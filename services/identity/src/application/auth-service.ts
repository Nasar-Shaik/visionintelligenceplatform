/**
 * Application: authentication use-cases. Login verifies credentials within a tenant and issues a
 * short-lived access token + a rotating refresh token. Refresh rotates the token within its family
 * and **detects reuse**: replaying a token that was already rotated revokes the entire family
 * (compromise response). See docs/architecture/phase1/AUTHENTICATION.md.
 */
import type { LoginInput, TokenPair } from '@vip/contracts';
import { TenantScope, type TenantRepository } from '@vip/tenancy';
import {
  generateRefreshToken,
  hashRefreshToken,
  parseDurationSeconds,
  signAccessToken,
  verifyPassword,
  AuthError,
} from '@vip/auth';
import type { Collection } from 'mongodb';
import type { UserDoc } from '../domain/user.js';
import { isUsable, newRefreshRecord, type RefreshTokenDoc } from '../domain/refresh.js';
import { nullPublisher, type EventPublisher } from './events.js';

export interface Clock {
  now(): Date;
}
export interface AuthIdGen {
  familyId(): string;
}
export interface JwtSettings {
  secret: string;
  accessTtl: string;
  refreshTtl: string;
  issuer: string;
  audience: string;
}

export interface AuthServiceDeps {
  users: TenantRepository<UserDoc>;
  /** Control-plane collection, looked up by token hash (`_id`). */
  refreshTokens: Collection<RefreshTokenDoc>;
  jwt: JwtSettings;
  clock: Clock;
  ids: AuthIdGen;
  publisher?: EventPublisher;
}

export class AuthService {
  private readonly users: TenantRepository<UserDoc>;
  private readonly refreshTokens: Collection<RefreshTokenDoc>;
  private readonly jwt: JwtSettings;
  private readonly clock: Clock;
  private readonly ids: AuthIdGen;
  private readonly publisher: EventPublisher;

  constructor(deps: AuthServiceDeps) {
    this.users = deps.users;
    this.refreshTokens = deps.refreshTokens;
    this.jwt = deps.jwt;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.publisher = deps.publisher ?? nullPublisher;
  }

  /** Authenticate a principal within a tenant and issue a token pair. */
  async login(scope: TenantScope, input: LoginInput): Promise<TokenPair> {
    const user = (await this.users.findOne(scope, {
      email: input.email.toLowerCase(),
    })) as UserDoc | null;
    // Constant-ish generic failure — never reveal whether the account exists.
    if (
      !user ||
      user.status !== 'active' ||
      !(await verifyPassword(input.password, user.passwordHash))
    ) {
      throw new AuthError('invalid email or password');
    }
    const pair = await this.issueTokens(user, this.ids.familyId());
    await this.publisher.publish({
      type: 'auth.login.succeeded',
      tenantId: user.tenantId,
      payload: { principalId: user._id },
    });
    return pair;
  }

  /** Rotate a refresh token. Detects reuse and revokes the family on replay. */
  async refresh(rawToken: string): Promise<TokenPair> {
    const hash = hashRefreshToken(rawToken);
    const rec = await this.refreshTokens.findOne({ _id: hash });
    if (!rec || rec.revokedAt !== null) throw new AuthError('invalid refresh token');

    if (rec.usedAt !== null) {
      // Replay of an already-rotated token → compromise. Revoke the whole family.
      await this.revokeFamily(rec.familyId);
      await this.publisher.publish({
        type: 'auth.refresh.reused',
        tenantId: rec.tenantId,
        payload: { principalId: rec.principalId, familyId: rec.familyId },
      });
      throw new AuthError('refresh token reuse detected');
    }
    if (!isUsable(rec, this.clock.now())) throw new AuthError('refresh token expired');

    // Mark this token used (rotate) and mint a new one in the same family.
    await this.refreshTokens.updateOne(
      { _id: hash },
      { $set: { usedAt: this.clock.now().toISOString() } },
    );

    const scope = TenantScope.fromTenantId(rec.tenantId);
    const user = (await this.users.findOne(scope, { _id: rec.principalId })) as UserDoc | null;
    if (!user || user.status !== 'active') throw new AuthError('account is not active');

    const pair = await this.issueTokens(user, rec.familyId);
    await this.publisher.publish({
      type: 'auth.token.refreshed',
      tenantId: user.tenantId,
      payload: { principalId: user._id },
    });
    return pair;
  }

  /** Revoke the family behind a refresh token (logout everywhere for that lineage). */
  async logout(rawToken: string): Promise<void> {
    const rec = await this.refreshTokens.findOne({ _id: hashRefreshToken(rawToken) });
    if (!rec) return; // idempotent
    await this.revokeFamily(rec.familyId);
    await this.publisher.publish({
      type: 'auth.logout',
      tenantId: rec.tenantId,
      payload: { principalId: rec.principalId },
    });
  }

  /**
   * Revoke **every** refresh-token family belonging to a principal — sign them out everywhere.
   *
   * ⚠️ This is the enforcement half of disabling an account, and it lives here because this class
   * is the only owner of `refresh_tokens`. `UserService` calls it through a one-method port rather
   * than reaching into the collection itself, so there stays exactly one place that knows how a
   * session is ended.
   *
   * ⚠️ **It does not invalidate an access token already in someone's hands.** Those are stateless
   * and self-verifying by design; the gateway checks a signature, not a database. The window is
   * therefore bounded by `JWT_ACCESS_TTL` (15 minutes deployed) — after which the refresh this
   * revoked is the only way to get another, and it fails. Recorded as L-23; closing the window
   * entirely means a per-request revocation lookup at the gateway, which is a measured decision to
   * take when there is evidence it is needed, not a thing to add speculatively.
   *
   * @returns how many **sessions** were ended — distinct families, not token records.
   *
   * ⚠️ **The distinction was measured, not reasoned about.** Counting modified rows reported `3`
   * for a user with two open sessions, because rotating a refresh token leaves the used record in
   * place and inserts a new one in the same family. An administrator reading "3 sessions ended"
   * for a person with two devices is being told something false about a security action, and the
   * number would drift further the longer someone stayed signed in. A **family is a session**: one
   * lineage, one sign-in, one device.
   */
  async revokeAllForPrincipal(tenantId: string, principalId: string): Promise<number> {
    const open = { tenantId, principalId, revokedAt: null };
    const families = await this.refreshTokens.distinct('familyId', open);
    await this.refreshTokens.updateMany(open, {
      $set: { revokedAt: this.clock.now().toISOString() },
    });
    return families.length;
  }

  private async issueTokens(user: UserDoc, familyId: string): Promise<TokenPair> {
    const { token: accessToken, expiresIn } = await signAccessToken(
      {
        principalId: user._id,
        tenantId: user.tenantId,
        email: user.email,
        roles: user.roles,
      },
      {
        secret: this.jwt.secret,
        accessTtl: this.jwt.accessTtl,
        issuer: this.jwt.issuer,
        audience: this.jwt.audience,
      },
    );

    const refreshToken = generateRefreshToken();
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + parseDurationSeconds(this.jwt.refreshTtl) * 1000);
    await this.refreshTokens.insertOne(
      newRefreshRecord(
        hashRefreshToken(refreshToken),
        user.tenantId,
        user._id,
        familyId,
        now,
        expiresAt,
      ),
    );

    return { tokenType: 'Bearer', accessToken, refreshToken, expiresIn };
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.refreshTokens.updateMany(
      { familyId, revokedAt: null },
      { $set: { revokedAt: this.clock.now().toISOString() } },
    );
  }
}

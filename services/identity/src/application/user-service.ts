/**
 * Application: user management (tenant-scoped via @vip/tenancy). Passwords are hashed before
 * persistence; the hash never leaves the domain. Listing/creation are gated by @vip/permissions
 * at the transport layer.
 */
import type { CreateUserInput, UpdateUserInput, User } from '@vip/contracts';
import type { TenantScope, TenantRepository } from '@vip/tenancy';
import { hashPassword } from '@vip/auth';
import { MongoServerError } from 'mongodb';
import { newUser, toUser, type UserDoc } from '../domain/user.js';
import { badRequest, conflict, notFound } from './errors.js';
import { nullPublisher, type EventPublisher } from './events.js';

const DUPLICATE_KEY = 11000;

export interface Clock {
  now(): Date;
}
export interface UserIdGen {
  userId(): string;
}

/**
 * The one thing user administration needs from the session store: end a principal's sessions.
 * `AuthService` implements it. A port rather than the collection, so `refresh_tokens` keeps a
 * single owner.
 */
export interface SessionRevoker {
  revokeAllForPrincipal(tenantId: string, principalId: string): Promise<number>;
}

/** The result of an act that also ended sessions — the count is what the caller reports. */
export interface UserMutation {
  user: User;
  sessionsRevoked: number;
}

export interface UserServiceDeps {
  users: TenantRepository<UserDoc>;
  clock: Clock;
  ids: UserIdGen;
  publisher?: EventPublisher;
  /** Optional so existing tests construct the service unchanged; a no-op revokes nothing. */
  sessions?: SessionRevoker;
}

const NO_SESSIONS: SessionRevoker = {
  async revokeAllForPrincipal() {
    return 0;
  },
};

export class UserService {
  private readonly users: TenantRepository<UserDoc>;
  private readonly clock: Clock;
  private readonly ids: UserIdGen;
  private readonly publisher: EventPublisher;
  private readonly sessions: SessionRevoker;

  constructor(deps: UserServiceDeps) {
    this.users = deps.users;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.publisher = deps.publisher ?? nullPublisher;
    this.sessions = deps.sessions ?? NO_SESSIONS;
  }

  async create(scope: TenantScope, input: CreateUserInput): Promise<User> {
    const passwordHash = await hashPassword(input.password);
    const doc = newUser(
      scope.tenantId,
      this.ids.userId(),
      input.email,
      passwordHash,
      input.roles,
      this.clock.now(),
    );
    try {
      await this.users.insertOne(scope, doc);
    } catch (err) {
      if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) {
        throw conflict(`a user with email "${doc.email}" already exists in this tenant`);
      }
      throw err;
    }
    await this.publisher.publish({
      type: 'user.created',
      tenantId: scope.tenantId,
      payload: { userId: doc._id },
    });
    return toUser(doc);
  }

  async list(scope: TenantScope): Promise<User[]> {
    const docs = await this.users.findMany(scope, {}, { sort: { email: 1 } });
    return docs.map((d) => toUser(d as UserDoc));
  }

  async get(scope: TenantScope, userId: string): Promise<User> {
    return toUser(await this.require(scope, userId));
  }

  /** Re-role a user. Roles only — see `UpdateUserInput` for what is deliberately not here. */
  async update(scope: TenantScope, userId: string, input: UpdateUserInput): Promise<User> {
    const doc = await this.require(scope, userId);
    const updatedAt = this.clock.now().toISOString();
    await this.users.updateOne(scope, { _id: userId }, { $set: { roles: input.roles, updatedAt } });
    await this.publisher.publish({
      type: 'user.roles.changed',
      tenantId: scope.tenantId,
      payload: { userId, from: doc.roles, to: input.roles },
    });
    return { ...toUser(doc), roles: input.roles, updatedAt };
  }

  /**
   * Disable an account: the offboarding act.
   *
   * Two things happen, and both are the point. The status flips — `login` and `refresh` already
   * refuse anything that is not `active`, so this is enforced at the door rather than in the UI —
   * **and every open session is revoked**, which is what makes it take effect now instead of
   * whenever the person next happens to sign out.
   *
   * ⚠️ **A user is disabled, never deleted.** Incidents name their assignee, evidence names who
   * attached it, and the audit names who looked. Deleting the row turns all of that into a dangling
   * id and quietly rewrites history — the same reason a location is archived (§38).
   *
   * ⚠️ **`actorId` may not be the target.** Locking yourself out of a security product mid-shift is
   * a mistake with no undo from inside the console; there is no "disable my own account" workflow
   * worth the risk of the accidental one.
   */
  async disable(scope: TenantScope, userId: string, actorId: string): Promise<UserMutation> {
    if (userId === actorId) {
      throw badRequest('you cannot disable your own account — ask another administrator');
    }
    const doc = await this.require(scope, userId);
    if (doc.status === 'disabled') {
      // Idempotent: already disabled is the requested end state, not a conflict. Still revoke —
      // a retry after a partial failure must be able to finish the job.
      const revoked = await this.sessions.revokeAllForPrincipal(scope.tenantId, userId);
      return { user: toUser(doc), sessionsRevoked: revoked };
    }
    const updatedAt = this.clock.now().toISOString();
    await this.users.updateOne(scope, { _id: userId }, { $set: { status: 'disabled', updatedAt } });
    const sessionsRevoked = await this.sessions.revokeAllForPrincipal(scope.tenantId, userId);
    await this.publisher.publish({
      type: 'user.disabled',
      tenantId: scope.tenantId,
      payload: { userId, actorId, sessionsRevoked },
    });
    return { user: { ...toUser(doc), status: 'disabled', updatedAt }, sessionsRevoked };
  }

  /**
   * Re-enable a disabled account. The password is unchanged and the old sessions stay revoked —
   * re-enabling restores the *right* to sign in, not a session that was ended.
   */
  async enable(scope: TenantScope, userId: string, actorId: string): Promise<User> {
    const doc = await this.require(scope, userId);
    const updatedAt = this.clock.now().toISOString();
    await this.users.updateOne(scope, { _id: userId }, { $set: { status: 'active', updatedAt } });
    await this.publisher.publish({
      type: 'user.enabled',
      tenantId: scope.tenantId,
      payload: { userId, actorId },
    });
    return { ...toUser(doc), status: 'active', updatedAt };
  }

  /**
   * Set a user's password (an administrator reset).
   *
   * Sessions are revoked for the same reason disabling revokes them: a reset is nearly always a
   * response to a suspected compromise, and leaving the sessions that prompted it running would
   * make the reset ceremonial.
   */
  async setPassword(
    scope: TenantScope,
    userId: string,
    password: string,
    actorId: string,
  ): Promise<UserMutation> {
    const doc = await this.require(scope, userId);
    const passwordHash = await hashPassword(password);
    const updatedAt = this.clock.now().toISOString();
    await this.users.updateOne(scope, { _id: userId }, { $set: { passwordHash, updatedAt } });
    const sessionsRevoked = await this.sessions.revokeAllForPrincipal(scope.tenantId, userId);
    await this.publisher.publish({
      type: 'user.password.reset',
      tenantId: scope.tenantId,
      // ⚠️ Never the password, never the hash. The audit records that it happened and who did it.
      payload: { userId, actorId, sessionsRevoked },
    });
    return { user: { ...toUser(doc), updatedAt }, sessionsRevoked };
  }

  /**
   * Fetch within the scope or 404.
   *
   * ⚠️ A user in *another* tenant is indistinguishable from one that does not exist, because the
   * scoped filter never matches it. That is the isolation guarantee showing through: a 404 rather
   * than a 403, so an id cannot be probed for existence across a tenant boundary.
   */
  private async require(scope: TenantScope, userId: string): Promise<UserDoc> {
    const doc = (await this.users.findOne(scope, { _id: userId })) as UserDoc | null;
    if (!doc) throw notFound(`user "${userId}" not found`);
    return doc;
  }
}

/**
 * Authentication + authorization contracts (Phase 1, P1-2). Users belong to a tenant (Law 5);
 * login issues a short-lived access token + a rotating refresh token; the access token's claims
 * mint the `TenantContext` every downstream service trusts.
 * Grounds: docs/architecture/15-SECURITY-ARCHITECTURE.md, 28-POLICY-ENGINE.md,
 * docs/architecture/phase1/AUTHENTICATION.md.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId } from '../common/primitives.js';
import { Permission, Scope } from '../common/tenant-context.js';

/** Account lifecycle. `invited` is reserved for the P1-2+ invite flow. */
export const UserStatus = z.enum(['active', 'disabled', 'invited']);
export type UserStatus = z.infer<typeof UserStatus>;

/** A user as persisted/returned — never carries the password hash. */
export const User = z.object({
  id: z.string().min(1),
  tenantId: TenantId,
  email: z.email(),
  roles: z.array(z.string().min(1)).default([]),
  status: UserStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type User = z.infer<typeof User>;

/** Create a user (server hashes the password and assigns id/timestamps). */
export const CreateUserInput = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
  roles: z.array(z.string().min(1)).default([]),
});
export type CreateUserInput = z.infer<typeof CreateUserInput>;

/**
 * Change what a user *is allowed to do*. **Roles only** — and the three fields that are absent are
 * the decision, so each is stated rather than silently omitted.
 *
 * - **`email` is not mutable.** It is the login identity and half of the `{tenantId, email}` unique
 *   key. Editing it silently changes who can sign in to an account that already owns incidents,
 *   assignments and audit lines — a takeover that reads as a typo fix. A person whose address
 *   changes gets a new account and the old one disabled, which leaves a trail. Recorded as L-21.
 * - **`status` is not mutable here.** Disabling someone's access is a named act, not a field edit
 *   (`POST /users/:id/disable`), for the same reason a location is archived rather than
 *   `PATCH {status:'archived'}`: the transition has side effects — every refresh-token family is
 *   revoked — and an audit line reading `user.disabled` says what happened where `user.updated`
 *   does not. A PATCH can therefore never lock somebody out by accident.
 * - **`password` is not mutable here.** A body that can carry both a role grant and a credential
 *   makes one audit entry cover two different acts. `POST /users/:id/password` is its own route.
 *
 * ⚠️ `roles` is an array of role names resolved by `@vip/permissions` at authorization time.
 * Contracts deliberately do not enumerate them: the role catalog is the policy engine's to own
 * (tenant-defined roles are a post-GA candidate), and duplicating the list here would create a
 * second source of truth that drifts. An unknown role grants nothing — it is not an error.
 */
export const UpdateUserInput = z.object({
  roles: z.array(z.string().min(1)).min(1),
});
export type UpdateUserInput = z.infer<typeof UpdateUserInput>;

/**
 * An administrator setting another user's password (a reset, not a self-service change).
 *
 * ⚠️ Deliberately **does not** carry the caller's own password or a reset token. This route is
 * authorized by `user:update` — the administrator's authority *is* the proof. A self-service
 * "change my password" flow is a different act with a different check (present the current
 * password) and is not this. Recorded as L-22.
 */
export const SetUserPasswordInput = z.object({
  password: z.string().min(8).max(200),
});
export type SetUserPasswordInput = z.infer<typeof SetUserPasswordInput>;

/** Credentials login. */
export const LoginInput = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginInput>;

/** Present a refresh token to rotate the token pair. */
export const RefreshInput = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof RefreshInput>;

/** The issued token pair. `expiresIn` is the access token's lifetime in seconds. */
export const TokenPair = z.object({
  tokenType: z.literal('Bearer').default('Bearer'),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});
export type TokenPair = z.infer<typeof TokenPair>;

/**
 * The authenticated principal (the `/auth/me` shape and the identity the gateway forwards).
 * A subset of TenantContext resolved from a validated access token.
 */
export const Principal = z.object({
  principalId: z.string().min(1),
  tenantId: TenantId,
  email: z.email(),
  roles: z.array(z.string()).default([]),
  permissions: z.array(Permission).default([]),
  scopes: z.array(Scope).default([]),
});
export type Principal = z.infer<typeof Principal>;

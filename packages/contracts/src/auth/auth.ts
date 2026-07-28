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

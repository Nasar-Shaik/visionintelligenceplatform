/**
 * Domain: user records. Framework-free. Users are tenant-scoped (Law 5); the password hash is
 * internal and never crosses the API boundary (`toUser` strips it). Shapes conform to the
 * @vip/contracts `User` schema.
 */
import type { User, UserStatus } from '@vip/contracts';
import type { TenantScoped } from '@vip/tenancy';

/** MongoDB-persisted user. Unique on `{ tenantId, email }`. */
export interface UserDoc extends TenantScoped {
  _id: string;
  email: string;
  passwordHash: string;
  roles: string[];
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export function newUser(
  tenantId: string,
  id: string,
  email: string,
  passwordHash: string,
  roles: string[],
  at: Date,
): UserDoc {
  const ts = at.toISOString();
  return {
    _id: id,
    tenantId,
    email: email.toLowerCase(),
    passwordHash,
    roles,
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  };
}

/** Map a persisted user to its public contract shape — never leaks the password hash. */
export function toUser(doc: UserDoc): User {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    email: doc.email,
    roles: doc.roles,
    status: doc.status,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Domain: pure tenant + org-hierarchy record construction and transitions. Framework-free and
 * deterministic — id generation and the clock are injected so the application/tests control them.
 * Shapes conform to the @vip/contracts `Tenant` / `OrgNode` schemas (validated at the edges).
 */
import type {
  CreateOrgNodeInput,
  CreateTenantInput,
  OrgNode,
  OrgNodeType,
  Tenant,
  TenantStatus,
  UpdateTenantInput,
} from '@vip/contracts';
import type { TenantScoped } from '@vip/tenancy';

/** MongoDB-persisted tenant document. `_id` is the tenantId; `tenantId` mirrors it (Law 5). */
export interface TenantDoc extends TenantScoped {
  _id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  createdAt: string;
  updatedAt: string;
}

/** MongoDB-persisted org-hierarchy node. `_id` is the node id. */
export interface OrgNodeDoc extends TenantScoped {
  _id: string;
  parentId: string | null;
  type: OrgNodeType;
  name: string;
  path: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Clock {
  now(): Date;
}

export interface IdGen {
  tenantId(): string;
  orgNodeId(): string;
}

/** Build a new tenant document in the `provisioning` state. */
export function newTenant(input: CreateTenantInput, id: string, at: Date): TenantDoc {
  const ts = at.toISOString();
  return {
    _id: id,
    tenantId: id,
    slug: input.slug,
    name: input.name,
    status: 'provisioning',
    createdAt: ts,
    updatedAt: ts,
  };
}

/** Build the org-hierarchy root (`org`, no parent) for a freshly provisioned tenant. */
export function newOrgRoot(tenantId: string, name: string, id: string, at: Date): OrgNodeDoc {
  const ts = at.toISOString();
  return {
    _id: id,
    tenantId,
    parentId: null,
    type: 'org',
    name,
    path: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

/** Build a child org node under a resolved parent (its materialized path = parent.path + parent.id). */
export function newOrgNode(
  tenantId: string,
  input: CreateOrgNodeInput,
  parent: Pick<OrgNodeDoc, '_id' | 'path'> | null,
  id: string,
  at: Date,
): OrgNodeDoc {
  const ts = at.toISOString();
  return {
    _id: id,
    tenantId,
    parentId: input.parentId,
    type: input.type,
    name: input.name,
    path: parent ? [...parent.path, parent._id] : [],
    createdAt: ts,
    updatedAt: ts,
  };
}

/** Apply an update (name and/or lifecycle transition), bumping `updatedAt`. */
export function applyTenantUpdate(doc: TenantDoc, patch: UpdateTenantInput, at: Date): TenantDoc {
  return {
    ...doc,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    updatedAt: at.toISOString(),
  };
}

/** Map a persisted tenant document to its public contract shape (`id`, no `_id`). */
export function toTenant(doc: TenantDoc): Tenant {
  return {
    id: doc._id,
    slug: doc.slug,
    name: doc.name,
    status: doc.status,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Map a persisted org node to its public contract shape. */
export function toOrgNode(doc: OrgNodeDoc): OrgNode {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    parentId: doc.parentId,
    type: doc.type,
    name: doc.name,
    path: doc.path,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

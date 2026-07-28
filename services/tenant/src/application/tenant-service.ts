/**
 * Application: tenant provisioning + org-hierarchy use-cases. Orchestrates the domain and the
 * tenant-scoped repositories; all tenant data flows through @vip/tenancy (fail-closed). The
 * tenant *registry* is control-plane (a tenant document is keyed by its own id); everything a
 * tenant owns (org nodes, later cameras/events) is isolated by the guard.
 */
import type {
  CreateOrgNodeInput,
  CreateTenantInput,
  OrgNode,
  Tenant,
  UpdateTenantInput,
} from '@vip/contracts';
import { TenantScope, type TenantRepository } from '@vip/tenancy';
import { MongoServerError } from 'mongodb';
import {
  applyTenantUpdate,
  newOrgNode,
  newOrgRoot,
  newTenant,
  toOrgNode,
  toTenant,
  type Clock,
  type IdGen,
  type OrgNodeDoc,
  type TenantDoc,
} from '../domain/tenant.js';
import { badRequest, conflict, notFound } from './errors.js';
import { nullPublisher, type EventPublisher } from './events.js';

const DUPLICATE_KEY = 11000;

export interface TenantServiceDeps {
  tenants: TenantRepository<TenantDoc>;
  orgNodes: TenantRepository<OrgNodeDoc>;
  clock: Clock;
  ids: IdGen;
  publisher?: EventPublisher;
}

export class TenantService {
  private readonly tenants: TenantRepository<TenantDoc>;
  private readonly orgNodes: TenantRepository<OrgNodeDoc>;
  private readonly clock: Clock;
  private readonly ids: IdGen;
  private readonly publisher: EventPublisher;

  constructor(deps: TenantServiceDeps) {
    this.tenants = deps.tenants;
    this.orgNodes = deps.orgNodes;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.publisher = deps.publisher ?? nullPublisher;
  }

  /** Provision a tenant: create the tenant, seed its org root, and activate it. */
  async provision(input: CreateTenantInput): Promise<{ tenant: Tenant; orgRoot: OrgNode }> {
    const tenantId = this.ids.tenantId();
    const scope = TenantScope.fromTenantId(tenantId);

    const doc = newTenant(input, tenantId, this.clock.now());
    try {
      await this.tenants.insertOne(scope, doc);
    } catch (err) {
      if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) {
        throw conflict(`a tenant with slug "${input.slug}" already exists`);
      }
      throw err;
    }
    await this.publisher.publish({
      type: 'tenant.created',
      tenantId,
      payload: { slug: input.slug },
    });

    const root = newOrgRoot(tenantId, input.name, this.ids.orgNodeId(), this.clock.now());
    await this.orgNodes.insertOne(scope, root);
    await this.publisher.publish({
      type: 'org.node.created',
      tenantId,
      payload: { nodeId: root._id, type: 'org' },
    });

    // provisioning → active (admin seeding is P1-2; not required to activate in P1-1).
    const activated = applyTenantUpdate(doc, { status: 'active' }, this.clock.now());
    await this.tenants.updateOne(
      scope,
      { _id: tenantId },
      { $set: { status: 'active', updatedAt: activated.updatedAt } },
    );
    await this.publisher.publish({ type: 'tenant.activated', tenantId });

    return { tenant: toTenant(activated), orgRoot: toOrgNode(root) };
  }

  /** Get a tenant within the caller's scope. */
  async get(scope: TenantScope): Promise<Tenant> {
    const doc = await this.tenants.findOne(scope, { _id: scope.tenantId });
    if (!doc) throw notFound(`tenant "${scope.tenantId}" not found`);
    return toTenant(doc as TenantDoc);
  }

  /** Update a tenant (name and/or lifecycle) within the caller's scope. */
  async update(scope: TenantScope, patch: UpdateTenantInput): Promise<Tenant> {
    const doc = await this.tenants.findOne(scope, { _id: scope.tenantId });
    if (!doc) throw notFound(`tenant "${scope.tenantId}" not found`);
    const updated = applyTenantUpdate(doc as TenantDoc, patch, this.clock.now());
    await this.tenants.updateOne(
      scope,
      { _id: scope.tenantId },
      {
        $set: {
          name: updated.name,
          status: updated.status,
          updatedAt: updated.updatedAt,
        },
      },
    );
    if (patch.status && patch.status !== (doc as TenantDoc).status) {
      await this.publisher.publish({ type: `tenant.${patch.status}`, tenantId: scope.tenantId });
    }
    return toTenant(updated);
  }

  /** List a tenant's org-hierarchy nodes (isolated by the guard). */
  async listOrgNodes(scope: TenantScope): Promise<OrgNode[]> {
    const docs = await this.orgNodes.findMany(scope, {});
    return docs.map((d) => toOrgNode(d as OrgNodeDoc));
  }

  /** Create an org-hierarchy node under the caller's tenant. */
  async createOrgNode(scope: TenantScope, input: CreateOrgNodeInput): Promise<OrgNode> {
    if (input.type === 'org' && input.parentId !== null) {
      throw badRequest('an org root must have a null parent');
    }
    if (input.type !== 'org' && input.parentId === null) {
      throw badRequest(`a ${input.type} node requires a parent`);
    }

    let parent: OrgNodeDoc | null = null;
    if (input.parentId !== null) {
      parent = (await this.orgNodes.findOne(scope, { _id: input.parentId })) as OrgNodeDoc | null;
      if (!parent) throw badRequest(`parent node "${input.parentId}" not found in this tenant`);
    }

    const node = newOrgNode(scope.tenantId, input, parent, this.ids.orgNodeId(), this.clock.now());
    await this.orgNodes.insertOne(scope, node);
    await this.publisher.publish({
      type: 'org.node.created',
      tenantId: scope.tenantId,
      payload: { nodeId: node._id, type: node.type },
    });
    return toOrgNode(node);
  }
}

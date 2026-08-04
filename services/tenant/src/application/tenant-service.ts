/**
 * Application: tenant provisioning + org-hierarchy use-cases. Orchestrates the domain and the
 * tenant-scoped repositories; all tenant data flows through @vip/tenancy (fail-closed). The
 * tenant *registry* is control-plane (a tenant document is keyed by its own id); everything a
 * tenant owns (org nodes, later cameras/events) is isolated by the guard.
 */
import type {
  CreateOrgNodeInput,
  CreateTenantInput,
  OrgLocation,
  OrgLocationPage,
  OrgNode,
  OrgNodeQuery,
  OrgTree,
  Tenant,
  UpdateOrgNodeInput,
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
import {
  archiveError,
  buildTree,
  byId,
  containmentError,
  isActive,
  moveError,
  movedPaths,
  resolveLocation,
  restoreError,
} from '../domain/hierarchy.js';
import { badRequest, conflict, notFound } from './errors.js';
import { nullPublisher, type EventPublisher } from './events.js';

const DUPLICATE_KEY = 11000;

/**
 * Ceiling on the nodes one tree read will assemble.
 *
 * An estate is read whole so the tree can be built in a single pass, which is only safe while
 * "whole" is bounded. Beyond this the caller narrows with `under` — and is told the result was
 * truncated rather than being handed a silently partial estate.
 */
const ORG_TREE_LIMIT = 5_000;

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

  /**
   * Update a tenant (name and/or lifecycle) within the caller's scope.
   *
   * ### ⚠️ Optimistic concurrency, and why the check is in the query rather than before it
   *
   * When `expectedUpdatedAt` is supplied it becomes part of the **update filter**, not an `if`
   * above it. Reading the document, comparing, and then writing leaves a window between the read
   * and the write in which another administrator can commit — the exact race the check exists to
   * close, reintroduced by the shape of the check. Mongo matches and writes in one operation, so
   * either the document still carries the timestamp the caller saw or nothing is written at all.
   *
   * A zero match is then disambiguated: the tenant is re-read, and a document that exists means a
   * **409** (someone else got there first) while a missing one means a 404.
   *
   * ### The audit record
   *
   * ⚠️ Every successful update now emits **`tenant.updated`** carrying before/after for each field
   * that actually moved, the actor and the correlation id. Previously a rename emitted **nothing** —
   * only a status transition announced itself — so the commonest settings change in the product left
   * no trace at all.
   *
   * ⚠️ **Where that record lands is a real limitation, and it is not hidden.** The tenant service
   * still uses `LoggingEventPublisher`, so this is a structured log line, not a queryable audit
   * store: `AccessAuditEntry` is frozen in the contracts with no consumer anywhere and no route on
   * any service. Building one here would be a new subsystem in a milestone that is meant to be
   * additive. The event is emitted in the shape a durable consumer will want, so wiring one later
   * changes the sink and not the call site. Recorded as L-25 / TD-49.
   */
  async update(
    scope: TenantScope,
    patch: UpdateTenantInput,
    context: { actorId?: string; correlationId?: string } = {},
  ): Promise<Tenant> {
    const doc = await this.tenants.findOne(scope, { _id: scope.tenantId });
    if (!doc) throw notFound(`tenant "${scope.tenantId}" not found`);
    /*
     * ⚠️ Snapshot the before-values **now**, not after the write.
     *
     * Reading them afterwards assumes the document handed back by `findOne` is a private copy. The
     * MongoDB driver deserializes a fresh object so that happens to hold — but the in-memory store
     * the HTTP tests use returns the stored reference and `updateOne` mutates it in place, so the
     * "before" name was already the *after* name and every audit event came out empty. The audit
     * record's correctness should not depend on which store is underneath it.
     */
    const before = { name: (doc as TenantDoc).name, status: (doc as TenantDoc).status };
    const updated = applyTenantUpdate(doc as TenantDoc, patch, this.clock.now());
    const matched = await this.tenants.updateOne(
      scope,
      patch.expectedUpdatedAt !== undefined
        ? { _id: scope.tenantId, updatedAt: patch.expectedUpdatedAt }
        : { _id: scope.tenantId },
      {
        $set: {
          name: updated.name,
          status: updated.status,
          updatedAt: updated.updatedAt,
        },
      },
    );
    if (matched === 0) {
      const current = (await this.tenants.findOne(scope, {
        _id: scope.tenantId,
      })) as TenantDoc | null;
      if (!current) throw notFound(`tenant "${scope.tenantId}" not found`);
      throw conflict(
        'this tenant was changed by someone else while you were editing. ' +
          'Reload to see the current settings, then apply your change again.',
      );
    }
    /*
     * ⚠️ Only fields that actually moved. An audit line claiming `name` changed from "Acme" to
     * "Acme" is noise that trains a reader to skim the ones that matter.
     */
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (patch.name !== undefined && patch.name !== before.name) {
      changes.name = { from: before.name, to: updated.name };
    }
    if (patch.status !== undefined && patch.status !== before.status) {
      changes.status = { from: before.status, to: updated.status };
    }

    if (Object.keys(changes).length > 0) {
      await this.publisher.publish({
        type: 'tenant.updated',
        tenantId: scope.tenantId,
        payload: {
          changes,
          actorId: context.actorId ?? null,
          correlationId: context.correlationId ?? null,
          at: updated.updatedAt,
          /* The version the caller held. `null` means they did not supply one — worth auditing. */
          expectedUpdatedAt: patch.expectedUpdatedAt ?? null,
        },
      });
    }

    // The lifecycle transition keeps its own event: consumers subscribe to `tenant.suspended`
    // specifically, and folding it into `tenant.updated` would break them for no gain.
    if (patch.status && patch.status !== before.status) {
      await this.publisher.publish({ type: `tenant.${patch.status}`, tenantId: scope.tenantId });
    }
    return toTenant(updated);
  }

  /** List a tenant's org-hierarchy nodes (isolated by the guard). Unresolved; see `locations`. */
  async listOrgNodes(scope: TenantScope): Promise<OrgNode[]> {
    const docs = await this.orgNodes.findMany(scope, {}, { limit: ORG_TREE_LIMIT });
    return docs.map((d) => toOrgNode(d as OrgNodeDoc));
  }

  /**
   * A bounded, filtered page of **resolved** locations — each with its breadcrumb, depth, label and
   * the child types it accepts.
   *
   * Three queries regardless of estate size: the page, its ancestors, and which of its members have
   * children. Not one per node, and not one per level.
   */
  async locations(scope: TenantScope, query: OrgNodeQuery): Promise<OrgLocationPage> {
    const filter: Record<string, unknown> = {};
    if (query.type) filter.type = query.type;
    if (query.parentId) filter.parentId = query.parentId;
    if (query.under) filter.path = query.under;
    if (!query.includeArchived) filter.status = { $ne: 'archived' };
    if (query.search) filter.name = { $regex: escapeRegex(query.search), $options: 'i' };
    if (query.cursor) filter._id = { $gt: query.cursor };

    const docs = (await this.orgNodes.findMany(scope, filter, {
      sort: { _id: 1 },
      limit: query.limit + 1,
    })) as OrgNodeDoc[];

    const page = docs.slice(0, query.limit);
    const locations = await this.resolve(scope, page);
    const last = page.at(-1);
    return {
      locations,
      ...(docs.length > query.limit && last ? { nextCursor: last._id } : {}),
    };
  }

  /** One resolved location, or 404. */
  async location(scope: TenantScope, nodeId: string): Promise<OrgLocation> {
    const doc = await this.requireNode(scope, nodeId);
    const [resolved] = await this.resolve(scope, [doc]);
    return resolved!;
  }

  /**
   * The estate as a forest, assembled in one pass over one query.
   *
   * Shallowest-first ordering matters when the estate is larger than the ceiling: a truncated tree is
   * then complete from the root downward — an estate missing its leaves is navigable, whereas one
   * missing its middle is not a tree at all.
   */
  async orgTree(scope: TenantScope, options: { under?: string } = {}): Promise<OrgTree> {
    const filter: Record<string, unknown> = { status: { $ne: 'archived' } };
    // A subtree read includes the node itself: a subtree without its root has no root, and every
    // node in it would be reported as an orphan of a parent that was never asked for.
    if (options.under) filter.$or = [{ _id: options.under }, { path: options.under }];

    const docs = (await this.orgNodes.findMany(scope, filter, {
      sort: { depth: 1, _id: 1 },
      limit: ORG_TREE_LIMIT + 1,
    })) as OrgNodeDoc[];

    const truncated = docs.length > ORG_TREE_LIMIT;
    const tree = buildTree(docs.slice(0, ORG_TREE_LIMIT), {
      ...(options.under ? { rootIds: [options.under] } : {}),
    });
    return { ...tree, truncated };
  }

  /** Create an org-hierarchy node under the caller's tenant. */
  async createOrgNode(scope: TenantScope, input: CreateOrgNodeInput): Promise<OrgNode> {
    let parent: OrgNodeDoc | null = null;
    if (input.parentId !== null) {
      parent = (await this.orgNodes.findOne(scope, { _id: input.parentId })) as OrgNodeDoc | null;
      if (!parent) throw badRequest(`parent node "${input.parentId}" not found in this tenant`);
      if (!isActive(parent)) {
        throw badRequest(`"${parent.name}" is archived — restore it before adding locations to it`);
      }
    }

    const invalid = containmentError(parent?.type ?? null, input.type);
    if (invalid) throw badRequest(invalid);

    const node = newOrgNode(scope.tenantId, input, parent, this.ids.orgNodeId(), this.clock.now());
    await this.orgNodes.insertOne(scope, node);
    await this.publisher.publish({
      type: 'org.node.created',
      tenantId: scope.tenantId,
      payload: { nodeId: node._id, type: node.type, parentId: node.parentId },
    });
    return toOrgNode(node);
  }

  /**
   * Rename and/or move a node.
   *
   * A rename touches one document and **no reference anywhere** — every reference in the platform is
   * by id, which is the whole reason names are allowed to be edited freely. A move rewrites the
   * moved node's ancestry and every descendant's, in one bulk write: the subtree travels intact, and
   * an interrupted move cannot leave the tree describing two shapes at once.
   */
  async updateOrgNode(
    scope: TenantScope,
    nodeId: string,
    patch: UpdateOrgNodeInput,
  ): Promise<OrgLocation> {
    const node = await this.requireNode(scope, nodeId);
    const now = this.clock.now().toISOString();
    const set: Record<string, unknown> = { updatedAt: now };

    if (patch.name !== undefined && patch.name !== node.name) {
      set.name = patch.name;
    }

    let moved: { parent: OrgNodeDoc; rewrites: ReturnType<typeof movedPaths> } | null = null;
    if (patch.parentId !== undefined && patch.parentId !== node.parentId) {
      const parent = (await this.orgNodes.findOne(scope, {
        _id: patch.parentId,
      })) as OrgNodeDoc | null;
      if (!parent) throw badRequest(`parent node "${patch.parentId}" not found in this tenant`);

      const invalid = moveError(node, parent);
      if (invalid) throw badRequest(invalid);

      const descendants = (await this.orgNodes.findMany(
        scope,
        { path: node._id },
        { limit: ORG_TREE_LIMIT },
      )) as OrgNodeDoc[];
      const rewrites = movedPaths(node, parent, descendants);
      moved = { parent, rewrites };

      const own = rewrites[0]!;
      set.parentId = parent._id;
      set.path = own.path;
      set.depth = own.depth;
    }

    await this.orgNodes.updateOne(scope, { _id: nodeId }, { $set: set });

    if (moved) {
      await this.orgNodes.bulkUpdate(
        scope,
        moved.rewrites.slice(1).map((rewrite) => ({
          filter: { _id: rewrite.id },
          update: { $set: { path: rewrite.path, depth: rewrite.depth, updatedAt: now } },
        })),
      );
      await this.publisher.publish({
        type: 'org.node.moved',
        tenantId: scope.tenantId,
        payload: {
          nodeId,
          fromParentId: node.parentId,
          toParentId: moved.parent._id,
          descendants: moved.rewrites.length - 1,
        },
      });
    }
    if (set.name !== undefined) {
      await this.publisher.publish({
        type: 'org.node.renamed',
        tenantId: scope.tenantId,
        payload: { nodeId, from: node.name, to: set.name },
      });
    }

    return this.location(scope, nodeId);
  }

  /**
   * Archive a node and everything beneath it. Nothing is deleted, ever.
   *
   * Evidence, incidents and audit records reference locations by id for as long as they are retained.
   * A delete would turn a two-year-old investigation into a dangling id at exactly the moment someone
   * needed to read it, so the estate retires locations instead of removing them: archived nodes leave
   * the working views and stay resolvable forever.
   */
  async archiveOrgNode(scope: TenantScope, nodeId: string): Promise<OrgLocation> {
    const node = await this.requireNode(scope, nodeId);
    const invalid = archiveError(node);
    if (invalid) throw badRequest(invalid);

    const now = this.clock.now().toISOString();
    const subtree = (await this.orgNodes.findMany(
      scope,
      { path: nodeId },
      { limit: ORG_TREE_LIMIT },
    )) as OrgNodeDoc[];

    await this.orgNodes.updateMany(
      scope,
      { $or: [{ _id: nodeId }, { path: nodeId }] },
      { $set: { status: 'archived', archivedAt: now, updatedAt: now } },
    );
    await this.publisher.publish({
      type: 'org.node.archived',
      tenantId: scope.tenantId,
      payload: { nodeId, type: node.type, descendants: subtree.length },
    });
    return this.location(scope, nodeId);
  }

  /** Restore an archived node and its subtree. Refused while an ancestor is still archived. */
  async restoreOrgNode(scope: TenantScope, nodeId: string): Promise<OrgLocation> {
    const node = await this.requireNode(scope, nodeId);
    const ancestors = await this.ancestorsOf(scope, [node]);
    const invalid = restoreError(node, [...ancestors.values()]);
    if (invalid) throw badRequest(invalid);

    const now = this.clock.now().toISOString();
    await this.orgNodes.updateMany(
      scope,
      { $or: [{ _id: nodeId }, { path: nodeId }] },
      { $set: { status: 'active', updatedAt: now }, $unset: { archivedAt: '' } },
    );
    await this.publisher.publish({
      type: 'org.node.restored',
      tenantId: scope.tenantId,
      payload: { nodeId, type: node.type },
    });
    return this.location(scope, nodeId);
  }

  /** Fetch a node within scope, or 404 (also the cross-tenant answer — no existence leak). */
  private async requireNode(scope: TenantScope, nodeId: string): Promise<OrgNodeDoc> {
    const doc = (await this.orgNodes.findOne(scope, { _id: nodeId })) as OrgNodeDoc | null;
    if (!doc) throw notFound(`location "${nodeId}" not found`);
    return doc;
  }

  /** Every ancestor of every given node, in one `$in` query. Ancestry is materialized, not walked. */
  private async ancestorsOf(
    scope: TenantScope,
    docs: readonly OrgNodeDoc[],
  ): Promise<Map<string, OrgNodeDoc>> {
    const wanted = new Set<string>();
    for (const doc of docs) for (const id of doc.path) wanted.add(id);
    if (wanted.size === 0) return new Map();
    const ancestors = (await this.orgNodes.findMany(scope, {
      _id: { $in: [...wanted] },
    })) as OrgNodeDoc[];
    return byId(ancestors);
  }

  /** Resolve documents for display: ancestors in one query, child-existence in one aggregation. */
  private async resolve(scope: TenantScope, docs: readonly OrgNodeDoc[]): Promise<OrgLocation[]> {
    if (docs.length === 0) return [];
    const lookup = await this.ancestorsOf(scope, docs);
    for (const doc of docs) lookup.set(doc._id, doc);

    const ids = docs.map((doc) => doc._id);
    const children = await this.orgNodes.aggregate<{ _id: string }>(scope, [
      { $match: { parentId: { $in: ids } } },
      { $group: { _id: '$parentId' } },
    ]);
    const withChildren = new Set(children.map((row) => row._id));

    return docs.map((doc) => resolveLocation(doc, lookup, withChildren.has(doc._id)));
  }
}

/** Escape a user-supplied search term so it matches literally rather than as a pattern. */
function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

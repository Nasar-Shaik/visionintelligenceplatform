import { http, HttpResponse, type RequestHandler } from 'msw';

/**
 * Base MSW request handlers (gateway mocks). Feature slices append their own handlers
 * here (or override per-test) so component/hook tests run against contract-shaped
 * responses without a live gateway.
 */
export const handlers: RequestHandler[] = [
  /**
   * An empty probe archive (P-2.2).
   *
   * A default rather than a per-test fixture because the camera detail sheet reads this on every
   * open, and the honest empty answer — "this camera has never been probed" — is what a real
   * deployment returns until someone tests one. Tests that care override it.
   */
  http.get('/api/camera/cameras/:id/probes', ({ params }) =>
    HttpResponse.json({
      success: true,
      data: { cameraId: params.id, records: [], total: 0, retained: 0, evicted: 0 },
    }),
  ),
  /** An empty evidence timeline (P-2.3) — read on every detail-sheet open. */
  http.get('/api/camera/cameras/:id/evidence', ({ params }) =>
    HttpResponse.json({
      success: true,
      data: {
        cameraId: params.id,
        from: '2026-07-03T00:00:00.000Z',
        to: '2026-08-02T00:00:00.000Z',
        entries: [],
        sources: [],
        truncated: false,
      },
    }),
  ),

  /**
   * A small estate (P-3): Acme › EMEA › London › Lobby, plus a second region.
   *
   * A default rather than a per-test fixture because the location picker and the camera list both
   * read the tree on every render, and every field here — breadcrumb, label, depth,
   * `allowedChildTypes` — is one the **server** computes. Building them by hand in the fixture is
   * what makes the tests meaningful: if the console ever started deriving them, the fixture would
   * stop being what the assertions depend on.
   */
  http.get('/api/tenant/tenants/:tenantId/org-tree', () =>
    HttpResponse.json({ success: true, data: ORG_TREE }),
  ),
  http.get('/api/tenant/tenants/:tenantId/locations/:nodeId', ({ params }) => {
    const found = FLAT_LOCATIONS.find((node) => node.id === params.nodeId);
    return found
      ? HttpResponse.json({ success: true, data: found })
      : HttpResponse.json(
          { success: false, error: { code: 'not_found', message: 'not found' } },
          { status: 404 },
        );
  }),
  http.get('/api/tenant/tenants/:tenantId/locations', () =>
    HttpResponse.json({ success: true, data: { locations: FLAT_LOCATIONS } }),
  ),

  /**
   * A run that established no behaviour (slice 2.8).
   *
   * A default rather than a per-test fixture because the investigation page reads this on every
   * open, and the honest empty answer — "this run produced nothing" — is what a real deployment
   * returns for a short clip in which nobody stood still. ⚠️ **`enabled: true` with no entries**,
   * which is a different fact from `enabled: false`: the first says the runtime looked and found
   * nothing, the second says it keeps no history to look at. Tests that care override it.
   */
  http.get('/api/behaviour/timeline', ({ request }) =>
    HttpResponse.json({
      success: true,
      data: {
        enabled: true,
        query: { streamId: new URL(request.url).searchParams.get('streamId') },
        entries: [],
        truncated: false,
        relational: { identitiesConsidered: 0, truncated: false, maxIdentities: 32 },
        kinds: [],
        countsByKind: {},
        kindsRequested: [],
        excludedByKind: 0,
      },
    }),
  ),
  http.get('/api/behaviour/graph', () =>
    HttpResponse.json({
      success: true,
      data: {
        enabled: true,
        graph: {
          nodes: [],
          edges: [],
          counts: { nodes: 0, edges: 0, byNodeKind: {}, byEdgeKind: {} },
          originSeconds: 0,
          truncated: { nodes: false, edges: false, relational: false, identitiesConsidered: 0, maxIdentities: 32 },
        },
      },
    }),
  ),
  http.get('/api/behaviour/primitives', () =>
    HttpResponse.json({
      success: true,
      data: {
        enabled: true,
        primitives: {
          task: 'behaviour',
          modules: [],
          identities: {},
          scene: [],
          zoneMembership: 'absent',
          lineGeometry: 'absent',
          readings: {},
          relational: { identitiesConsidered: 0, truncated: false, maxIdentities: 32 },
          moduleFailures: {},
        },
      },
    }),
  ),
  http.get('/api/track-history', () =>
    HttpResponse.json({ success: true, data: { enabled: true, records: [], live: [] } }),
  ),
];

const AT = '2026-08-02T00:00:00.000Z';

function location(
  id: string,
  type: string,
  name: string,
  parentId: string | null,
  path: string[],
  breadcrumb: Array<{ id: string; type: string; name: string }>,
  allowedChildTypes: string[],
  hasChildren: boolean,
) {
  return {
    id,
    tenantId: 'tnt_1',
    parentId,
    type,
    name,
    path,
    status: 'active',
    createdAt: AT,
    updatedAt: AT,
    breadcrumb,
    depth: breadcrumb.length,
    label: [...breadcrumb.map((crumb) => crumb.name), name].join(' › '),
    allowedChildTypes,
    hasChildren,
  };
}

const ORG = location('on_org', 'org', 'Acme', null, [], [], ['region', 'site', 'zone'], true);
const ORG_CRUMB = { id: 'on_org', type: 'org', name: 'Acme' };
const EMEA = location(
  'on_emea',
  'region',
  'EMEA',
  'on_org',
  ['on_org'],
  [ORG_CRUMB],
  ['site', 'zone'],
  true,
);
const EMEA_CRUMB = { id: 'on_emea', type: 'region', name: 'EMEA' };
const LONDON = location(
  'on_london',
  'site',
  'London',
  'on_emea',
  ['on_org', 'on_emea'],
  [ORG_CRUMB, EMEA_CRUMB],
  ['building', 'floor', 'zone'],
  true,
);
const LOBBY = location(
  'on_lobby',
  'zone',
  'Lobby',
  'on_london',
  ['on_org', 'on_emea', 'on_london'],
  [ORG_CRUMB, EMEA_CRUMB, { id: 'on_london', type: 'site', name: 'London' }],
  [],
  false,
);
const APAC = location(
  'on_apac',
  'region',
  'APAC',
  'on_org',
  ['on_org'],
  [ORG_CRUMB],
  ['site', 'zone'],
  false,
);

const FLAT_LOCATIONS = [ORG, EMEA, LONDON, LOBBY, APAC];

const ORG_TREE = {
  roots: [
    {
      ...ORG,
      children: [
        { ...APAC, children: [] },
        { ...EMEA, children: [{ ...LONDON, children: [{ ...LOBBY, children: [] }] }] },
      ],
    },
  ],
  nodeCount: 5,
  orphaned: [],
  truncated: false,
};

import { afterEach, describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { permissionsForRoles } from '@vip/permissions';
import type { OrgTreeNode } from '@vip/contracts';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { LocationsPage } from './LocationsPage';
import {
  defaultExpanded,
  findNode,
  flattenTree,
  orgTypeLabel,
  subtreeIds,
} from './orgPresentation';

function authAs(roles: string[]) {
  store.dispatch(
    authenticated({
      user: { id: 'u', email: 'ops@tenant', roles },
      tenantId: 'tnt_acme',
      permissions: permissionsForRoles(roles),
    }),
  );
}

afterEach(() => store.dispatch(signedOut()));

/** A tree node fixture. Every derived field is supplied as a *server* would compute it. */
function node(
  id: string,
  name: string,
  type: OrgTreeNode['type'],
  label: string,
  children: OrgTreeNode[] = [],
  overrides: Partial<OrgTreeNode> = {},
): OrgTreeNode {
  return {
    id,
    tenantId: 'tnt_acme',
    parentId: null,
    type,
    name,
    path: [],
    status: 'active',
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    breadcrumb: [],
    depth: 0,
    label,
    allowedChildTypes: [],
    hasChildren: children.length > 0,
    children,
    ...overrides,
  };
}

describe('estate presentation', () => {
  const lobby = node('z1', 'Lobby', 'zone', 'Acme › London › Lobby');
  const london = node('s1', 'London', 'site', 'Acme › London', [lobby]);
  const org = node('o1', 'Acme', 'org', 'Acme', [london]);

  it('flattens only what is expanded', () => {
    expect(flattenTree([org], new Set()).map((r) => r.node.id)).toEqual(['o1']);
    expect(flattenTree([org], new Set(['o1'])).map((r) => r.node.id)).toEqual(['o1', 's1']);
    expect(flattenTree([org], new Set(['o1', 's1'])).map((r) => r.node.id)).toEqual([
      'o1',
      's1',
      'z1',
    ]);
  });

  it('indents by rendering position, not by estate depth', () => {
    const rows = flattenTree([org], new Set(['o1', 's1']));
    expect(rows.map((r) => r.indent)).toEqual([0, 1, 2]);
  });

  it('opens a small estate fully and a large one only to its top levels', () => {
    expect(defaultExpanded([org], 3)).toEqual(new Set(['o1', 's1']));
    expect(defaultExpanded([org], 5_000)).toEqual(new Set(['o1', 's1']));

    const deep = node('a', 'A', 'org', 'A', [
      node('b', 'B', 'region', 'A › B', [
        node('c', 'C', 'site', 'A › B › C', [node('d', 'D', 'zone', 'A › B › C › D')]),
      ]),
    ]);
    expect(defaultExpanded([deep], 5_000)).toEqual(new Set(['a', 'b']));
  });

  it('collects a subtree including its own root — the set a camera filter consumes', () => {
    expect(subtreeIds(org)).toEqual(['o1', 's1', 'z1']);
    expect(subtreeIds(lobby)).toEqual(['z1']);
  });

  it('finds a node anywhere in the forest', () => {
    expect(findNode([org], 'z1')?.name).toBe('Lobby');
    expect(findNode([org], 'nope')).toBeUndefined();
  });

  it('translates the neutral type identifier and falls back visibly', () => {
    expect(orgTypeLabel('building')).toBe('Building');
    // A type with no translation renders as itself — a missing label should look wrong, not empty.
    expect(orgTypeLabel('helipad')).toBe('helipad');
  });
});

describe('locations page', () => {
  it('renders the estate with the labels the server resolved', async () => {
    authAs(['admin']);
    renderWithProviders(<LocationsPage />, { store });

    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('EMEA')).toBeInTheDocument();
    expect(screen.getByText('London')).toBeInTheDocument();
  });

  it('offers only the child types the server said are permitted', async () => {
    authAs(['admin']);
    renderWithProviders(<LocationsPage />, { store });

    await userEvent.click(
      await screen.findByRole('button', { name: /Add a location under London/ }),
    );
    await userEvent.click(await screen.findByRole('combobox', { name: /type/i }));

    // London is a site: the server permits building, floor and zone — and nothing above it.
    expect(await screen.findByRole('option', { name: 'Building' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Zone' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Region' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Country' })).not.toBeInTheDocument();
  });

  it('offers no way to add anything under a zone', async () => {
    authAs(['admin']);
    renderWithProviders(<LocationsPage />, { store });

    await screen.findByText('Lobby');
    expect(
      screen.queryByRole('button', { name: /Add a location under Lobby/ }),
    ).not.toBeInTheDocument();
  });

  it('creates a location under the node that was chosen', async () => {
    authAs(['admin']);
    let created: unknown = null;
    server.use(
      mswHttp.post('/api/tenant/tenants/:tenantId/org-nodes', async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ success: true, data: { id: 'on_new' } }, { status: 201 });
      }),
    );

    renderWithProviders(<LocationsPage />, { store });
    await userEvent.click(
      await screen.findByRole('button', { name: /Add a location under London/ }),
    );
    await userEvent.type(screen.getByLabelText('Name'), 'Tower B');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toMatchObject({ name: 'Tower B', parentId: 'on_london', type: 'building' });
  });

  it('renames without sending anything but the name', async () => {
    authAs(['admin']);
    let patched: unknown = null;
    server.use(
      mswHttp.patch('/api/tenant/tenants/:tenantId/org-nodes/:nodeId', async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json({ success: true, data: { id: 'on_london' } });
      }),
    );

    renderWithProviders(<LocationsPage />, { store });
    await userEvent.click(await screen.findByRole('button', { name: /Rename London/ }));
    const field = screen.getByLabelText('Name');
    await userEvent.clear(field);
    await userEvent.type(field, 'London City');
    await userEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(patched).not.toBeNull());
    // No id, no type, no path — a rename is a label change and nothing else.
    expect(patched).toEqual({ name: 'London City' });
  });

  it('archives rather than deletes — there is no delete control at all', async () => {
    authAs(['admin']);
    let archived = false;
    server.use(
      mswHttp.post('/api/tenant/tenants/:tenantId/org-nodes/:nodeId/archive', () => {
        archived = true;
        return HttpResponse.json({ success: true, data: { id: 'on_london', status: 'archived' } });
      }),
    );

    renderWithProviders(<LocationsPage />, { store });
    await userEvent.click(await screen.findByRole('button', { name: /Archive London/ }));

    await waitFor(() => expect(archived).toBe(true));
    // The estate retires locations; nothing in this page can remove one.
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  it('never offers to archive the organization root', async () => {
    authAs(['admin']);
    renderWithProviders(<LocationsPage />, { store });

    await screen.findByText('Acme');
    expect(screen.queryByRole('button', { name: /Archive Acme/ })).not.toBeInTheDocument();
  });

  it('hides every editing control from a viewer', async () => {
    authAs(['viewer']);
    renderWithProviders(<LocationsPage />, { store });

    await screen.findByText('London');
    expect(screen.queryByRole('button', { name: /Rename/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add a location/ })).not.toBeInTheDocument();
  });

  it('says so when the estate was larger than one read', async () => {
    authAs(['admin']);
    server.use(
      mswHttp.get('/api/tenant/tenants/:tenantId/org-tree', () =>
        HttpResponse.json({
          success: true,
          data: { roots: [], nodeCount: 0, orphaned: [], truncated: true },
        }),
      ),
    );

    renderWithProviders(<LocationsPage />, { store });
    expect(await screen.findByText(/larger than one view/i)).toBeInTheDocument();
  });

  it('surfaces a location whose parent no longer resolves', async () => {
    authAs(['admin']);
    server.use(
      mswHttp.get('/api/tenant/tenants/:tenantId/org-tree', () =>
        HttpResponse.json({
          success: true,
          data: { roots: [], nodeCount: 1, orphaned: ['on_ghost'], truncated: false },
        }),
      ),
    );

    renderWithProviders(<LocationsPage />, { store });
    expect(await screen.findByText(/no longer resolves/i)).toBeInTheDocument();
  });
});

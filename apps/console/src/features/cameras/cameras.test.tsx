import { afterEach, describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { permissionsForRoles } from '@vip/permissions';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { CamerasPage } from './CamerasPage';
import { CameraDetailPage } from './CameraDetailPage';
import { capabilitySummary, dvrChannels, matchesSearch } from './cameraPresentation';

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

const CAPABILITIES = {
  ptz: true,
  audio: false,
  snapshot: true,
  codecs: ['h264'],
  resolutions: ['2560x1440', '640x360'],
  protocols: ['rtsp'],
  streamProfiles: [
    { name: 'main', resolution: '2560x1440', fps: 25, preferredForAnalysis: false },
    { name: 'sub', resolution: '640x360', fps: 10, preferredForAnalysis: true },
  ],
  onvif: true,
  metadataStream: false,
  fpsRange: { min: 10, max: 25 },
};

const CAMERA = {
  id: 'cam_1',
  tenantId: 'tnt_acme',
  zoneId: 'on_lobby',
  name: 'Front entrance',
  protocol: 'rtsp',
  streamUrl: 'rtsp://10.0.0.64:554/Streaming/Channels/102',
  status: 'enabled',
  capture: { ptz: false },
  health: { status: 'online', lastCheckedAt: '2026-08-01T10:00:00.000Z' },
  capabilities: CAPABILITIES,
  metadata: { manufacturer: 'Hikvision', model: 'DS-2CD2143G2', firmware: 'V5.7.3', tags: [] },
  lifecycle: {
    state: 'connected',
    since: '2026-08-01T10:00:00.000Z',
    evidence: 'measured',
    reason: 'read 3 frames at 640x360',
  },
  timeline: [
    {
      at: '2026-08-01T09:00:00.000Z',
      kind: 'state-changed',
      evidence: 'declared',
      reasonCode: 'onboarded',
      to: 'configured',
      detail: 'onboarded',
    },
  ],
  identity: {
    onvifUuid: 'urn:uuid:abc-123',
    serialNumber: 'DS2CD00112233',
    lastKnownAddress: '10.0.0.64',
  },
  identityHistory: [
    {
      at: '2026-08-01T09:00:00.000Z',
      attribute: 'address',
      from: '10.0.0.60',
      to: '10.0.0.64',
      source: 'discovery',
    },
  ],
  capabilityCache: {
    cacheVersion: 1,
    refreshCount: 2,
    source: 'onvif-directed',
    freshness: 'fresh',
    firmware: 'V5.7.3',
    discoveredAt: '2026-08-01T09:00:00.000Z',
    lastRefreshedAt: '2026-08-01T09:30:00.000Z',
  },
  operational: {
    observedAt: '2026-08-01T10:00:00.000Z',
    source: 'stream-probe',
    evidenceClass: 'hardware',
    reachable: true,
    streamAvailable: true,
    rtspLatencyMs: 412,
    fps: 10,
    authentication: 'ok',
  },
  // P-2.2: what this camera has been proven to work under, per axis value.
  compatibility: [
    {
      dimension: 'firmware',
      value: 'V5.7.3',
      status: 'supported',
      firstSeenAt: '2026-08-01T09:00:00.000Z',
      lastSeenAt: '2026-08-01T10:00:00.000Z',
      evidenceClass: 'hardware',
      successfulProbes: 4,
      failedProbes: 0,
    },
  ],
  probeCount: 4,
  hasCredentials: true,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
};

const OFFLINE_CAMERA = {
  ...CAMERA,
  id: 'cam_2',
  name: 'Stock room',
  streamUrl: 'rtsp://10.0.0.65:554/Streaming/Channels/102',
  health: { status: 'offline' },
  lifecycle: { state: 'offline', since: '2026-08-01T10:00:00.000Z', evidence: 'measured' },
  identityHistory: [],
  metadata: { manufacturer: 'Dahua', model: 'IPC-HFW', tags: [] },
};

const DEVICE = {
  endpoint: 'http://10.0.0.70/onvif/device_service',
  address: '10.0.0.70',
  metadata: { manufacturer: 'Axis', model: 'P3245', firmware: '11.2', tags: [] },
  capabilities: CAPABILITIES,
  suggestedStreamUrl: 'rtsp://10.0.0.70:554/axis-media/media.amp',
  registryId: 'axis-p3245',
  alreadyOnboarded: false,
  addressChanged: false,
  identityConfidence: 'unknown',
};

/**
 * ⚠️ **A page, and the query that produced it.**
 *
 * P-6.6 moved search, location and lifecycle filtering to the server, so the list route now answers
 * `{ cameras, nextCursor }` and the console always sends a `limit`. The handler records the query it
 * was called with, because "the browser filtered it" and "the server filtered it" look identical on
 * screen and are the whole difference between nine cameras and five thousand.
 */
const listCalls: URLSearchParams[] = [];

function listReturns(cameras: unknown[], nextCursor?: string) {
  listCalls.length = 0;
  server.use(
    mswHttp.get('/api/camera/cameras', ({ request }) => {
      listCalls.push(new URL(request.url).searchParams);
      return HttpResponse.json({
        success: true,
        data: { cameras, ...(nextCursor ? { nextCursor } : {}) },
      });
    }),
    /* The estate's own count — the page's "of N" comes from here, never from the page length. */
    mswHttp.get('/api/camera/cameras/metrics', () =>
      HttpResponse.json({
        success: true,
        data: {
          window: 'day',
          windowStart: '2026-08-05T00:00:00.000Z',
          windowEnd: '2026-08-05T12:00:00.000Z',
          cameras: cameras.length,
          sampled: false,
          camerasProbed: 0,
          camerasNeverProbed: cameras.length,
          probes: 0,
          successes: 0,
          failures: 0,
        },
      }),
    ),
  );
}

/** The detail page fetches the camera by id — it no longer inherits a row object from the list. */
function detailReturns(camera: Record<string, unknown>) {
  server.use(
    mswHttp.get('/api/camera/cameras/:id', () =>
      HttpResponse.json({ success: true, data: camera }),
    ),
    /* No stream worker is the normal case, and it is a 404 by design (measured on the deployment). */
    mswHttp.get('/api/media/streams/:id/status', () =>
      HttpResponse.json(
        { success: false, error: { code: 'not_found', message: 'no stream for camera' } },
        { status: 404 },
      ),
    ),
  );
}

function discoveryReturns(body: Record<string, unknown>) {
  server.use(
    mswHttp.post('/api/camera/cameras/discover', () =>
      HttpResponse.json({ success: true, data: { probedSeconds: 3, ...body } }),
    ),
  );
}

describe('CamerasPage', () => {
  it('lists cameras with their health and analysed capabilities', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    renderWithProviders(<CamerasPage />, { store });

    expect(await screen.findByText('Front entrance')).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
    // The summary shows the SUB-stream resolution — the profile the runtime will actually analyse.
    expect(screen.getByText(/640x360/)).toBeInTheDocument();
    expect(screen.getByText(/ONVIF/)).toBeInTheDocument();
  });

  it('offers an empty state that leads to discovery', async () => {
    authAs(['admin']);
    listReturns([]);
    renderWithProviders(<CamerasPage />, { store });
    expect(await screen.findByText('No cameras yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /discover/i }).length).toBeGreaterThan(0);
  });

  it('hides the add and discover actions without camera:create', async () => {
    authAs(['viewer']);
    listReturns([CAMERA]);
    renderWithProviders(<CamerasPage />, { store });
    await screen.findByText('Front entrance');
    expect(screen.queryByRole('button', { name: /add cameras/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /discover/i })).not.toBeInTheDocument();
  });

  /**
   * ⚠️ **The search is the server's, and this asserts that it left the browser.**
   *
   * Before P-6.6 this test typed into the box and watched rows disappear — which is what a
   * *client-side* filter over a fully-loaded estate looks like, and it passed for exactly that
   * reason. The console now asks the camera service, so the thing worth asserting is that the
   * request carried the term: rows disappearing would prove nothing here, because the mock returns
   * whatever it is asked for.
   */
  it('sends the search to the server rather than filtering in the browser', async () => {
    authAs(['operator']);
    listReturns([CAMERA, OFFLINE_CAMERA]);
    renderWithProviders(<CamerasPage />, { store });
    await screen.findByText('Front entrance');

    await userEvent.type(screen.getByPlaceholderText('Search cameras…'), 'Dahua');
    await waitFor(() => {
      expect(listCalls.some((params) => params.get('search') === 'Dahua')).toBe(true);
    });
    /* And it is a page request, never "give me everything and I will look through it". */
    expect(listCalls.every((params) => params.get('limit') !== null)).toBe(true);
  });

  it('opens the detail sheet and shows which profile is analysed', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    detailReturns(CAMERA as never);
    renderWithProviders(<CameraDetailPage />, {
      store,
      route: `/cameras/${CAMERA.id}`,
      path: '/cameras/:id',
    });
    const sheet = await screen.findByRole('main').catch(() => document.body);
    expect(within(sheet).getByText('DS-2CD2143G2')).toBeInTheDocument();
    // Twice, for two different reasons (P-2.2): the firmware the device reports, and the firmware
    // row in the compatibility register saying what has been measured under it.
    expect(within(sheet).getAllByText('V5.7.3')).toHaveLength(2);
    /* ⚠️ "Supported" now appears in both the compatibility register and the capability table —
       the assertion says "at least one", because the page legitimately says it twice. */
    expect(within(sheet).getAllByText('Supported').length).toBeGreaterThan(0);
    // The stream-profile table names `sub` as the analysed one.
    const rows = within(sheet).getAllByRole('row');
    const subRow = rows.find((r) => within(r).queryByText('sub'));
    expect(subRow).toBeDefined();
    expect(within(subRow!).getByText('Yes')).toBeInTheDocument();
  });

  it('shows vaulted credentials as a fact, never as a value', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    detailReturns(CAMERA as never);
    renderWithProviders(<CameraDetailPage />, {
      store,
      route: `/cameras/${CAMERA.id}`,
      path: '/cameras/:id',
    });
    /* ⚠️ Await the page before reading it: a detail page fetches, where a sheet was handed a row. */
    await screen.findByRole('heading', { level: 1 });
    const sheet = document.body;
    expect(within(sheet).getByText('stored, encrypted')).toBeInTheDocument();
  });
});

describe('discovery dialog', () => {
  it('lists a discovered device and can onboard it', async () => {
    authAs(['admin']);
    listReturns([]);
    discoveryReturns({ devices: [DEVICE] });
    let onboarded: unknown = null;
    server.use(
      mswHttp.post('/api/camera/cameras/bulk', async ({ request }) => {
        onboarded = await request.json();
        return HttpResponse.json({
          success: true,
          data: {
            created: 1,
            failed: 0,
            results: [{ index: 0, name: 'Axis P3245', created: true }],
          },
        });
      }),
    );

    renderWithProviders(<CamerasPage />, { store });
    await userEvent.click((await screen.findAllByRole('button', { name: /discover/i }))[0]!);
    await userEvent.click(await screen.findByRole('button', { name: /^scan$/i }));

    expect(await screen.findByText('Axis P3245')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Select Axis P3245'));

    // P-3: discovery finds a camera on the network; only the operator knows where it physically is.
    await userEvent.click(screen.getByRole('combobox', { name: /location/i }));
    await userEvent.click(await screen.findByRole('option', { name: /Lobby/ }));

    await userEvent.click(screen.getByRole('button', { name: /add 1 camera/i }));

    await waitFor(() => expect(onboarded).not.toBeNull());
    const payload = onboarded as { cameras: Array<Record<string, unknown>> };
    expect(payload.cameras[0]!.streamUrl).toBe(DEVICE.suggestedStreamUrl);
    // Placed where the operator said, not in a hardcoded default.
    expect(payload.cameras[0]!.zoneId).toBe('on_lobby');
    // Capabilities travel with the camera so the runtime READS them instead of probing the device.
    expect(payload.cameras[0]!.capabilities).toMatchObject({ onvif: true });
  });

  it('shows an already-onboarded device greyed and unselectable rather than hiding it', async () => {
    // An installer re-scanning a half-configured site must be able to tell "already added" from
    // "did not answer" — hiding these makes those two indistinguishable.
    authAs(['admin']);
    listReturns([]);
    discoveryReturns({
      devices: [{ ...DEVICE, alreadyOnboarded: true, cameraId: 'cam_9' }],
    });
    renderWithProviders(<CamerasPage />, { store });
    await userEvent.click((await screen.findAllByRole('button', { name: /discover/i }))[0]!);
    await userEvent.click(await screen.findByRole('button', { name: /^scan$/i }));

    expect(await screen.findByText('Already added')).toBeInTheDocument();
    expect(screen.getByLabelText('Select Axis P3245')).toBeDisabled();
  });

  it('distinguishes "could not run" from "found nothing"', async () => {
    authAs(['admin']);
    listReturns([]);
    discoveryReturns({ devices: [], unavailable: 'WS-Discovery could not run on this host' });
    renderWithProviders(<CamerasPage />, { store });
    await userEvent.click((await screen.findAllByRole('button', { name: /discover/i }))[0]!);
    await userEvent.click(await screen.findByRole('button', { name: /^scan$/i }));

    expect(await screen.findByText('Discovery could not run')).toBeInTheDocument();
    expect(screen.getByText(/not an empty estate/i)).toBeInTheDocument();
    expect(screen.queryByText('No devices answered')).not.toBeInTheDocument();
  });

  it('reports an empty network as an empty network', async () => {
    authAs(['admin']);
    listReturns([]);
    discoveryReturns({ devices: [] });
    renderWithProviders(<CamerasPage />, { store });
    await userEvent.click((await screen.findAllByRole('button', { name: /discover/i }))[0]!);
    await userEvent.click(await screen.findByRole('button', { name: /^scan$/i }));

    expect(await screen.findByText('No devices answered')).toBeInTheDocument();
    expect(screen.queryByText('Discovery could not run')).not.toBeInTheDocument();
  });

  it('lists a device that half-answered, with its warning', async () => {
    authAs(['admin']);
    listReturns([]);
    discoveryReturns({
      devices: [
        {
          ...DEVICE,
          suggestedStreamUrl: undefined,
          warning: 'capability negotiation failed: Sender not Authorized',
        },
      ],
    });
    renderWithProviders(<CamerasPage />, { store });
    await userEvent.click((await screen.findAllByRole('button', { name: /discover/i }))[0]!);
    await userEvent.click(await screen.findByRole('button', { name: /^scan$/i }));

    expect(await screen.findByText(/Sender not Authorized/)).toBeInTheDocument();
    expect(screen.getByLabelText('Select Axis P3245')).toBeDisabled();
  });
});

describe('cameraPresentation', () => {
  it('summarises the analysed profile, not the largest one', () => {
    // The whole point: an operator must see the stream the runtime will decode.
    expect(capabilitySummary(CAPABILITIES as never)).toContain('640x360');
    expect(capabilitySummary(CAPABILITIES as never)).not.toContain('2560x1440');
  });

  it('falls back to the first declared resolution when nothing is marked for analysis', () => {
    const caps = { ...CAPABILITIES, streamProfiles: [] };
    expect(capabilitySummary(caps as never)).toContain('2560x1440');
  });

  it('returns an empty summary for absent capabilities rather than a misleading one', () => {
    expect(capabilitySummary(undefined)).toBe('');
  });

  it('searches across name, url, zone and device metadata', () => {
    expect(matchesSearch(CAMERA as never, 'hikvision')).toBe(true);
    expect(matchesSearch(CAMERA as never, 'on_lobby')).toBe(true);
    expect(matchesSearch(CAMERA as never, 'Channels/102')).toBe(true);
    expect(matchesSearch(CAMERA as never, 'nothing')).toBe(false);
    expect(matchesSearch(CAMERA as never, '  ')).toBe(true);
  });

  it('expands DVR channel templates', () => {
    const channels = dvrChannels({
      namePrefix: 'Aisle',
      zoneId: 'on_z',
      baseUrl: 'rtsp://10.0.0.9:554/',
      pathTemplate: '/cam/realmonitor?channel={channel}&subtype=1',
      channels: 3,
    });
    expect(channels).toHaveLength(3);
    expect(channels[0]!.name).toBe('Aisle 1');
    expect(channels[0]!.streamUrl).toBe('rtsp://10.0.0.9:554/cam/realmonitor?channel=1&subtype=1');
    expect(channels[2]!.streamUrl).toContain('channel=3');
  });

  it('honours a start offset so a second DVR can continue the numbering', () => {
    const channels = dvrChannels({
      namePrefix: 'Ch',
      zoneId: 'on_z',
      baseUrl: 'rtsp://10.0.0.9:554',
      pathTemplate: '/Streaming/Channels/{channel}02',
      channels: 2,
      startAt: 9,
    });
    expect(channels[0]!.name).toBe('Ch 9');
    expect(channels[0]!.streamUrl).toBe('rtsp://10.0.0.9:554/Streaming/Channels/902');
  });
});

// -------------------------------------------------------------------------------------------
// P-2: lifecycle, measured health, the installer test-connection readout
// -------------------------------------------------------------------------------------------

function probeReturns(body: Record<string, unknown>) {
  server.use(
    mswHttp.post('/api/camera/cameras/:id/probe', () =>
      HttpResponse.json({ success: true, data: body }),
    ),
  );
}

const PASSING_PROBE = {
  probedAt: '2026-08-01T10:00:00.000Z',
  evidenceClass: 'hardware',
  reachable: true,
  framesRead: 3,
  firstFrameMs: 412,
  fps: 10,
  resolution: '640x360',
  authentication: 'ok',
  probeVersion: '2',
  runtimeVersion: '0.1.0',
  totalMs: 346,
  checks: [
    { name: 'dns', status: 'pass', measured: '10.0.0.64', durationMs: 12 },
    { name: 'tcp', status: 'pass', measured: '10.0.0.64:554', durationMs: 4 },
    { name: 'authentication', status: 'pass', durationMs: 38 },
    { name: 'rtsp-negotiation', status: 'pass', durationMs: 110 },
    { name: 'stream-open', status: 'pass' },
    { name: 'first-frame', status: 'pass', durationMs: 182 },
    { name: 'frames-received', status: 'pass', measured: '3 frames' },
  ],
  profiles: [],
  warnings: [],
};

/**
 * ⚠️ **"Open the detail" is a navigation now, not a click that opens a drawer.**
 *
 * The camera has an address (`/cameras/:id`), so these tests render that page directly rather than
 * clicking a row — which is also what an operator following a link does. The helper keeps the old
 * name so the tests below read as they did; what changed is the surface underneath them.
 */
async function openDetail(camera: Record<string, unknown> = CAMERA as never) {
  detailReturns(camera);
  renderWithProviders(<CameraDetailPage />, {
    store,
    route: `/cameras/${String(camera.id)}`,
    path: '/cameras/:id',
  });
  await screen.findByRole('heading', { level: 1 });
  return userEvent.setup();
}

describe('camera lifecycle (P-2)', () => {
  it('shows the lifecycle state alongside health, because they answer different questions', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    renderWithProviders(<CamerasPage />, { store });

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('hides retired cameras by default but keeps them one filter away', async () => {
    authAs(['operator']);
    const retired = {
      ...CAMERA,
      id: 'cam_3',
      name: 'Old loading bay',
      lifecycle: {
        state: 'retired',
        since: '2026-08-01T10:00:00.000Z',
        evidence: 'administrative',
      },
    };
    listReturns([CAMERA, retired]);
    renderWithProviders(<CamerasPage />, { store });

    // A site that has replaced its cameras twice must not show three times as many rows as devices.
    expect(await screen.findByText('Front entrance')).toBeInTheDocument();
    expect(screen.queryByText('Old loading bay')).not.toBeInTheDocument();
  });

  it('explains what a state means rather than assuming the operator read the ADR', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    await openDetail(CAMERA as never);

    expect(
      await screen.findByText(/frames were read from the physical device/i),
    ).toBeInTheDocument();
  });

  it('distinguishes a camera never measured from one measured and found offline', async () => {
    authAs(['operator']);
    const unmeasured = {
      ...CAMERA,
      operational: undefined,
      lifecycle: { state: 'configured', since: '2026-08-01T09:00:00.000Z', evidence: 'declared' },
    };
    listReturns([unmeasured]);
    await openDetail(unmeasured as never);

    // Rendering an unmeasured latency as "0 ms" would claim a measurement nobody took.
    expect(await screen.findByText(/Nothing has ever measured this camera/i)).toBeInTheDocument();
  });
});

describe('test connection (P-2)', () => {
  it('reads out every check, so a credential problem is not mistaken for a cabling one', async () => {
    authAs(['admin']);
    listReturns([CAMERA]);
    probeReturns({
      cameraId: 'cam_1',
      probe: {
        ...PASSING_PROBE,
        framesRead: 0,
        authentication: 'failed',
        failureCode: 'authentication-failure',
        checks: [
          { name: 'dns', status: 'pass', measured: '10.0.0.64', durationMs: 12 },
          { name: 'tcp', status: 'pass', measured: '10.0.0.64:554', durationMs: 4 },
          { name: 'authentication', status: 'fail', detail: '401 from the device' },
          { name: 'rtsp-negotiation', status: 'not-executed' },
          { name: 'stream-open', status: 'not-executed' },
        ],
      },
      operational: {
        observedAt: '2026-08-01T10:00:00.000Z',
        source: 'stream-probe',
        evidenceClass: 'hardware',
        reachable: true,
        streamAvailable: false,
        authentication: 'failed',
      },
      lifecycle: { state: 'degraded', since: '2026-08-01T10:00:00.000Z', evidence: 'measured' },
    });
    renderWithProviders(<CamerasPage />, { store });
    const user = await openDetail();
    await user.click(await screen.findByRole('button', { name: /test connection/i }));

    // The headline is the runtime's typed code rendered, not a guess made here (rec 10).
    expect(await screen.findByText(/The device rejected the credentials/i)).toBeInTheDocument();
    expect(screen.getByText(/Check the username and password/i)).toBeInTheDocument();
    expect(screen.getByText('Device reachable')).toBeInTheDocument();
    expect(screen.getByText('401 from the device', { exact: false })).toBeInTheDocument();
    // The stream was never attempted — showing it as a failure would blame the wrong component.
    expect(screen.getByText('RTSP negotiated')).toBeInTheDocument();
  });

  it('says plainly when the deployment cannot test connections at all', async () => {
    authAs(['admin']);
    listReturns([CAMERA]);
    probeReturns({
      cameraId: 'cam_1',
      lifecycle: CAMERA.lifecycle,
      unavailable: 'stream validation is not configured for this deployment',
    });
    renderWithProviders(<CamerasPage />, { store });
    const user = await openDetail();
    await user.click(await screen.findByRole('button', { name: /test connection/i }));

    // A deployment gap must not be reported as a camera fault.
    expect(await screen.findByText(/Connections cannot be tested here/i)).toBeInTheDocument();
    expect(screen.getByText(/deployment gap, not a fault with this camera/i)).toBeInTheDocument();
  });

  it('marks a simulated measurement as one that proves nothing about the camera', async () => {
    authAs(['admin']);
    listReturns([CAMERA]);
    probeReturns({
      cameraId: 'cam_1',
      probe: { ...PASSING_PROBE, evidenceClass: 'simulated' },
      lifecycle: CAMERA.lifecycle,
    });
    renderWithProviders(<CamerasPage />, { store });
    const user = await openDetail();
    await user.click(await screen.findByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/simulated source/i)).toBeInTheDocument();
  });

  it('does not offer the test to someone who cannot run it', async () => {
    authAs(['viewer']);
    listReturns([CAMERA]);
    await openDetail(CAMERA as never);

    expect(await screen.findByRole('button', { name: /test connection/i })).toBeDisabled();
  });
});

describe('discovery after an address change (P-2)', () => {
  it('says the camera moved instead of offering it as a new device', async () => {
    authAs(['admin']);
    listReturns([CAMERA]);
    discoveryReturns({
      devices: [
        {
          ...DEVICE,
          alreadyOnboarded: true,
          addressChanged: true,
          cameraId: 'cam_1',
          address: '10.0.0.99',
        },
      ],
    });
    renderWithProviders(<CamerasPage />, { store });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^discover$/i }));
    await user.click(await screen.findByRole('button', { name: /^scan$/i }));

    expect(await screen.findByText(/its address changed to 10\.0\.0\.99/i)).toBeInTheDocument();
  });
});

// -------------------------------------------------------------------------------------------
// P-2.1: staged diagnostics, capability diff, identity history
// -------------------------------------------------------------------------------------------

describe('staged probe readout (P-2.1)', () => {
  it('shows each stage with its own duration, so "slow" becomes a specific stage', async () => {
    authAs(['admin']);
    listReturns([CAMERA]);
    probeReturns({ cameraId: 'cam_1', probe: PASSING_PROBE, lifecycle: CAMERA.lifecycle });
    renderWithProviders(<CamerasPage />, { store });
    const user = await openDetail();
    await user.click(await screen.findByRole('button', { name: /test connection/i }));

    expect(await screen.findByText('Name resolved')).toBeInTheDocument();
    expect(screen.getByText('Device reachable')).toBeInTheDocument();
    expect(screen.getByText('First frame received')).toBeInTheDocument();
    // Total time alone cannot say which step is slow.
    expect(screen.getByText('12 ms')).toBeInTheDocument();
    expect(screen.getByText('182 ms')).toBeInTheDocument();
    expect(screen.getByText(/346 ms total/)).toBeInTheDocument();
  });

  it('renders the runtime’s failure code rather than inferring one', async () => {
    authAs(['admin']);
    listReturns([CAMERA]);
    probeReturns({
      cameraId: 'cam_1',
      probe: {
        ...PASSING_PROBE,
        framesRead: 0,
        failureCode: 'dns-failure',
        checks: [
          { name: 'dns', status: 'fail', detail: 'Name or service not known' },
          { name: 'tcp', status: 'not-executed' },
        ],
      },
      lifecycle: CAMERA.lifecycle,
    });
    renderWithProviders(<CamerasPage />, { store });
    const user = await openDetail();
    await user.click(await screen.findByRole('button', { name: /test connection/i }));

    // A DNS problem sends someone to their DNS, not to a ladder.
    expect(await screen.findByText(/hostname did not resolve/i)).toBeInTheDocument();
    expect(screen.getByText(/use the IP address instead of a hostname/i)).toBeInTheDocument();
  });

  it('records the probe version, so two reports months apart are comparable', async () => {
    authAs(['admin']);
    listReturns([CAMERA]);
    probeReturns({ cameraId: 'cam_1', probe: PASSING_PROBE, lifecycle: CAMERA.lifecycle });
    renderWithProviders(<CamerasPage />, { store });
    const user = await openDetail();
    await user.click(await screen.findByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/Probe v2/)).toBeInTheDocument();
  });
});

describe('capability cache and diff (P-2.1)', () => {
  it('shows how stale the capabilities are and what they were read against', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    await openDetail(CAMERA as never);

    expect(await screen.findByText('Fresh')).toBeInTheDocument();
    expect(screen.getByText(/read against V5\.7\.3/)).toBeInTheDocument();
  });

  it('shows what changed after a refresh, not merely that it happened', async () => {
    authAs(['admin']);
    listReturns([CAMERA]);
    server.use(
      mswHttp.post('/api/camera/cameras/:id/capabilities/refresh', () =>
        HttpResponse.json({
          success: true,
          data: {
            cameraId: 'cam_1',
            capabilities: CAPABILITIES,
            cache: CAMERA.capabilityCache,
            reason: 'forced',
            refreshed: true,
            changes: [
              // P-2.2: unexplained, and therefore unexpected — nothing accounts for a codec moving.
              {
                field: 'codecs',
                severity: 'major',
                from: 'h264',
                to: 'h265',
                direction: 'changed',
                cause: 'unexplained',
                drift: 'unexpected',
              },
              {
                field: 'audio',
                severity: 'minor',
                from: 'false',
                to: 'true',
                direction: 'changed',
                cause: 'firmware-upgrade',
                drift: 'expected',
              },
            ],
          },
        }),
      ),
    );
    renderWithProviders(<CamerasPage />, { store });
    const user = await openDetail();
    await user.click(await screen.findByRole('button', { name: /refresh capabilities/i }));

    // "Capabilities refreshed" tells an operator nothing; this tells them their decode cost moved.
    expect(await screen.findByText('codecs')).toBeInTheDocument();
    expect(screen.getByText(/h264 → h265/)).toBeInTheDocument();
    expect(screen.getByText('major')).toBeInTheDocument();
  });
});

describe('device identity history (P-2.1)', () => {
  it('shows when a camera changed address, rather than overwriting the fact', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    await openDetail(CAMERA as never);

    expect(await screen.findByText('Device identity')).toBeInTheDocument();
    expect(screen.getByText('urn:uuid:abc-123')).toBeInTheDocument();
    // "When did this camera become a different device?" is only answerable if the old value survives.
    expect(screen.getByText(/10\.0\.0\.60 → 10\.0\.0\.64/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------
// P-2.2 — the probe archive in the console
// ---------------------------------------------------------------------------------------------

const ARCHIVED_OK = {
  probeId: 'prb_2',
  cameraId: 'cam_1',
  at: '2026-08-01T10:00:00.000Z',
  sequence: 2,
  outcome: 'succeeded',
  evidenceClass: 'hardware',
  probeVersion: '3',
  provider: 'rtsp',
  configuration: {
    protocol: 'rtsp',
    streamUrl: 'rtsp://10.0.0.64:554/Streaming/Channels/102',
    provider: 'rtsp',
    credentialsSupplied: true,
    firmware: 'V5.7.3',
  },
  lifecycleBefore: 'degraded',
  lifecycleAfter: 'connected',
  previousProbeId: 'prb_1',
  previousProbeAt: '2026-08-01T09:00:00.000Z',
  previousOutcome: 'failed',
  previousFailureCode: 'authentication-failure',
};

const ARCHIVED_FAILED = {
  ...ARCHIVED_OK,
  probeId: 'prb_1',
  sequence: 1,
  at: '2026-08-01T09:00:00.000Z',
  outcome: 'failed',
  failureCode: 'authentication-failure',
  lifecycleBefore: 'configured',
  lifecycleAfter: 'degraded',
  previousProbeId: undefined,
};

function archiveReturns(records: unknown[], evicted = 0) {
  server.use(
    mswHttp.get('/api/camera/cameras/:id/probes', () =>
      HttpResponse.json({
        success: true,
        data: {
          cameraId: 'cam_1',
          records,
          total: records.length + evicted,
          retained: records.length,
          evicted,
        },
      }),
    ),
  );
}

describe('probe archive (P-2.2)', () => {
  it('shows every probe a camera has had, not only the latest', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    archiveReturns([ARCHIVED_OK, ARCHIVED_FAILED]);
    await openDetail();

    // Before the archive existed each probe overwrote the last, which made "was it always like
    // this?" — the first question anyone asks about a slow camera — permanently unanswerable.
    expect(await screen.findByText('2 probes')).toBeInTheDocument();
    expect(screen.getByText(/rejected the credentials/i)).toBeInTheDocument();
  });

  it('says so when older reports have been aged out', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    archiveReturns([ARCHIVED_OK], 140);
    await openDetail();

    // A list that simply stops would let "1 probe, successful" stand for a camera with 140 failures
    // behind it.
    expect(await screen.findByText(/showing 1 of 141 probes/i)).toBeInTheDocument();
  });

  it('replays a stored report and names what changed, without contacting the camera', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    archiveReturns([ARCHIVED_OK, ARCHIVED_FAILED]);
    let probed = false;
    server.use(
      mswHttp.post('/api/camera/cameras/:id/probe', () => {
        probed = true;
        return HttpResponse.json({ success: true, data: {} });
      }),
      mswHttp.get('/api/camera/cameras/:id/probes/:probeId', () =>
        HttpResponse.json({
          success: true,
          data: {
            probeId: 'prb_2',
            cameraId: 'cam_1',
            recordedAt: '2026-08-01T10:00:00.000Z',
            replayedAt: '2026-08-08T10:00:00.000Z',
            evidenceClass: 'hardware',
            probeVersion: '3',
            provider: 'rtsp',
            outcome: 'succeeded',
            configuration: ARCHIVED_OK.configuration,
            stages: [
              { name: 'dns', status: 'pass', measured: '10.0.0.64', durationMs: 12 },
              { name: 'authentication', status: 'pass', durationMs: 90 },
            ],
            totalMs: 640,
            warnings: [],
            comparison: {
              previousProbeId: 'prb_1',
              previousAt: '2026-08-01T09:00:00.000Z',
              outcomeChanged: true,
              previousOutcome: 'failed',
              previousFailureCode: 'authentication-failure',
              stageChanges: [{ name: 'authentication', from: 'fail', to: 'pass' }],
              configurationChanged: false,
            },
          },
        }),
      ),
    );
    renderWithProviders(<CamerasPage />, { store });
    const user = await openDetail();

    // Clicked by its accessible name rather than its rendered timestamp: the timestamp is
    // locale-formatted, and a test that depends on the runner's locale is a flake waiting to happen.
    const [succeeded] = await screen.findAllByRole('button', { name: /succeeded/i });
    await user.click(succeeded!);

    expect(await screen.findByText(/the camera was not contacted/i)).toBeInTheDocument();
    // The comparison is the diagnosis: authentication used to fail and now passes.
    expect(screen.getByText(/previously/i)).toBeInTheDocument();
    expect(screen.getByText('fail → pass')).toBeInTheDocument();
    // Support work happens days later, often on a camera since power-cycled into working. Replay
    // must never quietly become a fresh measurement.
    expect(probed).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// P-2.3 — the unified investigation timeline
// ---------------------------------------------------------------------------------------------

const ENVELOPE = {
  tenantId: 'tnt_acme',
  producer: 'camera-service',
  evidence: 'measured',
  severity: 'info',
  reasonCode: 'derived',
};

function evidenceReturns(entries: unknown[], sources: string[]) {
  server.use(
    mswHttp.get('/api/camera/cameras/:id/evidence', () =>
      HttpResponse.json({
        success: true,
        data: {
          cameraId: 'cam_1',
          from: '2026-07-03T00:00:00.000Z',
          to: '2026-08-02T00:00:00.000Z',
          entries,
          sources,
          truncated: false,
        },
      }),
    ),
  );
}

describe('evidence timeline (P-2.3)', () => {
  it('renders an evidence type the console has never heard of', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    evidenceReturns(
      [
        {
          ...ENVELOPE,
          evidenceId: 'rec:1',
          // Neither of these exists in the console's label maps. The unified timeline is the only
          // investigation API (rec 6), so a producer that ships before a console release must still
          // appear — reading its own name in words rather than a blank cell.
          evidenceType: 'recovery-attempt',
          source: 'recovery',
          producer: 'ai-runtime',
          at: '2026-08-01T10:00:00.000Z',
          summary: 'session restarted after three consecutive decode failures',
          links: { cameraId: 'cam_1', causedEvidenceIds: [] },
        },
      ],
      ['recovery'],
    );
    await openDetail();

    expect(
      await screen.findByText(/session restarted after three consecutive decode failures/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Recovery').length).toBeGreaterThan(0);
    expect(screen.getByText('AI runtime')).toBeInTheDocument();
  });

  it('shows what an entry was caused by and what it went on to cause', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    evidenceReturns(
      [
        {
          ...ENVELOPE,
          evidenceId: 'tl:4:state-changed',
          evidenceType: 'state-change',
          source: 'lifecycle',
          at: '2026-08-01T10:00:01.000Z',
          summary: 'first-frame failed',
          severity: 'warning',
          links: {
            cameraId: 'cam_1',
            rootCauseEvidenceId: 'probe:prb_9',
            causedEvidenceIds: [],
          },
        },
        {
          ...ENVELOPE,
          evidenceId: 'probe:prb_9',
          evidenceType: 'probe-report',
          source: 'probe',
          producer: 'ai-runtime',
          at: '2026-08-01T10:00:00.000Z',
          summary: 'probe failed: no-first-frame via rtsp',
          severity: 'warning',
          links: { cameraId: 'cam_1', causedEvidenceIds: ['tl:4:state-changed'] },
        },
      ],
      ['lifecycle', 'probe'],
    );
    await openDetail();

    // Backwards answers "why did this happen"; forwards answers "what did it break".
    expect(await screen.findByText(/caused by: probe failed: no-first-frame/)).toBeInTheDocument();
    expect(screen.getByText(/led to 1 further event/)).toBeInTheDocument();
  });

  it('explains a decision and shows the evidence behind it', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    evidenceReturns(
      [
        {
          ...ENVELOPE,
          evidenceId: 'probe:prb_9',
          evidenceType: 'probe-report',
          source: 'probe',
          producer: 'ai-runtime',
          at: '2026-08-01T10:00:00.000Z',
          summary: 'probe succeeded via rtsp',
          links: { cameraId: 'cam_1', causedEvidenceIds: [] },
        },
      ],
      ['probe'],
    );
    server.use(
      mswHttp.get('/api/camera/cameras/:id/decisions', () =>
        HttpResponse.json({
          success: true,
          data: {
            cameraId: 'cam_1',
            from: '2026-07-03T00:00:00.000Z',
            to: '2026-08-02T00:00:00.000Z',
            decisions: [
              {
                kind: 'lifecycle-state',
                at: '2026-08-01T10:00:00.000Z',
                actor: 'camera-service',
                decision: 'unchanged',
                reason:
                  'this probe measured a simulated source, not the camera. States that describe a physical device may only be entered from hardware evidence, so nothing moved',
                supportingEvidence: ['probe:prb_9'],
                evidenceClass: 'simulated',
              },
            ],
          },
        }),
      ),
    );
    const user = await openDetailWithRender();

    await user.click(await screen.findByRole('button', { name: /why did the platform do this/i }));

    // The negative control, made legible: without an explanation, a state that correctly refuses to
    // move looks exactly like a bug.
    expect(
      await screen.findByText(/may only be entered from hardware evidence/),
    ).toBeInTheDocument();
    expect(screen.getByText('probe:prb_9')).toBeInTheDocument();
  });
});

async function openDetailWithRender() {
  return openDetail();
}

/**
 * P-6.6 — the claims this milestone added, and the defects behind them.
 */
describe('camera management depth (P-6.6)', () => {
  it('⚠️ refuses to overwrite an edit somebody else made, and keeps what was typed', async () => {
    authAs(['admin']);
    listReturns([CAMERA]);
    const user = await openDetail();

    let sentIfMatch: string | null = null;
    server.use(
      mswHttp.patch('/api/camera/cameras/:id', ({ request }) => {
        sentIfMatch = request.headers.get('if-match');
        return HttpResponse.json(
          {
            success: false,
            error: {
              code: 'conflict',
              message: 'this camera was changed by someone else at 2026-08-05T10:00:00.000Z',
            },
          },
          { status: 409 },
        );
      }),
    );

    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    const notes = await screen.findByLabelText('Notes');
    await user.clear(notes);
    await user.type(notes, 'lens cleaned');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    /* The token the server needs in order to be able to refuse at all. */
    await waitFor(() => expect(sentIfMatch).toBe(CAMERA.updatedAt));
    /* The refusal is explained in the dialog… */
    expect(await screen.findByText(/somebody else changed this camera/i)).toBeInTheDocument();
    /* …and the operator's typing is still there, because retyping it into a record they have not
       seen is how the *other* person's change gets lost next. */
    expect(screen.getByLabelText('Notes')).toHaveValue('lens cleaned');
  });

  it('⚠️ distinguishes a measured capability from one that was merely declared', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    await openDetail();

    const ptz = document.querySelector('[data-capability="ptz"]');
    const health = document.querySelector('[data-capability="health"]');
    expect(ptz).not.toBeNull();
    /* PTZ is declared by discovery and has never been exercised — it must not read as proof. */
    expect(within(ptz as HTMLElement).getByText('declared')).toBeInTheDocument();
    /* Health has a real observation behind it. */
    expect(within(health as HTMLElement).getByText('measured')).toBeInTheDocument();
  });

  it('⚠️ says AI analysis is not built rather than leaving the row blank or hopeful', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    await openDetail();

    const ai = document.querySelector('[data-capability="ai"]');
    expect(within(ai as HTMLElement).getByText('not built')).toBeInTheDocument();
    expect(within(ai as HTMLElement).getByText(/no camera is analysed/i)).toBeInTheDocument();
  });

  it('⚠️ reports "no stream worker" as a fact, not as a failure to reach media', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    await openDetail();

    expect(await screen.findByText(/no stream worker for this camera/i)).toBeInTheDocument();
    expect(screen.queryByText(/did not answer/i)).not.toBeInTheDocument();
  });

  it('⚠️ counts the estate from the server, never from the length of the page', async () => {
    authAs(['operator']);
    /* One row on the page, a nextCursor saying there are more — and the server's own total. */
    listReturns([CAMERA], 'cursor-2');
    server.use(
      mswHttp.get('/api/camera/cameras/metrics', () =>
        HttpResponse.json({
          success: true,
          data: {
            window: 'day',
            windowStart: '2026-08-05T00:00:00.000Z',
            windowEnd: '2026-08-05T12:00:00.000Z',
            cameras: 4137,
            sampled: false,
            camerasProbed: 0,
            camerasNeverProbed: 4137,
            probes: 0,
            successes: 0,
            failures: 0,
          },
        }),
      ),
    );
    renderWithProviders(<CamerasPage />, { store });

    expect(await screen.findByText(/of 4137 cameras/)).toBeInTheDocument();
  });
});

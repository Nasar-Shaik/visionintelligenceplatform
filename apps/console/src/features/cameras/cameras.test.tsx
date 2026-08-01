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

function listReturns(cameras: unknown[]) {
  server.use(
    mswHttp.get('/api/camera/cameras', () => HttpResponse.json({ success: true, data: cameras })),
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

  it('filters by search across name, url and device metadata', async () => {
    authAs(['operator']);
    listReturns([CAMERA, OFFLINE_CAMERA]);
    renderWithProviders(<CamerasPage />, { store });
    await screen.findByText('Front entrance');

    await userEvent.type(screen.getByPlaceholderText('Search cameras…'), 'Dahua');
    await waitFor(() => expect(screen.queryByText('Front entrance')).not.toBeInTheDocument());
    expect(screen.getByText('Stock room')).toBeInTheDocument();
  });

  it('opens the detail sheet and shows which profile is analysed', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    renderWithProviders(<CamerasPage />, { store });
    await userEvent.click(await screen.findByText('Front entrance'));

    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('DS-2CD2143G2')).toBeInTheDocument();
    expect(within(sheet).getByText('V5.7.3')).toBeInTheDocument();
    // The stream-profile table names `sub` as the analysed one.
    const rows = within(sheet).getAllByRole('row');
    const subRow = rows.find((r) => within(r).queryByText('sub'));
    expect(subRow).toBeDefined();
    expect(within(subRow!).getByText('Yes')).toBeInTheDocument();
  });

  it('shows vaulted credentials as a fact, never as a value', async () => {
    authAs(['operator']);
    listReturns([CAMERA]);
    renderWithProviders(<CamerasPage />, { store });
    await userEvent.click(await screen.findByText('Front entrance'));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Vaulted')).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('button', { name: /add 1 camera/i }));

    await waitFor(() => expect(onboarded).not.toBeNull());
    const payload = onboarded as { cameras: Array<Record<string, unknown>> };
    expect(payload.cameras[0]!.streamUrl).toBe(DEVICE.suggestedStreamUrl);
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

async function openDetail(name = 'Front entrance') {
  const user = userEvent.setup();
  await user.click(await screen.findByText(name));
  return user;
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
    renderWithProviders(<CamerasPage />, { store });
    await openDetail();

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
    renderWithProviders(<CamerasPage />, { store });
    await openDetail();

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
    renderWithProviders(<CamerasPage />, { store });
    await openDetail();

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
    renderWithProviders(<CamerasPage />, { store });
    await openDetail();

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
              { field: 'codecs', severity: 'major', from: 'h264', to: 'h265' },
              { field: 'audio', severity: 'minor', from: 'false', to: 'true' },
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
    renderWithProviders(<CamerasPage />, { store });
    await openDetail();

    expect(await screen.findByText('Device identity')).toBeInTheDocument();
    expect(screen.getByText('urn:uuid:abc-123')).toBeInTheDocument();
    // "When did this camera become a different device?" is only answerable if the old value survives.
    expect(screen.getByText(/10\.0\.0\.60 → 10\.0\.0\.64/)).toBeInTheDocument();
  });
});

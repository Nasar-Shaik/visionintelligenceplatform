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

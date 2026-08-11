/**
 * The Live Capture page (P-9), in jsdom.
 *
 * ⚠️ **jsdom has no camera, and stubbing one is not the same as having one.** These tests cover what
 * jsdom can honestly answer: the permission and device-failure paths, the guard that stops a capture
 * starting without a target camera, and — most importantly — that an unmeasured stage renders as a
 * dash rather than a zero. What they cannot cover (real pixels, real encode timings, a real device
 * being unplugged) is covered by the browser certification run and is named as such in
 * `COMPLETE_E2E_TEST_GUIDE.md`, not quietly assumed to be tested here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { permissionsForRoles } from '@vip/permissions';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { LiveCamPage } from './LiveCamPage';

const CAMERA = 'cam_live_1';

function authAs(roles: string[] = ['security_manager']) {
  store.dispatch(
    authenticated({
      user: { id: 'usr_me', email: 'op@northgate.demo', roles },
      tenantId: 'tnt_demo_retail',
      permissions: permissionsForRoles(roles),
    }),
  );
}

/** A `mediaDevices` stub whose `getUserMedia` the test controls. */
function stubMediaDevices(getUserMedia: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: () =>
        Promise.resolve([
          { deviceId: 'dev-a', kind: 'videoinput', label: 'FaceTime HD Camera', groupId: 'g' },
          { deviceId: 'dev-b', kind: 'audioinput', label: 'Microphone', groupId: 'g' },
        ] as unknown as MediaDeviceInfo[]),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
}

beforeEach(() => {
  server.use(
    mswHttp.get('*/api/camera/cameras', () =>
      HttpResponse.json({
        success: true,
        data: { cameras: [{ id: CAMERA, name: 'Laptop Webcam' }], nextCursor: null },
      }),
    ),
    mswHttp.get('*/api/media/live/sessions', () => HttpResponse.json({ success: true, data: [] })),
    mswHttp.get('*/api/media/perception/assignment/cameras', () =>
      HttpResponse.json({ success: true, data: [] }),
    ),
    mswHttp.get('*/api/tracking/tracks', () =>
      HttpResponse.json({ success: true, data: { tracks: [] } }),
    ),
  );
  authAs();
});

afterEach(() => {
  store.dispatch(signedOut());
  vi.restoreAllMocks();
});

describe('LiveCamPage', () => {
  it('refuses to start without a target camera, and says which choice is missing', async () => {
    stubMediaDevices(() => Promise.reject(new Error('should not be called')));
    renderWithProviders(<LiveCamPage />);
    await userEvent.click(await screen.findByTestId('livecam-start'));
    expect(await screen.findByTestId('livecam-error')).toHaveTextContent(/Choose the camera/i);
  });

  it('turns a denied permission into an instruction, not a stack trace', async () => {
    const denied = new Error('Permission denied');
    denied.name = 'NotAllowedError';
    stubMediaDevices(() => Promise.reject(denied));
    renderWithProviders(<LiveCamPage />);

    await userEvent.selectOptions(await screen.findByTestId('livecam-camera'), CAMERA);
    await userEvent.click(screen.getByTestId('livecam-start'));

    const error = await screen.findByTestId('livecam-error');
    expect(error).toHaveTextContent('permission-denied');
    /* ⭐ The operator is told the page cannot re-prompt — the single most common support question. */
    expect(error).toHaveTextContent(/cannot re-prompt/i);
  });

  it('names a busy device as busy rather than reporting no camera', async () => {
    const busy = new Error('Could not start video source');
    busy.name = 'NotReadableError';
    stubMediaDevices(() => Promise.reject(busy));
    renderWithProviders(<LiveCamPage />);

    await userEvent.selectOptions(await screen.findByTestId('livecam-camera'), CAMERA);
    await userEvent.click(screen.getByTestId('livecam-start'));

    expect(await screen.findByTestId('livecam-error')).toHaveTextContent('device-busy');
  });

  it('⛔ renders an unmeasured stage as a dash, never as 0.0', async () => {
    /*
     * The regression this file exists for. Every stage table on this page is empty before a capture
     * starts; a table of zeros would read as "capture takes no time", which is the exact confusion
     * ADR-0039 exists to prevent — and it is the confusion that matters most on the one page whose
     * whole output is latency.
     */
    stubMediaDevices(() => Promise.reject(new Error('x')));
    renderWithProviders(<LiveCamPage />);
    const rows = await screen.findAllByText(/not measured yet/i);
    expect(rows.length).toBe(4);
    expect(screen.queryByText('0.0')).toBeNull();
  });

  it('says there are no tracks rather than showing an overlay age of zero', async () => {
    stubMediaDevices(() => Promise.reject(new Error('x')));
    renderWithProviders(<LiveCamPage />);
    expect(await screen.findByTestId('livecam-overlay-age')).toHaveTextContent(
      /No tracks on this camera right now/i,
    );
  });

  it('draws the skeleton the runtime attached to a tracked person, and says what visible means', async () => {
    /*
     * ⛔ The end of the chain P3.3b exists to close: `Detection.attributes.pose` → tracker → the
     * live tracks API → this overlay. The page is the only place a reviewer will ever look, and a
     * skeleton drawn here without the caveat beside it invites "the model can see through that box".
     */
    server.use(
      mswHttp.get('*/api/tracking/tracks', () =>
        HttpResponse.json({
          success: true,
          data: {
            tracks: [
              {
                trackId: 'trk_pose_1',
                tenantId: 'tnt',
                cameraId: CAMERA,
                label: 'person',
                state: 'confirmed',
                confidence: 0.93,
                bbox: [0.24, 0.32, 0.7, 0.66],
                firstSeen: { frameIndex: 1, at: new Date().toISOString() },
                lastSeen: { frameIndex: 9, at: new Date().toISOString() },
                age: 9,
                hits: 9,
                quality: {},
                history: [],
                attributes: {
                  pose: {
                    skeleton: 'coco-17',
                    model: 'rtmpose-tiny',
                    threshold: 0.3,
                    artifactSha256: '38b1d472',
                    visibleMeaning: 'model-localized above threshold; NOT a claim about physical occlusion',
                    keypoints: [
                      { name: 'nose', x: 0.5, y: 0.3, confidence: 0.94, visible: true },
                      { name: 'left_shoulder', x: 0.45, y: 0.4, confidence: 0.9, visible: true },
                      { name: 'right_shoulder', x: 0.55, y: 0.4, confidence: 0.9, visible: true },
                      { name: 'left_ankle', x: 0.46, y: 0.99, confidence: 0.09, visible: false },
                    ],
                  },
                },
              },
            ],
          },
        }),
      ),
    );
    stubMediaDevices(() => Promise.reject(new Error('x')));
    renderWithProviders(<LiveCamPage />);
    await userEvent.selectOptions(await screen.findByTestId('livecam-camera'), CAMERA);

    expect(await screen.findByTestId('pose-trk_pose_1')).toBeInTheDocument();
    expect(screen.getByTestId('joint-nose')).toBeInTheDocument();
    expect(screen.getByTestId('limb-left_shoulder-right_shoulder')).toBeInTheDocument();
    /* The joint the model scored 0.09 is absent — not drawn faintly, not clamped to the box edge. */
    expect(screen.queryByTestId('joint-left_ankle')).not.toBeInTheDocument();
    expect(screen.getByTestId('livecam-pose-caveat')).toHaveTextContent(
      /not a claim about physical occlusion/i,
    );
    expect(screen.getByTestId('livecam-pose-caveat')).toHaveTextContent(/rtmpose-tiny/);
  });

  it('draws no skeleton for a tracked object the pose model never ran on', async () => {
    /* ⛔ The negative control, on the page: a `tie` track carries no pose and must draw nothing. */
    server.use(
      mswHttp.get('*/api/tracking/tracks', () =>
        HttpResponse.json({
          success: true,
          data: {
            tracks: [
              {
                trackId: 'trk_tie_1',
                tenantId: 'tnt',
                cameraId: CAMERA,
                label: 'tie',
                state: 'confirmed',
                confidence: 0.55,
                bbox: [0.1, 0.1, 0.2, 0.2],
                firstSeen: { frameIndex: 1, at: new Date().toISOString() },
                lastSeen: { frameIndex: 4, at: new Date().toISOString() },
                age: 4,
                hits: 4,
                quality: {},
                history: [],
                attributes: {},
              },
            ],
          },
        }),
      ),
    );
    stubMediaDevices(() => Promise.reject(new Error('x')));
    renderWithProviders(<LiveCamPage />);
    await userEvent.selectOptions(await screen.findByTestId('livecam-camera'), CAMERA);

    await screen.findByTestId('livecam-overlay-age');
    expect(screen.queryByTestId('pose-trk_tie_1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('livecam-pose-caveat')).not.toBeInTheDocument();
  });

  it('lists only video inputs in the device picker', async () => {
    stubMediaDevices(() => Promise.reject(new Error('x')));
    renderWithProviders(<LiveCamPage />);
    const picker = (await screen.findByTestId('livecam-device')) as HTMLSelectElement;
    await waitFor(() => expect(picker.options.length).toBe(2)); // "System default" + the camera
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      'System default',
      'FaceTime HD Camera',
    ]);
  });
});

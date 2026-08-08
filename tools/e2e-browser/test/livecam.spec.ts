/**
 * Live capture — browser certification and failure recovery (P-9).
 *
 * ⛔ **Nothing here is a double.** A real Chromium, real HTTPS through Caddy, a real login, a real
 * `getUserMedia`, the real console bundle, the real gateway, the real media service and the real
 * ONNX runtime. The only substitution is the **camera device**, replaced by Chrome's fake device so
 * the suite can run unattended — every line of the browser capture path still executes.
 *
 * ### ⭐ What these specs are for, and it is not the happy path
 *
 * The happy path is measured by the scenario matrix, which produces numbers. These specs cover the
 * things that go *wrong* around a live camera, because a capture page's real failure modes are all
 * lifecycle: a tab closed without stopping, a permission revoked halfway through, a device unplugged
 * mid-stream, a refresh. Each of those has a way of failing that produces **no error at all** — most
 * dangerously the unplug, where the video element simply freezes and the page happily posts the same
 * still frame for ever while the platform records a person standing perfectly still.
 */
import { test, expect, chromium, type Page, type APIRequestContext } from '@playwright/test';

const TENANT = process.env.VIP_TENANT ?? 'tnt_demo_retail';
const ADMIN = {
  email: process.env.VIP_EMAIL ?? 'security.manager@northgate.demo',
  password: process.env.VIP_PASSWORD ?? '12345678',
};
const CAMERA = process.env.VIP_LIVE_CAMERA ?? 'cam_4b8cbcbab9ec4685821b35a01c52efd2';

/**
 * ⚠️ Chromium only. The fake-device flags are Chromium switches; Firefox and WebKit have no
 * equivalent, so running there would mean `getUserMedia` prompting a headless browser that cannot
 * answer. Skipped explicitly rather than silently passing — a suite that reports a Chromium result
 * as a WebKit one is the failure mode `playwright.config.ts` already calls out for codecs.
 */
test.skip(({ browserName }) => browserName !== 'chromium', 'the fake camera device is Chromium-only');

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      /* No file: Chrome's built-in rolling test pattern. These specs assert lifecycle, not pixels. */
    ],
  },
});

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel(/tenant/i).fill(TENANT);
  await page.getByLabel(/email/i).fill(ADMIN.email);
  await page.getByLabel(/password/i).fill(ADMIN.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('navigation')).toBeVisible({ timeout: 30_000 });
}

async function token(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/identity/auth/login', {
    headers: { 'x-tenant-id': TENANT },
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  return (await res.json()).data.accessToken;
}

/** Live ingest sessions the platform believes are open. */
async function sessions(request: APIRequestContext, bearer: string) {
  const res = await request.get('/api/media/live/sessions', {
    headers: { authorization: `Bearer ${bearer}` },
  });
  const body = await res.json();
  return (body.data ?? []) as { cameraId: string; framesAccepted: number; agent: string }[];
}

/** Start a capture and wait until frames are actually flowing. */
async function startCapture(page: Page): Promise<void> {
  await page.goto('/live/webcam');
  await page.getByTestId('livecam-camera').selectOption(CAMERA);
  await page.getByTestId('livecam-start').click();
  await expect(page.getByTestId('livecam-stop')).toBeVisible({ timeout: 30_000 });
  /* ⚠️ Waiting for the Stop button proves the loop started; waiting for a non-zero Accepted count
   * proves a frame reached the platform. They are different claims and only the second one matters. */
  await expect(page.getByText('Accepted').locator('xpath=following-sibling::dd')).not.toHaveText(
    '—',
    { timeout: 30_000 },
  );
}

test.describe('live capture — the page works', () => {
  test('captures, uploads and reports every browser stage with a real sample count', async ({
    page,
    request,
  }) => {
    await signIn(page);
    await startCapture(page);
    await page.waitForTimeout(8_000);

    /* Every stage has measured something — a dash here would mean the page is reporting nothing. */
    for (const stage of ['Capture (video → canvas)', 'Encode (canvas → JPEG)', 'Upload (round trip)']) {
      const row = page.getByRole('row', { name: new RegExp(stage.replace(/[()→]/g, '.'), 'i') });
      await expect(row).not.toContainText('not measured yet');
    }

    /* ⭐ And the platform agrees it received them — the page's own count is not evidence. */
    const bearer = await token(request);
    const open = await sessions(request, bearer);
    const mine = open.find((s) => s.cameraId === CAMERA);
    expect(mine, 'the platform lists an open session for this camera').toBeDefined();
    expect(mine!.agent).toBe('browser-webcam');
    expect(mine!.framesAccepted).toBeGreaterThan(4);

    await page.getByTestId('livecam-stop').click();
    await expect(page.getByTestId('livecam-start')).toBeVisible();
  });

  test('the clock offset is reported with its uncertainty, never as a bare number', async ({ page }) => {
    await signIn(page);
    await startCapture(page);
    /*
     * ⚠️ `arrivalLagMs` is transport PLUS skew and the two are inseparable from one sample. A page
     * that printed an offset without the round trip it was estimated over would be asserting a
     * precision the measurement does not have.
     */
    await expect(page.getByTestId('livecam-clock')).toContainText('±');
    await expect(page.getByTestId('livecam-clock')).toContainText('round trip');
    await page.getByTestId('livecam-stop').click();
  });
});

test.describe('live capture — recovery', () => {
  test('stopping closes the session, so the camera is released immediately', async ({
    page,
    request,
  }) => {
    await signIn(page);
    await startCapture(page);
    await page.getByTestId('livecam-stop').click();
    await expect(page.getByTestId('livecam-start')).toBeVisible();

    const bearer = await token(request);
    await expect
      .poll(async () => (await sessions(request, bearer)).some((s) => s.cameraId === CAMERA), {
        timeout: 15_000,
      })
      .toBe(false);
  });

  test('a page refresh ends the capture rather than leaving a second one running', async ({
    page,
    request,
  }) => {
    await signIn(page);
    await startCapture(page);
    await page.reload();
    await expect(page.getByTestId('livecam-start')).toBeVisible({ timeout: 30_000 });

    /*
     * ⚠️ The assertion is that at most ONE session exists, not that zero do. A reload fires the
     * unmount cleanup, but `fetch` from an unloading document is not guaranteed to complete — so the
     * honest guarantee is "no duplicate claim on the camera", with the idle reaper (60 s) as the
     * backstop. Asserting zero would be asserting something the browser does not promise.
     */
    const bearer = await token(request);
    const open = await sessions(request, bearer);
    expect(open.filter((s) => s.cameraId === CAMERA).length).toBeLessThanOrEqual(1);
  });

  test('a capture can be started again after being stopped, on the same camera', async ({ page }) => {
    await signIn(page);
    await startCapture(page);
    await page.getByTestId('livecam-stop').click();
    await expect(page.getByTestId('livecam-start')).toBeVisible();

    /*
     * ⭐ The regression this guards is a real one in the ingest module: a session that refused frames
     * after close, with no way to open a new one, would make the page work exactly once per page
     * load. `LiveIngest.open()` replaces the session for a camera, and this proves it.
     */
    await page.getByTestId('livecam-start').click();
    await expect(page.getByTestId('livecam-stop')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('livecam-stop').click();
  });

  test('⛔ a device that stops producing video stops the capture instead of repeating a frame', async ({
    page,
  }) => {
    await signIn(page);
    await startCapture(page);

    /*
     * Ending the MediaStreamTrack is exactly what unplugging a USB camera does: the stream object
     * stays, `getUserMedia` never rejects again, and the `<video>` freezes on its last frame. Without
     * the `ended` handler the page would keep posting that still image, the runtime would keep
     * detecting the person in it, and the timeline would show somebody standing motionless until the
     * tab was closed — a fabricated observation, which an evidence platform may never produce.
     */
    await page.evaluate(() => {
      const video = document.querySelector('video');
      const stream = video?.srcObject as MediaStream | null;
      stream?.getVideoTracks().forEach((t) => t.stop());
      /* `stop()` does not fire `ended` on the track that called it — dispatch what an unplug would. */
      stream?.getVideoTracks().forEach((t) => t.dispatchEvent(new Event('ended')));
    });

    await expect(page.getByTestId('livecam-error')).toContainText('device-lost', { timeout: 15_000 });
    await expect(page.getByTestId('livecam-start')).toBeVisible();
  });

  test('closing the tab without stopping leaves at most one session, reaped by the platform', async ({
    browser,
    request,
  }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera'] });
    const page = await context.newPage();
    await signIn(page);
    await startCapture(page);
    await context.close();

    /*
     * ⚠️ This asserts the HONEST behaviour, which is not "the session vanishes". A closed tab sends
     * nothing; the platform cannot know. `LiveIngest.reapIdle()` takes it after 60 s of silence, and
     * that window is a documented limitation rather than a defect — the alternative is a heartbeat
     * on every camera in the estate to catch a case that costs one stale row for one minute.
     */
    const bearer = await token(request);
    const open = await sessions(request, bearer);
    expect(open.filter((s) => s.cameraId === CAMERA).length).toBeLessThanOrEqual(1);
  });
});

test.describe('live capture — permission', () => {
  test('a denied permission is an instruction the operator can act on', async () => {
    /*
     * ⚠️ A browser launched by hand, **without** `--use-fake-ui-for-media-stream`, so nothing
     * auto-grants the prompt and `getUserMedia` rejects the way it does for a real operator who
     * pressed Block. Playwright refuses `test.use({ launchOptions })` inside a describe (it would
     * force a new worker), and the file-level `test.use` above must stay auto-granting for every
     * other spec — so this one owns its browser.
     */
    const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream'] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: [] });
    const page = await context.newPage();
    await signIn(page);
    await page.goto('/live/webcam');
    await page.getByTestId('livecam-camera').selectOption(CAMERA);
    await page.getByTestId('livecam-start').click();

    const error = page.getByTestId('livecam-error');
    await expect(error).toBeVisible({ timeout: 30_000 });
    /*
     * ⚠️ Asserts the *code*, not the browser's own wording. Chrome rewords these between versions;
     * a certification keyed on message text degrades silently toward "unknown error", which reads to
     * an operator as a platform fault rather than something they can act on.
     *
     * ⛔ **`unknown` is asserted absent, and that assertion earned its place.** The first run of this
     * spec produced **"unknown — Not supported"**: headless Chromium rejects with
     * `NotSupportedError`, which had no case and fell through to the generic branch. The whole point
     * of `describeCameraError` is that an operator is never shown a raw browser string, so a code of
     * `unknown` here is a failure regardless of which specific code replaces it.
     *
     * ⚠️ A *genuine* prompt denial (`NotAllowedError`) cannot be produced by a headless browser —
     * there is no prompt to deny. That path is unit-tested in `capture.test.ts` and exercised by a
     * human in MANUAL_TEST_GUIDE §6.1. What this proves is that an unusable camera, whatever the
     * reason, reaches the operator as an instruction.
     */
    await expect(error).toContainText(
      /permission-denied|device-busy|no-device|capture-unsupported|insecure-context/,
    );
    await expect(error).not.toContainText('unknown');
    await context.close();
    await browser.close();
  });
});

test.describe('live capture — the edge permits the camera', () => {
  test('Permissions-Policy allows the camera for this origin and still denies the microphone', async ({
    request,
  }) => {
    /*
     * ⛔ Found by the deployment refusing `getUserMedia` before the page existed. The edge shipped
     * `camera=()`, which disables the API for the whole origin — and surfaces in the browser as
     * "permission denied", which reads as the operator's choice rather than the edge's.
     *
     * ⚠️ The microphone assertion is the more important half. A surveillance console must not be able
     * to listen to a room, and this header is what makes "video only" a property of the deployment
     * rather than a promise in the page's source.
     */
    const res = await request.get('/');
    const policy = res.headers()['permissions-policy'] ?? '';
    expect(policy).toContain('camera=(self)');
    expect(policy).toContain('microphone=()');
  });
});

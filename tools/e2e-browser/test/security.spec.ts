/**
 * Security and error-path certification, in a real browser against the deployed edge (P-8.5).
 *
 * ⛔ **These are the assertions that must hold when something goes wrong**, and they are the ones a
 * happy-path demo never reaches. Every item here is a thing a customer's security review will ask
 * about, answered by measurement rather than by pointing at the code that is supposed to do it.
 */
import { test, expect, signIn, apiToken, TENANT, VIEWER, clip } from '../src/fixtures.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SHOTS = join(process.cwd(), 'artifacts/screens');
mkdirSync(SHOTS, { recursive: true });
const shot = (n: string) => join(SHOTS, `p85-sec-${n}.png`);

test.describe('the edge', () => {
  test('serves the console over HTTPS with the security headers that were specified', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const h = res.headers();

    expect(h['strict-transport-security']).toMatch(/max-age=\d{7,}/);
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['content-security-policy']).toContain("default-src 'self'");
    /*
     * ⚠️ **`camera=(self)`, and the `(self)` is doing the work.**
     *
     * This asserted `camera=()` until P-11, written in P-8.5 when the console could not capture
     * anything: *"a surveillance console asking for the operator's own camera would be
     * indistinguishable, to a browser, from one that had been compromised into doing so."* P-9 then
     * shipped browser-side live capture, which the browser refuses unless the origin is permitted,
     * and changed the header without revisiting this line. The P-11 soak's post-run certification
     * was the first thing to notice — a full day later, because the browser suite is not in
     * `turbo lint typecheck test`.
     *
     * ⛔ The reasoning above is still right, so the assertion is **narrowed rather than dropped**.
     * `(self)` permits exactly the console's own origin; `*` or a named third party would mean any
     * embedded frame could open the operator's camera, and both must still fail here. Every other
     * capability stays fully denied — a surveillance console has no business asking for a
     * microphone, a location or a payment method.
     */
    expect(h['permissions-policy']).toContain('camera=(self)');
    expect(h['permissions-policy']).not.toMatch(/camera=\(\s*\*|camera=\([^)]*https?:/);
    for (const denied of ['microphone', 'geolocation', 'payment', 'usb', 'interest-cohort']) {
      expect(h['permissions-policy']).toContain(`${denied}=()`);
    }
    /* ⚠️ A version banner is free reconnaissance. */
    expect(h['server']).toBeUndefined();
  });

  /**
   * ⛔ Plaintext must **redirect**, not reset. HSTS only protects a browser that has already
   * completed one HTTPS visit; the redirect is what gets it there. Measured with redirects
   * disabled, `curl http://localhost/` returned `Connection reset by peer` — an operator typing
   * the hostname without a scheme would see nothing at all.
   */
  test('redirects plaintext to HTTPS rather than refusing it', async ({ request }) => {
    const res = await request.get('http://localhost/', { maxRedirects: 0 });
    expect([301, 302, 307, 308]).toContain(res.status());
    expect(res.headers()['location']).toMatch(/^https:/);
  });
});

test.describe('authorisation', () => {
  test('refuses an unauthenticated read of customer data', async ({ request }) => {
    for (const path of ['/api/media/analyses', '/api/events/events', '/api/workflow/incidents']) {
      expect((await request.get(path)).status(), path).toBe(401);
    }
  });

  /** ⛔ A token from one tenant must not read another's, whatever the URL says. */
  test('refuses a cross-tenant read', async ({ request }) => {
    const token = await apiToken(request);
    const res = await request.get('/api/media/analyses', {
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'tnt_someone_else' },
    });
    /* The tenant comes from the TOKEN, never the header — so this returns this tenant's data or
     * refuses, and must never return the other tenant's. */
    if (res.status() === 200) {
      const body = await res.json();
      for (const a of body.data.items ?? []) expect(a.tenantId).toBe(TENANT);
    } else {
      expect([401, 403]).toContain(res.status());
    }
  });

  /**
   * ⚠️ A read-only role must not be shown a control it cannot use. A button that 403s is worse
   * than an absent one: it teaches an operator the product is broken.
   */
  test('hides the upload control from a viewer', async ({ page }) => {
    await signIn(page, VIEWER);
    await page.goto('/investigations');
    /* Either the surface is not navigable at all, or it is read-only. Both are correct; a visible
     * enabled upload button is not. */
    const upload = page.getByRole('button', { name: /upload a recording/i });
    if (await upload.count()) await expect(upload).toBeDisabled();
    await page.screenshot({ path: shot('viewer'), fullPage: true });
  });
});

test.describe('error paths', () => {
  /**
   * ⛔ **V-5 — a presigned credential reached the caller in an error body.**
   *
   * `ffprobe` names the input it failed on, and that input is a presigned URL. Uploading a text
   * file renamed `.mp4` returned `X-Amz-Credential`, `X-Amz-Signature` and the internal endpoint
   * `http://minio:9000` in an HTTP 400 — a live tenant-scoped read credential, obtainable on demand
   * by anyone willing to upload a file that will not open.
   */
  test('⛔ never returns a signed url in an error message', async ({ request }) => {
    const token = await apiToken(request);
    const c = clip('corrupt-not-a-video');
    const created = await request.post('/api/media/analyses', {
      headers: { authorization: `Bearer ${token}` },
      data: {
        cameraId: process.env.VIP_CAMERA ?? 'cam_retail_entrance',
        originalName: 'not-a-video.mp4',
        contentType: 'video/mp4',
        bytes: c.bytes,
        footageStartedAt: '2026-02-14T18:30:00.000Z',
      },
    });
    const up = await created.json();
    await request.fetch(up.data.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4' },
      data: Buffer.from('This is not a video. A customer will upload this file.\n'.repeat(200)),
    });

    const confirm = await request.post(`/api/media/analyses/${up.data.analysis.id}/confirm`, {
      headers: { authorization: `Bearer ${token}` },
      data: {},
    });
    expect(confirm.status()).toBe(400);
    const text = await confirm.text();

    expect(text).not.toContain('X-Amz-Credential');
    expect(text).not.toContain('X-Amz-Signature');
    expect(text).not.toContain('minio:9000');
    /* ⚠️ …and the DIAGNOSIS survives. Redaction that destroys the reason trades one support ticket
     * for another: an operator needs to know whether the file, the codec or the store was at fault. */
    expect(text).toContain('could not be read as a video');
  });

  /** ⚠️ Each refusal must name what is actually wrong, not "invalid file". */
  test('refuses each kind of unusable upload with a reason', async ({ request }) => {
    const token = await apiToken(request);
    for (const id of ['corrupt-truncated-header', 'corrupt-audio-only']) {
      const c = clip(id);
      const created = await request.post('/api/media/analyses', {
        headers: { authorization: `Bearer ${token}` },
        data: {
          cameraId: process.env.VIP_CAMERA ?? 'cam_retail_entrance',
          originalName: `${id}.mp4`,
          contentType: 'video/mp4',
          bytes: c.bytes,
          footageStartedAt: '2026-02-14T18:30:00.000Z',
        },
      });
      const up = await created.json();
      const { readFileSync } = await import('node:fs');
      await request.fetch(up.data.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'video/mp4' },
        data: readFileSync(c.path),
      });
      const confirm = await request.post(`/api/media/analyses/${up.data.analysis.id}/confirm`, {
        headers: { authorization: `Bearer ${token}` },
        data: {},
      });
      expect(confirm.status(), id).toBe(400);
      /* ⭐ "no video stream" — the actual reason, which is what lets a customer fix their export
       * settings rather than re-uploading the same broken file three times. */
      expect(await confirm.text(), id).toMatch(/no video stream|could not be read/i);
    }
  });

  /** ⚠️ A 404 must render a page, not a blank screen with a stack trace in the console. */
  test('renders a real page for an analysis that does not exist', async ({ page }) => {
    await signIn(page);
    await page.goto('/investigations/ana_definitely_not_real');
    await expect(page.getByRole('navigation')).toBeVisible();
    const body = await page.innerText('body');
    expect(body.length).toBeGreaterThan(50);
    /* ⛔ Never a raw stack trace or an unhandled-rejection banner. */
    expect(body).not.toMatch(/at Object\.|TypeError:|undefined is not/i);
    await page.screenshot({ path: shot('not-found'), fullPage: true });
  });
});

test.describe('object storage', () => {
  /**
   * ⛔ **The evidence origin must be same-origin through the edge.** ADR-0036 lets the browser talk
   * to object storage; the edge fronting it is what keeps that inside one origin, so the CSP needs
   * no `connect-src` exception and no CORS is involved.
   */
  test('is reachable through the edge, not on a second origin', async ({ request }) => {
    const res = await request.get('/s3/', { maxRedirects: 0 });
    expect(res.status()).toBeLessThan(500);
  });
});

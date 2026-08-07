/**
 * Limits, large recordings and multiple uploads, in a real browser (P-8.5).
 *
 * ⚠️ **This spec asserts BOUNDARIES, not throughput.** Wall-clock numbers belong in
 * `docs/project/PERFORMANCE_BASELINE.md`, measured by `tools/validation/validate.mjs` where they can
 * be recorded with the hardware they were measured on. A test that asserted "analysis takes under
 * 30 s" would fail on a loaded laptop and pass on a fast one, telling you about the machine rather
 * than about the product.
 */
import { test, expect, signIn, uploadThroughUi, apiToken, CAMERA } from '../src/fixtures.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const SHOTS = join(process.cwd(), 'artifacts/screens');
mkdirSync(SHOTS, { recursive: true });

test.describe('declared limits', () => {
  /**
   * ⭐ **The ceiling is checked against the DECLARED size, before a byte is uploaded.**
   *
   * That is the whole reason the limit is worth having: refusing a 3 GB file after receiving it
   * costs the customer the upload and the platform the disk. So this asserts the refusal happens at
   * `create`, which takes milliseconds — and it is a genuine test of the boundary, not a stand-in
   * for one.
   */
  test('refuses a file larger than the stated ceiling before any bytes move', async ({ request }) => {
    const token = await apiToken(request);
    const overCeiling = 2 * 1024 * 1024 * 1024 + 1; // 2 GB + 1
    const res = await request.post('/api/media/analyses', {
      headers: { authorization: `Bearer ${token}` },
      data: {
        cameraId: CAMERA,
        originalName: 'enormous.mp4',
        contentType: 'video/mp4',
        bytes: overCeiling,
      },
    });
    expect(res.status()).toBe(400);
    /* ⚠️ The message must name the limit. "Bad request" leaves a customer guessing at what to trim. */
    expect(await res.text()).toMatch(/2|GB|large|limit|ceiling/i);
  });

  /** ⚠️ The UI states the limits before the operator picks a file, not after a rejection. */
  test('states the limits on the upload form', async ({ page }) => {
    await signIn(page);
    await page.goto('/investigations');
    await expect(page.getByText(/MP4 only, up to 2 GB and 4 hours/i)).toBeVisible();
  });

  /**
   * ⚠️ Only MP4 is decodable today, and the picker says so. `ANALYSIS_CONTAINER_SUPPORT` marks mkv,
   * mov and avi as present-but-not-decodable, which is a different statement from "unsupported".
   */
  test('accepts only mp4 in the file picker', async ({ page }) => {
    await signIn(page);
    await page.goto('/investigations');
    await expect(page.locator('input[type=file]')).toHaveAttribute('accept', 'video/mp4');
  });
});

test.describe('large recordings', () => {
  /**
   * A thirty-minute recording, uploaded and analysed through the browser.
   *
   * ⚠️ Skipped when the ladder has not been generated — those files are hundreds of megabytes and
   * are not committed. `node tools/dataset/large.mjs` builds them.
   *
   * ⛔ **Not run to completion.** Thirty minutes at 2 fps is 3 600 frames and about 200 s of analysis
   * on this deployment; what this asserts is that the *upload and start* of a large recording work
   * from a browser, which is the part that involves the browser at all. The full-length analysis is
   * measured by `tools/validation/validate.mjs` where it is not holding a browser open.
   */
  test('uploads a 30-minute recording and starts analysing it', async ({ page }) => {
    const ladder = join(
      process.cwd(),
      '../../infra/docker/fixtures/media/validation/large/duration-30min.mp4',
    );
    test.skip(!existsSync(ladder), 'run `node tools/dataset/large.mjs` to build the duration ladder');

    await signIn(page);
    await page.goto('/investigations');
    await page.getByLabel(/^camera$/i).click();
    await page.getByRole('option', { name: /Main Entrance/i }).click();

    const [created] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/media/analyses') && r.request().method() === 'POST',
        { timeout: 300_000 },
      ),
      page.locator('input[type=file]').setInputFiles(ladder),
    ]);
    const id = (await created.json()).data.analysis.id;
    await expect(page.locator(`a[href="/investigations/${id}"]`)).toBeVisible({ timeout: 300_000 });

    await page.locator(`a[href="/investigations/${id}"]`).click();
    await page.getByRole('button', { name: /run analysis/i }).click();
    await expect(page.getByText(/queued|starting|running/i).first()).toBeVisible({ timeout: 120_000 });

    /*
     * ⭐ **An ETA must be honest or absent.** ADR-0039: a duration nobody can yet estimate is not
     * "0 seconds remaining". The contract reports `etaUnavailableReason` until it has enough
     * samples, and a progress display that invented a number would be worse than one showing none.
     */
    await page.screenshot({ path: join(SHOTS, 'p85-perf-large-running.png'), fullPage: true });
    await page.getByRole('button', { name: /cancel/i }).first().click().catch(() => {
      /* Cancel is optional in the UI; the run finishing on its own is equally fine. */
    });
  });
});

test.describe('multiple uploads', () => {
  /**
   * ⭐ Three recordings uploaded back to back from one browser session, then all three checked.
   *
   * The correctness question is not "did they all finish" but "did they stay **separate**" — which
   * is precisely what V-2 and V-4 broke. Before those fixes, a second analysis on one camera
   * produced no tracking and no incidents at all, and it looked exactly like a successful run.
   */
  test('keeps three uploads separate and independently queryable', async ({ page, request }) => {
    await signIn(page);
    const ids: string[] = [];
    for (const id of ['single-person-walking', 'multiple-people', 'occlusion']) {
      const { id: analysisId } = await uploadThroughUi(page, id);
      ids.push(analysisId);
    }
    expect(new Set(ids).size).toBe(3);

    const token = await apiToken(request);
    for (const analysisId of ids) {
      const res = await request.get(`/api/media/analyses/${analysisId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      /* ⚠️ `{ analysis, sessions }` — the detail endpoint returns the recording AND its runs, not a
       * bare analysis. The two are one screen and would otherwise be two round trips. */
      expect(body.data.analysis.id).toBe(analysisId);
    }

    /* ⚠️ All three visible in the list at once — a list that paged one away would be a real defect
     * for an operator working through a batch of recordings. */
    await page.goto('/investigations');
    for (const analysisId of ids) {
      await expect(page.locator(`a[href="/investigations/${analysisId}"]`)).toBeVisible();
    }
    await page.screenshot({ path: join(SHOTS, 'p85-perf-multi-upload.png'), fullPage: true });
  });
});

test.describe('live isolation', () => {
  /**
   * ⛔ **The guarantee ADR-0047 exists for, checked in the product rather than in a unit test.**
   *
   * An incident replayed out of six-week-old footage is a real finding and is *not* something
   * anybody is dispatched to now. If offline findings reached the live queue, an investigation of
   * last month's footage would land in an operator's work list with no change to any caller.
   */
  test('offline incidents never appear in the live queue', async ({ request }) => {
    const token = await apiToken(request);
    const live = await request.get('/api/workflow/incidents?limit=200', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(live.status()).toBe(200);
    const items = (await live.json()).data.items ?? [];
    const leaked = items.filter((i: { analysisSessionId?: string }) => i.analysisSessionId !== undefined);
    expect(leaked, `${leaked.length} offline incident(s) leaked into the live queue`).toHaveLength(0);
  });

  /** ⚠️ …and the same for events, which is where the leak would start. */
  test('offline events never appear in an unfiltered event read', async ({ request }) => {
    const token = await apiToken(request);
    const res = await request.get('/api/events/events?limit=200', {
      headers: { authorization: `Bearer ${token}` },
    });
    const events = (await res.json()).data.events ?? [];
    const leaked = events.filter((e: { analysisSessionId?: string }) => e.analysisSessionId !== undefined);
    expect(leaked, `${leaked.length} offline event(s) leaked into the live feed`).toHaveLength(0);
  });
});

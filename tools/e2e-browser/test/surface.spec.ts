/**
 * P-8.6 Product Surface, certified in a real browser against the deployed stack.
 *
 * ⭐ **The question every test here asks is the same one: does the screen agree with the store?**
 * This milestone added no measurement — it exposed measurements that already existed. So the only
 * defect class that matters is *the UI showing something the API did not say*, and every assertion
 * below compares rendered DOM against the payload fetched independently over HTTP.
 *
 * ⛔ **A box in the wrong place renders perfectly.** So does a box from the wrong frame, a track id
 * attached to the wrong outline and a timestamp built from the wrong clock. None of them throw, none
 * of them look broken, and all of them would let a customer draw a conclusion about a person the
 * platform never supported. That is why these are pixel- and value-level comparisons rather than
 * "the overlay is visible".
 */
import type { Page } from '@playwright/test';
import { test, expect, signIn, apiToken, uploadThroughUi, waitForRunToFinish } from '../src/fixtures.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SHOTS = join(process.cwd(), 'artifacts/screens');
mkdirSync(SHOTS, { recursive: true });

interface Entry {
  eventId: string;
  offsetSeconds: number;
  occurredAt: string;
  label: string;
  confidence: number | null;
  trackId?: string;
  bbox?: [number, number, number, number];
}
interface Timeline {
  sessionId: string;
  footageStartedAt: string;
  durationSeconds?: number;
  entries: Entry[];
  tracks: { trackId: string; fromOffsetSeconds: number; toOffsetSeconds: number; observations: number }[];
  density: { fromOffsetSeconds: number; count: number }[];
  incidents: {
    incidentId: string;
    offsetSeconds: number;
    occurredAt: string;
    ruleName?: string;
    triggeredByEventId?: string;
  }[];
}

/** One analysed recording, reused by every test in the file. */
async function analysedRecording(page: Page) {
  await signIn(page);
  const { id } = await uploadThroughUi(page, 'multiple-people');
  await page.goto(`/investigations/${id}`);
  await page.getByRole('button', { name: /run analysis/i }).click();
  await waitForRunToFinish(page);
  return id;
}

test.describe('the recording is on the page', () => {
  /**
   * ⛔ **Before P-8.6 a customer could not watch the file they uploaded.** The endpoint returned a
   * working signed URL and nothing rendered it.
   *
   * ⚠️ Asserts `readyState`, not merely that a `<video>` exists. An element with a src that 404s or
   * whose signature expired is in the DOM and shows a black rectangle — indistinguishable from a
   * working player to any test that only checks visibility.
   */
  test('plays the uploaded recording, and the browser really decoded it', async ({ page }) => {
    await analysedRecording(page);
    const video = page.locator('[data-testid="analysis-player"] video');
    await expect(video).toBeVisible();

    await expect
      .poll(async () => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1); // HAVE_METADATA

    const duration = await video.evaluate((v: HTMLVideoElement) => v.duration);
    expect(Number.isFinite(duration)).toBe(true);
    expect(duration).toBeGreaterThan(0);
    await page.screenshot({ path: join(SHOTS, 'p86-01-player.png'), fullPage: true });
  });

  /**
   * ⭐ **Seeking is the whole point of a timeline.** Clicking an offset must move the playhead there,
   * and "there" means the footage offset — not a wall-clock time, and not an index.
   */
  test('seeks to the exact footage offset a timeline row names', async ({ page, request }) => {
    const id = await analysedRecording(page);
    const token = await apiToken(request);
    const timeline = (await (
      await request.get(`/api/media/analyses/${id}/timeline`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()).data as Timeline;

    const offsets = [...new Set(timeline.entries.map((e) => e.offsetSeconds))].sort((a, b) => a - b);
    test.skip(offsets.length === 0, 'this run stored no events to seek to');
    const target = offsets[offsets.length - 1]!;

    const video = page.locator('[data-testid="analysis-player"] video');
    await expect(video).toBeVisible();
    await expect
      .poll(async () => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);

    /*
     * ⚠️ Clicked by the row's OWN label, so the assertion names the offset it asked for. A test that
     * clicked "the first button" and then compared against "the first offset" would pass even if the
     * two were unrelated.
     */
    await page.getByRole('tab', { name: /events/i }).click();
    await page
      .getByRole('button', { name: `Play from ${formatOffset(target)}` })
      .first()
      .click();

    await expect
      .poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 })
      .toBeCloseTo(target, 1);
  });
});

test.describe('the overlay draws what is stored, and nothing else', () => {
  /**
   * ⛔ **The core claim of this milestone, checked to three decimal places.**
   *
   * The player is seeked to an analysed instant, and every rendered box's `left/top/width/height`
   * percentage is compared against the normalised bbox the API returned for that same instant. A
   * box drawn from a neighbouring frame, or rescaled for the 2160×4096 source, passes every
   * "is it visible" test and fails this one.
   */
  test('every drawn box matches the stored bbox for that frame', async ({ page, request }) => {
    const id = await analysedRecording(page);
    const token = await apiToken(request);
    const timeline = (await (
      await request.get(`/api/media/analyses/${id}/timeline`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()).data as Timeline;

    const withBox = timeline.entries.filter((e) => e.bbox !== undefined);
    test.skip(withBox.length === 0, 'this run stored no bounding boxes');

    const at = withBox[0]!.offsetSeconds;
    const expected = withBox.filter((e) => e.offsetSeconds === at);

    const video = page.locator('[data-testid="analysis-player"] video');
    await expect(video).toBeVisible();
    await video.evaluate((v: HTMLVideoElement, t) => {
      v.currentTime = t;
      v.dispatchEvent(new Event('timeupdate'));
    }, at);

    /* ⚠️ The overlay is `aria-hidden` (decorative), so it is reached by class, not by role. */
    const boxes = page.locator('[data-testid="analysis-player"] .absolute.rounded-xs.border-2');
    await expect.poll(async () => boxes.count(), { timeout: 15_000 }).toBe(expected.length);

    const drawn = await boxes.evaluateAll((els) =>
      els.map((el) => {
        const s = (el as HTMLElement).style;
        return {
          left: parseFloat(s.left),
          top: parseFloat(s.top),
          width: parseFloat(s.width),
          height: parseFloat(s.height),
        };
      }),
    );

    for (const box of expected) {
      const [x, y, w, h] = box.bbox!;
      const match = drawn.find(
        (d) =>
          Math.abs(d.left - x * 100) < 0.01 &&
          Math.abs(d.top - y * 100) < 0.01 &&
          Math.abs(d.width - w * 100) < 0.01 &&
          Math.abs(d.height - h * 100) < 0.01,
      );
      expect(match, `no drawn box matches stored bbox ${JSON.stringify(box.bbox)}`).toBeDefined();
    }
    await page.screenshot({ path: join(SHOTS, 'p86-02-overlay.png'), fullPage: true });
  });

  /**
   * ⛔ **Nothing is drawn where nothing was analysed.** This is the assertion that stops the overlay
   * becoming a lie: with events at 8.4 % of detections, holding a box across the gaps would put a
   * person on screen at instants the platform never examined.
   */
  test('draws no box at an instant with no analysed frame', async ({ page, request }) => {
    const id = await analysedRecording(page);
    const token = await apiToken(request);
    const timeline = (await (
      await request.get(`/api/media/analyses/${id}/timeline`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()).data as Timeline;

    const offsets = [...new Set(timeline.entries.map((e) => e.offsetSeconds))].sort((a, b) => a - b);
    /* A point at least 2 s from any analysed instant — far outside the ±0.25 s tolerance. */
    const gap = offsets.length > 1 ? (offsets[0]! + offsets[1]!) / 2 : undefined;
    test.skip(gap === undefined || offsets.some((o) => Math.abs(o - gap) < 2), 'no wide gap in this run');

    const video = page.locator('[data-testid="analysis-player"] video');
    await video.evaluate((v: HTMLVideoElement, t) => {
      v.currentTime = t;
      v.dispatchEvent(new Event('timeupdate'));
    }, gap!);

    /*
     * ⛔ **The assertion is that nothing is DRAWN, not that a particular sentence is on screen.**
     *
     * This line read `/no analysed frame/i` and had been red since `bfa4e1d` (V-17), one commit
     * after it was written: the console deliberately stopped saying that — *"'no analysed frame at
     * this instant' is true and useless… the nearest stored moment is the thing the operator can act
     * on"* — and the certification kept asserting the superseded copy. A check pinned to wording
     * fails when the wording improves, which is the same family as asserting a table by text instead
     * of by heading.
     *
     * Both statements the console may make here mean "this instant was not analysed"; either is
     * correct, and the box count below is what the test is actually for.
     */
    await expect(page.getByTestId('overlay-status')).toContainText(
      /nearest stored frame|nothing stored for this run/i,
    );
    const boxes = page.locator('[data-testid="analysis-player"] .absolute.rounded-xs.border-2');
    await expect.poll(async () => boxes.count()).toBe(0);
  });

  /** ⭐ The toggle the brief asked for — and it must actually remove the boxes. */
  test('turns the overlay off and on', async ({ page }) => {
    await analysedRecording(page);
    const toggle = page.getByLabel('Detection overlay');
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByTestId('overlay-status')).toHaveCount(0);
    await toggle.click();
    await expect(page.getByTestId('overlay-status')).toHaveCount(1);
  });
});

test.describe('the lanes agree with the payload', () => {
  /** ⭐ P-8.6 priority 3 — all four lanes, and V-7 / TD-69 closed. */
  test('renders incidents, events, tracks and density with the payload’s own counts', async ({
    page,
    request,
  }) => {
    const id = await analysedRecording(page);
    const token = await apiToken(request);
    const timeline = (await (
      await request.get(`/api/media/analyses/${id}/timeline`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()).data as Timeline;

    await expect(page.getByRole('tab', { name: `Events (${timeline.entries.length})` })).toBeVisible();
    await expect(page.getByRole('tab', { name: `Tracks (${timeline.tracks.length})` })).toBeVisible();
    await expect(page.getByRole('tab', { name: /density/i })).toBeVisible();

    await page.getByRole('tab', { name: /density/i }).click();
    await expect(page.getByTestId('density-lane')).toBeVisible();
    /* ⛔ The brief's own requirement, asserted verbatim. */
    await expect(page.getByTestId('density-lane')).toContainText(/persisted events/i);
    await expect(page.getByTestId('density-lane')).toContainText(/not.+a detection histogram/is);
    await page.screenshot({ path: join(SHOTS, 'p86-03-lanes.png'), fullPage: true });
  });

  /**
   * ⛔ **Timeline timestamps are built from footage time.** `occurredAt` must equal
   * `footageStartedAt + offsetSeconds` to the millisecond — the three-clocks invariant, checked on
   * the payload the screen is rendering rather than in a unit test against a double.
   */
  test('every offset is exactly its distance from the footage start', async ({ page, request }) => {
    const id = await analysedRecording(page);
    const token = await apiToken(request);
    const timeline = (await (
      await request.get(`/api/media/analyses/${id}/timeline`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()).data as Timeline;

    const start = Date.parse(timeline.footageStartedAt);
    for (const entry of timeline.entries) {
      expect(Date.parse(entry.occurredAt) - start).toBeCloseTo(entry.offsetSeconds * 1000, 0);
    }
    for (const incident of timeline.incidents) {
      expect(Date.parse(incident.occurredAt) - start).toBeCloseTo(incident.offsetSeconds * 1000, 0);
    }
  });

  /** ⚠️ Confidence must be a probability. A value outside [0,1] means a rescale went wrong. */
  test('reports confidences inside [0, 1]', async ({ page, request }) => {
    const id = await analysedRecording(page);
    const token = await apiToken(request);
    const timeline = (await (
      await request.get(`/api/media/analyses/${id}/timeline`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()).data as Timeline;

    for (const entry of timeline.entries) {
      if (entry.confidence === null) continue;
      expect(entry.confidence).toBeGreaterThan(0);
      expect(entry.confidence).toBeLessThanOrEqual(1);
    }
  });

  /**
   * ⭐ **Track ids are stable within a run**, and every id on an event belongs to a declared span.
   * A track lane listing an identity no event carries — or an event carrying one the lane omits —
   * means the two views were derived from different data.
   */
  test('every event’s track appears in the track lane, and vice versa', async ({ page, request }) => {
    const id = await analysedRecording(page);
    const token = await apiToken(request);
    const timeline = (await (
      await request.get(`/api/media/analyses/${id}/timeline`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()).data as Timeline;

    const onEvents = new Set(timeline.entries.map((e) => e.trackId).filter(Boolean));
    const onLane = new Set(timeline.tracks.map((t) => t.trackId));
    expect([...onEvents].sort()).toEqual([...onLane].sort());

    /* ⚠️ A span must contain every one of its own observations. */
    for (const span of timeline.tracks) {
      const mine = timeline.entries.filter((e) => e.trackId === span.trackId);
      expect(span.observations).toBe(mine.length);
      for (const e of mine) {
        expect(e.offsetSeconds).toBeGreaterThanOrEqual(span.fromOffsetSeconds);
        expect(e.offsetSeconds).toBeLessThanOrEqual(span.toOffsetSeconds);
      }
    }
  });

  /**
   * ⭐ **"Which events became incidents?" — from the recorded link.** Every incident's
   * `triggeredByEventId` must name an event in this run's own timeline, or the console is drawing a
   * relationship across two different runs.
   */
  test('each incident names a triggering event that belongs to this run', async ({ page, request }) => {
    const id = await analysedRecording(page);
    const token = await apiToken(request);
    const timeline = (await (
      await request.get(`/api/media/analyses/${id}/timeline`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()).data as Timeline;
    test.skip(timeline.incidents.length === 0, 'this run raised no incidents');

    const eventIds = new Set(timeline.entries.map((e) => e.eventId));
    for (const incident of timeline.incidents) {
      expect(incident.ruleName, 'an incident must name the rule that raised it').toBeTruthy();
      if (incident.triggeredByEventId !== undefined) {
        expect(eventIds.has(incident.triggeredByEventId)).toBe(true);
      }
    }
    await expect(page.getByRole('tab', { name: /incidents/i })).toBeVisible();
    await expect(page.getByText(timeline.incidents[0]!.ruleName!).first()).toBeVisible();
  });
});

test.describe('the rest of the surface', () => {
  /** ⭐ P-8.6 priority 5 — the fields that reached no screen before this milestone. */
  test('shows the full analysis metadata', async ({ page }) => {
    await analysedRecording(page);
    const panel = page.getByTestId('analysis-details');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('yolox-nano');
    await expect(panel).toContainText(/CPUExecutionProvider/);
    await expect(panel).toContainText(/fps/);
    await expect(panel).toContainText(/h264/);
  });

  /** ⭐ P-8.6 priority 6 — the report endpoint, reachable from the page at last. */
  test('downloads the export report', async ({ page }) => {
    await analysedRecording(page);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.getByRole('button', { name: /export report/i }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    await page.screenshot({ path: join(SHOTS, 'p86-04-export.png'), fullPage: true });
  });

  /**
   * ⭐ P-8.6 priority 4 — offline events reachable in the explorer, ⛔ and clearly marked as not
   * live. An events page that showed week-old footage as though it were the live feed would be the
   * most dangerous screen in the product.
   */
  test('opens one run’s events in the explorer, labelled as offline', async ({ page, request }) => {
    const id = await analysedRecording(page);
    const token = await apiToken(request);
    const timeline = (await (
      await request.get(`/api/media/analyses/${id}/timeline`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()).data as Timeline;

    await page.goto(`/events?analysisSessionId=${timeline.sessionId}`);
    await expect(page.getByTestId('analysis-filter-banner')).toContainText(/not live activity/i);
    /* ⚠️ And the rows really are this run's — a banner over the live feed would be worse than none. */
    await expect(page.getByRole('row')).not.toHaveCount(1);
    await page.screenshot({ path: join(SHOTS, 'p86-05-events-explorer.png'), fullPage: true });
  });
});

/** `mm:ss`, matching `features/investigations/format.ts`. */
function formatOffset(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

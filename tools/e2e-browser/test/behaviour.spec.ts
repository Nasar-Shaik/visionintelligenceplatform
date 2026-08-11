/**
 * **The investigation behaviour surface, in a real browser against the deployed platform**
 * (Phase 2.4 slice 2.8).
 *
 * ⛔ **The defect class here is not a crash — it is a screen that states something the runtime did
 * not.** A behaviour fact seeked to the wrong frame renders a perfectly good video frame; a
 * truncated answer drawn as a complete one renders a complete-looking list; a coverage measure
 * labelled "confidence" renders as a probability in the reader's head. None of them throw, none of
 * them look broken, and each would let a customer draw a conclusion about a person the platform
 * never supported.
 *
 * So every assertion below compares the rendered DOM against a payload fetched **independently**
 * over HTTP from the same deployment — the discipline `surface.spec.ts` established for P-8.6.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, signIn, apiToken, uploadThroughUi, waitForRunToFinish } from '../src/fixtures.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SHOTS = join(process.cwd(), 'artifacts/screens');
mkdirSync(SHOTS, { recursive: true });

interface TimelineEntry {
  kind: string;
  identityId: string;
  atSeconds: number;
  footageSeconds: number;
  seconds?: number;
  summary: string;
  evidence: { frameIndex?: number; trackId?: string };
}
interface BehaviourTimeline {
  enabled: boolean;
  entries: TimelineEntry[];
  truncated: boolean;
  countsByKind: Record<string, number>;
  kindsRequested: string[];
  excludedByKind: number;
  relational?: { identitiesConsidered: number; truncated: boolean; maxIdentities: number };
}

/** One analysed recording, reused across this file. */
async function analysedRecording(page: Page): Promise<string> {
  await signIn(page);
  const { id } = await uploadThroughUi(page, 'multiple-people');
  await page.goto(`/investigations/${id}`);
  await page.getByRole('button', { name: /run analysis/i }).click();
  await waitForRunToFinish(page);
  return id;
}

/** The run this page is showing, read off the page's own network traffic rather than guessed. */
async function sessionIdOf(page: Page, request: APIRequestContext, analysisId: string): Promise<string> {
  const token = await apiToken(request);
  const res = await request.get(`/api/media/analyses/${analysisId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  const sessions: { id: string; state: string }[] = body.data.sessions;
  const terminal = sessions.filter((s) => ['succeeded', 'failed', 'cancelled', 'expired'].includes(s.state));
  /* ⚠️ The page selects the FIRST session in the list, not the newest; mirroring that here is what
   * makes the comparison a comparison rather than two independent guesses. */
  const chosen = terminal[0] ?? sessions[0];
  if (chosen === undefined) throw new Error('the analysis has no session to read behaviour for');
  return chosen.id;
}

async function behaviourTimeline(
  request: APIRequestContext,
  streamId: string,
  kinds?: string,
): Promise<BehaviourTimeline> {
  const token = await apiToken(request);
  const query = kinds === undefined ? '' : `&kinds=${encodeURIComponent(kinds)}`;
  const res = await request.get(`/api/behaviour/timeline?streamId=${streamId}${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status(), 'the behaviour timeline must be readable through the gateway').toBe(200);
  return (await res.json()).data;
}

test.describe('the behaviour surface is on the investigation page', () => {
  test('renders the run’s own facts, and agrees with the API about every one', async ({ page, request }) => {
    const analysisId = await analysedRecording(page);
    const streamId = await sessionIdOf(page, request, analysisId);
    const api = await behaviourTimeline(request, streamId);

    const panel = page.getByTestId('behaviour-panel');
    await expect(panel).toBeVisible();

    /*
     * ⛔ **An empty behaviour answer is a legitimate result and must not be asserted away.** A
     * 19-second clip of two people may produce no primitive at all. So the assertion is that the
     * SCREEN AGREES WITH THE API — including when both say nothing.
     */
    const rows = page.getByTestId('behaviour-row');
    await expect
      .poll(async () => rows.count(), { timeout: 30_000 })
      .toBe(api.entries.length);

    const first = api.entries[0];
    if (first !== undefined) {
      const row = rows.first();
      await expect(row).toHaveAttribute('data-kind', first.kind);
      await expect(row).toHaveAttribute('data-identity', first.identityId);
    }
    await page.screenshot({ path: join(SHOTS, 'p28-01-behaviour-timeline.png'), fullPage: true });
  });

  /**
   * ⛔ **The seek arithmetic, measured against the video element rather than reasoned about.**
   *
   * `atSeconds` is measured from the run's first observation; `video.currentTime` is measured from
   * the first frame of the file. They are equal only when somebody is in shot at 00:00. Clicking a
   * fact must move the playhead to `footageSeconds - footageStartedAt`, and this asserts the number
   * the browser actually ended up at.
   */
  test('clicking a fact moves the playhead to the frame that fact came from', async ({ page, request }) => {
    const analysisId = await analysedRecording(page);
    const streamId = await sessionIdOf(page, request, analysisId);
    const api = await behaviourTimeline(request, streamId);
    test.skip(api.entries.length === 0, 'this recording produced no behaviour fact to seek to');

    const token = await apiToken(request);
    const timelineRes = await request.get(`/api/media/analyses/${analysisId}/timeline`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const analysisTimeline = (await timelineRes.json()).data;
    const startSeconds = Date.parse(analysisTimeline.footageStartedAt) / 1000;

    /*
     * ⛔ **Not `.first()` unconditionally — that made this test intermittent.**
     *
     * A fact whose footage instant falls outside this recording is `unplaceable`: the console
     * disables the control and leaves `data-offset` empty, deliberately, because seeking to 0 would
     * put an operator on a frame where the thing being explained is not happening. Reading that
     * attribute regardless gives `Number('') === 0`, which then fails against the fact's real
     * offset — so whether this test passed depended on whether the run's FIRST fact happened to
     * land inside the recording. That state is pinned deterministically in the console's own suite
     * (`behaviour-surface.test.tsx`, "disables the seek for a fact that does not fall inside this
     * recording"); here we assert it and then measure the seek on a fact there is a frame for.
     */
    const seeks = page.getByTestId('behaviour-seek');
    await expect(seeks.first()).toBeVisible();
    const bases = await seeks.evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLElement).dataset.basis ?? ''),
    );
    for (const [i, basis] of bases.entries()) {
      if (basis === 'unplaceable') {
        await expect(seeks.nth(i)).toBeDisabled();
        await expect(seeks.nth(i)).toHaveAttribute('data-offset', '');
      }
    }
    const index = bases.findIndex((b) => b !== 'unplaceable' && b !== '');
    test.skip(index === -1, 'every fact this run produced is unplaceable in this recording');

    const seek = seeks.nth(index);
    const basis = bases[index];
    const offset = Number(await seek.getAttribute('data-offset'));

    /* ⛔ The console's own arithmetic, recomputed here from the raw payloads. ⚠️ `entries[index]`,
     * because row order and entry order correspond — asserted by the sibling test above. */
    const fact = api.entries[index]!;
    const expected = basis === 'footage-clock' ? fact.footageSeconds - startSeconds : fact.footageSeconds;
    expect(offset).toBeCloseTo(Math.min(Math.max(expected, 0), analysisTimeline.durationSeconds ?? expected), 2);

    await seek.click();
    const video = page.locator('[data-testid="analysis-player"] video');
    await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(offset, 1);
    await page.screenshot({ path: join(SHOTS, 'p28-02-behaviour-seek.png'), fullPage: true });
  });

  /**
   * ⛔ **The filter must reach the runtime.** Filtering in the browser cannot recover a fact the
   * runtime's cap already dropped, so this asserts the outgoing request carries the selection.
   */
  test('a kind filter is sent to the runtime, not applied to what arrived', async ({ page, request }) => {
    const analysisId = await analysedRecording(page);
    const streamId = await sessionIdOf(page, request, analysisId);
    const api = await behaviourTimeline(request, streamId);
    const kind = Object.keys(api.countsByKind)[0];
    test.skip(kind === undefined, 'this recording produced no behaviour fact to filter');

    const filtered = page.waitForRequest(
      (r) => r.url().includes('/api/behaviour/timeline') && r.url().includes(`kinds=${kind}`),
      { timeout: 30_000 },
    );
    await page.getByTestId(`kind-filter-${kind}`).click();
    await filtered;

    /* And the answer really is narrowed at the source. */
    const narrowed = await behaviourTimeline(request, streamId, kind);
    expect(new Set(narrowed.entries.map((e) => e.kind))).toEqual(new Set([kind]));
    /* ⭐ The counts still describe the whole run — that is what makes the loss visible. */
    expect(narrowed.countsByKind).toEqual(api.countsByKind);
  });

  test('the graph draws the same nodes the API returned', async ({ page, request }) => {
    const analysisId = await analysedRecording(page);
    const streamId = await sessionIdOf(page, request, analysisId);
    const token = await apiToken(request);
    const res = await request.get(`/api/behaviour/graph?streamId=${streamId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const graph = (await res.json()).data.graph;

    await page.getByRole('tab', { name: 'Graph' }).click();
    if ((graph?.nodes.length ?? 0) === 0) {
      await expect(page.getByText(/no behaviour graph|no identity was tracked/i)).toBeVisible();
      return;
    }
    await expect(page.getByTestId('behaviour-graph-svg')).toBeVisible();
    const drawn = await page.getByTestId('graph-node').count();
    expect(drawn).toBeLessThanOrEqual(graph.nodes.length);
    await expect(page.getByTestId('graph-counts')).toContainText(`/${graph.nodes.length} nodes`);

    /*
     * ⛔ **No screen anywhere may print an absolute footage second.** A recording stamped with
     * wall-clock capture times gives instants around 1.79e9; this platform has shipped that defect
     * once already, one layer up.
     */
    const body = await page.getByTestId('behaviour-panel').innerText();
    expect(body).not.toMatch(/\b17[89]\d{7}\b/);
    await page.screenshot({ path: join(SHOTS, 'p28-03-behaviour-graph.png'), fullPage: true });
  });

  test('the primitive inspector shows the thresholds each word was computed at', async ({ page, request }) => {
    const analysisId = await analysedRecording(page);
    const streamId = await sessionIdOf(page, request, analysisId);
    const token = await apiToken(request);
    const res = await request.get(`/api/behaviour/primitives?streamId=${streamId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const readings = (await res.json()).data.primitives.readings;
    expect(Object.keys(readings).length, 'the runtime must publish its thresholds').toBeGreaterThan(0);

    await page.getByRole('tab', { name: 'Primitives' }).click();

    /*
     * ⛔ **Wait for the panel to SETTLE before branching on what it contains.**
     *
     * `locator.count()` is an immediate read with no retry, so calling it while the primitives query
     * is still in flight returns 0 — and the test then takes the "this run established nothing"
     * branch and waits thirty seconds for a message that will never appear, against a page that was
     * rendering the table correctly the whole time. A red test for a working product is the most
     * expensive kind of failure, and this one was mine.
     */
    const rows = page.getByTestId('primitive-row');
    await expect
      .poll(async () => (await rows.count()) > 0 || (await page.getByText(/established no primitive/i).count()) > 0, {
        timeout: 30_000,
      })
      .toBe(true);

    if ((await rows.count()) === 0) {
      await expect(page.getByText(/established no primitive/i)).toBeVisible();
      return;
    }
    /* Whatever this run produced, at least one row must carry the mechanism the runtime named. */
    const text = await page.getByTestId('primitive-inspector').innerText();
    const mechanisms = Object.values(readings)
      .map((r) => (r as { mechanism?: string }).mechanism)
      .filter((m): m is string => typeof m === 'string');
    expect(mechanisms.some((m) => text.includes(m))).toBe(true);
    await page.screenshot({ path: join(SHOTS, 'p28-04-primitive-inspector.png'), fullPage: true });
  });

  /**
   * ⛔ **Nothing on this surface may present a match as an incident**, and nothing may present the
   * coverage measure as a probability. Both are one word away from being wrong, and the wrong
   * version renders perfectly.
   */
  test('the reasoning surface says candidate, and labels confidence as coverage', async ({ page }) => {
    /*
     * ⚠️ Its own analysed recording, rather than whichever row happened to sort first. The earlier
     * version clicked the top of the list and skipped when the tab was absent — so it reported
     * "skipped" on a healthy deployment and would have reported "skipped" on a broken one too. A
     * conditional skip that can hide the defect it guards is worse than no test.
     */
    await analysedRecording(page);

    await page.getByRole('tab', { name: 'Reasoning' }).click();
    await expect(page.getByTestId('reasoning-panel')).toBeVisible();
    const text = await page.getByTestId('reasoning-panel').innerText();
    expect(text).toContain('no incident is created');

    /* Evaluate the composer's default two-step chain against the real graph, through the gateway. */
    const answered = page.waitForResponse(
      (r) => r.url().includes('/api/rules/rules/behaviour/evaluate'),
      { timeout: 60_000 },
    );
    await page.getByTestId('evaluate-rule').click();
    const response = await answered;
    /* ⛔ 200 or a stated 503. Anything else means the console composed a rule the service rejects. */
    expect([200, 503]).toContain(response.status());

    if (response.status() === 200) {
      const body = await response.json();
      expect(body.data.rulesEvaluated).toBe(1);
      /* Whatever it found, the words on screen must stay honest about what a match is. */
      const after = await page.getByTestId('reasoning-panel').innerText();
      expect(after).not.toMatch(/\bincident (created|raised|generated)\b/i);
      if (body.data.candidates.length > 0) {
        await expect(page.getByTestId('candidate-confidence')).toContainText('evidence coverage');
      }
    }
    await page.screenshot({ path: join(SHOTS, 'p28-05-reasoning-chain.png'), fullPage: true });
  });
});

test.describe('what the surface refuses to show', () => {
  /**
   * ⛔ **`track:read`, not a weaker permission.** A recomputed dwell is more revealing than the
   * track it came from, never less. A viewer without it must be refused by the API, not merely
   * hidden by the UI.
   */
  test('the behaviour reads are refused without a token', async ({ request }) => {
    for (const view of ['timeline', 'graph', 'primitives']) {
      const res = await request.get(`/api/behaviour/${view}?streamId=ases_nothing`);
      expect([401, 403], `${view} must not answer anonymously`).toContain(res.status());
    }
  });

  /** ⚠️ A stream that does not exist is an empty answer, not an error — and it says which. */
  test('an unknown run answers empty rather than failing', async ({ request }) => {
    const token = await apiToken(request);
    const res = await request.get('/api/behaviour/timeline?streamId=ases_does_not_exist', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()).data;
    expect(body.enabled).toBe(true);
    expect(body.entries).toEqual([]);
    /* ⭐ Echoed back, so a caller who mistyped an id can tell which empty they are looking at. */
    expect(body.query.streamId).toBe('ases_does_not_exist');
  });
});

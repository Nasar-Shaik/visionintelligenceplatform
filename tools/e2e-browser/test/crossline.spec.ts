/**
 * **Cross-line, end to end, in a real browser against the deployed platform** (Phase 2.4 slice 2.9).
 *
 * ⛔ **Nothing here simulates a crossing.** An operator draws a line in the Zone Editor with real
 * clicks; a real recording of a person walking across the frame goes through the real pipeline; and
 * the crossing that comes back is whatever the platform computed from the trajectory it stored.
 *
 * ⚠️ The two assertions that matter are paired, and neither means anything alone:
 *
 *   1. with the line in force, the walk reports a crossing;
 *   2. with **no** line, the same run reports none, and every other kind is unchanged.
 *
 * Without (2), a crossing count could come from anywhere. Without (1), (2) is vacuous.
 */
import type { APIRequestContext } from '@playwright/test';
import { test, expect, signIn, apiToken, uploadThroughUi, waitForRunToFinish, CAMERA } from '../src/fixtures.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SHOTS = join(process.cwd(), 'artifacts/screens');
mkdirSync(SHOTS, { recursive: true });

interface Zone {
  id: string;
  name: string;
  kind: string;
  shape: string;
  geometry: { points: [number, number][] };
}

async function authed(request: APIRequestContext) {
  const token = await apiToken(request);
  return { authorization: `Bearer ${token}` };
}

/** Remove any line zone this suite left behind, so a rerun starts from the same estate. */
async function clearLines(request: APIRequestContext): Promise<void> {
  const headers = await authed(request);
  const res = await request.get(`/api/camera/zones?cameraId=${CAMERA}`, { headers });
  const zones: Zone[] = (await res.json()).data ?? [];
  for (const zone of zones) {
    if (zone.kind === 'line') await request.delete(`/api/camera/zones/${zone.id}`, { headers });
  }
}

test.describe('an operator draws a line and the platform reports crossings', () => {
  test.beforeEach(async ({ request }) => clearLines(request));
  test.afterEach(async ({ request }) => clearLines(request));

  /**
   * ⛔ **Drawn with real clicks on the real canvas.** Posting the geometry over HTTP would prove the
   * API works and say nothing about whether an operator can create one — which is the half of "end
   * to end" that P-5.8 exists to remind everybody about.
   */
  test('draws a line zone through the Zone Editor, and it is stored as a line', async ({ page, request }) => {
    await signIn(page);
    await page.goto('/zones');
    await page.getByLabel('Camera').selectOption(CAMERA);

    /* ⭐ The kind is chosen before the first click: an area and a line are different questions. */
    await page.getByTestId('zone-kind-line').check();
    await expect(page.getByTestId('zone-kind-line')).toBeChecked();

    await page.getByTestId('zone-preset-tripwire').click();
    await page.getByLabel(/zone name/i).fill('Browser Tripwire');

    const created = page.waitForResponse(
      (r) => r.url().includes('/api/camera/zones') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: /save zone/i }).click();
    const response = await created;
    expect(response.status(), 'a line zone must be storable now').toBe(201);

    const zone: Zone = (await response.json()).data;
    expect(zone.kind).toBe('line');
    expect(zone.shape).toBe('line');
    /*
     * ⛔ **Edge to edge.** A tripwire is anchored at the subject's FOOT point, and a standing
     * person's feet sit at y ≈ 0.95 — a line stopping at 0.95 is walked around rather than through,
     * which is exactly what happened on the deployment before this preset was corrected.
     */
    expect(zone.geometry.points[0]?.[1]).toBe(0);
    expect(zone.geometry.points[1]?.[1]).toBe(1);

    /*
     * And it renders as an open line, never as a filled area.
     *
     * ⚠️ **The points are asserted, not visibility.** A perfectly vertical `<polyline>` has a
     * zero-width bounding box, so Playwright reports it `hidden` while it is on screen and correct.
     * Comparing the drawn geometry against the *stored* geometry is the stronger assertion in any
     * case — it is the whole discipline of this suite: does the screen agree with the store.
     */
    const drawn = page.locator(`[data-testid="zone-${zone.id}"]`);
    await expect(drawn).toHaveAttribute('data-kind', 'line');
    const polyline = drawn.locator('polyline');
    await expect(polyline).toHaveCount(1);
    await expect(polyline).toHaveAttribute(
      'points',
      zone.geometry.points.map(([x, y]) => `${String(x)},${String(y)}`).join(' '),
    );
    expect(await drawn.locator('polygon').count(), 'a line has no interior to shade').toBe(0);
    await page.screenshot({ path: join(SHOTS, 'p29-01-line-zone.png'), fullPage: true });

    /* ⭐ The list names the kind: a point count alone hid which question a zone answers. */
    await expect(page.getByText(/line · 2 points/)).toBeVisible();

    await request.delete(`/api/camera/zones/${zone.id}`, { headers: await authed(request) });
  });

  /**
   * ⭐ **The whole slice, measured**: operator geometry → plan → single pipeline → timeline → graph
   * → reasoning → console, on a real recording of a person crossing the frame.
   */
  test('a real walk across a real line appears once, everywhere', async ({ page, request }) => {
    const headers = await authed(request);

    /* 1 — the operator's line, drawn through the UI. */
    await signIn(page);
    await page.goto('/zones');
    await page.getByLabel('Camera').selectOption(CAMERA);
    await page.getByTestId('zone-kind-line').check();
    await page.getByTestId('zone-preset-tripwire').click();
    await page.getByLabel(/zone name/i).fill('Crossing Verification');
    const created = page.waitForResponse(
      (r) => r.url().includes('/api/camera/zones') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /save zone/i }).click();
    const zone: Zone = (await (await created).json()).data;

    /* 2 — it has to reach the enforcement point before the read can use it. */
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/behaviour/timeline?cameraId=${CAMERA}&streamId=probe`, { headers });
          const lines: { lineId: string }[] = (await res.json()).data?.lines ?? [];
          return lines.some((l) => l.lineId === zone.id);
        },
        { timeout: 60_000, intervals: [2000] },
      )
      .toBe(true);

    /* 3 — real footage of one person crossing the frame, through the real pipeline. */
    const { id } = await uploadThroughUi(page, 'single-person-walking');
    await page.goto(`/investigations/${id}`);
    await page.getByRole('button', { name: /run analysis/i }).click();
    await waitForRunToFinish(page);

    const detail = await (await request.get(`/api/media/analyses/${id}`, { headers })).json();
    const session = detail.data.sessions.find((s: { state: string }) => s.state === 'succeeded');
    expect(session, 'the run must have finished for behaviour to be recomputable').toBeDefined();
    const streamId: string = session.id;

    /* 4 — the timeline reports the crossing, with a direction and a frame. */
    const withLine = (
      await (await request.get(`/api/behaviour/timeline?streamId=${streamId}&cameraId=${CAMERA}`, { headers })).json()
    ).data;
    expect(withLine.lineGeometry).toBe('present');

    interface Entry { kind: string; identityId: string; attributes: Record<string, string>; evidence: { frameIndex?: number } }
    const crossings: Entry[] = withLine.entries.filter((e: Entry) => e.kind === 'lineCross');
    expect(crossings.length, 'a person walking across a full-height tripwire crosses it').toBeGreaterThan(0);
    expect(crossings[0]!.attributes.fromSide).not.toBe(crossings[0]!.attributes.toSide);
    expect(crossings[0]!.evidence.frameIndex, 'a crossing must be seekable').toBeGreaterThanOrEqual(0);

    /*
     * 5 — ⛔ **the negative control.** The same run, read without geometry, reports no crossing —
     * and every OTHER kind is identical. That is what makes step 4 evidence rather than a number.
     */
    const withoutLine = (
      await (await request.get(`/api/behaviour/timeline?streamId=${streamId}`, { headers })).json()
    ).data;
    expect(withoutLine.lineGeometry).toBe('absent');
    expect(withoutLine.entries.filter((e: Entry) => e.kind === 'lineCross')).toHaveLength(0);
    const others = Object.fromEntries(
      Object.entries(withLine.countsByKind as Record<string, number>).filter(([k]) => k !== 'lineCross'),
    );
    expect(withoutLine.countsByKind).toEqual(others);

    /*
     * 6 — ⛔ one event, not two: the graph is a reshaping of the timeline, never a second count.
     *
     * ⚠️ **Only comparable when the timeline was not capped.** The two reads use different entry
     * ceilings — 2 000 for the timeline, 20 000 for the graph's source — so on a busy camera the
     * graph legitimately holds facts the timeline did not return, and comparing the two lengths there
     * would report a *correct* platform as duplicating events. Measured on the live camera: 434
     * crossings in `countsByKind`, 216 in a capped `entries`, 434 in the graph. `countsByKind` is the
     * number that describes the run; `entries.length` describes the response.
     */
    expect(withLine.truncated, 'this fixture must fit inside one timeline read').toBe(false);
    const graph = (
      await (await request.get(`/api/behaviour/graph?streamId=${streamId}&cameraId=${CAMERA}`, { headers })).json()
    ).data.graph;
    interface Edge { kind: string; evidence: { frameIndex?: number } }
    const crossed: Edge[] = graph.edges.filter((e: Edge) => e.kind === 'crossed');
    expect(crossed).toHaveLength(crossings.length);
    expect(crossings.length).toBe((withLine.countsByKind as Record<string, number>).lineCross);
    expect(crossed.map((e) => e.evidence.frameIndex).sort()).toEqual(
      crossings.map((e) => e.evidence.frameIndex).sort(),
    );
    expect(graph.nodes.filter((n: { kind: string }) => n.kind === 'line').length).toBeGreaterThan(0);

    /* ⭐ The operator's own name reaches the graph, so a chain reads "crossed Doorway". */
    expect(graph.nodes.find((n: { kind: string; label: string }) => n.kind === 'line')?.label).toBe(
      'Crossing Verification',
    );

    /* 7 — the reasoning engine can name the direction, and refuses the line nobody drew. */
    const evaluate = async (steps: Record<string, unknown>[]) => {
      const res = await request.post('/api/rules/rules/behaviour/evaluate', {
        headers,
        data: {
          streamId,
          cameraId: CAMERA,
          rules: [
            {
              id: 'rule_browser',
              tenantId: process.env.VIP_TENANT ?? 'tnt_demo_retail',
              name: 'crossing',
              version: 1,
              enabled: true,
              cameraIds: [],
              steps,
              candidateLabel: 'crossed the line',
              severity: 'medium',
            },
          ],
        },
      });
      return (await res.json()).data.candidates.length as number;
    };
    const direction = crossings[0]!.attributes.toSide;
    const opposite = direction === 'left' ? 'right' : 'left';
    expect(await evaluate([{ kind: 'crossed', absent: false, lineId: zone.id }])).toBeGreaterThan(0);
    expect(await evaluate([{ kind: 'crossed', absent: false, lineId: zone.id, toSide: direction }])).toBeGreaterThan(0);
    /* ⛔ The wrong direction must NOT match — otherwise `toSide` is decoration. */
    expect(await evaluate([{ kind: 'crossed', absent: false, lineId: zone.id, toSide: opposite }])).toBe(0);
    /* ⛔ And a line that does not exist must not match either. */
    expect(await evaluate([{ kind: 'crossed', absent: false, lineId: 'zn-nothing' }])).toBe(0);

    /* 8 — the console shows it, on the same page, seekable. */
    await page.reload();
    await page.getByTestId('kind-filter-lineCross').click();
    const rows = page.locator('[data-testid="behaviour-row"][data-kind="lineCross"]');
    await expect.poll(async () => rows.count(), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId('line-geometry')).toContainText('Crossing Verification');
    await page.screenshot({ path: join(SHOTS, 'p29-02-crossing-timeline.png'), fullPage: true });

    const seek = rows.first().getByTestId('behaviour-seek');
    const offset = Number(await seek.getAttribute('data-offset'));
    await seek.click();
    const video = page.locator('[data-testid="analysis-player"] video');
    await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(offset, 1);

    await request.delete(`/api/camera/zones/${zone.id}`, { headers });
  });

  /**
   * ⭐ **A line drawn too short is explained rather than silent** (slice 2.9).
   *
   * ⛔ This is the exact configuration that produced zero crossings on the deployment and looked
   * identical to a working one. `lineDiagnostics` now says *people walked past this line*, which is
   * a sentence an operator can act on.
   */
  test('says when people are walking past a line rather than through it', async ({ page, request }) => {
    const headers = await authed(request);
    const short = await request.post('/api/camera/zones', {
      headers,
      data: {
        cameraId: CAMERA,
        name: 'Too Short',
        kind: 'line',
        shape: 'line',
        /* ⚠️ Visually spans the frame; stops above where feet actually are. */
        geometry: { points: [[0.5, 0.05], [0.5, 0.6]] },
        enabled: true,
        attributes: {},
      },
    });
    expect(short.status()).toBe(201);
    const zone: Zone = (await short.json()).data;

    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/behaviour/timeline?cameraId=${CAMERA}&streamId=probe`, { headers });
          const lines: { lineId: string }[] = (await res.json()).data?.lines ?? [];
          return lines.some((l) => l.lineId === zone.id);
        },
        { timeout: 60_000, intervals: [2000] },
      )
      .toBe(true);

    await signIn(page);
    const { id } = await uploadThroughUi(page, 'single-person-walking');
    await page.goto(`/investigations/${id}`);
    await page.getByRole('button', { name: /run analysis/i }).click();
    await waitForRunToFinish(page);

    const detail = await (await request.get(`/api/media/analyses/${id}`, { headers })).json();
    const streamId = detail.data.sessions.find((s: { state: string }) => s.state === 'succeeded').id;

    const primitives = (
      await (await request.get(`/api/behaviour/primitives?streamId=${streamId}&cameraId=${CAMERA}`, { headers })).json()
    ).data.primitives;
    interface Diagnostic { lineId: string; sideChanges: number; crossings: number; missedTheSegment: number }
    const diagnostic: Diagnostic | undefined = (primitives.lineDiagnostics as Diagnostic[]).find(
      (d) => d.lineId === zone.id,
    );
    expect(diagnostic, 'every line in force gets a diagnostic').toBeDefined();
    expect(diagnostic!.crossings).toBe(0);
    expect(diagnostic!.missedTheSegment, 'the walk changed side without passing through').toBeGreaterThan(0);

    /* And the operator is told, in words, on the page. */
    await page.reload();
    await page.getByRole('tab', { name: 'Primitives' }).click();
    await expect(page.getByTestId('behaviour-incompleteness')).toContainText(/walking PAST this line/i);
    await page.screenshot({ path: join(SHOTS, 'p29-03-short-line-diagnostic.png'), fullPage: true });

    await request.delete(`/api/camera/zones/${zone.id}`, { headers });
  });
});

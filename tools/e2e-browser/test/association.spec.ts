/**
 * **Object association, in a real browser against the deployed platform** (Phase 2.4 slice 2.10).
 *
 * ⛔ **The clip's pixels are a real CC0 photograph of a person carrying shopping bags, and the
 * detections are real. The camera motion is a pan and is authored** — nobody picks anything up in a
 * photograph. So this certifies the association *chain* on real multi-class detections and does not
 * certify pick-then-drop on real human motion, which remains PENDING FOOTAGE.
 *
 * ### ⭐ Why this suite exists at all
 *
 * `AssociationModule` ran on every frame from slice 2.2 to slice 2.10 and never once had an object
 * to associate. Every read returned nothing, every screen rendered an empty list, and that is
 * exactly what a working platform shows for a scene where nobody carried anything. The cause was a
 * single confidence floor chosen for `person` and applied to all eighty COCO classes. These specs
 * assert the two halves that make the difference visible: the facts appear **and** the reason for
 * their absence is stated when they do not.
 */
import type { APIRequestContext } from '@playwright/test';
import { test, expect, signIn, apiToken, CAMERA, clip } from '../src/fixtures.js';
import { readFileSync } from 'node:fs';

interface Analysed {
  analysisId: string;
  sessionId: string;
}

/** ⚠️ The runtime's sentences contain ids and full stops, so they are matched literally. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function authed(request: APIRequestContext): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await apiToken(request)}` };
}

/**
 * Push the carried-objects clip through the ordinary product path and wait for the run.
 *
 * ⚠️ Uploaded over the API rather than through the Investigations form, unlike the cross-line suite.
 * That form is certified by `journey.spec.ts` and by `crossline.spec.ts`; what is under test *here*
 * is the console's reading of an association, and re-certifying the uploader in every suite makes
 * one nav change break everything at once while proving nothing new.
 */
async function analyse(request: APIRequestContext): Promise<Analysed> {
  const headers = await authed(request);
  const c = clip('carried-objects');
  const bytes = readFileSync(c.path);

  const created = await request.post('/api/media/analyses', {
    headers,
    data: {
      cameraId: CAMERA,
      label: `association ${String(Date.now())}`,
      originalName: 'carried-objects.mp4',
      contentType: 'video/mp4',
      bytes: bytes.byteLength,
      /* ⚠️ A fixed footage start so two runs land on the same footage clock — offline replay never
       * moves footage time, and letting this default to upload time makes comparison meaningless. */
      footageStartedAt: '2026-02-14T18:30:00.000Z',
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = await created.json();
  const analysisId: string = body.data.analysis.id;

  const put = await request.fetch(body.data.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'video/mp4' },
    data: bytes,
  });
  expect(put.ok()).toBe(true);
  await request.post(`/api/media/analyses/${analysisId}/confirm`, { headers, data: {} });

  const started = await request.post(`/api/media/analyses/${analysisId}/sessions`, {
    headers,
    data: { analysisFrameRate: 4 },
  });
  expect(started.status(), await started.text()).toBe(201);
  const sessionId: string = (await started.json()).data.id;

  await expect
    .poll(
      async () => {
        const detail = await request.get(`/api/media/analyses/${analysisId}`, { headers });
        const session = ((await detail.json()).data.sessions ?? []).find(
          (s: { id: string }) => s.id === sessionId,
        );
        return session?.state ?? 'unknown';
      },
      { timeout: 300_000, intervals: [2_000] },
    )
    .toBe('succeeded');

  return { analysisId, sessionId };
}

test.describe('the platform reports what a person was carrying', () => {
  let run: Analysed;

  /*
   * ⛔ **Analysed per test, not once for the suite, and this is a finding rather than a preference.**
   *
   * Measured during slice 2.10: a subject still being tracked when an offline analysis ends is never
   * written to durable track history. It stays readable from the live window for a few minutes and
   * then disappears from every read — so the same run answers `carried: 3` at one minute and
   * `observed: 2` at ten, with nothing saying anything was lost. A suite that analysed once and
   * asserted five times would fail on whichever test happened to run last, and the failure would
   * look like a console defect. See `docs/validation/OBJECT_ASSOCIATION.md` § durability.
   */
  test.beforeEach(async ({ request }) => {
    run = await analyse(request);
  });

  /**
   * ⭐ The measurement this whole workstream existed to make: a carriable class, detected, tracked,
   * associated and readable. ⛔ Before slice 2.10 every one of these numbers was zero on this exact
   * clip, and nothing said why.
   */
  test('a real carried object reaches the behaviour read', async ({ request }) => {
    const headers = await authed(request);
    const res = await request.get(`/api/behaviour/primitives?streamId=${run.sessionId}`, { headers });
    expect(res.status()).toBe(200);
    const primitives = (await res.json()).data.primitives;

    const diagnostic = primitives.associationDiagnostic;
    expect(diagnostic, 'the diagnostic must always be published').toBeDefined();
    /* ⛔ The absence of a reason IS the success signal — a reason means association did not happen. */
    expect(diagnostic.reason, JSON.stringify(diagnostic)).toBeUndefined();
    expect(diagnostic.objects).toBeGreaterThan(0);
    expect(diagnostic.spans).toBeGreaterThan(0);
    expect(diagnostic.objectLabels.length).toBeGreaterThan(0);

    const held = Object.values(primitives.identities as Record<string, { association?: unknown }>).filter(
      (p) => p.association !== undefined,
    );
    expect(held.length, 'at least one object travelled with a person').toBeGreaterThan(0);
  });

  /**
   * ⛔ **The negative control, and it is what makes the test above evidence.** A clip of a person
   * walking with nothing in their hands must produce no association at all — and must say so with a
   * reason rather than an empty list.
   */
  test('authored footage with nothing to carry reports no association, and names why', async ({ request }) => {
    const headers = await authed(request);
    const c = clip('single-person-walking');
    const bytes = readFileSync(c.path);
    const created = await request.post('/api/media/analyses', {
      headers,
      data: {
        cameraId: CAMERA,
        label: `association control ${String(Date.now())}`,
        originalName: 'single-person-walking.mp4',
        contentType: 'video/mp4',
        bytes: bytes.byteLength,
        footageStartedAt: '2026-02-14T18:30:00.000Z',
      },
    });
    const body = await created.json();
    const analysisId: string = body.data.analysis.id;
    await request.fetch(body.data.uploadUrl, { method: 'PUT', headers: { 'content-type': 'video/mp4' }, data: bytes });
    await request.post(`/api/media/analyses/${analysisId}/confirm`, { headers, data: {} });
    const started = await request.post(`/api/media/analyses/${analysisId}/sessions`, {
      headers,
      data: { analysisFrameRate: 4 },
    });
    const sessionId: string = (await started.json()).data.id;
    await expect
      .poll(
        async () => {
          const detail = await request.get(`/api/media/analyses/${analysisId}`, { headers });
          const session = ((await detail.json()).data.sessions ?? []).find((s: { id: string }) => s.id === sessionId);
          return session?.state ?? 'unknown';
        },
        { timeout: 300_000, intervals: [2_000] },
      )
      .toBe('succeeded');

    const res = await request.get(`/api/behaviour/primitives?streamId=${sessionId}`, { headers });
    const diagnostic = (await res.json()).data.primitives.associationDiagnostic;
    expect(diagnostic.spans).toBe(0);
    /* ⭐ Silence with a reason attached. Before this slice, this and the run above were the same. */
    expect(diagnostic.reason).toBeDefined();
  });

  /** ⭐ The timeline and the graph must agree — one event, read two ways, never counted twice. */
  test('the same carry appears in the timeline and the graph, once', async ({ request }) => {
    const headers = await authed(request);
    const timeline = await (
      await request.get(`/api/behaviour/timeline?streamId=${run.sessionId}&kinds=carried`, { headers })
    ).json();
    const graph = await (await request.get(`/api/behaviour/graph?streamId=${run.sessionId}`, { headers })).json();

    const carried = timeline.data.entries.filter((e: { kind: string }) => e.kind === 'carried');
    const edges = graph.data.graph.edges.filter((e: { kind: string }) => e.kind === 'carried');
    expect(carried.length).toBeGreaterThan(0);
    /* ⚠️ Guarded, because the timeline and the graph read with different entry ceilings (2 000 vs
     * 20 000). On a busy camera the graph legitimately holds facts a capped timeline did not return,
     * and comparing the two lengths there would report a correct platform as duplicating events. */
    expect(timeline.data.truncated).toBe(false);
    expect(edges.length).toBe(carried.length);
  });

  /**
   * ⭐ **The operator's screen.** The console must show the carry, and it must render the runtime's
   * own facts rather than any of its own — everything below is compared against a payload fetched
   * independently of the browser.
   */
  test('the investigation console shows the carry, from the runtime’s own numbers', async ({ page, request }) => {
    const headers = await authed(request);
    const expected = (
      await (await request.get(`/api/behaviour/timeline?streamId=${run.sessionId}&kinds=carried`, { headers })).json()
    ).data;

    await signIn(page);
    await page.goto(`/investigations/${run.analysisId}`);

    await page.getByRole('tab', { name: 'Timeline' }).click();
    const rows = page.locator('[data-testid="behaviour-row"][data-kind="carried"]');
    await expect.poll(async () => rows.count(), { timeout: 60_000 }).toBe(expected.entries.length);

    /*
     * ⛔ Compared against the payload fetched independently of the browser, so this asserts the
     * console *renders the runtime's facts* rather than that it renders something.
     */
    const first = expected.entries[0] as { identityId: string; atSeconds: number; summary: string };
    await expect(rows.first()).toContainText(first.identityId);
    await expect(rows.first()).toContainText(`${first.atSeconds.toFixed(1)} s`);

    /* ⭐ The runtime's own sentence, verbatim, which is where the claim is actually stated. */
    await rows.first().getByRole('button').first().click();
    const detail = page.getByTestId('behaviour-row-detail').first();
    await expect(detail).toBeVisible({ timeout: 30_000 });
    await expect(detail).toHaveText(new RegExp(escapeForRegExp(first.summary)));
  });

  /**
   * ⭐ **The reason, on the screen an operator actually reads.** A carry that did not happen and a
   * carry that could not be computed look identical in a list; the Primitive Inspector is where the
   * difference is stated.
   */
  test('the primitive inspector explains an excluded object rather than staying silent', async ({ page, request }) => {
    const headers = await authed(request);
    const diagnostic = (
      await (await request.get(`/api/behaviour/primitives?streamId=${run.sessionId}`, { headers })).json()
    ).data.primitives.associationDiagnostic;

    await signIn(page);
    await page.goto(`/investigations/${run.analysisId}`);
    await page.getByRole('tab', { name: 'Primitives' }).click();

    const notes = page.getByTestId('behaviour-incompleteness');
    await expect(notes).toBeVisible({ timeout: 60_000 });
    /* ⚠️ Asserted unconditionally, so this test cannot pass by finding nothing to check. */
    expect(diagnostic, JSON.stringify(diagnostic)).toBeDefined();
    expect(diagnostic.spans).toBeGreaterThan(0);
    if (diagnostic.notCarriable > 0) {
      /* ⚠️ A tracked car must be *named* as excluded. Silence about it, on a screen that says
       * "carried", would let an operator believe the car had been considered and cleared. */
      await expect(notes).toContainText('excluded from carrying');
      for (const label of diagnostic.notCarriableLabels as string[]) {
        await expect(notes).toContainText(label);
      }
    }
  });
});

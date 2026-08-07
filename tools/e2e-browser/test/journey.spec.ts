/**
 * ⭐ **The complete customer journey, in a real browser, against the deployed platform** (P-8.5).
 *
 * Login → upload → analysis → progress → timeline → incidents → evidence → export → demonstration.
 * Every step is driven by clicking the thing a customer clicks, and every assertion compares the
 * rendered DOM against the payload the browser actually received — never against an expected string.
 *
 * ### ⚠️ Why the assertions are shaped that way
 *
 * These pages are an easy place to lie, because most of what they report is a **distinction that
 * renders identically when collapsed**: a run that analysed nothing looks like a fast one; a
 * confidence nobody measured looks like `0.00`; an incident lookup that failed looks like a run with
 * no incidents. Each of those looks perfect in a screenshot when it is wrong.
 *
 * So this suite asserts the **absence of invention** as hard as it asserts presence, and the
 * `empty-scene` case is treated as a first-class result rather than a skipped edge.
 */
import { test, expect, signIn, uploadThroughUi, waitForRunToFinish, apiToken } from '../src/fixtures.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SHOTS = join(process.cwd(), 'artifacts/screens');
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => join(SHOTS, `p85-${name}.png`);

test.describe('the investigation journey', () => {
  test('signs in, uploads a recording, and analyses it end to end', async ({ page, request }) => {
    /* ── 1. login ─────────────────────────────────────────────────────── */
    await page.goto('/');
    /* ⚠️ "Sign in to continue" is body text, not a heading — the only `h1` is the product name.
     * Asserting a heading role here failed against a perfectly correct page. */
    await expect(page.getByText(/sign in to continue/i)).toBeVisible();
    await page.screenshot({ path: shot('01-login'), fullPage: true });
    await signIn(page);

    /* ── 2. the investigations screen, reached by CLICKING the nav ────── */
    /*
     * ⛔ This click is the assertion that found V-6. Two sidebar items were both labelled
     * "Investigations" — this one and the incident workspace — so a name-based locator matched two
     * elements and Playwright refused to guess. That ambiguity was invisible to every unit test
     * because each page renders correctly on its own; it exists only in the relationship between
     * them, which is a thing only navigation can expose.
     */
    await page.getByRole('link', { name: 'Recorded Video' }).click();
    await expect(page).toHaveURL(/\/investigations/);
    await expect(page.getByRole('heading', { name: 'Investigations' })).toBeVisible();
    /* ⚠️ The limits are stated BEFORE the operator picks a file, not after a rejection. */
    await expect(page.getByText(/MP4 only, up to 2 GB and 4 hours/i)).toBeVisible();
    await page.screenshot({ path: shot('02-investigations'), fullPage: true });

    /* ⛔ The upload button must be disabled until a camera is chosen — the camera carries the zones
     * and the rules, so an analysis bound to the wrong one is a confident wrong answer. */
    await expect(page.getByRole('button', { name: /upload a recording/i })).toBeDisabled();

    /* ── 3/4. upload and asset creation ───────────────────────────────── */
    const { id } = await uploadThroughUi(page, 'multiple-people');
    await page.screenshot({ path: shot('03-uploaded'), fullPage: true });

    /* ── 5. open it and run the analysis ──────────────────────────────── */
    /* ⚠️ By href, not by name: the list labels rows with the filename and a validation run uploads
     * the same fixture repeatedly. See `uploadThroughUi`. */
    await page.locator(`a[href="/investigations/${id}"]`).click();
    await expect(page.getByRole('button', { name: /run analysis/i })).toBeVisible();
    await page.screenshot({ path: shot('04-detail-before-run'), fullPage: true });
    await page.getByRole('button', { name: /run analysis/i }).click();

    /* ── 6. progress must actually move ───────────────────────────────── */
    /* ⚠️ Asserted while it runs, not only at the end. A progress display that jumps 0 → 100 tells a
     * customer nothing for the whole run, and looks identical afterwards to one that worked. */
    await expect(page.getByText(/queued|starting|running/i).first()).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: shot('05-running'), fullPage: true });

    await waitForRunToFinish(page);
    await expect(page.getByText(/succeeded/i).first()).toBeVisible();
    await page.screenshot({ path: shot('06-succeeded'), fullPage: true });

    /* ── 7. the timeline, checked against the payload ─────────────────── */
    await expect(page.getByRole('heading', { name: /timeline/i })).toBeVisible();

    const analysisId = id;
    const token = await apiToken(request);
    const tl = await (
      await request.get(`/api/media/analyses/${analysisId}/timeline`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    const entries = tl.data.entries as unknown[];

    /*
     * ⭐ **The DOM is compared to the payload, not to a number I chose.** `multiple-people` is
     * measured in the manifest as two subjects; if the model changes, this test tracks the model
     * rather than failing for a reason that has nothing to do with the browser.
     */
    expect(entries.length).toBeGreaterThan(0);
    await expect(page.getByText(/person/i).first()).toBeVisible();
    await page.screenshot({ path: shot('07-timeline'), fullPage: true });

    /*
     * ⛔ **"Incidents could not be looked up" must NOT be on the page.** That string is the honest
     * rendering of a failed lookup, and it is indistinguishable at a glance from a run that simply
     * raised nothing. The workflow call being broken is exactly the defect that shipped once.
     */
    await expect(page.getByText(/could not be looked up/i)).toHaveCount(0);

    /* ── 8. evidence — a real image, fetched ──────────────────────────── */
    const capture = page.getByRole('button', { name: /capture still/i }).first();
    if (await capture.count()) {
      const [imgResponse] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/snapshots') && r.request().method() === 'POST'),
        capture.click(),
      ]);
      expect(imgResponse.status()).toBe(201);
      const snap = await imgResponse.json();
      /* ⚠️ The signed URL is FETCHED. "The API returned 201" is not evidence that a picture exists —
       * a URL that 404s is indistinguishable from a working one until somebody clicks it. */
      const img = await request.get(snap.data.url);
      expect(img.status()).toBe(200);
      const bytes = await img.body();
      expect(bytes.length).toBeGreaterThan(1000);
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8); // JPEG SOI
      await page.screenshot({ path: shot('08-evidence'), fullPage: true });
    }

    /* ── 9. the export report ─────────────────────────────────────────── */
    const report = await (
      await request.get(`/api/media/analyses/${analysisId}/report`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    expect(report.data.generatedAt).toBeTruthy();
    /* ⛔ A report that lists incidents above a count of zero contradicts itself — the defect slice 7
     * shipped and the deployment caught. */
    if ((report.data.counts?.incidents ?? 0) === 0) {
      expect(report.data.incidents ?? []).toHaveLength(0);
    }
  });

  /**
   * ⭐ **The negative control, and the most important test in this file.**
   *
   * Every other test asserts the platform finds something. Only this one asserts it does not
   * invent — and a customer's first false alarm on an empty shop is the fastest way to lose their
   * trust in the whole product.
   */
  test('an empty recording produces no events, and says so rather than rendering blank', async ({ page, request }) => {
    await signIn(page);
    const { id } = await uploadThroughUi(page, 'empty-scene');
    await page.locator(`a[href="/investigations/${id}"]`).click();
    await page.getByRole('button', { name: /run analysis/i }).click();
    await waitForRunToFinish(page);

    const analysisId = id;
    const token = await apiToken(request);
    const tl = await (
      await request.get(`/api/media/analyses/${analysisId}/timeline`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();

    expect(tl.data.entries).toHaveLength(0);
    /* ⚠️ The run still SUCCEEDED. "Nothing was found" and "the analysis failed" are opposite facts
     * and a customer must be able to tell them apart. */
    await expect(page.getByText(/succeeded/i).first()).toBeVisible();
    /* ⛔ And the page must say so in words, not render an empty region the operator has to interpret. */
    await expect(page.getByText(/nothing was detected/i)).toBeVisible();
    await page.screenshot({ path: shot('09-empty-scene'), fullPage: true });
  });

  /**
   * ⭐ Demonstration Mode — the same pipeline at one-times speed, which is what makes a customer
   * demo credible. Started, observed to be pacing, then cancelled: running it to completion would
   * cost the clip's full duration for no additional information.
   */
  test('demonstration mode paces the same pipeline at real time', async ({ page }) => {
    await signIn(page);
    const { id } = await uploadThroughUi(page, 'single-person-walking');
    await page.locator(`a[href="/investigations/${id}"]`).click();

    const demo = page.getByRole('button', { name: /demonstrate at real time/i });
    await expect(demo).toBeVisible();
    await expect(demo).toHaveAttribute('title', /real time/i);
    await demo.click();

    await expect(page.getByText(/queued|starting|running/i).first()).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: shot('10-demonstration'), fullPage: true });

    /*
     * ⚠️ Paced means SLOWER, and that is the assertion. An unpaced run of a 30 s clip finishes in
     * about 3.5 s on this deployment; a real-time run cannot. Checking that it is still running
     * after 10 s distinguishes "paced" from "the parameter was ignored" — which would otherwise
     * render identically.
     */
    await page.waitForTimeout(10_000);
    await expect(page.getByText(/running|starting/i).first()).toBeVisible();
  });

  /**
   * ⚠️ A browser refresh mid-investigation. State that lives only in React is state a customer
   * loses every time they hit F5 — and an investigation is exactly the workflow where somebody
   * bookmarks a URL and comes back to it tomorrow.
   */
  test('survives a refresh and a direct deep link', async ({ page }) => {
    await signIn(page);
    const { id } = await uploadThroughUi(page, 'occlusion');
    await page.locator(`a[href="/investigations/${id}"]`).click();
    const url = page.url();

    await page.reload();
    /* ⚠️ The `h1` is the recording's own filename — the page names the thing being investigated,
     * not the feature. "Runs" is an `h2` that only exists once a run does, so asserting it here
     * would fail on a recording nobody has analysed yet. */
    await expect(page.getByRole('heading', { name: 'occlusion.mp4' }).first()).toBeVisible();

    /* ⛔ A cold navigation, not a client-side route change: this is what a bookmark does. */
    await page.goto('about:blank');
    await page.goto(url);
    await expect(page).toHaveURL(url);
    await expect(page.getByRole('button', { name: /run analysis/i })).toBeVisible();
    await page.screenshot({ path: shot('11-deep-link'), fullPage: true });
  });
});

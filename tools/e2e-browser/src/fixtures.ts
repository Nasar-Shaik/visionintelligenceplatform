/**
 * Shared fixtures for browser certification (P-8.5).
 *
 * ⚠️ Everything here talks to the **deployed** platform. There is no mock server, no seeded
 * fixture database and no stubbed clock — a helper that quietly substituted one would turn this
 * suite into the thing it exists to be an alternative to.
 */
import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '../../..');
export const FIXTURES = join(REPO, 'infra/docker/fixtures/media');

/**
 * ⚠️ **Non-production demo credentials, and they are in the repository on purpose.** This tenant
 * exists only in a local deployment seeded by `pnpm seed:demo`; the password is documented in
 * `docs/project/UAT_GUIDE.md` because a UAT tester needs it. A real deployment's operator changes it
 * before first login — `.env.production` says so at `SEED_PASSWORD`.
 */
export const TENANT = process.env.VIP_TENANT ?? 'tnt_demo_retail';
export const ADMIN = {
  email: process.env.VIP_EMAIL ?? 'security.manager@northgate.demo',
  password: process.env.VIP_PASSWORD ?? '12345678',
};
/** ⚠️ A read-only role. Used to prove the UI hides what the API would refuse. */
export const VIEWER = { email: 'loss.prevention@northgate.demo', password: '12345678' };

export const CAMERA = process.env.VIP_CAMERA ?? 'cam_retail_entrance';

/** The validation library's measured manifest — the ground truth every assertion reads. */
export function manifest(): {
  clips: {
    id: string;
    file: string;
    title: string;
    category: string;
    durationSeconds?: number;
    bytes: number;
    measured?: { people: number | null };
    intent?: { people?: number };
  }[];
} {
  return JSON.parse(readFileSync(join(FIXTURES, 'validation/manifest.json'), 'utf8'));
}

export function clip(id: string) {
  const found = manifest().clips.find((c) => c.id === id);
  if (found === undefined) {
    throw new Error(
      `no clip "${id}" in the validation manifest — run \`node tools/dataset/generate.mjs --verify\``,
    );
  }
  return { ...found, path: join(FIXTURES, found.file) };
}

/**
 * Sign in through the real form.
 *
 * ⛔ Deliberately **not** by injecting a token into local storage. That would be faster and would
 * skip the one thing a login screen is for: proving that a human with a password can get in. P-5.8
 * exists because a step everyone assumed worked had never been executed against a deployment.
 */
export async function signIn(page: Page, who = ADMIN): Promise<void> {
  await page.goto('/');
  await page.getByLabel(/tenant/i).fill(TENANT);
  await page.getByLabel(/email/i).fill(who.email);
  await page.getByLabel(/password/i).fill(who.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  /* ⚠️ Waits for the app shell, not for a URL. A redirect can land before React has rendered
   * anything, and a test that continues then fails on a selector that was merely early. */
  await expect(page.getByRole('navigation')).toBeVisible({ timeout: 30_000 });
}

/** A token for the direct-API assertions a UI test needs to check its own claims against. */
export async function apiToken(request: APIRequestContext, who = ADMIN): Promise<string> {
  const res = await request.post('/api/identity/auth/login', {
    headers: { 'x-tenant-id': TENANT },
    data: { email: who.email, password: who.password },
  });
  const body = await res.json();
  return body.data.accessToken;
}

/**
 * Upload a recording through the **UI** and return the analysis it created.
 *
 * ⚠️ `setInputFiles` on the hidden `<input type=file>` rather than a click on the button. The button
 * opens a native picker Playwright cannot drive; the input is what the browser actually submits, so
 * this exercises the real change handler, the real presign call and the real PUT.
 */
export async function uploadThroughUi(
  page: Page,
  clipId: string,
  opts: { camera?: string } = {},
): Promise<{ name: string; id: string }> {
  const c = clip(clipId);
  /* ⚠️ Navigated by URL rather than by clicking the sidebar. The nav link is exercised once, in
   * `journey.spec.ts`; doing it in every helper would make an unrelated nav change break every
   * spec at once and say nothing about what actually broke. */
  await page.goto('/investigations');
  await page.getByLabel(/^camera$/i).click();
  await page.getByRole('option', { name: cameraLabel(opts.camera ?? CAMERA) }).click();

  /*
   * ⚠️ **The created id is taken from the response, not inferred from the row's name.**
   *
   * The list labels a recording with its filename, and a validation run uploads the same fixture
   * repeatedly — so `getByRole('link', { name: 'occlusion.mp4' })` matched five previous runs and
   * Playwright correctly refused to guess which. `.first()` would have "fixed" it by silently
   * asserting against whichever row sorted highest, which on a slow render is the *previous* upload.
   * A certification that can assert against the wrong object is worse than one that fails.
   *
   * ⓘ Worth recording as a product observation rather than a defect: the list gives an operator no
   * way to tell two same-named recordings apart except by the Created column.
   */
  const [created] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith('/api/media/analyses') && r.request().method() === 'POST',
      { timeout: 120_000 },
    ),
    page.locator('input[type=file]').setInputFiles(c.path),
  ]);
  const body = await created.json();
  const id: string = body.data.analysis.id;
  const name = `${c.id}.mp4`;
  /* The row must still appear — the upload is not done until the operator can see it. */
  await expect(page.locator(`a[href="/investigations/${id}"]`)).toBeVisible({ timeout: 120_000 });
  return { name, id };
}

/** ⚠️ The select shows camera NAMES; the API takes ids. Mapping them here keeps specs readable. */
function cameraLabel(id: string): RegExp {
  const known: Record<string, string> = {
    cam_retail_entrance: 'Main Entrance',
    cam_retail_checkout1: 'Checkout — Lanes 1–4',
    cam_retail_stockroom: 'Stock Room — Goods In',
  };
  return new RegExp(known[id] ?? id, 'i');
}

/**
 * Wait until a run reaches a terminal state, by watching the page rather than the API.
 *
 * ⚠️ **The point is that the UI reflects it.** Polling the API and then asserting on the DOM would
 * pass on a page that never refreshes — which is precisely the defect a customer would report as
 * "it says running forever".
 */
export async function waitForRunToFinish(page: Page, timeoutMs = 10 * 60 * 1000): Promise<void> {
  await expect(
    page.getByText(/succeeded|failed|cancelled|expired/i).first(),
  ).toBeVisible({ timeout: timeoutMs });
}

export const test = base;
export { expect };

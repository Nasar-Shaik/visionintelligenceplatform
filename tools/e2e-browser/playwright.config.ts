/**
 * Browser certification of the deployed platform (P-8.5 Product Validation).
 *
 * ⛔ **This suite has no doubles at all.** It drives a real browser against the real Caddy edge over
 * real TLS, with a real JWT, real object storage, real ffmpeg and the real ONNX runtime. Everything
 * else in this repository proves the code is right; this is the only thing that proves the product
 * works. Every serious defect P-8 shipped — a URL presigned for the wrong audience, a dedup key a
 * rerun collided with, a msgId the broker discarded, a playback path that had never worked outside
 * `pnpm dev` — was invisible to every unit test and visible here.
 *
 * ### ⚠️ `ignoreHTTPSErrors`, and why that is not a weakening
 *
 * The edge terminates TLS with Caddy's **internal CA**, which is a genuine certificate from a CA
 * this machine has not been told to trust. Accepting it is what lets the suite exercise the real
 * HTTPS path — HSTS, secure cookies, the CSP, the single origin — rather than a plaintext listener
 * standing in for it. Against a production edge with a public certificate this flag changes nothing.
 * It is scoped to this suite and appears nowhere in the application.
 *
 * ### ⚠️ Serial, one worker
 *
 * The deployment analyses one recording at a time (L-41: `maxConcurrent` is 1), so parallel specs
 * would queue behind each other and every duration measured would be a queue wait wearing an
 * analysis's clothes. Concurrency is measured deliberately in `concurrency.spec.ts`, not accidentally
 * everywhere.
 */
import { defineConfig, devices } from '@playwright/test';

const BASE = process.env.VIP_BASE_URL ?? 'https://localhost';

export default defineConfig({
  testDir: './test',
  outputDir: './artifacts/output',
  /* ⚠️ Long. A five-minute recording analysed at ×8 plus upload, probe and report is minutes, not
   * seconds, and a timeout tuned for a mocked API turns a slow deployment into a flaky suite. */
  timeout: 15 * 60 * 1000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  /*
   * ⛔ **`retries: 0`, deliberately.** A retry here would mask exactly the class of defect this
   * suite exists to find: a rerun that collides with the first run's state passes on attempt two for
   * the wrong reason. If a spec is flaky against a real deployment, that is a finding about the
   * product, not a reason to run it again.
   */
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/report', open: 'never' }],
    ['json', { outputFile: 'artifacts/results.json' }],
  ],
  use: {
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    /* ⚠️ Screenshots and traces on failure are the evidence. A red test with no artefact is a
     * bug report nobody can act on the next morning. */
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    actionTimeout: 30_000,
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    /*
     * ⚠️ **Edge is a real project, not an alias for Chromium.** It is the same engine, so it will
     * almost always agree — but "almost always" is a claim, and a customer's IT department asking
     * "is Edge supported?" deserves a measurement. It is skipped automatically when the channel is
     * not installed rather than silently reporting a Chromium pass as an Edge one.
     */
    {
      name: 'edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    /*
     * ⛔ **WebKit is where TD-29 lives.** Safari genuinely cannot play `hev1`-tagged HEVC in MSE
     * while Chromium can, so a suite that certified only Chromium would report a codec as supported
     * that a third of macOS customers cannot watch. This project is the reason the dataset ships
     * both `codec-h265-hvc1` and `codec-h265-hev1`.
     */
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
});

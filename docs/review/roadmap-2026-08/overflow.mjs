/**
 * Horizontal-overflow check, measured on painted boxes.
 *
 * ⚠️ **The version this replaces reported zero and was wrong.** P-5.9 compared
 * `document.scrollWidth` with `clientWidth` across 11 pages × 5 viewports and found no overflow. The
 * Investigation Workspace was, at that moment, painting its right column 24 px past its parent at
 * 1280 px and 1440 px — with 25 to 44 elements cut off — because an ancestor is `overflow-hidden`.
 * **A container that clips its children reports no page overflow while cutting content off.**
 *
 * So this asks the question that matters to an operator: is anything painted outside the viewport?
 * `getBoundingClientRect().right > clientWidth` answers that whether or not the page scrolls.
 *
 * Run: see docs/review/roadmap-2026-08/README.md.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'https://localhost';
const PASSWORD = process.env.SEED_PASSWORD ?? '12345678';

const ROUTES = [
  '/',
  '/live',
  '/cameras',
  '/locations',
  '/events',
  '/incidents',
  '/workspace',
  '/alerts',
  '/rules',
  '/health',
  '/settings',
];
/* 1280 and 1440 are the two most common operator laptop widths, and were the two that failed. */
const WIDTHS = [1920, 1536, 1440, 1280, 1024, 768, 390];

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.getByLabel(/tenant/i).fill('tnt_demo_retail');
await page.getByLabel(/email/i).fill('security.manager@northgate.demo');
await page.getByLabel(/password/i).fill(PASSWORD);
await page.getByRole('button', { name: /sign in/i }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });

let failures = 0;

for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 900 });
  const bad = [];
  for (const route of ROUTES) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const n = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      /*
       * ⚠️ A wide table inside an `overflow-x: auto` container is **not** a defect — it is a
       * scrollable table, which is the correct treatment for a dense grid on a narrow screen. Only
       * content the operator cannot reach counts, so anything inside a horizontally scrollable
       * ancestor is excluded.
       *
       * Getting this wrong in either direction is the same mistake: the first version of this check
       * measured page scroll and missed a clipped column; a version that flags every scrollable
       * table reports 23 failures that are all correct behaviour.
       */
      const reachable = (el) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const ox = getComputedStyle(p).overflowX;
          if (ox === 'auto' || ox === 'scroll') return true;
          if (ox === 'hidden') return false;
        }
        return false;
      };
      return [...document.querySelectorAll('*')].filter((el) => {
        const b = el.getBoundingClientRect();
        /* Ignore hairlines and zero-size nodes; a real cut-off element has width. */
        return b.width > 40 && b.right > vw + 1 && !reachable(el);
      }).length;
    });
    if (n > 0) bad.push(`${route} (${n})`);
  }
  failures += bad.length;
  console.log(
    `${String(width).padStart(4)}px  ${bad.length === 0 ? '✓ no clipped elements' : `✗ ${bad.join(', ')}`}`,
  );
}

console.log(failures === 0 ? '\n✓ nothing painted outside the viewport' : `\n✗ ${failures} page/width combinations clip content`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);

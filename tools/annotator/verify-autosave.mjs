/**
 * Does annotated work actually survive the page going away? — P3.3c.
 *
 *   node tools/annotator/verify-autosave.mjs
 *
 * ⛔ THE REGRESSION THIS EXISTS FOR. An hour of hand annotation was lost when the tab holding it
 * was closed: the tool had no autosave, nothing was on disk, and the only copy was page memory.
 *
 * ⭐ Unlike `verify-export.mjs`, this drives a REAL browser: the real 37 frames through the real
 * file picker, real `localStorage`, and a **real reload**. The VM harness can prove the draft
 * serialises and re-applies; only a browser can prove it survives the page being destroyed — and
 * that distinction is exactly what was lost the first time.
 *
 * Requires Playwright's chromium (already a dev dependency of tools/e2e-browser).
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(HERE));
const require = createRequire(join(REPO, 'tools', 'e2e-browser', 'package.json'));
const { chromium } = require('@playwright/test');

const FRAMES_DIR = join(REPO, '.data', 'real', 'movie101-frames');
const URL_ = 'file://' + join(HERE, 'pose-annotator.html');

let frames;
try {
  frames = readdirSync(FRAMES_DIR)
    .filter((f) => /^frame-\d+\.png$/.test(f))
    .sort()
    .map((f) => join(FRAMES_DIR, f));
} catch {
  console.error(`⛔ ${FRAMES_DIR} is missing — extract the movie101 frames first`);
  process.exit(1);
}
if (frames.length === 0) {
  console.error('⛔ no frame-000NN.png files found');
  process.exit(1);
}

/* ⛔ INVENTED joints, to exercise the path. Not ground truth, not from any model. */
const JOINTS = {
  left_shoulder: [0.39, 0.35],
  right_shoulder: [0.49, 0.35],
  left_hip: [0.405, 0.545],
  right_hip: [0.475, 0.545],
  left_wrist: [0.355, 0.53],
};
const HIDDEN = 'left_wrist';

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
await page.goto(URL_);

const ready = () =>
  page.waitForFunction(
    () => state.frames.length > 0 && state.images[0] && state.images[0].complete,
    null,
    { timeout: 30000 },
  );

/* 1 ── the real frames, through the real picker */
await page.setInputFiles('#filePicker', frames);
await ready();
const loaded = await page.evaluate(() => state.frames.length);

/* 2 ── annotate, and let the sidebar redraw as it does after any committed change */
await page.evaluate(
  ([joints, hidden]) => {
    state.current = 3;
    const f = state.frames[3];
    f.bbox = [0.3, 0.25, 0.28, 0.55];
    for (const [n, p] of Object.entries(joints))
      f.joints.set(n, { x: p[0], y: p[1], visible: n !== hidden });
    refreshStatus(f);
    state.frames[5].status = STATUS.EMPTY; /* a deliberate human statement, not an absence */
    document.getElementById('annotator').value = 'verify-autosave.mjs';
    renderSidebar();
  },
  [JOINTS, HIDDEN],
);

const saved = await page.evaluate(() => ({
  key: Object.keys(localStorage).find((k) => k.startsWith('vip.pose.draft.')) || null,
  raw:
    localStorage.getItem(
      Object.keys(localStorage).find((k) => k.startsWith('vip.pose.draft.')) || '',
    ) || '',
  status: document.getElementById('saveStatus').textContent,
}));

/* 3 ── ⛔ the event that destroyed the real annotation */
await page.reload();
const afterReload = await page.evaluate(() => ({
  offered: document.getElementById('draftNote').classList.contains('hidden')
    ? null
    : document.getElementById('draftText').textContent,
  inMemory: state.frames.length,
}));

/* 4 ── the same frames again; the work must come back */
await page.setInputFiles('#filePicker', frames);
await ready();
const restored = await page.evaluate(() => {
  const f = state.frames[3];
  return {
    frames: state.frames.length,
    bbox: f.bbox,
    joints: [...f.joints.entries()].map(([n, j]) => `${n}:${j.x},${j.y},${j.visible}`).sort(),
    status3: f.status,
    status5: state.frames[5].status,
    annotator: document.getElementById('annotator').value,
    noteHidden: document.getElementById('draftNote').classList.contains('hidden'),
  };
});

const expected = Object.entries(JOINTS)
  .map(([n, p]) => `${n}:${p[0]},${p[1]},${n !== HIDDEN}`)
  .sort();
const fail = [];
const check = (ok, m) => {
  if (!ok) fail.push(m);
};

check(loaded === frames.length, `all ${frames.length} frames loaded, got ${loaded}`);
check(saved.key !== null, '⛔ a draft was written to localStorage');
check(
  /saved \d\d:\d\d:\d\d/.test(saved.status),
  `the header shows when it saved — got "${saved.status}"`,
);
check(!/data:image|base64|blob:/.test(saved.raw), '⛔ no image data is stored, only coordinates');
check(afterReload.inMemory === 0, 'the reloaded page really did start empty');
check(
  afterReload.offered !== null && /Unfinished work/.test(afterReload.offered || ''),
  `⛔ the draft is offered after the reload — got ${JSON.stringify(afterReload.offered)}`,
);
check(restored.frames === frames.length, `frames restored, got ${restored.frames}`);
check(
  JSON.stringify(restored.joints) === JSON.stringify(expected),
  `⛔ every joint came back exactly\n    want ${JSON.stringify(expected)}\n    got  ${JSON.stringify(restored.joints)}`,
);
check(
  JSON.stringify(restored.bbox) === JSON.stringify([0.3, 0.25, 0.28, 0.55]),
  `bbox restored, got ${restored.bbox}`,
);
check(restored.status3 === 'ANNOTATED', `frame 3 is ANNOTATED, got ${restored.status3}`);
check(restored.status5 === 'EMPTY', `⛔ the deliberate EMPTY survived, got ${restored.status5}`);
check(
  restored.annotator === 'verify-autosave.mjs',
  `annotator name restored, got ${restored.annotator}`,
);
check(restored.noteHidden, 'the banner is dismissed once the work is back');
check(errs.length === 0, `page errors: ${errs.join(' | ')}`);

await browser.close();
for (const f of fail) console.error('⛔ ' + f);
if (fail.length) process.exit(1);
console.log(
  `✓ autosave survives a real reload — ${expected.length} joints, bbox, the EMPTY status ` +
    'and the annotator name all restored from browser storage',
);

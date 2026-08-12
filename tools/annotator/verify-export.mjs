/**
 * Verify the annotator's EXPORT path against the real validator — P3.3c.
 *
 *   node tools/annotator/verify-export.mjs
 *
 * ⭐ **It runs the tool's own `buildDocument()` and `exportJson()`**, not a second implementation of
 * them. The script block is lifted out of the generated HTML and evaluated against a minimal DOM
 * stub, a small annotation is placed into its state by hand, and the document it produces is handed
 * to `real_footage_cli.py --validate-annotations`. A re-implementation here would agree with itself
 * and prove nothing.
 *
 * ⛔ The annotations below are INVENTED to exercise the path. They are not ground truth, they are
 * not derived from any model, and they are written to a temporary file that is never kept.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(HERE));

/* ── A DOM small enough to be obviously inert ─────────────────────────────────────────────────── */

/* ⚠️ `appendChild` really stores children and `textContent = ""` really clears them. A stub that
   no-ops both would let every assertion about what the banner *says* pass without the banner
   existing — the export UX regression tests below would then be decorative. */
const noop = () => undefined;
function element(tag = 'DIV') {
  const node = {
    value: '',
    innerHTML: '',
    className: '',
    width: 0,
    height: 0,
    clientWidth: 1200,
    clientHeight: 800,
    max: 1,
    style: {},
    tagName: String(tag).toUpperCase(),
    children: [],
    clicks: 0,
    download: '',
    href: '',
    classList: { add: noop, remove: noop, contains: () => false },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    addEventListener: noop,
    click() {
      node.clicks += 1;
    },
    focus: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    getContext: () => new Proxy({}, { get: () => noop }),
    querySelector: () => element(),
  };
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get: () => text,
    set: (v) => {
      text = String(v);
      node.children.length = 0;
    },
  });
  return node;
}

/** Everything a human would read off the node, headline and detail together. */
const rendered = (node) =>
  [node.textContent, ...node.children.map((c) => c.textContent)].filter(Boolean).join(' ');

const nodes = new Map();
const created = [];
let objectUrls = 0;

const sandbox = {
  console,
  document: {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
    createElement(tag) {
      const n = element(tag);
      created.push(n);
      return n;
    },
    addEventListener: noop,
  },
  /* A localStorage faithful enough to fail: it stores strings and hands back exactly those. */
  window: {
    addEventListener: noop,
    alert: noop,
    confirm: () => true,
    localStorage: (() => {
      const map = new Map();
      return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
        get size() {
          return map.size;
        },
      };
    })(),
  },
  Date,
  Image: class {
    set src(_v) {
      /* never loaded here */
    }
  },
  URL: {
    createObjectURL: () => {
      objectUrls += 1;
      return 'blob:stub';
    },
    revokeObjectURL: noop,
  },
  Blob: class {
    constructor(parts) {
      this.parts = parts;
    }
  },
  FileReader: class {
    readAsText() {
      /* unused */
    }
  },
  setTimeout: noop,
  Math,
  JSON,
  isFinite,
  Number,
  String,
  Array,
  Object,
  Map,
  parseInt,
};
sandbox.globalThis = sandbox;

/* ── Load the tool's own script ───────────────────────────────────────────────────────────────── */

const html = readFileSync(join(HERE, 'pose-annotator.html'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html);
if (script === null) throw new Error('⛔ no script block in pose-annotator.html');

const context = vm.createContext(sandbox);
/* ⚠️ The tool's constants and functions are declared with const/function at top level, which are
   NOT properties of globalThis. The trailing expression hands out exactly what this check needs. */
const LIFT =
  '({ state, buildDocument, exportJson, blankFrame, STATUS, COCO_17, EXPORT_FILENAME,' +
  '   saveDraft, readDraft, clearDraft, applyDocument, DRAFT_KEY, problems })';
vm.runInContext(script[1] + '\n;' + LIFT, context, { filename: 'pose-annotator.html' });
const api = vm.runInContext(LIFT, context);

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

/* ── A small, invented annotation ─────────────────────────────────────────────────────────────── */

const BODY = {
  nose: [0.44, 0.29],
  left_eye: [0.425, 0.282],
  right_eye: [0.455, 0.282],
  left_shoulder: [0.39, 0.35],
  right_shoulder: [0.49, 0.35],
  left_elbow: [0.365, 0.44],
  right_elbow: [0.515, 0.44],
  left_wrist: [0.355, 0.53],
  right_wrist: [0.525, 0.53],
  left_hip: [0.405, 0.545],
  right_hip: [0.475, 0.545],
  left_knee: [0.4, 0.68],
  right_knee: [0.48, 0.68],
};
const OCCLUDED = new Set(['right_elbow', 'right_wrist']);

/** A clean three-frame corpus: one annotated person, two frames stated to be empty. */
function loadCleanCorpus() {
  api.state.frames = [0, 1, 2].map((i) => api.blankFrame(i));
  api.state.frames[0].status = api.STATUS.EMPTY;
  api.state.frames[2].status = api.STATUS.EMPTY;
  const annotated = api.state.frames[1];
  annotated.status = api.STATUS.ANNOTATED;
  annotated.bbox = [0.3, 0.25, 0.28, 0.55];
  annotated.visibility = 'partially-occluded';
  for (const [name, [x, y]] of Object.entries(BODY)) {
    annotated.joints.set(name, { x, y, visible: !OCCLUDED.has(name) });
  }
  sandbox.document.getElementById('annotator').value = 'verify-export.mjs';
}

loadCleanCorpus();
const doc = api.buildDocument();

/* ── Assertions the schema requires ───────────────────────────────────────────────────────────── */

check(doc.caseId === 'movie101', 'caseId');
check(typeof doc.clipSha256 === 'string' && doc.clipSha256.length === 64, 'clipSha256 is a digest');
check(doc.annotatedFps === 1.928609, `annotatedFps is the measured rate, got ${doc.annotatedFps}`);
check(doc.frames.length === 3, 'every frame is emitted, including the empty ones');
check(
  doc.frames[0].boxes.length === 0 && doc.frames[0].reviewStatus === 'EMPTY',
  'an EMPTY frame is emitted with no boxes and its status recorded',
);
check(doc.frames[2].reviewStatus === 'EMPTY', 'the third frame kept its status');

const box = doc.frames[1].boxes[0];
check(box !== undefined && box.label === 'person' && box.gtId === 1, 'the box is person gtId 1');
check(box.skeleton === 'coco-17', 'the skeleton is named');
check(
  box.keypoints.length === Object.keys(BODY).length,
  `only placed joints are emitted (${box.keypoints.length})`,
);

/* ⛔ The distinction the whole occluded-wrist measurement depends on. */
const emitted = new Set(box.keypoints.map((k) => k.name));
check(
  !emitted.has('left_ankle') && !emitted.has('right_ankle'),
  'unplaced joints are OMITTED, not written as invisible',
);
check(
  box.keypoints.find((k) => k.name === 'right_wrist').visible === false,
  'a hidden joint is written with visible:false and its position kept',
);
check(
  box.keypoints.every((k) => !('confidence' in k)),
  'no confidence field is ever written',
);
check(
  box.keypoints.every((k) => k.x >= 0 && k.x <= 1 && k.y >= 0 && k.y <= 1),
  'coordinates are normalized',
);
/* ⚠️ Emitted in COCO order regardless of the order they were clicked in. */
const order = box.keypoints.map((k) => k.name);
const expected = api.COCO_17.filter((n) => emitted.has(n));
check(JSON.stringify(order) === JSON.stringify(expected), 'joints are emitted in COCO_17 order');

/* ── Export UX: every attempt must say what happened ──────────────────────────────────────────────
 *
 * ⛔ REGRESSION. The previous version returned silently when the confirm dialog was dismissed, so a
 * cancelled export was indistinguishable from a successful one and an hour of annotation was lost
 * believing it had been written. These three scenarios pin all three outcomes.
 */

const banner = () => sandbox.document.getElementById('exportStatus');

/** Run one export attempt in isolation and return { result, banner text, class, downloads }. */
function attemptExport({ confirms }) {
  created.length = 0;
  objectUrls = 0;
  banner().className = 'hidden';
  banner().textContent = '';
  let asked = null;
  sandbox.window.confirm = (message) => {
    asked = message;
    return confirms;
  };
  const result = api.exportJson();
  /* ⛔ A silent return yields no result at all — the original defect's exact signature. */
  const downloads = created.filter((n) => n.tagName === 'A' && n.clicks > 0);
  return { result, asked, text: rendered(banner()), css: banner().className, downloads };
}

/* 1 ── A clean corpus exports with no questions asked, and says so. */
loadCleanCorpus();
const ok = attemptExport({ confirms: true });
check(ok.result?.outcome === 'exported', `clean export outcome, got ${ok.result?.outcome}`);
check(
  ok.downloads.length === 1,
  `clean export triggers exactly one download, got ${ok.downloads.length}`,
);
check(ok.downloads[0]?.download === api.EXPORT_FILENAME, 'the download is named annotations.json');
check(ok.text.includes(api.EXPORT_FILENAME), `the banner names the output file — got "${ok.text}"`);
check(
  ok.css === 'exported' && !ok.css.includes('hidden'),
  `the banner is visible, class="${ok.css}"`,
);
check(ok.text.includes('3 frames'), 'the banner states what was written');

/* 2 ── ⛔ The cancelled export. Nothing written, and the page SAYS nothing was written. */
loadCleanCorpus();
api.state.frames.push(api.blankFrame(3)); /* an UNREVIEWED frame forces the confirm */
const cancelled = attemptExport({ confirms: false });
check(
  cancelled.result?.outcome === 'cancelled',
  `cancel outcome, got ${cancelled.result?.outcome}`,
);
check(
  cancelled.downloads.length === 0 && objectUrls === 0,
  '⛔ a cancelled export must not write anything',
);
check(
  /export cancelled/i.test(cancelled.text),
  `the banner says it was cancelled — got "${cancelled.text}"`,
);
check(cancelled.text.includes('nothing was written'), 'the banner says nothing was written');
check(
  /only in this browser tab/i.test(cancelled.text),
  'the banner warns the work is still unsaved',
);
check(
  cancelled.css === 'cancelled' && !cancelled.css.includes('hidden'),
  `the cancelled banner is visible, class="${cancelled.css}"`,
);

/* 3 ── A blocked export states WHY it was blocked, both in the dialog and in the banner. */
loadCleanCorpus();
api.state.frames.push(api.blankFrame(3));
const blocked = attemptExport({ confirms: true });
check(
  blocked.asked !== null && blocked.asked.includes('never reviewed'),
  'the dialog states the reason it is asking',
);
check(blocked.result?.outcome === 'exported', 'confirming a blocked export still exports');
check(
  /blocking problem/.test(blocked.text) || /warning/.test(blocked.text),
  `the banner restates why it asked — got "${blocked.text}"`,
);

/* 4 ── A throw is reported, never swallowed. */
loadCleanCorpus();
const brokenUrl = sandbox.URL.createObjectURL;
sandbox.URL.createObjectURL = () => {
  throw new Error('object URL refused');
};
const failed = attemptExport({ confirms: true });
sandbox.URL.createObjectURL = brokenUrl;
check(
  failed.result?.outcome === 'failed',
  `a throw reports failure, got ${failed.result?.outcome}`,
);
check(failed.text.includes('object URL refused'), 'the banner carries the actual error');
check(failed.text.includes('do not close it'), 'the banner tells them not to lose the work');

/* ── An unscorable person must be called out ──────────────────────────────────────────────────────
 *
 * ⛔ REGRESSION. 12 boxes were annotated with not one keypoint between them, exported, and passed
 * the validator — because the torso check only ran once at least one joint existed, so a box with
 * zero joints raised nothing. Pose accuracy was unmeasurable and nothing said so.
 */
loadCleanCorpus();
const boxOnly = api.state.frames[1];
boxOnly.joints = new Map(); /* a box was drawn, no joints were placed */
const jointless = api.problems('all').filter((p) => /NO joints/.test(p));
check(jointless.length === 1, `⛔ a box with no joints is reported — got ${jointless.length}`);
check(jointless[0]?.startsWith('⛔'), 'it is blocking, not advisory');

/* ⚠️ And it must NOT fire for the states that are legitimately jointless. */
loadCleanCorpus();
api.state.frames[1].joints = new Map();
api.state.frames[1].bbox = null;
check(
  api.problems('all').filter((p) => /NO joints/.test(p)).length === 0,
  'a frame with neither a box nor joints is not accused of missing joints',
);
loadCleanCorpus();
check(
  api.problems('all').filter((p) => /NO joints/.test(p)).length === 0,
  'a properly annotated person is not accused',
);

/* ── Autosave: the work must survive the tab ──────────────────────────────────────────────────────
 *
 * ⛔ REGRESSION. An hour of hand annotation was lost when the tab holding it was closed: nothing was
 * on disk and nothing was in storage. These pin the round trip — saved, read back, re-applied to a
 * fresh set of frames, joint for joint.
 *
 * ⚠️ A reload cannot be simulated here; `verify-autosave.mjs` does that in a real browser.
 */
loadCleanCorpus();
api.state.frames[1].joints.set('left_wrist', { x: 0.355, y: 0.53, visible: false });
const savedRecord = api.saveDraft();

check(savedRecord !== null, 'saveDraft wrote a record');
check(typeof savedRecord?.savedAt === 'string', 'the record is stamped with when it was saved');
check(api.DRAFT_KEY.includes('movie101'), `the key is bound to the case — ${api.DRAFT_KEY}`);
check(
  api.DRAFT_KEY.includes(doc.clipSha256.slice(0, 12)),
  '⛔ the key is bound to the clip digest, so another clip cannot restore over this one',
);

/* ⛔ Coordinates only. A draft carrying pixels would put consented footage into browser storage. */
const rawDraft = sandbox.window.localStorage.getItem(api.DRAFT_KEY);
check(
  !/data:image|base64|blob:/.test(rawDraft),
  '⛔ no image data is ever stored, only coordinates',
);

/* The tab "closes": every frame is thrown away and rebuilt empty, as a reload would. */
const before = JSON.stringify(api.buildDocument());
api.state.frames = [0, 1, 2].map((i) => api.blankFrame(i));
sandbox.document.getElementById('annotator').value = '';
check(
  api.buildDocument().frames.every((f) => f.boxes.length === 0),
  'the fresh state really is empty',
);

const record = api.readDraft();
check(record !== null, '⛔ the draft is still there after the state was destroyed');
const restored = api.applyDocument(record.doc);
check(restored.ok === true, `the draft re-applies cleanly: ${restored.error || 'ok'}`);
check(
  JSON.stringify(api.buildDocument()) === before,
  '⛔ the restored document is byte-identical to what was saved',
);

/* ⚠️ A draft for another clip must never be restored over these pixels. */
const foreign = api.applyDocument({ ...record.doc, clipSha256: 'f'.repeat(64) });
check(foreign.ok === false, '⛔ a draft from a different clip is refused');

api.clearDraft();
check(api.readDraft() === null, 'discarding a draft removes it');

for (const failure of failures) console.error(`⛔ ${failure}`);
if (failures.length) process.exit(1);
console.log(
  `✓ export shape: ${doc.frames.length} frames, ${box.keypoints.length} joints, ` +
    `${box.keypoints.filter((k) => !k.visible).length} occluded, 0 confidence fields`,
);
console.log(
  '✓ export UX: exported / cancelled / blocked-then-confirmed / failed all report visibly',
);
console.log('✓ autosave: saved, survived the state being destroyed, restored byte-identical');

/* ── The real validator, on the real output ───────────────────────────────────────────────────── */

const dir = mkdtempSync(join(tmpdir(), 'vip-annotator-'));
const path = join(dir, 'annotations.json');
writeFileSync(path, JSON.stringify(doc, null, 1));

const out = execFileSync(
  'python3',
  [
    'real_footage_cli.py',
    '--validate-annotations',
    path,
    '--case',
    'movie101',
    '--real-root',
    join(REPO, '.data', 'real'),
  ],
  { cwd: join(REPO, 'ai', 'inference'), encoding: 'utf8' },
);
process.stdout.write(out);
if (!out.includes('PASS')) {
  console.error('⛔ the validator did not accept the export');
  process.exit(1);
}
console.log("✓ the annotator's own export is accepted by real_footage_cli --validate-annotations");

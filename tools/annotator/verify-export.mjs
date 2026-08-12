/**
 * Verify the annotator's EXPORT path against the real validator — P3.3c.
 *
 *   node tools/annotator/verify-export.mjs
 *
 * ⭐ **It runs the tool's own `buildDocument()`**, not a second implementation of it. The script
 * block is lifted out of the generated HTML and evaluated against a minimal DOM stub, a small
 * annotation is placed into its state by hand, and the document it produces is handed to
 * `real_footage_cli.py --validate-annotations`. A re-implementation here would agree with itself
 * and prove nothing.
 *
 * ⛔ The annotation below is INVENTED to exercise the path. It is not ground truth, it is not
 * derived from any model, and it is written to a temporary file that is never kept.
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

const noop = () => undefined;
function element() {
  const node = {
    value: '', textContent: '', innerHTML: '', className: '', width: 0, height: 0,
    clientWidth: 1200, clientHeight: 800, max: 1, style: {}, tagName: 'DIV',
    classList: { add: noop, remove: noop, contains: () => false },
    appendChild: noop, addEventListener: noop, click: noop, focus: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    getContext: () => new Proxy({}, { get: () => noop }),
    querySelector: () => element(),
  };
  return node;
}

const nodes = new Map();
const sandbox = {
  console,
  document: {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
    createElement: () => element(),
    addEventListener: noop,
  },
  window: { addEventListener: noop, alert: noop, confirm: () => true },
  Image: class { set src(_v) { /* never loaded here */ } },
  URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: noop },
  Blob: class { constructor(parts) { this.parts = parts; } },
  FileReader: class { readAsText() { /* unused */ } },
  setTimeout, Math, JSON, isFinite, Number, String, Array, Object, Map, parseInt,
};
sandbox.globalThis = sandbox;

/* ── Load the tool's own script ───────────────────────────────────────────────────────────────── */

const html = readFileSync(join(HERE, 'pose-annotator.html'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html);
if (script === null) throw new Error('⛔ no script block in pose-annotator.html');

const context = vm.createContext(sandbox);
/* ⚠️ The tool's constants and functions are declared with const/function at top level, which are
   NOT properties of globalThis. The trailing expression hands out exactly what this check needs. */
vm.runInContext(script[1] + '\n;({ state, buildDocument, blankFrame, STATUS, COCO_17 });', context,
  { filename: 'pose-annotator.html' });
const api = vm.runInContext('({ state, buildDocument, blankFrame, STATUS, COCO_17 })', context);

/* ── A small, invented annotation ─────────────────────────────────────────────────────────────── */

const BODY = {
  nose: [0.44, 0.29], left_eye: [0.425, 0.282], right_eye: [0.455, 0.282],
  left_shoulder: [0.39, 0.35], right_shoulder: [0.49, 0.35],
  left_elbow: [0.365, 0.44], right_elbow: [0.515, 0.44],
  left_wrist: [0.355, 0.53], right_wrist: [0.525, 0.53],
  left_hip: [0.405, 0.545], right_hip: [0.475, 0.545],
  left_knee: [0.4, 0.68], right_knee: [0.48, 0.68],
};
const OCCLUDED = new Set(['right_elbow', 'right_wrist']);

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

const doc = api.buildDocument();

/* ── Assertions the schema requires ───────────────────────────────────────────────────────────── */

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(doc.caseId === 'movie101', 'caseId');
check(typeof doc.clipSha256 === 'string' && doc.clipSha256.length === 64, 'clipSha256 is a digest');
check(doc.annotatedFps === 1.928609, `annotatedFps is the measured rate, got ${doc.annotatedFps}`);
check(doc.frames.length === 3, 'every frame is emitted, including the empty ones');
check(doc.frames[0].boxes.length === 0 && doc.frames[0].reviewStatus === 'EMPTY',
  'an EMPTY frame is emitted with no boxes and its status recorded');
check(doc.frames[2].reviewStatus === 'EMPTY', 'the third frame kept its status');

const box = doc.frames[1].boxes[0];
check(box !== undefined && box.label === 'person' && box.gtId === 1, 'the box is person gtId 1');
check(box.skeleton === 'coco-17', 'the skeleton is named');
check(box.keypoints.length === Object.keys(BODY).length,
  `only placed joints are emitted (${box.keypoints.length})`);

/* ⛔ The distinction the whole occluded-wrist measurement depends on. */
const emitted = new Set(box.keypoints.map((k) => k.name));
check(!emitted.has('left_ankle') && !emitted.has('right_ankle'),
  'unplaced joints are OMITTED, not written as invisible');
check(box.keypoints.find((k) => k.name === 'right_wrist').visible === false,
  'a hidden joint is written with visible:false and its position kept');
check(box.keypoints.every((k) => !('confidence' in k)), 'no confidence field is ever written');
check(box.keypoints.every((k) => k.x >= 0 && k.x <= 1 && k.y >= 0 && k.y <= 1),
  'coordinates are normalized');
/* ⚠️ Emitted in COCO order regardless of the order they were clicked in. */
const order = box.keypoints.map((k) => k.name);
const expected = api.COCO_17.filter((n) => emitted.has(n));
check(JSON.stringify(order) === JSON.stringify(expected), 'joints are emitted in COCO_17 order');

for (const failure of failures) console.error(`⛔ ${failure}`);
if (failures.length) process.exit(1);
console.log(`✓ export shape: ${doc.frames.length} frames, ${box.keypoints.length} joints, ` +
  `${box.keypoints.filter((k) => !k.visible).length} occluded, 0 confidence fields`);

/* ── The real validator, on the real output ───────────────────────────────────────────────────── */

const dir = mkdtempSync(join(tmpdir(), 'vip-annotator-'));
const path = join(dir, 'annotations.json');
writeFileSync(path, JSON.stringify(doc, null, 1));

const out = execFileSync('python3', [
  'real_footage_cli.py', '--validate-annotations', path,
  '--case', 'movie101', '--real-root', join(REPO, '.data', 'real'),
], { cwd: join(REPO, 'ai', 'inference'), encoding: 'utf8' });
process.stdout.write(out);
if (!out.includes('PASS')) { console.error('⛔ the validator did not accept the export'); process.exit(1); }
console.log('✓ the annotator\'s own export is accepted by real_footage_cli --validate-annotations');

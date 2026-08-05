/**
 * Gate: **nothing outside the AI runtime may know how a model works** (P-8 Phase 3H).
 *
 *   node tools/contracts/perception-boundary.mjs        # part of `pnpm verify:contracts`
 *
 * ADR-0002 says the platform is model-agnostic. That has always been a claim about code shape,
 * checked by review. This makes it a build failure.
 *
 * ### ⚠️ Why this is not a grep for "yolox"
 *
 * The first version was, and it found four hits, all of them correct code: a test fixture *value*
 * (`model: { id: 'yolox-nano' }` — asserting the id passes through opaquely, which is the behaviour
 * we want), two comment examples in the contract, and `video-player-container.tsx` using
 * "letterboxes" about **video display**. A gate that fires on all of those is one everybody learns
 * to skip.
 *
 * So comments and string literals are stripped first, and only **identifiers** are scanned. A string
 * is data passing through; a comment is prose; an identifier is coupling. That distinction is the
 * whole check.
 *
 * ### The four boundaries
 *
 * - **§A one seam** — exactly one file may call the runtime's `/infer`.
 * - **§B one consumer** — only media may know where the runtime lives.
 * - **§C no model vocabulary** — in code, outside `ai/`.
 * - **§D no field invention** — every field a consumer reads off a detection result must exist in
 *   the frozen `Detection` / `DetectionResult` schemas.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** Every TypeScript source outside the AI runtime, tests included. */
function sources() {
  const roots = [join(ROOT, 'services'), join(ROOT, 'apps'), join(ROOT, 'packages')];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(path)) out.push(path);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

/**
 * Remove comments and string/template literals, leaving identifiers and syntax.
 *
 * ⚠️ Crude on purpose — this is a boundary gate, not a parser. It over-removes in exotic cases
 * (a regex literal containing a quote), and over-removal can only make the gate *miss*, never make
 * it fire wrongly. A gate that occasionally under-reports is survivable; one that cries wolf is not.
 */
function stripLiterals(source) {
  return stripComments(source)
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/**
 * Comments only, keeping string literals.
 *
 * ⚠️ §A needs this and §C does not, because they forbid different things. §C forbids model
 * *vocabulary*, which only matters as an identifier — so it strips literals too. §A forbids *calling
 * the runtime*, and the call itself lives in a template literal (`${url}/infer`), so stripping
 * literals would blind the check to the one thing it exists to find.
 *
 * ⚠️ Found by the Event Publisher: its header explains that media receives the result from `/infer`,
 * and §A read that sentence as a second caller. That is the same false positive this file's header
 * describes for §C — a comment is prose — and the fix is the same. A gate that fires on correct
 * prose is one people learn to skip.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const files = sources();
console.log(`\nperception boundary · ${files.length} TypeScript source(s) outside ai/\n`);

/* ── §A one seam ─────────────────────────────────────────────────────────────────────────────── */
{
  const callers = files.filter((f) =>
    /['"`]\/infer['"`]|\/infer`/.test(stripComments(readFileSync(f, 'utf8'))),
  );
  const relative_ = callers.map((f) => relative(ROOT, f));
  check(
    callers.length === 1 && relative_[0] === 'services/media/src/adapters/http-frame-sink.ts',
    '§A the runtime is called from exactly one place',
    relative_.join(', ') || 'nowhere',
  );
}

/* ── §B one consumer ─────────────────────────────────────────────────────────────────────────── */
{
  // Literals stripped here too: an operator-facing sentence that *names* the variable is prose, and
  // the thing worth forbidding is a second process that *reads* it.
  const knowers = files
    .filter((f) => /\bINFERENCE_URL\b/.test(stripLiterals(readFileSync(f, 'utf8'))))
    .map((f) => relative(ROOT, f));
  const outsideMedia = knowers.filter((f) => !f.startsWith('services/media/'));
  check(
    outsideMedia.length === 0,
    '§B only media knows where the runtime lives',
    knowers.join(', ') || 'nobody',
  );
}

/* ── §C no model vocabulary in code ──────────────────────────────────────────────────────────── */
{
  /**
   * Terms that name **how a model works**. Each one, appearing as an identifier outside `ai/`, means
   * a consumer has learned something it is not allowed to depend on.
   */
  const FORBIDDEN = [
    'yolox', 'yolov', 'rtdetr', 'groundingdino', // families
    'letterbox', 'nms', 'nonmaxsuppression', 'anchors', 'anchorgrid', // decoding
    'nchw', 'nhwc', 'tensorshape', 'inputtensor', 'outputtensor', // tensors
    'onnxruntime', 'executionproviders', 'intraop', 'interop', // engine internals
  ];
  /*
   * ⚠️ Matched against the **word components of each identifier**, not with `\b…\b` on the source.
   *
   * The word-boundary version was the first attempt and it missed the obvious case: in
   * `nmsIouThreshold` the character after `nms` is `I`, which is a word character, so `\bnms\b` never
   * matches. A gate that passes `const nmsIouThreshold = 0.45` in the gateway is not a gate. It was
   * caught by planting exactly that line and watching the check stay green.
   *
   * Splitting on camelCase and `_` catches `nmsIouThreshold`, `applyNms` and `NMS_THRESHOLD`, while
   * leaving innocent words alone — `transmission` is one component and is not `nms`. The whole
   * identifier is added too, so a run-together `nonMaxSuppression` still matches.
   */
  const componentsOf = (code) => {
    const words = new Set();
    for (const id of code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
      words.add(id.toLowerCase());
      for (const part of id.split(/[_$]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
        if (part) words.add(part.toLowerCase());
      }
    }
    return words;
  };

  const hits = [];
  for (const file of files) {
    const words = componentsOf(stripLiterals(readFileSync(file, 'utf8')));
    for (const term of FORBIDDEN) {
      if (words.has(term)) hits.push(`${relative(ROOT, file)}:${term}`);
    }
  }
  check(
    hits.length === 0,
    '§C no service, app or package names a model implementation concept in code',
    hits.join(', ') || 'clean',
  );
}

/* ── §D no field invention ───────────────────────────────────────────────────────────────────── */
{
  const { Detection, DetectionResult, ModelBinding } = await import(
    join(ROOT, 'packages/contracts/dist/index.js')
  );
  const known = new Set([
    ...Object.keys(DetectionResult.shape),
    ...Object.keys(Detection.shape),
    ...Object.keys(ModelBinding.shape),
  ]);

  /*
   * The one place a detection result is parsed. Its response type literal IS the list of fields the
   * platform reads off the runtime, so it is compared against the frozen schema directly — a field
   * that exists here and not there is a consumer depending on something no contract promises.
   */
  const seam = join(ROOT, 'services/media/src/adapters/http-frame-sink.ts');
  const source = readFileSync(seam, 'utf8');
  const block = source.slice(source.indexOf('const result = data as {'));
  const literal = block.slice(0, block.indexOf('};') + 1);
  const read = [...literal.matchAll(/^\s{6}(\w+)\??:/gm)].map((m) => m[1]);
  const unknown = read.filter((field) => !known.has(field));

  check(read.length > 0, '§D the detection-result parse was found and has fields', `${read.length} field(s)`);
  check(
    unknown.length === 0,
    '§D every field read off a detection result exists in the frozen contract',
    unknown.length ? `not in the schema: ${unknown.join(', ')}` : read.join(', '),
  );
}

/*
 * ### §E the two languages agree on what a document IS
 *
 * ⚠️ Schema versions are declared twice — once in `packages/contracts` and once in the Python
 * runtime that produces the payloads — because the runtime is stdlib-only and cannot import the
 * TypeScript. Two constants with one meaning drift, and this one drifts SILENTLY: a runtime stamping
 * `1.0` on a document that is really `1.1` produces a consumer that reads the wrong fields and
 * reports no error at all. Nothing else in the build compares them, so this does.
 */
{
  const mirrors = [
    {
      what: 'Track',
      ts: ['packages/contracts/src/tracking/tracking.ts', /TRACK_SCHEMA_VERSION = '([^']+)'/],
      py: ['ai/inference/tracking_contracts.py', /^TRACK_SCHEMA_VERSION = "([^"]+)"/m],
    },
    {
      what: 'TrackingStats',
      ts: [
        'packages/contracts/src/tracking/tracking.ts',
        /TRACKING_STATS_SCHEMA_VERSION = '([^']+)'/,
      ],
      py: ['ai/inference/runtime_tracking.py', /^TRACKING_STATS_SCHEMA_VERSION = "([^"]+)"/m],
    },
  ];

  for (const { what, ts, py } of mirrors) {
    const read = ([file, pattern]) => {
      const found = readFileSync(join(ROOT, file), 'utf8').match(pattern);
      return found ? found[1] : null;
    };
    const left = read(ts);
    const right = read(py);
    check(
      left !== null && right !== null && left === right,
      `§E ${what} schema version agrees across TypeScript and Python`,
      left === right ? left : `contracts=${left ?? 'not found'} runtime=${right ?? 'not found'}`,
    );
  }
}

console.log(
  failures === 0
    ? '\nperception boundary: OK — the runtime is the only thing that knows how a model works.\n'
    : `\nperception boundary: ${failures} violation(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);

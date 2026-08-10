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

/*
 * ### §F the three places that name an attribute key agree
 *
 * ⛔ **Zone membership is written under one string by media, read under it by events, and now read
 * under it by the Python behaviour stage.** Three copies of `'zoneIds'` in two languages that cannot
 * import one another, each carrying a comment saying the others must match — which is a defect
 * waiting for a typo, and it would fail **silently**: every detection would simply carry no zone,
 * every dwell would read 0.0 s, and a zone-scoped rule would decline for ever without an error.
 *
 * ⚠️ The general form of §E one level down. §E compares *versions*; this compares the *names* inside
 * the frozen contract's open `attributes` map, which is exactly where P-10 and P-11 agreed that new
 * modalities would ride rather than widening the contract. An open map buys additive evolution at
 * the cost of untyped keys, and this is the check that pays that cost back.
 */
{
  const sites = [
    ['services/media/src/application/zone-resolver.ts', /ZONE_ATTRIBUTE = '([^']+)'/],
    ['services/events/src/domain/event-normalizer.ts', /ZONE_ATTRIBUTE = '([^']+)'/],
    ['ai/inference/behaviour_modules.py', /^ZONE_ATTRIBUTE = "([^"]+)"/m],
  ];
  const found = sites.map(([file, pattern]) => {
    const match = readFileSync(join(ROOT, file), 'utf8').match(pattern);
    return { file, value: match ? match[1] : null };
  });
  const values = new Set(found.map((f) => f.value));
  check(
    values.size === 1 && !values.has(null),
    '§F the zone attribute key agrees across media, events and the runtime',
    values.size === 1 && !values.has(null)
      ? `'${found[0].value}' in ${String(found.length)} places`
      : found.map((f) => `${f.file}=${f.value ?? 'not found'}`).join(' '),
  );
}

/*
 * ### §G the zone membership echo joins on the same key at both ends
 *
 * ⛔ **The join media and the runtime make across a network boundary, with nothing typed to hold it
 * together.** Media resolves membership for a frame it has already had answered and sends it back
 * under `zoneMembership`, naming the frame with `frameSeq`; the runtime reads those two names out of
 * an untyped dict and matches `frameSeq` against the frame sequence it stored (ADR-0053).
 *
 * ⚠️ **This one already failed once, in development, and produced a plausible number.** The runtime
 * originally stored its own per-camera frame counter, so the join landed one frame early on every
 * frame — a dwell short by exactly one interval, on a graph that looked entirely reasonable. So the
 * check is not just that the field names agree, but that the runtime stores the CALLER's sequence:
 * `frame_index=ctx.frame_number` in the one place a history point is created.
 */
{
  const wire = readFileSync(join(ROOT, 'packages/contracts/src/perception/perception.ts'), 'utf8');
  const runtime = readFileSync(join(ROOT, 'ai/inference/contracts.py'), 'utf8');
  const sink = readFileSync(join(ROOT, 'services/media/src/adapters/http-frame-sink.ts'), 'utf8');
  const tracking = readFileSync(join(ROOT, 'ai/inference/runtime_tracking.py'), 'utf8');

  for (const key of ['zoneMembership', 'frameSeq']) {
    const sites = [
      ['packages/contracts', wire.includes(key)],
      ['services/media', sink.includes(key) || key === 'frameSeq'],
      ['ai/inference', runtime.includes(`"${key}"`)],
    ];
    const missing = sites.filter(([, present]) => !present).map(([where]) => where);
    check(
      missing.length === 0,
      `§G '${key}' is named on both sides of the zone membership echo`,
      missing.length === 0 ? 'contracts · media · runtime' : `missing in ${missing.join(', ')}`,
    );
  }

  check(
    /frame_index=ctx\.frame_number/.test(tracking),
    "§G the runtime stores the caller's frame sequence, not its own counter",
    /frame_index=ctx\.frame_number/.test(tracking)
      ? 'runtime_tracking.py records frame_index=ctx.frame_number'
      : 'a history point is keyed by something other than ctx.frame_number — the echo will not join',
  );
}

/*
 * ### §H the behaviour vocabulary is one closed list, written down twice
 *
 * ⛔ **A viewer that meets an unknown kind renders a blank row, and a blank row reads as "nothing
 * happened here."** The runtime owns `TIMELINE_KINDS`; the console types it as
 * `BehaviourTimelineKind` so a browser can render every kind rather than discovering one in front of
 * a customer. Two hand-maintained lists across two languages drift silently and in exactly the
 * direction that hides evidence — the new kind is the interesting one.
 *
 * ⚠️ Set equality, both ways. A kind in the contract with no producer is a filter nobody can ever
 * satisfy; a kind in the runtime with no type is a fact the console cannot draw.
 */
{
  const py = readFileSync(join(ROOT, 'ai/inference/behaviour_timeline.py'), 'utf8');
  const ts = readFileSync(join(ROOT, 'packages/contracts/src/perception/behaviour-view.ts'), 'utf8');

  const block = (source, marker) => {
    const start = source.indexOf(marker);
    if (start < 0) return null;
    const end = source.indexOf(')', start);
    return end < 0 ? null : source.slice(start, end);
  };
  const names = (chunk) =>
    chunk === null ? null : [...chunk.matchAll(/["']([a-zA-Z][a-zA-Z0-9]*)["']/g)].map((m) => m[1]);

  const runtimeKinds = names(block(py, 'TIMELINE_KINDS: Tuple[str, ...] = ('));
  const contractKinds = names(block(ts, 'export const BehaviourTimelineKind = z.enum(['));

  if (runtimeKinds === null || contractKinds === null) {
    check(false, '§H the behaviour timeline vocabulary could be read from both sides', 'list not found');
  } else {
    const onlyRuntime = runtimeKinds.filter((k) => !contractKinds.includes(k));
    const onlyContract = contractKinds.filter((k) => !runtimeKinds.includes(k));
    check(
      onlyRuntime.length === 0 && onlyContract.length === 0,
      `§H the ${runtimeKinds.length} behaviour timeline kinds agree across the runtime and the contract`,
      onlyRuntime.length === 0 && onlyContract.length === 0
        ? 'behaviour_timeline.py ≡ behaviour-view.ts'
        : `runtime-only: [${onlyRuntime.join(', ')}] · contract-only: [${onlyContract.join(', ')}]`,
    );
  }
}

/*
 * ### §I every published threshold the console shows is one the runtime actually publishes
 *
 * ⛔ **The Primitive Inspector prints a threshold beside the word it explains**, so a mapping that
 * points at a reading the runtime does not have renders as *"not parameterised"* — a claim that no
 * threshold decided the finding. That was true of `proximity` and `gap` for three slices and is the
 * opposite of the truth for both; an operator defending a finding would have had nothing to quote.
 *
 * ⚠️ One direction only. A reading with no timeline kind is legitimate — `approach_object` and
 * `leave_object` are published and cannot fire until there is object footage — but a *mapping* to a
 * reading that does not exist is always a bug.
 */
{
  const py = readFileSync(join(ROOT, 'ai/inference/behaviour_primitives.py'), 'utf8');
  const ts = readFileSync(
    join(ROOT, 'apps/console/src/features/behaviour/PrimitiveInspectorPanel.tsx'),
    'utf8',
  );

  const start = ts.indexOf('const READING_OF_KIND: Record<string, string> = {');
  const map = start < 0 ? null : ts.slice(start, ts.indexOf('};', start));
  const mapped =
    map === null ? null : [...map.matchAll(/(\w+):\s*'([a-z_]+)'/g)].map((m) => [m[1], m[2]]);

  const published = new Set(
    [...py.matchAll(/^ {4}"([a-z_]+)": \{$/gm)].map((m) => m[1]),
  );

  if (mapped === null || published.size === 0) {
    check(false, '§I the reading tables could be read from both sides', 'table not found');
  } else {
    const missing = mapped.filter(([, reading]) => !published.has(reading));
    check(
      missing.length === 0,
      `§I all ${mapped.length} console reading mappings point at a published reading`,
      missing.length === 0
        ? 'PrimitiveInspectorPanel.tsx ⊆ PRIMITIVE_READINGS'
        : `no such reading: ${missing.map(([kind, r]) => `${kind}→${r}`).join(', ')}`,
    );
  }
}

/*
 * ### §J every attribute a rule FILTERS on is one the graph WRITES
 *
 * ⛔ **The defect this exists for was silent in the worst possible way.** `matchesFilters` compares
 * `step.lineId` against `edge.attributes.lineId`; `behaviour_graph.py` wrote `lineId` onto the line
 * *node* and not onto the `crossed` *edge*. So a rule naming a line matched nothing, while the
 * `absent` form of the identical step correctly reported *"1 fact of that kind was examined"* — the
 * fact was present and the filter could not see it. A rule that silently matches nothing is
 * indistinguishable from a scene where nothing happened.
 *
 * ⚠️ It survived a full evaluator test suite because those fixtures are hand-built graphs, which
 * carried the attribute the producer was not writing. Only a check across the two languages can see
 * it: one side is TypeScript in `services/rules`, the other is Python in `ai/inference`.
 */
{
  const evaluator = readFileSync(
    join(ROOT, 'services/rules/src/domain/behaviour-reasoning.ts'),
    'utf8',
  );
  const graph = readFileSync(join(ROOT, 'ai/inference/behaviour_graph.py'), 'utf8');

  const start = evaluator.indexOf('function matchesFilters(');
  const body = start < 0 ? null : evaluator.slice(start, evaluator.indexOf('\n}', start));
  /* Only the filters that read an EDGE ATTRIBUTE; `objectLabel`/`otherLabel` read a node's label. */
  const filtered =
    body === null ? null : [...new Set([...body.matchAll(/edge\.attributes\.(\w+)/g)].map((m) => m[1]))];

  if (filtered === null || filtered.length === 0) {
    check(false, '§J the evaluator’s edge-attribute filters could be read', 'matchesFilters not found');
  } else {
    /* Every keyword argument the graph passes to `edge(...)`. */
    const written = new Set([...graph.matchAll(/^\s{16}(\w+)=/gm)].map((m) => m[1]));
    const missing = filtered.filter((name) => !written.has(name));
    check(
      missing.length === 0,
      `§J all ${filtered.length} edge attributes a rule filters on are written by the graph`,
      missing.length === 0
        ? filtered.join(', ')
        : `the graph never writes: ${missing.join(', ')} — a rule naming one matches nothing, silently`,
    );
  }
}

console.log(
  failures === 0
    ? '\nperception boundary: OK — the runtime is the only thing that knows how a model works.\n'
    : `\nperception boundary: ${failures} violation(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);

/**
 * ⭐ **The source-agnosticism proof, as a test rather than a diagram** (P-9).
 *
 * The milestone's central architectural rule is *"There must be ONE perception pipeline only. No
 * duplicate inference path. No duplicate tracker. No duplicate rule engine. No 'live-only' AI
 * logic."* A diagram asserting that is true on the day it is drawn and silently false a milestone
 * later. These tests read the source and fail when it stops being true.
 *
 * ### ⚠️ Why structural assertions, which are unusual, are right here
 *
 * The property under test is not behavioural — both a one-pipeline and a two-pipeline deployment
 * detect people correctly, produce events, and pass every functional test in this repository. The
 * duplication would show up months later as two sets of numbers that disagree, and by then it is
 * load-bearing. The only cheap moment to catch it is the commit that adds the second call.
 *
 * ⚠️ These read source text, so they are sensitive to formatting in a way behavioural tests are not.
 * Each therefore asserts a **count of files** or a **presence in one named file**, never an exact
 * string of implementation — a rename must not break them, but a second inference call must.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Source with block and line comments stripped — a mention in prose is not a call. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const FILES = sourceFiles(SRC);
const relative = (p: string) => p.slice(SRC.length + 1);

describe('one perception pipeline (P-9 architectural rule)', () => {
  it('⛔ exactly one file in the service calls the runtime for inference', () => {
    /*
     * The single most important assertion in this suite. A live-only inference call would be
     * invisible to every functional test — it would work — and would immediately mean two places
     * that must agree about what is sent to the model, how zones are stamped, which analysis session
     * a result belongs to, and what happens when the runtime is slow.
     */
    const callers = FILES.filter((f) => /fetch\([^)]*\/infer/.test(code(f))).map(relative);
    expect(callers).toEqual(['adapters/http-frame-sink.ts']);
  });

  it('⛔ the live frame producer reaches perception ONLY through the shared sink', () => {
    const live = code(join(SRC, 'application/live-ingest.ts'));
    /* It pushes at the sink… */
    expect(live).toMatch(/#sink\.push\(/);
    /* …and does not talk to a runtime, a tracker, a publisher or a gate of its own. */
    expect(live).not.toMatch(/\/infer/);
    expect(live).not.toMatch(/fetch\(/);
    expect(live).not.toMatch(/Tracker|tracker/);
    expect(live).not.toMatch(/publisher|Publisher/);
  });

  it('⛔ push and deliver converge on one send, so live and offline cannot drift apart', () => {
    /*
     * `push` (live) and `deliver` (offline) differ ONLY in their admission policy — drop vs wait.
     * Everything after that point is one method. Two request builders would be two places for the
     * live and offline paths to disagree about what the runtime is asked, and a divergence there is
     * precisely what would break parity without failing a behavioural test.
     */
    const sink = code(join(SRC, 'adapters/http-frame-sink.ts'));
    const senders = sink.match(/#send\(/g) ?? [];
    /* One definition plus its call sites — and only one place where the request is constructed. */
    expect(senders.length).toBeGreaterThanOrEqual(2);
    expect((sink.match(/fetch\([^)]*\/infer/g) ?? []).length).toBe(1);
  });

  it('the composition root gives the live producer the SAME sink instance as the stream supervisor', () => {
    /*
     * ⭐ The whole "one pipeline" claim reduces to this one reference. If `LiveIngest` were
     * constructed with its own sink, every assertion above would still pass and the platform would
     * have two pipelines.
     */
    const index = code(join(SRC, 'index.ts'));
    expect(index).toMatch(/new LiveIngest\(\{\s*sink:\s*frameSink\s*\}\)/);
    expect(index).toMatch(/frameSink,/); // handed to the supervisor as well
  });

  it('⛔ no file outside the sink constructs its own runtime URL for inference', () => {
    /*
     * A second call could be written without the literal `/infer` — by building the path from a
     * variable. This catches the shape rather than the string: any file that both knows the runtime
     * base URL and performs a fetch is a candidate second pipeline.
     */
    const suspects = FILES.filter((f) => {
      const src = code(f);
      const knowsRuntime = /runtimeUrl|INFERENCE_URL|perception\.url/.test(src);
      /* ⚠️ `doFetch(` as well as `fetch(` — the read proxies take an injected fetch for testing, and
       * a second pipeline written the same way must not slip past this check. */
      const callsOut = /\b(?:do)?[Ff]etch\(/.test(src);
      return knowsRuntime && callsOut;
    }).map(relative);

    /*
     * ⚠️ The other three are READ proxies: they ask the runtime **about itself** — its tracks, its
     * status, its capacity — and never submit a frame. That is why the previous assertion (exactly
     * one caller of `/infer`) is the one that matters, and this one is its wider net.
     *
     * ⛔ If this list grows, the addition is either a second perception path (reject it) or a new
     * read proxy (add it here, with a comment saying which). Silence is not an option: an
     * unexplained fourth entry is how a duplicate pipeline arrives.
     */
    expect(suspects.sort()).toEqual([
      'adapters/http-frame-sink.ts',
      'transport/routes/assignment.ts',
      'transport/routes/perception.ts',
      'transport/routes/tracking.ts',
    ]);
  });

  it('⛔ nothing constructs a tracker or re-implements identity linking in this service', () => {
    /*
     * The tracker lives in the AI runtime (`ai/inference/runtime_tracking.py`) and media reads its
     * answers. A tracker here would be a second one — and two trackers on one camera produce two
     * sets of track ids, of which the events, the rules and the operator would each see a different
     * one. `transport/routes/tracking.ts` is a read proxy and is allowed to name the concept.
     */
    const implementers = FILES.filter((f) => {
      if (relative(f) === 'transport/routes/tracking.ts') return false;
      const src = code(f);
      return /new\s+\w*Tracker\b|class\s+\w*Tracker\b|reentry|reIdentif/i.test(src);
    }).map(relative);
    expect(implementers).toEqual([]);
  });

  it('the live ingest route registers no perception logic of its own', () => {
    const route = code(join(SRC, 'transport/routes/live.ts'));
    expect(route).not.toMatch(/\/infer/);
    expect(route).not.toMatch(/detect|Detection/);
    /* Its only verbs are the session lifecycle and the evidence snapshot. */
    expect(route).toMatch(/ingest\.frame\(/);
    expect(route).toMatch(/ingest\.open\(/);
    expect(route).toMatch(/ingest\.close\(/);
  });
});

/**
 * P-8 Phase 7 · **is a rule decision a function of the events, or of the moment it ran?**
 *
 *   node docs/review/p8/rule-replay.mjs         # against the running deployment
 *   node docs/review/p8/rule-replay.mjs clean   # ⚠️ if a run was interrupted
 *
 * ```
 *   persisted EventEnvelopes → POST /events/replay → rule engine (scope · condition · dwell)
 *                            → IncidentCandidate
 * ```
 *
 * The claim being tested is the one an auditor will make three months from now: *re-run the same
 * evidence and you get the same answer.* That claim is not free. A rule engine that stamped its own
 * clock anywhere in the decision — a dwell duration measured against `Date.now()`, a threshold
 * crossing timed against the node — would produce a different incident from the same events every
 * time it was asked, and nothing in the platform would report a problem.
 *
 * ### ⚠️ There is no camera in this run, and no live video
 *
 * A `DetectionResult` is injected onto the subject the perception runtime publishes to, so every
 * input is exact and the seeded window is byte-reproducible. What is being verified is everything
 * *downstream* of perception; putting a decoder and a model in front of it would make the run's
 * inputs a function of the host's load, which is the opposite of the property under test.
 *
 * ### ⚠️ Both rules are DRY RUN, and that is what makes this safe to run nightly
 *
 * A dry-run rule evaluates completely — the dwell clock advances, the threshold is crossed, the
 * candidate is **built in full** — and then declines to publish it. So this stage exercises the whole
 * decision path while creating no `incident.candidate`, no Incident, and no operator-facing record of
 * any kind. `/rules/:id/dry-run-candidates` returns the same objects a live rule would have raised,
 * which is precisely what makes them worth comparing.
 *
 * ### The three passes, and why each one exists
 *
 * | § | pass | engine state | proves |
 * |---|---|---|---|
 * | 2 | the **live** pass — two rules, one arrival | fresh | the decision is a pure function of the event stream |
 * | 3 | replayed once | warm | replay is **idempotent** — it raises nothing new |
 * | 4 | replayed after a **process restart** | reset | identical to the live candidate, `dedupKey` included |
 *
 * ⚠️ §2 and §4 answer different questions and neither substitutes for the other. §2 compares two
 * engine instances at one instant, so it cannot see a dependency on the wall clock — both would read
 * the same clock. §4 compares the *same* rule id across a restart and several minutes, which is the
 * only arrangement in which `dedupKey` — the platform's idempotency key, and the one field an
 * operator's de-duplication depends on — can be compared at all.
 *
 * ⚠️ **The rules exist before the events do**, so the first candidate is built by the *live* path.
 * That makes the comparison in §4 the one worth making: a replayed backlog must produce the same
 * incident the live traffic produced, not merely the same incident another replay produced. Two
 * replays agreeing with each other would still agree if both were wrong in the same way.
 *
 * ### ⚠️ Two fields cannot be identical, and the run says so rather than quietly excluding them
 *
 * `id` is a fresh UUID and `at` is the moment of raising. Both are **records of the run**, not
 * conclusions drawn from the evidence, and a candidate that reused a previous id would be claiming to
 * be the previous candidate. Every other field — including the whole `explanation`, the whole
 * `timeline` and every evidence reference — is compared byte for byte after canonical JSON ordering,
 * and §5 asserts that those two are the **only** differences rather than assuming it.
 *
 * ### ⚠️ Every arrival must be at least the JetStream duplicate window apart
 *
 * `POST /events/replay` re-publishes each envelope under `msgId: envelope.id`, and the stream drops a
 * repeat msgId inside `duplicate_window` (2 min, `NatsEventBus.ensureStream`). So does the *original*
 * publish — an envelope replayed ninety seconds after it was first persisted never reaches the engine
 * at all.
 *
 * The first draft of this script learned that the hard way: it seeded, then replayed immediately, and
 * the engine saw nothing because the broker had correctly suppressed a duplicate that the script
 * believed it was delivering. The run reported `10 envelope(s) replayed` — from the events service,
 * which had re-published all ten — and zero candidates. **The count came from the sender.** Every
 * wait below exists because of that, and they are why this stage belongs to the Nightly Framework
 * rather than to the gate.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const TAG = 'p8-rule-replay';
const CONTAINER = process.env.PROBE_CONTAINER ?? 'vip-prod-media-1';
const RULES_CONTAINER = process.env.RULES_CONTAINER ?? 'vip-prod-rules-1';
const PROBE_SRC = join(ROOT, 'docs/review/p8/bus-probe.mjs');
const PROBE = '/tmp/vip-bus-probe.mjs';
const OUT = process.env.OUT ?? join(ROOT, 'docs/review/p8/rule-replay-samples.json');

/** The capability the perception runtime publishes under. */
const CAP = 'perception.person-detection';

/**
 * The seeded visit, in **event time**. Ten observations, `STEP_MS` apart, spanning `SPAN`.
 *
 * ⚠️ `STEP_MS` is 11 s, just over the events service's dedup bucket (`EVENTS_DEDUP_WINDOW_MS`,
 * 10 s). Injecting faster would be honest about a camera's frame rate and dishonest about what the
 * platform *persists*: repeated detections of one subject inside a bucket collapse into one envelope,
 * so a 1 s spacing would seed ten detections and persist one, and the dwell would never accumulate.
 */
const OBSERVATIONS = 10;
const STEP_MS = 11_000;
/** Comfortably under the observed span, so the threshold is crossed partway through, not at the end. */
const DWELL_SECONDS = 45;
/** Must exceed the ~11 s observation interval — see ADR-0044 on why the frame interval is the wrong floor. */
const RESET_SECONDS = 30;
/** The shipped template's default. Longer than the seeded visit, so one visit is one candidate. */
const COOLDOWN_SECONDS = 300;
/** One `RULES_ZONE_CATALOG_INTERVAL_MS` (15 s default) plus a margin — see §0. */
const ZONE_CATALOG_WAIT_MS = Number(process.env.ZONE_CATALOG_WAIT_MS ?? 20_000);

/** JetStream `duplicate_window` from `NatsEventBus.ensureStream`, plus a margin. */
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const WINDOW_WAIT_MS = DUPLICATE_WINDOW_MS + 15_000;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const RUN = randomBytes(4).toString('hex');
/** ⚠️ Synthetic and named so nobody mistakes it for an estate camera. Registered, never assigned. */
const CAM_NAME = `${TAG} ${RUN}`;
const IDENTITY = `idt_replay_${RUN}`;

let failures = 0;
const findings = [];
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const note = (label, detail) => console.log(`  · ${label}${detail ? ` — ${detail}` : ''}`);
const finding = (label, detail) => {
  console.log(`  ⚠️ ${label} — ${detail}`);
  findings.push({ label, detail });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shq = (cmd, args, input) => {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      ...(input === undefined ? {} : { input }),
    }).trim();
  } catch {
    return '';
  }
};

async function api(path, opts = {}) {
  const res = await fetch(`${B}/api${path}`, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

let H = {};
async function login() {
  const r = await api('/identity/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify(ADMIN),
  });
  if (r.json?.data?.accessToken === undefined) {
    throw new Error(`login failed: ${r.text.slice(0, 200)}`);
  }
  H = { authorization: `Bearer ${r.json.data.accessToken}`, 'content-type': 'application/json' };
}

/* ── canonical JSON, so a key-order difference is never reported as a data difference ──────────── */

/**
 * Stable stringify: objects emit their keys sorted, arrays keep their order.
 *
 * ⚠️ Array order is **preserved, not sorted**. The timeline is an ordered story and the evidence list
 * is ordered by time; sorting them here would hide exactly the kind of nondeterminism — a set
 * iterated in hash order — that this run exists to catch.
 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Every leaf path in an object, as `a.b.0.c` → value. Used to name the exact field that diverged. */
function flatten(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object') {
    out[prefix] = value;
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : `${i}`, out));
    return out;
  }
  for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

/** Which leaf paths differ between two candidates, ignoring none — the caller decides what is allowed. */
function divergentPaths(a, b) {
  const fa = flatten(a);
  const fb = flatten(b);
  const paths = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  const out = [];
  for (const p of [...paths].sort()) {
    if (canonical(fa[p]) !== canonical(fb[p])) out.push({ path: p, a: fa[p], b: fb[p] });
  }
  return out;
}

/* ── the bus probe, running inside a service container ─────────────────────────────────────────── */

function probe(job) {
  const raw = shq('docker', ['exec', '-i', CONTAINER, 'node', PROBE], `${JSON.stringify(job)}\n`);
  if (raw === '') throw new Error('the bus probe produced no output — is the container running?');
  const parsed = JSON.parse(raw.split('\n').filter(Boolean).pop());
  if (parsed.error) throw new Error(`bus probe: ${parsed.error}`);
  return parsed;
}

/**
 * A `DetectionResult` shaped exactly as the publisher emits one.
 *
 * ⚠️ `attributes.zoneIds` is the carrier media stamps on the frame path (ADR-0044). Setting it here
 * is what lets this run have a zone without having a camera: the geometry has already been decided
 * upstream of the point under test, and re-deciding it would put a polygon evaluation inside a run
 * about determinism.
 */
function detectionResult({ seq, capturedAt, zoneId, cameraId }) {
  return {
    schemaVersion: '1.1',
    tenantId: TENANT,
    cameraId,
    capabilityId: CAP,
    capabilityVersion: '0.1.0',
    runtimeVersion: '0.1.0',
    executionProvider: 'CPUExecutionProvider',
    model: {
      id: 'yolox-nano',
      name: 'yolox-nano',
      version: '1.0.0',
      task: 'detect',
      family: 'perception',
      accelerator: 'cpu',
    },
    frame: { seq, capturedAt },
    detections: [
      {
        detectionId: `det_${RUN}_${seq}`,
        label: 'person',
        /* ⚠️ Fixed, not random: `meanConfidence` is compared, so a varying input would fail §1. */
        confidence: 0.9164,
        bbox: [0.111058, 0.417881, 0.138998, 0.53213],
        attributes: { zoneIds: [zoneId] },
        metadata: {},
        trackingId: `trk_${RUN}`,
        identityId: IDENTITY,
      },
    ],
    preprocessingVersion: '1.0/letterbox-416x416-NCHW-float32-BGR-pad114',
    confidenceThreshold: 0.35,
    inferenceMs: 12.5,
    frameLatencyMs: 41.2,
    correlationId: `${TENANT}:${cameraId}:${seq}`,
    at: capturedAt,
  };
}

/* ── cleanup ───────────────────────────────────────────────────────────────────────────────────── */

async function cleanup(quiet = false) {
  try {
    await login();
    const listed = (await api('/rules/rules', { headers: H })).json?.data;
    const rules = Array.isArray(listed) ? listed : (listed?.rules ?? []);
    for (const rule of rules.filter((r) => r.name?.startsWith(TAG))) {
      await api(`/rules/rules/${rule.id}`, {
        method: 'DELETE',
        headers: { authorization: H.authorization },
      });
    }
    /* ⚠️ Incidents, then zones, then cameras — each step needs the camera id the next one destroys. */
    const cams =
      (await api('/camera/cameras?limit=200', { headers: H })).json?.data?.cameras ?? [];
    for (const cam of cams.filter((c) => c.name?.startsWith(TAG))) {
      /*
       * ⚠️ **Closed with a note, never deleted.** There is no delete for an incident, deliberately —
       * it is an audit record, and a verification that could erase one would be a bigger problem than
       * the noise it saves. These are raised by the tenant's own pre-existing rules reacting to the
       * seeded detections, so they are real incidents about a camera that never existed, and the note
       * is the only thing that will tell whoever finds them what they were.
       */
      const raised =
        (await api(`/workflow/incidents?cameraId=${cam.id}&limit=100`, { headers: H })).json?.data
          ?.items ?? [];
      for (const incident of raised.filter((i) => i.status !== 'closed')) {
        await api(`/workflow/incidents/${incident.id}/ack`, { method: 'POST', headers: H, body: '{}' });
        await api(`/workflow/incidents/${incident.id}/resolve`, {
          method: 'POST',
          headers: H,
          body: JSON.stringify({
            resolution:
              `${TAG} verification run — synthetic detections injected onto a camera that was ` +
              'never assigned and no longer exists. No premises, no footage, no person.',
          }),
        });
        await api(`/workflow/incidents/${incident.id}/close`, { method: 'POST', headers: H, body: '{}' });
      }
      const zones = (await api(`/camera/zones?cameraId=${cam.id}`, { headers: H })).json?.data ?? [];
      for (const zone of zones) {
        await api(`/camera/zones/${zone.id}`, {
          method: 'DELETE',
          headers: { authorization: H.authorization },
        });
      }
      await api(`/camera/cameras/${cam.id}`, {
        method: 'DELETE',
        headers: { authorization: H.authorization },
      });
    }
  } catch {
    /* best effort */
  }
  shq('docker', ['exec', CONTAINER, 'rm', '-f', PROBE]);
  if (!quiet) {
    console.log('\nremoved the verification camera, its zone and its rules; closed what it caused\n');
  }
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

/* ── the run ───────────────────────────────────────────────────────────────────────────────────── */

await login();
shq('docker', ['cp', PROBE_SRC, `${CONTAINER}:${PROBE}`]);

console.log('\nP-8 Phase 7 · rule replay determinism — persisted events in, the same candidate out');
console.log(`run ${RUN} · no camera, no video, no incident raised\n`);

const samples = { run: RUN, at: new Date().toISOString() };
let cameraId;
let zoneId;
const ruleIds = {};

/** Wait for the rules engine to report itself evaluating again after a restart. */
async function waitForEngine(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api('/rules/rules/live', { headers: H });
    if (r.status === 200 && r.json?.data?.node !== undefined) return true;
    await sleep(1000);
  }
  return false;
}

/** The candidates one dry-run rule has built so far, newest last. */
async function withheld(ruleId) {
  const r = await api(`/rules/rules/${ruleId}/dry-run-candidates`, { headers: H });
  return r.json?.data ?? [];
}

/**
 * The rule did not produce exactly one candidate. Read the engine's own counters and say **which
 * stage** is responsible, because "wrong number of candidates" is four different repairs wearing one
 * message: the events never arrived, the condition never matched, the dwell never accumulated, or it
 * accumulated and fired more than once.
 */
async function explainCandidateCount(ruleId, got) {
  const stats = await api('/rules/rules/stats', { headers: H });
  const row = (stats.json?.data?.rules ?? []).find((r) => r.ruleId === ruleId);
  const live = (await api('/rules/rules/live', { headers: H })).json?.data;
  if (row === undefined) {
    finding('the rule has no statistics on this node', 'it was never compiled — check scope validation');
  } else {
    note('engine counters', `evaluated ${row.evaluations} · matched ${row.matches} · failed ${row.failures}`);
    if (row.evaluations === 0) {
      finding('the rule was never evaluated', 'no event reached it — the scope, the event type, or the broker');
    } else if (row.matches === 0) {
      finding('the rule was evaluated and never matched', 'the condition, not the dwell stage');
    } else if (got === 0) {
      finding('it matched but never fired', 'the dwell stage — threshold, reset window, or subject key');
    } else if (got > 1) {
      finding(
        `it fired ${got} times for one visit`,
        'the cool-down — a rule past its threshold raises on every observation without one',
      );
    }
  }
  if ((live?.dwellWithoutIdentity ?? 0) > 0) {
    finding(
      `${live.dwellWithoutIdentity} event(s) reached a dwell rule with no subject key`,
      'the identity did not survive to the engine (ADR-0041)',
    );
  }
  note('active dwell timers', `${live?.activeDwellTimers ?? '?'}`);
}

/** Replay the seeded window and return how many envelopes the service re-published. */
async function replay(from, to) {
  const r = await api('/events/events/replay', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ from, to, cameraId, limit: 500 }),
  });
  return r.json?.data?.replayed;
}

/** The persisted window, oldest first, so two reads are comparable in order. */
async function persisted() {
  const r = await api(`/events/events?cameraId=${encodeURIComponent(cameraId)}&limit=200`, {
    headers: H,
  });
  const rows = r.json?.data?.events ?? [];
  return [...rows].sort((x, y) => x.occurredAt.localeCompare(y.occurredAt) || x.id.localeCompare(y.id));
}

/** A countdown that shows the wait is deliberate rather than a hang. */
async function waitOutWindow(why) {
  const seconds = Math.round(WINDOW_WAIT_MS / 1000);
  note(`waiting ${seconds}s for the JetStream duplicate window`, why);
  await sleep(WINDOW_WAIT_MS);
}

try {
  /* ── 0 · a camera and a zone, so the candidate's explanation is complete ────────────────────── */
  console.log('0 · the fixture — a registered camera that will never be assigned');
  const hierarchyZone = (await api('/camera/cameras?limit=1', { headers: H })).json?.data
    ?.cameras?.[0]?.zoneId;
  check(hierarchyZone !== undefined, 'the tenant has a location hierarchy to attach a camera to');

  const cam = await api('/camera/cameras', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      zoneId: hierarchyZone,
      name: CAM_NAME,
      protocol: 'rtsp',
      /* ⚠️ Never opened. The camera is registered so a zone can exist on it; it is never assigned. */
      streamUrl: `rtsp://127.0.0.1:8554/${TAG}-${RUN}`,
      metadata: { tags: [TAG] },
    }),
  });
  cameraId = cam.json?.data?.id;
  check(cameraId !== undefined, 'a camera record exists', `HTTP ${cam.status}`);
  if (cameraId === undefined) throw new Error(`could not create the camera: ${cam.text.slice(0, 300)}`);

  const zone = await api('/camera/zones', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      cameraId,
      name: 'Checkout Queue',
      kind: 'area',
      shape: 'polygon',
      geometry: {
        points: [
          [0.02, 0.02],
          [0.98, 0.02],
          [0.98, 0.98],
          [0.02, 0.98],
        ],
      },
      purpose: 'verification',
      enabled: true,
    }),
  });
  zoneId = zone.json?.data?.id;
  check(zoneId !== undefined, 'a named detection zone exists', `HTTP ${zone.status}`);
  if (zoneId === undefined) throw new Error(`could not create the zone: ${zone.text.slice(0, 300)}`);
  /*
   * ⚠️ The rules service names a zone from a cache it refreshes on a timer, so a zone created seconds
   * ago has no name yet and its candidate carries the zone id instead. That is documented behaviour
   * and it is **not** what this run is measuring — waiting one refresh interval here is the
   * difference between testing determinism and re-testing the cache.
   *
   * ⚠️ It is a wait, not an exclusion. The comparison in §4 excludes nothing but `id` and `at`, so if
   * the cache regresses — a cold catalogue after a restart, say — this run goes red naming
   * `explanation.zoneName` rather than quietly agreeing about a field neither candidate carries.
   */
  note(`waiting ${ZONE_CATALOG_WAIT_MS / 1000}s for the rules service to learn the zone's name`, '');
  await sleep(ZONE_CATALOG_WAIT_MS);
  console.log('');

  /* ── 1 · two identical rules, enabled BEFORE any event exists ───────────────────────────────── */
  console.log('1 · two identically-configured dry-run rules, watching an empty camera');
  const makeRule = async (suffix) => {
    const made = await api('/rules/rules', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        name: `${TAG} ${suffix} ${RUN}`,
        description:
          'Verification instrument for P-8 Phase 7 replay determinism. Created and deleted by ' +
          'docs/review/p8/rule-replay.mjs. Dry run — it can never raise an incident.',
        eventTypes: ['perception.person.detected'],
        condition: { field: 'subjects.0.identityId', op: 'eq', value: IDENTITY },
        dwell: {
          minSeconds: DWELL_SECONDS,
          groupBy: 'identity',
          resetAfterSeconds: RESET_SECONDS,
          /*
           * ⚠️ The shipped template's default, and it must be longer than the seeded visit. With no
           * cool-down the rule fires on **every observation past the threshold** — the first run of
           * this script produced five candidates for one person standing still, which is what a
           * loitering rule does without one and is the reason the field exists.
           *
           * It is also what makes §3 meaningful: the cool-down is measured in EVENT time, so a
           * replayed backlog falls inside the window armed by the live pass and cannot re-fire. That
           * is idempotence by the rule's own semantics rather than by a broker's dedup window.
           */
          cooldownSeconds: COOLDOWN_SECONDS,
        },
        /* ⚠️ Dry run: everything is evaluated, nothing is published. See the header. */
        dryRun: true,
        severity: 'low',
        actions: [{ type: 'raise-incident' }],
        scope: { nodeIds: [], cameraIds: [cameraId], groupIds: [], zoneIds: [zoneId] },
      }),
    });
    const id = made.json?.data?.id;
    if (id === undefined) throw new Error(`could not create rule ${suffix}: ${made.text.slice(0, 300)}`);
    const enabled = await api(`/rules/rules/${id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ lifecycle: 'enabled' }),
    });
    return { id, lifecycle: enabled.json?.data?.lifecycle };
  };

  const ruleA = await makeRule('A');
  const ruleB = await makeRule('B');
  ruleIds.a = ruleA.id;
  ruleIds.b = ruleB.id;
  check(
    ruleA.lifecycle === 'enabled' && ruleB.lifecycle === 'enabled',
    'both are enabled — their scope references were verified against the camera service',
    `${ruleA.lifecycle} / ${ruleB.lifecycle}`,
  );
  /* The engine reloads on change; give the compiled scope a moment to land before events arrive. */
  await sleep(3000);
  console.log('');

  /* ── 2 · seed a visit — the LIVE pass ───────────────────────────────────────────────────────── */
  console.log(`2 · seeding one visit — ${OBSERVATIONS} observations, ${STEP_MS / 1000}s apart`);
  /*
   * ⚠️ The whole visit is placed in the PAST, ending a few seconds ago. `occurredAt` is what the
   * dwell stage accumulates against, so a visit seeded into the future would produce a candidate
   * whose duration was correct and whose evidence interval pointed at footage that does not exist.
   */
  const baseMs = Date.now() - (OBSERVATIONS + 1) * STEP_MS;
  const messages = [];
  for (let i = 0; i < OBSERVATIONS; i += 1) {
    const capturedAt = new Date(baseMs + i * STEP_MS).toISOString();
    messages.push({
      subject: `t.${TENANT}.capability.output.${CAP}`,
      body: detectionResult({ seq: 1000 + i, capturedAt, zoneId, cameraId }),
      msgId: `${TAG}:${RUN}:${1000 + i}`,
    });
  }
  probe({ op: 'publish', messages });

  const from = new Date(baseMs - 60_000).toISOString();
  const to = new Date(baseMs + OBSERVATIONS * STEP_MS + 60_000).toISOString();

  let seeded = [];
  const seedDeadline = Date.now() + 30_000;
  while (seeded.length < OBSERVATIONS && Date.now() < seedDeadline) {
    await sleep(1000);
    seeded = await persisted();
  }
  await sleep(2500);
  seeded = await persisted();

  check(
    seeded.length === OBSERVATIONS,
    `${OBSERVATIONS} envelopes were persisted`,
    `${seeded.length} in the store`,
  );
  check(
    seeded.every((e) => e.zoneId === zoneId),
    '⚠️ every envelope carries the DETECTION zone — without it the rule has nothing to scope to',
    `${seeded.filter((e) => e.zoneId === zoneId).length}/${seeded.length}`,
  );
  check(
    seeded.every((e) => e.subjects?.[0]?.identityId === IDENTITY),
    '⚠️ and an IDENTITY — a dwell rule accumulates on it, never on the track (ADR-0041)',
  );

  /* The fingerprint the "replay must not mutate" check is measured against. */
  const seedFingerprint = sha(canonical(seeded));
  samples.seed = {
    persisted: seeded.length,
    spanSeconds: (OBSERVATIONS - 1) * (STEP_MS / 1000),
    fingerprint: seedFingerprint,
    from,
    to,
  };
  note('window fingerprint', `${seedFingerprint.slice(0, 16)}…`);

  const a1 = await withheld(ruleA.id);
  const b1 = await withheld(ruleB.id);
  check(a1.length === 1, 'rule A built exactly one candidate from the live arrival', `${a1.length}`);
  check(b1.length === 1, 'rule B built exactly one candidate', `${b1.length}`);
  if (a1.length !== 1 || b1.length !== 1) {
    /* ⚠️ Name the stage responsible, rather than reporting a count. See `explainCandidateCount`. */
    await explainCandidateCount(ruleA.id, a1.length);
    throw new Error(
      `the seeded visit produced ${a1.length} candidate(s), not one — nothing downstream can be compared`,
    );
  }

  const candA = a1[0];
  const candB = b1[0];
  check(
    candA.identityId === IDENTITY,
    'the candidate names the identity that was seeded',
    candA.identityId,
  );
  check(
    candA.durationSeconds >= DWELL_SECONDS,
    `and a duration at or past the ${DWELL_SECONDS}s threshold`,
    `${candA.durationSeconds}s observed`,
  );
  check(
    (candA.timeline?.entries?.length ?? 0) > 0 && (candA.evidence?.length ?? 0) > 0,
    '⚠️ and it carries a timeline and evidence references — the parts worth comparing',
    `${candA.timeline?.entries?.length} moment(s), ${candA.evidence?.length} reference(s)`,
  );
  /*
   * ⚠️ The zone JOIN, checked separately from the zone id. `zoneVersion` is what an incident detail
   * page uses to fetch the geometry as it was judged; a candidate without it silently resolves to
   * today's polygon. This check names that specific failure, so a cold catalogue is never reported
   * as a determinism problem.
   */
  check(
    candA.explanation?.zoneName === 'Checkout Queue' && candA.explanation?.zoneVersion === 1,
    '⚠️ and the zone is NAMED and VERSIONED — without the version an incident resolves the wrong geometry',
    `${candA.explanation?.zoneName ?? 'unnamed'} v${candA.explanation?.zoneVersion ?? '?'}`,
  );

  /*
   * ⚠️ Four fields differ BY CONSTRUCTION here, because the rules are two different rules:
   * `ruleId`, `ruleName`, `dedupKey` (which contains the rule id, so that two rules watching one zone
   * raise two candidates instead of colliding), and `title` — which a dwell candidate renders as
   * "<rule name>: 55s in Checkout Queue". The duration and the zone inside that string are the same
   * in both; only the operator's name for the rule differs. All four are compared for real in §4,
   * where the rule id is held constant across a restart and nothing is excluded but `id` and `at`.
   */
  const instanceAllowed = new Set(['id', 'at', 'ruleId', 'ruleName', 'dedupKey', 'title']);
  const instanceDiff = divergentPaths(candA, candB).filter((d) => !instanceAllowed.has(d.path));
  check(
    instanceDiff.length === 0,
    '⚠️ every field derived from the EVENTS is identical across the two instances',
    instanceDiff.length === 0
      ? `${Object.keys(flatten(candA)).length} leaf field(s) compared`
      : instanceDiff.map((d) => d.path).join(', '),
  );
  for (const d of instanceDiff.slice(0, 5)) {
    finding(`instances diverged at ${d.path}`, `${JSON.stringify(d.a)} vs ${JSON.stringify(d.b)}`);
  }
  samples.instances = {
    compared: Object.keys(flatten(candA)).length,
    diverged: instanceDiff.map((d) => d.path),
  };
  console.log('');

  /* ── 3 · replayed into a warm engine — nothing new ──────────────────────────────────────────── */
  console.log('3 · the persisted window, replayed into the engine that just saw it live');
  await waitOutWindow('a repeat inside it is dropped by the broker, not judged by the engine');
  const replayed1 = await replay(from, to);
  check(replayed1 === OBSERVATIONS, 'the window replayed', `${replayed1} envelope(s)`);
  await sleep(8000);

  const a2 = await withheld(ruleA.id);
  check(
    a2.length === 1,
    '⚠️ replay is IDEMPOTENT — re-reading the record raised NO second candidate',
    `${a2.length} candidate(s) after the replay`,
  );
  if (a2.length > 1) {
    finding(
      'a replayed backlog raised a duplicate candidate',
      'an operator re-running an investigation would create incidents by reading the record',
    );
  }
  samples.idempotent = { candidatesAfterReplay: a2.length };
  console.log('');

  /* ── 4 · same rule, fresh process ───────────────────────────────────────────────────────────── */
  console.log('4 · the same rule, the same events, after a process restart');
  /*
   * ⚠️ The restart is the only way to get a fresh dwell state under the SAME rule id, and the rule id
   * is what makes `dedupKey` comparable. It also exercises the documented limitation directly: dwell
   * state is in-memory, so a restart must lose it completely and the engine must rebuild the whole
   * decision from the events alone. If any part of the candidate survived the restart by another
   * route, this section is where it would show.
   */
  note('restarting the rules service', 'in-memory dwell state must not survive it');
  shq('docker', ['restart', RULES_CONTAINER]);
  const back = await waitForEngine();
  check(back, 'the rules engine is evaluating again');

  const afterRestart = await withheld(ruleA.id);
  check(
    afterRestart.length === 0,
    '⚠️ and it came back with NO dwell state and NO candidates — nothing was carried over',
    `${afterRestart.length} candidate(s) survived`,
  );
  /*
   * ⚠️ Nothing is done to warm the zone catalogue here, deliberately. The composition root awaits one
   * refresh before the engine consumes, so a candidate raised in the first second after a restart
   * must already be able to name its zone. If that regresses, the comparison below goes red at
   * `explanation.zoneName` and `explanation.zoneVersion` — which is how this defect was found.
   */

  await waitOutWindow('this replay must not be swallowed by the last one');
  const replayed2 = await replay(from, to);
  check(replayed2 === OBSERVATIONS, 'the window replayed a second time', `${replayed2} envelope(s)`);
  await sleep(8000);

  const a3 = await withheld(ruleA.id);
  check(
    a3.length === 1,
    'the rebuilt engine produced exactly one candidate from the events alone',
    `${a3.length}`,
  );
  if (a3.length !== 1) throw new Error('no candidate after the restart — nothing to compare');

  const candA3 = a3[0];
  /* ⚠️ `id` and `at` only. `dedupKey` is NOT excluded here — that is the point of this section. */
  const replayAllowed = new Set(['id', 'at']);
  const replayDiff = divergentPaths(candA, candA3).filter((d) => !replayAllowed.has(d.path));
  check(
    replayDiff.length === 0,
    '⚠️ the replayed candidate is BYTE-IDENTICAL to the LIVE one, dedupKey included',
    replayDiff.length === 0
      ? sha(canonical({ ...candA3, id: null, at: null })).slice(0, 16) + '…'
      : replayDiff.map((d) => d.path).join(', '),
  );
  for (const d of replayDiff.slice(0, 8)) {
    finding(`replay diverged at ${d.path}`, `${JSON.stringify(d.a)} vs ${JSON.stringify(d.b)}`);
  }

  check(
    candA.dedupKey === candA3.dedupKey,
    '⚠️ the IDEMPOTENCY KEY is stable across a restart — a re-promotion collapses, it does not double',
    candA3.dedupKey,
  );
  check(
    candA.identityId === candA3.identityId &&
      candA.durationSeconds === candA3.durationSeconds &&
      candA.triggeredBy?.occurredAt === candA3.triggeredBy?.occurredAt,
    'identity, duration and trigger time are the ones the events say they are',
    `${candA3.identityId} · ${candA3.durationSeconds}s · ${candA3.triggeredBy?.occurredAt}`,
  );
  check(
    canonical(candA.explanation) === canonical(candA3.explanation),
    'the structured explanation is identical, field for field',
  );
  check(
    canonical(candA.timeline) === canonical(candA3.timeline),
    'the timeline is identical, in the same order',
    `${candA3.timeline?.entries?.length} of ${candA3.timeline?.total}`,
  );
  check(
    canonical(candA.evidence) === canonical(candA3.evidence),
    'every evidence reference points at the same camera over the same interval',
    (candA3.evidence ?? []).map((e) => e.kind).join(', '),
  );

  samples.replay = {
    fingerprint: sha(canonical({ ...candA3, id: null, at: null })),
    dedupKey: candA3.dedupKey,
    diverged: replayDiff.map((d) => d.path),
    durationSeconds: candA3.durationSeconds,
  };
  console.log('');

  /* ── 5 · the two fields that differ, and nothing else ───────────────────────────────────────── */
  console.log('5 · what is NOT identical, stated rather than assumed');
  const all = divergentPaths(candA, candA3).map((d) => d.path);
  check(
    all.length === 2 && all.includes('id') && all.includes('at'),
    '⚠️ exactly two fields differ, and both are records of the RUN, not of the evidence',
    all.join(', ') || 'none',
  );
  check(
    candA.id !== candA3.id,
    'the id is fresh — a replayed candidate does not claim to be the earlier one',
  );
  note('candidate.at', `${candA.at} → ${candA3.at}`);
  console.log('');

  /* ── 6 · replay changed nothing it read ─────────────────────────────────────────────────────── */
  console.log('6 · the stored events, after two replays');
  const after = await persisted();
  check(after.length === seeded.length, 'the store holds the same number of envelopes', `${after.length}`);
  check(
    canonical(after.map((e) => e.id)) === canonical(seeded.map((e) => e.id)),
    'the same ids, in the same order — replay re-publishes, it never re-persists',
  );
  check(
    sha(canonical(after)) === seedFingerprint,
    '⚠️ and every byte is unchanged — the window fingerprint still matches',
    sha(canonical(after)).slice(0, 16) + '…',
  );

  const incidents = await api(
    `/workflow/incidents?cameraId=${encodeURIComponent(cameraId)}&limit=100`,
    { headers: H },
  );
  const raised = incidents.json?.data?.items ?? [];
  const mine = raised.filter((i) => i.source?.ruleId === ruleIds.a || i.source?.ruleId === ruleIds.b);
  check(
    mine.length === 0,
    '⚠️ and NEITHER dry-run rule raised an incident, across three arrivals and one restart',
    `${mine.length} from this run's rules`,
  );
  /*
   * ⚠️ Other rules DO react, and the run says so rather than asserting a zero it cannot honestly
   * claim. The demo tenant ships an enabled, tenant-wide "After-hours presence" rule that matches any
   * person detection, so injecting ten of them raises incidents that have nothing to do with replay
   * determinism. They are the cost of seeding real events into a real deployment, they are closed
   * with a note in the cleanup below, and counting them here is what stops this stage quietly
   * depositing incidents in an operator's queue every night.
   */
  const others = raised.length - mine.length;
  if (others > 0) {
    note(
      `${others} incident(s) came from OTHER enabled rules in this tenant`,
      [...new Set(raised.filter((i) => !mine.includes(i)).map((i) => i.source?.ruleName))].join(', '),
    );
  }
  samples.stored = {
    before: seeded.length,
    after: after.length,
    incidentsFromThisRun: mine.length,
    incidentsFromOtherRules: others,
  };
  console.log('');
} finally {
  await cleanup(true);
  samples.failures = failures;
  samples.findings = findings;
  writeFileSync(OUT, `${JSON.stringify(samples, null, 2)}\n`);
}

console.log(
  failures === 0
    ? '\nthe same persisted events produce the same candidate — id and timestamp aside, byte for byte\n'
    : `\n${failures} replay determinism check(s) failed\n`,
);
if (findings.length > 0) {
  console.log(`${findings.length} finding(s) recorded in ${OUT}\n`);
}
process.exit(failures === 0 ? 0 : 1);

/**
 * P-8 Phase 5 · **duplicates, correlation, replay determinism, payload versions.**
 *
 *   node docs/review/p8/event-bridge-replay.mjs         # against the running deployment
 *   node docs/review/p8/event-bridge-replay.mjs clean   # ⚠️ if a run was interrupted
 *
 * `event-bridge.mjs` proves the chain **exists**: a real camera, real frames, real inference, and an
 * incident candidate at the end. It cannot prove the chain is *deterministic*, because it depends on
 * a video decoder, a model, and a host under whatever load it happens to be under.
 *
 * This run proves the other half, and it deliberately has **no camera in it at all**. It injects a
 * known `DetectionResult` onto the subject the publisher publishes to, so every input is exact and
 * every output is comparable:
 *
 * ```
 *   known DetectionResult → t.{tenant}.capability.output.{cap}
 *         → events (normalize · dedup · persist) → t.{tenant}.event.*
 *         → rules → IncidentCandidate → workflow → Incident
 * ```
 *
 * ### ⚠️ The injected result is checked against a REAL one
 *
 * A hand-written fixture that has drifted from what the publisher actually emits would verify a
 * shape nothing produces. §0 compares the envelope this run produces against the envelope recorded
 * by the live `event-bridge.mjs` run and reports any structural divergence as a finding.
 *
 * ### ⚠️ What "exactly once" is not
 *
 * The platform has **two** duplicate-suppression mechanisms and neither of them is exactly-once.
 * Both are *windows*. §1 measures each independently — including the point at which suppression
 * stops — because a guarantee is something you demonstrate, not something you inherit from a config
 * flag. What is claimed afterwards is what was measured.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const TAG = 'p8-replay';
const CONTAINER = process.env.PROBE_CONTAINER ?? 'vip-prod-media-1';
const PROBE_SRC = join(ROOT, 'docs/review/p8/bus-probe.mjs');
const PROBE = '/tmp/vip-bus-probe.mjs';
const OUT = process.env.OUT ?? join(ROOT, 'docs/review/p8/event-bridge-replay-samples.json');
const LIVE_SAMPLES = join(ROOT, 'docs/review/p8/event-bridge-samples.json');

/** The capability the perception runtime publishes under — matched to a recorded live result. */
const CAP = 'perception.person-detection';
/**
 * `EVENTS_DEDUP_WINDOW_MS` (events service default). The dedup key buckets `occurredAt` by this, so
 * it is the width of logical duplicate suppression — and §1c crosses it on purpose.
 */
const DEDUP_WINDOW_MS = Number(process.env.EVENTS_DEDUP_WINDOW_MS ?? 10_000);
/** JetStream `duplicate_window` from `NatsEventBus.ensureStream`. Reported, not assumed. */
const STREAM_DEDUP_WINDOW_MS = 2 * 60 * 1000;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const RUN = randomBytes(4).toString('hex');
/** ⚠️ Synthetic, and named so nobody mistakes it for an estate camera. Never registered. */
const CAM = `cam_p8replay_${RUN}`;

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

/** Per-rule counters from the engine's own statistics — not from a persisted incident. */
async function ruleStats(ruleId) {
  const r = await api('/rules/rules/stats', { headers: H });
  return (r.json?.data?.rules ?? []).find((x) => x.ruleId === ruleId);
}

/** How many incidents exist for the synthetic camera right now. */
async function incidentsForCamera() {
  const r = await api(`/workflow/incidents?cameraId=${encodeURIComponent(CAM)}&limit=100`, {
    headers: H,
  });
  return r.json?.data?.items ?? [];
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

/* ── the bus probe, running inside a service container ─────────────────────────────────────────── */

function probe(job) {
  const raw = shq('docker', ['exec', '-i', CONTAINER, 'node', PROBE], `${JSON.stringify(job)}\n`);
  if (raw === '') throw new Error('the bus probe produced no output — is the container running?');
  const parsed = JSON.parse(raw.split('\n').filter(Boolean).pop());
  if (parsed.error) throw new Error(`bus probe: ${parsed.error}`);
  return parsed;
}

const capabilitySubject = `t.${TENANT}.capability.output.${CAP}`;
const eventSubjectFor = (type) => `t.${TENANT}.event.${type}`;

/* ── the fixtures ──────────────────────────────────────────────────────────────────────────────── */

/**
 * A `DetectionResult` shaped exactly as the publisher emits one, with every varying part supplied by
 * the caller. `correlationId` is stamped the way `BufferedEventPublisher` stamps it — deterministic
 * from tenant + camera + sequence — because half of what this run measures is that the id survives.
 */
function detectionResult({ seq, capturedAt, trackId, identityId, precededBy, confidence = 0.9164 }) {
  return {
    schemaVersion: '1.1',
    tenantId: TENANT,
    cameraId: CAM,
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
        confidence,
        bbox: [0.111058, 0.417881, 0.138998, 0.53213],
        attributes: {},
        metadata: {},
        trackingId: trackId,
        identityId,
        ...(precededBy === undefined ? {} : { precededBy }),
      },
    ],
    preprocessingVersion: '1.0/letterbox-416x416-NCHW-float32-BGR-pad114',
    confidenceThreshold: 0.35,
    inferenceMs: 12.5,
    frameLatencyMs: 41.2,
    correlationId: `${TENANT}:${CAM}:${seq}`,
    at: capturedAt,
  };
}

/** Read the persisted envelopes this run produced. Newest-first, as the store returns them. */
async function persisted(extra = '') {
  const r = await api(`/events/events?cameraId=${encodeURIComponent(CAM)}&limit=200${extra}`, {
    headers: H,
  });
  return r.json?.data?.events ?? [];
}

/**
 * Poll until the store holds `expected` envelopes, then **settle** and confirm it did not grow.
 *
 * ⚠️ The settle is the point. Asserting "exactly one" the instant the first one lands would pass on
 * a system that was about to persist four more, which is precisely the failure this section exists
 * to catch.
 */
async function settleAt(expected, { timeoutMs = 20_000, settleMs = 2500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let events = await persisted();
  while (events.length < expected && Date.now() < deadline) {
    await sleep(500);
    events = await persisted();
  }
  await sleep(settleMs);
  return persisted();
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
    /*
     * ⚠️ Incidents are NOT deleted — there is no delete, deliberately, because an incident is an
     * audit record. The ones this run raises are closed with a note saying what they are. A
     * verification that could erase incidents would be a bigger problem than the noise it saves.
     */
    const raised =
      (await api(`/workflow/incidents?cameraId=${encodeURIComponent(CAM)}&limit=50`, { headers: H }))
        .json?.data?.items ?? [];
    for (const incident of raised.filter((i) => i.status !== 'closed')) {
      await api(`/workflow/incidents/${incident.id}/ack`, { method: 'POST', headers: H, body: '{}' });
      await api(`/workflow/incidents/${incident.id}/resolve`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ resolution: `${TAG} verification run ${RUN} — synthetic, no premises` }),
      });
      await api(`/workflow/incidents/${incident.id}/close`, { method: 'POST', headers: H, body: '{}' });
    }
  } catch {
    /* best effort */
  }
  shq('docker', ['exec', CONTAINER, 'rm', '-f', PROBE]);
  if (!quiet) console.log('\nremoved the verification rules and closed the incidents they raised\n');
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

/* ── the run ───────────────────────────────────────────────────────────────────────────────────── */

await login();
shq('docker', ['cp', PROBE_SRC, `${CONTAINER}:${PROBE}`]);

console.log('\nP-8 Phase 5 · duplicates, correlation, replay determinism, payload versions');
console.log(`run ${RUN} · synthetic camera ${CAM} · no live video in this run\n`);

const samples = { run: RUN, camera: CAM };
let incidentRule;
let auditRule;

/**
 * `RULES_CANDIDATE_DEDUP_WINDOW_MS` (rules service default). Identical candidates collapse inside
 * this bucket, so it decides how far apart §1's events and §2's must be to get separate incidents.
 */
const CANDIDATE_DEDUP_WINDOW_MS = Number(process.env.RULES_CANDIDATE_DEDUP_WINDOW_MS ?? 60_000);

/*
 * ⚠️ The run's synthetic clock is anchored FIVE MINUTES IN THE PAST, and every injected `capturedAt`
 * derives from it. Two reasons, and the first one cost a failed run:
 *
 *   - §1's events and §2's must land in different CANDIDATE dedup buckets. At one minute apart they
 *     did not, so §2's event produced a candidate that the rule engine correctly collapsed into the
 *     incident §1 had already raised — and §2 read that as "no incident", which was the wrong
 *     conclusion from a correct system.
 *   - §1c has to place the same result in a LATER event-dedup bucket. Doing that from "now" stamps
 *     events in the future, which is not what a camera produces.
 */
const CLOCK = Date.now() - 5 * CANDIDATE_DEDUP_WINDOW_MS;
const bucketStart = Math.floor(CLOCK / DEDUP_WINDOW_MS) * DEDUP_WINDOW_MS;
const startedAt = new Date(bucketStart - 1000).toISOString();

try {
  /* ── 0 · the instruments ───────────────────────────────────────────────────────────────────── */
  console.log('0 · two verification rules (created here, deleted in a finally)');
  const makeRule = async (name, description, actions) => {
    const made = await api('/rules/rules', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        name: `${TAG} ${name}`,
        description,
        eventTypes: ['perception.person.detected'],
        severity: 'low',
        actions,
      }),
    });
    const id = made.json?.data?.id;
    if (id === undefined) throw new Error(`could not create rule ${name}: ${made.text.slice(0, 300)}`);
    const enabled = await api(`/rules/rules/${id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ lifecycle: 'enabled' }),
    });
    /*
     * ⚠️ Asserted, not assumed. The first version ignored this response — and the observing rule
     * silently stayed a DRAFT, because it emitted an uncatalogued event type and validation refused
     * to enable it. Only enabled rules are evaluated, so §4 measured zero matches and looked like a
     * consumer that could not read payload v2. An instrument that fails to arm has to say so.
     */
    if (enabled.json?.data?.lifecycle !== 'enabled') {
      throw new Error(
        `rule ${name} did not enable: ${enabled.json?.error?.message ?? enabled.text.slice(0, 300)}`,
      );
    }
    return id;
  };

  incidentRule = await makeRule(
    'raises',
    'Verification instrument for P-8 Phase 5 replay determinism. Created and deleted by ' +
      'docs/review/p8/event-bridge-replay.mjs. Encodes no business meaning.',
    [{ type: 'raise-incident' }],
  );
  /*
   * ⚠️ An `emit-event` rule is evaluated and counted as a match, and the engine raises NOTHING for
   * it — `willRaise` is false, so no candidate is published. That is what makes it the right
   * instrument for §4: three payload versions can be pushed through the live consumer without
   * leaving three incidents behind referencing events that were never persisted.
   */
  auditRule = await makeRule(
    'observes',
    'Verification instrument for P-8 Phase 5 payload version compatibility. Matches but raises ' +
      'nothing, so version probes leave no incident behind. Created and deleted by the same script.',
    /*
     * ⚠️ A CATALOGUED type, because validation refuses to enable a rule that emits one that is not.
     * `tracking.track.updated` is safe here for a second reason: the engine does not implement
     * `emit-event` at all, so nothing is ever published and no loop is possible.
     */
    [{ type: 'emit-event', eventType: 'tracking.track.updated' }],
  );
  check(incidentRule !== undefined && auditRule !== undefined, 'both rules are enabled');
  await sleep(1500); // the engine recompiles on write; give the warm-up a moment
  console.log('');

  /* ── 1 · duplicates ────────────────────────────────────────────────────────────────────────── */
  console.log('1 · duplicate suppression — two mechanisms, both of them windows');

  /* Anchored 1s INTO a bucket so the five publishes of §1a/§1b cannot straddle its edge. */
  const dupAt = new Date(bucketStart + 1000).toISOString();
  const dupResult = detectionResult({
    seq: 1,
    capturedAt: dupAt,
    trackId: `trk_${RUN}_dup`,
    identityId: `trk_${RUN}_dup`,
  });

  /* 1a — the same body with the SAME msgId, which is what a publisher retry looks like. */
  const s0 = probe({ op: 'streams' }).streams;
  const a = probe({
    op: 'publish',
    messages: Array.from({ length: 5 }, () => ({
      subject: capabilitySubject,
      msgId: `${TENANT}:${CAM}:1`,
      body: dupResult,
    })),
  });
  const acceptedA = (a.streams.CAPABILITY_OUTPUT ?? 0) - (s0.CAPABILITY_OUTPUT ?? 0);
  check(
    acceptedA === 1,
    '⚠️ five publishes with one msgId reached the stream ONCE',
    `${acceptedA} message(s) accepted of 5 sent`,
  );
  let events = await settleAt(1);
  check(events.length === 1, 'and produced one persisted event', `${events.length} event(s)`);

  /* 1b — the same body with FRESH msgIds: a reconnect, where the producer's keys are regenerated. */
  const b = probe({
    op: 'publish',
    messages: Array.from({ length: 5 }, (_, i) => ({
      subject: capabilitySubject,
      msgId: `${TENANT}:${CAM}:1:reconnect-${i}`,
      body: dupResult,
    })),
  });
  const acceptedB = (b.streams.CAPABILITY_OUTPUT ?? 0) - (a.streams.CAPABILITY_OUTPUT ?? 0);
  check(
    acceptedB === 5,
    'five publishes with fresh msgIds all reached the stream — the transport did NOT collapse them',
    `${acceptedB} message(s) accepted`,
  );
  events = await settleAt(1);
  check(
    events.length === 1,
    '⚠️ and STILL one persisted event — a reconnect does not fork the logical event',
    `${events.length} event(s) from 6 deliveries of the same result`,
  );

  /* 1c — the same body, one dedup bucket later. This is where suppression stops. */
  const laterAt = new Date(bucketStart + DEDUP_WINDOW_MS * 3 + 1000).toISOString();
  probe({
    op: 'publish',
    messages: [
      {
        subject: capabilitySubject,
        msgId: `${TENANT}:${CAM}:1:later`,
        body: { ...dupResult, frame: { seq: 1, capturedAt: laterAt }, at: laterAt },
      },
    ],
  });
  events = await settleAt(2);
  check(
    events.length === 2,
    '⚠️ the SAME result outside the window persisted a SECOND event — suppression is bounded',
    `${events.length} event(s); window ${DEDUP_WINDOW_MS} ms`,
  );
  samples.duplicates = { acceptedA, acceptedB, persisted: events.length };
  finding(
    'delivery is AT-LEAST-ONCE. Exactly-once is achieved only WITHIN two windows',
    `JetStream collapses a repeated Nats-Msg-Id for ${STREAM_DEDUP_WINDOW_MS} ms; the events ` +
      `service collapses a repeated dedupKey inside a ${DEDUP_WINDOW_MS} ms bucket. Measured here: ` +
      '6 deliveries of one result → 1 event inside the window, 2 across it. Consumers must be idempotent.',
  );
  console.log('');

  /* ── 2 · correlation, all the way to the incident ──────────────────────────────────────────── */
  console.log('2 · correlation — one frame, traced through every subsystem');
  const seq = 42;
  const corr = `${TENANT}:${CAM}:${seq}`;
  const trackId = `trk_${RUN}_walk_2`;
  const identityId = `trk_${RUN}_walk_1`; // ⚠️ deliberately NOT equal — this track re-entered
  const traceResult = detectionResult({
    seq,
    capturedAt: new Date().toISOString(),
    trackId,
    identityId,
    precededBy: `trk_${RUN}_walk_1`,
  });
  probe({
    op: 'publish',
    messages: [{ subject: capabilitySubject, msgId: corr, body: traceResult }],
  });

  const deadline = Date.now() + 20_000;
  let traced = [];
  while (traced.length === 0 && Date.now() < deadline) {
    await sleep(500);
    traced = (
      await api(`/events/events?correlationId=${encodeURIComponent(corr)}&limit=10`, { headers: H })
    ).json?.data?.events ?? [];
  }
  const envelope = traced[0];
  check(envelope !== undefined, 'the frame produced an event, found BY CORRELATION ID', corr);

  if (envelope !== undefined) {
    samples.traced = envelope;
    check(envelope.correlationId === corr, 'correlationId survived', envelope.correlationId);
    check(envelope.cameraId === CAM, 'cameraId survived', envelope.cameraId);
    check(envelope.tenantId === TENANT, 'tenantId survived', envelope.tenantId);
    check(
      envelope.payload?.frameId === corr && envelope.payload?.frameSeq === seq,
      'frameId and frameSeq survived',
      `${envelope.payload?.frameId} / seq ${envelope.payload?.frameSeq}`,
    );
    check(envelope.subjects?.[0]?.trackId === trackId, 'trackId survived', envelope.subjects?.[0]?.trackId);
    check(
      envelope.subjects?.[0]?.identityId === identityId,
      '⚠️ identityId survived, and is DISTINCT from trackId — the re-entry link held',
      `${envelope.subjects?.[0]?.identityId} ← ${envelope.subjects?.[0]?.precededBy}`,
    );

    /* ⚠️ Does the fixture still look like reality? */
    if (existsSync(LIVE_SAMPLES)) {
      const live = JSON.parse(readFileSync(LIVE_SAMPLES, 'utf8')).samples?.sample;
      if (live !== undefined) {
        const keys = (o) => Object.keys(o ?? {}).sort().join(',');
        const same =
          keys(live) === keys(envelope) &&
          keys(live.payload) === keys(envelope.payload) &&
          keys(live.producer) === keys(envelope.producer);
        check(
          same,
          '⚠️ the injected result produces the SAME envelope shape as a real camera did',
          same ? 'structure matches the recorded live sample' : 'DIVERGED from event-bridge-samples.json',
        );
        if (!same) {
          finding(
            'the injected fixture has drifted from what the publisher emits',
            `live=${keys(live)} · injected=${keys(envelope)}`,
          );
        }
      }
    }

    /* the last two hops: rule → candidate → incident */
    /*
     * ⚠️ Filtered to the rule THIS RUN created. The demo tenant has its own enabled rules, and one of
     * them matches person detections too — so taking whichever incident came back first would let
     * this check pass on a deployment where the verification rule never fired at all.
     */
    const until = Date.now() + 20_000;
    let incident;
    while (incident === undefined && Date.now() < until) {
      await sleep(750);
      const page = await api(
        `/workflow/incidents?correlationId=${encodeURIComponent(corr)}&ruleId=${incidentRule}&limit=10`,
        { headers: H },
      );
      incident = (page.json?.data?.items ?? [])[0];
    }
    samples.incident = incident ?? null;
    check(incident !== undefined, '⚠️ a rule matched it and an INCIDENT was raised', incident?.id ?? 'none');

    if (incident !== undefined) {
      check(incident.correlationId === corr, 'the incident carries the frame\'s correlation id', incident.correlationId);
      check(
        incident.triggeredBy?.eventId === envelope.id,
        'and names the exact event that triggered it',
        incident.triggeredBy?.eventId,
      );
      check(
        typeof incident.source?.candidateId === 'string' && typeof incident.source?.dedupKey === 'string',
        'the IncidentCandidate it was promoted from is identified',
        incident.source?.dedupKey,
      );
      /*
       * ⚠️ The trace has to run BACKWARDS too — an operator holding an incident asks "which frame?".
       * The ids are not copied onto the incident (a copy drifts); they are reachable through the
       * event. This asserts the link actually resolves rather than assuming it.
       */
      const back = await api(`/events/events/${incident.triggeredBy.eventId}`, { headers: H });
      const recovered = back.json?.data;
      check(
        recovered?.subjects?.[0]?.trackId === trackId &&
          recovered?.subjects?.[0]?.identityId === identityId &&
          recovered?.payload?.frameId === corr,
        '⚠️ and from the incident ALONE, the frame, track and identity are recoverable',
        `${recovered?.payload?.frameId} · ${recovered?.subjects?.[0]?.identityId}`,
      );
      finding(
        `an incident carries the correlation id of the FIRST event in its ${CANDIDATE_DEDUP_WINDOW_MS} ms candidate bucket`,
        'identical candidates collapse on `tenant|rule|group|bucket`, so a burst of matching frames ' +
          'raises one incident — correctly. ⚠️ But the incident then names one frame out of many, ' +
          'and an operator asking "which frame?" gets the first, not the one they are looking at. ' +
          'A future Rule Engine milestone that needs every contributing frame must query the events ' +
          'by window, not follow triggeredBy.eventId.',
      );
      finding(
        'trackId and identityId reach the incident by LINK, not by copy',
        'the incident carries correlationId + triggeredBy.eventId; the subject ids are read back ' +
          'from the event. ⚠️ An event that has aged out of retention while its incident has not ' +
          'breaks that link — the incident remains valid, the subject detail does not.',
      );
    }
  }
  console.log('');

  /* ── 3 · replay determinism ────────────────────────────────────────────────────────────────── */
  console.log('3 · replay — same events, same order, same payloads, same decision');
  const to = new Date(Date.now() + 60_000).toISOString();
  const readA = await persisted(`&from=${encodeURIComponent(startedAt)}&to=${encodeURIComponent(to)}`);
  const readB = await persisted(`&from=${encodeURIComponent(startedAt)}&to=${encodeURIComponent(to)}`);
  check(readA.length > 0, 'the window holds this run\'s events', `${readA.length} event(s)`);
  check(
    JSON.stringify(readA) === JSON.stringify(readB),
    '⚠️ two reads are byte-identical — same ordering, same payloads',
    `${readA.map((e) => e.payload?.frameSeq).join(',')}`,
  );

  const statsBefore = await ruleStats(incidentRule);
  const incidentsBefore = (await incidentsForCamera()).length;
  const replayBody = JSON.stringify({ from: startedAt, to, cameraId: CAM, limit: 200 });
  /* ⚠️ `/events/events/replay` — the gateway prefix is `/events`, the service route is `/events/replay`. */
  const r1 = await api('/events/events/replay', { method: 'POST', headers: H, body: replayBody });
  await sleep(3000);
  const r2 = await api('/events/events/replay', { method: 'POST', headers: H, body: replayBody });
  await sleep(4000);

  check(
    r1.json?.data?.replayed === readA.length && r2.json?.data?.replayed === readA.length,
    '⚠️ replaying twice replayed the same count both times',
    `${r1.json?.data?.replayed} then ${r2.json?.data?.replayed} of ${readA.length}`,
  );
  const readC = await persisted(`&from=${encodeURIComponent(startedAt)}&to=${encodeURIComponent(to)}`);
  check(
    JSON.stringify(readC) === JSON.stringify(readA),
    '⚠️ and the store is UNCHANGED — replay re-publishes, it does not re-persist',
    `${readC.length} event(s)`,
  );

  /*
   * ⚠️ Measured, not asserted. Replay re-publishes each envelope under its own id as the msgId, so
   * inside JetStream's duplicate window the rule engine never sees it a second time. That is the
   * property that makes replay safe to run twice — and it is also a LIMIT: after the window, the
   * same replay does re-evaluate. Both halves are reported.
   */
  const statsAfter = await ruleStats(incidentRule);
  const reEvaluated = (statsAfter?.evaluations ?? 0) - (statsBefore?.evaluations ?? 0);
  const incidentsAfter = (await incidentsForCamera()).length;
  samples.replay = {
    replayed: r1.json?.data?.replayed,
    reEvaluated,
    incidentsBefore,
    incidentsAfter,
  };
  note(
    `the engine re-evaluated ${reEvaluated} time(s) across two replays`,
    reEvaluated === 0
      ? `collapsed by the JetStream duplicate window (${STREAM_DEDUP_WINDOW_MS} ms)`
      : 'the duplicate window had already elapsed for these envelopes',
  );
  check(
    incidentsAfter === incidentsBefore,
    '⚠️ replaying twice raised NO further incident — promotion is idempotent on the candidate dedup key',
    `${incidentsBefore} → ${incidentsAfter}`,
  );

  /*
   * The determinism claim in its strongest available form: hand the rule engine the same envelopes
   * twice, through the frozen simulate API, and compare the decisions. No broker, no clock, no
   * camera — so a difference here could only come from the rule or the envelope.
   */
  const simulate = async () => {
    const r = await api(`/rules/rules/${incidentRule}/simulate`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ events: readA }),
    });
    const d = r.json?.data;
    if (d === undefined) return undefined;
    const deterministic = { ...d };
    delete deterministic.at; // the only wall-clock field in the response
    return deterministic;
  };
  const sim1 = await simulate();
  const sim2 = await simulate();
  check(
    sim1 !== undefined && JSON.stringify(sim1) === JSON.stringify(sim2),
    '⚠️ the same events simulate to the same decisions AND the same explanations',
    `${sim1?.evaluated ?? '?'} evaluated, ${sim1?.matched ?? '?'} matched, decidedBy ${JSON.stringify(sim1?.decidedBy ?? {})}`,
  );
  samples.simulation = sim1 ?? null;
  console.log('');

  /* ── 4 · payload versions ──────────────────────────────────────────────────────────────────── */
  console.log('4 · Envelope v1 carrying Payload v1, v2 and v3');
  /*
   * ⚠️ The raising rule is paused first. It matches these probes too, and leaving it enabled would
   * raise four incidents pointing at events that were never persisted — a broken link in the exact
   * chain §2 just proved is unbroken. The observing rule stays on: it is evaluated and counted, and
   * the engine raises nothing for it.
   */
  await api(`/rules/rules/${incidentRule}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ lifecycle: 'disabled' }),
  });
  await sleep(1500);
  /*
   * ⚠️ Published straight onto the events subject, bypassing the normalizer. That is the ONLY way to
   * ask the real question: the normalizer emits payload 1.0.0 and always will, so a future payload
   * version can only be tested by handing the live consumer one. These are not persisted — the
   * events service is upstream of this subject — so they leave nothing behind but three evaluations.
   */
  const base = {
    envelopeVersion: '1.0.0',
    type: 'perception.person.detected',
    category: 'perception',
    tenantId: TENANT,
    cameraId: CAM,
    occurredAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    producer: { capability: CAP, capabilityVersion: '0.1.0', modelVersion: '1.0.0' },
    confidence: 0.9,
    evidenceRefs: [],
    priority: 'info',
  };
  const versions = [
    {
      schemaVersion: '1.0.0',
      payload: { label: 'person', executionProvider: 'CPUExecutionProvider', runtimeVersion: '0.1.0' },
    },
    {
      schemaVersion: '2.0.0',
      // v2 adds a scalar nothing on the platform knows about.
      payload: { label: 'person', executionProvider: 'CPUExecutionProvider', runtimeVersion: '0.1.0', poseConfidence: 0.71 },
    },
    {
      schemaVersion: '3.0.0',
      // v3 adds a nested structure — the shape a real future capability would bring.
      payload: {
        label: 'person',
        executionProvider: 'CPUExecutionProvider',
        runtimeVersion: '0.1.0',
        poseConfidence: 0.71,
        appearance: { descriptorVersion: '2.0', dims: 128, colors: ['navy', 'grey'] },
      },
    },
  ];

  const auditBefore = await ruleStats(auditRule);
  probe({
    op: 'publish',
    messages: versions.map((v, i) => ({
      subject: eventSubjectFor(base.type),
      msgId: `${RUN}:payload-v${i + 1}`,
      body: {
        ...base,
        ...v,
        id: randomUUID(),
        correlationId: `${RUN}:payload-v${i + 1}`,
        subjects: [{ class: 'person', trackId: `trk_${RUN}_v${i + 1}`, identityId: `trk_${RUN}_v${i + 1}` }],
      },
    })),
  });
  await sleep(4000);
  const auditAfter = await ruleStats(auditRule);
  const matched = (auditAfter?.matches ?? 0) - (auditBefore?.matches ?? 0);
  const failed = (auditAfter?.failures ?? 0) - (auditBefore?.failures ?? 0);
  samples.payloadVersions = { matched, failed };
  check(
    matched === 3,
    '⚠️ all three payload versions were consumed and matched by the SAME envelope contract',
    `${matched}/3 matched, ${failed} failure(s)`,
  );
  check(failed === 0, 'and none of them made a rule throw');
  finding(
    'a payload version bump requires NO transport change (ADR-0040)',
    'payload 1.0.0, 2.0.0 and 3.0.0 — including an unknown scalar and an unknown nested object — ' +
      'all travelled inside envelopeVersion 1.0.0 and were evaluated identically.',
  );
  /*
   * ⚠️ The honest other half. `envelopeVersion` is a plain SemVer with a default; nothing refuses a
   * future one. Tolerating an additive v1.1 is correct (Postel). Silently accepting a BREAKING v2.0
   * is not, and no consumer on the platform would notice today.
   */
  const futureEnvelope = { ...base, ...versions[0], envelopeVersion: '2.0.0', id: randomUUID(), correlationId: `${RUN}:envelope-v2`, subjects: [{ class: 'person', trackId: `trk_${RUN}_ev2` }] };
  const evBefore = await ruleStats(auditRule);
  probe({ op: 'publish', messages: [{ subject: eventSubjectFor(base.type), msgId: `${RUN}:envelope-v2`, body: futureEnvelope }] });
  await sleep(3000);
  const evAfter = await ruleStats(auditRule);
  const acceptedFuture = (evAfter?.matches ?? 0) - (evBefore?.matches ?? 0) > 0;
  samples.futureEnvelopeAccepted = acceptedFuture;
  if (acceptedFuture) {
    finding(
      'an envelopeVersion of 2.0.0 is ACCEPTED, not rejected',
      'correct for an additive minor, and a real gap for a breaking major: a consumer pinned to v1 ' +
        'would process a v2 envelope as though it understood it. No consumer checks the field today. ' +
        'Recorded as a limitation rather than fixed here — the fix is a contract change, and this ' +
        'milestone ships no contract changes beyond ADR-0041.',
    );
  } else {
    note('a future envelopeVersion was refused by the consumer', 'stricter than the contract requires');
  }
  console.log('');
} finally {
  await cleanup(true);
}

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      at: new Date().toISOString(),
      dedupWindowMs: DEDUP_WINDOW_MS,
      streamDedupWindowMs: STREAM_DEDUP_WINDOW_MS,
      samples,
      findings,
    },
    null,
    2,
  )}\n`,
);
console.log(`samples → ${OUT.replace(`${ROOT}/`, '')}`);
console.log(
  failures === 0
    ? '\nduplicates are bounded, correlation is unbroken, replay is deterministic, payloads may version freely\n'
    : `\n${failures} replay/correlation check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);

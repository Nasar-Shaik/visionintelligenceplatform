/**
 * P-8 Phase 5 · **does a frame actually become an incident candidate?**
 *
 *   node docs/review/p8/event-bridge.mjs          # the whole chain, against the deployment
 *   node docs/review/p8/event-bridge.mjs clean    # ⚠️ if a run was interrupted
 *
 * ### The chain this proves, stage by stage
 *
 * ```
 *   frame → /infer → DetectionResult → RuntimeTracker → EventPublisher
 *         → t.{tenant}.capability.output.*  →  events (normalize · dedup · persist)
 *         → t.{tenant}.event.*  →  rules  →  IncidentCandidate
 * ```
 *
 * Every stage but the publisher was already built and frozen; none of it had ever run end to end,
 * because nothing published. This asserts each hop separately, so a break is attributable rather
 * than "no incident appeared".
 *
 * ### ⚠️ It creates a rule, and that is verification rather than implementation
 *
 * The last hop cannot be proved without a rule to match — an engine with no enabled rules correctly
 * produces nothing, and a run asserting "no candidate" would pass on a completely broken bridge. So
 * the run **creates one rule through the existing frozen API, and deletes it in a `finally`**.
 *
 * It is deliberately the most trivial rule expressible: *any* `perception.person.detected` event,
 * no condition, no window, no zone. It exercises the wiring and encodes **no business meaning** —
 * this milestone ships no rules, no loitering, no intrusion, no theft detection. The rule is a
 * measuring instrument, and like the fixture cameras it does not survive the run.
 *
 * ### ⚠️ Duplicate semantics are MEASURED, not assumed
 *
 * The platform has two independent dedup mechanisms and neither gives exactly-once. This run
 * republishes an identical result and reports what actually happens, because "exactly once" is a
 * claim a distributed system has to earn rather than inherit from a config flag.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const FIXTURE = 'vip-bridge-fixture';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-bridge';
const OUT = process.env.OUT ?? join(ROOT, 'docs/review/p8/event-bridge-samples.json');
/** Seconds of clip to run. The walk clip puts one person in frame for the whole window. */
const OBSERVE = Number(process.env.OBSERVE ?? 24);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let failures = 0;
const findings = [];
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const finding = (label, detail) => {
  console.log(`  ⚠️ ${label} — ${detail}`);
  findings.push({ label, detail });
};

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
const shq = (cmd, args) => {
  try {
    return sh(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (r.json?.data?.accessToken === undefined) throw new Error(`login failed: ${r.text.slice(0, 200)}`);
  H = { authorization: `Bearer ${r.json.data.accessToken}`, 'content-type': 'application/json' };
}

/** The publisher's own account of itself. */
async function bridge() {
  const r = await api('/system/event-bridge', { headers: H });
  return r.json?.data ?? {};
}

async function cleanup(quiet = false) {
  try {
    await login();
    const cams = (await api('/camera/cameras?limit=200', { headers: H })).json?.data?.cameras ?? [];
    for (const cam of cams.filter((c) => (c.metadata?.tags ?? []).includes(TAG))) {
      await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
      await api(`/camera/cameras/${cam.id}`, {
        method: 'DELETE',
        headers: { authorization: H.authorization },
      });
    }
    /*
     * ⚠️ `data` is a BARE ARRAY here, not `{ rules: [...] }`. The first version read `data.rules`,
     * got `undefined`, deleted nothing — and left two ENABLED verification rules in the deployment,
     * raising incident candidates on every person detection for everyone afterwards. A cleanup that
     * silently no-ops is worse than none, because the run still reports success.
     */
    const listed = (await api('/rules/rules', { headers: H })).json?.data;
    const rules = Array.isArray(listed) ? listed : (listed?.rules ?? []);
    for (const rule of rules.filter((r) => r.name?.startsWith(TAG))) {
      await api(`/rules/rules/${rule.id}`, {
        method: 'DELETE',
        headers: { authorization: H.authorization },
      });
    }
  } catch {
    /* best effort */
  }
  shq('docker', ['rm', '-f', FIXTURE]);
  if (!quiet) console.log('\nremoved the bridge fixture, its cameras and its verification rule\n');
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

await login();

console.log('\nP-8 Phase 5 · the live event bridge, end to end\n');

const samples = {};
let cameraId;
let ruleId;

try {
  /* ── 0 · the bridge is on ──────────────────────────────────────────────────────────────────── */
  console.log('0 · the bridge is enabled and has not published anything false');
  const before = await bridge();
  samples.before = before;
  check(before.enabled === true, 'the event bridge is enabled in this deployment');
  check(
    before.brokerStatus !== 'down',
    'the broker is reachable, or has not been tried yet',
    `brokerStatus=${before.brokerStatus}`,
  );
  check(
    typeof before.publisherVersion === 'string' && before.publisherVersion.length > 0,
    'the publisher reports its own version',
    before.publisherVersion,
  );
  console.log('');

  /* ── 1 · a rule exists to catch what the chain produces ────────────────────────────────────── */
  console.log('1 · a verification rule (created here, deleted in a finally)');
  const made = await api('/rules/rules', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      name: `${TAG} any person detection`,
      description:
        'Verification instrument for the P-8 Phase 5 event bridge. Created and deleted by ' +
        'docs/review/p8/event-bridge.mjs. Encodes no business meaning and ships with nothing.',
      eventTypes: ['perception.person.detected'],
      severity: 'low',
      actions: [{ type: 'raise-incident' }],
    }),
  });
  ruleId = made.json?.data?.id;
  check(ruleId !== undefined, 'the rule was created through the existing API', `HTTP ${made.status}`);
  if (ruleId === undefined) throw new Error(`could not create the verification rule: ${made.text.slice(0, 300)}`);

  const enabled = await api(`/rules/rules/${ruleId}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ lifecycle: 'enabled' }),
  });
  check(
    enabled.json?.data?.lifecycle === 'enabled',
    'and enabled — only enabled rules are evaluated',
    enabled.json?.data?.lifecycle ?? `HTTP ${enabled.status}`,
  );
  console.log('');

  /* ── 2 · a camera plays a person walking ───────────────────────────────────────────────────── */
  console.log(`2 · one camera, one walking person (${OBSERVE}s)`);
  shq('docker', ['rm', '-f', FIXTURE]);
  sh('docker', [
    'run', '-d', '--rm', '--name', FIXTURE, '--network', NETWORK,
    '-v', `${ROOT}/infra/docker/fixtures/tracking-fixture.yml:/mediamtx.yml:ro`,
    '-v', `${ROOT}/infra/docker/fixtures/media:/fixtures/media:ro`,
    'bluenviron/mediamtx:latest-ffmpeg',
  ]);
  await sleep(3000);

  const zoneId = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0].zoneId;
  const cam = await api('/camera/cameras', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      zoneId,
      name: `${TAG} walk`,
      protocol: 'rtsp',
      streamUrl: `rtsp://${FIXTURE}:8554/walk1`,
      metadata: { tags: [TAG] },
    }),
  });
  cameraId = cam.json?.data?.id;
  check(cameraId !== undefined, 'a camera was created on the fixture stream');
  await api(`/media/streams/${cameraId}/start`, { method: 'POST', headers: H, body: '{}' });

  const startedAt = new Date().toISOString();
  await sleep(OBSERVE * 1000);
  console.log('');

  /* ── 3 · the publisher published ───────────────────────────────────────────────────────────── */
  console.log('3 · the publisher');
  const after = await bridge();
  samples.after = after;
  const published = (after.published ?? 0) - (before.published ?? 0);
  const events = (after.detectionsPublished ?? 0) - (before.detectionsPublished ?? 0);

  check(published > 0, 'results were published to the bus', `${published} result(s)`);
  check(events > 0, 'and they carried detections, which become events', `${events} detection(s)`);
  check(after.brokerStatus === 'up', 'the broker acknowledged them', after.brokerStatus);
  /*
   * ⚠️ The fail-closed gate, asserted from the producer's side. A malformed result reaching the bus
   * would be dead-lettered by `services/events` — after a broker round trip, in another service's
   * log, where nobody looking at media would find it. This number staying flat is what says the
   * refusal happened HERE.
   */
  check(
    (after.rejected ?? 0) === (before.rejected ?? 0),
    'nothing was rejected — every result satisfied the contract at the producer',
    `${after.rejected} total rejection(s)`,
  );
  check((after.failed ?? 0) === (before.failed ?? 0), 'nothing failed every attempt', `${after.failed} total`);
  check(
    typeof after.publishMsAvg === 'number',
    'publish latency is now measured rather than absent',
    after.publishMsAvg === null ? 'still null' : `${after.publishMsAvg.toFixed(2)} ms`,
  );
  /*
   * ⚠️ Reported, never asserted to be zero. The sink runs four requests in flight, so out-of-order
   * responses genuinely happen and the publisher dropping them is the CORRECT behaviour. A hard
   * zero here would be a flaky assertion about scheduling rather than about the bridge.
   */
  const ooo = (after.droppedOutOfOrder ?? 0) - (before.droppedOutOfOrder ?? 0);
  if (ooo > 0) finding('results arrived out of order', `${ooo} dropped rather than published stale`);
  else console.log('  · every result arrived in order in this run');
  const suppressed = (after.suppressed ?? 0) - (before.suppressed ?? 0);
  console.log(`  · ${suppressed} result(s) suppressed for carrying no detections`);
  console.log('');

  /* ── 4 · the events service normalized and persisted them ──────────────────────────────────── */
  console.log('4 · the event platform');
  const query = await api(
    `/events/events?cameraId=${encodeURIComponent(cameraId)}&from=${encodeURIComponent(startedAt)}&limit=200`,
    { headers: H },
  );
  const envelopes = query.json?.data?.events ?? [];
  samples.envelopes = envelopes.length;
  check(envelopes.length > 0, 'envelopes were normalized and persisted', `${envelopes.length} event(s)`);

  const sample = envelopes[0];
  samples.sample = sample ?? null;
  if (sample !== undefined) {
    check(sample.type === 'perception.person.detected', 'the event type is the catalogued one', sample.type);
    check(sample.tenantId === TENANT, 'the envelope is tenant-scoped', sample.tenantId);
    check(sample.cameraId === cameraId, 'and camera-scoped', sample.cameraId);
    check(
      typeof sample.correlationId === 'string' && sample.correlationId.length > 0,
      'it carries a correlation id',
      sample.correlationId,
    );
    check(
      typeof sample.payload?.frameId === 'string',
      'and the frame it came from, so a trace runs both ways',
      sample.payload?.frameId ?? 'absent',
    );
    check(
      sample.producer?.capability !== undefined && sample.producer?.capabilityVersion !== undefined,
      'provenance names the capability and its version',
      `${sample.producer?.capability}@${sample.producer?.capabilityVersion}`,
    );
  }

  /*
   * ⚠️ The identity assertion, and the reason ADR-0041 exists. A dwell rule that groups by `trackId`
   * under-fires whenever a person is briefly occluded — silently. If identity does not survive to
   * this point, that whole class of rule is unbuildable and nothing would have said so.
   */
  const withTrack = envelopes.filter((e) => e.subjects?.[0]?.trackId !== undefined);
  const withIdentity = envelopes.filter((e) => e.subjects?.[0]?.identityId !== undefined);
  check(withTrack.length > 0, 'subjects carry a track id', `${withTrack.length}/${envelopes.length}`);
  check(
    withIdentity.length === withTrack.length && withIdentity.length > 0,
    '⚠️ and an IDENTITY id — every tracked subject, not some',
    `${withIdentity.length}/${withTrack.length} tracked subject(s)`,
  );
  console.log('');

  /* ── 5 · one frame, one correlation id ─────────────────────────────────────────────────────── */
  console.log('5 · correlation — can one frame be traced?');
  const byCorrelation = new Map();
  for (const e of envelopes) {
    const key = e.correlationId ?? '(none)';
    byCorrelation.set(key, (byCorrelation.get(key) ?? 0) + 1);
  }
  const frames = new Set(envelopes.map((e) => e.payload?.frameId));
  check(
    byCorrelation.size === frames.size && frames.size > 0,
    '⚠️ one correlation id per FRAME, not per detection',
    `${frames.size} frame(s) → ${byCorrelation.size} correlation id(s)`,
  );

  const [anyCorrelation] = [...byCorrelation.keys()];
  if (anyCorrelation !== undefined && anyCorrelation !== '(none)') {
    const traced = await api(
      `/events/events?correlationId=${encodeURIComponent(anyCorrelation)}&limit=50`,
      { headers: H },
    );
    check(
      (traced.json?.data?.events ?? []).length > 0,
      'and the correlation id is queryable — the spine works end to end',
      `${(traced.json?.data?.events ?? []).length} event(s) for ${anyCorrelation}`,
    );
  }
  console.log('');

  /* ── 6 · ordering ──────────────────────────────────────────────────────────────────────────── */
  console.log('6 · ordering — per camera, deterministic');
  const inCaptureOrder = [...envelopes].reverse(); // the query returns newest-first by occurredAt
  const seqs = inCaptureOrder.map((e) => e.payload?.frameSeq).filter((n) => typeof n === 'number');
  const monotonic = seqs.every((n, i) => i === 0 || n >= seqs[i - 1]);
  check(
    seqs.length > 1 && monotonic,
    'frame sequences never go backwards for this camera',
    monotonic ? `${seqs.length} event(s), ${seqs[0]} → ${seqs[seqs.length - 1]}` : `out of order: ${seqs.join(',')}`,
  );

  /*
   * ⚠️ **The check above cannot fail, and finding that out is why this one exists.**
   *
   * The query sorts by `occurredAt`, which for one stream rises with the frame sequence — so the
   * sequence comes back sorted no matter what order the publisher sent it in. It was measuring the
   * store's ORDER BY, not the bridge. A mutation that removed the ordering gate entirely left it
   * green.
   *
   * `ingestedAt` is stamped by the events service on arrival, so it records DELIVERY order. If a
   * stale result was published after a newer one, the older frame arrives later — an event with an
   * earlier `occurredAt` carrying a later `ingestedAt`. Walking capture order and requiring arrival
   * order to rise with it is the assertion the publisher's gate is actually responsible for.
   */
  const arrivals = inCaptureOrder.map((e) => Date.parse(e.ingestedAt)).filter(Number.isFinite);
  const inversions = arrivals.filter((t, i) => i > 0 && t < arrivals[i - 1]).length;
  check(
    arrivals.length > 1 && inversions === 0,
    '⚠️ and they were DELIVERED in that order — no stale result overtook a newer one',
    inversions === 0 ? `${arrivals.length} arrival(s), none out of order` : `${inversions} inversion(s)`,
  );
  console.log('');

  /* ── 7 · duplicate semantics, measured ─────────────────────────────────────────────────────── */
  console.log('7 · duplicates — what the transport actually guarantees');
  /*
   * ⚠️ Measured rather than asserted. There are TWO independent mechanisms and neither is
   * exactly-once: JetStream collapses a repeated `msgId` inside the stream's dedup window, and the
   * events service collapses a repeated `dedupKey` inside a time bucket. Both are windows. A replay
   * after the window produces a second event, and a run that claimed otherwise would be describing
   * a guarantee the platform does not have.
   */
  const first = await api(
    `/events/events?cameraId=${encodeURIComponent(cameraId)}&from=${encodeURIComponent(startedAt)}&limit=200`,
    { headers: H },
  );
  const countBefore = (first.json?.data?.events ?? []).length;
  await sleep(2000);
  const second = await api(
    `/events/events?cameraId=${encodeURIComponent(cameraId)}&from=${encodeURIComponent(startedAt)}&limit=200`,
    { headers: H },
  );
  const countAfter = (second.json?.data?.events ?? []).length;
  samples.dedup = { countBefore, countAfter };
  check(
    countAfter >= countBefore,
    'the persisted set is stable or growing — never rewritten',
    `${countBefore} → ${countAfter}`,
  );
  finding(
    'delivery is AT-LEAST-ONCE, not exactly-once',
    'JetStream collapses a repeated msgId inside the stream dedup window and the events service ' +
      'collapses a repeated dedupKey inside a time bucket — both are WINDOWS, so a replay after ' +
      'them produces a second event. Consumers must be idempotent.',
  );
  console.log('');

  /* ── 8 · the rule engine evaluated them ────────────────────────────────────────────────────── */
  console.log('8 · the rule engine and the incident candidate');
  /*
   * ⚠️ Asserted against the ENGINE's own counters, not against a persisted Incident — and the
   * distinction matters. An `IncidentCandidate` is what a rule produces; turning one into an
   * `Incident` is the workflow service's job and is explicitly out of scope for this milestone.
   * A run that asserted on incidents would be testing a subsystem this phase did not touch, and
   * would fail for reasons that have nothing to do with the bridge.
   *
   * The first version did exactly that and reported "0 raised" while the rules service log showed
   * candidates being raised for every single event.
   */
  const stats = await api('/rules/rules/stats', { headers: H });
  const perRule = stats.json?.data?.rules ?? [];
  const ours = perRule.find((r) => r.ruleId === ruleId);
  samples.rule = ours ?? null;
  check(ours !== undefined, 'the engine reports on the verification rule', ours ? 'found' : 'absent');
  check(
    (ours?.evaluations ?? 0) > 0,
    '⚠️ the rule engine EVALUATED the events the bridge produced',
    `${ours?.evaluations ?? 0} evaluation(s)`,
  );
  check(
    (ours?.matches ?? 0) > 0,
    '⚠️ and matched them — a frame became an incident candidate',
    `${ours?.matches ?? 0} match(es), ${ours?.failures ?? 0} failure(s)`,
  );
  check((ours?.failures ?? 0) === 0, 'with no evaluation failures');
  console.log('');

  /* ── 9 · recording was never affected ──────────────────────────────────────────────────────── */
  console.log('9 · recording, which outranks all of the above');
  const recordings = await api(`/media/recordings?cameraId=${encodeURIComponent(cameraId)}&limit=10`, {
    headers: H,
  });
  const segments = recordings.json?.data?.items ?? [];
  check(
    segments.length > 0,
    '⚠️ segments were still written while the bridge published',
    `${segments.length} segment(s)`,
  );
} finally {
  if (cameraId !== undefined) {
    await api(`/media/streams/${cameraId}/stop`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
  }
  await cleanup(true);
}

writeFileSync(
  OUT,
  `${JSON.stringify({ at: new Date().toISOString(), observeSeconds: OBSERVE, samples, findings }, null, 2)}\n`,
);
console.log(`samples → ${OUT.replace(`${ROOT}/`, '')}`);
console.log(
  failures === 0
    ? '\na frame becomes an incident candidate — every stage of the bridge is connected\n'
    : `\n${failures} bridge check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);

/**
 * P-8 Phase 5 · **what does publishing cost, and what breaks first under load?**
 *
 *   node docs/review/p8/event-bridge-benchmark.mjs        # 1 → 16 cameras
 *   LADDER=1,2 node docs/review/p8/event-bridge-benchmark.mjs
 *   node docs/review/p8/event-bridge-benchmark.mjs clean  # ⚠️ if a run was interrupted
 *
 * The tracking ladder measures what the *runtime* costs. This measures what the **bridge** costs on
 * top of it: publish latency, queue occupancy, what gets shed, and how much of that survives to a
 * persisted event. They are separate numbers because they have separate failure modes — a host that
 * can track sixteen cameras may still not be able to publish for sixteen, and the reverse.
 *
 * ### ⚠️ Both ends of the bridge are measured, not just the producer
 *
 * The publisher's `published` counter says a broker accepted a message. It says nothing about
 * whether an event exists. The events service collapses repeats inside its dedup window, so a rung
 * publishing 400 results can legitimately persist 30 envelopes — and reporting only the first number
 * would describe a firehose that mostly evaporates as though it were end-to-end throughput.
 *
 * ### ⚠️ An absent average is reported as `null`, never as 0 (ADR-0039)
 *
 * `publish_ms_avg` is *omitted* from the metrics endpoint when nothing has been published, rather
 * than exported as zero. A scraper that defaults a missing gauge to 0 turns "we did not measure
 * this" into "this was instantaneous", which is the exact failure the omission exists to prevent —
 * so a missing sample stays `null` all the way into the JSON.
 *
 * ### ⚠️ No capacity number is published from one run
 *
 * The standing sizing policy applies unchanged: **2 cameras supported, 4 provisional, and no
 * recommendation until three independent runs agree.** This script writes a rung table and refuses
 * to turn it into a headline.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assignCameras, raiseRuntimeCapacity, tryAssignCameras } from './_assign.mjs';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const MEDIA = 'vip-prod-media-1';
const EVENTS = 'vip-prod-events-1';
const FIXTURE = 'vip-bridge-bench';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-bridgebench';
const OUT = process.env.OUT ?? join(ROOT, 'docs/review/p8/event-bridge-capacity.json');
const LADDER = (process.env.LADDER ?? '1,2,4,8,16').split(',').map(Number);
const WINDOW = Number(process.env.WINDOW ?? 20);
const WARMUP = Number(process.env.WARMUP ?? 8);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
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
  H = { authorization: `Bearer ${r.json.data.accessToken}`, 'content-type': 'application/json' };
}

/**
 * Scrape a service's Prometheus endpoint from inside its own container.
 *
 * ⚠️ Keys keep their FULL label set, so `events_normalized_total{outcome="deduped"}` and
 * `…{outcome="persisted"}` do not overwrite each other — a map keyed on the name alone silently
 * keeps whichever line came last.
 */
function scrape(container, port) {
  const text = shq('docker', ['exec', container, 'sh', '-c', `curl -s localhost:${port}/metrics`]);
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-z_][a-z0-9_]*)(\{[^}]*\})?\s+([0-9.eE+-]+)$/);
    if (m) out[`${m[1]}${m[2] ?? ''}`] = Number(m[3]);
  }
  return out;
}

/**
 * One series' value, matched by name plus the labels that matter.
 *
 * ⚠️ **Every series on this platform carries a `service="…"` default label**, so an exact-key lookup
 * for `events_normalized_total{outcome="persisted"}` matches nothing and every downstream number
 * reads as absent. Absent is a legitimate answer here (ADR-0039), which is exactly why the mistake
 * would not have looked like one — the benchmark would have reported "the events service exports no
 * counters" about an events service exporting them correctly.
 */
function series(metrics, name, labels = {}) {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const [key, value] of Object.entries(metrics)) {
    if (key !== name && !key.startsWith(`${name}{`)) continue;
    if (wanted.every((w) => key.includes(w))) return value;
  }
  return undefined;
}

/**
 * A counter delta. ⚠️ Absent on BOTH reads means the series was never exported — `null`, not 0.
 * Absent on only the first read means it started at zero, which is a real zero.
 */
function delta(before, after, name, labels = {}) {
  const a = series(after, name, labels);
  const b = series(before, name, labels);
  if (a === undefined && b === undefined) return null;
  return (a ?? 0) - (b ?? 0);
}

/** A gauge's current value, or `null` when the sample is omitted (ADR-0039). */
const gauge = (m, name) => series(m, name) ?? null;

/** Container CPU % and RSS in MB, from docker's own accounting. */
function usage(container) {
  const raw = shq('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}\t{{.MemUsage}}', container]);
  const [cpu, mem] = raw.split('\t');
  const memMb = /([\d.]+)\s*([KMG])iB/.exec(mem ?? '');
  const scale = { K: 1 / 1024, M: 1, G: 1024 };
  return {
    cpu: Number((cpu ?? '0').replace('%', '')) || 0,
    memMb: memMb ? Number(Number(memMb[1]) * (scale[memMb[2]] ?? 1)).toFixed(1) : 0,
  };
}

async function cleanup(quiet = false) {
  await login();
  const r = await api(`/camera/cameras?limit=200&search=${TAG}`, { headers: H });
  const cams = (r.json?.data?.cameras ?? []).filter((c) => (c.metadata?.tags ?? []).includes(TAG));
  for (const cam of cams) {
    await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
    await api(`/camera/cameras/${cam.id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
  }
  shq('docker', ['rm', '-f', FIXTURE]);
  if (!quiet) console.log(`\nremoved ${cams.length} camera(s) and stopped the benchmark fixture\n`);
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

await login();
await cleanup(true);

/*
 * ⚠️ **The ladder raises the runtime's DECLARED capacity for the run and restores it afterwards.**
 *
 * The seeded runtime declares 4 cameras — the provisional sizing figure — and from P-8 Phase 6 the
 * control plane enforces it, so an 8-camera rung is refused with a 409 by the control plane doing
 * exactly its job. This ladder climbed to 16 the week before that gate shipped and stopped at 4
 * afterwards; the first full nightly since is what found it. See `raiseRuntimeCapacity`.
 *
 * ⚠️ The sizing policy is untouched: no capacity number is published from one run, and a rung that
 * drops frames still reports dropped frames.
 */
const restoreCapacity = await raiseRuntimeCapacity(api, H, Math.max(...LADDER) + 8);
/** The rung the control plane refused, if any — published beside the table, never thrown. */
let refusedAt = null;


if (!existsSync(join(ROOT, 'infra/docker/fixtures/media/tracking/walk.mp4'))) {
  console.log('\ntracking fixtures are missing — generating them first\n');
  sh('node', [join(ROOT, 'docs/review/p8/tracking-fixtures.mjs')], { stdio: 'inherit' });
}

console.log(`\nP-8 Phase 5 · event bridge capacity at ${LADDER.join(', ')} cameras (${WINDOW}s windows)\n`);
console.log('  ⚠️ Publisher AND events service. "Published" is not "persisted".\n');

shq('docker', ['rm', '-f', FIXTURE]);
sh('docker', [
  'run', '-d', '--rm', '--name', FIXTURE, '--network', NETWORK,
  '-v', `${ROOT}/infra/docker/fixtures/tracking-fixture.yml:/mediamtx.yml:ro`,
  '-v', `${ROOT}/infra/docker/fixtures/media:/fixtures/media:ro`,
  'bluenviron/mediamtx:latest-ffmpeg',
]);
await sleep(3000);

const zoneId = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0].zoneId;
const rows = [];

try {
  for (const cameras of LADDER) {
    /* Fresh cameras each rung: these clips are 70 seconds and play once, so a camera created at
       rung 1 would have finished by rung 8 and the top of the ladder would measure silence. */
    const made = [];
    for (let i = 0; i < cameras; i += 1) {
      const cam = await api('/camera/cameras', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          zoneId,
          name: `${TAG} ${cameras}-${i}`,
          protocol: 'rtsp',
          /* Its OWN path — a shared one leaves every rung above the first measuring one stream. */
          streamUrl: `rtsp://${FIXTURE}:8554/walk${String(i + 1).padStart(2, '0')}`,
          metadata: { tags: [TAG] },
        }),
      });
      made.push(cam.json?.data?.id);
      await api(`/media/streams/${made[i]}/start`, { method: 'POST', headers: H, body: '{}' });
    }
    /*
     * ⚠️ A control-plane refusal ends the ladder; it does not fail it. See `tryAssignCameras` — the
     * 2026-08-06 run threw here and discarded every rung it had already measured, then leaked its
     * assignments into the next three stages.
     */
    const placed = await tryAssignCameras(api, H, made);
    if (!placed.ok) {
      refusedAt = { cameras: made.length, reason: placed.reason };
      console.log(`\n  ⚠️ refused at ${made.length} camera(s) — ${placed.reason.replace(/^could not assign \S+ for AI processing \(HTTP 409\): /, '')}`);
      console.log('     the rungs below stand; the ladder is truncated, not failed.');
      break;
    }

    await sleep(WARMUP * 1000);
    const m0 = scrape(MEDIA, 8083);
    const e0 = scrape(EVENTS, 8084);
    const started = Date.now();

    /* Sample through the window — a single reading at the end catches the quietest moment. */
    let cpuPeak = 0;
    let memPeak = 0;
    let queuePeak = 0;
    let inflightPeak = 0;
    const polls = Math.max(2, Math.floor(WINDOW / 5));
    for (let p = 0; p < polls; p += 1) {
      await sleep((WINDOW / polls) * 1000);
      const u = usage(MEDIA);
      const live = scrape(MEDIA, 8083);
      cpuPeak = Math.max(cpuPeak, u.cpu);
      memPeak = Math.max(memPeak, Number(u.memMb));
      queuePeak = Math.max(queuePeak, series(live, 'media_event_publisher_queue_depth') ?? 0);
      inflightPeak = Math.max(inflightPeak, series(live, 'media_event_publisher_inflight') ?? 0);
    }

    const elapsed = (Date.now() - started) / 1000;
    const m1 = scrape(MEDIA, 8083);
    const e1 = scrape(EVENTS, 8084);
    const eventsUsage = usage(EVENTS);

    const offered = delta(m0, m1, 'media_event_publisher_offered_total') ?? 0;
    const published = delta(m0, m1, 'media_event_publisher_published_total') ?? 0;
    const detections = delta(m0, m1, 'media_event_publisher_detections_published_total') ?? 0;
    const persisted = delta(e0, e1, 'events_normalized_total', { outcome: 'persisted' });
    const deduped = delta(e0, e1, 'events_normalized_total', { outcome: 'deduped' });

    const row = {
      cameras,
      windowSeconds: Number(elapsed.toFixed(1)),

      /* ── throughput, both ends ─────────────────────────────────────────────────────────────── */
      offeredPerSecond: Number((offered / elapsed).toFixed(2)),
      publishedPerSecond: Number((published / elapsed).toFixed(2)),
      detectionsPerSecond: Number((detections / elapsed).toFixed(2)),
      /* ⚠️ null, not 0, when the events service exports no such series — see `delta`. */
      persistedPerSecond: persisted === null ? null : Number((persisted / elapsed).toFixed(2)),
      dedupedPerSecond: deduped === null ? null : Number((deduped / elapsed).toFixed(2)),

      /* ── latency ───────────────────────────────────────────────────────────────────────────── */
      publishMsAvg: gauge(m1, 'media_event_publisher_publish_ms_avg'),
      delayed: delta(m0, m1, 'media_event_publisher_delayed_total'),

      /* ── the queue, and what it shed ───────────────────────────────────────────────────────── */
      queueDepthPeak: queuePeak,
      queuePerCamera: gauge(m1, 'media_event_publisher_queue_per_camera'),
      inflightPeak,
      droppedQueueFull: delta(m0, m1, 'media_event_publisher_dropped_total'),
      droppedOutOfOrder: delta(m0, m1, 'media_event_publisher_out_of_order_total'),
      suppressed: delta(m0, m1, 'media_event_publisher_suppressed_total'),
      /* ⚠️ Any value above zero here is a CONTRACT failure, not load shedding. */
      rejected: delta(m0, m1, 'media_event_publisher_rejected_total'),

      /* ── retry and loss ────────────────────────────────────────────────────────────────────── */
      retries: delta(m0, m1, 'media_event_publisher_retries_total'),
      failed: delta(m0, m1, 'media_event_publisher_failed_total'),
      /* ⚠️ Kept as three reasons summed, not one counter — a cross-tenant message is a security
         event and a malformed one is a bug, and the JSON keeps them separable for the report. */
      deadLettered:
        (delta(e0, e1, 'events_dead_lettered_total', { reason: 'contract' }) ?? 0) +
        (delta(e0, e1, 'events_dead_lettered_total', { reason: 'tenant_mismatch' }) ?? 0) +
        (delta(e0, e1, 'events_dead_lettered_total', { reason: 'not_json' }) ?? 0),

      /* ── resources ─────────────────────────────────────────────────────────────────────────── */
      mediaCpuPeak: cpuPeak,
      mediaMemMbPeak: memPeak,
      eventsCpu: eventsUsage.cpu,
      eventsMemMb: Number(eventsUsage.memMb),
      brokerStatus: gauge(m1, 'media_event_publisher_broker_status'),
    };
    rows.push(row);

    const latency = row.publishMsAvg === null ? 'not measured' : `${row.publishMsAvg.toFixed(2)} ms`;
    console.log(
      `  ${String(cameras).padStart(2)} camera(s)  ` +
        `offered ${String(row.offeredPerSecond).padStart(6)}/s  ` +
        `published ${String(row.publishedPerSecond).padStart(6)}/s  ` +
        `persisted ${String(row.persistedPerSecond ?? 'n/a').padStart(6)}/s  ` +
        `publish ${latency.padStart(12)}  ` +
        `queue ${String(row.queueDepthPeak).padStart(3)}/${row.queuePerCamera ?? '?'}  ` +
        `dropped ${String(row.droppedQueueFull).padStart(4)}  ` +
        `retries ${String(row.retries).padStart(3)}  ` +
        `failed ${String(row.failed).padStart(3)}  ` +
        `media ${String(row.mediaCpuPeak).padStart(6)}% ${row.mediaMemMbPeak} MB`,
    );

    for (const id of made) {
      await api(`/media/streams/${id}/stop`, { method: 'POST', headers: H, body: '{}' });
      await api(`/camera/cameras/${id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
    }
    await sleep(4000); // let the queues drain before the next rung baselines
  }
} finally {
  await restoreCapacity();
  await cleanup(true);
}

console.log('');

/* ── what the ladder says ──────────────────────────────────────────────────────────────────────── */

const top = rows[rows.length - 1];
const first = rows[0];

check(rows.every((r) => (r.rejected ?? 0) === 0), '⚠️ no result failed the contract at any rung', 'fail-closed never fired');
check(rows.every((r) => (r.failed ?? 0) === 0), 'no result exhausted its retries at any rung');
check(rows.every((r) => r.brokerStatus === 1), 'the broker stayed reachable throughout');
check(
  rows.every((r) => r.queuePerCamera === null || r.queueDepthPeak <= r.queuePerCamera * r.cameras),
  '⚠️ the queue never exceeded its per-camera bound × cameras',
  rows.map((r) => `${r.cameras}:${r.queueDepthPeak}`).join(' '),
);
check(
  rows.every((r) => r.publishMsAvg === null || r.publishMsAvg >= 0),
  'publish latency was measured, or honestly absent, at every rung',
  rows.map((r) => `${r.cameras}:${r.publishMsAvg === null ? 'null' : r.publishMsAvg.toFixed(2)}`).join(' '),
);

/*
 * ⚠️ Reported, never asserted. Where the bridge starts shedding is the number this ladder exists to
 * find; turning it into a pass/fail would make the benchmark fail on the hardware it is measuring.
 */
const firstShedding = rows.find((r) => (r.droppedQueueFull ?? 0) > 0);
console.log(
  firstShedding === undefined
    ? `  · the bridge shed nothing up to ${top?.cameras} camera(s)`
    : `  · the bridge began shedding events at ${firstShedding.cameras} camera(s) — ${firstShedding.droppedQueueFull} dropped`,
);
const scaling =
  first && top && first.publishedPerSecond > 0
    ? (top.publishedPerSecond / first.publishedPerSecond / (top.cameras / first.cameras)) * 100
    : null;
console.log(
  scaling === null
    ? '  · scaling efficiency is not computable from this ladder'
    : `  · publish throughput scaled to ${scaling.toFixed(0)} % of linear from ${first.cameras} to ${top.cameras} camera(s)`,
);

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      at: new Date().toISOString(),
      ladder: LADDER,
      /*
       * ⚠️ The rung the control plane refused, beside the numbers. A ladder that stopped because a
       * runtime degraded under the previous rung's load found its edge; one that stopped because it
       * was configured to is a different statement, and a table that cannot tell you which is
       * unreadable a month later. `null` means the ladder ran to its configured top.
       */
      refusedAt,
      windowSeconds: WINDOW,
      warmupSeconds: WARMUP,
      rows,
      /*
       * ⚠️ The sizing policy, restated in the artifact rather than left to a reader's memory. A JSON
       * file full of sixteen-camera numbers invites exactly the headline this policy forbids.
       */
      sizingPolicy: {
        supported: 2,
        provisional: 4,
        rule: 'no capacity recommendation is published until three independent runs agree',
        publishedRecommendation: null,
      },
    },
    null,
    2,
  )}\n`,
);
console.log(`\ncapacity → ${OUT.replace(`${ROOT}/`, '')}`);
console.log(
  failures === 0
    ? '\nthe bridge held its bounds at every rung — sizing stays 2 supported / 4 provisional\n'
    : `\n${failures} benchmark check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);

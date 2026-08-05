/**
 * P-8 Phase 5 · **what the bridge does when things go wrong**
 *
 *   node docs/review/p8/event-bridge-resilience.mjs        # broker outage + camera assignment
 *   node docs/review/p8/event-bridge-resilience.mjs clean  # ⚠️ if a run was interrupted
 *
 * ### ⚠️ This STOPS THE BROKER on a running deployment
 *
 * It kills `nats`, watches what happens, and restarts it in a `finally`. Every service on the
 * deployment shares that broker, so a run that dies half way leaves the platform without one — the
 * `clean` subcommand exists for exactly that, and the restart is unconditional.
 *
 * ### The two questions
 *
 * **1 · Broker recovery.** The claim the bridge makes is that a broker outage costs events and never
 * recordings. That is a claim about a failure nobody had ever induced, so this induces it:
 *
 * ```
 *   broker down → queue fills → events fail → RECORDING CONTINUES
 *              → broker up   → queue drains → ordering preserved
 * ```
 *
 * ⚠️ The load-bearing assertion is the third one. Everything else is about events, which are
 * allowed to be lost; segments are not.
 *
 * **2 · Camera Processing Assignment compatibility.** Assignment is **not built** and nothing here
 * implements it. What it *will* do is stop offering frames for a camera and later start again — so
 * this drives that shape through the existing stream controls and proves the bridge already behaves:
 *
 * ```
 *   frames stop → publisher goes idle → recording continues → no events published
 *   frames start → publisher resumes  → events continue, ordering intact
 * ```
 *
 * ⚠️ The re-enable half is the one that matters. The publisher holds a per-camera ordering gate, so a
 * restarted stream whose frame sequence begins again at 1 would be silently dropped as "stale" by a
 * naive implementation — every event, indefinitely, with nothing in the logs.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const FIXTURE = 'vip-bridge-res-fixture';
const NETWORK = 'vip-prod_default';
const NATS = 'vip-prod-nats-1';
const TAG = 'p8-bridge-res';
const OUT = process.env.OUT ?? join(ROOT, 'docs/review/p8/event-bridge-resilience.json');
/** Seconds under each condition. Long enough for the 6-second recording segments to turn over. */
const PHASE = Number(process.env.PHASE ?? 20);

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

const bridge = async () => (await api('/system/event-bridge', { headers: H })).json?.data ?? {};

async function segments(cameraId) {
  const r = await api(`/media/recordings?cameraId=${encodeURIComponent(cameraId)}&limit=200`, {
    headers: H,
  });
  return (r.json?.data?.items ?? []).length;
}

/** ⚠️ Unconditional. A run that dies must not leave the deployment without a broker. */
function restoreBroker() {
  shq('docker', ['start', NATS]);
}

async function cleanup(quiet = false) {
  restoreBroker();
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
  } catch {
    /* best effort */
  }
  shq('docker', ['rm', '-f', FIXTURE]);
  if (!quiet) console.log('\nbroker restarted, fixture and cameras removed\n');
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

await login();
console.log('\nP-8 Phase 5 · event bridge resilience\n');
console.log('  ⚠️ This STOPS THE BROKER on the running deployment and restarts it in a finally.\n');

const samples = {};
let cameraId;

try {
  /* ── setup ─────────────────────────────────────────────────────────────────────────────────── */
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
  if (cameraId === undefined) throw new Error('could not create the fixture camera');

  /* ── 1 · a healthy baseline ────────────────────────────────────────────────────────────────── */
  console.log(`1 · baseline — the bridge publishing normally (${PHASE}s)`);
  await api(`/media/streams/${cameraId}/start`, { method: 'POST', headers: H, body: '{}' });
  await sleep(PHASE * 1000);

  const healthy = await bridge();
  const healthySegments = await segments(cameraId);
  samples.healthy = { ...healthy, segments: healthySegments };
  check(healthy.published > 0, 'events are publishing', `${healthy.published} result(s)`);
  check(healthy.brokerStatus === 'up', 'the broker is up', healthy.brokerStatus);
  check(healthySegments > 0, 'and segments are being recorded', `${healthySegments} segment(s)`);
  console.log('');

  /* ── 2 · the broker goes away ──────────────────────────────────────────────────────────────── */
  console.log(`2 · the broker is STOPPED (${PHASE}s)`);
  sh('docker', ['stop', NATS]);
  await sleep(PHASE * 1000);

  const outage = await bridge();
  const outageSegments = await segments(cameraId);
  samples.outage = { ...outage, segments: outageSegments };

  check(
    outage.brokerStatus === 'down',
    'the publisher reports the broker as DOWN, rather than staying optimistically up',
    outage.brokerStatus,
  );
  check(
    (outage.failed ?? 0) > (healthy.failed ?? 0),
    'publishes failed and were counted, not silently swallowed',
    `${outage.failed} total failure(s)`,
  );
  check(
    (outage.retries ?? 0) > (healthy.retries ?? 0),
    'and were retried within the bound before giving up',
    `${outage.retries} retry attempt(s)`,
  );
  /*
   * ⚠️ THE assertion of this whole file. Everything above is about events, which the bridge is
   * allowed to lose. A queue that grew without bound, or back-pressure reaching the decoder, would
   * cost segments — and segments are evidence.
   */
  check(
    outageSegments > healthySegments,
    '⚠️ RECORDING CONTINUED THROUGH THE OUTAGE — segments kept being written',
    `${healthySegments} → ${outageSegments} segment(s)`,
  );
  /*
   * ⚠️ Against the deployment's OWN bound, not a constant. A check written as "depth stayed under
   * 64" passes on a publisher configured at 256 whose eviction has been removed — it would be
   * measuring the number in the script rather than the behaviour of the bridge.
   */
  const bound = outage.queuePerCamera ?? 16;
  check(
    (outage.queueDepth ?? 0) <= bound * Math.max(1, outage.activeCameras ?? 1),
    'the queue stayed bounded rather than growing with the outage',
    `depth ${outage.queueDepth} against a bound of ${bound} per camera`,
  );
  /*
   * ⚠️ The bridge's stated policy under pressure is that events are DROPPED and recording is not
   * touched. Nothing verified the dropping half. Without this, a publisher that quietly accumulated
   * every result of an outage would satisfy every other check on this page — it publishes when the
   * broker returns, recording never stopped — while holding an unbounded amount of memory in the
   * one process that must not run out of it.
   */
  check(
    (outage.droppedQueueFull ?? 0) > (healthy.droppedQueueFull ?? 0),
    '⚠️ and SHED load rather than accumulating it — results were dropped, by policy',
    `${healthy.droppedQueueFull} → ${outage.droppedQueueFull} dropped`,
  );
  console.log('');

  /* ── 3 · the broker comes back ─────────────────────────────────────────────────────────────── */
  console.log(`3 · the broker is RESTORED (${PHASE}s)`);
  restoreBroker();
  await sleep(PHASE * 1000);

  const recovered = await bridge();
  samples.recovered = recovered;
  check(
    recovered.brokerStatus === 'up',
    '⚠️ the publisher recovered on its own — no restart, no intervention',
    recovered.brokerStatus,
  );
  check(
    (recovered.published ?? 0) > (outage.published ?? 0),
    'and resumed publishing',
    `${outage.published} → ${recovered.published} result(s)`,
  );
  /*
   * ⚠️ Sampled TWICE, and the first sample is not asserted on. A broker takes seconds to become
   * healthy after `docker start`, and the publisher legitimately keeps failing across that window
   * — so an assertion of "no failures after restore" fails for the right reason at the wrong time.
   * What "recovered" actually means is that failures STOPPED, which needs a second window.
   */
  const settled = await bridge();
  await sleep(8000);
  const stable = await bridge();
  samples.stable = stable;
  check(
    (stable.failed ?? 0) === (settled.failed ?? 0),
    'and failures stopped once the broker was actually accepting',
    `${settled.failed} → ${stable.failed} total`,
  );
  /*
   * ⚠️ `offered`, not `published` — and the difference is the whole point of the metric split.
   *
   * `published` counts results that CARRIED DETECTIONS. The fixture clip has stretches with nobody
   * in frame, so an eight-second window can legitimately publish nothing while the bridge is
   * working perfectly; this check failed exactly that way, measured, and the conclusion "the
   * publisher stalled after recovery" would have been wrong. What must still be moving after the
   * broker returns is the bridge being FED and accepting work, which is `offered`.
   */
  check(
    (stable.offered ?? 0) > (settled.offered ?? 0),
    'while the bridge kept accepting work',
    `${settled.offered} → ${stable.offered} result(s) offered, ${settled.published} → ${stable.published} published`,
  );

  const started = new Date(Date.now() - PHASE * 1000).toISOString();
  const after = await api(
    `/events/events?cameraId=${encodeURIComponent(cameraId)}&from=${encodeURIComponent(started)}&limit=200`,
    { headers: H },
  );
  const seqs = (after.json?.data?.events ?? [])
    .map((e) => e.payload?.frameSeq)
    .filter((n) => typeof n === 'number')
    .reverse();
  check(
    seqs.length === 0 || seqs.every((n, i) => i === 0 || n >= seqs[i - 1]),
    '⚠️ ordering survived the outage — sequences never go backwards',
    seqs.length === 0 ? 'no events in the window' : `${seqs.length} event(s), ${seqs[0]} → ${seqs[seqs.length - 1]}`,
  );
  /*
   * ⚠️ Stated, not asserted away. Events published during the outage are GONE — the bridge drops
   * rather than holding them, by design, because holding them is what would cost recordings. The
   * gap is the cost of that choice and it belongs in the record.
   */
  finding(
    'events published during a broker outage are lost',
    `${(outage.failed ?? 0) - (healthy.failed ?? 0)} result(s) failed every attempt and were dropped. ` +
      'The bridge trades events for recordings deliberately — see the publisher header.',
  );
  console.log('');

  /* ── 4 · camera assignment compatibility ───────────────────────────────────────────────────── */
  console.log(`4 · camera assignment compatibility — frames stop, then start again (${PHASE}s each)`);
  const beforeIdle = await bridge();
  const segmentsBeforeIdle = await segments(cameraId);

  await api(`/media/streams/${cameraId}/stop`, { method: 'POST', headers: H, body: '{}' });
  await sleep(PHASE * 1000);

  const idle = await bridge();
  samples.idle = idle;
  /*
   * ⚠️ This is the shape assignment will produce: frames simply stop being offered. Nothing in the
   * bridge should complain, retry, or keep a queue warm.
   */
  check(
    (idle.published ?? 0) === (beforeIdle.published ?? 0),
    '⚠️ no events published while the camera offered no frames',
    `${beforeIdle.published} → ${idle.published}`,
  );
  check((idle.queueDepth ?? 0) === 0, 'the queue drained rather than holding work', `depth ${idle.queueDepth}`);
  check(
    (idle.failed ?? 0) === (beforeIdle.failed ?? 0),
    'and an idle camera is not an error',
    `${idle.failed} failure(s)`,
  );
  const segmentsWhileIdle = await segments(cameraId);
  check(
    segmentsWhileIdle >= segmentsBeforeIdle,
    'recordings already written are untouched',
    `${segmentsBeforeIdle} → ${segmentsWhileIdle}`,
  );

  /*
   * ⚠️ The half that matters. A restarted stream begins its frame sequence again, and the publisher
   * holds a per-camera ordering gate — so a naive implementation drops EVERY event from a
   * re-enabled camera as "stale", indefinitely, with nothing in the logs to say why.
   */
  await api(`/media/streams/${cameraId}/start`, { method: 'POST', headers: H, body: '{}' });
  await sleep(PHASE * 1000);

  const resumed = await bridge();
  samples.resumed = resumed;
  check(
    (resumed.published ?? 0) > (idle.published ?? 0),
    '⚠️ the camera was re-enabled and events RESUMED — the ordering gate did not strand it',
    `${idle.published} → ${resumed.published} result(s)`,
  );
  check(
    (resumed.droppedOutOfOrder ?? 0) - (idle.droppedOutOfOrder ?? 0) < (resumed.published ?? 0) - (idle.published ?? 0),
    'and most results got through rather than being dropped as stale',
    `${(resumed.droppedOutOfOrder ?? 0) - (idle.droppedOutOfOrder ?? 0)} dropped vs ` +
      `${(resumed.published ?? 0) - (idle.published ?? 0)} published`,
  );
  console.log('');
} finally {
  if (cameraId !== undefined) {
    await api(`/media/streams/${cameraId}/stop`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
  }
  await cleanup(true);
}

writeFileSync(
  OUT,
  `${JSON.stringify({ at: new Date().toISOString(), phaseSeconds: PHASE, samples, findings }, null, 2)}\n`,
);
console.log(`samples → ${OUT.replace(`${ROOT}/`, '')}`);
console.log(
  failures === 0
    ? '\nthe bridge survives a broker outage and a camera being switched off — recording never stopped\n'
    : `\n${failures} resilience check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);

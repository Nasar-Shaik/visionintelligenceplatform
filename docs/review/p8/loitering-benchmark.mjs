/**
 * P-8 Phase 7 · **what does rule evaluation cost, and where does the time actually go?**
 *
 *   node docs/review/p8/loitering-benchmark.mjs        # 1 → 16 cameras
 *   LADDER=1,2 node docs/review/p8/loitering-benchmark.mjs
 *   node docs/review/p8/loitering-benchmark.mjs clean  # ⚠️ if a run was interrupted
 *
 * ### ⚠️ Three latencies, separated, because one number cannot be acted on (Architect rec 6)
 *
 * | measured | from → to | measured by | isolates |
 * |---|---|---|---|
 * | **event → rule** | the frame's `occurredAt` → the engine consuming it | `rules_event_ingest_latency_seconds` | media, the broker, the events service |
 * | **rule → candidate** | one event against the whole rule set | `rules_event_evaluation_duration_seconds` | the rule set itself |
 * | **end to end** | the frame's `occurredAt` → candidate published | `rules_candidate_latency_seconds` | everything |
 *
 * A single end-to-end figure rising tells an operator to look somewhere, and the three together tell
 * them where. Subtracting evaluation from end-to-end gives the transport share.
 *
 * ⚠️ **Every one is the platform's own measurement, taken from `/metrics`.** Timing from this script
 * would measure its own HTTP round trips and sleeps. Two of the three span services, and are stamped
 * against the *frame's* capture time rather than against a receiving node's clock — timing them
 * across two wall clocks would be measuring skew.
 *
 * ### ⚠️ Zone resolution is measured where it happens
 *
 * `averageResolveMicros` comes from the frame sink, which is the process that runs the geometry. It
 * is the number that says whether point-in-polygon on the recording path is free or is not.
 *
 * ### ⚠️ No capacity number is published from one run
 *
 * The standing sizing policy applies unchanged: **2 cameras supported, 4 provisional, and no
 * recommendation until three independent runs agree.** This writes a rung table and refuses to turn
 * it into a headline.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assignCameras, releaseCameras, tryAssignCameras } from './_assign.mjs';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const MEDIA = 'vip-prod-media-1';
const RULES = 'vip-prod-rules-1';
const EVENTS = 'vip-prod-events-1';
const FIXTURE = 'vip-loiter-bench';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-loiterbench';
const OUT = process.env.OUT ?? join(ROOT, 'docs/review/p8/loitering-capacity.json');
const LADDER = (process.env.LADDER ?? '1,2,4,8,16').split(',').map(Number);
/**
 * Seconds of steady state per rung.
 *
 * ⚠️ Must span several observation intervals. The platform observes a continuously present subject
 * about once per event-dedup bucket (~10 s), so a 20 s window gives two samples per subject and a
 * throughput figure built from almost nothing. 45 s is the shortest window that produces a rate
 * worth reporting.
 */
const WINDOW = Number(process.env.WINDOW ?? 45);
const WARMUP = Number(process.env.WARMUP ?? 12);
const CONVERGE_MS = Number(process.env.CONVERGE_MS ?? 18_000);
/** The dwell threshold each rung's rule uses. Short enough that every rung actually fires. */
const DWELL = Number(process.env.DWELL ?? 20);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts }).trim();
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
  if (r.json?.data?.accessToken === undefined) throw new Error('login failed');
  H = { authorization: `Bearer ${r.json.data.accessToken}`, 'content-type': 'application/json' };
}

/** One container's CPU and resident memory, right now. */
function usage(container) {
  const raw = shq('docker', [
    'stats', '--no-stream', '--format', '{{.CPUPerc}}\t{{.MemUsage}}', container,
  ]);
  const [cpu, mem] = raw.split('\t');
  const memMb = /([\d.]+)\s*([KMG])iB/.exec(mem ?? '');
  const scale = { K: 1 / 1024, M: 1, G: 1024 };
  return {
    cpu: Number((cpu ?? '0').replace('%', '')) || 0,
    memMb: memMb ? Number(Number(memMb[1]) * (scale[memMb[2]] ?? 1)) : 0,
  };
}

/**
 * Read a Prometheus histogram's count and sum from a container's `/metrics`.
 *
 * ⚠️ Returns `null` for a histogram with **no observations**, never `0`. A latency of "0 ms" and a
 * latency nobody has measured are opposite statements, and this ladder exists partly because P-8
 * Phase 6 shipped two latency metrics that fell as load rose (ADR-0039, [L-53]).
 */
function histogram(container, name) {
  const body = shq('docker', ['exec', container, 'wget', '-qO-', 'http://127.0.0.1:8086/metrics']);
  /*
   * ⚠️ **The label set is optional in the pattern, and leaving it out was a real bug.**
   *
   * The registry stamps `{service="rules"}` on every series, so `rules_..._count` never appears bare
   * and an anchored `^name_count\s+` matched nothing. Every latency in the first ladder read "not
   * measured" — which is the honest rendering of a failed read (ADR-0039) and therefore looked like a
   * platform that had observed nothing rather than a script that could not parse. A `0` here would
   * have been worse and would have shipped.
   */
  const read = (suffix) => {
    const m = new RegExp(`^${name}_${suffix}(?:\\{[^}]*\\})?\\s+([\\d.e+-]+)$`, 'm').exec(body);
    return m === null ? null : Number(m[1]);
  };
  const count = read('count');
  const sum = read('sum');
  if (count === null || sum === null || !Number.isFinite(count) || count === 0) return null;
  return { count, sum };
}

/** The mean of a histogram between two samples — a WINDOW mean, not a lifetime one. */
function windowMean(before, after) {
  if (before === null || after === null) return null;
  const dCount = after.count - before.count;
  const dSum = after.sum - before.sum;
  /*
   * ⚠️ `null` when nothing was observed IN THIS WINDOW, even though the lifetime count is non-zero.
   * Falling back to the lifetime mean is exactly how a rung reports the previous rung's number and a
   * ladder appears to get faster under load.
   */
  if (dCount <= 0) return null;
  return (dSum / dCount) * 1000;
}

function counter(container, name) {
  const raw = shq('docker', ['exec', container, 'wget', '-qO-', 'http://127.0.0.1:8086/metrics']);
  /* ⚠️ Optional label set — see `histogram`. */
  const m = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([\\d.e+-]+)$`, 'm').exec(raw);
  return m === null ? null : Number(m[1]);
}

async function cleanup(quiet = false) {
  try {
    await login();
    const cams = (await api('/camera/cameras?limit=300', { headers: H })).json?.data?.cameras ?? [];
    const mine = cams.filter((c) => (c.metadata?.tags ?? []).includes(TAG));
    for (const cam of mine) {
      const zones = (await api(`/camera/zones?cameraId=${cam.id}`, { headers: H })).json?.data ?? [];
      for (const z of zones) {
        await api(`/camera/zones/${z.id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
      }
    }
    await releaseCameras(api, H, mine.map((c) => c.id));
    for (const cam of mine) {
      await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
      await api(`/camera/cameras/${cam.id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
    }
    const listed = (await api('/rules/rules', { headers: H })).json?.data;
    const rules = Array.isArray(listed) ? listed : (listed?.rules ?? []);
    for (const rule of rules.filter((r) => r.name?.startsWith(TAG))) {
      await api(`/rules/rules/${rule.id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
    }
  } catch {
    /* best effort */
  }
  shq('docker', ['rm', '-f', FIXTURE]);
  if (!quiet) console.log('\nremoved the benchmark fixture, its cameras, zones and rules\n');
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

await login();
await cleanup(true);

/*
 * ⚠️ **The ladder raises the runtime's declared capacity for the run and restores it afterwards.**
 *
 * The seeded runtime declares 4 cameras — the provisional sizing figure — so an 8-camera rung is
 * refused by the control plane doing exactly its job. A ladder that stopped there would be measuring
 * the refusal path and reporting it as the cost of eight cameras. The same thing the assignment
 * ladder does, for the same reason, and the declared figure is put back in the `finally`.
 */
const runtimes = (await api('/camera/processing-runtimes', { headers: H })).json?.data ?? [];
const runtime = runtimes[0];
const originalMax = runtime?.maxCameras;
if (runtime !== undefined) {
  await api(`/camera/processing-runtimes/${runtime.id}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ maxCameras: Math.max(...LADDER) + 8 }),
  });
}

console.log('\nP-8 Phase 7 · the loitering capacity ladder\n');
console.log(
  `  ⚠️ ${WINDOW}s steady-state window per rung, ${DWELL}s dwell threshold. Every latency is the\n` +
    `     PLATFORM's own measurement, read from /metrics, and null when nothing was observed.\n`,
);

const rungs = [];
/**
 * The rung the control plane refused, if any. ⚠️ Declared OUT here, not inside the `try`, because the
 * samples file is written in the `finally` — a scope this lived one block too deep in would have been
 * a ReferenceError on the one path that matters, the failing one.
 */
let refusedAt = null;

try {
  shq('docker', ['rm', '-f', FIXTURE]);
  sh('docker', [
    'run', '-d', '--rm', '--name', FIXTURE, '--network', NETWORK,
    '-v', `${ROOT}/infra/docker/fixtures/tracking-fixture.yml:/mediamtx.yml:ro`,
    '-v', `${ROOT}/infra/docker/fixtures/media:/fixtures/media:ro`,
    'bluenviron/mediamtx:latest-ffmpeg',
  ]);
  await sleep(3000);
  const hierarchyZone = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0].zoneId;

  for (const n of LADDER) {
    if (refusedAt !== null) break;
    console.log(`  ── ${n} camera${n === 1 ? '' : 's'} ──────────────────────────────────────────`);
    const cameraIds = [];
    const zoneIds = [];

    for (let i = 0; i < n; i += 1) {
      const cam = await api('/camera/cameras', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          zoneId: hierarchyZone,
          name: `${TAG} ${n}-${i}`,
          protocol: 'rtsp',
          /* ⚠️ Independent publisher per camera — see the fixture's `~^walk[0-9]+$` note. */
          streamUrl: `rtsp://${FIXTURE}:8554/walk${i + 1}`,
          metadata: { tags: [TAG] },
        }),
      });
      const id = cam.json?.data?.id;
      if (id === undefined) throw new Error(`camera ${i} failed: ${cam.text.slice(0, 200)}`);
      cameraIds.push(id);

      const zone = await api('/camera/zones', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          cameraId: id,
          name: `${TAG} frame ${n}-${i}`,
          kind: 'area',
          shape: 'polygon',
          geometry: { points: [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]] },
          enabled: true,
        }),
      });
      zoneIds.push(zone.json?.data?.id);
    }

    /* One rule covering every camera on this rung — the shape a customer actually deploys. */
    const made = await api('/rules/rules', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        name: `${TAG} ${n}-camera loitering`,
        eventTypes: ['perception.person.detected'],
        condition: { field: 'subjects.0.identityId', op: 'exists' },
        dwell: { minSeconds: DWELL, groupBy: 'identity', resetAfterSeconds: 15, cooldownSeconds: 0 },
        severity: 'low',
        actions: [{ type: 'raise-incident' }],
        scope: { nodeIds: [], cameraIds, groupIds: [], zoneIds: zoneIds.filter(Boolean) },
      }),
    });
    const ruleId = made.json?.data?.id;
    await api(`/rules/rules/${ruleId}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ lifecycle: 'enabled' }),
    });

    for (const id of cameraIds) {
      await api(`/media/streams/${id}/start`, { method: 'POST', headers: H, body: '{}' });
    }
    /*
     * ⚠️ A control-plane refusal ends the ladder; it does not fail it. See `tryAssignCameras` — the
     * 2026-08-06 run threw here and discarded every rung it had already measured, then leaked its
     * assignments into the next three stages.
     */
    const placed = await tryAssignCameras(api, H, cameraIds, { settleMs: CONVERGE_MS });
    if (!placed.ok) {
      refusedAt = { cameras: cameraIds.length, reason: placed.reason };
      console.log(`\n  ⚠️ refused at ${cameraIds.length} camera(s) — ${placed.reason.replace(/^could not assign \S+ for AI processing \(HTTP 409\): /, '')}`);
      console.log('     the rungs below stand; the ladder is truncated, not failed.');
      break;
    }
    await sleep(WARMUP * 1000);

    /* ── the window ────────────────────────────────────────────────────────────────────────── */
    const before = {
      ingest: histogram(RULES, 'rules_event_ingest_latency_seconds'),
      evaluate: histogram(RULES, 'rules_event_evaluation_duration_seconds'),
      candidate: histogram(RULES, 'rules_candidate_latency_seconds'),
      events: counter(RULES, 'rules_events_consumed_total'),
      evaluations: counter(RULES, 'rules_evaluated_total'),
      candidates: null,
    };
    const startedAt = Date.now();

    let mediaCpu = 0;
    let mediaMem = 0;
    let rulesCpu = 0;
    let rulesMem = 0;
    let eventsCpu = 0;
    const samples = Math.max(1, Math.floor(WINDOW / 5));
    for (let i = 0; i < samples; i += 1) {
      await sleep(5000);
      const m = usage(MEDIA);
      const r = usage(RULES);
      const e = usage(EVENTS);
      mediaCpu = Math.max(mediaCpu, m.cpu);
      mediaMem = Math.max(mediaMem, m.memMb);
      rulesCpu = Math.max(rulesCpu, r.cpu);
      rulesMem = Math.max(rulesMem, r.memMb);
      eventsCpu = Math.max(eventsCpu, e.cpu);
    }
    const elapsed = (Date.now() - startedAt) / 1000;

    const after = {
      ingest: histogram(RULES, 'rules_event_ingest_latency_seconds'),
      evaluate: histogram(RULES, 'rules_event_evaluation_duration_seconds'),
      candidate: histogram(RULES, 'rules_candidate_latency_seconds'),
      events: counter(RULES, 'rules_events_consumed_total'),
      evaluations: counter(RULES, 'rules_evaluated_total'),
    };

    const runtime = (await api('/system/ai-runtime', { headers: H })).json?.data?.pipeline ?? {};
    const liveStatus = (await api('/rules/rules/live', { headers: H })).json?.data ?? {};

    const rung = {
      cameras: n,
      /* The three latencies, in milliseconds, over THIS window. */
      eventToRuleMs: windowMean(before.ingest, after.ingest),
      ruleToCandidateMs: windowMean(before.evaluate, after.evaluate),
      endToEndMs: windowMean(before.candidate, after.candidate),
      /* Throughput, from counters differenced over the same window. */
      eventsPerSecond:
        before.events === null || after.events === null
          ? null
          : Number(((after.events - before.events) / elapsed).toFixed(2)),
      evaluationsPerSecond:
        before.evaluations === null || after.evaluations === null
          ? null
          : Number(((after.evaluations - before.evaluations) / elapsed).toFixed(2)),
      activeDwellTimers: liveStatus.activeDwellTimers ?? null,
      dwellStateEntries: liveStatus.dwellStateEntries ?? null,
      /* ⚠️ Non-zero here means a dwell rule could not accumulate — see the live status page. */
      dwellWithoutIdentity: liveStatus.dwellWithoutIdentity ?? null,
      /* Zone geometry, measured in the process that runs it. */
      zoneResolveMicros: runtime.zones?.averageResolveMicros ?? null,
      zonesLoaded: runtime.zones?.zonesLoaded ?? null,
      detectionsTested: runtime.zones?.detectionsTested ?? null,
      /* Resource peaks over the window. */
      mediaCpuPct: Number(mediaCpu.toFixed(1)),
      mediaMemMb: Number(mediaMem.toFixed(0)),
      rulesCpuPct: Number(rulesCpu.toFixed(1)),
      rulesMemMb: Number(rulesMem.toFixed(0)),
      eventsCpuPct: Number(eventsCpu.toFixed(1)),
    };
    rungs.push(rung);

    const ms = (v) => (v === null ? 'not measured' : `${v.toFixed(1)} ms`);
    console.log(`     event → rule       ${ms(rung.eventToRuleMs)}`);
    console.log(`     rule → candidate   ${ms(rung.ruleToCandidateMs)}`);
    console.log(`     end to end         ${ms(rung.endToEndMs)}`);
    console.log(
      `     throughput         ${rung.eventsPerSecond ?? '—'} events/s · ` +
        `${rung.evaluationsPerSecond ?? '—'} evaluations/s`,
    );
    console.log(
      `     dwell              ${rung.activeDwellTimers ?? '—'} clock(s) running, ` +
        `${rung.dwellWithoutIdentity ?? '—'} skipped for want of identity`,
    );
    console.log(
      `     zones              ${rung.zonesLoaded ?? '—'} loaded, ` +
        `${rung.zoneResolveMicros === null ? 'not measured' : `${rung.zoneResolveMicros.toFixed(1)} µs/frame`}`,
    );
    console.log(
      `     resources          media ${rung.mediaCpuPct}% / ${rung.mediaMemMb} MB · ` +
        `rules ${rung.rulesCpuPct}% / ${rung.rulesMemMb} MB · events ${rung.eventsCpuPct}%`,
    );
    console.log('');

    await releaseCameras(api, H, cameraIds);
    for (const id of cameraIds) {
      await api(`/media/streams/${id}/stop`, { method: 'POST', headers: H, body: '{}' });
    }
    for (const z of zoneIds.filter(Boolean)) {
      await api(`/camera/zones/${z}`, { method: 'DELETE', headers: { authorization: H.authorization } });
    }
    for (const id of cameraIds) {
      await api(`/camera/cameras/${id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
    }
    if (ruleId !== undefined) {
      await api(`/rules/rules/${ruleId}`, { method: 'DELETE', headers: { authorization: H.authorization } });
    }
    await sleep(6000);
  }
} finally {
  /* ⚠️ Restore the declared capacity, whatever happened above. */
  if (runtime !== undefined && originalMax !== undefined) {
    await api(`/camera/processing-runtimes/${runtime.id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ maxCameras: originalMax }),
    }).catch(() => {});
  }
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        windowSeconds: WINDOW,
        dwellSeconds: DWELL,
        /*
         * ⚠️ Recorded with the numbers, because the numbers are meaningless without it: the sizing
         * policy is unchanged by this run and no capacity claim is made from a single ladder.
         */
        sizingPolicy: '2 cameras supported, 4 provisional; no change from one run',
        rungs,
        /*
         * ⚠️ The rung the control plane refused, beside the numbers. A ladder that stopped because a
         * runtime degraded under the previous rung's load found its edge; one that stopped because it
         * was configured to is a different statement, and a table that cannot tell you which is
         * unreadable a month later. `null` means the ladder ran to its configured top.
         */
        refusedAt,
      },
      null,
      2,
    )}\n`,
  );
  await cleanup(true);
}

console.log('  cams  ev→rule   rule→cand   end-to-end   events/s   zones µs   media %   rules %');
for (const r of rungs) {
  const f = (v, w) => (v === null ? '—'.padStart(w) : v.toFixed(1).padStart(w));
  console.log(
    `  ${String(r.cameras).padStart(4)}  ${f(r.eventToRuleMs, 7)}   ${f(r.ruleToCandidateMs, 9)}   ` +
      `${f(r.endToEndMs, 10)}   ${String(r.eventsPerSecond ?? '—').padStart(8)}   ` +
      `${f(r.zoneResolveMicros, 8)}   ${f(r.mediaCpuPct, 7)}   ${f(r.rulesCpuPct, 7)}`,
  );
}
console.log(`\n⚠️ sizing policy unchanged: 2 cameras supported, 4 provisional.\n`);
console.log(`ladder → ${OUT}\n`);

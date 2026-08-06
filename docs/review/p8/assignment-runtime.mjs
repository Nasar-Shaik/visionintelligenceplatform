/**
 * P-8 Phase 6 · **runtime orchestration** — health, capacity, failover, persistence (§3, §5).
 *
 *   node docs/review/p8/assignment-runtime.mjs
 *   node docs/review/p8/assignment-runtime.mjs clean
 *
 * ### What this proves that `assignment.mjs` does not
 *
 * `assignment.mjs` proves a camera can be analysed. This proves the platform behaves correctly when
 * the runtime **stops being usable** — which is the case an operator will actually meet, and the one
 * no happy-path run touches.
 *
 *   - a second runtime can be registered, and it is `unknown` until media measures it;
 *   - capacity is **refused**, not silently exceeded;
 *   - a runtime going offline moves its cameras and leaves the others alone;
 *   - a camera that cannot be re-placed lands in `error` with the reason on it, not silently off;
 *   - assignments **survive a restart of both the control plane and the enforcement point**.
 *
 * ### ⚠️ The unreachable runtime is registered, not broken
 *
 * The failover case uses a second runtime at an address nothing listens on. That is deliberate: it
 * produces a genuinely unreachable runtime without stopping the real one, so the rest of the
 * deployment keeps working while the failure is observed. Stopping the real inference container
 * would have made every other check in the file fail for an unrelated reason.
 *
 * ### ⚠️ Persistence is verified by RESTARTING containers, not by re-reading a document
 *
 * "Assignments survive a restart" is a claim about processes, and re-reading Mongo proves only that
 * Mongo works. Both halves are restarted and the plan is asserted to reconverge.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const FIXTURE = 'vip-assignment-rt-fixture';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-assignment-rt';
const OUT = process.env.OUT ?? join(ROOT, 'docs/review/p8/assignment-runtime-samples.json');
const CONVERGE_MS = Number(process.env.CONVERGE_MS ?? 22_000);
/** ⚠️ A registered address nothing listens on — see the header. */
const DEAD_RUNTIME = { id: 'p8-dead-runtime', name: 'Unreachable runtime', url: 'http://127.0.0.1:9', maxCameras: 4 };
const SMALL_RUNTIME = { id: 'p8-small-runtime', name: 'One-camera runtime', url: 'http://inference:8085', maxCameras: 1 };

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
  if (r.json?.data?.accessToken === undefined) throw new Error(`login failed: ${r.text.slice(0, 200)}`);
  H = { authorization: `Bearer ${r.json.data.accessToken}`, 'content-type': 'application/json' };
}

const assignmentOf = async (cameraId) =>
  (await api(`/camera/assignments/${cameraId}`, { headers: H })).json?.data ?? {};
const runtimesNow = async () =>
  (await api('/camera/processing-runtimes', { headers: H })).json?.data ?? [];
const runtimeOf = async (id) => (await runtimesNow()).find((r) => r.id === id) ?? {};

async function cleanup(quiet = false) {
  try {
    await login();
    const cams = (await api('/camera/cameras?limit=200', { headers: H })).json?.data?.cameras ?? [];
    for (const cam of cams.filter((c) => (c.metadata?.tags ?? []).includes(TAG))) {
      await api(`/camera/assignments/${cam.id}`, {
        method: 'DELETE',
        headers: { authorization: H.authorization },
      });
      await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
      await api(`/camera/cameras/${cam.id}`, {
        method: 'DELETE',
        headers: { authorization: H.authorization },
      });
    }
    /*
     * ⚠️ Runtimes are removed LAST and unconditionally. A verification runtime left registered is
     * permanent drag on every future placement decision — the same reasoning that stops the bus
     * probe leaving a durable consumer behind.
     */
    for (const id of [DEAD_RUNTIME.id, SMALL_RUNTIME.id]) {
      await api(`/camera/processing-runtimes/${id}`, {
        method: 'DELETE',
        headers: { authorization: H.authorization },
      });
    }
  } catch {
    /* best effort */
  }
  shq('docker', ['rm', '-f', FIXTURE]);
  if (!quiet) console.log('\nremoved the runtime fixture, its cameras and its verification runtimes\n');
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

await login();
await cleanup(true);
console.log('\nP-8 Phase 6 · runtime orchestration — health, capacity, failover, persistence\n');

const samples = {};
const cameras = [];

try {
  /* ── 0 · fixture cameras ───────────────────────────────────────────────────────────────────── */
  console.log('0 · two cameras on a fixture stream');
  shq('docker', ['rm', '-f', FIXTURE]);
  sh('docker', [
    'run', '-d', '--rm', '--name', FIXTURE, '--network', NETWORK,
    '-v', `${ROOT}/infra/docker/fixtures/tracking-fixture.yml:/mediamtx.yml:ro`,
    '-v', `${ROOT}/infra/docker/fixtures/media:/fixtures/media:ro`,
    'bluenviron/mediamtx:latest-ffmpeg',
  ]);
  await sleep(3000);

  const zoneId = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0].zoneId;
  for (let i = 1; i <= 2; i += 1) {
    const made = await api('/camera/cameras', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        zoneId,
        name: `${TAG} cam${i}`,
        protocol: 'rtsp',
        streamUrl: `rtsp://${FIXTURE}:8554/walk0${i}`,
        metadata: { tags: [TAG] },
      }),
    });
    const id = made.json?.data?.id;
    if (id === undefined) throw new Error(`camera ${i} not created: ${made.text.slice(0, 200)}`);
    cameras.push(id);
    await api(`/media/streams/${id}/start`, { method: 'POST', headers: H, body: '{}' });
  }
  check(cameras.length === 2, 'two cameras were created');
  console.log('');

  /* ── 1 · registration is declared; health is measured ──────────────────────────────────────── */
  console.log('1 · a newly registered runtime is UNKNOWN until something measures it');
  const registered = await api('/camera/processing-runtimes', {
    method: 'POST',
    headers: H,
    body: JSON.stringify(DEAD_RUNTIME),
  });
  check(registered.status === 201, 'the runtime was registered', `HTTP ${registered.status}`);
  check(
    registered.json?.data?.health === 'unknown',
    '⚠️ and is "unknown" — a runtime is not healthy because somebody typed a URL',
    registered.json?.data?.health,
  );
  check(
    registered.json?.data?.latencyMs === null,
    'with no latency, because nothing has measured one',
    String(registered.json?.data?.latencyMs),
  );
  check(
    registered.json?.data?.capabilities === null,
    '⚠️ and null capabilities — "not read" is not the same as "offers none"',
    String(registered.json?.data?.capabilities),
  );

  await sleep(CONVERGE_MS);
  const dead = await runtimeOf(DEAD_RUNTIME.id);
  samples.dead = dead;
  /*
   * ⚠️ `offline`, and measured — media tried to reach it and could not. This is the check that says
   * health comes from the process that actually sends frames rather than from configuration.
   */
  check(dead.health === 'offline', '⚠️ media MEASURED it offline', dead.health);
  check(dead.latencyMs === null, 'and reported no latency — a timeout is not a slow round trip', String(dead.latencyMs));
  check(dead.observedBy === 'media', 'the observer is the enforcement point', String(dead.observedBy));
  console.log('');

  /* ── 2 · placement refuses a dead runtime ──────────────────────────────────────────────────── */
  console.log('2 · placement refuses what it cannot use');
  const pinned = await api(`/camera/assignments/${cameras[0]}/enable`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ profileId: 'person-tracking', runtimeId: DEAD_RUNTIME.id }),
  });
  check(pinned.status === 409, 'pinning a camera to an offline runtime is refused', `HTTP ${pinned.status}`);
  check(
    /healthy/i.test(pinned.json?.error?.message ?? pinned.text),
    'and the refusal names the reason',
    (pinned.json?.error?.message ?? '').slice(0, 80),
  );
  /* ⚠️ Nothing was written. A rejected request must not leave a junk assignment behind. */
  const untouched = await assignmentOf(cameras[0]);
  check(untouched.state === 'unassigned', '⚠️ and NOTHING was written for the refused camera', untouched.state);

  const profileless = await api(`/camera/assignments/${cameras[0]}/enable`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ profileId: 'vehicle-analytics' }),
  });
  check(
    profileless.status === 409,
    'a profile no runtime advertises is refused rather than accepted',
    `HTTP ${profileless.status}`,
  );
  check(
    /capability/i.test(profileless.json?.error?.message ?? profileless.text),
    '⚠️ naming the capability, not a generic failure',
    (profileless.json?.error?.message ?? '').slice(0, 80),
  );
  console.log('');

  /* ── 3 · capacity is refused, not exceeded ─────────────────────────────────────────────────── */
  console.log('3 · capacity is a bound, not a suggestion');
  await api('/camera/processing-runtimes', {
    method: 'POST',
    headers: H,
    body: JSON.stringify(SMALL_RUNTIME),
  });
  await sleep(CONVERGE_MS);

  const first = await api(`/camera/assignments/${cameras[0]}/enable`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ profileId: 'person-tracking', runtimeId: SMALL_RUNTIME.id }),
  });
  check(first.status === 200, 'the first camera fits on a one-camera runtime', `HTTP ${first.status}`);

  const second = await api(`/camera/assignments/${cameras[1]}/enable`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ profileId: 'person-tracking', runtimeId: SMALL_RUNTIME.id }),
  });
  check(second.status === 409, '⚠️ the second is REFUSED — capacity is enforced', `HTTP ${second.status}`);
  check(
    /capacity/i.test(second.json?.error?.message ?? second.text),
    'and the refusal says why',
    (second.json?.error?.message ?? '').slice(0, 80),
  );

  /* ⚠️ Without a pin, placement finds the runtime that does have room. */
  const unpinned = await api(`/camera/assignments/${cameras[1]}/enable`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ profileId: 'person-tracking' }),
  });
  check(unpinned.status === 200, 'unpinned, placement finds a runtime with room', `HTTP ${unpinned.status}`);
  check(
    unpinned.json?.data?.runtimeId !== SMALL_RUNTIME.id,
    'and it is not the full one',
    String(unpinned.json?.data?.runtimeId),
  );
  console.log('');

  /* ── 4 · failover moves the affected camera and nothing else ───────────────────────────────── */
  console.log('4 · failover — a runtime becomes unusable');
  await sleep(CONVERGE_MS);
  const beforeFailover = await Promise.all(cameras.map(assignmentOf));
  samples.beforeFailover = beforeFailover;

  /*
   * ⚠️ Disabling the runtime administratively rather than killing a container. It produces the same
   * decision input (`placeable === false`) through a path an operator actually uses, and it does not
   * take the real inference runtime away from every other check in this file.
   */
  const disabled = await api(`/camera/processing-runtimes/${SMALL_RUNTIME.id}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ enabled: false }),
  });
  check(disabled.status === 200, 'the small runtime was disabled administratively', `HTTP ${disabled.status}`);

  await sleep(CONVERGE_MS);
  const afterFailover = await Promise.all(cameras.map(assignmentOf));
  samples.afterFailover = afterFailover;

  const moved = afterFailover[0];
  const untouchedCam = afterFailover[1];
  check(
    moved.runtimeId !== SMALL_RUNTIME.id,
    '⚠️ the camera on the disabled runtime was MOVED',
    `${beforeFailover[0].runtimeId} → ${moved.runtimeId}`,
  );
  check(
    ['recovering', 'running', 'starting'].includes(moved.state),
    'and is re-establishing rather than silently off',
    moved.state,
  );
  check(
    moved.sessionEpoch > beforeFailover[0].sessionEpoch,
    '⚠️ with a new session — the tracks lived in the old runtime and did not move with it',
    `epoch ${beforeFailover[0].sessionEpoch} → ${moved.sessionEpoch}`,
  );
  /*
   * ⚠️ The camera on the HEALTHY runtime is asserted untouched. "Healthy runtimes must never restart
   * unnecessarily" is a statement about what a failover does NOT do, and only this check sees it.
   */
  check(
    untouchedCam.runtimeId === beforeFailover[1].runtimeId &&
      untouchedCam.sessionEpoch === beforeFailover[1].sessionEpoch,
    '⚠️ and the camera on the healthy runtime was NOT disturbed',
    `runtime ${untouchedCam.runtimeId}, epoch ${untouchedCam.sessionEpoch}`,
  );

  const history = (await api(`/camera/assignments/history?cameraId=${cameras[0]}&limit=20`, { headers: H }))
    .json?.data ?? [];
  const failoverEntry = history.find((e) => e.action === 'failover');
  samples.failoverEntry = failoverEntry ?? null;
  check(failoverEntry !== undefined, 'the failover is in the audit trail');
  check(
    failoverEntry?.actor === 'system',
    '⚠️ attributed to the platform, not to a person who did nothing',
    String(failoverEntry?.actor),
  );
  console.log('');

  /* ── 5 · a camera that cannot be placed lands in error, visibly ────────────────────────────── */
  console.log('5 · nowhere to go');
  const allRuntimes = await runtimesNow();
  const realRuntime = allRuntimes.find((r) => r.id !== SMALL_RUNTIME.id && r.id !== DEAD_RUNTIME.id);
  if (realRuntime === undefined) {
    finding('no third runtime to disable', 'skipping the unplaceable case on this deployment');
  } else {
    await api(`/camera/processing-runtimes/${realRuntime.id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ enabled: false }),
    });
    await sleep(CONVERGE_MS);
    const stranded = await Promise.all(cameras.map(assignmentOf));
    samples.stranded = stranded;
    check(
      stranded.some((a) => a.state === 'error'),
      '⚠️ a camera with nowhere to go lands in ERROR — never silently off',
      stranded.map((a) => a.state).join('/'),
    );
    const errored = stranded.find((a) => a.state === 'error') ?? {};
    check(
      errored.placementFailure !== null && errored.placementFailure !== undefined,
      'with the machine-readable reason on the record',
      String(errored.placementFailure),
    );
    check(
      typeof errored.lastError === 'string' && errored.lastError.length > 0,
      'and the sentence an operator reads',
      String(errored.lastError).slice(0, 60),
    );

    /* Put it back and watch it recover. */
    await api(`/camera/processing-runtimes/${realRuntime.id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ enabled: true }),
    });
    await sleep(CONVERGE_MS);
    const recovered = await Promise.all(cameras.map(assignmentOf));
    samples.recovered = recovered;
    check(
      recovered.every((a) => a.state !== 'error'),
      '⚠️ and recovers on its own when a runtime comes back — no operator action',
      recovered.map((a) => a.state).join('/'),
    );
  }
  console.log('');

  /* ── 6 · persistence across a restart of BOTH halves ───────────────────────────────────────── */
  console.log('6 · assignments survive a restart (§5)');
  const beforeRestart = await Promise.all(cameras.map(assignmentOf));
  samples.beforeRestart = beforeRestart;

  shq('docker', ['restart', 'vip-prod-camera-1']);
  shq('docker', ['restart', 'vip-prod-media-1']);
  await sleep(CONVERGE_MS + 15_000);
  await login();

  const afterRestart = await Promise.all(cameras.map(assignmentOf));
  samples.afterRestart = afterRestart;
  check(
    afterRestart.every((a, i) => a.profileId === beforeRestart[i].profileId),
    '⚠️ every profile survived a restart of the control plane AND the enforcement point',
    afterRestart.map((a) => a.profileId).join('/'),
  );
  check(
    afterRestart.every((a, i) => a.runtimeId === beforeRestart[i].runtimeId),
    'and every placement',
    afterRestart.map((a) => a.runtimeId).join('/'),
  );

  const gate = (await api('/media/perception/assignment', { headers: H })).json?.data ?? {};
  samples.gateAfterRestart = gate;
  check(gate.enabled === true, 'the enforcement point came back with the gate on');
  check(
    typeof gate.planVersion === 'number',
    '⚠️ and re-applied the plan on its own — polling is self-healing',
    `planVersion=${gate.planVersion}`,
  );
  check(
    (gate.plannedCameras ?? 0) >= 2,
    'covering the cameras that were assigned before the restart',
    String(gate.plannedCameras),
  );
  console.log('');
} finally {
  /* ⚠️ Re-enable anything this run disabled, whatever happened, before removing its own runtimes. */
  try {
    for (const rt of await runtimesNow()) {
      if (rt.id !== SMALL_RUNTIME.id && rt.id !== DEAD_RUNTIME.id && rt.enabled === false) {
        await api(`/camera/processing-runtimes/${rt.id}`, {
          method: 'PATCH',
          headers: H,
          body: JSON.stringify({ enabled: true }),
        });
      }
    }
  } catch {
    /* best effort */
  }
  await cleanup(true);
  writeFileSync(OUT, JSON.stringify(samples, null, 2));
  console.log(`\nsamples written to ${OUT}`);
}

if (findings.length > 0) console.log(`\n${findings.length} finding(s) recorded — see above\n`);
console.log(
  failures === 0
    ? '\n✅ health is measured, capacity is enforced, failover moves only what it must, and assignments survive a restart\n'
    : `\n❌ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);

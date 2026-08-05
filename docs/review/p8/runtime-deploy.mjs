/**
 * P-8 Phase 1 · **the AI runtime, deployed — verified against the deployment, not the tree.**
 *
 *   node docs/review/p8/runtime-deploy.mjs
 *
 * The claim this exists to test is narrow and was, until today, false: **a runtime that has never
 * run in production now runs in production.** 121 Python modules with a green unit-test suite told
 * us nothing about that — which is the whole of [DoD 24].
 *
 * ⚠️ Phase 1 connects **nothing**. Half these checks therefore assert an *absence*: no camera, no
 * session, no frame, no gateway route, no published port. An absence is the easiest thing in the
 * world to assert accidentally-truthfully, so each one is paired with a positive reading from the
 * same source — a check that would go green against a container that is not running is not a check.
 *
 * Every HTTP call reaches the runtime **inside the compose network**, because it publishes no port —
 * verifying it over a port that had to be opened for the test would verify a different deployment.
 */
import { execFileSync } from 'node:child_process';

const C = 'vip-prod-inference-1';
const IMAGE = 'vip/inference:local';
const B = process.env.BASE ?? 'https://localhost';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let failures = 0;
const findings = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
/** ⚠️ Recorded, not failed: a fact about the deployment an operator must be told (DoD 36). */
const finding = (label, detail) => {
  console.log(`  ⚠️ ${label} — ${detail}`);
  findings.push(label);
};

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts }).trim();

/** One HTTP GET, issued from inside the container by the interpreter that is already there. */
function get(path, container = C) {
  const py = `import urllib.request,sys
try:
  r=urllib.request.urlopen('http://127.0.0.1:8085${path}',timeout=4)
  sys.stdout.write(str(r.status)+'\\n'+r.read().decode())
except Exception as e:
  sys.stdout.write(getattr(e,'code',0) and str(e.code)+'\\n'+e.read().decode() or '0\\n'+str(e))`;
  /*
   * ⚠️ A dead container must produce a red check, never a dead script. P-6.5 watched a soak run
   * crash at 5d and silently skip the six checks after it; every one of them was reported as
   * "not run" only because somebody read the log. An unreachable runtime is exactly the state this
   * script exists to detect, so it is handled rather than thrown.
   */
  let out;
  try {
    out = sh('docker', ['exec', container, 'python', '-c', py]);
  } catch (e) {
    return {
      status: 0,
      body: `unreachable: ${(e?.message ?? String(e)).slice(0, 120)}`,
      json: undefined,
    };
  }
  const nl = out.indexOf('\n');
  const status = Number(out.slice(0, nl));
  const body = out.slice(nl + 1);
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    /* /metrics is Prometheus text */
  }
  return { status, body, json };
}

const inspect = (fmt, target = C) => sh('docker', ['inspect', '-f', fmt, target]);

console.log('\nP-8 Phase 1 · the AI runtime, deployed\n');

/* ── 1 · the container ───────────────────────────────────────────────────────────────────────── */
console.log('1 · the container is running the image this commit builds');

const state = inspect('{{.State.Status}}');
const health = inspect('{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}');
check(state === 'running', 'the runtime container is running', state);
check(
  health === 'healthy',
  '⚠️ its own healthcheck passes — the container decides this, not the script',
  health,
);

const imageRef = inspect('{{.Config.Image}}');
check(imageRef === IMAGE, 'it runs the image compose builds', imageRef);

const backendLabel = inspect(`{{index .Config.Labels "vip.inference.backend"}}`, IMAGE);
check(
  backendLabel === 'stub',
  '⚠️ the image says which backend it carries — answerable from the deployment, not from whoever built it',
  backendLabel,
);

/*
 * ⚠️ The container id must match the tag. P-6.5 found a *seeder* running bytes that no longer
 * existed in its tag; the same class of drift is what makes "we deployed it" and "it is deployed"
 * two different statements.
 */
const runningImageId = inspect('{{.Image}}');
const taggedImageId = inspect('{{.Id}}', IMAGE);
check(
  runningImageId === taggedImageId,
  'the running container is that image, not an older build of the same tag',
  runningImageId.slice(7, 19),
);

/* ── 2 · nothing is published, nothing is routed ─────────────────────────────────────────────── */
console.log('\n2 · deployed BESIDE the platform — connected to nothing');

const ports = sh('docker', ['port', C]);
check(ports === '', '⚠️ the runtime publishes no host port', ports === '' ? 'none' : ports);

/* Positive pair: the stack still has exactly one container with a host port, and it is the edge. */
const published = sh('sh', [
  '-c',
  `docker ps --filter label=com.docker.compose.project=vip-prod --format '{{.Names}} {{.Ports}}' | grep -c '0.0.0.0' || true`,
]);
const edgePorts = sh('sh', [
  '-c',
  `docker ps --filter label=com.docker.compose.project=vip-prod --format '{{.Names}} {{.Ports}}' | grep '0.0.0.0' | cut -d' ' -f1 | sort | uniq | tr '\\n' ' '`,
]);
check(
  Number(published) > 0 && /proxy/.test(edgePorts),
  'and the edge is still the only thing that does — the reading is live, not vacuous',
  edgePorts.trim(),
);

/* ⚠️ No route points at the runtime yet, and Phase 1 must not quietly add one. */
const edge = await fetch(`${B}/api/inference/health`).catch((e) => ({ status: 0, err: e.message }));
check(
  edge.status === 404 || edge.status === 401,
  '⚠️ the runtime is NOT reachable through the gateway — Phase 1 exposes no product surface',
  `edge answered ${edge.status}`,
);

const gatewayEnv = sh('docker', ['inspect', '-f', '{{json .Config.Env}}', 'vip-prod-gateway-1']);
check(
  !/INFERENCE_URL/.test(gatewayEnv),
  'the gateway holds no upstream for it either — absence of a route, not a disabled one',
);

/* ── 3 · health, readiness, startup ──────────────────────────────────────────────────────────── */
console.log('\n3 · health · readiness · startup');

const h = get('/health');
check(
  h.status === 200 && h.json?.success === true && h.json?.data?.status === 'ok',
  'GET /health answers 200 in the platform envelope',
  JSON.stringify(h.json?.data ?? h.body.slice(0, 60)),
);

const ready = get('/ready');
const checks = ready.json?.checks ?? [];
check(
  ready.status === 200 && ready.json?.status === 'pass' && checks.length > 0,
  '⚠️ GET /ready reports named checks, not a bare ok — readiness must be able to fail',
  `${ready.json?.status} · ${checks.map((c) => `${c.name}=${c.status}`).join(', ')}`,
);
/*
 * ⚠️ A shape difference, recorded rather than smoothed over: every TypeScript service answers
 * `/ready` inside the `{success,data}` envelope and the runtime answers bare. Nothing consumes it
 * today, and the System Health page would need to know — so it is written down now, while it is
 * cheap, instead of being discovered by a red panel in a later phase.
 */
if (ready.json?.success === undefined) {
  finding(
    '/ready is not in the {success,data} envelope the ten TS services use',
    'harmless today (nothing consumes it); it is a compatibility note for the phase that adds the runtime to System Health',
  );
}

const info = get('/');
check(
  info.json?.data?.name === 'inference' && typeof info.json?.data?.runtimeVersion === 'string',
  'GET / identifies the runtime and its version',
  `${info.json?.data?.name} ${info.json?.data?.runtimeVersion}`,
);

const logs = sh('sh', ['-c', `docker logs ${C} 2>&1 | tail -50`]);
check(
  /inference runtime .* listening on .*capabilities:/.test(logs),
  '⚠️ startup is announced with version, backend, address and the capability set it loaded',
  (logs.split('\n').find((l) => /listening on/.test(l)) ?? '').slice(0, 90),
);

/*
 * ⚠️ The honest half of "verify logging". The runtime silences per-request logging deliberately
 * (`log_message` returns None, "logs aggregated elsewhere" — and elsewhere was never built), so a
 * deployed runtime says one sentence at boot and nothing ever again. Measured, not assumed: issue
 * requests and see whether the log grows.
 */
const linesBefore = logs.split('\n').filter(Boolean).length;
for (let i = 0; i < 5; i += 1) get('/health');
const linesAfter = sh('sh', ['-c', `docker logs ${C} 2>&1 | tail -50`])
  .split('\n')
  .filter(Boolean).length;
if (linesAfter === linesBefore) {
  finding(
    'the runtime logs NOTHING after startup — five requests produced zero log lines',
    'an operator cannot tell a serving runtime from a wedged one without polling it; recommended fix in the Phase 1 report',
  );
} else {
  check(true, 'per-request logging is emitted', `${linesAfter - linesBefore} lines for 5 requests`);
}

/* ── 4 · metrics ─────────────────────────────────────────────────────────────────────────────── */
console.log('\n4 · metrics');

const m = get('/metrics');
/* ⚠️ `[a-z0-9_]`, not `[a-z_]`: the first version of this regex stopped at the digit in `p50`/`p95`
   and reported the two latency percentiles missing. The check went red and the product was fine —
   which is the correct order to discover that in. */
const metricNames = [...m.body.matchAll(/^([a-z_][a-z0-9_]*)\s/gm)].map((x) => x[1]);
const wanted = [
  'inference_frames_processed_total',
  'inference_frames_dropped_total',
  'inference_latency_ms_p95',
];
check(
  m.status === 200 && wanted.every((n) => metricNames.includes(n)),
  'GET /metrics exposes Prometheus counters an operator can scrape',
  `${new Set(metricNames).size} series`,
);

const sched = get('/scheduler');
const res = sched.json?.data?.resources;
check(
  typeof res?.memoryMb === 'number' && typeof res?.cpuPercent === 'number',
  '⚠️ the scheduler reports MEASURED resource use, not a configured figure',
  `${res?.memoryMb?.toFixed(1)} MB · ${res?.cpuPercent}% CPU · ${res?.logicalCores} cores`,
);
check(
  (sched.json?.data?.computeResources ?? []).length > 0,
  'and it has detected the compute it believes it may use',
  (sched.json?.data?.computeResources ?? []).map((r) => r.label).join(', '),
);

/*
 * ⚠️ Found by deploying, invisible to every unit test: capacity comes from `os.cpu_count()`, which
 * reports the HOST's cores inside a container and ignores the cgroup CPU quota entirely. With no
 * limit set — which is how this stack runs today — the belief is correct. Under `cpus: 2` the
 * scheduler would admit sessions for capacity it is not allowed to use, and the failure would land
 * as dropped frames on every camera instead of a refusal on one.
 */
const cores = res?.logicalCores;
/* Same reason as `get()`: an unreachable container is a finding, not a stack trace. */
const quota = sh('sh', [
  '-c',
  `docker exec ${C} sh -c 'cat /sys/fs/cgroup/cpu.max 2>/dev/null' 2>/dev/null || echo unknown`,
]);
if (!/^max/.test(quota) && quota !== 'unknown') {
  finding(
    `the runtime believes it has ${cores} cores while its cgroup quota is "${quota}"`,
    'admission control would over-admit — must be fixed before Phase 4 gives it sessions',
  );
} else {
  check(
    true,
    '⚠️ no CPU quota is set, so the detected core count is the truth for this deployment',
    `cpu.max=${quota} · ${cores} cores`,
  );
}

/* ── 5 · Phase 1 connects nothing, and that is asserted ──────────────────────────────────────── */
console.log('\n5 · no camera, no session, no frame');

const sup = get('/supervisor').json?.data;
check(
  sup?.activeSessions === 0 && sup?.maxSessions > 0,
  '⚠️ zero live sessions — and the ceiling reads, so the zero is a measurement not a missing field',
  `${sup?.activeSessions}/${sup?.maxSessions} sessions`,
);

const status = get('/status').json?.data ?? [];
const totalFrames = status.reduce((n, s) => n + (s.metrics?.framesProcessed ?? 0), 0);
check(
  status.length > 0 && totalFrames === 0,
  'no frame has been processed by any capability',
  `${status.length} capability/ies · ${totalFrames} frames`,
);

const caps = get('/capabilities').json?.data ?? [];
check(
  caps.length === 1 && caps[0]?.id === 'perception.person-detection',
  'exactly the manifest set on disk is loaded — nothing more is registered than is declared',
  caps.map((c) => c.id).join(', '),
);

/*
 * ⚠️ The stub backend answers with a MODEL IDENTITY it invented — `person-detection v1, family
 * yolo`. Nothing is registered; `FakeModelResolver` produced it. This is exactly the reading that
 * must never reach a screen, and the reason no console surface may exist before Phase 5.
 */
const provider = status[0]?.executionProvider;
check(
  provider === 'stub',
  '⚠️ and it says `stub` where the execution provider goes — the model name it reports is fabricated',
  `provider=${provider} · model=${status[0]?.model?.name}@${status[0]?.model?.version} (${status[0]?.model?.family})`,
);

/* ── 6 · independence and restart ────────────────────────────────────────────────────────────── */
console.log('\n6 · it survives what it does not depend on');

const deps = sh('sh', [
  '-c',
  `docker inspect -f '{{index .Config.Labels "com.docker.compose.depends_on"}}' ${C}`,
]);
check(
  deps === '' || deps === '<no value>',
  '⚠️ the runtime declares NO infrastructure dependency — stub backend, null sink, nothing persisted',
  deps || 'none',
);

/* Proven, not asserted: pause the database the rest of the platform cannot live without. */
sh('docker', ['pause', 'vip-prod-mongodb-1']);
let survived = false;
try {
  const during = get('/health');
  survived = during.status === 200;
} finally {
  sh('docker', ['unpause', 'vip-prod-mongodb-1']);
}
check(survived, '⚠️ it keeps answering while MongoDB is PAUSED — measured by pausing it');

/* A restart must come back healthy on its own, or `restart: unless-stopped` is decoration. */
const started = Date.now();
sh('docker', ['restart', C]);
let backHealthy = false;
for (let i = 0; i < 40; i += 1) {
  if (inspect('{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}') === 'healthy') {
    backHealthy = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
check(
  backHealthy,
  'it returns to healthy after a restart',
  `${((Date.now() - started) / 1000).toFixed(0)}s`,
);

const exitCode = sh('sh', [
  '-c',
  `docker inspect -f '{{.State.ExitCode}}' ${C} 2>/dev/null || echo n/a`,
]);
check(
  inspect('{{.State.Status}}') === 'running',
  'and it is running again, not restart-looping',
  `last exit ${exitCode}`,
);

/* ── 7 · secrets ─────────────────────────────────────────────────────────────────────────────── */
console.log('\n7 · what it must never say');

const key = sh('sh', [
  '-c',
  `grep '^INTERNAL_API_KEY=' .env.production | cut -d= -f2- | tr -d '\\n'`,
]);
const allLogs = sh('sh', ['-c', `docker logs ${C} 2>&1`]);
check(key.length >= 16, 'the internal key is set and long enough to be meaningful to search for');
/*
 * ⚠️ The positive control. "The key is not in the log" is also true of an empty log, of the wrong
 * container, and of a search that never ran — three ways to pass while measuring nothing. So the
 * same haystack is required to contain something that is definitely in it, first.
 */
check(
  allLogs.includes('inference runtime'),
  'the log was actually read — the haystack contains what it must contain',
  `${allLogs.length} bytes`,
);
check(!allLogs.includes(key), '⚠️ the internal key never appears in the container log');
const surfaces = ['/', '/capabilities', '/status', '/scheduler', '/supervisor', '/metrics']
  .map((p) => get(p).body)
  .join('\n');
check(
  surfaces.includes('perception.person-detection'),
  'and every endpoint answered before being searched',
  `${surfaces.length} bytes across 6 endpoints`,
);
check(!surfaces.includes(key), 'nor in any endpoint an operator or scraper can read');

/* ── done ────────────────────────────────────────────────────────────────────────────────────── */
console.log('');
if (findings.length > 0) {
  console.log(`⚠️ ${findings.length} finding(s) recorded — not failures, and not to be forgotten:`);
  for (const f of findings) console.log(`   · ${f}`);
  console.log('');
}
console.log(
  failures === 0
    ? '✓ P-8 Phase 1: the AI runtime is deployed and every check passed\n'
    : `✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);

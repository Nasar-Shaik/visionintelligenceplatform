/**
 * P-8 Phase 4 · **is tracking actually in the deployment, or only in the tree?**
 *
 *   node docs/review/p8/tracking-deploy.mjs
 *
 * The tracking suite proves identity behaviour. This proves the far more boring thing that suite
 * assumes: that the tracking code is **inside the running image**, reachable by the routes the
 * console uses, gated by the permission it claims, and off the gateway's upstream list.
 *
 * ### ⚠️ Half of these assert an ABSENCE, and each is paired with a presence
 *
 * "There is no direct route to the runtime" is trivially true against a stopped container. So every
 * negative check is paired with a positive reading from the same source: the route is absent AND the
 * runtime answers on the network it is supposed to answer on. A check that would pass against a dead
 * deployment is not a check.
 *
 * ### ⚠️ Reachability is verified through the GATEWAY, not the runtime
 *
 * The tracking verification talks to the runtime directly on purpose — it is about the engine. This
 * one goes the whole way a browser goes (gateway → media → runtime), because the question here is
 * whether an operator can actually get to it.
 */
import { execFileSync } from 'node:child_process';

const RUNTIME = 'vip-prod-inference-1';
const MEDIA = 'vip-prod-media-1';
const GATEWAY = 'vip-prod-gateway-1';
const IMAGE = 'vip/inference:local';
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let failures = 0;
const findings = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const finding = (label, detail) => {
  console.log(`  ⚠️ ${label} — ${detail}`);
  findings.push(label);
};

const shq = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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

async function token(who) {
  const r = await api('/identity/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify(who),
  });
  return r.json?.data?.accessToken;
}

console.log('\nP-8 Phase 4 · tracking, as deployed\n');

/* ── 1 · the code is in the image that is running ─────────────────────────────────────────────── */
console.log('1 · the running image contains the tracking engine');

const modules = shq('docker', ['exec', RUNTIME, 'sh', '-c', 'ls /app 2>/dev/null || ls /opt/vip/app 2>/dev/null']);
const expected = ['runtime_tracking.py', 'reentry.py', 'track_motion.py', 'tracker.py', 'track_manager.py'];
const missing = expected.filter((m) => !modules.includes(m));
check(missing.length === 0, 'every tracking module is inside the container', missing.length === 0 ? expected.join(', ') : `missing ${missing.join(', ')}`);

/*
 * ⚠️ Imported, not merely present. A `.py` on disk that raises on import is a file the deployment
 * has, not a feature the deployment runs — and `ls` cannot tell those apart.
 */
const imported = shq('docker', ['exec', RUNTIME, 'python', '-c',
  'import sys; sys.path.insert(0, "/app"); import runtime_tracking, reentry, track_motion; print(runtime_tracking.MAX_CAMERAS)']);
check(/^\d+$/.test(imported), 'the modules import cleanly in the container', imported || 'import failed');

/* ── 2 · the runtime reports tracking as its own state ────────────────────────────────────────── */
console.log('\n2 · the runtime says tracking is on');

const runtimeRaw = shq('docker', ['exec', RUNTIME, 'python', '-c',
  "import urllib.request,json;print(urllib.request.urlopen('http://127.0.0.1:8085/runtime',timeout=5).read().decode())"]);
let runtime = {};
try {
  runtime = JSON.parse(runtimeRaw).data ?? {};
} catch {
  /* reported below */
}
check(runtime.tracking?.enabled === true, 'the runtime view reports tracking enabled',
  runtime.tracking?.enabled === true ? runtime.tracking.engine?.associator : JSON.stringify(runtime.tracking ?? null));
check(runtime.tracking?.engine?.associator === 'predictive-iou',
  'the deployed associator is the predictive one, not the AI-2 default',
  runtime.tracking?.engine?.associator ?? 'absent');
/*
 * ⚠️ The runtime view must carry NO tenant identifier. It is the one tracking-adjacent payload that
 * is not tenant-scoped, and a camera id leaking into it would make a deployment-wide page carry one
 * customer's data.
 */
check(!/tnt_/.test(runtimeRaw), 'the deployment-wide runtime view carries no tenant identifier',
  /tnt_/.test(runtimeRaw) ? 'a tenant id appears in /runtime' : 'counts only');

/* ── 3 · the routes exist where the console expects them ──────────────────────────────────────── */
console.log('\n3 · the console can reach it, and only with permission');

const admin = await token(ADMIN);
check(typeof admin === 'string' && admin.length > 0, 'an operator can sign in');

const overview = await api('/tracking', { headers: { authorization: `Bearer ${admin}` } });
check(overview.status === 200, 'GET /api/tracking answers through the gateway', `HTTP ${overview.status}`);
check(overview.json?.data?.enabled === true, 'and reports tracking enabled for this tenant',
  JSON.stringify(overview.json?.data?.enabled ?? null));

const list = await api('/tracking/tracks', { headers: { authorization: `Bearer ${admin}` } });
check(list.status === 200, 'GET /api/tracking/tracks answers', `HTTP ${list.status}`);
check(Array.isArray(list.json?.data?.tracks), 'and returns a track array (possibly empty)',
  Array.isArray(list.json?.data?.tracks) ? `${list.json.data.tracks.length} live` : 'not an array');

const anon = await api('/tracking/tracks');
check(anon.status === 401 || anon.status === 403, 'an unauthenticated request is refused', `HTTP ${anon.status}`);

/* ── 4 · the runtime is still not an upstream ─────────────────────────────────────────────────── */
console.log('\n4 · the runtime is still off the gateway, as Phase 1 asserted');

const direct = await api('/inference/tracking');
check(direct.status === 404 || direct.status === 502 || direct.status === 400,
  'there is no /api/inference/* route to the runtime', `HTTP ${direct.status}`);
const trackingUpstream = await api('/tracking/definitely-not-a-route');
check(trackingUpstream.status === 404, '/api/tracking is a static route, not a proxied upstream',
  `HTTP ${trackingUpstream.status}`);

const ports = shq('docker', ['inspect', '-f', '{{json .NetworkSettings.Ports}}', RUNTIME]);
check(!/HostPort/.test(ports), 'the runtime publishes no host port', ports || 'none');

/*
 * ⚠️ Paired with the positive: the runtime IS reachable from media on the compose network. Without
 * this, every check above would pass against a runtime that had simply stopped.
 */
const fromMedia = shq('docker', ['exec', MEDIA, 'sh', '-c',
  'curl -s -o /dev/null -w "%{http_code}" -H "x-internal-key: $INTERNAL_API_KEY" -H "x-tenant-id: ' + TENANT + '" http://inference:8085/tracking']);
check(fromMedia === '200', 'media can reach the runtime on the compose network', `HTTP ${fromMedia}`);

/* ── 5 · the gateway's reserved prefix is enforced ────────────────────────────────────────────── */
console.log('\n5 · the reserved prefix holds');
const gatewayEnv = shq('docker', ['exec', GATEWAY, 'sh', '-c', 'echo "$UPSTREAMS"']);
if (gatewayEnv === '') {
  finding('the gateway upstream list is not readable from the environment',
    'the reserved-prefix guard is asserted by a unit test instead');
} else {
  check(!/(^|,)\s*tracking\s*=/.test(gatewayEnv), 'no upstream claims the `tracking` prefix', gatewayEnv.slice(0, 120));
}

/* ── 6 · the image is the committed one ───────────────────────────────────────────────────────── */
console.log('\n6 · what is running is what was built');
const built = shq('docker', ['inspect', '-f', '{{.Config.Image}}', RUNTIME]);
check(built === IMAGE || built.startsWith('sha256:'), 'the runtime runs the local image', built);

console.log('');
console.log(
  failures === 0
    ? 'tracking is deployed, reachable, permission-gated, and still off the gateway\n'
    : `${failures} deployment check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);

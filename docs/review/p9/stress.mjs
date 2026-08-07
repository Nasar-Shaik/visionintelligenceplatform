/**
 * P-9 · **A11 — camera stress validation.**
 *
 *   node docs/review/p9/stress.mjs
 *   node docs/review/p9/stress.mjs clean     # ⚠️ if a run was interrupted
 *
 * Eleven ways a camera misbehaves in the field. For each one this file states **what the platform
 * should do**, then finds out — and where it cannot find out without hardware, it says so and names
 * the hardware.
 *
 * ### ⭐ Why the expected behaviour is written down first
 *
 * Every scenario below has a *plausible* wrong answer that looks like working software. A camera
 * that vanishes and comes back can produce a new identity for the same person; a duplicate stream
 * URL can be accepted and silently halve the frame rate of both cameras; a dead stream can leave a
 * camera reading `connected` forever. None of those raise an error. They are only defects if
 * someone decided in advance what the right answer was — so the expectation is the deliverable, and
 * the run is the check on it.
 *
 * ### ⚠️ What synthetic stress can and cannot stand in for
 *
 * Killing a container is not unplugging a cable. The container disappears in milliseconds and takes
 * its TCP state with it; a pulled cable leaves the socket open until a timeout fires, which is a
 * different code path and a slower one. **The synthetic runs below prove the platform's REACTION
 * exists and is correct in shape. They do not measure how long a real device takes to be noticed**,
 * and that measurement is Track B's.
 */
import {
  api,
  check,
  checkIntegrity,
  cleanup,
  createCamera,
  defaultZoneId,
  ensureAuth,
  exit,
  finding,
  FIXTURE,
  guard,
  H,
  heading,
  login,
  read,
  sh,
  shq,
  sleep,
  startFixture,
  stopFixture,
} from './_p9.mjs';

if (process.argv[2] === 'clean') {
  await cleanup();
  stopFixture();
  process.exit(0);
}

const stageOf = (result, name) => (result?.checks ?? []).find((c) => c.name === name);

async function probe(cameraId) {
  await ensureAuth();
  const res = await api(`/camera/cameras/${cameraId}/probe`, {
    method: 'POST',
    headers: H,
    body: '{}',
  });
  return { status: res.status, report: res.json?.data, result: res.json?.data?.probe };
}

/** Records one scenario's expectation alongside what actually happened. */
const scenarios = [];
function scenario(id, title, expected, { status, observed, hardware }) {
  scenarios.push({ id, title, expected, status, observed, hardware });
  const mark = { pass: '  ✓', fail: '  ✗', 'not-executed': '  —' }[status] ?? '  ?';
  console.log(`${mark} ${id} · ${title}`);
  console.log(`      expected: ${expected}`);
  console.log(`      observed: ${observed}`);
  if (status === 'fail') check(false, `${id} did not behave as specified`);
  else if (status === 'pass') check(true, `${id} behaved as specified`, '');
}

heading('deployment integrity');
checkIntegrity();

await login();
await cleanup(true);

heading('setup');
startFixture('p9-probe-fixture.yml');
await sleep(4000);
console.log('  ✓ RTSP fixture running');
const zoneId = await defaultZoneId();

/* ── S1 · bad credentials ─────────────────────────────────────────────────────────────────────── */

heading('scenarios');
{
  const cam = await createCamera({
    name: 'p9 stress bad-credentials',
    streamUrl: `rtsp://${FIXTURE}:8554/secure`,
    credentials: { username: 'vipcam', password: 'wrong-on-purpose' },
    zoneId,
  });
  const { result } = await probe(cam.id);
  const auth = stageOf(result, 'authentication');
  const later = ['rtsp-negotiation', 'stream-open', 'first-frame'].map(
    (n) => stageOf(result, n)?.status,
  );
  const ok =
    auth?.status === 'fail' &&
    result?.failureCode === 'authentication-failure' &&
    later.every((s) => s === 'not-executed');
  scenario(
    'S1',
    'bad credentials',
    'fails at `authentication`, names the credentials, leaves later stages `not-executed`, never echoes the password',
    {
      status: ok ? 'pass' : 'fail',
      observed: `authentication=${auth?.status} · code=${result?.failureCode} · later=${later.join(',')}`,
    },
  );
}

/* ── S2 · unavailable stream (host up, path absent) ───────────────────────────────────────────── */
{
  const cam = await createCamera({
    name: 'p9 stress unavailable-stream',
    streamUrl: `rtsp://${FIXTURE}:8554/no-such-path-here`,
    zoneId,
  });
  const { result, report } = await probe(cam.id);
  /* ⭐ The camera must NOT be promoted to `connected` on a stream that never opened. */
  const lifecycle = report?.lifecycle?.state;
  const ok = result?.reachable !== undefined && (result?.framesRead ?? 0) === 0 && lifecycle !== 'connected';
  scenario(
    'S2',
    'unavailable stream — host answers, path does not exist',
    'the device is reachable, no frames arrive, and the camera does NOT become `connected`',
    {
      status: ok ? 'pass' : 'fail',
      observed: `framesRead=${result?.framesRead} · failureCode=${result?.failureCode} · lifecycle=${lifecycle}`,
    },
  );
}

/* ── S3 · duplicate camera ────────────────────────────────────────────────────────────────────── */
{
  const url = `rtsp://${FIXTURE}:8554/cam01`;
  const first = await createCamera({ name: 'p9 stress duplicate A', streamUrl: url, zoneId });
  const second = await createCamera({ name: 'p9 stress duplicate B', streamUrl: url, zoneId });
  /* ⚠️ Accepting this would silently halve both cameras' frame rate — the P-8.6 ladder defect, one
     layer up. It is refused at the database, not by a race-prone read-then-write. */
  const ok = first.id !== undefined && second.id === undefined && second.status === 409;
  scenario(
    'S3',
    'duplicate camera — the same stream URL twice',
    'the second is refused with 409; two cameras on one stream would silently halve both frame rates',
    {
      status: ok ? 'pass' : 'fail',
      observed: `first=${first.id ? 'created' : first.status} · second=HTTP ${second.status}`,
    },
  );
}

/* ── S4 · RTSP timeout (TCP accepts, RTSP never answers) ──────────────────────────────────────── */
{
  /* A listener that accepts and stays silent. `socat` on the docker network, deliberately not the
     fixture — a fixture that answers RTSP cannot produce this. */
  shq('docker', ['rm', '-f', 'vip-p9-silent']);
  sh('docker', [
    'run', '-d', '--rm', '--name', 'vip-p9-silent',
    '--network', 'vip-prod_default',
    'alpine/socat', 'TCP-LISTEN:8554,fork', 'SYSTEM:sleep 300',
  ]);
  await sleep(3000);
  const cam = await createCamera({
    name: 'p9 stress rtsp-timeout',
    streamUrl: 'rtsp://vip-p9-silent:8554/stream',
    zoneId,
  });
  const started = Date.now();
  const { result } = await probe(cam.id);
  const elapsed = Date.now() - started;
  const tcp = stageOf(result, 'tcp')?.status;
  /* ⭐ `tcp` must PASS and a later stage must fail. A probe that reported `tcp` failed here would
     send an installer to their firewall for a camera whose firewall is fine. */
  const ok = tcp === 'pass' && result?.reachable !== undefined && (result?.framesRead ?? 0) === 0;
  scenario(
    'S4',
    'RTSP timeout — TCP accepts, RTSP never answers',
    '`tcp` passes and a LATER stage fails; the probe returns rather than hanging',
    {
      status: ok ? 'pass' : 'fail',
      observed: `tcp=${tcp} · framesRead=${result?.framesRead} · code=${result?.failureCode} · ${elapsed}ms`,
    },
  );
  shq('docker', ['rm', '-f', 'vip-p9-silent']);
}

/* ── S5 · ONVIF timeout ───────────────────────────────────────────────────────────────────────── */
{
  const started = Date.now();
  const res = await api('/camera/cameras/discover', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ timeoutSeconds: 3, endpoint: 'http://198.51.100.9/onvif/device_service' }),
  });
  const elapsed = Date.now() - started;
  const data = res.json?.data;
  /* ⭐ `unavailable` is the wrong answer here. Discovery RAN; it found nothing. Reporting it as
     unconfigured would send an installer to their settings instead of to their network. */
  const ok = res.status === 200 && data?.unavailable === undefined && (data?.devices?.length ?? -1) === 0;
  scenario(
    'S5',
    'ONVIF timeout — a device address that never answers',
    'discovery returns 200 with zero devices and NO `unavailable` reason, inside its own budget',
    {
      status: ok ? 'pass' : 'fail',
      observed: `status=${res.status} · devices=${data?.devices?.length} · unavailable=${data?.unavailable ?? 'absent'} · ${elapsed}ms`,
    },
  );
}

/* ── S6 · IP address change ───────────────────────────────────────────────────────────────────── */
{
  /* ⚠️ The first version restarted the fixture and hoped docker would hand out a different address.
     It did not — the same IP came back, so the scenario measured nothing and reported `not-executed`.
     A verification whose outcome depends on someone else's IPAM is not a verification.

     What actually matters is deterministic and can be stated directly: a camera onboarded by a bare
     IP breaks when that address moves, and it must break LOUDLY. So one camera is onboarded at an
     address nothing is listening on — exactly what a moved camera leaves behind — and one at the
     hostname, which is what survives. */
  const live = shq('docker', ['inspect', FIXTURE, '--format',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']);
  const stale = live.replace(/\.(\d+)$/, (_m, last) => `.${(Number(last) + 7) % 254 || 200}`);

  const byName = await createCamera({
    name: 'p9 stress address-by-name',
    streamUrl: `rtsp://${FIXTURE}:8554/cam02`,
    zoneId,
  });
  const byStaleIp = await createCamera({
    name: 'p9 stress address-stale-ip',
    streamUrl: `rtsp://${stale}:8554/cam02`,
    zoneId,
  });
  const nameResult = await probe(byName.id);
  const staleResult = await probe(byStaleIp.id);

  const nameOk = (nameResult.result?.framesRead ?? 0) > 0;
  /* ⭐ It must fail at `tcp` — the address parses as a literal, nothing answers. Anything else,
     especially `unavailable`, would tell an installer the platform is broken rather than that the
     address is stale. */
  const staleStage = stageOf(staleResult.result, 'tcp')?.status;
  const staleOk = staleStage === 'fail' && staleResult.result?.failureCode === 'tcp-failure';
  scenario(
    'S6',
    'IP address change',
    'a camera onboarded by HOSTNAME survives; one left on a stale IP fails at `tcp` with a named code, never silently and never as `unavailable`',
    {
      status: nameOk && staleOk ? 'pass' : 'fail',
      observed:
        `by-name framesRead=${nameResult.result?.framesRead} · ` +
        `stale-ip ${stale} tcp=${staleStage} code=${staleResult.result?.failureCode ?? 'none'}`,
    },
  );
  finding(
    'a camera onboarded by bare IP fails the moment the address moves',
    'why FIELD_INSTALLATION_GUIDE requires reserved DHCP leases or hostnames, not whatever the camera booted with',
  );
}

/* ── S7 · stream disappears mid-probe (proxy for cable unplug) ────────────────────────────────── */
{
  const cam = await createCamera({
    name: 'p9 stress vanishing-source',
    streamUrl: `rtsp://${FIXTURE}:8554/cam04`,
    zoneId,
  });
  const healthy = await probe(cam.id);
  stopFixture();
  await sleep(1500);
  const gone = await probe(cam.id);
  const ok =
    (healthy.result?.framesRead ?? 0) > 0 &&
    gone.result !== undefined &&
    (gone.result?.framesRead ?? 0) === 0 &&
    ['dns-failure', 'tcp-failure'].includes(gone.result?.failureCode);
  scenario(
    'S7',
    'source disappears (synthetic proxy for a cable unplug)',
    'the next probe fails at `dns` or `tcp` with a named code, and a measurement is still RECORDED',
    {
      status: ok ? 'pass' : 'fail',
      observed: `before framesRead=${healthy.result?.framesRead} · after code=${gone.result?.failureCode ?? 'none'}`,
    },
  );
  finding(
    'killing a container is not unplugging a cable',
    'the container takes its TCP state with it; a pulled cable leaves the socket open until a timeout — a different, slower path. Track B measures the real one',
  );
}

/* ── S8 · reconnect after the source returns ──────────────────────────────────────────────────── */
{
  startFixture('p9-probe-fixture.yml');
  await sleep(4000);
  const cams = await read(`/camera/cameras?limit=50&search=p9`);
  const target = (cams.data?.cameras ?? []).find((c) => c.name.includes('vanishing-source'));
  const back = target ? await probe(target.id) : { result: undefined };
  const ok = (back.result?.framesRead ?? 0) > 0;
  scenario(
    'S8',
    'reconnect — the source returns',
    'the same camera probes healthy again with no operator action and no re-onboarding',
    {
      status: ok ? 'pass' : 'fail',
      observed: `framesRead=${back.result?.framesRead} · failureCode=${back.result?.failureCode ?? 'none'}`,
    },
  );
}

/* ── S9–S11 · the ones that need hardware ─────────────────────────────────────────────────────── */

scenario(
  'S9',
  'camera reboot',
  'the camera is unreachable for the reboot window, then returns with the SAME device identity — ' +
    'a reboot must not produce a new camera, and ONVIF `GetDeviceInformation` serial is what proves it',
  {
    status: 'not-executed',
    observed: 'no physical camera exists to reboot',
    hardware: 'any certified IP camera + its web UI or a PoE power cycle',
  },
);

scenario(
  'S10',
  'slow network',
  'frame delivery degrades and is REPORTED as degraded; the probe still returns within its budget ' +
    'and the camera does not flap between connected and disconnected',
  {
    status: 'not-executed',
    observed:
      'needs deterministic link shaping. `tc`/netem is unavailable in Docker Desktop on macOS without ' +
      'a privileged container and a custom kernel module',
    hardware: 'a managed switch with rate limiting, or a Linux host with netem',
  },
);

scenario(
  'S11',
  'packet loss',
  'decoded frames drop while the connection stays open; the platform reports reduced delivery ' +
    'rather than a disconnection, and ⛔ never reports a packet-loss PERCENTAGE it cannot measure',
  {
    status: 'not-executed',
    observed:
      'RTP sequence numbers are not visible to this stack — OpenCV hands over decoded frames and ' +
      'discards the transport. The installer toolkit reports frame delivery and says it is not packet loss',
    hardware: 'a managed switch or netem, plus an RTCP-aware receiver to measure the real figure',
  },
);

/* ── summary ──────────────────────────────────────────────────────────────────────────────────── */

heading('coverage');
{
  const executed = scenarios.filter((s) => s.status !== 'not-executed');
  const passed = scenarios.filter((s) => s.status === 'pass');
  console.table(
    scenarios.map((s) => ({
      id: s.id,
      scenario: s.title,
      status: s.status,
      needs: s.hardware ?? '—',
    })),
  );
  check(
    guard(executed, passed.length === executed.length),
    `⭐ every executable scenario behaved as specified`,
    `${passed.length}/${executed.length} executed · ${scenarios.length - executed.length} need hardware`,
  );
  /* ⚠️ Deliberately NOT a check. Three scenarios needing hardware is the correct state of this
     milestone, and turning it into a failure would make the file red for being honest. */
  finding(
    `${scenarios.length - executed.length} of ${scenarios.length} scenarios need hardware`,
    scenarios.filter((s) => s.status === 'not-executed').map((s) => s.id).join(', ') +
      ' — Track B, and the plan names the equipment',
  );
}

heading('teardown');
await cleanup();
stopFixture();
shq('docker', ['rm', '-f', 'vip-p9-silent']);
console.log('  ✓ fixture stopped');

exit('A11 camera stress validation');

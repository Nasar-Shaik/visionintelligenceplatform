/**
 * P-9 · **A2 — does the staged probe name the right stage?**
 *
 *   node docs/review/p9/stream-probe.mjs
 *   node docs/review/p9/stream-probe.mjs clean     # ⚠️ if a run was interrupted
 *
 * ### What a staged probe is for
 *
 * `dns → tcp → authentication → rtsp-negotiation → stream-open → first-frame → codec → …`. The
 * point is never the boolean at the end; it is **which stage stopped**. `dns` sends an installer to
 * their DNS server, `tcp` to their firewall, `authentication` to their password, `first-frame` to
 * the camera itself. A probe that reports "failed" sends them to all four.
 *
 * ⚠️ Until [A1](discovery.mjs), none of this ran in a deployed product — `HttpStreamProbe` fell back
 * to `UnavailableStreamProbe` because `CAMERA_DISCOVERY_URL` was unset. So every stage below is
 * being exercised through the deployed path **for the first time**.
 *
 * ### ⭐ The case that needed a new fixture
 *
 * `authentication` cannot be provoked by an open server. `stream_probe.py` classifies an auth
 * failure by **pattern-matching the transport's error text** (`_AUTH_MARKERS` = "401",
 * "unauthorized", …) — a match against strings produced by someone else's library, which will keep
 * producing a well-formed report with `authentication: not-executed` on the day that library rewords
 * its errors. `infra/docker/fixtures/p9-probe-fixture.yml` adds a credentialed path so the stage is
 * measured rather than assumed.
 *
 * ⚠️ **Synthetic throughout.** L-1 stands: no camera has been connected. This measures the platform's
 * probe path, not any vendor's behaviour.
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
  H,
  heading,
  login,
  sleep,
  startFixture,
  stopFixture,
} from './_p9.mjs';

const CREDS = { username: 'vipcam', password: 'Vip-Fixture-2026' };

if (process.argv[2] === 'clean') {
  await cleanup();
  stopFixture();
  process.exit(0);
}

/**
 * The ordered stage list, as `StreamProbeCheckName` declares it — all thirteen.
 * ⚠️ The first version of this file listed ten and reported the three it had forgotten as contract
 * violations. A check written against a hand-copied subset of a contract tests the copy.
 */
const ORDER = [
  'dns',
  'tcp',
  'authentication',
  'rtsp-negotiation',
  'stream-open',
  'first-frame',
  'frames-received',
  'codec',
  'resolution',
  'fps',
  'stream-profile',
  'latency',
  'jitter',
];

const stageOf = (result, name) => (result?.checks ?? []).find((c) => c.name === name);
const render = (result) =>
  (result?.checks ?? [])
    .map((c) => `${c.name}=${c.status}${c.measured ? `(${c.measured})` : ''}`)
    .join(' ');

/** Probe one camera and return the measurement, never a fabricated empty one. */
async function probe(cameraId) {
  await ensureAuth();
  const res = await api(`/camera/cameras/${cameraId}/probe`, {
    method: 'POST',
    headers: H,
    body: '{}',
  });
  return {
    status: res.status,
    report: res.json?.data,
    result: res.json?.data?.probe,
    text: res.text,
  };
}

heading('deployment integrity');
checkIntegrity();

await login();
await cleanup(true);

heading('setup');
startFixture('p9-probe-fixture.yml');
await sleep(4000);
console.log('  ✓ credentialed RTSP fixture running');
const zoneId = await defaultZoneId();
check(zoneId !== undefined, 'a zone exists to attach cameras to', zoneId ?? '(none)');

/* ── the success path ─────────────────────────────────────────────────────────────────────────── */

heading('an open stream that works');
{
  const cam = await createCamera({
    name: `${'p9'} probe open`,
    streamUrl: `rtsp://${FIXTURE}:8554/p9probe`,
    zoneId,
  });
  check(cam.id !== undefined, 'camera created', cam.id ?? cam.text.slice(0, 120));

  const { status, result } = await probe(cam.id);
  check(status === 200, 'the probe answered 200', `status ${status}`);
  check(result !== undefined, 'and returned a measurement rather than `unavailable`');
  console.log(`    ${render(result)}`);

  check(result?.reachable === true, 'reachable', String(result?.reachable));
  check((result?.framesRead ?? 0) > 0, 'frames were decoded', `framesRead=${result?.framesRead}`);
  check(stageOf(result, 'first-frame')?.status === 'pass', 'first-frame passed');
  check(
    stageOf(result, 'tcp')?.status === 'pass' && stageOf(result, 'dns')?.status === 'pass',
    'dns and tcp passed before it',
  );
  check(result?.failureCode === undefined, 'no failure code', result?.failureCode ?? 'absent');

  /* ⭐ Measured, not declared. The probe must report what the device really sent. */
  check(/^\d+x\d+$/.test(result?.resolution ?? ''), 'resolution was measured', result?.resolution);
  check((result?.fps ?? 0) > 0, 'fps was measured', String(result?.fps));

  /* ⛔ Codec is the exception, and it is a real limitation rather than a bug: the stage reports the
     camera's DECLARED codec ("declared, not verified by decode") and reports `not-executed` when
     nothing is declared. The probe decodes frames and never says what they were encoded with.
     Consequence: an H.265-only camera onboards with no warning that no open-source browser will
     play its recordings (TD-29). Recorded here rather than fixed — `CAP_PROP_FOURCC` would answer
     it, and that is frozen-runtime work a real device should justify. */
  const codecStage = stageOf(result, 'codec');
  check(codecStage !== undefined, 'the codec stage is present in the report', codecStage?.status);
  if (codecStage?.status === 'not-executed') {
    finding(
      'codec is `not-executed` on a stream that decoded 3 frames',
      'the stage reports declared capabilities only — the wire codec is never measured (TD-29 risk)',
    );
  }

  /* ⚠️ Every stage the probe ran must be named. A report with `reachable: true` and no checks is a
     boolean wearing a report's clothes, and would pass every assertion above. */
  const named = (result?.checks ?? []).map((c) => c.name);
  check(named.length >= 6, 'the report names its stages', `${named.length} stage(s)`);
  check(
    named.every((n) => ORDER.includes(n)),
    'and every named stage is in the frozen contract',
    named.join(','),
  );

  /* ⛔ The evidence question. A synthetic RTSP fixture is still RTSP, so the runtime's source-type
     mapping calls it `hardware`. Whatever it says, it must be recorded here — this is the value the
     camera service reads when deciding whether a camera may become `connected`, and the value
     certification reads when deciding whether it may certify. */
  const ev = result?.evidenceClass;
  finding(`the probe reports evidenceClass '${ev}'`, 'against a synthetic fixture — see §A2 findings');
  check(ev !== undefined, 'evidenceClass is present at all', String(ev));
}

/* ── authentication ───────────────────────────────────────────────────────────────────────────── */

heading('⭐ a credentialed stream with the WRONG password');
{
  const cam = await createCamera({
    name: 'p9 probe bad-password',
    streamUrl: `rtsp://${FIXTURE}:8554/secure`,
    credentials: { username: CREDS.username, password: 'definitely-not-the-password' },
    zoneId,
  });
  check(cam.id !== undefined, 'camera created', cam.id ?? cam.text.slice(0, 120));

  const { result } = await probe(cam.id);
  console.log(`    ${render(result)}`);

  check(result !== undefined, 'the probe returned a measurement');
  check((result?.framesRead ?? -1) === 0, 'no frames were decoded', `framesRead=${result?.framesRead}`);

  /* ⚠️ `reachable` stays TRUE here, deliberately: the runtime means "the device answered", and a
     camera that rejects a password is emphatically present. The frozen TypeScript contract
     documents the field as "The source opened", which is a different claim. The two have disagreed
     since P-2; neither is changed by this milestone. Recorded, not asserted either way. */
  if (result?.reachable === true) {
    finding(
      '`reachable` is true on an authentication failure',
      'runtime means "the device answered"; the contract comment says "the source opened" — they disagree',
    );
  }

  const auth = stageOf(result, 'authentication');
  check(auth?.status === 'fail', '⭐ it failed at `authentication`', auth?.status ?? 'stage absent');
  check(
    result?.authentication === 'failed',
    'and the authentication state says so',
    result?.authentication,
  );
  check(
    result?.failureCode === 'authentication-failure',
    'with the matching failure code',
    result?.failureCode ?? 'absent',
  );
  check(
    (auth?.detail ?? '').includes('rejected the ones supplied'),
    'and the detail tells the installer which credentials were rejected',
    auth?.detail ?? '(none)',
  );

  /* ⭐ The stages AFTER the failure must be `not-executed`, not `fail`. A probe that marks every
     later stage failed tells an installer their codec is wrong when their password is wrong. */
  const later = ['rtsp-negotiation', 'stream-open', 'first-frame'];
  const laterStatuses = later.map((n) => stageOf(result, n)?.status);
  check(
    laterStatuses.length > 0 && laterStatuses.every((s) => s === 'not-executed'),
    'every later stage is `not-executed`, never `fail`',
    later.map((n, i) => `${n}=${laterStatuses[i] ?? 'absent'}`).join(' '),
  );

  /* ⛔ Credentials must never come back out. */
  const blob = JSON.stringify(result ?? {});
  check(
    !blob.includes('definitely-not-the-password'),
    'the password does not appear anywhere in the report',
  );
}

heading('the same stream with the RIGHT password');
{
  /* ⚠️ Without this case, the previous one passes on a probe that fails authentication always. */
  const cam = await createCamera({
    name: 'p9 probe good-password',
    streamUrl: `rtsp://${FIXTURE}:8554/secure?ok=1`,
    credentials: CREDS,
    zoneId,
  });
  check(cam.id !== undefined, 'camera created', cam.id ?? cam.text.slice(0, 120));

  const { result } = await probe(cam.id);
  console.log(`    ${render(result)}`);
  check(
    stageOf(result, 'authentication')?.status === 'pass',
    '⭐ authentication passed with correct credentials',
    stageOf(result, 'authentication')?.status ?? 'absent',
  );
  check(result?.reachable === true, 'and the stream opened', String(result?.reachable));
  check((result?.framesRead ?? 0) > 0, 'frames decoded', `framesRead=${result?.framesRead}`);
}

/* ── transport failures ───────────────────────────────────────────────────────────────────────── */

heading('a hostname that does not resolve');
{
  const cam = await createCamera({
    name: 'p9 probe bad-dns',
    streamUrl: 'rtsp://no-such-host-p9.invalid:554/stream',
    zoneId,
  });
  check(cam.id !== undefined, 'camera created', cam.id ?? cam.text.slice(0, 120));

  const { result } = await probe(cam.id);
  console.log(`    ${render(result)}`);
  check(stageOf(result, 'dns')?.status === 'fail', '⭐ it failed at `dns`', stageOf(result, 'dns')?.status);
  check(result?.failureCode === 'dns-failure', 'with the matching failure code', result?.failureCode);
  check(
    stageOf(result, 'tcp')?.status === 'not-executed',
    'and `tcp` was never attempted',
    stageOf(result, 'tcp')?.status,
  );
}

heading('a reachable host with nothing listening');
{
  /* The fixture container resolves; port 9 (discard) is not served by it. */
  const cam = await createCamera({
    name: 'p9 probe closed-port',
    streamUrl: `rtsp://${FIXTURE}:9/stream`,
    zoneId,
  });
  check(cam.id !== undefined, 'camera created', cam.id ?? cam.text.slice(0, 120));

  const { result } = await probe(cam.id);
  console.log(`    ${render(result)}`);
  check(stageOf(result, 'dns')?.status === 'pass', '`dns` passed — the name resolved');
  check(stageOf(result, 'tcp')?.status === 'fail', '⭐ and it failed at `tcp`', stageOf(result, 'tcp')?.status);
  check(
    stageOf(result, 'authentication')?.status === 'not-executed',
    'authentication was never attempted',
    stageOf(result, 'authentication')?.status,
  );
}

/* ── the archive ──────────────────────────────────────────────────────────────────────────────── */

heading('every probe was retained');
{
  const r = await api(`/camera/cameras?limit=50&search=p9`, { headers: H });
  const cams = (r.json?.data?.cameras ?? []).filter((c) =>
    (c.metadata?.tags ?? []).includes('p9-fixture'),
  );
  check(cams.length === 5, 'five cameras were probed', `${cams.length}`);

  /* ⚠️ The archive answers `{ cameraId, records: [...] }`. The first version of this check read
     `.probes`, found `undefined`, and reported 0/5 retained against an archive that had every one —
     an absence produced by the reader, not by the product. */
  let archived = 0;
  for (const cam of cams) {
    const h = await api(`/camera/cameras/${cam.id}/probes`, { headers: H });
    const items = h.json?.data?.records;
    if (Array.isArray(items) && items.length > 0) archived += 1;
  }
  /* ⚠️ A probe that could not run is still recorded — a gap in the evidence with a timestamp on it
     is what lets someone tell "we never checked" from "we checked and it was fine". */
  check(archived === cams.length, 'each has a retained probe report', `${archived}/${cams.length}`);
}

heading('teardown');
await cleanup();
stopFixture();
console.log('  ✓ fixture stopped');

exit('A2 staged stream probe');

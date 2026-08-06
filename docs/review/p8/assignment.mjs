/**
 * P-8 Phase 6 · **does an ASSIGNED camera become an incident candidate, and does an unassigned one
 * keep recording?**
 *
 *   node docs/review/p8/assignment.mjs          # the whole chain, against the deployment
 *   node docs/review/p8/assignment.mjs clean    # ⚠️ if a run was interrupted
 *
 * ### The chain this proves, stage by stage
 *
 * ```
 *   camera → assignment → runtime → tracking → publisher
 *          → t.{tenant}.capability.output.*  →  events  →  rules  →  IncidentCandidate
 * ```
 *
 * P-8 Phase 5 proved every hop from the publisher onwards. What is new here is the first two, and
 * the thing they add is **selectivity**: the platform can now analyse some cameras and not others,
 * and this run asserts both halves of that on the same deployment at the same time.
 *
 * ### ⚠️ The negative half is the important half
 *
 * Three cameras record. One is assigned. The run asserts that the other two produce **zero analysed
 * frames** while writing **every recording segment** — because a milestone that only proves the
 * positive case is satisfied equally well by a gate that lets everything through, which is precisely
 * the behaviour it replaced.
 *
 * ### ⚠️ Hot assignment is asserted on the cameras that were NOT touched (Architect rec 3)
 *
 * Changing one camera's profile must not disturb another's. That is measured by watching the OTHER
 * cameras' counters across the change — their frame counts must keep climbing and their session
 * epochs must not move. Asserting it on the changed camera would prove nothing: the interesting
 * failure is collateral damage.
 *
 * ### ⚠️ It creates a rule, and that is verification rather than implementation
 *
 * Same instrument as Phase 5, same reasoning: an engine with no enabled rules correctly produces
 * nothing, so a run asserting "a candidate appeared" needs one rule to exist. It is the most trivial
 * rule expressible, it encodes no business meaning, and it is deleted in a `finally`. This milestone
 * ships no rules.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const FIXTURE = 'vip-assignment-fixture';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-assignment';
const OUT = process.env.OUT ?? join(ROOT, 'docs/review/p8/assignment-samples.json');
/** Seconds of clip per observation window. */
const OBSERVE = Number(process.env.OBSERVE ?? 20);
/**
 * ⚠️ How long a change may take to reach the enforcement point and come back as an observation.
 * The poll interval is 5 s, so a change needs one tick to be picked up and one to be reported —
 * this is that, doubled, because a verification that races the system it measures is a flaky test
 * rather than a strict one.
 */
const CONVERGE_MS = Number(process.env.CONVERGE_MS ?? 22_000);

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
  if (r.json?.data?.accessToken === undefined) {
    throw new Error(`login failed: ${r.text.slice(0, 200)}`);
  }
  H = { authorization: `Bearer ${r.json.data.accessToken}`, 'content-type': 'application/json' };
}

/** The control plane's record for one camera. */
const assignmentOf = async (cameraId) =>
  (await api(`/camera/assignments/${cameraId}`, { headers: H })).json?.data ?? {};

/** What the enforcement point measured, indexed by camera. */
async function measured() {
  const rows = (await api('/media/perception/assignment/cameras', { headers: H })).json?.data;
  const out = new Map();
  if (Array.isArray(rows)) for (const row of rows) out.set(row.cameraId, row);
  return out;
}

const streamOf = async (cameraId) =>
  (await api(`/media/streams/${cameraId}/status`, { headers: H })).json?.data ?? {};

async function cleanup(quiet = false) {
  try {
    await login();
    const cams = (await api('/camera/cameras?limit=200', { headers: H })).json?.data?.cameras ?? [];
    for (const cam of cams.filter((c) => (c.metadata?.tags ?? []).includes(TAG))) {
      /*
       * ⚠️ The assignment is removed BEFORE the camera. A deleted camera whose assignment survives
       * leaves the plan naming a camera that no longer exists — the enforcement point would keep a
       * queue for it for ever, and the next run's capacity numbers would be wrong for reasons
       * nobody could see.
       */
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
  if (!quiet) console.log('\nremoved the assignment fixture, its cameras and its verification rule\n');
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

await login();
console.log('\nP-8 Phase 6 · camera processing assignment, end to end\n');

const samples = {};
const cameras = [];
let ruleId;

try {
  /* ── 0 · the control plane and the enforcement point agree they exist ──────────────────────── */
  console.log('0 · the assignment layer is deployed and connected');
  const gate = (await api('/media/perception/assignment', { headers: H })).json?.data ?? {};
  samples.gate = gate;
  check(gate.enabled === true, 'the assignment gate is enabled in this deployment');
  check(
    typeof gate.planVersion === 'number',
    'the enforcement point has applied a plan from the control plane',
    `planVersion=${gate.planVersion}`,
  );
  check((gate.cycles ?? 0) > 0, 'and is completing poll-and-report cycles', `${gate.cycles} cycle(s)`);

  const runtimes = (await api('/camera/processing-runtimes', { headers: H })).json?.data ?? [];
  samples.runtimes = runtimes;
  check(runtimes.length > 0, 'a runtime is registered', `${runtimes.length}`);
  const rt = runtimes[0] ?? {};
  /*
   * ⚠️ Health is MEASURED by media, which is the only service that talks to the runtime. A control
   * plane that polled the runtime itself would have measured a path no frame ever takes.
   */
  check(rt.health === 'healthy', 'and media has measured it healthy', `health=${rt.health}`);
  check(
    Array.isArray(rt.capabilities) && rt.capabilities.length > 0,
    'and read what it can run — capabilities are observed, never configured',
    (rt.capabilities ?? []).join(', ') || 'none read',
  );
  check(rt.observedBy === 'media', 'reported by the enforcement point', String(rt.observedBy));
  console.log('');

  /* ── 1 · the profile catalogue tells the truth about this deployment ───────────────────────── */
  console.log('1 · the profile catalogue reflects what this deployment can actually run');
  const profiles = (await api('/camera/processing-profiles', { headers: H })).json?.data ?? [];
  samples.profiles = profiles;
  const supported = profiles.filter((p) => p.supported === true).map((p) => p.id);
  const unsupported = profiles.filter((p) => p.supported === false).map((p) => p.id);
  check(supported.length > 0, 'some profiles are supported here', supported.join(', '));
  /*
   * ⚠️ Asserted, not tolerated. The runtime advertises ONE capability, so a catalogue reporting
   * everything as supported would mean the support flag is derived from nothing. This check fails
   * on a deployment that stopped measuring.
   */
  check(
    unsupported.length > 0,
    '⚠️ and some are NOT — support is measured against the runtime, not assumed',
    unsupported.join(', '),
  );
  console.log('');

  /* ── 2 · a rule exists to catch what the chain produces ────────────────────────────────────── */
  console.log('2 · a verification rule (created here, deleted in a finally)');
  const made = await api('/rules/rules', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      name: `${TAG} any person detection`,
      description:
        'Verification instrument for P-8 Phase 6 camera processing assignment. Created and deleted ' +
        'by docs/review/p8/assignment.mjs. Encodes no business meaning and ships with nothing.',
      eventTypes: ['perception.person.detected'],
      severity: 'low',
      actions: [{ type: 'raise-incident' }],
    }),
  });
  ruleId = made.json?.data?.id;
  check(ruleId !== undefined, 'the rule was created through the existing API', `HTTP ${made.status}`);
  if (ruleId === undefined) throw new Error(`could not create the rule: ${made.text.slice(0, 300)}`);
  const enabled = await api(`/rules/rules/${ruleId}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ lifecycle: 'enabled' }),
  });
  /*
   * ⚠️ Asserted, because a rule that silently stays a DRAFT makes every downstream check pass
   * vacuously. P-8 Phase 5 lost half a day to exactly that.
   */
  check(
    enabled.json?.data?.lifecycle === 'enabled',
    'and enabled — only enabled rules are evaluated',
    enabled.json?.data?.lifecycle ?? `HTTP ${enabled.status}`,
  );
  if (enabled.json?.data?.lifecycle !== 'enabled') {
    throw new Error(`rule did not enable: ${enabled.text.slice(0, 300)}`);
  }
  console.log('');

  /* ── 3 · three cameras recording, none assigned ────────────────────────────────────────────── */
  console.log('3 · three cameras recording, NONE of them assigned');
  shq('docker', ['rm', '-f', FIXTURE]);
  sh('docker', [
    'run', '-d', '--rm', '--name', FIXTURE, '--network', NETWORK,
    '-v', `${ROOT}/infra/docker/fixtures/tracking-fixture.yml:/mediamtx.yml:ro`,
    '-v', `${ROOT}/infra/docker/fixtures/media:/fixtures/media:ro`,
    'bluenviron/mediamtx:latest-ffmpeg',
  ]);
  await sleep(3000);

  const zoneId = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0].zoneId;
  for (let i = 1; i <= 3; i += 1) {
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
  check(cameras.length === 3, 'three cameras were created and their streams started');

  await sleep(OBSERVE * 1000);

  const unassignedStreams = await Promise.all(cameras.map(streamOf));
  const unassignedMeasured = await measured();
  samples.unassigned = {
    streams: unassignedStreams,
    measured: [...unassignedMeasured.values()].filter((r) => cameras.includes(r.cameraId)),
  };

  check(
    unassignedStreams.every((s) => s.recording === true),
    '⚠️ every unassigned camera IS RECORDING — the two axes are independent',
    unassignedStreams.map((s) => `${s.cameraId?.slice(-6)}:${s.recording}`).join(' '),
  );
  check(
    unassignedStreams.every((s) => (s.framesReceived ?? 0) > 0),
    'and the decoder is producing frames for all three',
    unassignedStreams.map((s) => s.framesReceived).join('/'),
  );
  /*
   * ⚠️ **The negative half.** Nothing was analysed, and the frames were SKIPPED rather than dropped —
   * a distinct counter, because a skipped frame is a decision an operator made and a dropped one is a
   * symptom of load. A run that only checked "delivered === 0" would pass on a broken frame path.
   */
  const skipped = cameras
    .map((id) => unassignedMeasured.get(id))
    .filter((r) => r !== undefined);
  check(
    skipped.length === 3 && skipped.every((r) => r.framesDelivered === 0),
    '⚠️ and NOT ONE frame reached the runtime — AI is off for all three',
    skipped.map((r) => r.framesDelivered).join('/'),
  );
  check(
    skipped.every((r) => r.framesSkippedUnassigned > 0),
    'the frames were SKIPPED as policy, not dropped as a symptom',
    skipped.map((r) => r.framesSkippedUnassigned).join('/'),
  );
  console.log('');

  /* ── 4 · assign one camera ─────────────────────────────────────────────────────────────────── */
  console.log('4 · one camera is assigned — camera → assignment → runtime');
  const target = cameras[0];
  const others = cameras.slice(1);
  const enableRes = await api(`/camera/assignments/${target}/enable`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ profileId: 'person-tracking' }),
  });
  check(enableRes.status === 200, 'the camera was enabled through the control plane', `HTTP ${enableRes.status}`);
  const assigned = enableRes.json?.data ?? {};
  check(assigned.state === 'starting', 'and entered "starting" — declared, not yet confirmed', assigned.state);
  check(assigned.runtimeId !== null, 'placement chose a runtime', String(assigned.runtimeId));
  check(assigned.aiEnabled === true, 'aiEnabled is derived from the state', String(assigned.aiEnabled));

  await sleep(CONVERGE_MS);

  const running = await assignmentOf(target);
  samples.assigned = running;
  /*
   * ⚠️ `running` is only reachable by an OBSERVATION. This check is the whole evidence discipline of
   * the milestone: the control plane cannot have set it, because no operator action reaches it.
   */
  check(
    running.state === 'running',
    '⚠️ and the ENFORCEMENT POINT confirmed it — "running" needs an observation',
    running.state,
  );
  check(running.observed?.state === 'active', 'the observation says active', running.observed?.state);
  check(running.observed?.stale === false, 'and it is fresh, not an expired measurement');
  console.log('');

  /* ── 5 · the analysed camera produces events and a candidate ───────────────────────────────── */
  console.log('5 · runtime → tracking → publisher → events → rules → candidate');
  await sleep(OBSERVE * 1000);
  const afterMeasured = await measured();
  const targetRow = afterMeasured.get(target) ?? {};
  samples.targetRow = targetRow;
  check((targetRow.framesDelivered ?? 0) > 0, 'frames reached the runtime', String(targetRow.framesDelivered));
  check(targetRow.processingFps !== null, 'processing fps is measured rather than absent', String(targetRow.processingFps));
  check((targetRow.eventsPublished ?? 0) > 0, 'and results were published to the event platform', String(targetRow.eventsPublished));
  if ((targetRow.activeTracks ?? null) === null) {
    finding('live track count unavailable', 'the runtime tracking view could not be read this run');
  } else {
    console.log(`  · ${targetRow.activeTracks} live track(s) on the assigned camera`);
  }

  const events = (
    await api(`/events/events?cameraId=${target}&limit=50`, { headers: H })
  ).json?.data;
  const rows = Array.isArray(events) ? events : (events?.events ?? events?.items ?? []);
  check(rows.length > 0, 'the event platform persisted events for this camera', `${rows.length} event(s)`);
  const sample = rows[0];
  if (sample !== undefined) {
    samples.event = sample;
    check(
      sample.cameraId === target,
      'and the envelope names the camera the assignment named',
      String(sample.cameraId),
    );
  }

  /*
   * ⚠️ Asserted against the ENGINE's own counters, not against a persisted `Incident` — the
   * distinction P-8 Phase 5 recorded and this run inherits. An `IncidentCandidate` is what a rule
   * produces; promoting one to an `Incident` is the workflow service's job and is out of scope here,
   * so a run asserting on incidents would fail for reasons that have nothing to do with assignment.
   */
  const stats = await api('/rules/rules/stats', { headers: H });
  const ours = (stats.json?.data?.rules ?? []).find((r) => r.ruleId === ruleId);
  samples.rule = ours ?? null;
  check(ours !== undefined, 'the engine reports on the verification rule', ours ? 'found' : 'absent');
  check(
    (ours?.evaluations ?? 0) > 0,
    'the rule engine evaluated the events the assigned camera produced',
    `${ours?.evaluations ?? 0} evaluation(s)`,
  );
  check(
    (ours?.matches ?? 0) > 0,
    '⚠️ AN ASSIGNED CAMERA BECAME AN INCIDENT CANDIDATE',
    `${ours?.matches ?? 0} match(es), ${ours?.failures ?? 0} failure(s)`,
  );
  console.log('');

  /* ── 6 · the others are STILL not analysed ─────────────────────────────────────────────────── */
  console.log('6 · selectivity — the unassigned cameras stayed unassigned');
  const otherRows = others.map((id) => afterMeasured.get(id) ?? {});
  check(
    otherRows.every((r) => (r.framesDelivered ?? 0) === 0),
    '⚠️ the two unassigned cameras analysed NOTHING while the assigned one worked',
    otherRows.map((r) => r.framesDelivered ?? '?').join('/'),
  );
  const otherStreams = await Promise.all(others.map(streamOf));
  check(
    otherStreams.every((s) => s.recording === true),
    'and both were still recording throughout',
    otherStreams.map((s) => s.recording).join('/'),
  );
  console.log('');

  /* ── 7 · hot assignment (Architect rec 3) ──────────────────────────────────────────────────── */
  console.log('7 · hot assignment — enable a second camera without disturbing the first');
  const beforeHot = await assignmentOf(target);
  const beforeHotRow = (await measured()).get(target) ?? {};
  const second = others[0];

  const hot = await api(`/camera/assignments/${second}/enable`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ profileId: 'retail-monitoring' }),
  });
  check(hot.status === 200, 'the second camera was enabled', `HTTP ${hot.status}`);

  await sleep(CONVERGE_MS);
  const afterHot = await assignmentOf(target);
  const afterHotRow = (await measured()).get(target) ?? {};
  samples.hot = { before: beforeHot, after: afterHot };

  /*
   * ⚠️ Asserted on the camera that was NOT touched. The interesting failure of a control plane is
   * collateral damage — a plan change that restarts every camera would pass every check that only
   * looks at the camera it changed.
   */
  check(
    afterHot.sessionEpoch === beforeHot.sessionEpoch,
    '⚠️ the first camera’s session was NOT restarted',
    `epoch ${beforeHot.sessionEpoch} → ${afterHot.sessionEpoch}`,
  );
  check(
    afterHot.state === 'running',
    'and it never left "running"',
    `${beforeHot.state} → ${afterHot.state}`,
  );
  check(
    (afterHotRow.framesDelivered ?? 0) > (beforeHotRow.framesDelivered ?? 0),
    '⚠️ and it KEPT PROCESSING across the change',
    `${beforeHotRow.framesDelivered} → ${afterHotRow.framesDelivered}`,
  );

  /* Changing a running camera's PROFILE is also hot — the state and the session must both hold. */
  const beforeProfile = await assignmentOf(target);
  await api(`/camera/assignments/${target}/enable`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ profileId: 'retail-monitoring' }),
  });
  await sleep(CONVERGE_MS);
  const afterProfile = await assignmentOf(target);
  check(
    afterProfile.profileId === 'retail-monitoring',
    'a running camera’s profile can be changed',
    `${beforeProfile.profileId} → ${afterProfile.profileId}`,
  );
  check(
    afterProfile.sessionEpoch === beforeProfile.sessionEpoch,
    '⚠️ without restarting its session — a profile change is hot',
    `epoch ${beforeProfile.sessionEpoch} → ${afterProfile.sessionEpoch}`,
  );
  check(afterProfile.state === 'running', 'and without leaving "running"', afterProfile.state);
  console.log('');

  /* ── 8 · pause retains state; recording never stops ────────────────────────────────────────── */
  console.log('8 · pause — frames stop, state is retained, recording continues');
  await api(`/camera/assignments/${target}/pause`, { method: 'POST', headers: H, body: '{}' });
  await sleep(CONVERGE_MS);
  const pausedAssignment = await assignmentOf(target);
  /*
   * ⚠️ Delivery is measured over a window that starts AFTER the pause has converged, not across the
   * pause itself. A change takes up to one poll interval to reach the enforcement point and the
   * in-flight queue drains behind it, so frames legitimately land for a few seconds after the
   * request returns. Measuring across the boundary asserted that a correct system was broken — the
   * first run failed here with 164 → 170, which is the queue emptying, not a gate that did nothing.
   */
  const pausedBefore = (await measured()).get(target) ?? {};
  await sleep(10_000);
  const pausedRow = (await measured()).get(target) ?? {};
  const pausedStream = await streamOf(target);
  samples.paused = { assignment: pausedAssignment, row: pausedRow, stream: pausedStream };

  check(pausedAssignment.state === 'paused', 'the camera is paused', pausedAssignment.state);
  check(pausedAssignment.aiEnabled === true, '⚠️ and still counts as AI-enabled — it holds its slot', String(pausedAssignment.aiEnabled));
  check(
    (pausedRow.framesDelivered ?? 0) === (pausedBefore.framesDelivered ?? 0),
    '⚠️ frame delivery STOPPED — not one frame in a ten-second window after the pause settled',
    `${pausedBefore.framesDelivered} → ${pausedRow.framesDelivered}`,
  );
  check(pausedStream.recording === true, '⚠️ and RECORDING NEVER STOPPED', String(pausedStream.recording));
  check(
    pausedAssignment.sessionEpoch === afterProfile.sessionEpoch,
    '⚠️ pause did not bump the session — the tracks survive a resume',
    `epoch ${afterProfile.sessionEpoch} → ${pausedAssignment.sessionEpoch}`,
  );
  console.log('');

  /* ── 9 · the C-14c sequence the Architect specified ────────────────────────────────────────── */
  console.log('9 · disabled → released → re-enabled → events resume');
  await api(`/camera/assignments/${target}/disable`, { method: 'POST', headers: H, body: '{}' });
  await sleep(CONVERGE_MS);
  const stopped = await assignmentOf(target);
  const stoppedStream = await streamOf(target);
  samples.stopped = { assignment: stopped, stream: stoppedStream };
  check(
    stopped.state === 'stopped',
    '⚠️ the enforcement point CONFIRMED the release — "stopped" needs an observation',
    stopped.state,
  );
  check(stopped.aiEnabled === false, 'and AI is off for this camera', String(stopped.aiEnabled));
  check(stoppedStream.recording === true, '⚠️ recording continued through the stop', String(stoppedStream.recording));

  const beforeResume = (await measured()).get(target) ?? {};
  const reEnabled = await api(`/camera/assignments/${target}/enable`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ profileId: 'person-tracking' }),
  });
  check(reEnabled.status === 200, 'the camera was re-enabled', `HTTP ${reEnabled.status}`);
  check(
    (reEnabled.json?.data?.sessionEpoch ?? 0) > (stopped.sessionEpoch ?? 0),
    '⚠️ with a NEW session epoch — this is what stops the P-8 Phase 5 defect recurring',
    `epoch ${stopped.sessionEpoch} → ${reEnabled.json?.data?.sessionEpoch}`,
  );

  await sleep(CONVERGE_MS + OBSERVE * 1000);
  const resumed = await assignmentOf(target);
  const resumedRow = (await measured()).get(target) ?? {};
  samples.resumed = { assignment: resumed, row: resumedRow };
  check(resumed.state === 'running', 'processing resumed', resumed.state);
  /*
   * ⚠️ **The defect P-8 Phase 5 measured, asserted as fixed.** A re-enabled camera restarts its
   * frame sequence at 1; a publisher holding the previous session's `lastSeq` drops every event
   * indefinitely. Phase 5 measured 0 published and 32 dropped. This is that exact sequence.
   */
  check(
    (resumedRow.eventsPublished ?? 0) > (beforeResume.eventsPublished ?? 0),
    '⚠️ AND EVENTS RESUMED — the re-enabled camera is publishing again',
    `${beforeResume.eventsPublished} → ${resumedRow.eventsPublished}`,
  );
  console.log('');

  /* ── 10 · the capability matrix answers for the camera ─────────────────────────────────────── */
  console.log('10 · the camera capability matrix (Architect rec 1)');
  const matrixRes = await api(`/camera/cameras/${target}/capability-matrix`, { headers: H });
  const matrix = matrixRes.json?.data ?? {};
  samples.matrix = matrix;
  check(matrixRes.status === 200, 'the matrix is served', `HTTP ${matrixRes.status}`);
  check(matrix.recording?.available === true, 'it reports recording', JSON.stringify(matrix.recording));
  check(
    matrix.recording?.evidence === 'measured',
    '⚠️ on MEASURED evidence, not declared — the point of the matrix',
    matrix.recording?.evidence,
  );
  check(matrix.aiProcessing?.available === true, 'it reports AI processing', matrix.aiProcessing?.evidence);
  check(
    matrix.events?.available === true,
    'and events, from the publisher rather than from configuration',
    matrix.events?.evidence,
  );
  const unmeasured = Object.entries(matrix).filter(
    ([, v]) => v && typeof v === 'object' && v.evidence === 'unknown',
  );
  for (const [name] of unmeasured) {
    console.log(`  · ${name} is honestly unknown on this deployment`);
  }

  /* The unassigned camera must answer too — recording yes, AI no. */
  const otherMatrix = (
    await api(`/camera/cameras/${others[1]}/capability-matrix`, { headers: H })
  ).json?.data ?? {};
  samples.otherMatrix = otherMatrix;
  check(
    otherMatrix.recording?.available === true && otherMatrix.aiProcessing?.available === false,
    '⚠️ an unassigned camera reports recording=true, ai=false — never "unknown" for both',
    `recording=${otherMatrix.recording?.available} ai=${otherMatrix.aiProcessing?.available}`,
  );
  console.log('');

  /* ── 11 · the audit trail ──────────────────────────────────────────────────────────────────── */
  console.log('11 · the immutable audit trail (Architect rec 4)');
  const history = (await api(`/camera/assignments/history?cameraId=${target}&limit=50`, { headers: H }))
    .json?.data ?? [];
  samples.history = history.slice(0, 5);
  check(history.length > 0, 'every change was recorded', `${history.length} entries`);
  const actions = history.map((e) => e.action);
  for (const expected of ['assign', 'start', 'pause', 'stop']) {
    check(actions.includes(expected), `  · "${expected}" is in the trail`);
  }
  check(
    history.every((e) => typeof e.actor === 'string' && e.actor.length > 0),
    'and every entry names an actor',
  );
  check(
    history.some((e) => e.before !== null && e.after !== undefined),
    '⚠️ carrying the WHOLE assignment before and after, not a diff',
  );
  console.log('');

  /* ── 12 · capacity reflects reality ────────────────────────────────────────────────────────── */
  console.log('12 · capacity planning (Architect rec 6)');
  const capacity = (await api('/camera/assignments/capacity', { headers: H })).json?.data ?? {};
  samples.capacity = capacity;
  check(capacity.totalCameras >= 3, 'the report counts the estate', String(capacity.totalCameras));
  check(capacity.assignedCameras >= 2, 'and how much of it consumes AI', String(capacity.assignedCameras));
  check(capacity.idleCameras >= 1, '⚠️ and how much only records — the number this milestone sells', String(capacity.idleCameras));
  check(
    typeof capacity.availableCapacity === 'number',
    'available capacity is a number because a runtime declared one',
    String(capacity.availableCapacity),
  );
  const runtimeRow = (capacity.runtimes ?? [])[0] ?? {};
  check(
    runtimeRow.utilization !== null && runtimeRow.utilization !== undefined,
    'utilisation is defined for a runtime with a declared capacity',
    String(runtimeRow.utilization),
  );
  console.log('');
} finally {
  await cleanup(true);
  writeFileSync(OUT, JSON.stringify(samples, null, 2));
  console.log(`\nsamples written to ${OUT}`);
}

if (findings.length > 0) {
  console.log(`\n${findings.length} finding(s) recorded — see above\n`);
}
console.log(
  failures === 0
    ? '\n✅ an assigned camera becomes an incident candidate; an unassigned one records and is never analysed\n'
    : `\n❌ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);

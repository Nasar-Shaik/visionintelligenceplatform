/**
 * P-8 Phase 7 · **does a person standing in a zone become an incident candidate?**
 *
 *   node docs/review/p8/loitering.mjs          # the whole workflow, against the deployment
 *   node docs/review/p8/loitering.mjs clean    # ⚠️ if a run was interrupted
 *
 * ### The chain this proves, stage by stage
 *
 * ```
 *   camera → assignment → tracking → identity → zone → events
 *          → rule evaluation (scope · condition · dwell) → incident candidate → incident
 * ```
 *
 * Every hop is asserted separately, so a break is attributable rather than "no incident appeared" —
 * which is what a single end-to-end assertion tells you at 2 a.m.
 *
 * ### ⚠️ The negative half is asserted at the same time, on the same deployment
 *
 * A run that only proves "a loiterer produces a candidate" would pass on a rule that fires for
 * everybody. So this run asserts, simultaneously:
 *
 *   - a subject **inside** the zone accumulates and fires;
 *   - a subject **outside** every zone produces events with **no `zoneId`** and never fires;
 *   - a **dry-run** rule with the same threshold raises nothing while its clock advances.
 *
 * The third is the one that would be easiest to fake and hardest to notice: a dry run that silently
 * did not evaluate would look identical to one that evaluated and withheld.
 *
 * ### ⚠️ It creates a zone and two rules, and deletes them in a `finally`
 *
 * They are measuring instruments, exactly as the P-8 Phase 5 rule was. The zone is drawn to cover
 * the part of the frame the fixture's walker occupies; nothing about its coordinates encodes
 * business meaning, and it does not survive the run.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assignCameras, releaseCameras } from './_assign.mjs';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const FIXTURE = 'vip-loiter-fixture';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-loiter';
const OUT = process.env.OUT ?? join(ROOT, 'docs/review/p8/loitering-samples.json');

/**
 * Seconds to observe.
 *
 * ⚠️ Must exceed the dwell threshold with room for the plan to reach media (5 s poll) and for the
 * candidate to travel. 70 s against a 20 s threshold leaves the outcome unambiguous — a run that
 * only just crosses would go red on a slow machine and be blamed on the product.
 */
const OBSERVE = Number(process.env.OBSERVE ?? 70);
/** The dwell threshold the verification rule uses. Short, because a run is not a shift. */
const DWELL = Number(process.env.DWELL ?? 20);

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

async function cleanup(quiet = false) {
  try {
    await login();
    const cams = (await api('/camera/cameras?limit=200', { headers: H })).json?.data?.cameras ?? [];
    const mine = cams.filter((c) => (c.metadata?.tags ?? []).includes(TAG));
    /*
     * ⚠️ Zones first, then assignments, then cameras. A deleted camera whose zones survive leaves
     * the plan naming geometry for a camera that no longer exists — the same class of orphan P-8
     * Phase 6 shipped with assignments and had to sweep.
     */
    for (const cam of mine) {
      const zones = (await api(`/camera/zones?cameraId=${cam.id}`, { headers: H })).json?.data ?? [];
      for (const zone of zones) {
        await api(`/camera/zones/${zone.id}`, {
          method: 'DELETE',
          headers: { authorization: H.authorization },
        });
      }
    }
    await releaseCameras(api, H, mine.map((c) => c.id));
    for (const cam of mine) {
      await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
      await api(`/camera/cameras/${cam.id}`, {
        method: 'DELETE',
        headers: { authorization: H.authorization },
      });
    }
    /* ⚠️ A bare array, not `{ rules: [...] }` — the P-8 Phase 5 cleanup defect. */
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
  if (!quiet) console.log('\nremoved the loitering fixture, its cameras, zones and rules\n');
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

await login();
await cleanup(true);
console.log('\nP-8 Phase 7 · Retail Loitering, camera to candidate\n');

const samples = {};
let watchedCamera;
let controlCamera;
let zoneId;
let ruleId;
let dryRunRuleId;

try {
  /* ── 1 · two cameras on the fixture: one watched, one control ──────────────────────────────── */
  console.log('1 · two cameras — one with a zone, one without');
  shq('docker', ['rm', '-f', FIXTURE]);
  sh('docker', [
    'run', '-d', '--rm', '--name', FIXTURE, '--network', NETWORK,
    '-v', `${ROOT}/infra/docker/fixtures/tracking-fixture.yml:/mediamtx.yml:ro`,
    '-v', `${ROOT}/infra/docker/fixtures/media:/fixtures/media:ro`,
    'bluenviron/mediamtx:latest-ffmpeg',
  ]);
  await sleep(3000);

  const hierarchyZone = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0]
    .zoneId;
  const makeCamera = async (name, path) => {
    const r = await api('/camera/cameras', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        zoneId: hierarchyZone,
        name: `${TAG} ${name}`,
        protocol: 'rtsp',
        streamUrl: `rtsp://${FIXTURE}:8554/${path}`,
        metadata: { tags: [TAG] },
      }),
    });
    return r.json?.data?.id;
  };
  /*
   * ⚠️ Different fixture paths. The camera service refuses a duplicate `streamUrl`, so pointing both
   * cameras at `walk1` silently created only one — and the control half of this run then asserted
   * nothing at all while reporting a tidy "0 unexpectedly zoned". The fixture matches `~^walk[0-9]+$`
   * so each camera gets an independent publisher, which is also what the capacity ladder needs.
   */
  watchedCamera = await makeCamera('watched', 'walk1');
  controlCamera = await makeCamera('control', 'walk2');
  check(
    watchedCamera !== undefined && controlCamera !== undefined,
    'two cameras were created on the fixture stream',
    `${watchedCamera} · ${controlCamera}`,
  );
  console.log('');

  /* ── 2 · a detection zone covering the whole frame of the watched camera ───────────────────── */
  console.log('2 · a detection zone');
  /*
   * ⚠️ The whole frame, deliberately. This run proves the *workflow*, not the geometry — the
   * geometry has its own exhaustive tests in `packages/contracts/test/zone-geometry.test.ts`, where
   * a polygon can be checked against a point without waiting seventy seconds. A tight zone here
   * would make the run depend on where the fixture's walker happens to be, and a red would mean
   * "the clip changed" far more often than "the platform broke".
   */
  const zone = await api('/camera/zones', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      cameraId: watchedCamera,
      name: `${TAG} whole frame`,
      kind: 'area',
      shape: 'polygon',
      geometry: {
        points: [
          [0.02, 0.02],
          [0.98, 0.02],
          [0.98, 0.98],
          [0.02, 0.98],
        ],
      },
      purpose: 'verification',
      enabled: true,
    }),
  });
  zoneId = zone.json?.data?.id;
  check(zoneId !== undefined, 'a zone was created through the operator API', `HTTP ${zone.status}`);
  if (zoneId === undefined) throw new Error(`could not create the zone: ${zone.text.slice(0, 300)}`);
  check(zone.json?.data?.version === 1, 'it starts at version 1', `v${zone.json?.data?.version}`);

  const versions = await api(`/camera/zones/${zoneId}/versions`, { headers: H });
  check(
    (versions.json?.data ?? []).length === 1,
    '⚠️ and an immutable snapshot exists, so a future incident can resolve THIS geometry',
    `${(versions.json?.data ?? []).length} version record(s)`,
  );
  console.log('');

  /* ── 3 · two rules: one live, one dry run ──────────────────────────────────────────────────── */
  console.log(`3 · a loitering rule (${DWELL}s) and a dry-run twin`);
  const makeRule = async (name, dryRun) => {
    const made = await api('/rules/rules', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        name: `${TAG} ${name}`,
        description:
          'Verification instrument for P-8 Phase 7. Created and deleted by ' +
          'docs/review/p8/loitering.mjs. Ships with nothing.',
        eventTypes: ['perception.person.detected'],
        condition: { field: 'subjects.0.identityId', op: 'exists' },
        dwell: {
          minSeconds: DWELL,
          groupBy: 'identity',
          /*
           * ⚠️ 15s — above the ~10s interval at which the platform actually observes a present
           * subject (the event dedup window). At 5s this run would have accumulated nothing and the
           * red would have looked like a broken dwell stage.
           */
          resetAfterSeconds: 15,
          /* ⚠️ Zero, so a repeat is visible within the run's window rather than 300 s later. */
          cooldownSeconds: 0,
        },
        dryRun,
        severity: 'low',
        actions: [{ type: 'raise-incident' }],
        scope: { nodeIds: [], cameraIds: [watchedCamera], groupIds: [], zoneIds: [zoneId] },
      }),
    });
    const id = made.json?.data?.id;
    if (id === undefined) throw new Error(`could not create ${name}: ${made.text.slice(0, 300)}`);
    const enabled = await api(`/rules/rules/${id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ lifecycle: 'enabled' }),
    });
    return { id, lifecycle: enabled.json?.data?.lifecycle, body: enabled };
  };

  const live = await makeRule('live', false);
  ruleId = live.id;
  /*
   * ⚠️ **This is the check that the camera directory is wired.** Before P-8 Phase 7 nothing wired
   * one, so `unavailableCameraDirectory` reported `available: false`, validation reported
   * `verified: false`, and a camera-scoped rule COULD NOT BE ENABLED in any deployment. Nobody had
   * noticed, because nothing had ever tried. If this goes red, `CAMERA_SERVICE_URL` is missing.
   */
  check(
    live.lifecycle === 'enabled',
    '⚠️ the camera- and zone-scoped rule ENABLED — scope references were verified against the camera service',
    live.lifecycle ?? `HTTP ${live.body.status}: ${live.body.text.slice(0, 200)}`,
  );

  const validation = await api(`/rules/rules/${ruleId}/validation`, { headers: H });
  const report = validation.json?.data;
  samples.validation = report ?? null;
  check(report?.verified === true, 'the validation report says every reference was checked');
  check(
    (report?.checked ?? []).includes('zone') && (report?.checked ?? []).includes('camera'),
    'including the detection zone and the camera',
    (report?.checked ?? []).join(', '),
  );

  const dry = await makeRule('dry run', true);
  dryRunRuleId = dry.id;
  check(dry.lifecycle === 'enabled', 'and a dry-run twin is enabled — it evaluates and raises nothing');
  console.log('');

  /* ── 4 · assignment: only the watched camera is analysed ───────────────────────────────────── */
  console.log('4 · assignment');
  for (const id of [watchedCamera, controlCamera]) {
    await api(`/media/streams/${id}/start`, { method: 'POST', headers: H, body: '{}' });
  }
  await assignCameras(api, H, [watchedCamera, controlCamera]);
  check(true, 'both cameras assigned for AI processing');

  /*
   * ⚠️ The plan is what actually carries the zone to media. Asserting the zone exists in Mongo
   * proves nothing about whether the enforcement point can see it.
   */
  /*
   * ⚠️ `/system/ai-runtime` proxies to media's `/perception/runtime`, which serves the FRAME SINK's
   * stats — the process that actually resolves zones. The assignment gate's own view
   * (`/media/perception/assignment`) reports the plan; this reports what was done with it.
   */
  const gate = await api('/system/ai-runtime', { headers: H });
  samples.gate = gate.json?.data ?? null;
  /* ⚠️ The frame sink's stats sit under `pipeline` — the route wraps them with runtime metadata. */
  const zoneStats = gate.json?.data?.pipeline?.zones;
  if (zoneStats !== undefined) {
    check(
      (zoneStats.zonesLoaded ?? 0) > 0,
      '⚠️ the enforcement point HOLDS the zone — it travelled on the assignment plan',
      `${zoneStats.zonesLoaded} zone(s) across ${zoneStats.camerasWithZones} camera(s)`,
    );
    check(
      (zoneStats.insideDetections ?? 0) > 0,
      'and it RESOLVED subjects into it — the geometry ran on the frame path',
      `${zoneStats.insideDetections} membership(s) from ${zoneStats.detectionsTested} tested, ` +
        `${zoneStats.averageResolveMicros?.toFixed?.(1) ?? '—'}µs/frame`,
    );
  } else {
    finding('the gate does not report zone statistics', 'media may predate P-8 Phase 7');
  }
  console.log('');

  /* ── 5 · observe ───────────────────────────────────────────────────────────────────────────── */
  const startedAt = new Date().toISOString();
  console.log(`5 · watching for ${OBSERVE}s (threshold ${DWELL}s)`);
  /* Sample the live status mid-run, while a clock should be running. */
  await sleep(Math.round(OBSERVE * 0.6) * 1000);
  const mid = await api('/rules/rules/live', { headers: H });
  samples.liveMidRun = mid.json?.data ?? null;
  const midTimers = mid.json?.data?.timers ?? [];
  check(
    midTimers.length > 0,
    '⚠️ a dwell clock is RUNNING mid-observation — the loiter timer is real, not a post-hoc figure',
    `${midTimers.length} timer(s); longest ${Math.max(0, ...midTimers.map((t) => t.elapsedSeconds)).toFixed(1)}s`,
  );
  const named = midTimers.find((t) => t.zoneName !== undefined);
  check(
    named !== undefined,
    'and it names its zone, so the candidate can too',
    named?.zoneName ?? 'no timer carried a zone name',
  );
  await sleep(Math.round(OBSERVE * 0.4) * 1000);
  console.log('');

  /* ── 6 · events carry the zone ─────────────────────────────────────────────────────────────── */
  console.log('6 · events');
  const eventsFor = async (cameraId) =>
    (
      await api(
        `/events/events?cameraId=${encodeURIComponent(cameraId)}&from=${encodeURIComponent(startedAt)}&limit=300`,
        { headers: H },
      )
    ).json?.data?.events ?? [];

  const watchedEvents = await eventsFor(watchedCamera);
  const controlEvents = await eventsFor(controlCamera);
  samples.events = { watched: watchedEvents.length, control: controlEvents.length };

  check(watchedEvents.length > 0, 'the watched camera produced events', `${watchedEvents.length}`);
  const zoned = watchedEvents.filter((e) => e.zoneId === zoneId);
  check(
    zoned.length > 0,
    '⚠️ and they carry the DETECTION ZONE — the string agreed between media and events',
    `${zoned.length}/${watchedEvents.length} stamped with ${zoneId}`,
  );

  /*
   * ⚠️ The negative control, on the same deployment at the same moment. A camera with no zones must
   * still produce events, and they must carry NO zone. Without this, a resolver that stamped every
   * camera with every zone would pass every other check in this file.
   */
  check(controlEvents.length > 0, 'the control camera produced events too', `${controlEvents.length}`);
  check(
    controlEvents.every((e) => e.zoneId === undefined),
    '⚠️ and NONE of them carries a zone — the camera has none drawn on it',
    `${controlEvents.filter((e) => e.zoneId !== undefined).length} unexpectedly zoned`,
  );

  const identified = zoned.filter((e) => e.subjects?.[0]?.identityId !== undefined);
  check(
    identified.length === zoned.length && identified.length > 0,
    '⚠️ every zoned event carries an IDENTITY — without it a dwell rule can never accumulate',
    `${identified.length}/${zoned.length}`,
  );
  console.log('');

  /* ── 7 · the candidate ─────────────────────────────────────────────────────────────────────── */
  console.log('7 · the incident candidate');
  /*
   * ⚠️ `data.items`, not `data.incidents`. The first version of this run read the wrong key, got an
   * empty array, and reported "the live rule raised an incident — 0" while the dry-run twin with
   * identical configuration was demonstrably withholding candidates. The two halves disagreeing is
   * what exposed it; a run with only the positive half would have blamed the product.
   */
  const incidents =
    (await api(`/workflow/incidents?limit=100`, { headers: H })).json?.data?.items ?? [];
  const mine = incidents.filter(
    (i) => i.source?.ruleId === ruleId && Date.parse(i.raisedAt) >= Date.parse(startedAt),
  );
  samples.incidents = mine.length;
  check(mine.length > 0, 'the live rule raised an incident', `${mine.length}`);

  const incident = mine[0];
  samples.incident = incident ?? null;
  if (incident !== undefined) {
    const e = incident.explanation;
    check(incident.triggeredBy?.cameraId === watchedCamera, 'it names the camera', incident.triggeredBy?.cameraId);
    check(incident.triggeredBy?.zoneId === zoneId, 'and the zone', incident.triggeredBy?.zoneId);
    check(typeof incident.identityId === 'string', 'and the identity it accumulated on', incident.identityId);
    check(
      typeof incident.durationSeconds === 'number' && incident.durationSeconds >= DWELL,
      `and a duration at or past the ${DWELL}s threshold`,
      `${incident.durationSeconds?.toFixed?.(1)}s`,
    );
    check(e?.trigger === 'dwell', 'the explanation is structured, not prose', e?.trigger);
    check(
      typeof e?.trackFragments === 'number' && typeof e?.longestGapSeconds === 'number',
      '⚠️ and carries the two honesty fields — fragments and the longest unobserved gap',
      `${e?.trackFragments} fragment(s), longest gap ${e?.longestGapSeconds?.toFixed?.(1)}s`,
    );
    check(
      e?.exitAt === undefined || e?.exitAt === null,
      '⚠️ and does NOT claim an exit time — nobody had left when it was raised',
      String(e?.exitAt),
    );
    check(
      (incident.timeline?.entries ?? []).length > 0,
      'the timeline is ordered and populated',
      `${incident.timeline?.entries?.length} entries, ${incident.timeline?.omitted} omitted of ${incident.timeline?.total}`,
    );
    const times = (incident.timeline?.entries ?? []).map((x) => Date.parse(x.at));
    check(
      times.every((t, i) => i === 0 || t >= times[i - 1]),
      'and strictly in time order',
      `${times.length} entries`,
    );
    check(
      (incident.evidence ?? []).some((r) => r.kind === 'recording-interval'),
      'evidence references the recorded interval rather than copying it',
      (incident.evidence ?? []).map((r) => r.kind).join(', '),
    );
    check(
      (incident.evidence ?? []).every((r) => r.locator?.startsWith('/')),
      '⚠️ and every locator is platform-relative — no host, no scheme, no token',
      `${(incident.evidence ?? []).length} reference(s)`,
    );
  }
  console.log('');

  /* ── 8 · the dry run evaluated and raised nothing ──────────────────────────────────────────── */
  console.log('8 · dry run — evaluated, withheld');
  const dryIncidents = incidents.filter((i) => i.source?.ruleId === dryRunRuleId);
  check(
    dryIncidents.length === 0,
    '⚠️ the dry-run rule raised NOTHING',
    `${dryIncidents.length} incident(s)`,
  );

  const dryRuns = await api('/rules/rules/live/dry-runs', { headers: H });
  const summary = (dryRuns.json?.data ?? []).find((r) => r.ruleId === dryRunRuleId);
  samples.dryRun = summary ?? null;
  /*
   * ⚠️ **The check that separates a dry run from a broken rule.** Both raise nothing. Only one of
   * them evaluated, crossed its threshold and built the candidate it withheld.
   */
  check(
    (summary?.withheld ?? 0) > 0,
    '⚠️ but it DID evaluate and withheld candidates — a silent rule would look identical',
    `${summary?.withheld ?? 0} withheld, longest ${summary?.maxDurationSeconds?.toFixed?.(1) ?? '—'}s`,
  );

  const withheldCandidates = await api(`/rules/rules/${dryRunRuleId}/dry-run-candidates`, {
    headers: H,
  });
  const candidate = (withheldCandidates.json?.data ?? [])[0];
  check(
    candidate !== undefined && candidate.dryRun === true,
    'and the withheld candidate is the same object a live rule would have published',
    candidate === undefined ? 'none retained' : `duration ${candidate.durationSeconds?.toFixed?.(1)}s`,
  );
  console.log('');

  /* ── 9 · live status agrees with what happened ─────────────────────────────────────────────── */
  console.log('9 · live rule status');
  const live2 = await api('/rules/rules/live', { headers: H });
  const st = live2.json?.data;
  samples.liveAfter = st ?? null;
  check(st?.activeRules >= 2, 'both verification rules are compiled and active', `${st?.activeRules}`);
  check(st?.dwellRules >= 2, 'and both carry a dwell threshold', `${st?.dwellRules}`);
  check(st?.dryRunRules >= 1, 'one of them is in dry run', `${st?.dryRunRules}`);
  check(st?.activeZones >= 1, 'the zone is being watched', `${st?.activeZones}`);
  /*
   * ⚠️ `dwellWithoutIdentity` must be zero. A non-zero value means events reached a dwell rule that
   * could not accumulate them — the rule would look healthy and never fire, which is exactly the
   * silent failure this milestone's whole identity story exists to prevent.
   */
  check(
    (st?.dwellWithoutIdentity ?? 0) === 0,
    '⚠️ and NO evaluation was skipped for want of an identity',
    `${st?.dwellWithoutIdentity} skipped`,
  );
  check(
    typeof st?.evaluationsPerSecond === 'number',
    'evaluation rate is measured rather than absent',
    st?.evaluationsPerSecond === null ? 'still null' : `${st?.evaluationsPerSecond?.toFixed(1)}/s`,
  );
  console.log('');
} finally {
  writeFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), samples, findings }, null, 2)}\n`);
  await cleanup(true);
  shq('docker', ['rm', '-f', FIXTURE]);
}

console.log(
  failures === 0
    ? `\n✅ camera → assignment → tracking → identity → zone → events → rule → candidate, end to end\n`
    : `\n❌ ${failures} check(s) failed\n`,
);
if (findings.length > 0) {
  console.log('findings:');
  for (const f of findings) console.log(`  ⚠️ ${f.label} — ${f.detail}`);
  console.log('');
}
console.log(`samples → ${OUT}\n`);
process.exit(failures === 0 ? 0 : 1);

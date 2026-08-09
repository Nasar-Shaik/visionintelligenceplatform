/**
 * Object-association verification (Phase 2.4 workstream B).
 *
 *   node tools/validation/object-association.mjs                       # what is possible today
 *   node tools/validation/object-association.mjs --clip .data/real/x.mp4 --control .soak-real.mp4
 *
 * ⛔ **This tool cannot pass today, and that is its most important property.**
 *
 * `AssociationModule` has been written, unit-tested, deployed and running on every frame since slice
 * 2.2. It has **never had an object to associate**. Across every recording this platform has ever
 * analysed the detector has returned `person`, plus `tie` and `toilet` false positives — no bottle,
 * cup, backpack, handbag, suitcase, chair or laptop has ever reached it. No unit test could reveal
 * that, because every unit test authors its own objects.
 *
 * So this runs the whole chain on the **deployed stack** and reports each stage separately, and when
 * the clip contains no object it says `PENDING FOOTAGE` rather than `PASS`. A verification that
 * cannot tell "the feature is broken" from "nothing was there to see" is not a verification —
 * ⛔ **the one outcome this tool must never produce is a green tick nobody earned.**
 *
 * ### The five stages, in the order a failure should be read
 *
 * 1. **Detection** — which COCO labels appear, and how often. ⚠️ Reported before anything else: if
 *    the object never detects, nothing downstream can be judged, and that is a finding about the
 *    clip rather than about the platform.
 * 2. **Tracking** — whether the object got a stable identity, and for how many frames.
 * 3. **Association** — the spans `AssociationModule` produced: which subject, when, how long.
 * 4. **Events** — whether `subjects[].attributes.behaviour.association` reached the events store,
 *    four hops and two languages away from where it was computed.
 * 5. **Behaviour API** — whether the same facts are readable through `/api/behaviour/primitives`
 *    and `/api/behaviour/timeline`, including the `picked` / `dropped` / `objectMissing` /
 *    `objectReturned` entries.
 *
 * ### ⛔ The negative control runs in the same command
 *
 * The same pipeline is run over a clip known to contain **no** object, and association must produce
 * nothing. A positive result means little without it: an association layer that fires on empty
 * footage is worse than one that never fires, and only the pair of runs can tell them apart.
 *
 * See `docs/validation/OBJECT_FOOTAGE.md` for what to record, and
 * `docs/validation/OBJECT_ASSOCIATION.md` for the standing result.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/* ⚠️ Scoped to this validation tool, never the application: the edge uses Caddy's internal CA. */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE = process.env.VIP_BASE_URL ?? 'https://localhost';
const TENANT = process.env.VIP_TENANT ?? 'tnt_demo_retail';
const EMAIL = process.env.VIP_EMAIL ?? 'security.manager@northgate.demo';
const PASSWORD = process.env.VIP_PASSWORD ?? '12345678';

const flag = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit !== undefined) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] !== undefined && !process.argv[index + 1].startsWith('--'))
    return process.argv[index + 1];
  return index >= 0 ? true : fallback;
};

const CLIP = flag('clip', null);
const CONTROL = flag('control', null);
const CAMERA = String(flag('camera', process.env.VIP_CAMERA ?? 'cam_retail_entrance'));
const FPS = Number(flag('fps', 2));
const OUT = flag('out', null);
const TIMEOUT_MS = Number(flag('timeout', 900_000));

/**
 * The classes that make a clip usable, from `OBJECT_FOOTAGE.md`.
 *
 * ⚠️ Every one is a thing a person carries, because that is what association is *for*. A `chair`
 * detects well and is never picked up, so it proves the detector and nothing about the primitive.
 */
const CARRIED = ['bottle', 'cup', 'wine glass', 'backpack', 'handbag', 'suitcase', 'laptop', 'book', 'cell phone'];

const report = {
  startedAt: new Date().toISOString(),
  verdict: null,
  clip: CLIP === null ? null : String(CLIP),
  control: CONTROL === null ? null : String(CONTROL),
  stages: {},
  findings: [],
};
const finding = (kind, what) => report.findings.push({ kind, what });

let token = '';

async function login() {
  const res = await fetch(`${BASE}/api/identity/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json();
  if (res.status !== 200) throw new Error(`login: HTTP ${res.status}`);
  token = body.data.accessToken;
}

async function api(path, init = {}, retry = true) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'x-tenant-id': TENANT,
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401 && retry) {
    await login();
    return api(path, init, false);
  }
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── stage 0: run the clip through the product ─────────────────────────────────────────────────── */

/**
 * Upload and analyse one clip through the ordinary product path.
 *
 * ⚠️ **The product path, not a side door.** Anything that reached the runtime another way would
 * prove the runtime works and nothing about the platform — which is the failure P-5.8 found when a
 * feature turned out never to have worked outside `pnpm dev`.
 */
async function analyse(path) {
  const bytes = readFileSync(path);

  const created = await api('/api/media/analyses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cameraId: CAMERA,
      originalName: path.split('/').pop(),
      contentType: 'video/mp4',
      bytes: bytes.byteLength,
      label: `object-association-${Date.now()}`,
      /* ⚠️ A fixed footage start, so two runs land on the same footage clock. Offline replay never
       * moves footage time, and letting this default to upload time makes every comparison
       * meaningless. */
      footageStartedAt: '2026-02-14T18:30:00.000Z',
    }),
  });
  if (created.status !== 201) {
    throw new Error(`create analysis: HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);
  }
  const analysisId = created.body.data.analysis.id;

  const put = await fetch(created.body.data.uploadUrl, {
    method: 'PUT',
    body: bytes,
    headers: { 'content-type': 'video/mp4' },
  });
  if (!put.ok) throw new Error(`upload: HTTP ${put.status}`);

  const confirmed = await api(`/api/media/analyses/${analysisId}/confirm`, { method: 'POST' });
  if (confirmed.status !== 200) {
    throw new Error(`confirm: HTTP ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 300)}`);
  }

  /*
   * ⛔ **Confirming an upload does not analyse it — a session does.** The first version of this tool
   * polled `analysis.status` for `"completed"`; the field is `analysis.state`, its values are
   * `ready`/`processing`, and no session had been started at all. It sat in its own 900-second
   * timeout against a deployment that was working perfectly. `behaviour.mjs` already had the right
   * sequence; this now follows it rather than a guess about it.
   */
  const started = await api(`/api/media/analyses/${analysisId}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ analysisFrameRate: FPS }),
  });
  if (started.status !== 201) {
    throw new Error(`session: HTTP ${started.status} ${JSON.stringify(started.body).slice(0, 300)}`);
  }
  /* ⚠️ The session is the payload itself, not `{ session }` — unlike the create call above it. */
  const sessionId = started.body.data.id;

  const deadline = Date.now() + TIMEOUT_MS;
  let session = started.body.data;
  while (Date.now() < deadline && !['succeeded', 'failed', 'cancelled'].includes(session.state)) {
    await sleep(3000);
    const detail = await api(`/api/media/analyses/${analysisId}`);
    session = detail.body.data.sessions?.find((s) => s.id === sessionId) ?? session;
  }
  if (session.state !== 'succeeded') throw new Error(`analysis did not succeed: state=${String(session.state)}`);
  return { analysisId, sessionId, state: session.state };
}

/* ── stage 1 and 4: what the detector saw, and what reached the events store ───────────────────── */

async function detectionsAndEvents(sessionId) {
  const labels = new Map();
  const withAssociation = new Set();
  let events = 0;
  let cursor;
  do {
    const query = new URLSearchParams({ analysisSessionId: sessionId, limit: '200' });
    if (cursor !== undefined) query.set('cursor', cursor);
    const page = await api(`/api/events/events?${query.toString()}`);
    if (page.status !== 200) throw new Error(`events: HTTP ${page.status}`);
    for (const event of page.body.data.events ?? []) {
      events += 1;
      for (const subject of event.subjects ?? []) {
        const label = subject.label ?? event.payload?.label;
        if (typeof label === 'string') labels.set(label, (labels.get(label) ?? 0) + 1);
        /* ⭐ The four-hop assertion: computed in Python, read back out of MongoDB. */
        if (subject.attributes?.behaviour?.association !== undefined) {
          withAssociation.add(subject.identityId ?? subject.trackId ?? 'unknown');
        }
      }
    }
    cursor = page.body.data.nextCursor;
  } while (cursor !== undefined);

  const seen = [...labels.keys()];
  return {
    events,
    labels: Object.fromEntries([...labels].sort((a, b) => b[1] - a[1])),
    carriedSeen: CARRIED.filter((c) => labels.has(c)),
    carriedNotSeen: CARRIED.filter((c) => !labels.has(c)),
    distinctLabels: seen.length,
    identitiesWithAssociationInEvents: withAssociation.size,
  };
}

/* ── stages 2, 3 and 5: tracking, association and the read APIs ────────────────────────────────── */

async function behaviour(sessionId) {
  const [primitives, timeline, history] = await Promise.all([
    api(`/api/behaviour/primitives?streamId=${encodeURIComponent(sessionId)}`),
    api(`/api/behaviour/timeline?streamId=${encodeURIComponent(sessionId)}`),
    api(`/api/track-history?streamId=${encodeURIComponent(sessionId)}`),
  ]);

  const read = primitives.body?.data?.primitives ?? {};
  const identities = read.identities ?? {};
  const entries = timeline.body?.data?.entries ?? [];
  const records = history.body?.data?.records ?? [];

  /* ⚠️ An object identity is one whose stored record carries a non-subject label. Read off track
   * history rather than guessed from the primitives, because that is where the label lives. */
  const objectRecords = records.filter((r) => r.label !== undefined && r.label !== 'person');
  const objectKinds = ['carried', 'picked', 'dropped', 'objectMissing', 'objectReturned', 'handover'];
  const kinds = new Map();
  for (const entry of entries) if (objectKinds.includes(entry.kind)) kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);

  const spans = Object.values(identities)
    .flatMap((p) => p.association?.heldBy ?? [])
    .map((s) => ({ identityId: s.identityId, seconds: s.seconds, current: s.current }));

  return {
    tracking: {
      records: records.length,
      objectRecords: objectRecords.length,
      objectLabels: [...new Set(objectRecords.map((r) => r.label))].sort(),
      /* ⛔ One frame is a detection, not a track. An object association built on a single
       * observation is a coincidence with a duration attached. */
      objectRecordsOverFiveFrames: objectRecords.filter((r) => (r.points?.length ?? 0) >= 5).length,
    },
    association: {
      identitiesWithAssociation: Object.values(identities).filter((p) => p.association !== undefined).length,
      spans: spans.slice(0, 8),
      totalSpans: spans.length,
      events: Object.values(identities).flatMap((p) => p.association?.events ?? []).length,
    },
    behaviourApi: {
      primitivesStatus: primitives.status,
      timelineStatus: timeline.status,
      objectKindsSeen: Object.fromEntries([...kinds].sort((a, b) => b[1] - a[1])),
      objectKindsNotSeen: objectKinds.filter((k) => !kinds.has(k)),
      sample: entries.filter((e) => objectKinds.includes(e.kind)).slice(0, 4).map((e) => e.summary),
      relational: read.relational ?? null,
    },
  };
}

/* ── the verdict ───────────────────────────────────────────────────────────────────────────────── */

/**
 * ⛔ **Three outcomes, and `PENDING FOOTAGE` is not a soft failure.**
 *
 * It is the correct verdict when the platform behaved impeccably and the clip contained nothing to
 * associate. Calling that a pass would be fabrication; calling it a failure would blame the code for
 * the camera. Only a run whose *detector* produced a carried object can produce PASS or FAIL.
 */
function decide(run, control) {
  if (run === null) return 'NOT RUN — no --clip given';
  if (run.detections.carriedSeen.length === 0) {
    finding(
      'pending-footage',
      `the detector returned no carriable object in this clip (saw: ${Object.keys(run.detections.labels).join(', ') || 'nothing'}) — association cannot be judged`,
    );
    return 'PENDING FOOTAGE';
  }
  let ok = true;
  if (run.behaviour.tracking.objectRecordsOverFiveFrames === 0) {
    finding('functional-bug', 'an object was detected but never tracked for five frames — no identity to associate');
    ok = false;
  }
  if (run.behaviour.association.totalSpans === 0) {
    finding('functional-bug', 'an object was tracked and no association span was produced');
    ok = false;
  }
  if (run.detections.identitiesWithAssociationInEvents === 0 && run.behaviour.association.totalSpans > 0) {
    finding('functional-bug', 'association was computed and never reached the events store — the wire drops it');
    ok = false;
  }
  if (control !== null && control.behaviour.association.totalSpans > 0) {
    /* ⛔ The control is what makes the positive mean anything. */
    finding('functional-bug', 'the negative control produced association spans on footage with no objects');
    ok = false;
  }
  if (control === null) {
    finding('coverage', 'no negative control was run — pass --control with a clip known to contain no objects');
  }
  return ok ? 'PASS' : 'FAIL';
}

async function main() {
  await login();

  /* ⚠️ Reported even when no clip is given, because "what has this platform ever seen" is the
   * question this whole workstream exists to answer. */
  const store = await api('/api/track-history');
  const labelCounts = new Map();
  for (const record of store.body?.data?.records ?? []) {
    labelCounts.set(record.label, (labelCounts.get(record.label) ?? 0) + 1);
  }
  report.stages.everSeen = {
    httpStatus: store.status,
    records: store.body?.data?.records?.length ?? null,
    labels: Object.fromEntries([...labelCounts].sort((a, b) => b[1] - a[1])),
    carriedEverSeen: CARRIED.filter((c) => labelCounts.has(c)),
  };
  if (store.status === 200 && report.stages.everSeen.carriedEverSeen.length === 0) {
    finding(
      'pending-footage',
      'no carriable object appears anywhere in this deployment’s stored history — association has never executed on real data',
    );
  }

  let run = null;
  let control = null;

  if (CLIP !== null) {
    if (!existsSync(String(CLIP))) throw new Error(`no such clip: ${String(CLIP)}`);
    const analysed = await analyse(String(CLIP));
    run = {
      analysis: analysed,
      detections: await detectionsAndEvents(analysed.sessionId),
      behaviour: await behaviour(analysed.sessionId),
    };
    report.stages.run = run;
  }

  if (CONTROL !== null) {
    if (!existsSync(String(CONTROL))) throw new Error(`no such control clip: ${String(CONTROL)}`);
    const analysed = await analyse(String(CONTROL));
    control = {
      analysis: analysed,
      detections: await detectionsAndEvents(analysed.sessionId),
      behaviour: await behaviour(analysed.sessionId),
    };
    report.stages.control = control;
  }

  report.verdict = decide(run, control);
  report.finishedAt = new Date().toISOString();
}

main()
  .catch((err) => {
    report.error = err instanceof Error ? err.message : String(err);
    report.verdict = 'ERROR';
    finding('error', report.error);
  })
  .finally(() => {
    const text = JSON.stringify(report, null, 2);
    if (OUT !== null) writeFileSync(String(OUT), text);
    console.log(text);
    console.log(`\nverdict: ${String(report.verdict)}`);
    /* ⚠️ `PENDING FOOTAGE` exits 0: the platform is not broken, the recording does not exist yet.
     * A non-zero exit would put a permanent red light on a CI board and teach everyone to ignore it. */
    process.exit(report.verdict === 'FAIL' || report.verdict === 'ERROR' ? 1 : 0);
  });

/**
 * Behaviour-layer deployment verification (P-11 slice 2.2).
 *
 *   node tools/validation/behaviour.mjs --clip .soak-real.mp4 [--fps 2] [--restart] [--out f.json]
 *
 * ### ⚠️ What this proves that no unit test can
 *
 * The Python suite drives `RuntimeTracker` and `BehaviourStage` directly, with authored detections.
 * It proves the primitives and the wiring are right. It cannot prove any of the four things that
 * have actually broken on this platform before:
 *
 *   1. that the **built image** carries the stage at all — P-5.8 found a feature that had never
 *      worked outside `pnpm dev`;
 *   2. that behaviour attributes **survive the wire** — runtime → media → broker → events, four
 *      hops and two languages, with an open `attributes` map at every one of them;
 *   3. that the deployed model actually emits **more than one class**, on real footage rather than
 *      on a fixture whose labels were chosen by whoever wrote it;
 *   4. that track history **survives a container replacement**, which is the whole of ADR-0051's
 *      "resume after restart" and is a property of a volume rather than of any code.
 *
 * ### ⛔ Absence is reported, never rounded to zero
 *
 * Every count here can legitimately be 0 — an empty room produces no subjects. So each check states
 * whether it was *measurable*, and a class that never appeared is listed as `notSeen` rather than
 * folded into a total. A verification that cannot tell "the feature is broken" from "nothing walked
 * past the camera" is not a verification.
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/* ⚠️ Scoped to this tool, never to the application. Caddy serves an internal CA in the local stack;
 * the platform itself must never be told to skip verification. */
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

const CLIP = String(flag('clip', '.soak-real.mp4'));
const CAMERA = String(flag('camera', process.env.VIP_CAMERA ?? 'cam_4b8cbcbab9ec4685821b35a01c52efd2'));
const FPS = Number(flag('fps', 2));
const RESTART = flag('restart', false) === true;
const OUT = flag('out', null);
const TIMEOUT_MS = Number(flag('timeout', 900_000));

/** COCO classes the Behaviour Engine's first capability actually needs. */
const WANTED = ['person', 'bottle', 'cup', 'wine glass', 'backpack', 'handbag', 'suitcase'];

let token = null;
const report = {
  startedAt: new Date().toISOString(),
  clip: basename(CLIP),
  frameRate: FPS,
  stages: {},
  findings: [],
};
const finding = (kind, what) => report.findings.push({ kind, what });

/* ── platform ──────────────────────────────────────────────────────────────────────────────────── */

async function login() {
  const res = await fetch(`${BASE}/api/identity/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
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
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── the run ───────────────────────────────────────────────────────────────────────────────────── */

async function runAnalysis() {
  const bytes = readFileSync(CLIP);
  const created = await api('/api/media/analyses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cameraId: CAMERA,
      originalName: basename(CLIP),
      bytes: bytes.byteLength,
      contentType: 'video/mp4',
      /* ⚠️ Named for the run, so a rerun is comparable rather than indistinguishable. */
      label: `behaviour-verification-${Date.now()}`,
      /* ⚠️ A fixed footage start, so two runs land on the same footage clock. Offline replay never
       * moves footage time, and letting this default to upload time makes every comparison
       * meaningless — the trap `_state_for`'s stream key exists to survive. */
      footageStartedAt: '2026-02-14T18:30:00.000Z',
    }),
  });
  if (created.status !== 201) throw new Error(`create: HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);
  const analysisId = created.body.data.analysis.id;

  const put = await fetch(created.body.data.uploadUrl, {
    method: 'PUT',
    body: bytes,
    headers: { 'content-type': 'video/mp4' },
  });
  if (!put.ok) throw new Error(`upload: HTTP ${put.status}`);

  const confirmed = await api(`/api/media/analyses/${analysisId}/confirm`, { method: 'POST' });
  if (confirmed.status !== 200) throw new Error(`confirm: HTTP ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 300)}`);

  const started = await api(`/api/media/analyses/${analysisId}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ analysisFrameRate: FPS }),
  });
  if (started.status !== 201) throw new Error(`session: HTTP ${started.status} ${JSON.stringify(started.body).slice(0, 300)}`);
  /* ⚠️ The session is the payload itself, not `{ session }` — unlike the create call above it. */
  const sessionId = started.body.data.id;

  const deadline = Date.now() + TIMEOUT_MS;
  let session = started.body.data;
  while (Date.now() < deadline && !['succeeded', 'failed', 'cancelled'].includes(session.state)) {
    await sleep(3000);
    const detail = await api(`/api/media/analyses/${analysisId}`);
    session = detail.body.data.sessions?.find((s) => s.id === sessionId) ?? session;
  }
  return { analysisId, sessionId, session };
}

/* ── the checks ────────────────────────────────────────────────────────────────────────────────── */

/**
 * Which classes the deployed model actually emitted, and which it did not.
 *
 * ⛔ `notSeen` is the point. A histogram showing only `person` proves multi-class works *or* that no
 * bottle walked past — and the two are the same picture unless the absent classes are named.
 */
async function classHistogram(sessionId) {
  const labels = new Map();
  let withBehaviour = 0;
  let total = 0;
  const primitives = new Set();
  let cursor;
  do {
    const query = new URLSearchParams({ analysisSessionId: sessionId, limit: '200' });
    if (cursor !== undefined) query.set('cursor', cursor);
    /* ⚠️ `/api/events/events` — the gateway's generic `/api/:service/*` proxy, so the service
     * name appears once and the service's own path again. Getting this wrong is a 404, not a bug. */
    const page = await api(`/api/events/events?${query.toString()}`);
    if (page.status !== 200) throw new Error(`events: HTTP ${page.status} ${JSON.stringify(page.body).slice(0, 200)}`);
    for (const event of page.body.data.events ?? []) {
      total += 1;
      const label = event.payload?.label;
      if (typeof label === 'string') labels.set(label, (labels.get(label) ?? 0) + 1);
      /* ⭐ Behaviour rides on the SUBJECT's attributes — the frozen contract's open map, exactly
       * where ADR-0050 said a new modality would ride. This is the assertion that the four hops
       * between the runtime and the events store preserved it. */
      const attributes = event.subjects?.[0]?.attributes ?? {};
      if (attributes.behaviour !== undefined && attributes.behaviour !== null) {
        withBehaviour += 1;
        for (const key of Object.keys(attributes.behaviour)) primitives.add(key);
      }
    }
    cursor = page.body.data.nextCursor;
  } while (cursor !== undefined);

  return {
    events: total,
    labels: Object.fromEntries([...labels].sort((a, b) => b[1] - a[1])),
    distinctLabels: labels.size,
    notSeen: WANTED.filter((w) => !labels.has(w)),
    eventsWithBehaviour: withBehaviour,
    primitivesObserved: [...primitives].sort(),
  };
}

async function runtimeState() {
  const [behaviour, history, tracking] = await Promise.all([
    api('/api/behaviour'),
    api('/api/track-history'),
    api('/api/tracking'),
  ]);
  return {
    behaviour: behaviour.body?.data ?? { httpStatus: behaviour.status },
    history: {
      enabled: history.body?.data?.enabled ?? false,
      records: history.body?.data?.records?.length ?? 0,
      stats: history.body?.data?.stats ?? null,
    },
    trackHistoryEngine: tracking.body?.data?.engine?.trackHistory ?? null,
  };
}

/** ⭐ ADR-0051's "resume after restart", proved by replacing the container rather than by asserting. */
async function restartAndReread() {
  const before = (await runtimeState()).history;
  await execFileAsync('docker', ['restart', 'vip-prod-inference-1']);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(2000);
    const { status } = await api('/api/tracking');
    if (status === 200) break;
  }
  const after = (await runtimeState()).history;
  return { before, after, survived: after.records >= before.records && before.records > 0 };
}

/* ── main ──────────────────────────────────────────────────────────────────────────────────────── */

async function main() {
  await login();
  report.stages.before = await runtimeState();

  const durable = report.stages.before.history?.stats?.store?.durable;
  if (durable !== true) {
    finding('config', 'the runtime is not persisting track history — INFERENCE_TRACK_HISTORY_DIR is unset');
  }

  const t = Date.now();
  const { analysisId, sessionId, session } = await runAnalysis();
  report.stages.analysis = {
    analysisId,
    sessionId,
    state: session.state,
    framesProcessed: session.progress?.framesProcessed ?? null,
    elapsedMs: Date.now() - t,
  };
  if (session.state !== 'succeeded') {
    finding('functional-bug', `analysis ended ${session.state}`);
    return;
  }

  report.stages.detections = await classHistogram(sessionId);
  report.stages.after = await runtimeState();

  const d = report.stages.detections;
  if (d.events === 0) finding('coverage', 'the run produced no events — nothing to verify against');
  if (d.distinctLabels <= 1) {
    finding(
      'coverage',
      `only ${String(d.distinctLabels)} class(es) appeared; multi-class is unproven on this footage`,
    );
  }
  if (d.events > 0 && d.eventsWithBehaviour === 0) {
    finding('functional-bug', 'no event carried behaviour attributes — the layer did not survive the wire');
  }

  if (RESTART) report.stages.restart = await restartAndReread();

  report.finishedAt = new Date().toISOString();
}

main()
  .catch((err) => {
    report.error = err instanceof Error ? err.message : String(err);
    finding('error', report.error);
  })
  .finally(() => {
    const text = JSON.stringify(report, null, 2);
    if (OUT !== null && OUT !== true) writeFileSync(String(OUT), text);
    console.log(text);
    process.exit(report.findings.some((f) => f.kind !== 'coverage') ? 1 : 0);
  });

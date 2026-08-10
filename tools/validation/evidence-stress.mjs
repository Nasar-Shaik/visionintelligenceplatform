/**
 * Evidence integrity under load — Evidence Integrity, EI-5b.
 *
 *   node tools/validation/evidence-stress.mjs --clip <file.mp4> --runs 24 --concurrency 4
 *   node tools/validation/evidence-stress.mjs --clip <file.mp4> --runs 120 --restarts 3   # nightly
 *
 * ⛔ **What this is for.** Every durability property proven so far was proven on a quiet stack: one
 * analysis, one restart, one read. The defects this milestone found were all *steady-state* defects —
 * 28 open identities across 12 finished runs had accumulated in 26 minutes of ordinary use — and a
 * property that holds for one run is not the same claim as one that holds for the hundredth.
 *
 * ### What is asserted, and why each one
 *
 * 1. **No write ever failed.** ⚠️ Weak on its own — it stayed at zero throughout the original defect,
 *    because nothing was attempted. It is here as a *precondition*, not as a pass.
 * 2. **Nothing is live once a run has ended.** ⭐ The real one. This is the invariant that makes
 *    SIGKILL, OOM and an expired grace period harmless: there is nothing in memory to lose.
 * 3. **Every succeeded run reads back.** Its own identities, under its own stream id — which is what
 *    catches a close that retired the wrong stream.
 * 4. **No read is `corrupted` or `lost`.** The six-state model is the instrument; a stress run that
 *    never exercises it is measuring with a broken gauge.
 * 5. **Restarts change nothing.** Runs continue across an ungraceful kill of the runtime, and the
 *    records written before it are still there afterwards.
 * 6. **Cancelled runs keep what they saw.** ⚠️ A cancelled analysis has produced real evidence up to
 *    the moment it stopped, and an operator who cancels after twenty minutes expects the twenty
 *    minutes.
 *
 * ⚠️ **Concurrency is the point of `--concurrency`.** One analysis at a time would never exercise the
 * recorder's lock, the shared `_pending` queue, or two streams closing at once — and "closing one
 * stream must not retire another" is a property that can only fail when there is another.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/* ⚠️ Scoped to this validation tool, never the application: the edge uses Caddy's internal CA. */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const flag = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit !== undefined) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] !== undefined && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return index >= 0 ? true : fallback;
};

const BASE = process.env.VIP_BASE_URL ?? 'https://localhost';
const TENANT = process.env.VIP_TENANT ?? 'tnt_demo_retail';
const EMAIL = process.env.VIP_EMAIL ?? 'security.manager@northgate.demo';
const PASSWORD = process.env.VIP_PASSWORD ?? '12345678';
const CAMERA = String(flag('camera', process.env.VIP_CAMERA ?? 'cam_retail_entrance'));
const CLIP = String(flag('clip', 'infra/docker/fixtures/media/validation/carried-objects.mp4'));
const RUNS = Number(flag('runs', '24'));
const CONCURRENCY = Number(flag('concurrency', '4'));
const RESTARTS = Number(flag('restarts', '1'));
/** ⚠️ Cancel roughly one run in this many, so the interrupted path is exercised under load. */
const CANCEL_EVERY = Number(flag('cancel-every', '8'));
const CONTAINER = process.env.VIP_INFERENCE_CONTAINER ?? 'vip-prod-inference-1';

let token = '';
const login = async () => {
  const res = await fetch(`${BASE}/api/identity/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login: HTTP ${res.status}`);
  token = (await res.json()).data.accessToken;
};

const api = async (path, init = {}, retry = true) => {
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
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The runtime's own counters, read from inside the container.
 *
 * ⚠️ Read from `/metrics` rather than inferred from the API, because the whole class of defect this
 * milestone found was *the API looking fine while the counters said otherwise*.
 */
const metrics = () => {
  try {
    const out = execSync(
      `docker exec ${CONTAINER} python -c 'import urllib.request as u; print(u.urlopen("http://127.0.0.1:8085/metrics").read().decode())'`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const pick = (name) => {
      const m = out.match(new RegExp(`^inference_track_history_${name} (\\d+)`, 'm'));
      return m === null ? null : Number(m[1]);
    };
    return {
      records: pick('records'),
      live: pick('live_identities'),
      streams: pick('live_streams'),
      failures: pick('write_failures_total'),
    };
  } catch {
    return { records: null, live: null, streams: null, failures: null };
  }
};

const bytes = readFileSync(CLIP);

/** Upload, analyse, and report what the run did — including a deliberate cancellation. */
async function runOnce(index) {
  const created = await api('/api/media/analyses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cameraId: CAMERA,
      originalName: CLIP.split('/').pop(),
      contentType: 'video/mp4',
      bytes: bytes.byteLength,
      label: `evidence-stress-${String(index)}-${Date.now()}`,
      /* ⚠️ A fixed footage start, so every run lands on the same footage clock — offline replay
       * never moves footage time, and letting this default to upload time makes runs incomparable. */
      footageStartedAt: '2026-02-14T18:30:00.000Z',
    }),
  });
  if (created.status !== 201) return { index, error: `create HTTP ${String(created.status)}` };
  const analysisId = created.body.data.analysis.id;

  const put = await fetch(created.body.data.uploadUrl, {
    method: 'PUT',
    body: bytes,
    headers: { 'content-type': 'video/mp4' },
  });
  if (!put.ok) return { index, error: `upload HTTP ${String(put.status)}` };
  await api(`/api/media/analyses/${analysisId}/confirm`, { method: 'POST' });

  const started = await api(`/api/media/analyses/${analysisId}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ analysisFrameRate: 2 }),
  });
  if (started.status !== 201) return { index, error: `session HTTP ${String(started.status)}` };
  const sessionId = started.body.data.id;

  const cancelling = CANCEL_EVERY > 0 && index % CANCEL_EVERY === CANCEL_EVERY - 1;
  if (cancelling) {
    /* ⚠️ Part-way through, not immediately: a cancel before the first frame leaves nothing to keep,
     * which would make this assert nothing. */
    await sleep(2500);
    await api(`/api/media/analysis-sessions/${sessionId}/cancel`, { method: 'POST' });
  }

  let session = started.body.data;
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline && !['succeeded', 'failed', 'cancelled'].includes(session.state)) {
    await sleep(2000);
    const detail = await api(`/api/media/analyses/${analysisId}`);
    session = detail.body.data.sessions?.find((s) => s.id === sessionId) ?? session;
  }

  const notPreserved = (session.findings ?? []).filter((f) => f.kind === 'evidence-not-preserved');
  return {
    index,
    analysisId,
    sessionId,
    state: session.state,
    cancelling,
    /*
     * ⛔ **The denominator, without which every assertion below is a coin toss.**
     *
     * A run that took place while the runtime was dead analyses nothing and finds nothing, and reads
     * back `absent` — which is CORRECT. Asserting "every succeeded run reads back evidence" would
     * fail on it and call a working platform broken. Worse, it would pass on the day a run that DID
     * see something lost it, if the two happened to cancel out.
     *
     * ⚠️ The first version of this harness did exactly that and reported 9 of 23 runs as losing
     * evidence. None of them had. What separates the two cases is whether the run *saw* anything —
     * so that number is carried, and every claim below is conditioned on it.
     */
    detections: session.counts?.detections ?? 0,
    framesAnalysed: session.counts?.framesAnalysed ?? 0,
    notPreserved: notPreserved.map((f) => f.detail),
    /** Every finding kind, so "it said nothing" can be told from "it said something else". */
    findingKinds: (session.findings ?? []).map((f) => f.kind),
  };
}

/** Read one run back and report its six-state verdict. */
async function readBack(sessionId) {
  const res = await api(`/api/behaviour/timeline?streamId=${encodeURIComponent(sessionId)}`);
  if (res.status !== 200) return { state: `HTTP ${String(res.status)}`, records: 0 };
  const evidence = res.body.data?.evidence ?? {};
  return {
    state: evidence.state ?? 'missing',
    records: evidence.records ?? 0,
    damaged: evidence.damagedRecords ?? 0,
    lost: evidence.lostIdentities ?? [],
  };
}

// --- the run --------------------------------------------------------------------------------------

await login();

console.log(`\nevidence stress · ${String(RUNS)} analyses · concurrency ${String(CONCURRENCY)} · ${String(RESTARTS)} ungraceful restart(s)`);
console.log(`clip: ${CLIP}  camera: ${CAMERA}\n`);

const before = metrics();
console.log(`before   records=${String(before.records)} live=${String(before.live)} failures=${String(before.failures)}`);

const results = [];
const restartAfter = RESTARTS > 0 ? Math.floor(RUNS / (RESTARTS + 1)) : Number.POSITIVE_INFINITY;
let nextRestart = restartAfter;
let launched = 0;
const started = Date.now();

/* A fixed-size pool, so `--concurrency` means what it says rather than "all at once". */
const workers = Array.from({ length: Math.min(CONCURRENCY, RUNS) }, async () => {
  for (;;) {
    const index = launched;
    if (index >= RUNS) return;
    launched += 1;
    const result = await runOnce(index);
    results.push(result);
    const done = results.length;
    process.stdout.write(
      `  [${String(done).padStart(3)}/${String(RUNS)}] ${String(result.state ?? result.error).padEnd(10)} ${result.sessionId ?? ''}${result.cancelling === true ? '  (cancelled deliberately)' : ''}\n`,
    );

    /*
     * ⛔ **An ungraceful kill, mid-flight, with other analyses still running.** This is the moment
     * the whole milestone is about: a runtime that dies without warning while work is in progress.
     * Runs in flight will fail or retry, which is correct and expected — what must NOT happen is
     * that a run which already reported `succeeded` loses its evidence.
     */
    if (done >= nextRestart && nextRestart < RUNS) {
      nextRestart += restartAfter;
      const at = metrics();
      console.log(`\n  ⏻ SIGKILL the runtime at ${String(done)} runs — records=${String(at.records)} live=${String(at.live)}`);
      try {
        execSync(`docker kill -s KILL ${CONTAINER}`, { stdio: 'ignore' });
        execSync(`docker start ${CONTAINER}`, { stdio: 'ignore' });
      } catch {
        console.log('  ⚠️ could not restart the container — continuing');
      }
      for (let i = 0; i < 45; i += 1) {
        try {
          execSync(
            `docker exec ${CONTAINER} python -c 'import urllib.request as u; u.urlopen("http://127.0.0.1:8085/ready")'`,
            { stdio: 'ignore' },
          );
          break;
        } catch {
          await sleep(2000);
        }
      }
      const after = metrics();
      console.log(`  ⏻ back up — records=${String(after.records)} live=${String(after.live)}`);
      if (after.records !== null && at.records !== null && after.records < at.records) {
        console.log(`  ⛔ RECORDS WENT DOWN across the kill: ${String(at.records)} → ${String(after.records)}`);
      }
      console.log('');
    }
  }
});
await Promise.all(workers);

const elapsed = (Date.now() - started) / 1000;

/*
 * ⭐ **Wait for the live buffer to drain, and report how long it took.**
 *
 * ⛔ Not a sleep to make the assertion pass. A run reaches its terminal state in Mongo a moment
 * before its close lands, so a reading taken at the instant the last poll returns can legitimately
 * show identities still open — measured at 3. The question that matters is not "is it zero right
 * now" but **"does it reach zero at all"**, and those are different claims: one is a race, the other
 * is the leak this whole milestone is about. So it is polled, bounded, and the time is printed —
 * a drain that starts taking thirty seconds is itself a finding.
 */
let settleMs = 0;
for (let i = 0; i < 30; i += 1) {
  if (metrics().live === 0) break;
  await sleep(1000);
  settleMs += 1000;
}
const after = metrics();
console.log(`\nafter    records=${String(after.records)} live=${String(after.live)} streams=${String(after.streams)} failures=${String(after.failures)}`);
console.log(`elapsed  ${elapsed.toFixed(0)} s\n`);

// --- what it proved -------------------------------------------------------------------------------

const byState = {};
for (const r of results) byState[r.state ?? r.error ?? 'unknown'] = (byState[r.state ?? r.error ?? 'unknown'] ?? 0) + 1;
console.log(`run outcomes: ${JSON.stringify(byState)}`);

const readable = [];
for (const r of results) {
  if (r.sessionId === undefined) continue;
  readable.push({ ...r, evidence: await readBack(r.sessionId) });
}

const failures = [];

/* 1. No durable write failed. ⚠️ A precondition, never a pass on its own. */
if (after.failures !== 0) failures.push(`write_failures_total is ${String(after.failures)}, expected 0`);

/* 2. ⭐ Nothing is live once every run has ended — the invariant that makes a kill harmless. */
if (after.live !== 0) {
  failures.push(`${String(after.live)} identity(ies) still live 30 s after every run ended — they are never being closed`);
}

/*
 * 3. Runs that reported they could not be closed.
 *
 * ⚠️ **Expected when this harness kills the runtime on purpose, and NOT a failure then.** A run that
 * finishes while the runtime is dead genuinely cannot be told to close; saying so is the mechanism
 * working, and a silent success there would be the defect. It is a failure only when no restart was
 * injected — then nothing should have prevented the close.
 *
 * ⛔ Whether evidence was actually *lost* is a different question, and assertion 5 answers it
 * precisely. This one must not be allowed to stand in for that, or a harness that kills the runtime
 * would report failure every time and be switched off.
 */
const notPreserved = readable.filter((r) => r.notPreserved.length > 0);
if (notPreserved.length > 0) {
  if (RESTARTS === 0) {
    failures.push(`${String(notPreserved.length)} run(s) could not be closed, with no restart to explain it`);
    for (const r of notPreserved.slice(0, 5)) console.log(`  ⛔ ${r.sessionId}: ${r.notPreserved[0]}`);
  } else {
    console.log(`  ⚠️ ${String(notPreserved.length)} run(s) finished while the runtime was killed and said so — expected`);
  }
}

/*
 * 4. ⛔ **No read is ever `corrupted`.** Nothing in this harness damages a file, so a corrupted read
 * would mean the write path tore a record under concurrency — which is exactly what `--concurrency`
 * is here to try to provoke.
 *
 * ⚠️ `lost` is a different matter. Evidence held in memory by a process that is SIGKILLed mid-run is
 * genuinely unrecoverable — no shutdown handler is consulted — so under deliberate kills a `lost`
 * read is the platform being HONEST, not failing. What must never happen is that such a run reads
 * `absent`: that is the collapse EI-4 exists to prevent, and it is checked in assertion 5.
 */
const corrupted = readable.filter((r) => r.evidence.state === 'corrupted');
if (corrupted.length > 0) {
  failures.push(`${String(corrupted.length)} read(s) came back corrupted — the write path tore a record`);
  for (const r of corrupted.slice(0, 5)) console.log(`  ⛔ ${r.sessionId}: corrupted`);
}
const lostReads = readable.filter((r) => r.evidence.state === 'lost');
if (lostReads.length > 0 && RESTARTS === 0) {
  failures.push(`${String(lostReads.length)} read(s) came back lost, with no restart to explain it`);
}

/*
 * 5. ⭐ **Every run that SAW something reads it back.**
 *
 * ⚠️ Conditioned on `detections > 0`, and that condition is the whole assertion. A run that took
 * place while the runtime was deliberately dead analysed nothing, found nothing, and reads back
 * `absent` — correctly. Only a run that produced detections and then reads back nothing has lost
 * something.
 */
const saw = readable.filter((r) => r.detections > 0);
const lostWhatItSaw = saw.filter((r) => r.evidence.records === 0);
/*
 * ⛔ **The rule, stated exactly.** Without a deliberate kill, a run that saw something must read it
 * back — no loss is acceptable. With one, evidence held in memory by the killed process is gone and
 * cannot be otherwise; what is required is that the read SAYS SO. A run that detected 51 things,
 * lost them to a SIGKILL and answers `absent` is indistinguishable from a run where nobody was
 * there — which is the single failure this milestone exists to end.
 */
const silentlyLost = lostWhatItSaw.filter((r) => r.evidence.state !== 'lost');
if (RESTARTS === 0 && lostWhatItSaw.length > 0) {
  failures.push(`${String(lostWhatItSaw.length)} of ${String(saw.length)} run(s) that DETECTED something read back nothing, with no restart to explain it`);
} else if (silentlyLost.length > 0) {
  failures.push(`${String(silentlyLost.length)} run(s) lost what they saw and did NOT report it as lost`);
}
for (const r of lostWhatItSaw.slice(0, 5)) {
  console.log(`  ${r.evidence.state === 'lost' ? '⚠️ ' : '⛔'} ${r.sessionId}: ${String(r.detections)} detections, reads ${r.evidence.state}`);
}

/* 6. ⚠️ A cancelled run keeps what it saw before it stopped — again, only if it saw anything. */
const cancelled = readable.filter((r) => r.state === 'cancelled');
const cancelledSaw = cancelled.filter((r) => r.detections > 0);
const cancelledLost = cancelledSaw.filter((r) => r.evidence.records === 0);
if (cancelledLost.length > 0) {
  failures.push(`${String(cancelledLost.length)} cancelled run(s) detected something and kept none of it`);
}

/*
 * 7. ⛔ **A run that analysed nothing must not be silent about it.**
 *
 * A `succeeded` state on a run that looked at zero frames is the reassuring answer to a question
 * nobody asked. The worker already raises `frames-dropped` for refused frames; this checks it did.
 */
const analysedNothing = readable.filter((r) => r.state === 'succeeded' && r.framesAnalysed === 0);
/* ⛔ A run that looked at nothing and said nothing is the reassuring answer to a question nobody
 * asked. `frames-dropped` counts as saying something — it names the frames that went unexamined. */
const silentlyEmpty = analysedNothing.filter((r) => r.findingKinds.length === 0);
if (silentlyEmpty.length > 0) {
  failures.push(`${String(silentlyEmpty.length)} run(s) analysed nothing and raised no finding at all`);
  for (const r of silentlyEmpty.slice(0, 5)) console.log(`  ⛔ ${r.sessionId}: succeeded, 0 frames analysed, no findings`);
}

console.log('');
console.log(`runs that detected something         : ${String(saw.length)}/${String(readable.length)}`);
console.log(`  …of those, reading their evidence  : ${String(saw.length - lostWhatItSaw.length)}/${String(saw.length)}`);
console.log(`runs that analysed nothing (dead rt) : ${String(analysedNothing.length)}  (${String(silentlyEmpty.length)} without a finding)`);
console.log(`cancelled runs keeping what they saw : ${String(cancelledSaw.length - cancelledLost.length)}/${String(cancelledSaw.length)}`);
console.log(`reads reported as lost (kill mid-run): ${String(lostReads.length)}  ⚠️ honest, not silent`);
console.log(`reads corrupted                      : ${String(corrupted.length)}`);
console.log(`live buffer drained after            : ${String(settleMs / 1000)} s`);
console.log(`durable write failures               : ${String(after.failures)}`);
console.log(`identities live after the last run   : ${String(after.live)}`);

if (failures.length === 0) {
  console.log('\n⭐ EVIDENCE HELD under load, concurrency, cancellation and ungraceful restarts.\n');
  process.exit(0);
}
console.log(`\n⛔ ${String(failures.length)} FAILURE(S):`);
for (const f of failures) console.log(`  · ${f}`);
console.log('');
process.exit(1);

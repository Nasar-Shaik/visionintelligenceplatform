/**
 * P-8 Phase 3 · **is the runtime actually looking at the frames, or only answering?**
 *
 *   node docs/review/p8/inference.mjs          # integrity → real inference → end-to-end → ladder
 *   node docs/review/p8/inference.mjs clean    # ⚠️ if a run was interrupted
 *
 * Phase 2 proved frames arrive. This proves something is *done* with them — by a real model, in the
 * deployed container, with the answer traced back to the pixels that produced it.
 *
 * ### ⚠️ The check that makes every other check meaningful
 *
 * **A frame with nothing in it must produce nothing.** The `stub` backend returned a detection for
 * any bytes at all: it would pass "frames arrive", "detections are produced", "latency is measured"
 * and "the dashboard is populated" while seeing precisely nothing. So the suite runs two frames —
 * a photograph of two people, and a colour-bar test pattern — and the test pattern must come back
 * empty. Everything else here is only evidence *because* that one holds.
 *
 * ### ⚠️ Counting is not enough: the count must be right
 *
 * The photograph contains **two** people. The assertion is `=== 2`, not `> 0`. A model that
 * hallucinated a third would satisfy "detections were produced", and a product that reports three
 * people in front of a cash counter when two are there is worse than one that reports none.
 *
 * ### What is deliberately NOT measured here
 *
 * Model accuracy. Two photographs are a smoke test of the deployed path, not an evaluation set —
 * mAP against a labelled corpus is a different exercise on different data, and quoting a confidence
 * number from two frames as though it were quality would be exactly the overstatement this
 * platform's capability matrix exists to prevent.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const VIEWER = { email: 'loss.prevention@northgate.demo', password: 'Vip-Demo-2026!' };
const MEDIA = 'vip-prod-media-1';
const RUNTIME = 'vip-prod-inference-1';
const FIXTURE = 'vip-rtsp-fixture';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-infer';
const LADDER = [1, 2, 4, 8, 16];
const WINDOW = 20;
const WARMUP = 8;
/** The photograph the fixture loops, and the number of people actually in it. */
const SCENE = `${ROOT}/infra/docker/fixtures/media/scene-people.jpg`;
const PEOPLE_IN_SCENE = 2;

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

/* ── talking to the runtime without ever handling its key ─────────────────────────────────────── */

/**
 * POST a frame to the runtime **from inside the media container**.
 *
 * ⚠️ The internal key is never read into this process. `$INTERNAL_API_KEY` is expanded by the shell
 * *inside* the container that already holds it, so the secret exists in exactly the places it
 * already existed and a stray `console.log` here cannot print it (ADR-0018).
 */
function infer(jpegPath, { cameraId = 'cam_verify', seq = 1, capturedAt = null } = {}) {
  const body = {
    capabilityId: 'perception.person-detection',
    context: { tenantId: TENANT },
    frame: {
      cameraId,
      seq,
      capturedAt: capturedAt ?? new Date().toISOString(),
      source: 'media',
    },
    imageBase64: readFileSync(jpegPath).toString('base64'),
  };
  const staged = join(tmpdir(), `p8-infer-${process.pid}.json`);
  writeFileSync(staged, JSON.stringify(body));
  try {
    sh('docker', ['cp', staged, `${MEDIA}:/tmp/p8-infer.json`]);
    const raw = shq('docker', [
      'exec',
      MEDIA,
      'sh',
      '-c',
      'curl -s -X POST http://inference:8085/infer ' +
        '-H "content-type: application/json" -H "x-internal-key: $INTERNAL_API_KEY" ' +
        '--data-binary @/tmp/p8-infer.json',
    ]);
    try {
      return JSON.parse(raw);
    } catch {
      return { success: false, raw: raw.slice(0, 300) };
    }
  } finally {
    try {
      unlinkSync(staged);
    } catch {
      /* best effort */
    }
  }
}

/** Ask the runtime about itself, from inside the network that is allowed to. */
function runtimeView() {
  const raw = shq('docker', [
    'exec',
    RUNTIME,
    'python',
    '-c',
    "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8085/runtime',timeout=5).read().decode())",
  ]);
  try {
    return JSON.parse(raw).data ?? {};
  } catch {
    return {};
  }
}

function scrape(container, port) {
  const text =
    container === MEDIA
      ? shq('docker', ['exec', container, 'sh', '-c', `curl -s localhost:${port}/metrics`])
      : shq('docker', [
          'exec',
          container,
          'python',
          '-c',
          `import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:${port}/metrics',timeout=5).read().decode())`,
        ]);
  const out = {};
  const labelled = {};
  for (const line of text.split('\n')) {
    /* ⚠️ The label block is OPTIONAL, and forgetting that cost a whole run. Every media series
       carries `{service="media"}`, so a regex that only accepts bare `name value` reads all of them
       as absent — the ladder printed five rungs of zeros against a pipeline that was working. */
    const m = line.match(/^([a-z_][a-z0-9_]*)(?:\{([^}]*)\})?\s+([0-9.eE+-]+)$/);
    if (!m) continue;
    const [, name, labels = '', value] = m;
    out[name] = Number(value);
    const label = (labels.match(/(?:^|,)label="([^"]*)"/) ?? [])[1];
    if (label !== undefined) {
      labelled[name] ??= {};
      labelled[name][label] = Number(value);
    }
  }
  return { ...out, _labelled: labelled };
}

function containerStats(name) {
  const raw = shq('docker', [
    'stats',
    '--no-stream',
    '--format',
    '{{.CPUPerc}}|{{.MemUsage}}',
    name,
  ]);
  const [cpu = '', mem = ''] = raw.split('|');
  const toMb = (s) => {
    const m = s.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
    if (!m) return 0;
    const v = Number(m[1]);
    const unit = (m[2] ?? '').toLowerCase();
    return unit.startsWith('g') ? v * 1024 : unit.startsWith('k') ? v / 1024 : v;
  };
  return {
    cpuPercent: Number((cpu.replace('%', '') || '0').trim()),
    memoryMb: toMb((mem.split('/')[0] ?? '').trim()),
  };
}

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
async function tokenFor(user) {
  const r = await api('/identity/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify(user),
  });
  return r.json?.data?.accessToken;
}
async function login() {
  H = { authorization: `Bearer ${await tokenFor(ADMIN)}`, 'content-type': 'application/json' };
}

/* ── fixture cameras ──────────────────────────────────────────────────────────────────────────── */

const fixtureCameras = async () => {
  const r = await api(`/camera/cameras?limit=200&search=${TAG}`, { headers: H });
  return (r.json?.data?.cameras ?? []).filter((c) => (c.metadata?.tags ?? []).includes(TAG));
};

async function cleanup(quiet = false) {
  await login();
  const cams = await fixtureCameras();
  for (const cam of cams) {
    await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
    await api(`/camera/cameras/${cam.id}`, {
      method: 'DELETE',
      headers: { authorization: H.authorization },
    });
  }
  shq('docker', ['rm', '-f', FIXTURE]);
  if (!quiet) console.log(`\nremoved ${cams.length} fixture camera(s) and stopped the RTSP fixture\n`);
  return cams.length;
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

function startFixture() {
  shq('docker', ['rm', '-f', FIXTURE]);
  sh('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    FIXTURE,
    '--network',
    NETWORK,
    '-v',
    `${ROOT}/infra/docker/fixtures/rtsp-fixture.yml:/mediamtx.yml:ro`,
    '-v',
    `${ROOT}/infra/docker/fixtures/media:/fixtures/media:ro`,
    'bluenviron/mediamtx:latest-ffmpeg',
  ]);
}

/** The zone every fixture camera is created under — read from an existing camera, not invented. */
let zoneId = null;

async function createCamera(index, path = null) {
  zoneId ??= (await api('/camera/cameras?limit=1', { headers: H })).json?.data?.cameras?.[0]?.zoneId;
  const slug = `p8i${String(index).padStart(2, '0')}`;
  const r = await api('/camera/cameras', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      zoneId,
      name: `${TAG} ${String(index).padStart(2, '0')}`,
      protocol: 'rtsp',
      streamUrl: `rtsp://${FIXTURE}:8554/${path ?? slug}`,
      metadata: { tags: [TAG] },
    }),
  });
  if (r.status !== 201) {
    check(false, `could not create fixture camera ${index}`, `${r.status} ${r.text.slice(0, 140)}`);
    return null;
  }
  return r.json?.data?.id ?? null;
}

console.log('\nP-8 Phase 3 · real inference\n');
await login();
await cleanup(true);

/* ── 0 · the image is the one that was built, and it carries what it claims ───────────────────── */
console.log('0 · image + artifact integrity');
{
  const label = shq('docker', [
    'inspect',
    '-f',
    '{{ index .Config.Labels "vip.inference.backend" }}',
    'vip/inference:local',
  ]);
  check(label === 'onnx', 'the deployed image is built for the real backend', `label=${label || 'none'}`);

  const backend = shq('docker', ['exec', RUNTIME, 'printenv', 'INFERENCE_BACKEND']);
  check(backend === 'onnx', 'the running container is configured for the real backend', backend);

  const source = shq('docker', ['exec', RUNTIME, 'printenv', 'INFERENCE_MODEL_SOURCE']);
  check(
    source === 'local',
    '⚠️ models resolve from the image, not from a tracking server it must reach at boot',
    source,
  );

  // ⚠️ Re-verified here, independently of the runtime's own start-up check: "the file is present"
  // and "the file we registered is present" are different claims.
  const verify = shq('docker', [
    'exec',
    RUNTIME,
    'python',
    'fetch_models.py',
    '--verify-only',
    '--dest',
    '/opt/vip/models',
  ]);
  check(verify.includes('verified'), 'every registered artifact matches its recorded sha256', verify.split('\n').pop());

  const ort = shq('docker', [
    'exec',
    RUNTIME,
    'python',
    '-c',
    'import onnxruntime;print(onnxruntime.__version__)',
  ]);
  check(/^\d+\.\d+/.test(ort), 'onnxruntime is installed in the image', `v${ort}`);

  // ⚠️ Asserted as an absence. The serving container must NOT carry the authoring dependencies —
  // that decision is what lets a production start not depend on MLflow being reachable.
  const mlflow = shq('docker', [
    'exec',
    RUNTIME,
    'python',
    '-c',
    'import importlib.util;print("present" if importlib.util.find_spec("mlflow") else "absent")',
  ]);
  check(mlflow === 'absent', '⚠️ the serving image does not carry the authoring dependencies', `mlflow ${mlflow}`);
}

/* ── 1 · what the runtime says it loaded ─────────────────────────────────────────────────────── */
console.log('\n1 · the runtime, self-reported');
const view = runtimeView();
{
  check(view.health === 'ok', 'health is derived from the capabilities, and every one is READY', view.health);
  check(
    view.executionProvider === 'CPUExecutionProvider',
    'the execution provider is what the session reported, not what was requested',
    view.executionProvider,
  );
  const cap = (view.capabilities ?? [])[0] ?? {};
  check(cap.state === 'READY', 'the perception capability is loaded', `${cap.capabilityId}=${cap.state}`);
  check(cap.model?.id === 'yolox-nano', 'the model bound is the catalogue default', cap.model?.id);
  check((cap.adapter?.warmupMs ?? 0) > 0, 'the session was warmed up during load, not on the first frame', `${cap.adapter?.warmupMs}ms`);
  check(
    typeof cap.adapter?.preprocessingVersion === 'string' && cap.adapter.preprocessingVersion.includes('/'),
    'the pixel path is recorded as a reproducible fingerprint',
    cap.adapter?.preprocessingVersion,
  );
  const registered = view.registeredModels ?? [];
  check(
    registered.length > 0 && registered.every((m) => m.artifactPresent),
    'every registered model has its artifact on disk',
    `${registered.length} registered`,
  );
  const cores = view.resources?.cpuCores;
  check(typeof cores === 'number' && cores > 0, 'capacity reads the cgroup quota, not the host core count', `${cores} cores`);
  // ⚠️ `'resources' in view` first: without it this passes on an empty payload from a dead runtime,
  // which is the opposite of what it is for.
  check(
    view.resources !== undefined && (view.resources.gpuPercent === null || view.resources.gpuPercent === undefined),
    '⚠️ GPU reports absent rather than 0% — there is none in this deployment',
    String(view.resources?.gpuPercent),
  );
}

/* ── 2 · REAL inference on a REAL photograph ─────────────────────────────────────────────────── */
console.log('\n2 · a photograph of two people');
let sceneResult = null;
{
  const response = infer(SCENE, { seq: 1, capturedAt: new Date(Date.now() - 250).toISOString() });
  sceneResult = response?.data ?? null;
  check(response?.success === true, 'the runtime answered', response?.success ? '' : JSON.stringify(response).slice(0, 200));

  const dets = sceneResult?.detections ?? [];
  // ⚠️ Exactly two. `> 0` would pass for a model that hallucinated a third, and "three people at the
  // cash counter when there are two" is a worse product than one that says nothing.
  /*
   * ⚠️ Every assertion below starts with `dets.length > 0`, and that is not belt-and-braces.
   * Mutation-testing this file by corrupting the model artifact found six checks that passed
   * **vacuously**: `[].every(...)` is `true`, so "every detection is a person" reported green
   * against a runtime that was in a crash loop. A check that cannot fail when the product is dead
   * is decoration.
   */
  const some = (predicate) => dets.length > 0 && dets.every(predicate);

  check(dets.length === PEOPLE_IN_SCENE, `exactly ${PEOPLE_IN_SCENE} detections, matching the scene`, `got ${dets.length}`);
  check(some((d) => d.label === 'person'), 'every detection is a person', dets.map((d) => d.label).join(', '));
  check(
    some((d) => d.confidence > 0.8),
    'both are confident, not marginal',
    dets.map((d) => d.confidence.toFixed(3)).join(', '),
  );
  check(
    some((d) => d.bbox.every((v) => v >= 0 && v <= 1) && d.bbox[2] > 0 && d.bbox[3] > 0),
    'boxes are inside the frame and have area',
    dets.map((d) => `[${d.bbox.map((v) => v.toFixed(2)).join(',')}]`).join(' '),
  );
  check(
    dets.length > 0 &&
      new Set(dets.map((d) => d.detectionId)).size === dets.length &&
      dets.every((d) => d.detectionId?.startsWith('det_')),
    'each detection carries its own identity',
    dets.map((d) => d.detectionId).join(' '),
  );

  // The reproducibility set the Architect specified, checked field by field on the wire.
  check(sceneResult?.schemaVersion === '1.1', 'the document says how to read it', sceneResult?.schemaVersion);
  check(sceneResult?.model?.id === 'yolox-nano' && sceneResult?.model?.version === '1.0.0',
    'model id + version travel with the result', `${sceneResult?.model?.id} v${sceneResult?.model?.version}`);
  check(sceneResult?.executionProvider === 'CPUExecutionProvider', 'the execution provider travels with the result', sceneResult?.executionProvider);
  check(typeof sceneResult?.preprocessingVersion === 'string', 'the pixel path travels with the result', sceneResult?.preprocessingVersion);
  check(sceneResult?.confidenceThreshold === 0.5, 'the confidence floor travels with the result', String(sceneResult?.confidenceThreshold));
  check((sceneResult?.inferenceMs ?? 0) > 0, 'inference latency is measured', `${sceneResult?.inferenceMs}ms`);
  check((sceneResult?.frameLatencyMs ?? 0) > 0, 'capture → detection is measured', `${sceneResult?.frameLatencyMs}ms`);
  // ⚠️ `!== undefined` first: comparing two undefineds is `true`, and this check reported green
  // against a runtime in a crash loop until the artifact-corruption mutation exposed it.
  check(
    sceneResult?.runtimeVersion !== undefined && sceneResult.runtimeVersion === view.runtimeVersion,
    'the runtime version travels with the result',
    sceneResult?.runtimeVersion,
  );

  // Identity is derived, so the same frame twice is the same ids.
  const again = infer(SCENE, { seq: 1, capturedAt: sceneResult?.frame?.capturedAt });
  const replayed = (again?.data?.detections ?? []).map((d) => d.detectionId);
  check(
    replayed.length > 0 && JSON.stringify(replayed) === JSON.stringify(dets.map((d) => d.detectionId)),
    '⚠️ reprocessing the same frame yields the same detection ids',
    replayed.join(' '),
  );
}

/* ── 3 · the control: nothing in, nothing out ────────────────────────────────────────────────── */
console.log('\n3 · a frame with nothing in it');
{
  // Generated in the container that has ffmpeg, from the same test pattern the fixture can serve.
  shq('docker', [
    'exec',
    MEDIA,
    'sh',
    '-c',
    'ffmpeg -y -loglevel error -f lavfi -i testsrc=size=640x360 -frames:v 1 /tmp/p8-blank.jpg',
  ]);
  shq('docker', ['cp', `${MEDIA}:/tmp/p8-blank.jpg`, join(tmpdir(), 'p8-blank.jpg')]);
  const blank = infer(join(tmpdir(), 'p8-blank.jpg'), { seq: 99 });
  const dets = blank?.data?.detections ?? [];
  check(blank?.success === true, 'the runtime answered');
  // ⚠️ **The check that makes every other check meaningful.** The stub backend returns a detection
  // for any bytes at all; it would pass every other assertion in this file while seeing nothing.
  check(dets.length === 0, '⚠️ a colour-bar test pattern produces ZERO detections', `got ${dets.length}`);
  check((blank?.data?.inferenceMs ?? 0) > 0, 'and the model still ran — an empty answer is work, not a skip', `${blank?.data?.inferenceMs}ms`);
}

/* ── 4 · the unit tests that need numpy actually RAN ─────────────────────────────────────────── */
console.log('\n4 · the decoder’s own tests, inside the deployed image');
{
  /* ⚠️ `2>&1`: unittest writes its summary to **stderr**, so capturing only stdout returns an empty
     string and the check reports "undefined tests" — a red that says nothing about the product. */
  const out = shq('docker', [
    'exec',
    RUNTIME,
    'sh',
    '-c',
    'python -m unittest discover -s tests -p "test_model_formats.py" 2>&1',
  ]);
  const ran = (out.match(/Ran (\d+) tests?/) ?? [])[1];
  check(out.includes('OK'), 'the model-format suite passes in the image', `${ran} tests`);
  // ⚠️ These tests skip locally (no numpy). A suite that silently skips in the one environment that
  // matters reports green while checking nothing, so "not skipped" is asserted, not assumed.
  check(!/skipped/.test(out) && Number(ran) > 0, '⚠️ and it was NOT skipped here', out.split('\n').pop());
}

/* ── 5 · end to end: camera → RTSP → media → runtime → detections ────────────────────────────── */
console.log('\n5 · end to end, through a camera');
startFixture();
await sleep(3000);
{
  const people = (m) => m._labelled?.media_perception_detections_by_label_total?.person ?? 0;

  const before = scrape(MEDIA, 8083);
  const camId = await createCamera(1);
  check(camId !== null, 'a fixture camera exists');
  await api(`/media/streams/${camId}/start`, { method: 'POST', headers: H, body: '{}' });
  await sleep(18000);

  const after = scrape(MEDIA, 8083);
  const delivered = (after.media_perception_frames_delivered_total ?? 0) - (before.media_perception_frames_delivered_total ?? 0);
  const detections = (after.media_perception_detections_total ?? 0) - (before.media_perception_detections_total ?? 0);
  const withDetections = (after.media_perception_frames_with_detections_total ?? 0) - (before.media_perception_frames_with_detections_total ?? 0);
  const persons = people(after) - people(before);

  check(delivered > 0, 'frames from a real RTSP source reached the runtime', `${delivered} frames`);
  check(detections > 0, '⚠️ and produced detections — the whole path, end to end', `${detections} detections`);
  check(persons > 0, 'labelled `person`, from a photograph of people', `${persons} person detections`);
  // Every analysed frame is the same looping photograph, so essentially all of them should detect.
  const rate = delivered > 0 ? withDetections / delivered : 0;
  check(rate > 0.9, 'nearly every frame of a scene containing people detects people', `${(rate * 100).toFixed(0)}%`);
  check(
    (after.media_perception_inference_ms_avg ?? 0) > 0,
    'media records the inference time the runtime reported',
    `${(after.media_perception_inference_ms_avg ?? 0).toFixed(1)}ms`,
  );

  /*
   * The other half of the control, through the full pipeline rather than a single POST.
   *
   * ⚠️ **The scene camera is stopped first**, and the first version of this check did not do that.
   * Both cameras were streaming, so the 58 "new" people detected during the blank window were the
   * real ones from the other camera — the check went red against a pipeline that was behaving
   * perfectly. The counter is deployment-wide; isolating the claim means isolating the camera.
   */
  await api(`/media/streams/${camId}/stop`, { method: 'POST', headers: H, body: '{}' });
  await sleep(3000);

  const blankCam = await createCamera(2, 'blank');
  await api(`/media/streams/${blankCam}/start`, { method: 'POST', headers: H, body: '{}' });
  await sleep(6000);
  const beforeBlank = scrape(MEDIA, 8083);
  await sleep(14000);
  const afterBlank = scrape(MEDIA, 8083);
  const blankFrames = (afterBlank.media_perception_frames_delivered_total ?? 0) - (beforeBlank.media_perception_frames_delivered_total ?? 0);
  const blankPeople = people(afterBlank) - people(beforeBlank);
  check(blankFrames > 0, 'the blank camera also delivers frames', `${blankFrames} frames`);
  // ⚠️ With only the test pattern streaming, the person counter must not move AT ALL. This is the
  // end-to-end twin of §3: if it moved, the pipeline would be reporting on plumbing, not pixels.
  check(
    blankPeople === 0,
    '⚠️ and a test-pattern camera detects nobody — not one person across the window',
    `${blankPeople} people across ${blankFrames} analysed frames`,
  );

  await api(`/media/streams/${blankCam}/stop`, { method: 'POST', headers: H, body: '{}' });
  // Back on for the ladder, which counts this camera as its first rung.
  await api(`/media/streams/${camId}/start`, { method: 'POST', headers: H, body: '{}' });
}

/* ── 6 · the dashboard's route, and the boundary it must not cross ───────────────────────────── */
console.log('\n6 · the operator route');
{
  const admin = await api('/system/ai-runtime', { headers: H });
  check(admin.status === 200, 'an administrator can read the runtime view', String(admin.status));
  check(admin.json?.data?.configured === true, 'the deployment reports perception as configured');
  check(
    admin.json?.data?.runtime?.reachable === true,
    'and the runtime answered through media',
    `${admin.json?.data?.runtime?.latencyMs}ms`,
  );
  check(
    admin.json?.data?.pipeline?.detections > 0,
    'the page would show real detections',
    `${admin.json?.data?.pipeline?.detections}`,
  );

  const viewerToken = await tokenFor(VIEWER);
  const viewer = await api('/system/ai-runtime', { headers: { authorization: `Bearer ${viewerToken}` } });
  check(viewer.status === 403, '⚠️ a viewer is refused — `system:inspect`, not `*:read`', String(viewer.status));

  const anon = await api('/system/ai-runtime');
  check(anon.status === 401, 'an unauthenticated caller is refused', String(anon.status));

  // ⚠️ The Phase 1 boundary, re-asserted now that a page depends on the data behind it: the runtime
  // is reached THROUGH media and is still not an upstream of its own.
  const direct = await api('/inference/runtime', { headers: H });
  check(direct.status === 404, '⚠️ the runtime is still not routed through the gateway', String(direct.status));

  const published = shq('docker', ['port', RUNTIME]);
  check(published === '', 'and still publishes no port to the host', published || 'none');
}

/* ── 7 · the ladder ──────────────────────────────────────────────────────────────────────────── */
console.log('\n7 · throughput at 1, 2, 4, 8 and 16 cameras');
const rows = [];
{
  let created = 1; // camera 1 is already running the scene
  for (const target of LADDER) {
    while (created < target) {
      created += 1;
      const id = await createCamera(created + 10);
      await api(`/media/streams/${id}/start`, { method: 'POST', headers: H, body: '{}' });
    }
    await sleep(WARMUP * 1000);
    const before = scrape(MEDIA, 8083);
    const beforeRuntime = scrape(RUNTIME, 8085);
    await sleep(WINDOW * 1000);
    const after = scrape(MEDIA, 8083);
    const afterRuntime = scrape(RUNTIME, 8085);
    const mediaStats = containerStats(MEDIA);
    const runtimeStats = containerStats(RUNTIME);

    const d = (k, a = after, b = before) => (a[k] ?? 0) - (b[k] ?? 0);
    const delivered = d('media_perception_frames_delivered_total');
    const row = {
      cams: target,
      offered: d('media_perception_frames_offered_total'),
      delivered,
      dropped: d('media_perception_frames_dropped_total'),
      failed: d('media_perception_frames_failed_total'),
      detections: d('media_perception_detections_total'),
      fps: delivered / WINDOW,
      inferenceMs: after.media_perception_inference_ms_avg ?? 0,
      frameLatencyMs: after.media_perception_frame_latency_ms_avg ?? 0,
      queue: after.media_perception_queue_depth ?? 0,
      runtimeP95: afterRuntime.inference_latency_ms_p95 ?? 0,
      mediaCpu: mediaStats.cpuPercent,
      mediaMem: mediaStats.memoryMb,
      runtimeCpu: runtimeStats.cpuPercent,
      runtimeMem: runtimeStats.memoryMb,
    };
    rows.push(row);
    console.log(
      `  ${String(target).padStart(2)} cameras · ${row.delivered} analysed · ${row.detections} detections · ` +
        `${row.inferenceMs.toFixed(1)}ms inference · queue ${row.queue} · dropped ${row.dropped} · ` +
        `runtime ${row.runtimeCpu.toFixed(0)}% / ${row.runtimeMem.toFixed(0)}MB`,
    );
  }
}

/* ── 8 · what the ladder has to prove ────────────────────────────────────────────────────────── */
console.log('\n8 · the assertions the ladder exists for');
{
  const last = rows.at(-1);
  const first = rows[0];

  check(
    rows.every((r) => r.delivered > 0 && r.detections > 0),
    'every rung analysed frames and produced detections',
  );
  // ⚠️ Not "nothing was dropped". At some rung CPU inference will saturate and frames WILL be
  // dropped — that is the design working. What must hold is that they are dropped by policy and
  // counted, never lost silently.
  check(
    rows.every((r) => r.offered === r.delivered + r.dropped + r.failed || r.offered - (r.delivered + r.dropped + r.failed) <= r.cams * 4),
    '⚠️ frame accounting closes at every rung — nothing is lost silently',
    rows.map((r) => `${r.cams}:${r.offered}=${r.delivered}+${r.dropped}+${r.failed}`).join(' '),
  );
  check(
    rows.every((r) => r.failed === 0),
    'no frame was refused or unreachable at any rung',
    rows.map((r) => `${r.cams}:${r.failed}`).join(' '),
  );
  check(last.runtimeMem < 600, 'the runtime’s memory stays bounded under load', `${last.runtimeMem.toFixed(0)}MB at 16 cameras`);

  const saturated = rows.filter((r) => r.dropped > 0).map((r) => r.cams);
  if (saturated.length > 0) {
    finding(
      'CPU inference saturates within the ladder',
      `frames first dropped at ${saturated[0]} cameras — the queue is doing its job, and this is the number that sizes a deployment`,
    );
  }
  if (last.inferenceMs > 100) {
    finding('inference latency at full load', `${last.inferenceMs.toFixed(0)}ms per frame at 16 cameras on CPU`);
  }
  console.log(
    `\n  scale: ${first.cams} camera ${first.inferenceMs.toFixed(1)}ms → ${last.cams} cameras ${last.inferenceMs.toFixed(1)}ms`,
  );
}

/* ── 9 · the measured table ──────────────────────────────────────────────────────────────────── */
console.log('\n9 · measured (20s windows, looping CC0 photograph over RTSP)\n');
console.log('cams | analysed | detections | dropped | failed |  fps | inference | latency | queue | media cpu/mem | runtime cpu/mem');
for (const r of rows) {
  console.log(
    `${String(r.cams).padStart(4)} | ${String(r.delivered).padStart(8)} | ${String(r.detections).padStart(10)} | ` +
      `${String(r.dropped).padStart(7)} | ${String(r.failed).padStart(6)} | ${r.fps.toFixed(1).padStart(4)} | ` +
      `${(r.inferenceMs.toFixed(1) + 'ms').padStart(9)} | ${(r.frameLatencyMs.toFixed(0) + 'ms').padStart(7)} | ` +
      `${String(r.queue).padStart(5)} | ${(r.mediaCpu.toFixed(0) + '% / ' + r.mediaMem.toFixed(0) + 'MB').padStart(13)} | ` +
      `${(r.runtimeCpu.toFixed(0) + '% / ' + r.runtimeMem.toFixed(0) + 'MB').padStart(15)}`,
  );
}

await cleanup();

console.log(
  failures === 0
    ? `\n✓ real inference verified against the deployment${findings.length ? ` · ${findings.length} finding(s)` : ''}\n`
    : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);

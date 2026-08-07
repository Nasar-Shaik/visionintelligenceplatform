/**
 * P-9 · **A5 — TD-29: H.265 has been probed and never decoded.**
 *
 *   node docs/review/p9/h265.mjs
 *
 * ### The gap this closes
 *
 * P-5.6 measured `canPlayType` across five engines and
 * [BROWSER_MATRIX](../p56/BROWSER_MATRIX.md) records the answers. That is a measurement of what
 * each engine **claims**. No HEVC file has ever been decoded by this product — which is exactly what
 * [TD-29](../../project/PHASE_8_ARCHITECTURE_REVIEW.md) says, and why `codecs.ts` carries a comment
 * that its verdicts are "the strongest claim the available data supports".
 *
 * ⭐ **So the question here is not "what does the browser say" — it is "is the browser telling the
 * truth".** A `probably` that does not decode would put an operator in front of a black rectangle
 * with no error, having been told the evidence was playable. A `''` that decodes fine would mean the
 * product refuses evidence it could have shown.
 *
 * ### Three fixtures, and the third is the one that matters
 *
 * | Fixture           | Why                                                                       |
 * | ----------------- | ------------------------------------------------------------------------- |
 * | `h264-avc1.mp4`   | The control. Every engine must decode it, or the harness is broken.       |
 * | `hevc-hvc1.mp4`   | HEVC with parameter sets in the sample description — what cameras write.  |
 * | `hevc-hev1.mp4`   | ⭐ HEVC in-band. Safari/WebKit answer `''` to the PROBE. Does it decode?  |
 *
 * ### Decoding is proved by pixels, not by events
 *
 * `readyState` and `loadedmetadata` prove the container was parsed. A frame is drawn to a canvas and
 * its pixels read back: `testsrc` is saturated colour bars, so a decoded frame and an undecoded one
 * are not close. ⚠️ An engine that fires `canplay` and paints nothing would pass any event-based
 * check, and that is precisely the failure mode an operator would report as "the video is broken".
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { check, exit, finding, guard, heading, ROOT } from './_p9.mjs';

const DIR = join(ROOT, 'infra/docker/fixtures/media/codec');
const FIXTURES = [
  { file: 'h264-avc1.mp4', codec: 'h264', entry: 'avc1', control: true },
  { file: 'hevc-hvc1.mp4', codec: 'h265', entry: 'hvc1', control: false },
  { file: 'hevc-hev1.mp4', codec: 'h265', entry: 'hev1', control: false },
];
/** The RFC 6381 strings `codecs.ts` actually hands the browser, so the comparison is like for like. */
const PROBE_STRINGS = {
  avc1: 'video/mp4; codecs="avc1.42E01E"',
  hvc1: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  hev1: 'video/mp4; codecs="hev1.1.6.L93.B0"',
};

heading('fixtures');
for (const f of FIXTURES) {
  check(existsSync(join(DIR, f.file)), `${f.file} exists`, `${f.entry} sample entry`);
}

/**
 * A local static server: the question is the decoder, and a signed URL or a proxy hop in the way
 * would make a failure ambiguous between transport and codec.
 *
 * ⛔ **Two harness defects lived here, and the H.264 control is what exposed both.** The first
 * version served whole files from `about:blank`, and every engine failed — including on H.264,
 * which all five demonstrably play:
 *
 *   - **Chromium, Chrome, Edge:** `MEDIA_ELEMENT_ERROR: Format error`. Chromium's media stack
 *     requires **range requests**; a 200-only server is not a source it will decode from.
 *   - **Firefox, WebKit:** `SecurityError` from `getImageData`. A video loaded cross-origin
 *     **taints the canvas**, so the pixels cannot be read back at all.
 *
 * ⚠️ Without the control both would have been reported as "no engine decodes HEVC" — a confident,
 * completely wrong conclusion, and one that matches the prior expectation closely enough that
 * nobody would have questioned it. The page is now served from this same origin and ranges are
 * honoured, which is also how the product actually serves evidence.
 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>P-9 A5</title><body></body>`;
const server = createServer((req, res) => {
  const name = (req.url ?? '/').slice(1).split('?')[0];
  if (name === '') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    return;
  }
  const path = join(DIR, name);
  if (!FIXTURES.some((f) => f.file === name) || !existsSync(path)) {
    res.writeHead(404).end('no');
    return;
  }
  const body = readFileSync(path);
  const range = req.headers.range;
  const common = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : body.length - 1;
    const slice = body.subarray(start, end + 1);
    res
      .writeHead(206, {
        ...common,
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': slice.length,
      })
      .end(slice);
    return;
  }
  res.writeHead(200, { ...common, 'content-length': body.length }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
console.log(`  ✓ serving fixtures on 127.0.0.1:${PORT}`);

/**
 * In-page: claim, then truth.
 * Returns `{ claim, decoded, width, height, error }` — `decoded` is a painted, non-uniform frame.
 */
const MEASURE = async ({ url, probeString }) => {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const claim = video.canPlayType(probeString);

  const outcome = await new Promise((resolve) => {
    const done = (r) => resolve(r);
    const timer = setTimeout(() => done({ ok: false, error: 'timed out after 12s' }), 12_000);
    video.addEventListener('error', () => {
      clearTimeout(timer);
      done({ ok: false, error: `media error ${video.error?.code ?? '?'}: ${video.error?.message ?? ''}` });
    });
    /* `canplay` alone is not enough — see the module note. Wait for a frame to be presentable. */
    video.addEventListener('loadeddata', () => {
      clearTimeout(timer);
      done({ ok: true });
    });
    video.src = url;
    video.load();
  });
  if (!outcome.ok) return { claim, decoded: false, error: outcome.error };

  /* Seek a little in, so the answer is not about the first keyframe alone. */
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 4000);
    video.addEventListener('seeked', () => { clearTimeout(t); resolve(); }, { once: true });
    video.currentTime = 2.0;
  });

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 320;
  canvas.height = video.videoHeight || 180;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let painted = false;
  let distinct = 0;
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    /* ⚠️ Not "is it non-black" — a decoder that fails can leave green or grey. Colour bars produce
       many distinct values; an undecoded surface produces one or two. */
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 97) {
      seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      if (seen.size > 24) break;
    }
    distinct = seen.size;
    painted = seen.size > 4;
  } catch (err) {
    return { claim, decoded: false, error: `canvas read failed: ${String(err)}` };
  }
  return {
    claim,
    decoded: painted,
    distinct,
    width: video.videoWidth,
    height: video.videoHeight,
  };
};

const ENGINES = [
  { id: 'chromium', launcher: chromium, options: {} },
  { id: 'chrome', launcher: chromium, options: { channel: 'chrome' } },
  { id: 'msedge', launcher: chromium, options: { channel: 'msedge' } },
  { id: 'firefox', launcher: firefox, options: {} },
  { id: 'webkit', launcher: webkit, options: {} },
];

const rows = [];
for (const engine of ENGINES) {
  heading(`engine: ${engine.id}`);
  let browser;
  try {
    browser = await engine.launcher.launch({ ...engine.options });
  } catch (err) {
    /* ⚠️ A finding, not a failure: a branded channel that is not installed is a gap in coverage, and
       recording it as a passing check would be worse than recording nothing. */
    finding(`${engine.id} could not be launched`, String(err).split('\n')[0].slice(0, 140));
    rows.push({ engine: engine.id, launched: false });
    continue;
  }
  const page = await browser.newPage();
  /* Same origin as the fixtures — a cross-origin video taints the canvas and the pixels cannot
     be read back at all (Firefox and WebKit both refuse with SecurityError). */
  await page.goto(`http://127.0.0.1:${PORT}/`);

  for (const f of FIXTURES) {
    const r = await page.evaluate(MEASURE, {
      url: `/${f.file}`,
      probeString: PROBE_STRINGS[f.entry],
    });
    const claim = r.claim === '' ? "''" : r.claim;
    console.log(
      `  ${f.entry.padEnd(5)} claim=${claim.padEnd(9)} decoded=${String(r.decoded).padEnd(5)}` +
        ` ${r.width ?? '?'}x${r.height ?? '?'}${r.error ? ` — ${r.error}` : ''}`,
    );
    rows.push({ engine: engine.id, launched: true, entry: f.entry, codec: f.codec, control: f.control, ...r });
  }
  await browser.close();
}

/* ── what the measurements mean ───────────────────────────────────────────────────────────────── */

heading('the control');
{
  const controls = rows.filter((r) => r.launched && r.control);
  check(
    guard(controls, controls.every((r) => r.decoded)),
    '⭐ every launched engine decodes H.264 — the harness is measuring something',
    controls.map((r) => `${r.engine}:${r.decoded}`).join(' '),
  );
}

heading('⭐ does `canPlayType` tell the truth about HEVC?');
{
  const hevc = rows.filter((r) => r.launched && r.codec === 'h265');
  check(guard(hevc, true), 'HEVC was measured on every launched engine', `${hevc.length} measurements`);

  const claimedYes = hevc.filter((r) => r.claim !== '');
  const claimedNo = hevc.filter((r) => r.claim === '');

  /* ⛔ The dangerous direction: told it plays, and it does not. An operator gets a black rectangle
     and no explanation, having been assured the evidence was fine. */
  const falsePositives = claimedYes.filter((r) => !r.decoded);
  check(
    falsePositives.length === 0,
    "⭐ no engine claims HEVC and then fails to decode it",
    falsePositives.map((r) => `${r.engine}/${r.entry}: ${r.error ?? 'no frame'}`).join(' · ') || 'none',
  );

  /* The wasteful direction: refuses evidence it could have shown. */
  const falseNegatives = claimedNo.filter((r) => r.decoded);
  if (falseNegatives.length > 0) {
    finding(
      `${falseNegatives.length} engine/entry pair(s) answer '' and decode anyway`,
      falseNegatives.map((r) => `${r.engine}/${r.entry}`).join(' · ') +
        " — the product refuses evidence these engines can show",
    );
  } else {
    check(true, "and no engine answers '' while decoding fine", 'the probe is not over-refusing');
  }

  check(
    guard(claimedYes, claimedYes.every((r) => r.decoded)),
    'every `probably` was honoured by an actual decode',
    `${claimedYes.length} claim yes`,
  );
}

heading('⭐ hvc1 vs hev1 — the split codecs.ts was built for');
{
  const byEntry = (entry) => rows.filter((r) => r.launched && r.entry === entry);
  for (const entry of ['hvc1', 'hev1']) {
    const list = byEntry(entry);
    console.log(
      `  ${entry}: ` + list.map((r) => `${r.engine}=${r.claim === '' ? "''" : r.claim}/${r.decoded ? 'dec' : 'no'}`).join('  '),
    );
  }
  const hvc1 = byEntry('hvc1');
  const hev1 = byEntry('hev1');
  check(
    guard(hvc1, true) && guard(hev1, true),
    'both sample entries were measured on every engine',
    `${hvc1.length} hvc1 · ${hev1.length} hev1`,
  );
  /* ⚠️ Reported, not asserted. Whether the two entries differ is a fact about browser builds today,
     not an invariant the platform gets to require — and `codecs.ts` already tries both and takes the
     best answer, which is correct whichever way this lands. */
  const differs = hvc1.filter((h) => {
    const other = hev1.find((e) => e.engine === h.engine);
    return other && (other.decoded !== h.decoded || other.claim !== h.claim);
  });
  finding(
    differs.length > 0
      ? `${differs.length} engine(s) treat hvc1 and hev1 differently`
      : 'no engine distinguishes hvc1 from hev1 today',
    differs.map((d) => d.engine).join(' · ') || 'the P-5.6 split did not reproduce here — see the report',
  );
}

heading('the measured table');
console.table(
  rows
    .filter((r) => r.launched)
    .map((r) => ({
      engine: r.engine,
      entry: r.entry,
      claim: r.claim === '' ? "''" : r.claim,
      decoded: r.decoded,
      size: r.width ? `${r.width}x${r.height}` : '—',
      error: r.error ?? '',
    })),
);

writeFileSync(
  join(ROOT, 'docs/review/p9/h265-decode.json'),
  `${JSON.stringify({ measuredAt: new Date().toISOString(), rows }, null, 2)}\n`,
);
console.log('  ✓ measurements written to docs/review/p9/h265-decode.json');

server.close();
exit('A5 H.265 decode');

/**
 * The validation video library — **the catalogue, separated from the generator** (P-8.5).
 *
 * ### ⚠️ Read this before writing a test against any of these
 *
 * Every clip here is **real person pixels on authored motion**: crops taken from a CC0 photograph at
 * the exact boxes the deployed model returns, composited onto a synthetic background along a
 * scripted path. That is a deliberate design, and it buys exactly one thing — **a known right
 * answer**. On real footage nobody knows the true number of people in frame 743, so nothing can be
 * asserted, only observed.
 *
 * ⛔ **It also costs something, and the cost is the entire point of [L-1].** A composited sprite has
 * no gait, no perspective change, no rolling shutter, no compression history and no lens. A clip
 * that degrades one of those (`night`, `rain`, `blur`, `shake`) degrades a *clean* frame in a way
 * that is plausible, not a real one in the way a real sensor does. So:
 *
 *   - these prove the **platform** handles the input — decode, provenance, tracking, rules, timeline;
 *   - they prove **nothing** about detector accuracy in a real venue.
 *
 * The six `procurement` entries at the bottom are the ones that would, and they are listed as
 * unmet requirements rather than quietly approximated. A synthetic "warehouse" clip would be the
 * most dangerous file in this repository: it would turn an open question into a green test.
 *
 * ### ⚠️ Ground truth is MEASURED, never declared
 *
 * `expect.people` below is the author's *intent*. The generator probes the deployed runtime and
 * writes what the model **actually** found into `manifest.json`, flagging every disagreement. Tests
 * read the manifest. An intent that the detector cannot see is a broken fixture, and it must fail
 * loudly at generation time rather than quietly inside somebody's tracking test six weeks later.
 */

/** Source frame geometry. CCTV-plausible, and what the tracking fixtures already use. */
export const W = 640;
export const H = 360;
export const FPS = 15;
/** Sprite height in the output frame — large enough for yolox-nano at 416×416 to be reliable. */
export const SPRITE_H = 190;
/** A background the detector must find nothing in — asserted by `--verify`, never assumed. */
export const BACKGROUND = '0x5a5f66';
/** Default clip length. Long enough for a 2 fps analysis to produce 60 frames of timeline. */
export const DURATION = 30;

/** Even dimensions, because H.264 requires them and the failure is a cryptic encoder error. */
export const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Sprite width once scaled to `h`, preserving the crop's aspect ratio. */
const widthAt = (sprite, h = SPRITE_H) => even((sprite.crop.w / sprite.crop.h) * h);

/** Floor line — sprites stand on it rather than floating. */
const floorY = (h = SPRITE_H) => H - h - 20;

/**
 * One `[bg][sprite]overlay` link in a filter_complex chain.
 *
 * ⚠️ `eval=frame` on every overlay whose `x` or `y` mentions `t`. Without it ffmpeg evaluates the
 * expression **once**, at filter-init, and the sprite sits perfectly still at its t=0 position — a
 * clip that looks correct in a thumbnail and contains no motion at all.
 */
const overlay = (x, y) => `overlay=x='${x}':y='${y}':eval=frame`;

/**
 * The scenarios that can be built with a known right answer.
 *
 * `probeAt` is where `--verify` samples the clip. ⚠️ Per-scenario and not simply the midpoint: for
 * the occlusion clip the midpoint is the exact moment the subject is *correctly* hidden, so a
 * working fixture would report "model found 0" and look broken.
 */
export function authored(sprites) {
  const [a, b] = sprites;
  const wA = widthAt(a);
  const wB = widthAt(b);

  /** A crowd/queue member: a sprite at an arbitrary scale, standing on the floor line. */
  const person = (sprite, index, h, x) => ({
    input: sprite.path,
    h,
    x,
    y: floorY(h),
    index,
  });

  /**
   * Build the filter for a static group of people (queue, crowd, counter, empty-adjacent scenes).
   * Each member is scaled then overlaid in turn; the chain is linear because ffmpeg needs a single
   * thread of `[in][ov]filter[out]` links.
   */
  const group = (members, post = '') => {
    const scales = members
      .map((m, i) => `[${i + 1}:v]scale=-2:${m.h}[p${i}]`)
      .join(';');
    let chain = '[0:v]';
    const links = members
      .map((m, i) => {
        const out = `[s${i}]`;
        const link = `${chain}[p${i}]${overlay(m.x, m.y)}${out}`;
        chain = out;
        return link;
      })
      .join(';');
    /* ⚠️ The last link must NOT be labelled when there is no post-filter — an unconsumed output
     * label makes ffmpeg fail with "Output with label 'sN' does not exist in any defined filter". */
    const tail = post === '' ? '' : `;${chain}${post}`;
    const body = `${scales};${links}${tail}`;
    return post === ''
      ? body.replace(/\[s(\d+)\]$/, '')
      : body;
  };

  return [
    /* ─────────────────────────  motion and identity  ───────────────────────── */
    {
      id: 'single-person-walking',
      title: 'One person crosses the frame, continuously visible',
      category: 'motion',
      duration: DURATION,
      probeAt: 15,
      expect: {
        people: 1,
        identities: 1,
        note: 'A single object visible in every frame must hold exactly one track id for the whole clip.',
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]${overlay(`-${wA}+(${W + wA * 2})*(t/${DURATION})`, floorY())}`,
    },
    {
      id: 'multiple-people',
      title: 'Two people cross in opposite directions at different depths',
      category: 'motion',
      duration: DURATION,
      /*
       * ⛔ **Probed at t=5, not at the midpoint — and the reason is a defect this catalogue already
       * shipped once.** The two walk toward each other over 30 s, so at t=15 they are at the *same*
       * x by construction: one sprite sits exactly on top of the other and the model correctly
       * reports ONE person. The generator flagged `authored 2, model found 1` and the fixture looked
       * broken when it was the probe point that was wrong. The midpoint of a crossing scenario is
       * the one moment you must not sample.
       */
      probeAt: 5,
      expect: {
        people: 2,
        identities: 2,
        /*
         * ⚠️ Different heights, and that is what makes the no-swap assertion possible. After they
         * cross, "left" and "right" have exchanged, so position alone cannot distinguish a correct
         * tracker from one that swapped the identities. Height does not swap.
         */
        note: 'Each identity keeps its own row. A swap shows as a track that changes height. They coincide at t=15 — sample either side of it.',
      },
      inputs: [a.path, b.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[pa];[2:v]scale=-2:${SPRITE_H - 40}[pb];` +
        `[0:v][pa]${overlay(`${Math.round(W * 0.05)}+${Math.round(W * 0.7)}*(t/${DURATION})`, floorY())}[t1];` +
        `[t1][pb]${overlay(`${Math.round(W * 0.75)}-${Math.round(W * 0.7)}*(t/${DURATION})`, floorY(SPRITE_H - 40) - 55)}`,
    },
    {
      id: 'fast-movement',
      title: 'One person traverses the frame every four seconds',
      category: 'motion',
      duration: DURATION,
      probeAt: 2,
      expect: {
        people: 1,
        /*
         * ⚠️ At 2 fps analysis a 4-second traverse moves the subject ~320 px between consecutive
         * analysed frames — further than its own width. This is the scenario that decides whether
         * association is predictive or merely nearest-neighbour, and a tracker that fragments here
         * is behaving correctly for its configuration, not necessarily wrongly.
         */
        note: 'Displacement between analysed frames exceeds the subject width. Fragmentation here is expected and must be REPORTED, not asserted away.',
        expectFragmentation: true,
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]${overlay(`-${wA}+(${W + wA * 2})*(mod(t,4)/4)`, floorY())}`,
    },
    {
      id: 'occlusion',
      title: 'One person walks behind a pillar and out the other side',
      category: 'motion',
      duration: DURATION,
      probeAt: 4,
      expect: {
        people: 1,
        identities: 1,
        note: 'The identity must survive the gap. A new id here is the defect predictive association exists to prevent.',
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]${overlay(`min(-${wA}+(${W + wA * 2})*(t/22), ${W + wA * 2})`, floorY())}[o];` +
        /* ⚠️ The pillar is drawn AFTER the overlay so it genuinely hides the person. Underneath, it
         * would occlude nothing and the test would pass for the wrong reason. */
        `[o]drawbox=x=${Math.round(W * 0.44)}:y=0:w=${Math.round(W * 0.2)}:h=${H}:color=0x2b2f36:t=fill`,
    },
    {
      id: 'partial-visibility',
      title: 'One person stands half outside the frame edge',
      category: 'motion',
      duration: DURATION,
      probeAt: 15,
      expect: {
        people: 1,
        /* ⚠️ Genuinely uncertain. A half-visible torso is exactly the input a detector may or may
         * not fire on, so the MEASURED value is the truth and the intent is only a starting guess. */
        uncertain: true,
        note: 'Half the subject is outside the frame. Whether the model fires is a property of the model — the manifest records what it did, and the test asserts the platform handled it either way.',
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]${overlay(`-${Math.round(wA / 2)}`, floorY())}`,
    },

    /* ─────────────────────────  retail / rule scenarios  ───────────────────────── */
    {
      id: 'retail-loitering',
      title: 'One person enters, stops in the middle, and stays',
      category: 'rules',
      duration: 60,
      probeAt: 30,
      expect: {
        people: 1,
        identities: 1,
        dwellSeconds: 45,
        note: 'Arrives by t=8s and never leaves. A loitering rule with a 20s threshold must fire exactly once, not once per frame.',
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]${overlay(`min(-${wA}+(${W / 2 + wA})*(t/8), ${Math.round(W * 0.42)})`, floorY())}`,
    },
    {
      id: 'restricted-zone',
      title: 'One person walks through a marked restricted area',
      category: 'rules',
      duration: DURATION,
      probeAt: 15,
      expect: {
        people: 1,
        identities: 1,
        /* The drawn rectangle is cosmetic — the zone that matters is configured on the camera. This
         * exists so a screenshot shows the operator what the rule is about. */
        zone: { x: 0.55, y: 0.35, w: 0.4, h: 0.6 },
        note: 'The subject is outside the marked area before t=12s and inside it after. An entry event must fire once, on the transition.',
      },
      inputs: [a.path],
      filter:
        `[0:v]drawbox=x=${Math.round(W * 0.55)}:y=${Math.round(H * 0.35)}:w=${Math.round(W * 0.4)}:h=${Math.round(H * 0.6)}:color=0xb04030@0.45:t=fill[z];` +
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[z][p]${overlay(`-${wA}+(${W + wA})*(t/${DURATION})`, floorY())}`,
    },
    {
      id: 'counter-monitoring',
      title: 'A served counter — one person behind, one arriving in front',
      category: 'rules',
      duration: DURATION,
      probeAt: 20,
      expect: {
        people: 2,
        identities: 2,
        note: 'A stationary staff member plus an arriving customer. Distinguishes "someone is present" from "someone approached".',
      },
      inputs: [a.path, b.path],
      filter:
        `[0:v]drawbox=x=0:y=${Math.round(H * 0.62)}:w=${W}:h=${Math.round(H * 0.12)}:color=0x3b4048:t=fill[c];` +
        `[1:v]scale=-2:${SPRITE_H - 30}[pa];[2:v]scale=-2:${SPRITE_H}[pb];` +
        `[c][pa]${overlay(Math.round(W * 0.18), floorY(SPRITE_H - 30) - 40)}[t1];` +
        `[t1][pb]${overlay(`min(${W} - (${W - Math.round(W * 0.55)})*(t/12), ${Math.round(W * 0.55)})`, floorY())}`,
    },
    {
      id: 'queue-formation',
      title: 'Four people standing in a line at a service point',
      category: 'rules',
      duration: DURATION,
      probeAt: 15,
      expect: {
        people: 4,
        note: 'A queue is a count plus a persistence. Four subjects at receding scales, all stationary for the whole clip.',
      },
      inputs: [a.path, b.path, a.path, b.path],
      filter: group([
        person(a, 0, 170, Math.round(W * 0.12)),
        person(b, 1, 150, Math.round(W
* 0.3)),
        person(a, 2, 132, Math.round(W * 0.46)),
        person(b, 3, 116, Math.round(W * 0.6)),
      ]),
    },
    {
      id: 'crowd',
      title: 'Eight people at mixed depths, partially overlapping',
      category: 'rules',
      duration: DURATION,
      probeAt: 15,
      expect: {
        people: 8,
        /* ⚠️ Eight is the intent; small overlapping sprites are exactly where NMS suppresses a real
         * detection. The measured value is the truth and the gap is a REPORTED finding about the
         * model's crowd behaviour, not a fixture bug. */
        uncertain: true,
        note: 'Overlapping subjects at small scale. The gap between intent and measurement IS the crowd finding.',
      },
      inputs: [a.path, b.path, a.path, b.path, a.path, b.path, a.path, b.path],
      filter: group([
        person(a, 0, 175, Math.round(W * 0.02)),
        person(b, 1, 160, Math.round(W * 0.16)),
        person(a, 2, 148, Math.round(W * 0.29)),
        person(b, 3, 138, Math.round(W * 0.42)),
        person(a, 4, 128, Math.round(W * 0.54)),
        person(b, 5, 120, Math.round(W * 0.65)),
        person(a, 6, 112, Math.round(W * 0.75)),
        person(b, 7, 104, Math.round(W * 0.85)),
      ]),
    },
    {
      id: 'empty-scene',
      title: 'Nobody is there',
      category: 'rules',
      duration: DURATION,
      probeAt: 15,
      expect: {
        people: 0,
        /*
         * ⭐ **The most important clip in the library.** Every other scenario asserts the platform
         * finds something; only this one asserts it does not invent. A model that hallucinated a
         * person would pass every other fixture here and fail exactly one — and a customer's first
         * false alarm on an empty shop is the fastest way to lose their trust in the product.
         */
        note: 'Zero detections, zero tracks, zero events, and a timeline that says so rather than rendering blank.',
      },
      inputs: [],
      filter: `[0:v]drawbox=x=${Math.round(W * 0.55)}:y=${Math.round(H * 0.35)}:w=${Math.round(W * 0.4)}:h=${Math.round(H * 0.6)}:color=0xb04030@0.45:t=fill`,
    },

    /* ─────────────────────────  degraded capture  ───────────────────────── */
    /*
     * ⚠️ These degrade a CLEAN synthetic frame. A real sensor degrades differently — real low light
     * brings sensor-specific chroma noise and a slower shutter that smears moving subjects together;
     * real rain occludes in coherent streaks the compressor then mangles. What these prove is that
     * the PLATFORM survives poor input and reports honestly. What they cannot prove is detector
     * accuracy under those conditions, which is [L-1] and P-9's job.
     */
    {
      id: 'lighting-changes',
      title: 'One person walking while the scene brightness swings',
      category: 'degraded',
      duration: DURATION,
      probeAt: 15,
      expect: {
        people: 1,
        uncertain: true,
        note: 'Brightness ramps ±0.35 over a 10s cycle. Confidence is expected to move with it; the manifest records the spread.',
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]${overlay(`-${wA}+(${W + wA * 2})*(t/${DURATION})`, floorY())}[o];` +
        `[o]eq=brightness='0.35*sin(2*PI*t/10)':contrast='1+0.2*sin(2*PI*t/10)':eval=frame`,
    },
    {
      id: 'night-footage',
      title: 'One person walking in low light with sensor noise',
      category: 'degraded',
      duration: DURATION,
      probeAt: 15,
      expect: {
        people: 1,
        uncertain: true,
        note: 'Gamma-crushed to ~25% luminance plus temporal noise. A detector that finds nothing here is a REPORTED limitation, not a fixture defect.',
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]${overlay(`-${wA}+(${W + wA * 2})*(t/${DURATION})`, floorY())}[o];` +
        `[o]curves=all='0/0 0.5/0.18 1/0.55',noise=alls=14:allf=t+u`,
    },
    {
      id: 'rain',
      title: 'One person walking through rain-like degradation',
      category: 'degraded',
      duration: DURATION,
      probeAt: 15,
      expect: {
        people: 1,
        uncertain: true,
        /* ⚠️ Named honestly. This is heavy temporal noise plus contrast loss and a light blur — the
         * things rain does to an ENCODED frame. It is not water. */
        note: 'Temporal noise + contrast loss + light blur: what rain does to an encoded frame, not what rain is.',
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]${overlay(`-${wA}+(${W + wA * 2})*(t/${DURATION})`, floorY())}[o];` +
        `[o]noise=alls=26:allf=t,eq=contrast=0.82:brightness=0.04,gblur=sigma=0.8`,
    },
    {
      id: 'blur',
      title: 'One person walking, the lens out of focus',
      category: 'degraded',
      duration: DURATION,
      probeAt: 15,
      expect: {
        people: 1,
        uncertain: true,
        note: 'Gaussian sigma 3.5 — a badly focused or dirty dome, which is the single most common real-world camera fault.',
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]${overlay(`-${wA}+(${W + wA * 2})*(t/${DURATION})`, floorY())}[o];` +
        `[o]gblur=sigma=3.5`,
    },
    {
      id: 'camera-shake',
      title: 'One person walking while the camera vibrates',
      category: 'degraded',
      duration: DURATION,
      probeAt: 15,
      expect: {
        people: 1,
        uncertain: true,
        /* ⚠️ Shake moves the WORLD, not the subject — so a tracker keyed to absolute position sees
         * every static object jitter. This is the fixture that catches association tuned too tight. */
        note: 'The whole frame translates ±10px. Static geometry moves, which is what a pole-mounted camera in wind actually does to a tracker.',
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]${overlay(`-${wA}+(${W + wA * 2})*(t/${DURATION})`, floorY())}[o];` +
        /* ⚠️ No `eval=frame` here, unlike `overlay`. `crop` re-evaluates its expressions every frame
         * by default and rejects the option outright — ffmpeg 8 fails with "Option not found",
         * which reads like a version problem and is actually a filter that never needed telling. */
        `[o]crop=${W - 24}:${H - 24}:x='12+10*sin(2*PI*t*3.1)':y='12+8*cos(2*PI*t*4.7)',scale=${W}:${H}`,
    },

    /* ─────────────────────────  capture rate and length  ───────────────────────── */
    {
      id: 'low-fps',
      title: 'One person walking, recorded at 1 fps',
      category: 'capture',
      duration: DURATION,
      fps: 1,
      probeAt: 15,
      expect: {
        people: 1,
        /*
         * ⭐ **The clip that tests the three clocks.** At 1 fps source and 2 fps requested analysis,
         * the platform is asked for more frames than exist. What must NOT happen is a silently
         * invented timestamp: `ptsSeconds` is MEASURED and may be null, `mediaOffsetSeconds` is
         * DERIVED and never is. ADR-0039 lives or dies here.
         */
        note: 'Source rate is BELOW the requested analysis rate. Provenance must stay honest rather than interpolating frames that do not exist.',
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]${overlay(`-${wA}+(${W + wA * 2})*(t/${DURATION})`, floorY())}`,
    },
    {
      id: 'high-fps',
      title: 'One person walking, recorded at 30 fps',
      category: 'capture',
      duration: DURATION,
      fps: 30,
      probeAt: 15,
      expect: {
        people: 1,
        note: 'Source rate far ABOVE the analysis rate. The decoder must decimate to exactly the requested rate — an off-by-one here doubles every customer bill.',
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]${overlay(`-${wA}+(${W + wA * 2})*(t/${DURATION})`, floorY())}`,
    },
    {
      id: 'long-recording',
      title: 'Five minutes of intermittent activity',
      category: 'capture',
      duration: 300,
      probeAt: 20,
      expect: {
        people: 1,
        /* ⚠️ Five minutes at 2 fps is 600 analysed frames — enough to cross the chunk boundary the
         * decoder uses, which is where a seek-arithmetic error shows up as a duplicated or skipped
         * second. A 30-second clip never reaches it. */
        note: 'Long enough to cross a decode chunk boundary and to make the timeline bucket rather than list.',
        crossesChunkBoundary: true,
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        /* Walks a lap every 60s: present, gone, present — so the timeline has real gaps in it. */
        `[0:v][p]${overlay(`-${wA}+(${W + wA * 2})*(mod(t,60)/45)`, floorY())}`,
    },
  ];
}

/**
 * **Transport variants** — the same scene, re-encoded along one axis at a time.
 *
 * ⚠️ Deliberately one axis at a time. A fixture that changed resolution *and* codec together would,
 * on failure, tell you only that something about it was unsupported. These exist to answer
 * "which one?" — so `res-1080p` differs from `res-360p` in exactly one property.
 *
 * The scene is `single-person-walking`, already measured, so any difference in the result is caused
 * by the transport rather than by the content.
 */
export const variants = [
  /* ── resolution ──  ⚠️ The model letterboxes to 416×416 regardless, so this measures the DECODE
   * and provenance path, not accuracy. A 1080p source that reports 640×360 provenance is the bug. */
  { id: 'res-180p', axis: 'resolution', title: '320×180 — below the model input', scale: '320:180', expectPeople: 1, uncertain: true },
  { id: 'res-360p', axis: 'resolution', title: '640×360 — the baseline', scale: '640:360', expectPeople: 1 },
  { id: 'res-720p', axis: 'resolution', title: '1280×720 — common IP camera', scale: '1280:720', expectPeople: 1 },
  { id: 'res-1080p', axis: 'resolution', title: '1920×1080 — full HD', scale: '1920:1080', expectPeople: 1 },

  /* ── codec ──  ⚠️ `hev1` vs `hvc1` is not pedantry: TD-29 is open precisely because WebKit
   * refuses `hev1` in MSE while Chromium accepts it. Both tags must exist or the browser-playback
   * regression cannot be written. */
  { id: 'codec-h264', axis: 'codec', title: 'H.264 / avc1 — the universal baseline', codec: ['libx264'], tag: 'avc1', expectPeople: 1 },
  { id: 'codec-h265-hvc1', axis: 'codec', title: 'H.265 / hvc1 — plays in Safari', codec: ['libx265'], tag: 'hvc1', expectPeople: 1 },
  { id: 'codec-h265-hev1', axis: 'codec', title: 'H.265 / hev1 — ⛔ TD-29, refused by WebKit MSE', codec: ['libx265'], tag: 'hev1', expectPeople: 1 },
  { id: 'codec-mpeg4', axis: 'codec', title: 'MPEG-4 Part 2 — a legacy DVR export', codec: ['mpeg4'], tag: 'mp4v', expectPeople: 1, uncertain: true },

  /* ── camera angle ──  ⚠️ Approximated by geometry, and that limit is real: a true overhead camera
   * sees the top of a head, which is a different OBJECT to a detector than a foreshortened
   * full-length figure. This measures the platform's handling, not overhead accuracy. */
  { id: 'angle-eye-level', axis: 'angle', title: 'Eye level — the baseline framing', vf: null, expectPeople: 1 },
  { id: 'angle-high', axis: 'angle', title: 'High angle — perspective-compressed', vf: 'perspective=x0=0:y0=40:x1=640:y1=0:x2=-60:y2=360:x3=700:y3=360:sense=destination', expectPeople: 1, uncertain: true },
  { id: 'angle-overhead', axis: 'angle', title: '⚠️ Steep down-angle, NOT true overhead', vf: 'perspective=x0=-120:y0=0:x1=760:y1=0:x2=90:y2=360:x3=550:y3=360:sense=destination', expectPeople: 1, uncertain: true },
  { id: 'angle-wide', axis: 'angle', title: 'Wide angle with barrel distortion', vf: 'lenscorrection=k1=-0.28:k2=-0.05', expectPeople: 1, uncertain: true },
];

/**
 * **Corrupted and hostile inputs.** Built by damaging a known-good clip in one specific way.
 *
 * ⛔ **These have no expected detections — they have an expected REFUSAL.** Every entry below is a
 * file a customer will eventually upload, and for each one the only acceptable outcomes are a clear
 * rejection or a completed analysis. What must never happen is the third thing: a session that sits
 * in `running` forever, or one that reports `succeeded` having analysed nothing.
 *
 * `expectState` is asserted against the session's terminal state; `mustNotHang` means the platform
 * must reach a terminal state at all.
 */
export const corrupt = [
  {
    id: 'corrupt-zero-bytes',
    title: 'A zero-byte file with a .mp4 name',
    build: 'truncate to 0',
    expect: 'rejected at probe — there is no container to read',
    stage: 'upload-confirm',
  },
  {
    id: 'corrupt-truncated-header',
    title: 'The first 200 bytes only — a stalled upload',
    build: 'head -c 200',
    expect: 'rejected at probe — moov atom absent',
    stage: 'upload-confirm',
  },
  {
    id: 'corrupt-truncated-tail',
    title: 'The last 40% cut off — a DVR that lost power mid-write',
    build: 'head -c 60%',
    /* ⚠️ The interesting one. The header is intact so `ffprobe` reports the ORIGINAL duration, and
     * the decoder then runs off the end of a file that ends early. The session must terminate
     * honestly — either short-but-succeeded with the real frame count, or failed with a reason. A
     * run that reports the probed duration's worth of frames it never decoded is a fabrication. */
    expect: 'probe succeeds and MISREPORTS duration; the decode must end honestly, not invent frames',
    stage: 'analysis',
  },
  {
    id: 'corrupt-not-a-video',
    title: 'A text file renamed to .mp4',
    build: 'ascii payload',
    expect: 'rejected at probe — no stream of any kind',
    stage: 'upload-confirm',
  },
  {
    id: 'corrupt-audio-only',
    title: 'A valid MP4 containing only an audio track',
    build: 'aac, no video stream',
    /* ⚠️ The container is legitimate and `ffprobe` succeeds — so a probe that checks only "did
     * ffprobe exit 0" accepts this and the decoder produces zero frames forever. */
    expect: 'rejected — a valid container is not a video',
    stage: 'upload-confirm',
  },
  {
    id: 'corrupt-bitflips',
    title: 'Valid header, 64 random bytes flipped mid-stream',
    build: 'dd random over payload',
    expect: 'decodes with visible artefacts OR fails with a reason — never silently produces nothing',
    stage: 'analysis',
  },
];

/**
 * The clips that **cannot** be built here, and must be procured before the claims that depend on
 * them can be made.
 *
 * ⛔ Each of these is listed precisely because approximating it would be worse than not having it.
 * A generated "hospital corridor" is a grey rectangle with a sprite in it; the moment it is checked
 * in, a test asserts the platform works in hospitals, and it does not.
 */
export const procurement = [
  {
    id: 'real-shop',
    title: 'Real retail shop floor, fixed overhead camera',
    needs: 'Detector accuracy on real subjects at real scale; reflections from glass and polished floor.',
    blocks: 'Any claim about retail detection accuracy, and the loitering false-positive rate.',
    duration: '10 min, business hours',
    consent: 'Signed footage-use agreement from the store; faces blurred or a private fixture repo.',
  },
  {
    id: 'mall-concourse',
    title: 'Shopping-centre concourse, wide angle, heavy footfall',
    needs: 'Genuine crowd density and mutual occlusion — the thing the `crowd` fixture only gestures at.',
    blocks: 'Crowd counting accuracy; the NMS suppression question the crowd fixture raises.',
    duration: '10 min, peak',
    consent: 'Centre management agreement; public-space signage.',
  },
  {
    id: 'warehouse',
    title: 'Warehouse aisle with forklift and pedestrian traffic',
    needs: 'Vehicle/person discrimination and high-ceiling perspective.',
    blocks: 'Any safety claim about pedestrian–vehicle separation.',
    duration: '15 min, shift hours',
    consent: 'Site operator agreement; union/works-council notice where required.',
  },
  {
    id: 'hospital-corridor',
    title: 'Hospital corridor, mixed staff and public',
    needs: 'Uniform-heavy scenes, trolleys, and long thin geometry with strong perspective.',
    blocks: 'Healthcare deployment claims.',
    duration: '10 min',
    consent: '⛔ Highest bar in this table — patient privacy. Likely requires a synthetic re-enactment on a real ward instead of live footage.',
  },
  {
    id: 'factory-floor',
    title: 'Production line, fixed camera, machinery in motion',
    needs: 'Persistent non-human motion — the single largest false-positive source in industrial installs.',
    blocks: 'Industrial deployment claims; the moving-machinery false-positive rate.',
    duration: '15 min',
    consent: 'Site operator agreement.',
  },
  {
    id: 'parking-area',
    title: 'Outdoor car park, day→dusk transition',
    needs: 'Real low-light transition, headlights, and weather — the honest version of `night-footage` and `rain`.',
    blocks: 'Outdoor/overnight claims; everything the `night-footage` and `rain` fixtures approximate.',
    duration: '30 min spanning dusk',
    consent: 'Site operator agreement; ANPR rules may apply in some jurisdictions.',
  },
];

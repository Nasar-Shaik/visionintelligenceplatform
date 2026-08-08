/**
 * The live-capture validation matrix (P-9).
 *
 * ### ⭐ Why these are files fed through a real `getUserMedia`, and not a human in front of a laptop
 *
 * Chrome's `--use-file-for-fake-video-capture` replaces the **camera device**, not the capture API.
 * The page still calls `navigator.mediaDevices.getUserMedia`, still receives a `MediaStream`, still
 * decodes into a `<video>`, still draws to a canvas, still encodes JPEG and still uploads — every
 * line of the browser capture path executes exactly as it does with a real webcam. What changes is
 * only where the photons came from.
 *
 * That buys three things a person standing in a room cannot:
 *
 *   - **Ground truth.** Each clip's manifest records how many people are in it. "The detector found
 *     two" is only a result if something independent says there were two.
 *   - **Repeatability.** The same scenario runs identically next month, against a different model,
 *     and the two numbers can be compared. A human walks differently every time.
 *   - **Scenarios a person cannot stage.** Eight people, overhead CCTV framing, 1 fps capture.
 *
 * ### ⛔ What this therefore does NOT validate, stated before any result is read
 *
 * The **optics** are not a webcam's. These clips are authored: real photographed people composited
 * over backgrounds, encoded by ffmpeg. A real webcam adds sensor noise, rolling-shutter skew,
 * auto-exposure hunting, auto-white-balance drift and compression artefacts of its own — none of
 * which is present here. Anything this matrix says about **detector accuracy under real webcam
 * optics** is unsupported; what it says about **the pipeline** — that frames flow, that tracks form
 * and persist, that rules fire, that incidents are raised, and how long each takes — is supported,
 * because those are properties of the platform rather than of the photons.
 *
 * The `webcam-live` scenario exists precisely to close that gap for one case: it is run against the
 * real device by a human, following `MANUAL_TEST_GUIDE.md`, and is marked `manual: true` here so a
 * matrix run reports it as **not executed** rather than silently omitting it.
 */

/**
 * Derived clips this matrix needs and the fixture library does not ship.
 *
 * ⚠️ **These are filter transforms, not footage.** `eq=brightness=-0.28` darkens an image; it does
 * not reproduce a dark room. A real low-light frame carries sensor noise that rises as gain rises,
 * motion blur from a longer exposure, and a colour cast from the white balance giving up — a gamma
 * curve reproduces none of them. So a `low-light` result here means "the detector still works when
 * the *pixels* are dark", which is a weaker and different claim than "the detector works at night",
 * and the report says so wherever one of these appears.
 *
 * `night-footage.mp4` in the fixture library is authored for darkness rather than filtered, so it is
 * used as well — the two disagreeing would itself be the finding.
 */
export const DERIVED = [
  {
    id: 'light-bright',
    from: 'single-person-walking.mp4',
    filter: 'eq=brightness=0.22:contrast=0.92',
    note: 'Bright room — overexposed, flattened contrast.',
  },
  {
    id: 'light-office',
    from: 'single-person-walking.mp4',
    filter: 'eq=brightness=0.04:contrast=1.02:saturation=0.95',
    note: 'Office lighting — the near-neutral control for the lighting group.',
  },
  {
    id: 'light-low',
    from: 'single-person-walking.mp4',
    filter: 'eq=brightness=-0.28:contrast=1.15,noise=alls=12:allf=t',
    note: 'Low light — darkened AND noised, because gain noise is what actually costs the detector.',
  },
  {
    id: 'light-backlight',
    from: 'single-person-walking.mp4',
    filter: 'eq=brightness=-0.18:contrast=1.6:gamma=0.7',
    note: 'Backlight — subject crushed toward silhouette against a blown background.',
  },
  {
    id: 'light-glare',
    from: 'single-person-walking.mp4',
    filter: "eq=brightness=0.05,drawbox=x=iw*0.55:y=0:w=iw*0.3:h=ih*0.5:color=white@0.55:t=fill",
    note: 'Monitor glare — a fixed blown rectangle over part of the frame.',
  },
  {
    id: 'light-side',
    from: 'single-person-walking.mp4',
    filter: 'eq=brightness=-0.10:contrast=1.25,vignette=angle=PI/3.5',
    note: 'Side lighting — one side of the frame falls away.',
  },
  {
    id: 'move-pan',
    from: 'single-person-walking.mp4',
    filter: "crop=iw*0.8:ih*0.8:(iw*0.2)*(0.5+0.5*sin(t/3)):(ih*0.2)*0.5,scale=640:360",
    note: 'Moving laptop — a slow continuous pan.',
  },
  {
    id: 'move-shake',
    from: 'single-person-walking.mp4',
    filter:
      "crop=iw*0.9:ih*0.9:(iw*0.1)*(0.5+0.5*sin(t*23)):(ih*0.1)*(0.5+0.5*sin(t*31)),scale=640:360",
    note: 'Shaking laptop — high-frequency jitter in both axes.',
  },
  {
    id: 'move-rotate',
    from: 'single-person-walking.mp4',
    filter: "rotate=0.25*sin(t/2):fillcolor=black,scale=640:360",
    note: 'Rotating webcam — the horizon tilts through ±14°.',
  },
  {
    id: 'orient-portrait',
    /*
     * ⛔ **This was `transpose=1` and it produced a completely invalid test.**
     *
     * Rotating a landscape clip by 90° makes the frame portrait — and lays every **person** on their
     * side. Measured: the same footage that yields 59 detections in 59 frames upright yielded
     * **0 detections in 70 frames** rotated. That is a true statement about a detector shown people
     * lying down, and it is not what "portrait orientation" means: a corridor-mounted CCTV camera in
     * portrait sees people **upright** in a tall frame.
     *
     * Reporting the rotated result would have been a serious false claim — "the platform fails in
     * portrait" — caused entirely by the fixture. Cropping to a tall aspect keeps people upright and
     * tests the thing the scenario is named after.
     */
    from: 'single-person-walking.mp4',
    filter: 'crop=ih*9/16:ih,scale=360:640',
    note: 'Portrait orientation — a tall 9:16 crop, people UPRIGHT (not a rotated landscape).',
  },
  {
    id: 'orient-rotated-90',
    from: 'single-person-walking.mp4',
    filter: 'transpose=1,scale=360:640',
    note: 'A camera physically mounted 90° wrong. Kept as its own scenario because the answer — the detector sees nothing — is a real and useful limitation, just not a statement about portrait.',
  },
];

/**
 * The matrix.
 *
 * `expect` is what the fixture's own manifest says is in the scene — the ground truth every
 * assertion is read against. ⚠️ `null` means the clip has no people count worth asserting (a derived
 * clip whose transform may legitimately cost the detector the subject); those scenarios report what
 * they measured and assert only that the **pipeline** ran, which is the honest split.
 */
export const SCENARIOS = [
  /* ── the fourteen the milestone named ──────────────────────────────────────────────────────── */
  { id: 'empty-room', clip: 'empty-scene.mp4', group: 'scene', expect: 0, title: 'Empty room' },
  { id: 'one-person', clip: 'single-person-walking.mp4', group: 'scene', expect: 1, title: 'One person' },
  { id: 'two-people', clip: 'multiple-people.mp4', group: 'scene', expect: 2, title: 'Two people' },
  { id: 'three-plus-people', clip: 'queue-formation.mp4', group: 'scene', expect: 4, title: 'Three or more people (four)' },
  { id: 'crowd', clip: 'crowd.mp4', group: 'scene', expect: 8, title: 'Crowded scene (eight)' },
  { id: 'fast-walking', clip: 'fast-movement.mp4', group: 'motion', expect: 1, title: 'Fast walking' },
  { id: 'slow-walking', clip: 'retail-loitering.mp4', group: 'motion', expect: 1, title: 'Slow walking / dwelling' },
  { id: 'entering-leaving', clip: 'partial-visibility.mp4', group: 'motion', expect: 1, title: 'Entering and leaving frame' },
  { id: 'partial-occlusion', clip: 'occlusion.mp4', group: 'motion', expect: 1, title: 'Partial occlusion' },
  { id: 'low-light', clip: 'night-footage.mp4', group: 'lighting', expect: 1, title: 'Low light (authored)' },
  { id: 'light-bright', clip: 'light-bright.mp4', group: 'lighting', expect: null, title: 'Bright light' },
  { id: 'light-backlight', clip: 'light-backlight.mp4', group: 'lighting', expect: null, title: 'Backlight' },
  { id: 'orient-portrait', clip: 'orient-portrait.mp4', group: 'orientation', expect: 1, title: 'Portrait orientation (tall crop, people upright)' },
  { id: 'orient-landscape', clip: 'res-720p.mp4', group: 'orientation', expect: 1, title: 'Landscape orientation (720p)' },
  {
    id: 'orient-rotated-90',
    clip: 'orient-rotated-90.mp4',
    group: 'orientation',
    expect: null,
    title: 'Camera mounted 90° wrong (people sideways)',
    note: 'Expected to fail. Recorded because a miscabled or mis-mounted camera is a real deployment event, and "the detector reports an empty scene" is what an operator would see.',
  },

  /* ── occlusion, in the six forms the milestone asked for ───────────────────────────────────── */
  { id: 'occl-static-object', clip: 'occlusion.mp4', group: 'occlusion', expect: 1, title: 'Behind a static object (chair/desk analogue)' },
  { id: 'occl-by-person', clip: 'multiple-people.mp4', group: 'occlusion', expect: 2, title: 'Behind another person (they cross at t=15)' },
  { id: 'occl-partial-body', clip: 'partial-visibility.mp4', group: 'occlusion', expect: 1, title: 'Partial body visibility' },
  { id: 'occl-exit-reentry', clip: 'exit-reentry.mp4', group: 'occlusion', expect: 1, title: 'Leaving and re-entering frame', from: 'tracking' },

  /* ── lighting, the six forms ───────────────────────────────────────────────────────────────── */
  { id: 'light-office', clip: 'light-office.mp4', group: 'lighting', expect: null, title: 'Office lighting (control)' },
  { id: 'light-low', clip: 'light-low.mp4', group: 'lighting', expect: null, title: 'Low light (darkened + noised)' },
  { id: 'light-glare', clip: 'light-glare.mp4', group: 'lighting', expect: null, title: 'Monitor glare' },
  { id: 'light-side', clip: 'light-side.mp4', group: 'lighting', expect: null, title: 'Side lighting' },

  /* ── camera movement ───────────────────────────────────────────────────────────────────────── */
  { id: 'move-pan', clip: 'move-pan.mp4', group: 'movement', expect: null, title: 'Moving laptop (slow pan)' },
  { id: 'move-shake', clip: 'move-shake.mp4', group: 'movement', expect: null, title: 'Shaking laptop' },
  { id: 'move-rotate', clip: 'move-rotate.mp4', group: 'movement', expect: null, title: 'Rotating webcam' },
  { id: 'move-angle', clip: 'angle-overhead.mp4', group: 'movement', expect: 1, title: 'Changed viewing angle (overhead)' },

  /* ── the one no file can stand in for ──────────────────────────────────────────────────────── */
  {
    id: 'webcam-live',
    clip: null,
    group: 'device',
    expect: null,
    manual: true,
    title: 'The real built-in webcam, driven by a human',
    note: 'Run from MANUAL_TEST_GUIDE.md §4. Reported as NOT EXECUTED by an automated matrix run.',
  },
];

/** Every distinct clip the matrix needs, so the Y4M builder knows what to produce. */
export function requiredClips() {
  return [...new Set(SCENARIOS.filter((s) => s.clip !== null).map((s) => s.clip))];
}

# Pose annotator — movie101 (P3.3c)

An offline, single-file keypoint annotator for the 37 extracted `movie101` frames. It produces the
exact annotation file `real_footage_cli.py --validate-annotations` and `pose_score_cli.py score`
already read.

> ⛔ **It never shows you what the model thought.** There is no code path from this page to the
> runtime's output, and the build refuses to write a file that mentions it. Ground truth influenced
> by the thing it is meant to score is not ground truth.

> ⛔ **It cannot reach the network.** A `Content-Security-Policy` of `default-src 'none'` +
> `connect-src 'none'` is declared in the page, and a test asserts no request-issuing API and no
> absolute URL appears anywhere in it. Your frames — consented footage of an identifiable person —
> are read from disk by the browser and never leave this machine.

---

## Launch

```bash
open tools/annotator/pose-annotator.html          # macOS
# or: xdg-open tools/annotator/pose-annotator.html
# or just double-click the file
```

No server, no build step, no dependencies, no internet. Then press **Choose frame files…** and
select **all 37** PNGs in `.data/real/movie101-frames/` (⌘A / Ctrl-A in the file dialog).

⚠️ The tool refuses a selection whose frame indices are not contiguous from `0` — a gap means your
frame *N* and the runtime's frame *N* are different pixels, which is the join everything downstream
depends on.

---

## Annotate

| | |
| --- | --- |
| <kbd>←</kbd> <kbd>→</kbd> | previous / next frame |
| **click** | place the selected joint, then advance to the next unplaced one |
| **drag a joint** | move it |
| <kbd>N</kbd> <kbd>P</kbd> | select next / previous joint |
| <kbd>V</kbd> | toggle the selected joint **visible ⇄ occluded** |
| <kbd>X</kbd> | delete the selected joint |
| <kbd>B</kbd> / <kbd>J</kbd> | box mode / joint mode |
| <kbd>E</kbd> | mark the frame **EMPTY** — nobody is here |
| <kbd>C</kbd> | clear the frame back to **UNREVIEWED** |
| **wheel** | zoom at the cursor · <kbd>space</kbd>+drag pans · <kbd>0</kbd> fits |

Filled circles are **visible** joints, hollow ones **occluded**. Blue is the subject's **left**,
amber the subject's **right**.

### The three frame states

| | Means |
| --- | --- |
| **UNREVIEWED** | you have not looked at this frame |
| **EMPTY** | ⭐ you looked, and state that nobody was there |
| **ANNOTATED** | a box and/or joints exist |

⛔ **EMPTY is a deliberate human statement and UNREVIEWED is not.** An empty frame is what makes a
false positive measurable; an unreviewed one is a gap. The exporter warns about every frame still
UNREVIEWED, and the distinction is recorded in the file as `reviewStatus`.

### The rules the tool enforces for you

- **Left and right are the SUBJECT'S.** A person facing the camera has their left side on the right
  of your screen. A mirrored ground truth makes a correct model look broken.
- `visible: true` = you can see the joint. `visible: false` = it is there but **hidden**. Place
  hidden joints where you judge them to be — "did the model find the hidden wrist" is half the
  measurement.
- **If you cannot tell where a joint is, delete it.** Omitted and hidden are different facts and the
  scorer counts them differently. A guessed joint is worse than an absent one.
- ⚠️ **Place all four torso joints** (both shoulders, both hips) whenever you can, hidden ones
  included. Without a shoulder *and* the opposite hip there is no torso, and the scorer normalizes
  PCK by torso length — that person is **excluded from the score entirely**. The tool warns per
  frame when the torso is incomplete.
- No `confidence` field is ever written. Ground truth has none; the parser refuses it.

---

## Export, and continue later

**Export annotations.json** shows every problem it found before writing anything — unreviewed
frames, a box-less skeleton, an incomplete torso, an out-of-range coordinate, a missing annotator
name. Save the download to:

```
.data/real/movie101-pose/annotations.json
```

### ⛔ Every export attempt reports back

A banner under the toolbar states the outcome of **every** press, because an earlier version
returned silently when the confirm dialog was dismissed — indistinguishable from success, and an
hour of annotation was lost to it.

| Banner | Means |
| --- | --- |
| ✓ **Exported annotations.json** — *n* frames, *n* reviewed, *n* person(s) | the file was written; move it to the path above |
| ⚠️ **Export cancelled — nothing was written** | you dismissed the dialog. ⛔ **The work is still only in this tab** |
| ⛔ **Export failed — nothing was written** | the browser refused; the error is shown and the work is still in the tab |

⚠️ **There is no autosave.** Nothing is written to disk until an export succeeds and you see the
green banner. If the tab is ever closed with unsaved work, this recovers it from the console:

```js
const a = document.createElement('a');
a.href = URL.createObjectURL(new Blob([JSON.stringify(buildDocument(), null, 1)],
                                      { type: 'application/json' }));
a.download = 'annotations.json'; a.click();
```

**Import…** reads a previously exported file back, so you can stop and resume. It refuses a file
whose `caseId` or `clipSha256` describes a different clip.

Then, from the repository root:

```bash
cd ai/inference
python3 real_footage_cli.py --validate-annotations ../../.data/real/movie101-pose/annotations.json \
    --case movie101 --real-root ../../.data/real
```

⚠️ If that prints a `NOT CHECKED` line, read it. It means a check could not run — most often the
rate-and-range check, which needs `opencv-python-headless` and the clip on disk. A PASS with a
`NOT CHECKED` note is a narrower claim than a PASS without one.

---

## ⛔ This file is generated

`pose-annotator.html` is written by `build_annotator.py` from the Python that owns the definitions:

| Injected | From |
| --- | --- |
| joint names | `perception.COCO_17` |
| skeleton edges | `pose.COCO_17_EDGES` |
| schema version, visibility enum | `annotations.SCHEMA_VERSION`, `annotations.VISIBILITY` |
| case id, clip digest, frame size | `benchmarks/detector-corpus.json` |
| `annotatedFps` | ⭐ the extraction artifact that produced these very PNGs — **1.928609**, the measured rate, not the manifest's rounded `27.001 / 14 = 1.928643` |

A browser cannot import a Python tuple, so the copy is *derived* rather than typed —
`"left_wrist"` versus `"leftWrist"` is exactly the disagreement that surfaces as a plausible,
terrible accuracy score rather than as an error.

Edit `annotator.template.html`, never the generated file, then:

```bash
python3 tools/annotator/build_annotator.py          # regenerate
python3 tools/annotator/build_annotator.py --check  # fail if the checked-in file is stale
```

`ai/inference/tests/test_annotator.py` fails if the checked-in HTML stops matching the Python it came
from, so vocabulary drift is a red test rather than a bad number six weeks later.

## Checking the export path

```bash
node tools/annotator/verify-export.mjs
```

⭐ It lifts the tool's **own** `buildDocument()` out of the generated HTML, runs it against a stub
DOM with a small invented annotation, and hands the result to
`real_footage_cli.py --validate-annotations`. A re-implementation of the exporter here would agree
with itself and prove nothing. It asserts the things the schema turns on: unplaced joints are
**omitted** rather than written as invisible, hidden joints keep their position with
`visible: false`, no `confidence` is ever written, and joints come out in `COCO_17` order however
they were clicked.

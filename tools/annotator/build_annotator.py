"""Generate the offline pose annotator — P3.3c.

    perception.COCO_17 ─┐
    pose.COCO_17_EDGES ─┼─▶ build_annotator.py ─▶ tools/annotator/pose-annotator.html
    annotations.SCHEMA ─┘

⛔ **The HTML is GENERATED, and that is the whole point of this script.** A browser cannot import a
Python tuple, so an annotator written by hand would carry a second copy of the joint vocabulary — and
`"left_wrist"` versus `"leftWrist"` is exactly the disagreement that surfaces as a plausible, awful
accuracy score rather than as an error. Here the copy is *derived*, and `tests/test_annotator.py`
fails if the checked-in file stops matching the Python it came from. Drift becomes a red test.

⚠️ Everything the annotator needs about the clip — case id, digest, dimensions, sample rate — is read
from the artifacts that already declare it, never retyped. The rate in particular comes from the
extraction skeleton that produced the very PNGs being annotated.

    python3 tools/annotator/build_annotator.py            # regenerate
    python3 tools/annotator/build_annotator.py --check     # fail if the checked-in file is stale
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "ai", "inference"))

import annotations as ann  # noqa: E402
import benchmark_corpus as bc  # noqa: E402
import pose  # noqa: E402
from perception import COCO_17, DEFAULT_SKELETON, SKELETONS  # noqa: E402

CASE_ID = "movie101"
OUTPUT = os.path.join(HERE, "pose-annotator.html")
TEMPLATE = os.path.join(HERE, "annotator.template.html")

#: ⛔ The four joints `pose_scoring` needs for torso normalization. Named here so the annotator can
#: warn live rather than letting a person discover after the work that they are excluded from PCK.
TORSO = ("left_shoulder", "right_shoulder", "left_hip", "right_hip")


def _case() -> bc.BenchmarkCase:
    corpus = bc.load(
        os.path.join(REPO, "ai", "inference", "benchmarks", "detector-corpus.json"),
        real_root=os.path.join(REPO, ".data", "real"),
        require_files=False,
    )
    return corpus.by_id(CASE_ID)


def _annotated_fps(case: bc.BenchmarkCase) -> float:
    """⭐ The rate from the extraction artifact that produced the PNGs being annotated.

    ⚠️ Not the manifest's `capture.fps / stride`. The manifest stores the source rate **rounded to
    three decimals**, and dividing a rounded number by the stride gives 1.928643 where the frames
    were actually sampled at 1.928609. The annotator's file is the thing `align()` later checks
    against the real pixels, so it must carry the rate those pixels have — "round for reading, never
    for deciding". Falls back to the manifest only if the extraction artifact is gone, and says so.
    """
    skeleton = os.path.join(REPO, ".data", "real", "movie101-frames", "annotations.skeleton.json")
    if os.path.isfile(skeleton):
        with open(skeleton, "r", encoding="utf-8") as handle:
            declared = json.load(handle)
        rate = declared.get("annotatedFps")
        if isinstance(rate, (int, float)) and rate > 0:
            return float(rate)
    capture = dict(case.capture or {})
    fps = float(capture.get("fps") or 0.0)
    return fps / max(1, round(fps / 2.0))


def render() -> str:
    case = _case()
    capture = dict(case.capture or {})
    with open(TEMPLATE, "r", encoding="utf-8") as handle:
        html = handle.read()

    substitutions = {
        "/*__COCO_17__*/": json.dumps(list(COCO_17)),
        "/*__EDGES__*/": json.dumps([list(edge) for edge in pose.COCO_17_EDGES]),
        "/*__TORSO__*/": json.dumps(list(TORSO)),
        "/*__VISIBILITY__*/": json.dumps(list(ann.VISIBILITY)),
        "/*__SCHEMA_VERSION__*/": json.dumps(ann.SCHEMA_VERSION),
        "/*__SKELETON__*/": json.dumps(DEFAULT_SKELETON),
        "/*__CASE_ID__*/": json.dumps(case.case_id),
        "/*__CLIP_SHA256__*/": json.dumps(case.sha256),
        "/*__FRAME_WIDTH__*/": json.dumps(int(capture.get("width") or 0)),
        "/*__FRAME_HEIGHT__*/": json.dumps(int(capture.get("height") or 0)),
        "/*__ANNOTATED_FPS__*/": json.dumps(round(_annotated_fps(case), 6)),
        "/*__GENERATED_BY__*/": json.dumps("tools/annotator/build_annotator.py"),
    }
    for token, value in substitutions.items():
        if token not in html:
            raise SystemExit(f"⛔ template is missing the token {token}")
        html = html.replace(token, value)

    # ⛔ A last structural check on the generated artifact rather than on the intent: the file must
    # not have acquired a way to reach the network or a reference to the model's predictions.
    for banned in ("fetch(", "XMLHttpRequest", "WebSocket", "http://", "https://", "predictions"):
        if banned in html:
            raise SystemExit(f"⛔ generated annotator contains '{banned}' — refusing to write it")
    if SKELETONS.get(DEFAULT_SKELETON) != COCO_17:
        raise SystemExit("⛔ the default skeleton is not COCO_17; the template's assumptions no longer hold")
    return html


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true",
                        help="exit non-zero if the checked-in file is not what this script produces")
    args = parser.parse_args(argv)

    html = render()
    if args.check:
        if not os.path.isfile(OUTPUT):
            print(f"⛔ {OUTPUT} does not exist", file=sys.stderr)
            return 1
        with open(OUTPUT, "r", encoding="utf-8") as handle:
            current = handle.read()
        if current != html:
            print("⛔ pose-annotator.html is STALE — the joint vocabulary, skeleton, schema version "
                  "or clip metadata it carries no longer matches the Python it was generated from. "
                  "Run: python3 tools/annotator/build_annotator.py", file=sys.stderr)
            return 1
        print("✓ pose-annotator.html is current")
        return 0

    with open(OUTPUT, "w", encoding="utf-8") as handle:
        handle.write(html)
    print(f"✓ wrote {OUTPUT} ({len(html):,} bytes) — {len(COCO_17)} joints, "
          f"{len(pose.COCO_17_EDGES)} edges, schema {ann.SCHEMA_VERSION}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

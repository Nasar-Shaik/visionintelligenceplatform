"""Pose accuracy against human ground truth — the operator's entry point (P3.3c).

    predict   frames ─▶ the DEPLOYED runtime ─▶ predictions.json (provenance-bound)
    template  the 17-joint annotation stub a human fills in
    score     annotations.json + predictions.json ─▶ PCK@0.2, per joint, wrists, visible/occluded

⛔ **`predict` does not produce ground truth and can never be made to.** It records what the model
said, in a file whose every field names the model that said it. Ground truth comes from `template`,
filled in by a person, and the two are compared only by `score`.

⚠️ **Provenance is mandatory, not decorative.** Every subcommand refuses to write a file it cannot
fully attribute: no commit, no output. A predictions file that cannot name the code, the artifact and
the pixels that produced it is not evidence — it is a number of unknown origin, and six months from
now nobody will be able to reproduce or refute it.

    python3 pose_score_cli.py predict --frames DIR --case movie101 --commit $(git rev-parse HEAD) \\
        --out predictions.json
    python3 pose_score_cli.py template --frames DIR --case movie101 --out annotations.json
    python3 pose_score_cli.py score --annotations A.json --predictions P.json --case movie101
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import time
from typing import Dict, List, Mapping, Optional, Sequence

import annotations as ann
import benchmark_corpus as bc
import pose_scoring as ps
from perception import COCO_17

PREDICTIONS_SCHEMA = "pose-predictions-2026-08-12"

DEFAULT_ENDPOINT = "http://127.0.0.1:8085"
DEFAULT_CAPABILITY = "perception.person-detection"


class CliError(RuntimeError):
    """A refusal the operator must act on."""


# --- shared -----------------------------------------------------------------------------------


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _frame_files(directory: str) -> List[str]:
    """Every extracted frame, in index order.

    ⛔ Sorted by the index parsed out of the NAME, not by `readdir` order and not by mtime. A
    directory listing that happened to interleave a second extraction once swept 302 unrelated
    frames into a run and made it unattributable.
    """
    out = []
    for name in os.listdir(directory):
        stem, ext = os.path.splitext(name)
        if ext.lower() not in (".png", ".jpg", ".jpeg"):
            continue
        digits = stem.rsplit("-", 1)[-1]
        if not digits.isdigit():
            raise CliError(
                f"'{name}' does not end in a frame index. ⚠️ The index is the join to the "
                f"annotation file; a file whose index cannot be read cannot be scored against it."
            )
        out.append((int(digits), os.path.join(directory, name)))
    if not out:
        raise CliError(f"no frames in '{directory}'")
    out.sort()
    indices = [i for i, _ in out]
    if indices != list(range(len(indices))):
        raise CliError(
            f"frame indices are not contiguous from 0: found {indices[:5]}…{indices[-3:]}. "
            f"⛔ A gap means the annotator's frame N and the runtime's frame N are different pixels."
        )
    return [p for _, p in out]


#: The declared corpus. ⚠️ `require_files=False`: the clip itself is git-ignored real footage and is
#: not on every machine that needs to read the case's *declaration* — the digest, dimensions and rate
#: live in the manifest, and `score` binds the predictions to them without needing the video.
DEFAULT_CORPUS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "benchmarks", "detector-corpus.json")


#: ⛔ **Absolute, because the alternative degrades quietly-ish.** `bc.DEFAULT_REAL_ROOT` is the
#: relative `.data/real`, which resolves against the caller's working directory — so running this
#: tool from `ai/inference` rather than the repo root turned the rate-and-range check into a
#: "NOT CHECKED" line. The disclosure was printed, which is the only reason it was caught; the
#: annotator would still have lost the check that catches a whole-file rate slide.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_REAL_ROOT = os.path.join(_REPO_ROOT, bc.DEFAULT_REAL_ROOT)


def _corpus(path: str = "") -> bc.Corpus:
    return bc.load(path or DEFAULT_CORPUS, real_root=DEFAULT_REAL_ROOT, require_files=False)


def _case(case_id: str, corpus_path: str = "") -> bc.BenchmarkCase:
    return _corpus(corpus_path).by_id(case_id)


def _case_geometry(case: bc.BenchmarkCase) -> Dict[str, object]:
    """Resolution, digest and the EFFECTIVE sample rate, from the declared case.

    ⛔ The effective rate, never the requested one. `FrameSampler` uses an integer stride, so a
    27.001 fps clip asked for 2.0 is sampled at **1.9286** — and an annotator working to 2.0 drifts
    8.75 frames over 70 seconds while every individual frame looks correct.
    """
    capture = dict(case.capture or {})
    width, height = capture.get("width"), capture.get("height")
    fps = capture.get("fps")
    if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise CliError(
            f"case '{case.case_id}' does not declare pixel dimensions. ⚠️ Required: coordinates are "
            f"normalized per axis, so a distance computed without them scores a horizontal error "
            f"and an equal vertical one differently."
        )
    if not isinstance(fps, (int, float)) or fps <= 0:
        raise CliError(f"case '{case.case_id}' does not declare a frame rate")
    stride = max(1, round(float(fps) / 2.0))
    return {"width": width, "height": height, "sourceFps": float(fps),
            "stride": stride, "effectiveFps": float(fps) / stride,
            "effectiveFpsTolerance": _rate_tolerance(fps, stride),
            "clipSha256": case.sha256}


def _rate_tolerance(declared_fps: float, stride: int) -> float:
    """How far the manifest's rate may legitimately sit from the clip's measured one.

    ⛔ **Derived from the manifest's own precision, never guessed.** `capture.fps` is stored rounded
    — movie101 declares `27.001` — so the true rate lies within half a unit of the last decimal
    place, and the sampled rate within that band divided by the stride. movie101: ±0.0005 fps →
    **±7.2e-5** on the effective rate, which is why the annotation skeleton (built from the exact
    probe, 1.928609) and this file (built from the manifest, 1.928643) differ in the fifth decimal.

    ⚠️ That gap is small and it is not nothing: the same class of mismatch — a rate rounded for
    reading and then used for deciding — is what once made a correct annotation file fail its own
    validator by 34× the tolerance. So the two rates are compared at scoring time against **this**
    number rather than against a convenient epsilon.
    """
    text = f"{declared_fps!r}"
    decimals = len(text.split(".")[1]) if "." in text else 0
    return (0.5 * (10 ** -decimals)) / stride if decimals else 0.5 / stride


# --- predict ----------------------------------------------------------------------------------


def _post_frame(endpoint: str, key: str, capability: str, raw: bytes, index: int) -> dict:
    import urllib.request  # noqa: WPS433 - stdlib, imported at the one place it is used

    body = {
        "capabilityId": capability,
        "context": {"tenantId": "t_pose_scoring"},
        "frame": {"cameraId": "cam_pose_scoring", "seq": index},
        "imageBase64": base64.b64encode(raw).decode("ascii"),
    }
    request = urllib.request.Request(
        endpoint.rstrip("/") + "/infer",
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "x-internal-key": key},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        payload = json.loads(response.read())
    # ⚠️ The envelope is unwrapped HERE, once. Reading `detections` off the envelope is precisely
    # the mistake that produced "0 detections" for 37 frames the runtime had found people in.
    return payload.get("data", payload)


def _runtime_identity(endpoint: str, key: str) -> dict:
    import urllib.request  # noqa: WPS433

    request = urllib.request.Request(endpoint.rstrip("/") + "/runtime",
                                     headers={"x-internal-key": key})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.loads(response.read())
    runtime = payload.get("data", payload)
    loaded = runtime.get("loadedModels") or []
    pose = next((entry.get("pose") for entry in loaded if entry.get("pose")), None)
    if pose is None:
        raise CliError(
            "⛔ the runtime at this endpoint reports NO pose model. Predictions captured from it "
            "would contain no keypoints, and an empty result is not a low score — it is the absence "
            "of a measurement. Check INFERENCE_POSE_ENABLED and the catalogue."
        )
    return {
        "runtimeVersion": runtime.get("runtimeVersion"),
        "executionProvider": runtime.get("executionProvider"),
        "poseModel": pose.get("model"),
        "poseArtifactSha256": pose.get("artifactSha256"),
        "detector": (loaded[0].get("model") if loaded else None),
    }


def predict(*, frames_dir: str, case_id: str, commit: str, endpoint: str, key: str,
            capability: str, out_path: str, image: str = "", corpus_path: str = "") -> dict:
    """Run every frame through the deployed runtime and record what it said, with provenance."""
    if not commit.strip():
        raise CliError(
            "⛔ --commit is required. A predictions file that cannot name the code that produced it "
            "is not evidence; it is a number of unknown origin."
        )
    case = _case(case_id, corpus_path)
    geometry = _case_geometry(case)
    files = _frame_files(frames_dir)
    identity = _runtime_identity(endpoint, key)

    frames: List[dict] = []
    posed = people = 0
    for index, path in enumerate(files):
        raw = open(path, "rb").read()
        result = _post_frame(endpoint, key, capability, raw, index)
        persons = []
        for det in result.get("detections", []):
            if det.get("label") != "person":
                continue
            people += 1
            pose = (det.get("attributes") or {}).get("pose") or {}
            keypoints = pose.get("keypoints") or []
            if keypoints:
                posed += 1
            # ⛔ The artifact that produced these joints is checked against the one the runtime
            # reports. A predictions file mixing two artifacts would score as a single model.
            if pose and pose.get("artifactSha256") != identity["poseArtifactSha256"]:
                raise CliError(
                    f"frame {index}: keypoints attributed to artifact "
                    f"{pose.get('artifactSha256')!r}, but the runtime reports "
                    f"{identity['poseArtifactSha256']!r}"
                )
            persons.append({
                "bbox": det.get("bbox"),
                "confidence": det.get("confidence"),
                "keypoints": [
                    {"name": k.get("name"), "x": k.get("x"), "y": k.get("y"),
                     "confidence": k.get("confidence"), "visible": k.get("visible")}
                    for k in keypoints
                ],
            })
        frames.append({
            "frameIndex": index,
            "file": os.path.basename(path),
            # ⭐ The pixels are digest-bound too. Regenerating predictions from a re-extracted frame
            # set would otherwise be invisible, and every joint would describe different pixels.
            "fileSha256": _sha256_file(path),
            "people": persons,
        })

    document = {
        "schemaVersion": PREDICTIONS_SCHEMA,
        "caseId": case.case_id,
        "clipSha256": geometry["clipSha256"],
        "frameWidth": geometry["width"],
        "frameHeight": geometry["height"],
        "sourceFps": geometry["sourceFps"],
        "stride": geometry["stride"],
        # ⚠️ Labelled by where it came from. The manifest's fps is rounded, so this is the rate
        # implied by a rounded number — close to, and not identical with, the clip's measured rate.
        "effectiveFps": round(float(geometry["effectiveFps"]), 6),
        "effectiveFpsSource": "manifest capture.fps / stride",
        "effectiveFpsTolerance": geometry["effectiveFpsTolerance"],
        "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "provenance": {
            "commit": commit.strip(),
            "image": image or None,
            "endpoint": endpoint,
            "capabilityId": capability,
            **identity,
        },
        "totals": {"frames": len(frames), "personDetections": people, "personsWithPose": posed},
        "frames": frames,
    }
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=1)
    return document


def load_predictions(path: str, *, case_id: str = "", clip_sha256: str = "") -> dict:
    """Read a predictions file and refuse one that describes different pixels or another clip."""
    with open(path, "r", encoding="utf-8") as handle:
        document = json.load(handle)
    if document.get("schemaVersion") != PREDICTIONS_SCHEMA:
        raise CliError(
            f"predictions schemaVersion is {document.get('schemaVersion')!r}, this tool reads "
            f"{PREDICTIONS_SCHEMA!r}"
        )
    if case_id and document.get("caseId") != case_id:
        raise CliError(f"predictions are for case {document.get('caseId')!r}, not {case_id!r}")
    if clip_sha256 and document.get("clipSha256") != clip_sha256:
        raise CliError(
            f"predictions declare clip sha256 {str(document.get('clipSha256'))[:12]}…, the case "
            f"declares {clip_sha256[:12]}…. ⛔ Different pixels — a score from these would be "
            f"precise, reproducible and about nothing."
        )
    for field in ("commit", "poseModel", "poseArtifactSha256"):
        if not (document.get("provenance") or {}).get(field):
            raise CliError(f"predictions carry no provenance.{field}; refusing to score")
    return document


def check_alignment(parsed: ann.Annotations, document: Mapping[str, object],
                    geometry: Mapping[str, object]) -> List[str]:
    """⛔ Does the annotator's frame N describe the same pixels the runtime saw as frame N?

    Four independent joins, each of which has silently broken something in this project before:
    the clip digest, the effective sample rate, the frame range, and the case id.
    """
    problems: List[str] = []
    if parsed.clip_sha256 and document.get("clipSha256") != parsed.clip_sha256:
        problems.append(
            f"⛔ the annotations describe clip sha256:{str(parsed.clip_sha256)[:12]}… and the "
            f"predictions sha256:{str(document.get('clipSha256'))[:12]}… — different pixels"
        )

    tolerance = float(geometry["effectiveFpsTolerance"])  # type: ignore[arg-type]
    declared = float(document.get("effectiveFps") or 0.0)
    if parsed.annotated_fps and abs(parsed.annotated_fps - declared) > tolerance:
        problems.append(
            f"⛔ rate mismatch: the annotations were made at {parsed.annotated_fps:.6f} fps and the "
            f"predictions at {declared:.6f} fps — a gap of "
            f"{abs(parsed.annotated_fps - declared):.2e}, beyond the ±{tolerance:.2e} the manifest's "
            f"own rounding allows. ⚠️ A rate error does not misplace one frame; it slides the whole "
            f"file, so early frames look right and later ones silently describe a different moment."
        )

    frames = len(document.get("frames") or ())  # type: ignore[arg-type]
    highest = max((f.frame_index for f in parsed.frames), default=-1)
    if highest >= frames:
        problems.append(
            f"⛔ the annotations reach frame {highest} but only {frames} frames were analysed"
        )
    return problems


def to_people(document: Mapping[str, object]) -> Dict[int, List[ps.PredictedPerson]]:
    """Predictions file → the scorer's input, keyed by frame index."""
    out: Dict[int, List[ps.PredictedPerson]] = {}
    for frame in document.get("frames", []):  # type: ignore[union-attr]
        people = []
        for person in frame.get("people", []):
            bbox = tuple(float(v) for v in person.get("bbox") or ())
            if len(bbox) != 4:
                raise CliError(f"frame {frame.get('frameIndex')}: a person has no usable bbox")
            people.append(ps.PredictedPerson(
                bbox=bbox,  # type: ignore[arg-type]
                confidence=float(person.get("confidence") or 0.0),
                keypoints=tuple(
                    ps.PredictedKeypoint(
                        name=str(k.get("name")), x=float(k.get("x")), y=float(k.get("y")),
                        confidence=float(k.get("confidence") or 0.0),
                        visible=bool(k.get("visible")),
                    )
                    for k in person.get("keypoints") or []
                ),
            ))
        out[int(frame["frameIndex"])] = people
    return out


# --- template ---------------------------------------------------------------------------------


def _measured_effective_fps(case: bc.BenchmarkCase, geometry: Mapping[str, object]) -> float:
    """The sampled rate from the clip's own header, falling back to the manifest's rounded one.

    ⚠️ `probe` needs cv2 and the clip on disk; neither is guaranteed on the machine generating a
    template. The fallback is the manifest value — correct to its own precision — and the difference
    is bounded by `_rate_tolerance`, which is what `check_alignment` compares against later.
    """
    clip = os.path.join(DEFAULT_REAL_ROOT, case.path)
    if not os.path.isfile(clip):
        return float(geometry["effectiveFps"])  # type: ignore[arg-type]
    try:
        import real_footage_cli as rf  # noqa: WPS433 - pulls cv2, only needed here

        measured = rf.probe(clip)
        exact = measured.get("fpsExact", measured.get("fps"))
        if isinstance(exact, (int, float)) and exact > 0:
            return float(exact) / int(geometry["stride"])  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001 - a template is still useful without cv2
        pass
    return float(geometry["effectiveFps"])  # type: ignore[arg-type]


def template(*, frames_dir: str, case_id: str, annotator: str = "", corpus_path: str = "") -> dict:
    """The file a HUMAN fills in. ⛔ Contains no model output and no coordinates.

    ⚠️ Every frame arrives with `boxes: []` — an empty list is a *positive statement* that nothing
    was there, and it is what makes false positives measurable. The annotator confirms or replaces
    each one; an unreviewed file therefore claims the clip is empty, loudly, rather than quietly
    claiming nothing at all.
    """
    case = _case(case_id, corpus_path)
    geometry = _case_geometry(case)
    files = _frame_files(frames_dir)
    return {
        "schemaVersion": ann.SCHEMA_VERSION,
        "caseId": case.case_id,
        "clipSha256": geometry["clipSha256"],
        # ⛔ The MEASURED rate when the clip is reachable, the manifest's rounded one otherwise. The
        # annotator's file is the thing `align()` checks against the real pixels, so it must carry
        # the rate those pixels actually have — "round for reading, never for deciding".
        "annotatedFps": round(float(_measured_effective_fps(case, geometry)), 6),
        "annotator": annotator,
        "note": (
            "⛔ UNFILLED SKELETON — every frame reads as EMPTY, which is a CLAIM. Confirm or replace "
            "each one. Copy `_keypointTemplate` into a box's `keypoints` and DELETE every joint you "
            "cannot locate; a guessed joint is worse than an absent one. Never copy coordinates from "
            "the model — a score computed against model output measures self-consistency."
        ),
        "_keypointTemplate": {
            "_readme": (
                "17 COCO joints. `visible` is YOUR judgement: true = plainly in shot, false = there "
                "but hidden by something. It is NOT the model's confidence and NOT how sure you are "
                "— if you are unsure where a joint is, delete it. x/y are normalized [0,1] against "
                f"the FULL frame ({geometry['width']}×{geometry['height']}), not the person's box."
            ),
            "keypoints": [{"name": name, "x": None, "y": None, "visible": True} for name in COCO_17],
        },
        "_boxTemplate": {
            "label": "person",
            "gtId": 1,
            "bbox": [None, None, None, None],
            "visibility": "fully-visible",
            "skeleton": "coco-17",
            "keypoints": [],
        },
        "frames": [
            {"frameIndex": index, "atSeconds": round(index / float(geometry["effectiveFps"]), 3),
             "boxes": []}
            for index in range(len(files))
        ],
    }


# --- score ------------------------------------------------------------------------------------


def render(report: ps.PoseReport, cover: ps.Coverage) -> str:
    """The human-readable result. ⛔ Caveats print BEFORE the numbers, never as a footnote."""
    lines: List[str] = []
    for caveat in cover.caveats:
        lines.append(caveat)
    if cover.caveats:
        lines.append("")

    data = report.to_dict()
    sample = data["sample"]
    lines.append(f"metric      {data['metric']}  ·  normalizer {data['normalizer']}  ·  "
                 f"match IoU {data['matchIou']}")
    lines.append(f"provenance  {json.dumps(data['provenance'], sort_keys=True)}")
    lines.append(f"sample      {sample['framesScored']}/{sample['framesAnnotated']} frames scored · "
                 f"{sample['gtPeopleMatched']}/{sample['gtPeopleWithKeypoints']} annotated people "
                 f"matched · {sample['distinctSubjects']} subject(s) · "
                 f"{sample['jointsScored']} joints")
    lines.append(f"detector    {sample['gtPeopleUnmatchedByDetector']} annotated person(s) not found "
                 f"· {sample['predictedPeopleUnmatched']} detection(s) with no annotation "
                 f"⚠️ detector numbers, reported apart from pose")
    lines.append("")

    if not cover.publishable:
        lines.append("PCK         ⛔ NOT PUBLISHED — see the caveat above. Counts only.")
        return "\n".join(lines)

    overall = data["overall"]
    lines.append(f"PCK@{report.alpha}    {overall['pck']}  ({overall['correct']}/{overall['total']})")
    wrists = data["wrists"]
    lines.append(f"  wrists    {wrists['overall']['pck']}  "
                 f"({wrists['overall']['correct']}/{wrists['overall']['total']})   "
                 f"left {wrists['left']['pck'] if wrists['left'] else None} · "
                 f"right {wrists['right']['pck'] if wrists['right'] else None}")
    lines.append(f"  visible   {wrists['visible']['pck']} wrists · overall per-joint below")
    lines.append("")
    lines.append(f"{'joint':<16}{'pck':>8}{'n':>6}   {'visible':>16}{'occluded':>16}")
    for joint in data["perJoint"]:
        vis, occ = joint["visible"], joint["occluded"]
        lines.append(
            f"{joint['joint']:<16}{str(joint['pck']):>8}{joint['total']:>6}   "
            f"{str(vis['pck']) + ' (' + str(vis['total']) + ')':>16}"
            f"{str(occ['pck']) + ' (' + str(occ['total']) + ')':>16}"
        )
    lines.append("")
    agreement = data["visibilityAgreement"]
    lines.append(
        f"visibility agreement (⛔ a SEPARATE question from localization): "
        f"{agreement['agree']}/{agreement['total']} agree · "
        f"model-visible/human-not {agreement['modelSaidVisibleHumanDidNot']} · "
        f"human-visible/model-not {agreement['humanSaidVisibleModelDidNot']}"
    )
    return "\n".join(lines)


def _score(args) -> int:  # noqa: ANN001
    import real_footage_cli as rf  # noqa: WPS433 - reuse the validator, never restate its rules

    case = _case(args.case, args.corpus)
    geometry = _case_geometry(case)

    # ⛔ Validation BEFORE scoring, and a failure is terminal. Every rule here is the one the
    # existing validator already applies — digest, effective rate, frame range, case, gtId
    # continuity — called rather than restated, so the two can never disagree.
    problems = rf.validate_annotations(args.annotations, corpus=_corpus(args.corpus),
                                       case_id=args.case, real_root=DEFAULT_REAL_ROOT)
    hard = [p for p in problems if not p.startswith("⚠️ NOT CHECKED")]
    for problem in problems:
        print(f"  {problem}")
    if hard:
        print(f"\n⛔ {len(hard)} problem(s) — refusing to score. Ground truth that cannot be "
              f"trusted as ground truth produces a score that cannot be trusted as a score.")
        return 2
    # ⚠️ Names only what the validator actually ran. It reports a "NOT CHECKED" line for anything it
    # could not do — a clip it cannot find, or one it cannot read because cv2 is absent — and those
    # lines are printed above. A blanket "✓ everything checked" here would contradict them, which is
    # how a PASS that skipped its strongest check starts being quoted as a full one.
    skipped = [p for p in problems if p.startswith("⚠️ NOT CHECKED")]
    print("✓ annotations validated: schema, boxes, keypoints, digest, case, gtId continuity"
          + ("" if not skipped else f" — ⚠️ {len(skipped)} check(s) could not run, see above"))

    parsed = ann.load(args.annotations)
    document = load_predictions(args.predictions, case_id=args.case,
                               clip_sha256=str(geometry["clipSha256"] or ""))

    # ⛔ The annotations and the predictions are each valid on their own; this asks whether they
    # describe the SAME pixels at the SAME moments. Nothing downstream can detect a failure here —
    # a slid file scores as a uniformly mediocre model.
    misaligned = check_alignment(parsed, document, geometry)
    for problem in misaligned:
        print(f"  {problem}")
    if misaligned:
        print("\n⛔ annotations and predictions are not aligned — refusing to score.")
        return 2
    print("✓ aligned: clip digest, effective rate (within the manifest's own rounding), frame range")
    report = ps.score(
        parsed,
        to_people(document),
        frame_width=int(geometry["width"]),  # type: ignore[arg-type]
        frame_height=int(geometry["height"]),  # type: ignore[arg-type]
        alpha=args.alpha,
        normalizer=args.normalizer,
        match_iou=args.match_iou,
        provenance={
            "caseId": document["caseId"],
            "clipSha256": str(document["clipSha256"])[:16] + "…",
            "effectiveFps": document["effectiveFps"],
            "annotator": parsed.annotator or "(unnamed)",
            **{k: v for k, v in document["provenance"].items() if k != "endpoint"},
        },
    )
    cover = ps.coverage(report)
    print()
    print(render(report, cover))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump({**report.to_dict(), "coverage": cover.to_dict()}, handle, indent=1)
        print(f"\n✓ wrote {args.json}")
    return 0 if cover.verdict != "no-ground-truth" else 3


# --- entry point ------------------------------------------------------------------------------


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("predict", help="capture what the deployed runtime says about each frame")
    p.add_argument("--frames", required=True)
    p.add_argument("--case", required=True)
    p.add_argument("--commit", required=True, help="the code that produced these predictions")
    p.add_argument("--image", default="", help="the container image, when known")
    p.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    p.add_argument("--key", default=os.environ.get("INTERNAL_API_KEY", ""))
    p.add_argument("--capability", default=DEFAULT_CAPABILITY)
    p.add_argument("--corpus", default=DEFAULT_CORPUS)
    p.add_argument("--out", required=True)

    t = sub.add_parser("template", help="the empty annotation file a human fills in")
    t.add_argument("--frames", required=True)
    t.add_argument("--case", required=True)
    t.add_argument("--annotator", default="")
    t.add_argument("--corpus", default=DEFAULT_CORPUS)
    t.add_argument("--out", required=True)

    s = sub.add_parser("score", help="score model keypoints against human keypoints")
    s.add_argument("--annotations", required=True)
    s.add_argument("--predictions", required=True)
    s.add_argument("--case", required=True)
    s.add_argument("--alpha", type=float, default=ps.DEFAULT_ALPHA)
    s.add_argument("--normalizer", default=ps.DEFAULT_NORMALIZER, choices=ps.NORMALIZERS)
    s.add_argument("--match-iou", type=float, default=ps.DEFAULT_MATCH_IOU)
    s.add_argument("--corpus", default=DEFAULT_CORPUS)
    s.add_argument("--json", default="", help="also write the full report here")

    args = parser.parse_args(argv)
    try:
        if args.command == "predict":
            document = predict(frames_dir=args.frames, case_id=args.case, commit=args.commit,
                               endpoint=args.endpoint, key=args.key, capability=args.capability,
                               out_path=args.out, image=args.image, corpus_path=args.corpus)
            totals = document["totals"]
            print(f"✓ {totals['frames']} frames · {totals['personDetections']} person detections · "
                  f"{totals['personsWithPose']} with pose")
            print(f"  model {document['provenance']['poseModel']} "
                  f"sha256:{str(document['provenance']['poseArtifactSha256'])[:12]}… · "
                  f"commit {document['provenance']['commit'][:12]}")
            print(f"✓ wrote {args.out}")
            return 0
        if args.command == "template":
            document = template(frames_dir=args.frames, case_id=args.case,
                                annotator=args.annotator, corpus_path=args.corpus)
            if os.path.exists(args.out):
                raise CliError(f"'{args.out}' exists — refusing to overwrite annotation work")
            with open(args.out, "w", encoding="utf-8") as handle:
                json.dump(document, handle, indent=1)
            print(f"✓ wrote {args.out}: {len(document['frames'])} frames, every one EMPTY and "
                  f"awaiting a human")
            return 0
        return _score(args)
    except (CliError, ann.AnnotationError, bc.CorpusError, ps.PoseScoringError) as exc:
        print(f"⛔ {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

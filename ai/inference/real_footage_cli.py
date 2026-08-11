"""Ingest and verify real footage — P3.2.

    python3 real_footage_cli.py --verify
    python3 real_footage_cli.py --register clip.mp4 --clip-id walk-01 \
        --scenarios normal-person,front-facing-person --consent docs/…/consent.md \
        --device "iPhone 13, fixed tripod" --captured-at 2026-08-12
    python3 real_footage_cli.py --gap            # what recording would unblock most

⭐ **This is the smallest thing that was missing, and deliberately not a pipeline.** Replay already
exists twice over: `detector_benchmark_cli.py` runs a clip through `VideoAnalyzer` at the runtime
tier, and `tools/validation/object-association.mjs --clip` uploads one through the deployed platform
to evidence and the WHY chain. Neither needed a change to accept real footage. What was missing was
the *declaration*: provenance strong enough that a real clip cannot be confused with a rendered one,
and a checksum that binds the manifest to the bytes.

### ⛔ What this refuses to do

- **Invent consent.** `--consent` is required and must reference a record an auditor can follow. A
  boolean would record no decision, and a default would record somebody else's.
- **Copy footage into the repository.** Real clips stay in the git-ignored real root. The manifest
  entry — provenance, dimensions, digest — is what gets committed, exactly as `object-corpus.mjs`
  established for photographs.
- **Re-declare a digest that stopped matching.** `--verify` reports the mismatch and exits non-zero.
  Phones re-encode on export and files get overwritten in place; a measurement quietly re-run against
  different pixels produces a plausible number that describes nothing.

Stdlib + OpenCV for the probe, like the runtime it feeds. Runs inside the built image.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

import annotations as ann
import benchmark_corpus as bc

DEFAULT_CORPUS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "benchmarks", "detector-corpus.json")
DEFAULT_FIXTURES = "/opt/vip/fixtures/media"


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe(path: str) -> Dict[str, object]:
    """Dimensions, rate and duration read from the file itself.

    ⚠️ Recorded at registration because the benchmark's sampler derives its stride from the clip's
    own frame rate. A clip whose rate is assumed rather than read is sampled wrongly and reads as a
    faster or slower detector — the defect P3.1 found in its own runner.

    ⛔ **`fps` is rounded for reading; `fpsExact` is what a decision may be derived from.** They are
    both here because rounding one of them was a real defect: the first real clip measured
    27.00052530204868 fps, `round(…, 3)` recorded 27.001, and `validate_annotations` divided *that*
    by the stride to decide what rate the annotator should have used. The answer — 1.9286428… against
    a true 1.9286089… — is wrong by 3.4e-5, thirty-four times the tolerance `align()` allows, so the
    tool refused the very skeleton it had just generated. ⚠️ Every authored fixture has an integer
    rate, where rounding changes nothing; only a real clip could expose it.
    """
    out: Dict[str, object] = {"bytes": os.path.getsize(path)}
    try:
        import cv2  # noqa: WPS433 - present in the image, optional elsewhere
    except Exception:  # noqa: BLE001
        out["probe"] = "unavailable: OpenCV is not installed here"
        return out
    capture = cv2.VideoCapture(path)
    try:
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        frames = float(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0)
        out.update(
            {
                "width": int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
                "height": int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
                # Rounded, and read by people: this is what lands in the manifest's capture block.
                "fps": round(fps, 3),
                # ⛔ Unrounded, and read by code. See the warning above.
                "fpsExact": fps,
                "frames": int(frames),
                "durationSeconds": round(frames / fps, 3) if fps > 0 else None,
            }
        )
    finally:
        capture.release()
    return out


def entry_for(
    *,
    clip_id: str,
    path: str,
    file_name: str,
    scenarios: Sequence[str],
    consent: str,
    device: str,
    captured_at: str,
    category: str = "real",
    note: str = "",
) -> dict:
    """The manifest entry for one real clip — ⛔ built from the file, not from a template.

    ⚠️ `groundTruth` is `None` and stays that way until annotations exist. Declaring a path to an
    annotation file that has not been written would authorise precision and recall for a case nothing
    can score, which `benchmark_corpus.load` refuses one layer later.
    """
    unknown = [s for s in scenarios if s not in bc.SCENARIOS]
    if unknown:
        raise bc.CorpusError(
            f"clip '{clip_id}' claims unknown scenario(s) {unknown}. Nothing reports them, so the "
            f"claim would be silent. Known scenarios: {', '.join(bc.SCENARIOS)}"
        )
    measured = probe(path)
    return {
        "caseId": clip_id,
        "path": file_name,
        "category": category,
        "footageKind": "REAL_FOOTAGE",
        "scenarios": list(scenarios),
        "sceneTags": ["real"],
        "groundTruth": None,
        "note": note,
        "sha256": sha256_file(path),
        "consent": consent,
        "capture": {"device": device, "capturedAt": captured_at, **measured},
    }


def extract_frames(path: str, out_dir: str, *, target_fps: float = 2.0) -> Dict[str, object]:
    """Write the **exact frames the benchmark will score**, numbered as it numbers them.

    ⭐ **This is what makes annotation possible at all, and it is deliberately tiny.** An annotator
    working from the video would have to guess which instants were sampled; working from these files
    the `frameIndex` alignment is exact by construction, which removes the single failure mode
    `align()` exists to catch.

    ⚠️ The stride is the runtime's own integer rule (`round(source/target)`), so the effective rate
    is reported and is what belongs in `annotatedFps` — a 15 fps clip asked for 2.0 is sampled at
    1.875, and an annotator who assumed 2.0 would be describing different instants.
    """
    try:
        import cv2  # noqa: WPS433
    except Exception as exc:  # noqa: BLE001
        raise bc.CorpusError(f"frame extraction needs OpenCV: {exc}") from exc

    os.makedirs(out_dir, exist_ok=True)
    capture = cv2.VideoCapture(path)
    source_fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    if source_fps <= 0:
        capture.release()
        raise bc.CorpusError(f"cannot read a frame rate from '{path}'")
    stride = max(1, round(source_fps / target_fps))
    effective = source_fps / stride

    index = kept = 0
    manifest: List[dict] = []
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if index % stride == 0:
            name = f"frame-{kept:05d}.png"
            cv2.imwrite(os.path.join(out_dir, name), frame)
            manifest.append({"frameIndex": kept, "sourceFrame": index,
                             "atSeconds": round(index / source_fps, 3), "file": name})
            kept += 1
        index += 1
    capture.release()

    summary = {
        "clip": os.path.basename(path),
        "sourceFps": round(source_fps, 3),
        "stride": stride,
        # ⛔ The rate to put in `annotatedFps`. Not the one that was asked for.
        "effectiveFps": round(effective, 6),
        "sourceFrames": index,
        "sampledFrames": kept,
        "frames": manifest,
    }
    with open(os.path.join(out_dir, "frames.json"), "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
        handle.write("\n")
    return summary


def annotation_skeleton(summary: Mapping[str, object], *, case_id: str, clip_sha256: Optional[str]) -> dict:
    """An empty Tier-1 file with one entry per sampled frame, ready for a human to fill in.

    ⛔ **Every frame starts with `"boxes": []`, and that is a claim the annotator must confirm.** An
    empty frame is a positive statement that nothing was there — it is what makes false positives
    measurable — so the skeleton cannot silently pass off "not yet annotated" as "nothing here".
    The `note` says so, and `annotator` is left blank for a person to sign.
    """
    return {
        "schemaVersion": "tier1-2026-08-11",
        "caseId": case_id,
        "clipSha256": clip_sha256,
        "annotatedFps": summary.get("effectiveFps"),
        "annotator": "",
        "note": "⛔ UNFILLED SKELETON. Every frame reads as empty, which is a CLAIM — confirm or "
                "replace each one. An unreviewed empty frame scores every detection in it as a "
                "false positive.",
        "frames": [
            {"frameIndex": f["frameIndex"], "atSeconds": f["atSeconds"], "boxes": []}
            for f in summary.get("frames", [])  # type: ignore[union-attr]
        ],
    }


def skeleton_digest(
    clip_path: str, *, clip_id: str, corpus: Optional[bc.Corpus]
) -> Tuple[Optional[str], List[str]]:
    """Which digest a generated skeleton must carry — ⛔ whatever the case itself declares.

    ⚠️ **A skeleton that is not digest-bound cannot pass its own validator**, and the annotator finds
    out only after the work. The first real ingestion generated exactly that: every skeleton was
    written with `clipSha256: null`, so `align()` reported *"the case is bound by sha256 but these
    annotations declare none"* against a file the tool had produced seconds earlier.

    The rule is to mirror the corpus rather than to invent, because the two footage kinds disagree on
    purpose and `align()` refuses both mismatches:

    - **real footage** is digest-bound — the skeleton carries the case's digest;
    - **constructed fixtures** declare none (git binds file to content), so the skeleton declares none;
    - **an undeclared clip** is bound to the bytes it was actually extracted from, and says so.

    ⛔ A digest is never copied from the case without checking it against the file. Binding a skeleton
    to a digest the extracted pixels do not have would defeat the one check that ties boxes to bytes.
    """
    measured = sha256_file(clip_path)
    case = None
    if corpus is not None and clip_id:
        try:
            case = corpus.by_id(clip_id)
        except bc.CorpusError:
            case = None

    if case is None:
        return measured, [
            f"⚠️ '{clip_id or 'this clip'}' is not declared in the corpus. The skeleton is bound to "
            f"the file it came from (sha256:{measured[:12]}…), but nothing checks its rate or frame "
            f"range until the clip is registered."
        ]
    if case.sha256 is None:
        return None, []
    if case.sha256.lower() != measured:
        raise bc.CorpusError(
            f"'{clip_id}' declares sha256:{case.sha256[:12]}… but the file being extracted is "
            f"sha256:{measured[:12]}…. ⛔ These are different pixels — a skeleton built from one and "
            f"bound to the other would score boxes against footage they were never drawn on."
        )
    return case.sha256.lower(), []


def validate_annotations(
    path: str,
    *,
    corpus: Optional[bc.Corpus] = None,
    case_id: str = "",
    fixtures_root: str = DEFAULT_FIXTURES,
    real_root: str = bc.DEFAULT_REAL_ROOT,
) -> List[str]:
    """Check a finished annotation file. Returns every problem found; empty means PASS.

    ⛔ **This computes no accuracy, modifies nothing, and repairs nothing.** It exists because a
    person finishing two hours of annotation previously had no way to learn whether their file would
    be accepted — `--verify` checks clip digests and `align()` only ran inside a benchmark. Finding
    a rate mistake after the work is the expensive order to find it in.

    ⭐ **Every rule is the one the scorer already applies**, called here rather than restated:
    `annotations.load` for the schema, boxes and keypoints; `align` for digest, rate, range and
    case; `identity_problems` for gtId consistency. A second implementation would eventually
    disagree with the first, and the disagreement would be discovered as an unexplained score.
    """
    try:
        parsed = ann.load(path)
    except ann.AnnotationError as exc:
        # ⛔ Schema failure is terminal: nothing downstream can be checked against a file that did
        # not parse, and listing speculative further problems would be noise.
        return [str(exc)]

    problems: List[str] = []
    if parsed.schema_version != ann.SCHEMA_VERSION:
        problems.append(
            f"schemaVersion is '{parsed.schema_version}', this tool validates "
            f"'{ann.SCHEMA_VERSION}' — the meaning of a field may have changed between them"
        )
    problems.extend(ann.identity_problems(parsed))

    if corpus is None:
        # ⚠️ Reported, never silently skipped: alignment is the half that catches a file describing
        # different pixels, and a PASS that omitted it would be a weaker claim wearing the same word.
        problems.append(
            "⚠️ NOT CHECKED: digest, rate, range and case alignment — pass --corpus and --case to "
            "bind this file to a declared clip. Schema, boxes, keypoints and identity were checked."
        )
        return problems

    wanted = case_id or parsed.case_id
    try:
        case = corpus.by_id(wanted)
    except bc.CorpusError as exc:
        problems.append(str(exc))
        return problems

    clip = os.path.join(bc.root_for(case, fixtures_root, real_root), case.path)
    sampled_fps: Optional[float] = None
    analysed: Optional[int] = None
    if os.path.isfile(clip):
        measured = probe(clip)
        # ⛔ The exact rate, never the rounded one — dividing a 3-decimal copy by the stride refuses
        # a correct annotator. See `probe`.
        source_fps = measured.get("fpsExact", measured.get("fps"))
        frames = measured.get("frames")
        if isinstance(source_fps, (int, float)) and source_fps > 0:
            # ⛔ The runtime's own integer stride, so the rate checked is the rate SAMPLED — a 27 fps
            # clip asked for 2.0 is sampled at 1.929, and comparing against 2.0 would refuse a
            # correct annotator and accept a drifting one.
            stride = max(1, round(float(source_fps) / 2.0))
            sampled_fps = float(source_fps) / stride
            if isinstance(frames, int) and frames > 0:
                analysed = (frames + stride - 1) // stride
    else:
        problems.append(f"⚠️ NOT CHECKED: rate and range — the clip is not present at '{clip}'")

    report = ann.align(
        parsed,
        case_id=case.case_id,
        clip_sha256=case.sha256,
        sampled_fps=sampled_fps,
        analysed_frames=analysed,
    )
    problems.extend(report.problems)
    return problems


def gaps(corpus: bc.Corpus) -> List[str]:
    """Scenarios no real footage covers — ⭐ the recording list, generated rather than maintained."""
    rows = bc.coverage(corpus)
    return [row.scenario for row in rows if row.state != "AVAILABLE"]


def render_gap(corpus: bc.Corpus) -> str:
    rows = bc.coverage(corpus)
    counts = bc.coverage_counts(rows)
    real = bc.real_cases(corpus)
    lines = [
        "# Real footage — what is declared, and what is still needed",
        "",
        f"**{len(real)} real clip(s) declared** · {counts['AVAILABLE']} AVAILABLE · "
        f"{counts['PARTIAL']} PARTIAL · {counts['MISSING']} MISSING of {len(rows)} scenarios",
        "",
    ]
    if real:
        lines += ["| Clip | Scenarios | Captured | Consent |", "| --- | --- | --- | --- |"]
        for case in real:
            capture = dict(case.capture or {})
            lines.append(
                f"| `{case.case_id}` | {', '.join(case.scenarios) or '—'} | "
                f"{capture.get('capturedAt', '—')} | {case.consent} |"
            )
    else:
        lines.append("⛔ **No real footage is declared.** Every scenario below is capped at PARTIAL "
                     "at best, whatever authored material backs it.")
    lines += ["", "## Not yet covered by real footage", ""]
    for scenario in gaps(corpus):
        lines.append(f"- `{scenario}`")
    return "\n".join(lines) + "\n"


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Declare and verify real footage for the benchmark corpus")
    parser.add_argument("--corpus", default=DEFAULT_CORPUS)
    parser.add_argument("--fixtures", default=os.environ.get("VIP_FIXTURES_DIR", DEFAULT_FIXTURES))
    parser.add_argument("--real-root", default=os.environ.get(bc.REAL_ROOT_ENV, bc.DEFAULT_REAL_ROOT))
    parser.add_argument("--verify", action="store_true", help="re-hash every declared real clip")
    parser.add_argument("--gap", action="store_true", help="what recording would unblock most")
    parser.add_argument("--register", default="", help="path to a real clip to declare")
    parser.add_argument("--clip-id", default="")
    parser.add_argument("--scenarios", default="", help="comma-separated, from SCENARIOS")
    parser.add_argument("--consent", default="", help="⛔ required: a lawful-basis record to reference")
    parser.add_argument("--device", default="", help="camera and mounting, e.g. 'iPhone 13, tripod'")
    parser.add_argument("--captured-at", default="", help="YYYY-MM-DD")
    parser.add_argument("--note", default="")
    parser.add_argument("--write", action="store_true", help="append the entry to the corpus manifest")
    parser.add_argument("--list-scenarios", action="store_true")
    parser.add_argument("--extract-frames", default="", help="clip to extract sampled frames from")
    parser.add_argument("--frames-out", default="", help="directory for the extracted frames")
    parser.add_argument("--target-fps", type=float, default=2.0)
    parser.add_argument(
        "--validate-annotations",
        default="",
        help="check a finished annotation file. ⛔ Computes no accuracy and changes nothing",
    )
    parser.add_argument("--case", default="", help="the corpus case to align the annotations against")
    args = parser.parse_args(argv)

    if args.validate_annotations:
        return _validate(args)

    if args.extract_frames:
        if not args.frames_out:
            print("⛔ --extract-frames needs --frames-out", file=sys.stderr)
            return 2
        # ⚠️ Loaded before any frame is written, so a clip whose digest disagrees with its declared
        # case fails before an annotator is handed 37 images to work from.
        declared: Optional[bc.Corpus] = None
        try:
            declared = bc.load(
                args.corpus, root=args.fixtures, real_root=args.real_root, require_files=False
            )
        except bc.CorpusError:
            declared = None
        try:
            digest, notes = skeleton_digest(
                args.extract_frames, clip_id=args.clip_id, corpus=declared
            )
            summary = extract_frames(args.extract_frames, args.frames_out, target_fps=args.target_fps)
        except bc.CorpusError as exc:
            print(f"⛔ {exc}", file=sys.stderr)
            return 2
        skeleton = annotation_skeleton(
            summary, case_id=args.clip_id or "UNNAMED-CASE", clip_sha256=digest
        )
        with open(os.path.join(args.frames_out, "annotations.skeleton.json"), "w", encoding="utf-8") as h:
            json.dump(skeleton, h, indent=1)
            h.write("\n")
        print(
            f"✓ {summary['sampledFrames']} frame(s) from {summary['sourceFrames']} "
            f"(stride {summary['stride']}) → {args.frames_out}"
        )
        # ⛔ Printed every time, because it is the number that goes in `annotatedFps` and it is NOT
        # the rate that was requested.
        print(f"⚠️ annotate at the EFFECTIVE rate: {summary['effectiveFps']} fps (asked for {args.target_fps})")
        for note in notes:
            print(note)
        if digest:
            print(f"✓ skeleton bound to sha256:{digest[:12]}…")
        return 0

    if args.list_scenarios:
        for scenario in bc.SCENARIOS:
            print(scenario)
        return 0

    if args.register:
        return _register(args)

    try:
        corpus = bc.load(args.corpus, root=args.fixtures, real_root=args.real_root, require_files=False)
    except bc.CorpusError as exc:
        print(f"⛔ corpus: {exc}", file=sys.stderr)
        return 2

    if args.gap:
        print(render_gap(corpus))
        return 0

    # --verify is the default: the question this tool is usually asked.
    findings = bc.verify_real_footage(corpus, args.real_root)
    declared = len(bc.real_cases(corpus))
    if not declared:
        # ⚠️ Reported as a fact, not as success. "Nothing failed" and "nothing was checked" are
        # different claims, and only one of them is a green tick.
        print(f"⚠️ no real footage is declared in '{corpus.version}' — nothing to verify")
        return 0
    for case_id, problem in findings:
        print(f"⛔ {case_id}: {problem}", file=sys.stderr)
    if findings:
        print(f"⛔ {len(findings)} of {declared} declared clip(s) failed verification", file=sys.stderr)
        return 1
    print(f"✓ {declared} declared real clip(s) match their checksums")
    return 0


def _register(args) -> int:  # noqa: ANN001
    path = args.register
    if not os.path.isfile(path):
        print(f"⛔ no such clip: {path}", file=sys.stderr)
        return 2
    missing = [
        flag
        for flag, value in (
            ("--clip-id", args.clip_id),
            ("--consent", args.consent),
            ("--device", args.device),
            ("--captured-at", args.captured_at),
            ("--scenarios", args.scenarios),
        )
        if not value
    ]
    if missing:
        # ⛔ Never defaulted. Consent especially: a default would record somebody else's decision,
        # and the whole point of the field is that an auditor can follow it to a real record.
        print(f"⛔ registration requires {', '.join(missing)}", file=sys.stderr)
        return 2

    try:
        entry = entry_for(
            clip_id=args.clip_id,
            path=path,
            file_name=os.path.basename(path),
            scenarios=[s.strip() for s in args.scenarios.split(",") if s.strip()],
            consent=args.consent,
            device=args.device,
            captured_at=args.captured_at,
            note=args.note,
        )
    except bc.CorpusError as exc:
        print(f"⛔ {exc}", file=sys.stderr)
        return 2

    print(json.dumps(entry, indent=2))
    if not args.write:
        print(
            f"\n⚠️ Not written. Copy the clip to '{args.real_root}/{entry['path']}' and re-run with "
            f"--write, or paste the entry into the corpus manifest by hand.",
            file=sys.stderr,
        )
        return 0

    with open(args.corpus, "r", encoding="utf-8") as handle:
        doc = json.load(handle)
    if any(c.get("caseId") == entry["caseId"] for c in doc.get("cases", [])):
        print(f"⛔ '{entry['caseId']}' is already declared", file=sys.stderr)
        return 2
    doc.setdefault("cases", []).append(entry)
    with open(args.corpus, "w", encoding="utf-8") as handle:
        json.dump(doc, handle, indent=2)
        handle.write("\n")
    print(f"\n✓ declared '{entry['caseId']}' in {args.corpus}", file=sys.stderr)
    return 0



def _validate(args) -> int:  # noqa: ANN001
    """`--validate-annotations`. ⛔ PASS or FAIL, every error listed, nothing repaired."""
    if not os.path.isfile(args.validate_annotations):
        print(f"⛔ no such annotation file: {args.validate_annotations}", file=sys.stderr)
        return 2

    # ⭐ Binding is opt-in via `--case`, so the two modes are a choice rather than an accident of
    # whether a default corpus file happens to exist. Without it the file is still fully checked for
    # schema, boxes, keypoints and identity — and the report says what it could not check.
    corpus = None
    if args.case:
        try:
            corpus = bc.load(
                args.corpus, root=args.fixtures, real_root=args.real_root, require_files=False
            )
        except bc.CorpusError as exc:
            print(f"⛔ corpus: {exc}", file=sys.stderr)
            return 2

    problems = validate_annotations(
        args.validate_annotations,
        corpus=corpus,
        case_id=args.case,
        fixtures_root=args.fixtures,
        real_root=args.real_root,
    )
    # ⚠️ A "NOT CHECKED" note is a disclosure, not a defect: it must not fail the file, and it must
    # not be hidden either — a PASS that quietly skipped alignment is a weaker claim wearing the
    # same word.
    errors = [p for p in problems if not p.startswith("⚠️ NOT CHECKED")]
    notes = [p for p in problems if p.startswith("⚠️ NOT CHECKED")]

    for note in notes:
        print(note)
    for problem in errors:
        print(f"  ⛔ {problem}", file=sys.stderr)

    if errors:
        print(f"\nFAIL — {len(errors)} problem(s) in {args.validate_annotations}", file=sys.stderr)
        return 1
    print(f"\nPASS — {args.validate_annotations}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

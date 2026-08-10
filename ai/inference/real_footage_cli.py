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
from typing import Dict, List, Optional, Sequence

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
                "fps": round(fps, 3),
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
    args = parser.parse_args(argv)

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


if __name__ == "__main__":
    raise SystemExit(main())

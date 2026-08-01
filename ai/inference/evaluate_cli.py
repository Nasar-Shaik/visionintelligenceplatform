"""`vip evaluate` — run the CCTV dataset library and report accuracy (AI-5e, Architect priority 1).

    python evaluate_cli.py --coverage                       # what the corpus covers, and its gaps
    python evaluate_cli.py --all --output eval-out          # run every case with footage present
    python evaluate_cli.py --category loitering             # one scenario
    python evaluate_cli.py --case loitering/entrance-dwell-01 --playground pg-out
    python evaluate_cli.py --all --baseline eval-baseline.json   # regression gate

**In CI this exits 0 with everything skipped**, because the DVC footage is not pulled and a case with
no footage reports `footage-missing` — never a pass. That is deliberate: the gate is `--gate`, which
requires that at least one case was actually evaluated. A green run that evaluated nothing is the
exact false assurance the corpus exists to prevent, so you have to ask for the strict behaviour and it
tells you plainly when it cannot give it.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import List, Optional

from dataset import DatasetLibrary, render_coverage
from evaluation import EvaluationReport, Finding, render_summary, run_case, summarize

RUNTIME_VERSION = "1.0.0"


def _load_baseline(path: str) -> List[EvaluationReport]:
    """Rehydrate an accepted accuracy baseline. Only the fields the comparison reads are restored —
    a baseline is a scoreboard, not a full replay."""
    with open(path, encoding="utf-8") as fh:
        payload = json.load(fh)
    out: List[EvaluationReport] = []
    for entry in payload.get("reports", payload if isinstance(payload, list) else []):
        report = EvaluationReport(
            id=entry.get("id", ""),
            case_id=entry["caseId"],
            category=entry["category"],
            status=entry["status"],
            runtime_version=entry.get("runtimeVersion", RUNTIME_VERSION),
        )
        report.findings = [
            Finding(
                kind=f.get("kind", "behavior"),
                type=f.get("type", ""),
                outcome=f.get("outcome", "match"),
                expected_count=f.get("expectedCount"),
                observed_count=int(f.get("observedCount") or 0),
            )
            for f in entry.get("findings") or []
        ]
        out.append(report)
    return out


def run(args: argparse.Namespace) -> int:
    library = DatasetLibrary(args.root).load()

    if args.coverage:
        print(render_coverage(library.coverage()))
        missing = library.missing_footage()
        if missing:
            print(f"\n{len(missing)} case(s) have no footage on this machine:")
            for case in missing:
                print(f"  {case.id:<44} {case.footage.path}")
            print("\nPull the footage with `dvc pull` before these can be evaluated.")
        return 0

    if args.case:
        case = library.get(args.case)
        if case is None:
            print(f"error: no dataset case '{args.case}'", file=sys.stderr)
            return 2
        cases = [case]
    elif args.category:
        cases = library.cases(category=args.category)
        if not cases:
            print(f"no cases in category '{args.category}' yet.", file=sys.stderr)
            return 0
    elif args.all:
        cases = library.cases()
    else:
        print(render_coverage(library.coverage()))
        print("\nNothing selected. Use --all, --category <name> or --case <id>.")
        return 0

    reports = [
        run_case(case, engine=args.engine, runtime_version=RUNTIME_VERSION, max_frames=args.max_frames)
        for case in cases
    ]
    for report in reports:
        _print_case(report)

    baseline = _load_baseline(args.baseline) if args.baseline else None
    summary = summarize(reports, baseline=baseline, runtime_version=RUNTIME_VERSION)
    print()
    print(render_summary(summary))

    if args.output:
        os.makedirs(args.output, exist_ok=True)
        _write(
            os.path.join(args.output, "evaluation.json"),
            {"summary": summary, "reports": [r.to_dict() for r in reports]},
        )
        print(f"\nartifacts written to {os.path.abspath(args.output)}")

    if not args.gate:
        return 0
    # --gate: a strict regression gate. Skipped cases are a failure here, because the gate's whole
    # purpose is to assert that accuracy was measured, not merely that nothing crashed.
    if summary["skipped"]:
        print(
            f"\nGATE FAILED: {summary['skipped']} case(s) had no footage. A gate that passes without "
            "evaluating anything is worthless — run `dvc pull` first.",
            file=sys.stderr,
        )
        return 1
    if not summary["accepted"]:
        print("\nGATE FAILED: failures or regressions against the baseline.", file=sys.stderr)
        return 1
    print("\nGATE PASSED")
    return 0


def _print_case(report: EvaluationReport) -> None:
    mark = {"pass": "PASS", "fail": "FAIL", "footage-missing": "skip", "error": "ERR "}[report.status]
    print(f"[{mark}] {report.case_id}")
    if report.status == "footage-missing":
        print(f"        {report.notes}")
        return
    for finding in report.findings:
        if finding.outcome == "match":
            continue
        window = f" in {finding.window}" if finding.window else ""
        print(
            f"        {finding.outcome:<17} {finding.kind}/{finding.type}{window} — "
            f"{finding.detail or ''}"
        )
    if report.status == "pass":
        print(
            f"        precision {_pct(report.precision)} · recall {_pct(report.recall)} · "
            f"{report.frames_processed} frames"
        )


def _pct(value: Optional[float]) -> str:
    return "n/a" if value is None else f"{value * 100:.0f}%"


def _write(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
        fh.write("\n")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="vip evaluate",
        description="Evaluate the CCTV dataset library and report accuracy.",
    )
    p.add_argument("--all", action="store_true", help="run every case in the library")
    p.add_argument("--category", help="run one scenario (see --coverage for the list)")
    p.add_argument("--case", help="run one case by id")
    p.add_argument("--coverage", action="store_true", help="print corpus coverage and exit")
    p.add_argument("--engine", default="stub", choices=["stub", "onnx"])
    p.add_argument("--max-frames", type=int, default=None, help="cap frames per case (smoke runs)")
    p.add_argument("--baseline", help="path to an accepted evaluation.json to compare against")
    p.add_argument("--gate", action="store_true", help="exit non-zero on skips, failures or regressions")
    p.add_argument("--output", help="write evaluation.json here")
    p.add_argument("--root", help="dataset root (defaults to ai/datasets)")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    return run(build_parser().parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())

"""Fetch the registered model artifacts named in models/registry.json (P-8 Phase 3).

Run at image build time (`Dockerfile.inference`, `INFERENCE_BACKEND=onnx`) and available locally for
anyone running the real backend outside Docker:

    python fetch_models.py                       # → /opt/vip/models
    python fetch_models.py --dest ./.models      # → a writable dev location
    python fetch_models.py --only yolox-nano

⚠️ **The checksum is the point, not the download.** A build that pulls "whatever is at that URL
today" produces an image whose behaviour depends on a third party's release process; every artifact
is verified against the sha256 in the catalogue and the build fails if it differs. The runtime then
verifies the same digest again at start (model_store.verify), because a byte that changed between
build and run changes what the product detects.

Stdlib only — this runs in the image layer *before* pip has installed anything.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import urllib.error
import urllib.request
from typing import List, Optional, Sequence

from model_store import DEFAULT_ARTIFACT_DIR, DEFAULT_CATALOGUE, ModelStore, RegisteredModel, sha256_file

_TIMEOUT_SECONDS = 300
_USER_AGENT = "vip-inference-runtime/model-fetch"


def fetch(model: RegisteredModel, dest_dir: str, *, force: bool = False) -> str:
    """Download one artifact into `dest_dir` and verify it. Returns the final path."""
    target = os.path.join(dest_dir, model.artifact)
    if os.path.isfile(target) and not force:
        if sha256_file(target) == model.sha256:
            print(f"  ✓ {model.id}: already present and verified")
            return target
        print(f"  ! {model.id}: present but checksum differs — re-downloading")

    if not model.source:
        raise SystemExit(f"model '{model.id}' has no source URL and no verified artifact on disk")

    os.makedirs(dest_dir, exist_ok=True)
    # ⚠️ Download to a temp file in the SAME directory and rename only after the checksum passes, so
    # an interrupted build can never leave a half-written artifact that looks like a model.
    handle, staged = tempfile.mkstemp(dir=dest_dir, prefix=f".{model.artifact}.", suffix=".part")
    os.close(handle)
    try:
        request = urllib.request.Request(model.source, headers={"User-Agent": _USER_AGENT})
        with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:  # noqa: S310
            with open(staged, "wb") as out:
                while True:
                    block = response.read(1024 * 256)
                    if not block:
                        break
                    out.write(block)
    except (urllib.error.URLError, OSError) as exc:
        _unlink(staged)
        raise SystemExit(f"model '{model.id}': download failed from {model.source}: {exc}") from exc

    digest = sha256_file(staged)
    if digest != model.sha256:
        size = os.path.getsize(staged)
        _unlink(staged)
        raise SystemExit(
            f"model '{model.id}': checksum mismatch — registered sha256:{model.sha256}, "
            f"downloaded sha256:{digest} ({size} bytes from {model.source}). "
            "The artifact at that URL is not the one this platform registered."
        )
    os.replace(staged, target)
    print(f"  ✓ {model.id}: {os.path.getsize(target)} bytes, sha256 verified")
    return target


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch + verify registered model artifacts.")
    parser.add_argument("--catalogue", default=DEFAULT_CATALOGUE, help="path to models/registry.json")
    parser.add_argument("--dest", default=DEFAULT_ARTIFACT_DIR, help="artifact directory")
    parser.add_argument("--only", action="append", default=[], help="model id (repeatable)")
    parser.add_argument("--force", action="store_true", help="re-download even if verified")
    parser.add_argument("--verify-only", action="store_true", help="check what is on disk; download nothing")
    args = parser.parse_args(argv)

    store = ModelStore.load(args.catalogue, artifact_dir=args.dest)
    wanted: List[RegisteredModel] = [m for m in store.all() if not args.only or m.id in args.only]
    if not wanted:
        print(f"no models matched {args.only}", file=sys.stderr)
        return 2

    print(f"model store → {args.dest} ({len(wanted)} of {len(store)} registered)")
    for model in wanted:
        # ⛔ A disabled entry is a *registered* model this deployment does not run — a decoder that
        # exists for a family whose artifact the product deliberately does not ship (an AGPL model a
        # customer must licence themselves), or one exported locally and mounted for benchmarking.
        # Fetching it would fail a build over a model nobody enabled, so the check that matters is
        # moved to where it belongs: `model_store.verify()` at process start, for enabled models only.
        if model.status != "enabled" and not args.only:
            print(f"  – {model.id}: skipped ({model.status}; enable it in the catalogue to fetch)")
            continue
        if args.verify_only:
            store.verify(model)
            print(f"  ✓ {model.id}: verified")
        else:
            fetch(model, args.dest, force=args.force)
    return 0


def _unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


if __name__ == "__main__":
    raise SystemExit(main())

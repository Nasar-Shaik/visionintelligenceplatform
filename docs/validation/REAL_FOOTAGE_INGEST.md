# Real-footage ingest and replay — P3.2

**2026-08-11.** How a recording of real people becomes benchmark evidence, and what refuses to let it
become anything else.

> ⭐ **Replay was never the missing piece.** A clip already runs through the production pipeline two
> ways, and neither needed a change to accept real footage. What was missing was the **declaration**:
> provenance strong enough that real footage cannot be confused with a rendered fixture, and a
> checksum binding the manifest to the bytes.

---

## 1. The two replay paths that already exist

| Tier | Command | What it exercises |
| --- | --- | --- |
| **Runtime** | `detector_benchmark_cli.py --corpus … --real-root …` | decode → sample → preprocess → detect → track → behaviour → events, via `VideoAnalyzer` |
| **Platform** | `tools/validation/object-association.mjs --clip <file>` | the deployed chain: upload → analysis → events → behaviour → evidence + WHY |

⛔ **Neither was rebuilt and neither should be.** A second ingest path would be a second thing to
keep faithful to production, which is the defect the benchmark lab exists to avoid.

---

## 2. Declaring a clip

```
python3 real_footage_cli.py --register <clip.mp4> \
    --clip-id walk-01 \
    --scenarios normal-person,front-facing-person,person-entering-frame \
    --consent  docs/validation/consent/2026-08-12-colleagues.md \
    --device   "iPhone 13, tripod, 2.4 m" \
    --captured-at 2026-08-12
```

It prints a manifest entry and writes nothing. `--write` appends it to
`ai/inference/benchmarks/detector-corpus.json`.

### ⛔ What it refuses

| Refusal | Why |
| --- | --- |
| **No `--consent`** | video of identifiable people is not declared on a label. A boolean would record no decision and a default would record somebody else's |
| **No `--device` / `--captured-at`** | provenance is what distinguishes a recording from a render |
| **A scenario not in `SCENARIOS`** | nothing reports it, so the claim would be silent |
| **Declaring ground truth** | annotations do not exist when a clip is filmed; a path to one would authorise precision and recall for a case nothing can score |

⚠️ **The pixels never enter the repository.** Clips live in `.data/real/` (git-ignored); the manifest
entry — provenance, dimensions, digest — is what gets committed. This is the convention
`object-corpus.mjs` established for photographs, applied to video.

---

## 3. Why a mislabel is structurally impossible

P3.1 made it impossible to *promote* authored material. The opposite mistake is the live one: real
footage misfiled as `AUTHORED` is a genuine measurement discarded as a rendered rectangle, and a
recording of identifiable people held with no consent record.

```
REAL_FOOTAGE          must carry  sha256 + capture + consent   →  resolves under .data/real
AUTHORED / SYNTHETIC  must carry  none of them                 →  resolves under the repo fixtures
/ PHOTOGRAPH
```

⭐ Relabelling fails in **either** direction, and the error names the likely mistake. Because the two
kinds resolve under different roots, a mislabel is additionally a *missing file* rather than a quiet
reclassification — the guard is structural, not clerical.

---

## 4. Verifying

```
python3 real_footage_cli.py --verify      # re-hash every declared clip
python3 real_footage_cli.py --gap         # what recording would unblock most
```

⛔ **A mismatch is never repaired by re-declaring the digest.** Phones re-encode on export and files
get overwritten in place; a measurement quietly re-run against different pixels produces a plausible
number that describes nothing.

⚠️ With nothing declared, `--verify` prints *"no real footage is declared — nothing to verify"* and
exits 0. **That is a fact, not a pass.** "Nothing failed" and "nothing was checked" are different
claims, and only one of them is a green tick.

---

## 5. The path, demonstrated end to end

2026-08-11, on the one real clip that exists on this machine — a 19.04 s, 1080×1920, 27 fps handheld
phone recording already used for soak testing, declared into a **local** corpus:

| | yolox-nano | rtdetr-r18vd |
| --- | ---: | ---: |
| Frames (2 fps sampling) | 34 | 34 |
| Detections | 29 | 43 |
| Detections/frame | 0.853 | 1.265 |
| Tracks | 4 | 8 |
| Events | 32 | 46 |
| Inference avg | 37.9 ms | 780.4 ms |
| FPS | 2.85 | 0.84 |
| Peak RSS | 273 MiB | 497 MiB |

⛔ **This settles nothing, and the report says so itself.** RT-DETR produced 48 % more detections and
twice the tracks on identical frames. With no annotations, *nothing distinguishes a detector that
found more people from one that found more false positives* — which is exactly why ground truth, not
another model, is the next expensive thing worth buying.

⭐ What it does establish: the ingest → declare → verify → replay → report path executes on real
footage; the promotion gate opens only for `REAL_FOOTAGE` (4 of 41 scenarios reached `AVAILABLE`);
and the report's refusal to name a winner survives real footage being present.

⚠️ **This clip is not declared in the committed corpus.** Its lawful basis has not been confirmed, so
it was registered with an explicit placeholder consent string for a local demonstration only. The
committed corpus remains 16 `AUTHORED` + 1 `PHOTOGRAPH`, 0 `REAL_FOOTAGE`. ⛔ It must not be promoted
into declared evidence until an operator confirms the basis on record.

---

## 6. When the controlled footage is recorded

See `FOOTAGE_ACQUISITION.md` for the priority order and the annotation plan. Then, per clip:

1. `--register` it with its consent record, device and capture date.
2. Copy it to `.data/real/`.
3. `--verify`.
4. Re-run the **identical** benchmark command — ⚠️ no methodology change, or before and after are
   not comparable.
5. ⛔ `tests/test_benchmark_corpus.py::test_no_case_is_real_footage_today` **will fail.** That is the
   tripwire saying the corpus has changed character, and the signal to revisit every conclusion drawn
   from the authored one.

# ai/datasets/ — Dataset Registry (DVC)

Versioned datasets tracked with **DVC**, stored on the **MinIO** S3 remote `vip-datasets`
(docs/architecture/08 §3). **Data does not live in git** — only small `*.dvc` pointer files
and metadata do; the bytes live in object storage.

> **Phase 0:** the remote + config are bootstrapped; no datasets are tracked yet. This
> README is the place raw → labeled → split lineage and consent/licensing metadata get
> recorded as datasets arrive (P3+).

## Setup (once)

DVC is already initialised at the repo root ([`.dvc/config`](../../.dvc/config)) with the
`minio` remote. Install and provide credentials (never commit them):

```bash
pip install -r ai/mlops/requirements.txt        # installs dvc + dvc-s3

# Credentials go in .dvc/config.local (gitignored) or the environment — NOT .dvc/config:
dvc remote modify --local minio access_key_id "$AWS_ACCESS_KEY_ID"
dvc remote modify --local minio secret_access_key "$AWS_SECRET_ACCESS_KEY"
# (endpointurl is already s3://vip-datasets @ http://localhost:49000 in .dvc/config)
```

## Track a dataset

```bash
# Add data under ai/datasets/<name>/, then:
dvc add ai/datasets/raw/sample-set
git add ai/datasets/raw/sample-set.dvc ai/datasets/raw/.gitignore
dvc push                       # uploads bytes to MinIO (vip-datasets bucket)
git commit -m "data(dataset): add sample-set"
```

`dvc pull` restores the bytes on another machine from the same pointer.

## Conventions

- **Lineage:** organise as `raw/ → labeled/ → splits/`; record the transformation in each dataset's own README.
- **Consent/licensing + PII:** every source records consent/licence and any anonymisation applied (compliance, docs/architecture/08 §3 and 15).
- **Credentials:** only ever in `.dvc/config.local` or env — the committed `.dvc/config` holds no secrets.

## References

[08-AI-ML-PLATFORM §3](../../docs/architecture/08-AI-ML-PLATFORM.md) · [ai/mlops](../mlops/README.md) · [DVC docs](https://dvc.org/doc).

---

## The CCTV evaluation corpus (AI-5e)

> **Priority 1 of AI-5e:** _"proving that the AI Runtime Architecture v1.0 can reliably detect and
> analyze real-world CCTV scenarios using recorded surveillance footage."_ The corpus is the evidence
> that moves a capability from _runs_ to _works_, and no amount of simulation can supply it.

### Layout

```
ai/datasets/
├── <scenario>/               18 scenarios — see the list below
│   ├── README.md             what it is · what the runtime produces today · the honest gap
│   ├── cases/*.json          DatasetCase manifests — COMMITTED (these are the assertions)
│   └── footage/              the clips — DVC-tracked, .gitignore REFUSES them into git
```

Scenarios: `person_detection` · `tracking` · `queue` · `crowd` · `loitering` · `intrusion` ·
`restricted_area` · `shoplifting` · `cashier_theft` · `suspicious_behavior` · `fire` · `smoke` ·
`violence` · `abandoned_object` · `fall_detection` · `ppe` · `customer_movement` · `staff_movement`.

The list is a **closed enum** in both the contract and `ai/inference/dataset.py`. An open string would
let cases accumulate under three spellings of "loitering" and quietly stop functioning as a regression
suite — the failure mode of every test corpus allowed to grow organically.

### A dataset case

```jsonc
{
  "id": "loitering/entrance-dwell-01",
  "category": "loitering", // must match the directory it lives in
  "title": "One subject dwells at the entrance while others pass through",
  "footage": {
    "path": "ai/datasets/loitering/footage/entrance-dwell-01.mp4",
    "origin": "internal-capture", // public-dataset | synthetic | customer-pilot | internal-capture
    "licence": "consented staged capture, 2026-07", // REQUIRED — see below
    "sha256": "…", // optional; pins results to exact bytes
    "durationSeconds": 45.0,
    "fps": 25.0,
    "resolution": "1280x720",
  },
  "zones": [/* generic zone configs the analyzer already consumes */],
  "options": { "behaviors": { "loitering": { "dwell_seconds": 10.0 } }, "targetFps": 5 },
  "expectations": [
    { "kind": "behavior", "type": "loitering", "count": 1, "fromSeconds": 8, "toSeconds": 40 },
    { "kind": "event", "type": "behavior.theft.suspected", "absent": true },
  ],
}
```

### Five rules that keep the corpus honest

1. **A licence or consent basis is required.** The manifest refuses to load without one. Surveillance
   footage of real people is exactly the category of data that must not be casually collected.
2. **Footage never enters git.** Each `footage/.gitignore` refuses everything but `.dvc` pointers. A
   clip committed by accident cannot be un-committed from everyone's clone.
3. **Write expectations from what a _human_ sees, before running the platform.** Expectations derived
   from current output are not a test; they are a snapshot of today's bugs.
4. **Include negative expectations.** In surveillance analytics a false positive costs more than a
   miss: an operator paged four times a night for nothing stops reading the alerts by Thursday, and
   then the misses stop mattering too.
5. **`footage-missing` is never a pass.** In CI, where the bytes are not pulled, every case reports
   skipped and the run is not accepted. A suite that goes green because it evaluated nothing is worse
   than no suite.

### Running

```bash
python ai/inference/evaluate_cli.py --coverage           # what the corpus covers, and its gaps
python ai/inference/evaluate_cli.py --category loitering
python ai/inference/evaluate_cli.py --all --output eval-out
python ai/inference/evaluate_cli.py --all --gate         # strict: skips and regressions fail
```

`--gate` requires that at least one case was actually evaluated, so it cannot pass on a machine with
no footage. Pull the bytes first (`dvc pull`).

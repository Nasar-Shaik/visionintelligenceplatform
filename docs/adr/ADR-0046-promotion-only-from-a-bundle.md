# ADR-0046 — A device's certification status changes only from a bundle, and the verdict is re-derived

- **Status:** Accepted
- **Date:** 2026-08-07
- **Milestone:** P-9 Track A, task A6 (Real Camera Validation — pre-hardware engineering)
- **Extends:** [ADR-0024](ADR-0024-camera-lifecycle-evidence-gate.md) (the camera lifecycle evidence
  gate). **Related:** [CONSTRAINTS §18](../project/CONSTRAINTS.md) (simulation never certifies),
  [ADR-0023](ADR-0023-onvif-discovery-placement.md).
- **Touches:** `ai/inference/camera_registry.py`, `ai/inference/certification.py` (`verdict_for`),
  `ai/inference/certify_cli.py`. No contract changes; the certification contracts stay frozen.

## Context

The camera registry — `profiles/cameras/*.json`, eleven rows, every one `Pending Validation` — is
what the platform will one day point at when a customer asks "do you support this camera?". AI-5e
made two rules structural: a report is only as strong as its **weakest** check, and `certified` is
unreachable without `hardware` evidence. Both held.

⭐ **What P-9 found is that the rules were right and the mechanism around them was not.**

**1 · The only promotion function took a bare dict.** `CameraRegistry.certify(entry_id, summary)`
accepts any mapping with the right keys. A summary produced by a measured run and a summary typed
into a file are indistinguishable to it. The `hardware`-evidence invariant still fired, but only on
the _fields of the summary_, which is exactly the thing an author of a forged summary controls.

**2 · The refusal caused the damage it existed to prevent.** `certify()` mutated the entry and
re-ran the invariants afterwards. Measured, on a summary claiming `certified` from `simulated`
evidence:

```
certify() raised: entry 'acme-x1' claims certification on 'simulated' evidence
in-memory AFTER the refusal -> status: certified | evidenceClass: simulated
WRITTEN TO DISK             -> status: certified | evidenceClass: simulated
```

The next `load()` then refused the entire registry. ⛔ **A caught-and-ignored refusal became a
corrupted profile that bricked the registry on the following start** — and the exception message,
which was correct, is what would stop anyone looking further.

**3 · The deployed image cannot be written to.** `--write-registry` inside the production container
raised `PermissionError` on the first profile. That is deliberate: the process is non-root, `/app` is
root-owned, and gate 0 compares the container's `/app` byte-for-byte against the source. But it means
the exact command a field engineer runs after certifying a real camera could not work.

## Decision

**1 · `promote_from_bundle()` is the only supported way a registry row's status changes.**
`certify()` remains as its implementation detail; `certify_cli --write-registry` goes through the
guarded path, because routing the CLI around its own guard would leave the guard protecting only the
callers who did not need protecting.

**2 · ⭐ The verdict is RE-DERIVED from the bundle's own checks, never read from the status it
claims.** `verdict_for(checks)` applies the same rule as `CertificationHarness._status_for` to
serialised checks. A bundle whose `status` says `certified` while its checks are `simulated` is
refused with both values named.

> Every other integrity check here can be satisfied by someone careful with a text editor. This one
> cannot, because it derives the answer from the evidence rather than reading the conclusion.

**3 · A refusal leaves the entry and the file exactly as it found them.** The candidate is
constructed and validated before anything is committed.

**4 · The registry directory is configurable** — `--registry-dir` / `VIP_CAMERA_REGISTRY_DIR`. The
fix for an unwritable image is a writable location, never a writable image.

## Consequences

- ✅ There is one promotion path, and it is guarded. Eight refusal tests cover it, including a
  hand-written `certified` and the refusal-leaves-no-damage case.
- ✅ `verdict_for` and `_status_for` are kept in step by `VerdictParityTest` — a complete hardware
  run, a simulated run, a failed check, one simulated check among hardware ones, and **the empty
  list**, which is where two implementations of one rule diverge unnoticed.
- ⚠️ **Two implementations of one rule now exist.** That is a real cost, accepted because a bundle
  arriving from a field engineer's laptop must be judged on what it contains rather than on what the
  process that made it asserts. The parity test is the mitigation, and if either moves the other must
  move with it.
- ⛔ **This is not a signature.** Someone determined can write a bundle whose checks all claim
  `hardware`. Closing that needs signed bundles, and it is worth doing only once bundles actually
  arrive from field engineers rather than from this repository. Recorded as Track B work, not as
  solved.
- ⚠️ Operators must mount a writable registry directory to persist certifications from a deployed
  container. Documented in [P9_TRACK_A_ACCEPTANCE](../project/P9_TRACK_A_ACCEPTANCE.md).

## Alternatives considered

**Keep `certify()` as the entry point and tighten its invariants.** Rejected: the invariants can only
inspect the fields of the object handed to them, and those are precisely what a forged summary
controls. Re-deriving from checks is a different kind of check, not a stricter version of the same one.

**Make the image writable.** Rejected outright. It would break the deployment-integrity property that
lets gate 0 assert a container matches the image it was built from.

**Require a cryptographic signature now.** Rejected as premature. Every bundle today is produced by
this repository on a machine we control; a signing story with no key management is ceremony rather
than security. The threat becomes real when installers start producing bundles, and that is when it
should be built.

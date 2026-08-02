# Architectural Constraints

> **Hard rules future engineers (human or AI) must never violate.** These encode the frozen v1.0 architecture and the Engineering Constitution. A change to any constraint requires an [ADR](../adr/) — not a code review comment.
>
> Many of these are **machine-enforced**; the enforcement mechanism is named so you know what will catch a violation.

## Core design (the Laws)

1. **No industry/customer logic in core.** Industries, connectors, and models are plugins. Core packages/services stay vertical-agnostic (Law 1). — _enforced: `check:imports` noCoreToPlugin; code review._
2. **Contract-first (Law 4).** Add/extend the schema in `@vip/contracts` before writing code that produces or consumes it. Types and JSON Schema derive from one source. — _enforced: contract-testing harness; review._
3. **Tenant isolation, fail-closed (Law 5).** Every record carries `tenantId`; no operation runs without resolved tenant context; on doubt, deny. — _enforced (from P1): data-layer guard + isolation test suite. Phase 0: seam only, see [ED-0013]._
4. **The architecture is frozen at v1.0.** Every architectural change goes through an ADR. No silent redesign. — _enforced: review; `docs/adr/`._

## Boundaries & coupling

5. **Never access another bounded context's database directly.** Read another context's data only via its API or its published events (22 golden rule). — _enforced: review; import-graph (cross-context DB check planned)._
6. **Never couple plugins to core internals, and never let core import a plugin.** — _enforced: `check:imports` noCoreToPlugin._
7. **Never deep-import another package's internals.** Import a package by its public entry only (`@vip/contracts`, not `@vip/contracts/src/...`). — _enforced: `check:imports` noDeepImports._
8. **Never import another service's code.** Cross-service communication is API/events only. — _enforced: `check:imports` noCrossServiceInternals._
9. **The package/service dependency graph stays acyclic.** — _enforced: `check:imports` noCycles._
10. **Domain layer imports nothing from transport/adapters or any framework.** Call direction is `transport → application → domain`; adapters implement ports. — _enforced: review; layering convention._

## Runtime platform (become enforceable as the engines land)

11. **Never bypass the Event Engine** for cross-context propagation once it exists. Side effects across contexts flow through events (outbox pattern), not direct calls. — _enforced (future): review; architecture tests._
12. **Never bypass the Policy Engine** for authorization/governance decisions once it exists. The Rule Engine (business logic) is distinct from the Policy Engine (who/what/where/when) — ADR-0013. — _enforced (future): PDP hooks._
13. **Never hardcode customer-specific logic** anywhere in core, capabilities, or shared packages. — _enforced: review; import-graph._
14. **Every service exposes `/health`, `/ready`, `/metrics`** and emits events via the outbox pattern. — _enforced: service template; review._
    14b. **Never commit model weights or dataset bytes to git.** They live in the registry / object storage — models in MLflow (+MinIO), datasets in DVC (+MinIO). Git holds only pointers (`*.dvc`), model cards, and metadata. — _enforced: `.gitignore` (weights/`/datasets/`) + DVC; review._
    14c. **Reference models by registry selector, never by hardcoded path/vendor** ([ADR-0002](../adr/ADR-0002-model-agnostic-inference.md)). — _enforced: review; capability contract._

## AI Runtime evidence discipline (v1.0 closed 2026-08-01 — these are permanent)

<!-- §25–29 extend the same discipline to devices and to the operational evidence layer (P-2 · P-2.1 ·
     P-2.2). The operational evidence subsystem was declared complete and frozen at the P-2.2 review. -->

> Recorded at the **AI-5e acceptance / AI Runtime Architecture v1.0 closure** review (Architect, 7
> recommendations). The runtime architecture is now **frozen and closed**; it evolves through better
> models, faster implementations and hardware integrations — **not through structural expansion**.
> These seven rules outlive the phase that produced them.

18. **Never certify hardware without measured evidence.** Simulation validates architecture; physical
    devices validate production. A device stays `pending-validation` until a run against the physical
    unit says otherwise. — _enforced: `certification.CertificationHarness._status_for()` returns
    `pending-validation` for any evidence class below `hardware`; `CameraRegistryEntry` **refuses to
    construct** a `certified` row with no evidence or sub-hardware evidence; negative control
    `tests/test_certification.py::EvidenceClassTest::test_a_flawless_simulated_run_is_still_not_certified`._
19. **Never promote capability maturity manually.** Promotion goes through `maturity.promote()` with the
    **ids** of the reports that justify it: Experimental → Beta needs a passing recorded-footage
    evaluation; Beta → Production needs, additionally, a `certified` compatibility run, a passed soak and
    a non-regressing benchmark. Demotion needs nothing — discovering something is worse than believed
    must never be harder than claiming it is better. — _enforced: `maturity.py`; `tests/test_maturity.py`.
    A hand-edit of [CAPABILITY_MATURITY](../architecture/future/CAPABILITY_MATURITY.md) is a constraint
    violation, not a documentation update._
20. **Grow the CCTV dataset library; it is the asset.** Future perception improvements come from **better
    datasets, not deeper runtime abstraction**. Every case records a licence or consent basis, expectations
    written from what a **human** saw (never from current output), and at least one **negative** expectation
    — a false positive costs a deployment more than a miss. — _enforced: `dataset.py` refuses a case with
    no licence and a case filed under the wrong scenario; footage `.gitignore` refuses bytes into git;
    `evaluate_cli.py --gate` treats `footage-missing` as a failure, never a pass._
21. **Expand the compatibility registry with every deployment.** A validated device permanently records
    manufacturer · model · firmware · codecs · stream profiles · ONVIF capabilities · known issues ·
    benchmark history · certification history. The fifth Hikvision deployment should cost a fraction of
    the first, and that only happens if the first wrote down what it learned. — _enforced:
    `profiles/cameras/*.json` are data, not code; `CameraRegistry.certify()` is the only mutator, and
    discovery deliberately **never** changes a status._
22. **The AI Playground is the primary engineering workbench.** Every new model, behaviour and
    optimization proves itself there — annotated video, timeline, incident candidates, performance
    breakdown — **before** it reaches production. — _enforced: review; `playground_cli.py` +
    `report.html` are the artifact of record for a change to perception._
23. **Maintain benchmark governance.** Baseline → optimization → benchmark → regression comparison →
    accept or reject. No performance claim without a comparison against the accepted baseline, and no
    comparison across differing configuration or hardware fingerprints. — _enforced:
    `benchmark_cli.py --baseline` **exits non-zero on regression**; `BenchmarkComparison.comparable`
    guards fingerprint mismatch; `--scenarios` folds the 17 production simulations into the same gate._
24. **Keep architectural discipline: no new abstraction layer without necessity.** AI Runtime
    Architecture v1.0 is complete. Improve it through implementation quality, not structural expansion;
    a new layer requires an ADR and a platform-wide justification. "It would be convenient here" is not
    one. — _enforced: `check:imports`; ADR requirement; review._
25. **A camera's operational state requires measured evidence.** `connected` · `monitoring` ·
    `degraded` · `offline` are claims about a physical device and may only be entered from a probe of
    that device (`EvidenceClass: hardware`). `discovered` · `validated` · `configured` are declared;
    `retired` is administrative and is not reversible by a health check. This is §18 applied to
    devices instead of capabilities, and for the same reason: a platform that can talk itself into
    "connected" from a simulation reports estates that do not exist. — _enforced:
    `services/camera/src/domain/lifecycle.ts` refuses the transition; `stateForProbe()` returns
    `null` for non-hardware evidence; negative controls in `stream_probe`, `lifecycle.test.ts` and
    the camera-service HTTP tests. [ADR-0024](../adr/ADR-0024-camera-lifecycle-evidence-gate.md)._
26. **One evidence vocabulary, platform-wide.** `EvidenceClass` lives in
    `@vip/contracts/common/evidence.ts` and is read by certification, capability maturity, benchmarks
    and the camera lifecycle alike. A second evidence vocabulary would drift, and a drifted evidence
    vocabulary is how a simulation starts counting as a measurement somewhere nobody is looking. —
    _enforced: one definition, imported not re-exported, so the barrel exports exactly one; review._
27. **Stored evidence is never modified.** A probe report is written once and read thereafter: there
    is no update path against the probe archive, a correction is a **new** record, and retention
    drops whole reports while reporting how many it dropped. The same rule governs identity history
    and the compatibility register — older rows survive the conditions that produced them, because
    "it worked on V5.7.9 and has failed since V5.8.0" _is_ the diagnosis and a current-status field
    erases it. — _enforced: `services/camera/src/domain/probe-archive.ts` exposes no mutator;
    `CameraService.archive()` only ever inserts; `CameraProbeHistory.evicted` makes a trimmed archive
    self-declaring; `test/evidence.test.ts` + the P-2.2 HTTP tests._
28. **Replay reconstructs, it never re-measures.** Reconstructing a stored probe contacts nothing:
    `replayProbe()` is a pure function over a record, with no camera, network or probe port in scope,
    and its route is a `GET`. Support work happens days after a failure, frequently on a camera since
    power-cycled into working — re-probing then measures a different moment and answers "it works
    now", which closes the ticket without explaining anything. — _enforced: the function's signature;
    `GET /cameras/:id/probes/:probeId`; an HTTP test that counts probe invocations across a replay._
29. **One validation engine, many providers.** Every source type the platform validates — RTSP, HTTP,
    WebRTC, SRT, recorded video, DVR export, NVR playback, USB camera, edge stream — runs the same
    staged pipeline. A new source type is a `register_provider(...)` row declaring which stages it
    has, never a second validation path. Two validation paths would grow two definitions of
    "connected", which is precisely what §25 exists to prevent. — _enforced:
    `ai/inference/stream_probe.py` selects stages from the registry and never branches on a provider
    id; `tests/test_stream_probe.py::TestValidationProviders` asserts every provider answers the same
    stage list and that a newly registered one works without touching the engine._

## Engineering process

15. **Never choose a dependency version from memory.** Registry-verify latest stable; no alpha/beta/rc unless requested; document in [DEPENDENCIES](DEPENDENCIES.md). — _enforced: CI `--frozen-lockfile`; DEPENDENCIES review._
    15b. **Never read `process.env` directly in business logic.** All configuration flows through `@vip/config` (typed, validated, grouped); Python via `ai/mlops/config.py`. — _enforced: review; [ADR-0018](../adr/ADR-0018-env-only-secrets-and-centralized-config.md)._
    15c. **Never require an external secret manager.** `.env` (dev) / injected env (prod) is the only secrets source; deployment stays `cp .env.example .env → compose up`. Vault/KMS/K8s-Secrets are optional, documentation-only extension points. — _enforced: review; ADR-0018._
16. **Every service/package/plugin/capability ships a `README.md`** (purpose, responsibilities, architecture position, dependencies, config, run, test, extension points). — _enforced: review; [DoD](DEFINITION_OF_DONE.md)._
17. **Every slice satisfies the [Definition of Done](DEFINITION_OF_DONE.md)** and updates all governance trackers before it is Done. — _enforced: end-of-sprint validation._

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

<!-- §25–34 extend the same discipline to devices and to the operational evidence layer (P-2 · P-2.1 ·
     P-2.2 · P-2.3). **Camera Foundation v1.0 is FROZEN** (2026-08-02) — see
     docs/architecture/CAMERA_FOUNDATION_V1.md. §30–34 are that freeze, the rules that survive it, and
     the rule that protects it from the product layers built on top. -->

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
30. **Persist measurements; derive conclusions.** The platform stores observations and evidence —
    probe reports, identity changes, capability reads, compatibility observations. It does **not**
    store confidence, trends, health scores, decision records or summaries: those are computed from
    the evidence on every read. A stored conclusion is a second copy that can drift from what it was
    drawn from, and it freezes an explanation in the words of whatever version wrote it. — _enforced:
    `domain/confidence.ts`, `domain/decisions.ts`, `domain/probe-metrics.ts` are pure functions over
    stored records with no writer; an HTTP test asserts no derived field is ever persisted on a
    camera. The one named exception is `Camera.health`, a coarse rollup predating this rule (ADR-0024
    P-2.3 amendment)._
31. **The Camera Foundation is frozen.** Discovery · camera identity · lifecycle · capability cache ·
    probe pipeline · evidence archive · operational timeline · compatibility tracking are complete.
    They evolve through **additive contracts only** — a new field, a new enum value, a new validation
    provider, a new evidence type. A breaking change requires an ADR and a platform-wide
    justification. Product work builds **on** this foundation, not into it. — _enforced: review; ADR
    requirement; [ADR-0024](../adr/ADR-0024-camera-lifecycle-evidence-gate.md) and its amendments._
32. **The unified evidence timeline is the only investigation API.** Every operational claim resolves
    to evidence through one surface, and every entry carries the same chain-of-custody envelope
    whatever produced it. A consumer must read the envelope rather than switch on the producer, so a
    new evidence type appears without a consumer release. — _enforced:
    `domain/evidence-timeline.ts`; the console's source and producer labels are lookups with a
    fallback, guarded by a test that renders an evidence type the console has never heard of._
33. **Product layers consume foundations; they never redesign them.** P-3's organisation hierarchy
    depends on the Camera Foundation exactly as Rules, Evidence and the Runtime already do — through
    its contracts, as a stable platform dependency. A camera does not learn about sites; a site
    references cameras. When a product layer cannot express something, the answer is an **additive
    contract with an ADR**, never a convenient change to a frozen subsystem: the first exception
    granted is the one that ends the freeze. — _enforced: review; ADR requirement;
    [CAMERA_FOUNDATION_V1](../architecture/CAMERA_FOUNDATION_V1.md);
    [PLATFORM_BOUNDARIES](../architecture/PLATFORM_BOUNDARIES.md)._
34. **Read [FOUNDATION_PRINCIPLES](FOUNDATION_PRINCIPLES.md) before modifying a foundation.** Ten
    principles — persist measurements · derive conclusions · evidence before decisions · deterministic
    runtime · contract-first · architecture freeze · additive evolution · explainability ·
    replayability · auditability — each with the enforcement point that keeps it real. Mandatory
    reading, because every one of them exists where the alternative had already failed silently. —
    _enforced: review; [DoD](DEFINITION_OF_DONE.md)._

## Product layer (from P-3 — these govern everything built on the frozen foundations)

35. **Read [PRODUCT_PRINCIPLES](PRODUCT_PRINCIPLES.md) before adding a product feature.** Customer
    workflows first · configuration over customization · industry-neutral core · multi-tenant by
    default · explainability before automation · evidence before assumptions · simple workflows ·
    progressive disclosure · consistent experience · security by default. A feature must answer:
    _can a customer understand the value of this in a demonstration?_ — and if not, the justification
    is written down rather than assumed. — _enforced: review; [DoD](DEFINITION_OF_DONE.md)._
36. **No industry noun ever enters a type name.** There is no `RetailCamera`, `HospitalZone`,
    `FactoryRule` or `SchoolBehavior`, and there never will be. Industry solutions are configuration,
    profiles and templates over the identical generic platform — a retail and a hospital deployment
    run the same code and differ in their data. — _enforced: review; the AI-4 behavior profiles are
    the pattern._
37. **The backend owns traversal and derivation; the console renders.** Breadcrumbs, labels, depth,
    permitted child types and every other derived value are computed server-side and returned
    resolved. A client that re-derives a rule will disagree with the service the first time the rule
    changes — the P-2 failure-headline defect, exactly. — _enforced:
    [ADR-0025](../adr/ADR-0025-organization-hierarchy.md); `domain/hierarchy.ts`; console tests that
    assert the rendered options are the ones the server sent._
38. **Structural records are archived, never deleted.** Locations, and anything else evidence
    references by id, are retired rather than removed: archiving cascades to the subtree and leaves
    every historical reference resolving. No `DELETE` route exists on such a resource — its absence
    is the guarantee. — _enforced: [ADR-0025](../adr/ADR-0025-organization-hierarchy.md); an HTTP
    test asserts the route is a 404 and a console test asserts no delete control exists._

39. **The Location Hierarchy is frozen (v1.0, 2026-08-02).** Twelve invariants define it — one
    parent · no cycles · valid path · correct depth · depth bounded at 7 by containment · immutable
    id and type · editable name · containment preserved · backend-owned traversal · no deletion ·
    occupant independence · tenant isolation. It evolves by **addition only**; a breaking change
    needs an ADR. Product layers reference locations by id and never reshape them. — _enforced:
    [HIERARCHY_FOUNDATION_V1](../architecture/HIERARCHY_FOUNDATION_V1.md);
    [ADR-0025](../adr/ADR-0025-organization-hierarchy.md); `hierarchy-invariants.test.ts` asserts
    every invariant; `FOUNDATIONS` in `@vip/contracts`._
40. **An index is not coverage until a query plan says so.** Index specifications are declared as
    data and every read the service issues is checked against them: equality keys must occupy a
    contiguous index prefix and the sort key must be the next key. "We created indexes" and "the
    planner will use them" are different claims, and only the second one survives production — the
    P-3 review found three reads whose filter was indexed and whose sort was not, each an in-memory
    sort that is invisible against a fixture. — _enforced: `adapters/indexes.ts` in the tenant and
    camera services; `index-coverage.test.ts` in both, which fails when a query pattern is added
    without a covering index._

41. **Public contracts are frozen; documentation terminology is not.** Vocabulary may improve
    independently of published names — the subsystem frozen as `OrgNode` / `/org-nodes` is _called_
    the Location Hierarchy, and the code keeps its names. **Cosmetic API renames are forbidden:** a
    rename breaks every consumer, every stored document and every integration, in exchange for a
    clearer word. A genuinely misleading name is an ADR with a migration path, not a find-and-replace.
    — _enforced: review; [FOUNDATIONS](FOUNDATIONS.md); the freeze records._
42. **Every foundation change answers the three migration questions.** Can existing data still be
    read · can an existing deployment upgrade without rebuilding · is the migration additive. A field
    added is optional or defaulted, and a reader defaults rather than assuming — that is what additive
    means in a **store** as opposed to in a schema. If any answer is no, it is an ADR carrying the
    migration path. — _enforced: [Foundation Principle 11](FOUNDATION_PRINCIPLES.md); contract tests
    parse a pre-change record and assert the default; review._

43. **Rules are configuration, never code.** The Rule Designer produces a declarative predicate tree
    evaluated by a bounded, sandboxed interpreter — no code generation, no expression evaluation, no
    business logic embedded in the runtime. Configuration is consumed by the runtime; it never
    modifies it. — _enforced: `domain/condition.ts` (data-only operators, no regex, prototype-safe
    field access); [ADR-0026](../adr/ADR-0026-rule-scope-validation-and-explainability.md)._
44. **A check that could not run is not a check that passed.** Reference validation reports `valid`
    and `verified` separately, and a rule is never activated on an unverified check. When the context
    that owns a referenced thing is unreachable, the answer is "not verified" — never "fine". This is
    [Foundation Principle 3](FOUNDATION_PRINCIPLES.md) applied to configuration instead of devices. —
    _enforced: `domain/validation.ts`; ports default to unavailable; tests assert a location-scoped
    rule cannot be enabled with no hierarchy configured._
45. **Nothing in an event-evaluation path may query.** Rule scope, ordering and bounds are resolved
    when a rule is validated and compiled per tenant; evaluating an event touches no store. A lookup
    there is a query per rule per event — the shape that survives a fixture and not production. —
    _enforced: `application/compiled-rules.ts`; a test counts store calls across 1,000 events and
    asserts one._

46. **Diagnostics are derived, never stored.** Fingerprints, dependency graphs, complexity
    measurements and audit timelines are computed from the record on demand — never persisted beside
    the thing they describe, where they can end up disagreeing with it after a migration or a
    restore. A fingerprint that can lie is worse than none, because it is trusted; recomputing is
    microseconds and the recomputation _is_ the verification. Corollary: **one record of one truth** —
    a parallel audit collection written by a second code path eventually contradicts the versions, and
    a derived trail works retroactively on records written before anyone thought to record it. —
    _enforced: [Foundation Principle 2](FOUNDATION_PRINCIPLES.md);
    [ADR-0027](../adr/ADR-0027-rule-operations-diagnostics-and-portability.md); `domain/fingerprint.ts`,
    `domain/audit.ts`; a test asserts a rule renamed or paused keeps its content hash._
47. **What is put in front of live events is gated — not the transition that got it there.** A
    validation gate keyed on a state _change_ misses the larger case: editing something already live.
    P-4 gated activation and left re-scoping a running rule unchecked, which silently took it to
    matching nothing. The gate fires whenever a request leaves a resource live with changed content,
    however it arrived — and never when the request leaves it not-live, so a broken thing can always
    be turned off or fixed-and-parked in one call. — _enforced: `rule-service.ts`;
    [ADR-0027](../adr/ADR-0027-rule-operations-diagnostics-and-portability.md); tests assert
    re-scoping a live rule re-resolves rather than unresolving, and that the same edit passes when it
    also disables._
48. **A domain that removes a field must have a store that removes it.** Mongo `$set` with an object
    lacking a key leaves the stored key untouched, so a field deleted in the domain survives in the
    database and the next reader sees stale truth. Every write of a document with optional fields
    pairs `$set` with an `$unset` for what is absent. — _enforced: `writeOf`/`unsetOf` in
    `mongo-rule-store.ts`; a unit test asserts the exact unset set; the round trip is covered by the
    integration suite._
49. **A recursive schema needs a crash guard that runs before it.** `RuleCondition`-shaped contracts
    parse recursively, so a deeply nested body overflows the stack _inside the parser_ — before
    validation, before any limit, before anything can report it. Depth is checked iteratively on the
    raw body first; the meaningful limit is enforced afterwards with a number that means something to
    an author. — _enforced: `domain/budget.ts` (`rawDepth`, `MAX_BODY_NESTING`); a route test posts a
    5,000-deep body and asserts a 400._
50. **Operational numbers are honest about their scope, and never fabricated.** Per-node counters say
    which node; a hit ratio over zero lookups is zero, not one; a node that is not evaluating returns
    501 rather than zeroes, because an unstarted engine and an idle one produce identical zeroes and
    only one is worth paging about. Cluster totals come from the metrics pipeline, never from summing
    per-node reports across a load balancer. — _enforced: `RuleStatsReport.node`;
    `application/rule-stats.ts`; tests assert the zero-lookup ratio and the 501._
51. **Benchmarks record a baseline, and gates assert a shape.** A recorded number is a comparison
    point on the machine that produced it — never a threshold, never transferable. Regression gates
    assert ratios (cost per unit stays flat as the count grows), which a loaded CI runner does not
    move and a quadratic regression cannot pass. — _enforced:
    [RULE_ENGINE_BASELINE](../architecture/RULE_ENGINE_BASELINE.md); `services/rules/test/scale.test.ts`._

52. **A score is never reported without the reasons that produced it.** Any derived rating —
    health, risk, readiness — carries the findings whose deductions sum to it, and the number is
    computed _from_ that list so the two cannot disagree. A rating nobody can take apart is one people
    learn to ignore, and then a real problem hides behind a 78. Where the inputs could not be checked,
    the answer is **unknown**, never a confident number: `0/100` beside "cannot be checked" reads as
    "this is broken", which is a different and wrong claim. — _enforced: `domain/health.ts`;
    [ADR-0028](../adr/ADR-0028-rule-support-surface-and-the-p5-contract.md); a test asserts the score
    equals `100 −` the sum of the deductions, and another asserts an unverifiable rule is `unknown`._
53. **A composed artifact omits what it does not know; it never zeroes it.** A support bundle,
    report or export leaves a section **absent** when the node has no measurement for it. Zeroes and
    "no data" are different facts and only one is worth acting on — the same reason `/rules/stats`
    returns 501 rather than an idle-looking report. It also never synthesises a derivation that needs
    an input it does not have: an explanation without an event is the most misleading thing a
    diagnostic artifact can contain. — _enforced: `RuleDiagnosticPackage`; tests assert the runtime
    sections are `undefined`, not `0`, on a node that does not evaluate._
54. **A per-item lookup is resolved once per request, not once per item.** Any list view that
    annotates rows from another context batches the lookup for the whole page. The obvious
    implementation turns a list into a load test on a neighbour, and it passes every test written
    against three rows. — _enforced: `searchDiagnostics`; a test creates ten rules and asserts **one**
    hierarchy call._
55. **Structural separation is not a URL rewrite.** Splitting an API into planes, contexts or
    concerns is done in the modules; published paths do not move. A rename breaks every consumer,
    integration and runbook in exchange for tidier prose — §41, applied to the refactor that most often
    forgets it. — _enforced: `rule-authoring.ts` / `rule-operations.ts`; a route test asserts every
    published path still resolves._
56. **A state machine gains states, not adjectives.** Before adding a value to a lifecycle enum, ask
    whether it answers _where is this_ or _whose is this / what is attached to this_. Only the first is
    a state. Assignment, tagging and ownership are operations on an entity in a state — folding them in
    makes every pair of transitions look legal and the table stops carrying information. — _enforced:
    `IncidentStatus` excludes `assigned`; `ALLOWED_FROM` is asserted whole, so widening the lifecycle is
    always a deliberate edit._
57. **A terminal state is terminal for the whole record.** Once an entity reaches its closed/archived
    end state, nothing may be appended — no transition, no assignment, no comment. "Retained for audit"
    is only true if the record stops changing; one that keeps growing is still live under another name.
    — _enforced: `refuseIfSealed`; tests assert a closed incident refuses notes and assignment._
58. **A filter nobody can populate is worse than a missing one.** Do not add a query field whose data
    no producer writes. It parses, it indexes, and it always matches nothing — which reads as "there are
    none" rather than "this cannot be asked". Record the gap instead. — _enforced: `IncidentQuery` omits
    behaviour/composite ids (TD-23); the frozen filter set is asserted in `incident.test.ts`._
59. **An index only counts as narrowing if it consumes a key beyond the tenant.** A tenant-leading
    cursor index serves the sort for _every_ query, so a naive coverage model marks an unindexed filter
    as served while it walks the tenant's whole collection. Classify coverage as `covered` / `bounded` /
    `scan`, and forbid `scan`. — _enforced: `services/workflow/test/index-coverage.test.ts`, including a
    self-test that the model detects both a missing index and one truncated before the cursor._
60. **Index declarations are data, and changing one is a migration.** Declare the index set in a module
    a test can read, build the collection from that declaration, and reconcile a name whose key set
    changed — re-declaring it is an `IndexOptionsConflict` that fails the service at boot. — _enforced:
    `workflow/adapters/indexes.ts`, `events/adapters/indexes.ts`; an integration test recreates the old
    index shape and asserts the service still starts._
61. **A coverage model must model the whole sort, and the filter's cardinality.** Checking only the
    leading sort key declares an index sound that MongoDB will still sort in memory — measured. And an
    unindexed filter is not one failure: a near-unique **identity** filter examines the tenant's whole
    history, while a two-valued **enum** costs `limit ÷ selectivity` and is bounded by the page. Model
    both. — _enforced: `services/evidence/test/index-coverage.test.ts`, whose self-test reproduces the
    exact index that fooled the ported model._
62. **Classify an actor at the moment it acts; never infer it afterwards.** Store who did a thing as a
    typed reference at write time. A record written before typing existed resolves to `unknown`, not
    to a guess from its display string — a person named `system` is an ordinary account, and a
    confident wrong attribution in an immutable audit trail cannot be withdrawn. — _enforced:
    `IncidentActorRef`; `resolveActor` returns `unknown` for every untyped record._
63. **A cross-context read has a call budget, a timeout and a gap.** Any view assembled from other
    contexts states its maximum upstream calls, bounds each with a timeout, and reports every absence
    as a **typed gap** — distinguishing "unavailable", "truncated" and "not requested". Returning the
    partial view is right; returning it silently is not, because an omitted source reads as an empty
    one. Ports for such reads **default to unavailable**, never to an empty result. — _enforced:
    `IncidentTimeline.gaps`; `UnavailableTimelineSources`; tests assert a hung upstream is abandoned
    and reported._

## Engineering process

15. **Never choose a dependency version from memory.** Registry-verify latest stable; no alpha/beta/rc unless requested; document in [DEPENDENCIES](DEPENDENCIES.md). — _enforced: CI `--frozen-lockfile`; DEPENDENCIES review._
    15b. **Never read `process.env` directly in business logic.** All configuration flows through `@vip/config` (typed, validated, grouped); Python via `ai/mlops/config.py`. — _enforced: review; [ADR-0018](../adr/ADR-0018-env-only-secrets-and-centralized-config.md)._
    15c. **Never require an external secret manager.** `.env` (dev) / injected env (prod) is the only secrets source; deployment stays `cp .env.example .env → compose up`. Vault/KMS/K8s-Secrets are optional, documentation-only extension points. — _enforced: review; ADR-0018._
16. **Every service/package/plugin/capability ships a `README.md`** (purpose, responsibilities, architecture position, dependencies, config, run, test, extension points). — _enforced: review; [DoD](DEFINITION_OF_DONE.md)._
17. **Every slice satisfies the [Definition of Done](DEFINITION_OF_DONE.md)** and updates all governance trackers before it is Done. — _enforced: end-of-sprint validation._

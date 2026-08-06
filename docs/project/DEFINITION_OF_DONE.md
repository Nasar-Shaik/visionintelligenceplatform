# Definition of Done

> The canonical checklist. **Every slice must satisfy every applicable item before it is considered Done.** If any item is incomplete, the slice is **NOT Done**. Each slice's review row ([REVIEW_HISTORY](../tracker/REVIEW_HISTORY.md)) records its actual status against this checklist.
>
> Items marked _(when applicable)_ are skipped only when structurally impossible for the slice (e.g. Docker validation for a docs-only slice) — and the skip is stated explicitly with a reason.

## Checklist

| #   | Item                           | Meaning                                                                                                                                                                                        |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ✅ Implementation Complete     | The slice's scope is fully implemented; no TODO stubs in shipped paths                                                                                                                         |
| 2   | ✅ Documentation Updated       | Architecture/reference/governance docs reflect the change                                                                                                                                      |
| 3   | ✅ README Updated              | Affected package/service/plugin READMEs are current and accurate                                                                                                                               |
| 4   | ✅ Unit Tests                  | Logic covered by unit tests; all pass                                                                                                                                                          |
| 5   | ✅ Integration Tests           | Cross-boundary behaviour tested (HTTP inject / Testcontainers) _(when applicable)_                                                                                                             |
| 6   | ✅ Scenario Tests              | A PO-executable scenario doc exists in [docs/testing/](../testing/)                                                                                                                            |
| 7   | ✅ Logging                     | Structured logs with correlation id on the relevant paths _(when applicable)_                                                                                                                  |
| 8   | ✅ Metrics                     | Prometheus metrics exposed / extended _(when applicable)_                                                                                                                                      |
| 9   | ✅ Health Checks               | `/health` + `/ready` behave correctly _(services only)_                                                                                                                                        |
| 10  | ✅ Docker Validation           | Compose config validates / service boots in a container _(when applicable)_                                                                                                                    |
| 11  | ✅ Dependency Review           | New deps registry-verified + recorded in [DEPENDENCIES](DEPENDENCIES.md)                                                                                                                       |
| 12  | ✅ Security Review             | Secrets/SAST considered; no secrets committed; threats noted in [RISK_REGISTER](RISK_REGISTER.md)                                                                                              |
| 13  | ✅ Foundation Discipline       | If the slice touches a **frozen foundation**: [FOUNDATION_PRINCIPLES](FOUNDATION_PRINCIPLES.md) re-read, the change is additive, and an ADR exists if it is not _(when applicable)_            |
| 14  | ✅ Documentation Status Labels | Every claim in new/changed docs is labelled **Implemented** · **Future Extension** · **Out of Scope** · **Known Limitation** · **Technical Debt**. An unlabelled aspiration reads as a feature |
| 15  | ✅ Index Coverage              | Any new query is added to `index-coverage.test.ts` with a covering index, or its non-coverage is recorded with the mitigation ([INDEX_POLICY](INDEX_POLICY.md)) _(when applicable)_            |
| 16  | ⏳ Architecture Review Pending | Handoff prepared; **left PENDING for the Architect** — never self-approved                                                                                                                     |

## Product-phase additions (from P-6 onward · 2026-08-04)

⚠️ **These are not optional and none is _(when applicable)_.** Items 1–16 above were written for an
architecture phase, where a slice could be a package or a contract set. From P-6 the platform ships
product, and a product milestone that has not been deployed and driven in a browser has not been
verified — it has been described. Every item below was added because its absence let a real defect
through.

| #   | Item                                   | Meaning                                                                                                                                                                                                                                                      |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 17  | ✅ **Real backend, real API**          | No mock, no fixture, no in-memory stand-in on a shipped path. ⚠️ If the contract is frozen and the service is not built, the feature is **not in this milestone** — say so rather than building a UI over nothing                                            |
| 18  | ✅ **Real permissions**                | Every panel and route independently respects the caller's permissions, fail-closed. No widening, no hidden service-to-service escalation                                                                                                                     |
| 19  | ✅ **Four render states, everywhere**  | Loading · empty · unavailable · error — plus `not-built` where nothing exists. A screen that can only render its happy path is unfinished                                                                                                                    |
| 20  | ✅ **Production deployment verified**  | Built image, deployed, exercised. ⚠️ **`pnpm dev` is not verification** — P-5.8 found evidence playback had never worked outside it                                                                                                                          |
| 21  | ✅ **Every route renders**             | `docs/review/roadmap-2026-08/verify.mjs` — zero `pageerror`, zero console errors. ⚠️ **This runs before any other UI measurement.** P-5.9 scored a crashed page 0/0/0, because a crashed page has no overflow, no unlabelled controls and no contrast faults |
| 22  | ✅ **Responsive verified**             | `overflow.mjs` — nothing painted off-screen, 390 → 1920, measured on **painted boxes**. ⚠️ `scrollWidth > clientWidth` misses everything an `overflow-hidden` ancestor clips                                                                                 |
| 23  | ✅ **Accessibility verified**          | WCAG AA: 0 unnamed controls · 0 targets < 24 px · 0 heading skips · every tab stop focus-visible · the primary operator workflow completed keyboard-only                                                                                                     |
| 24  | ✅ **Playwright verified**             | Every new interaction driven in a real browser, against the deployment. Not asserted from the component test                                                                                                                                                 |
| 25  | ✅ **Bundle budget + no chunk cycles** | Re-run after every meaningful UI change                                                                                                                                                                                                                      |
| 26  | ✅ **Design system only**              | Tailwind and the existing tokens. **No Bootstrap, no Material UI, no third-party design system.** Reusable component over one-off. ⚠️ The token layer is what makes runtime white-labelling work without a rebuild                                           |
| 27  | ✅ **Review package delivered**        | Under `docs/review/<milestone>/`: what was built, what was measured, screenshots of every screen **from the deployment**, and what is still missing                                                                                                          |
| 28  | ✅ **Known limitations recorded**      | Honestly, with an owner and a tracker id. ⚠️ **An unrecorded limitation is a defect**, and a limitation discovered by a customer is a defect that has already cost something                                                                                 |
| 29  | ✅ **Capability matrix updated**       | [PRODUCT_CAPABILITY_MATRIX](PRODUCT_CAPABILITY_MATRIX.md), in the same commit. A cell goes ✅ only when it is true of the **deployment**                                                                                                                     |
| 30  | ✅ **No fake CCTV behaviour**          | Never simulate a vendor, a codec or a device the platform has not met. An unvalidated area is recorded as unvalidated ([§18](CONSTRAINTS.md))                                                                                                                |

**The question behind all fourteen:** for every check, ask what result would have turned it red. If
there isn't one, it is decoration — that is exactly how a crashed page passed a UI audit
([§111](CONSTRAINTS.md)).

## Verification additions (from the P-6.5 freeze · 2026-08-05)

⚠️ Items 17–30 made a milestone prove the product works. These make a milestone prove that **the
proof works** — each was added because a green check hid a real defect. Full account:
[P-6.5 Lessons](../review/p6/P6-5-LESSONS.md).

| #   | Item                                                   | Meaning                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 31  | ✅ **Deployment integrity proven first**               | Before any verification is allowed to mean anything: the running bytes are the committed bytes — every service, every shared package, the browser bundle the **edge serves**, and the tools that are not services and that nothing restarts. The commit hash goes in the report          |
| 32  | ✅ **Every verification script mutation-tested**       | In the milestone that introduces it: break the behaviour it claims, confirm it goes red **on the owning check** with a message that names the fault, restore, confirm green. ⚠️ Mutate the **product** — flipping the script's own assertion proves only that the assertion is evaluated |
| 33  | ✅ **Exclusivity proven under real concurrency**       | Any transition whose correctness depends on only one caller winning is proven against the **real** dependency, from overlapping connections, over enough rounds that one lucky ordering cannot carry it — and the regression test is written **red first**                               |
| 34  | ✅ **Fixtures measured, not imagined**                 | A fixture value that describes platform behaviour is measured **from the platform** and pinned by a check that goes red when the behaviour changes. The check asserts what is true, never what is intended                                                                               |
| 35  | ✅ **Operator-facing words asserted verbatim**         | Every string a person acts on is asserted word for word against a real counterpart, including what it must **not** say. Judged by what the reader concludes — two accurate sentences can leave a false impression                                                                        |
| 36  | ✅ **Silence reported as a finding**                   | Skipped, excluded, crashed, unreachable and "0 of 9 were published" are results, not gaps in the output. ⚠️ And a run installs every fixture it depends on rather than assuming a previous run's survived a rebuild                                                                      |
| 37  | ✅ **A shared-pattern defect is fixed at the pattern** | When a defect is found in a shared component or shape, the unit of repair is the pattern and the verification enumerates every place it is used. "Fixed on the page it was reported on" is a status, not a fix                                                                           |

## The eight deliverables of a subsystem (permanent, from the P-8 Phase 4 freeze · 2026-08-05)

⚠️ **These are delivered TOGETHER or the subsystem is not delivered.** Not a checklist to work
through afterwards — a subsystem that ships seven of them has shipped something nobody can operate,
and the eighth is always the one that would have caught the defect.

| #   | Deliverable                 | ⚠️ What its absence costs                                                                                                                                                                                                          |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Runtime implementation**  | —                                                                                                                                                                                                                                  |
| 2   | **Runtime metrics**         | A subsystem nobody can see the state of. Every metric separates **measurable** from **unavailable**; an absent value is `null` with a reason, never `0` ([ADR-0039](../adr/ADR-0039-absent-metrics-are-unavailable-never-zero.md)) |
| 3   | **Browser visibility**      | Rules that are only observable on a page go unverified. A hard-coded "Not measurable" once made a contract violation invisible while the check stayed green                                                                        |
| 4   | **Deployment verification** | A subsystem proven under `pnpm dev` and broken in the deployment. P-5.8 found playback had never worked outside it. ⚠️ P-8 Phase 6 found **three** defects here that no unit test could reach — see the note below                 |
| 5   | **Mutation testing**        | A verification that cannot fail. Two of this milestone's checks were **vacuous** and only mutation found them                                                                                                                      |
| 6   | **Nightly automation**      | A verification that ran once. Registered in **every** profile, never left to manual invocation                                                                                                                                     |
| 7   | **Benchmark evidence**      | A capacity claim from nothing. Numbers carry their conditions, and no sizing recommendation publishes until **three independent runs agree**                                                                                       |
| 8   | **Governance updates**      | Work nobody after you can find. Capability matrix, limitation register, ADR index, and the tracker — in the **same commit**                                                                                                        |

⚠️ **Item 4 catches a class of defect the unit suite is structurally unable to reach: the code path
that only runs in a configuration no test creates.** P-8 Phase 6 found three, all the same shape.

- A registered runtime with **no cameras** was never health-probed, because the probe list came from
  the plan's _entries_. **Every unit test assigns a camera first**, so every one of them passed.
- A camera stranded in `error` was never re-placed, because the failover sweep looked for cameras
  whose _runtime_ had become unusable — and a stranded camera's runtime is by then perfectly usable.
- A payload shape mismatch made every live track count read `null`, which is **honest** under
  ADR-0039 and therefore invisible: a wrong shape and a runtime that has tracked nothing are
  indistinguishable from the caller's side.

The generalisation is worth more than the three instances: **when a check reports an absence, ask
what else produces that same absence.** Two of these survived precisely because the platform's own
honesty discipline made a bug look like a correct "we do not know".

⚠️ **Item 8 has failed twice in this repository, the same way both times.** The ADR index went
thirteen ADRs stale, was backfilled with a note explaining why that mattered, and went four ADRs
stale again within a day. Writing down the lesson did not change the outcome: the row belongs in the
commit that adds the file, and a reviewer should look for it before reading the diff.

## Governance trackers (must all be updated as part of Done)

- [ ] [ENGINEERING_DECISION_LOG](ENGINEERING_DECISION_LOG.md) — new decisions appended
- [ ] [RISK_REGISTER](RISK_REGISTER.md) — new/rescored risks
- [ ] [ASSUMPTIONS](ASSUMPTIONS.md) — new assumptions
- [ ] [OPEN_QUESTIONS](OPEN_QUESTIONS.md) — new/closed questions
- [ ] [QUALITY_GATES](QUALITY_GATES.md) — this sprint's PASS/FAIL recorded
- [ ] [API_INVENTORY](API_INVENTORY.md) — any new/changed endpoints
- [ ] [docs/testing/slice-NNN.md](../testing/) — scenario doc created
- [ ] [REVIEW_HISTORY](../tracker/REVIEW_HISTORY.md) — slice review row added, Architect column PENDING
- [ ] [MASTER_PROGRESS](../tracker/MASTER_PROGRESS.md) + [DAILY_LOG](../tracker/DAILY_LOG.md) + [TASK-BOARD](../../tracking/TASK-BOARD.md) — updated
- [ ] [PRODUCT_CAPABILITY_MATRIX](PRODUCT_CAPABILITY_MATRIX.md) — every touched capability re-stated against the **deployment**
- [ ] [TECH-DEBT](../../tracking/TECH-DEBT.md) — debt added or paid down, by id

**Rule:** if any item above is "No", the slice is not complete. The Architect column in [REVIEW_HISTORY](../tracker/REVIEW_HISTORY.md) stays PENDING until the Architect signs off — never self-approved.

## Documentation status labels

Every statement in a design or governance document carries one of five labels, explicitly or by the
section it sits in. The point is that a reader can tell, in one glance, what is **true today** from
what is **intended** — the two read identically in prose, and confusing them is how a roadmap becomes
a promise.

| Label                | Means                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| **Implemented**      | Built, tested, and true of the code as it stands.                       |
| **Future Extension** | A shape the design supports and nothing has built. Not a commitment.    |
| **Out of Scope**     | Deliberately not being built, so nobody re-proposes it as an oversight. |
| **Known Limitation** | The system is wrong or incomplete here, we know, and it is tracked.     |
| **Technical Debt**   | A shortcut taken knowingly, with a recorded pay-down trigger.           |

Two rules that matter more than the labels:

- **A Known Limitation must name its owner and its tracker.** "We should fix this someday" is not a
  limitation, it is a wish. See [E-1](../tracker/E-1-EVIDENCE-LOCATION-SNAPSHOT.md) for the shape.
- **A Future Extension must not be written in the present tense.** "The hierarchy supports inherited
  permissions" is false; "a permission grant would attach to a node id" is true and clearly a plan.

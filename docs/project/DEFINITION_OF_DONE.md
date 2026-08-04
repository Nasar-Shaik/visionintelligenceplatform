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

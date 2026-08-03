# ADR-0031 — P-5.2.0 workspace prerequisites: freeze the shapes, refuse the ones that cannot be honest

- **Status:** Accepted
- **Date:** 2026-08-03 · **Accepted:** 2026-08-03 (Architect decision, P-5.1 approval + P-5.2 planning approval + three mid-flight refinement sets)
- **Deciders:** Principal Architect + development
- **Touches:** `@vip/contracts` (`workspace/`, `playback/`, `search/`, `jobs/`, `reporting/`, `audit/`); `@vip/permissions` (`WORKSPACE_PERMISSIONS`, `REFUSED_WORKSPACE_PERMISSIONS`, `audit:inspect`); `apps/console` (design-system enforcement test); [INVESTIGATION_WORKSPACE](../architecture/INVESTIGATION_WORKSPACE.md); [DESIGN_SYSTEM](../architecture/phase2/DESIGN_SYSTEM.md) v2. Relates to [ADR-0029], [ADR-0030], CONSTRAINTS §36, §40, §44, §46, §52–53, §57–63, TD-26.

## Context

P-5.1 was approved with eleven recommendations to address "before beginning P-5.2", most of them of
the form _define the contract before implementation_. Three further refinement sets arrived during
the work: panel dock metadata, a keyboard registry, workspace state persistence, report theme
metadata, a command palette registry, and an enterprise design system specification.

All of it is **contract and specification work**. Nothing here is implemented, and P-5.2 — the
Investigation Workspace backend and frontend — has not begun. That separation is the standing
discipline the same review opened with: _never merge multiple milestones together._

Eleven decisions in that work were not mechanical.

## Decision

### 1. A layout that must not drift is data, not prose

The instruction was that the layout "become the reference implementation and evolve only
additively". Prose cannot evolve additively — nothing fails when someone adds a panel. So the
layout is `INVESTIGATION_WORKSPACE_LAYOUT`, a parsed constant a test reads, in the same way index
specifications are (§60). Adding a region fails a test; adding a panel is one line.

The dock metadata from refinement 1 lives on the same record: allowed regions, size bounds,
resizable, collapsible, hideable, floatable, persistence key.

⚠️ **Size bounds are stated along an axis, not as a width.** Three of four regions resize
horizontally and `bottom` does not; a `minWidth`-only contract leaves the bottom dock's constraint
inexpressible, and the first person to need it either adds a second field or reuses the wrong one.

⚠️ **`persistenceKey` excludes the layout version.** A key carrying it would reset every operator's
saved layout on the next additive panel — data loss that reads as a browser bug. The state schema
version is a _separate_ number for the opposite reason: bumping it _must_ discard incompatible
state.

### 2. `availability` is a field, because two approved panels have no producer

AI Recommendations (no model emits an `IncidentRecommendation` — P-5.1) and Saved Investigations
(frozen here, no store) would otherwise render as empty boxes. An empty box asserts _there is
nothing here_, which is a different and false claim from _nothing has produced this_. Every
non-available panel carries a required `unavailableReason`, enforced by the schema.

This is §44 and §63 — _a check that could not run is not a check that passed_ — applied to a screen,
and it is why DESIGN_SYSTEM v2 §11 defines **four** render states rather than the usual three.

### 3. One command registry, not a registry and a keymap

The refinements asked for a keyboard shortcut contract and a command palette registry as two items.
They are one thing: a shortcut is a _binding to a command_. Two tables would carry the same names
twice, and the first divergence is a key firing a command that was renamed — at runtime, on a
keystroke, for one user, where no test reaches. Same reasoning as ADR-0030 decision 4.

Three rules are enforced by the schema, not by review:

- **A mutating command may not bind a bare key.** `r` for Resolve is one keystroke from a state
  change whenever focus is not in a text field.
- **`Mod+K`, never `Ctrl+K`.** Hard-coding either ships the wrong shortcut to half the operators —
  the half that files no bug, because they assume there are no shortcuts.
- **No chord bound twice in a scope**, and a `global` chord shadows nested scopes. Conflicts are
  silent: one handler wins consistently and the other command never fires.

### 4. "Persist only UI state" is really "a reference may be persisted; a record may not"

The instruction was right and its own examples crossed it: _current incident_, _selected evidence_
and _applied filters_ are not UI state the way a panel width is. The line that survives contact with
code is the one above. An id goes stale safely — re-fetch and get a 404, a 403, or the truth. A
`{id, status, title}` copy in a browser has no invalidation, no tenant check and no permission
check, and it renders a stale status confidently _after_ access has been revoked.

Every persisted field is therefore a scalar, an enum, a number or an id. **Restore is a re-fetch**,
and anything that fails to resolve is reported in `dropped` — an operator whose workspace quietly
loses a tab assumes they closed it.

⚠️ State is keyed `vip.workspace.state.<tenant>.<principal>`. The scope is in the **key**, not in a
field a reader must remember to compare: getting a key wrong returns nothing, while forgetting a
field check returns someone else's workspace.

### 5. Search is a federation, and there is no relevance score

No new service, no Elasticsearch. Search fans out to the contexts that already own the records, so
it inherits the timeline's discipline exactly: a **call budget** (5 entities), a **timeout** (2s
each), and **typed gaps** (§63).

⚠️ **No global relevance.** Ranking incidents against cameras needs one scorer over one index;
blending across federated contexts is arithmetic on incomparable quantities — a score nobody can
take apart (§52). Results are grouped per entity, each stating its own ordering. Less impressive,
and true.

⚠️ **`total` is absent unless free.** A count is a second unbounded query; an estimate labelled as a
count ends up in a report.

### 6. An entity is searchable only if an index says so — and four of them are not entities

Entry criterion G-4 was _never expose a query without index validation_. Text matching on an
unindexed field is a collection scan that passes every fixture and melts a tenant with a year of
history. So `SearchMatchMode` is declared per entity, `filter-only` is a legitimate honest answer,
and a test asserts no supported entity has `match: 'none'`.

Refused, and recorded rather than dropped:

- **Site / Building / Floor / Zone** are the `type` of a `location`. Four entities would copy the
  frozen Location Hierarchy type enum into this contract — two enums to keep in sync forever.
- **Actor** is not an entity. `IncidentActorRef` is a _reference_; it has no record to return.
- **Operator** is declared `supported: false`: Identity has no indexed principal search, and
  searching people is directory disclosure needing its own permission, which `incident:read` is not.

### 7. Jobs are owned by the context that produces the artefact

No central job service — it would need read access to every context's data to do the work, which is
what bounded contexts exist to prevent. Workflow renders reports, Evidence packages evidence, Media
cuts clips; this contract is the shared vocabulary.

Four failure modes are designed against:

- **The eternal spinner** — every claim carries a **lease**; an expired lease is reclaimable.
- **The stored signed URL** — `JobResult` holds a **storage key, never a URL**. A URL in a record
  outlives its expiry: a broken link at best, a credential in a queryable collection at worst.
- **The double-click that costs 400 MB** — every submission carries a `requestKey`.
- **Progress that reports 0 when it means unknown** — `total` is optional and there is no `percent`
  field; `jobPercent()` returns `undefined` rather than a fabricated zero (§53).

⚠️ **There is no `partial` state.** A half-finished export is a _failure that produced something_ —
"partly succeeded" is where the archive missing four clips gets handed to a regulator.

⚠️ **A schedule is not a job.** Modelling scheduled reports as jobs produces a record that is
simultaneously a thing that ran and a thing that will run, with a `state` answering neither.
`JobSchedule` is separate, frozen, and `enabled: false` with no runner.

### 8. A report pins the version it describes, omits what it cannot know, and never varies by theme

- **Provenance.** `incidentVersion` is required. Without it two PDFs of "the incident report"
  circulate with nothing distinguishing the one someone acted on from the one that superseded it.
- **Omission.** A section with no data is absent, and the absence carries a reason — `no-data` and
  `not-available` are different claims and only one of them is true of AI findings today (§53).
- **⚠️ A theme may not choose content.** If a theme could drop the audit trail, "the Executive
  report" and "the Police report" of one incident would say different things while both claiming to
  be the report. `ReportPresentation` has no field that includes or excludes a section; `sectionOrder`
  reorders only.
- **⚠️ A theme id is an opaque configured slug, not an enum of industries.** Executive, Security,
  Retail, Manufacturing, Healthcare and Police ship as configuration presets, because §36 forbids an
  industry noun entering a platform type — and because a customer needing "Logistics" should add a
  preset, not wait for a release.

### 9. Audit the reads, because nothing else witnesses them

The eleven requested audit events split along one line: **a write leaves a record; a read leaves
nothing.**

Assignment, comment, attachment, resolution and escalation already append to the incident's own
streams and are derived by `IncidentActivity`. Recording them again is two records of one truth,
written by different code paths, that eventually disagree (§46). They are **refused**, in
`REFUSED_AUDIT_ACTIONS`, rather than silently omitted.

`open`, `download`, `export`, `search` and `recommendation-viewed` change nothing, so if they are
not recorded at the moment they happen the fact is gone. That is the entire content of this
contract.

⚠️ **No sampling.** A sampled audit is not an audit — the one access anybody ever asks about is the
one that was dropped. Volume is controlled by recording **record-level acts**, not list impressions,
which is why `view` is refused and `open` is not.

⚠️ **It records the act, never the content.** The search _query_ is stored; the results are not.
⚠️ **It does not duplicate the chain of custody.** Evidence byte access is
`EvidenceCustodyAction.accessed` — hash-chained, and the artefact a court sees.

### 10. ⚠️ `audit:inspect`, and the wildcard that nearly granted a staff-surveillance log to viewers

The obvious name was `audit:read`. Both `operator` and `viewer` hold `*:read` — so naming it that
way would have granted _who looked at what, when, from which IP_ to the least privileged role in the
product. **Nothing would have failed.** It is a wildcard expansion; no test asserted the negative.

The action is `inspect`, and `permissions.test.ts` now asserts operator and viewer do not hold it —
_and_ asserts that `audit:read` would have been granted, so the hazard is pinned rather than merely
avoided.

The general defect is worse than the instance: `*:read` means **every future `<resource>:read` is
granted to viewers the moment it is named.** Recorded as **TD-26**. Narrowing the wildcard is a
breaking change and needs its own ADR.

### 11. The design system is extended, not recreated

The refinement asked for an Enterprise Design System specification. One already exists
(`DESIGN_SYSTEM.md`, P2-1): tokens live in `theme.css`, an ESLint rule fails a build that hardcodes
a hex or a px, and the primitive set is built. A second specification would describe one visual
language twice, and the first disagreement would have no principled resolution.

So v2 extends it in place (§10–22), adding what did not exist: the framework policy — **now a test
rather than an assumption**, because "no Bootstrap, no MUI" was true only by accident — the four
render states, the status/badge mapping to platform enums, table/card/drawer/dialog standards, panel
chrome, timeline and playback-gap styling, and the theme extension contract.

⚠️ **Report themes are not UI themes.** `ReportThemeId` styles a generated PDF and shares no tokens
with the console; wiring them together would let a tenant's console accent restyle a document handed
to a regulator.

## Consequences

**Good.** Every shape P-5.2 needs is settled and parseable before a line of workspace code exists.
Six decisions that would otherwise have been made implicitly during implementation — federation over
a search engine, references over cached records, a lease on every job, the audit read/write split,
the theme/content separation, the permission naming — are now checkable by tests. The design system
has one source and an enforcement gate.

**Costs.** Nine new contract modules that nothing reads yet, which is a real carrying cost until
P-5.2 consumes them. `SEARCH_ENTITIES` declares three entities unsupported, so the first search UI
will visibly not find operators or saved work. `JobSchedule` exists with no runner. The design
system's §11 fourth state means every panel P-5.2 builds must implement four states, not three.

**Deliberately not done.** No workspace, no UI, no components, no search implementation, no job
runner, no report generator, no audit writer. Those are P-5.2 onward, and merging them into a
contract freeze would break the discipline this milestone exists to honour.

## Alternatives considered

- **A second design system document** — rejected: two descriptions of one visual language, with no
  way to decide which the code is wrong against (decision 11).
- **A separate keymap table** — rejected: it duplicates command names and diverges silently
  (decision 3).
- **A central job service** — rejected: it needs every context's data, and no new services is a
  standing constraint (decision 7).
- **A blended relevance score across contexts** — rejected: incomparable quantities, and §52
  (decision 5).
- **`audit:read`** — rejected on measurement, not taste: `can(viewer, 'audit:read')` is `true`
  (decision 10).
- **Caching titles in persisted tab state** — rejected: it survives revoked access and renders
  stale confidently (decision 4).
- **Modelling zoom, rate and playback position server-side** — rejected: persistence invented for
  something nobody stores, and a write on every scrub.

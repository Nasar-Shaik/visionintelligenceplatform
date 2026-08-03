# ADR-0032 — P-5.2 Investigation Workspace: the registry drives the screen, and the joins run as the caller

- **Status:** Accepted
- **Date:** 2026-08-03 · **Accepted:** 2026-08-03 (Architect decision, P-5.2.0 approval + 17 recommendations)
- **Deciders:** Principal Architect + development
- **Touches:** `@vip/contracts` (`IncidentTimelineGapReason.forbidden`; the nine additive refinements — panel `priority`/`detachable`, `PlaybackSyncGroup`, marker ranges, `CommandBindingKind`, `EvidenceViewerCapabilities`, reserved `JobKind`s, `SavedWorkspaceLayout`, `EXTENSION_POINTS`); `services/workflow` (`adapters/http-timeline-sources.ts`, `TimelineCaller`, the timeline route); `apps/console` (`features/workspace/*`, `QueryBoundary`'s fourth state, `useCan`). Relates to [ADR-0030], [ADR-0031], CONSTRAINTS §44, §46, §63–66, §70.

## Context

P-5.2.0 froze the shapes. This slice builds the workspace against them, and folds in the nine
additive refinements the approval carried. Two things it does that the freeze could not: it wires
the timeline's cross-context joins, which P-5.1 shipped deliberately unwired, and it renders
fifteen panels that must each tell an operator the truth about what they are looking at.

Six decisions were not mechanical.

## Decision

### 1. ⚠️ Every join carries the caller's own authority

The timeline fans out to Events, Evidence and Notify. The obvious client reuses the internal service
key `HttpCameraSource` already uses — it is the established pattern, it works, and it is wrong.

A service-key join shows an operator events, evidence and notifications **they cannot open anywhere
else in the product**. Nothing errors. The Events panel refuses them and the timeline does not, and
the discrepancy reads as a bug in the panel rather than as a disclosure. A privilege escalation
through a read-only narrative is one nobody thinks to look for.

So the caller's `Authorization` header is forwarded verbatim, and a request that carries no identity
is **refused rather than upgraded** — asserted by a test that the upstream is never called at all,
not merely that the call fails.

### 2. ⚠️ A 403 is not an outage — the frozen enum gained a value

Decision 1 makes "you may not read that context" a routine answer. `IncidentTimelineGapReason` had
`unavailable`, `truncated` and `not-requested`, and mapping a permission failure onto `unavailable`
tells an operator the events service is down — sending them to an engineer for something a role
grant fixes.

`forbidden` was added. ⚠️ Extending the enum is **not purely additive for a strict parser** — the
caveat [ADR-0029](ADR-0029-incident-workflow-entry-criteria.md) records for `IncidentStatus` — and
it is safe only because P-5.2 is the first consumer. Recorded rather than glossed, because the next
such extension will not have that luxury.

This is the milestone's headline finding, and it came from _writing the client_, not from reviewing
the contract. The freeze got the shape right and the vocabulary incomplete.

### 3. The evidence join asks by incident, not by correlation

Both are indexed (P-5.1 closed TD-25), so this is not a performance choice. The correlation spine
can carry evidence belonging to **sibling incidents**, and a timeline that shows another incident's
evidence as this one's is worse than one that shows less — it is wrong in the direction an
investigator would act on.

### 4. The registry drives the screen, or it is not a registry

`INVESTIGATION_WORKSPACE_LAYOUT` and `WORKSPACE_COMMANDS` are consumed, never restated. The console
holds a layout _engine_ — filter by permission, apply persisted state, drop by priority — and a
`PANEL_BODIES` map keyed by `WorkspacePanelId`, so **adding a panel to the contract without a body
is a TypeScript error** rather than a blank rectangle a customer finds.

Three consequences worth stating:

- **A panel the principal cannot see is omitted, not disabled.** A greyed-out "AI Recommendations"
  tells a viewer exactly which capabilities exist and which roles hold them.
- **A persisted size is clamped back into the registry's bounds.** A value stored by an older build
  must not escape the current `minSizePx`.
- **Responsive drop order is data.** DESIGN_SYSTEM v2 §20 described it in prose; `priority` makes it
  checkable, and the contract refuses a non-hideable panel with a high one — a rule that would
  otherwise contradict itself silently.

### 5. ⚠️ The fourth render state, wired to the contract

`QueryBoundary` had loading, error and empty. It now has **unavailable**, and it takes priority over
all of them — an unavailable surface is not fetched at all.

The reason never comes from the component. It comes from `WorkspacePanel.availability` through
`ResolvedPanel.unavailableReason`, so a panel _cannot_ render Empty where the contract says
Unavailable. Two panels use it today: AI Recommendations (no producer) and Playback (contracts
frozen, no session resolver). Both would otherwise render an empty surface asserting there is no
data, which is a confident false statement inside an investigation record.

### 6. Persisted state holds references, and a failed restore is reported

Keyed `vip.workspace.state.<tenant>.<principal>` — the scope is in the key, not in a field a reader
must remember to compare. A body disagreeing with its own key is discarded as `wrong-tenant`; an
incompatible schema version is discarded whole rather than half-applied; an unreadable body is
reported as `invalid`.

⚠️ **Discarded state is surfaced in the UI.** An operator whose workspace quietly loses a tab
assumes they closed it, and then assumes the product is unreliable.

## Consequences

**Good.** The timeline answers for the first time. Adding a panel is a contract edit. "We could not
look" is now structurally distinguishable from "there is nothing" on every surface in the workspace,
and a permission failure in a join is distinguishable from an outage.

**Costs.** Forwarding the caller's token means the workflow service cannot pre-warm or cache a
timeline across principals — correct, and it forecloses an optimisation someone will eventually
want. The `forbidden` enum extension is a strict-parser break for any consumer pinned to the P-5.1
schema. `PANEL_BODIES` couples the console to the panel enum, which is the intended trade.

**Deliberately not done.** No playback session resolver, no evidence viewer, no annotations, no
saved investigations, no search federator, no job worker, no report generator, no audit writer, no
detached windows. Panel resize handles and floating are declared in the registry and **not
implemented** — collapse and persistence are. Those are P-5.3 onward and Q-5…Q-9.

## Alternatives considered

- **An internal service key for the joins** — rejected on the disclosure, not on the plumbing
  (decision 1).
- **Mapping 403 to `unavailable`** — rejected: it misdirects the operator to the wrong fix
  (decision 2).
- **Joining evidence by `correlationId`** — rejected: sibling-incident leakage (decision 3).
- **A `PanelUnavailable` component alongside `QueryBoundary`** — rejected: two components deciding
  one thing, and the panel could then choose Empty over Unavailable (decision 5).
- **Caching incident titles in tab state** — rejected in P-5.2.0 and re-confirmed here: a tab
  renders a skeleton instead.

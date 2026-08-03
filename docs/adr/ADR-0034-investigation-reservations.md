# ADR-0034 — P-5.4 investigation reservations: the contracts frozen before the last implementation phase

- **Status:** Accepted
- **Date:** 2026-08-03 · **Accepted:** 2026-08-03 (Architect decision, P-5.3 approval + reservation list)
- **Deciders:** Principal Architect + development
- **Touches:** `@vip/contracts` (`playback/annotation.ts`, `playback/session.ts`, `playback/playback.ts`, `playback/viewer.ts`, `reporting/profiles.ts`, `camera/placement.ts`, `incidents/metrics.ts`, `incidents/incident.ts`, `workspace/{commands,surfaces,workspace}.ts`, `tenant/branding.ts`); `@vip/permissions`. Relates to [ADR-0031], [ADR-0032], [ADR-0033], CONSTRAINTS §36, §46, §60, §69, §75–79.

## Context

P-5.3 was approved with a reservation list: playback sessions, multi-camera walls, annotations,
export profiles, camera maps, heatmaps, AI recommendations, demo mode, branding, metrics, workspace
templates and mobile layouts. A later instruction closed the phase:

> "Stop adding architecture unless a real limitation is discovered. Focus on completing
> implementation, polishing UX, testing, and demo readiness rather than introducing new
> abstractions."

**P-5.4 is therefore the last reservation milestone.** It freezes the vocabulary the remaining
implementation work needs and adds no services, no routes and no runtime behaviour.

⚠️ **Five of the twelve areas were already frozen** — sync groups and clock skew (P-5.3 rec 5), AI
recommendation categories and their three enforcement points, workspace profiles, offline bundles,
and tenant branding. Those were extended, not rebuilt. Re-reserving them would have produced a
second vocabulary for the same concepts, which is the duplicate-source-of-truth failure the freeze
exists to prevent.

Five decisions were not mechanical.

## Decision

### 1. ⚠️ A redaction drawn as an overlay is not a redaction — the finding

The annotation requirement listed rectangles, polygons, arrows, text, **blur, redaction** and
timestamps as one feature. They are two features, and conflating them is a data leak.

An overlay is a shape stored beside the media and painted over it at display time. That is exactly
right for a rectangle an investigator drew round a suspect. For a blur over a bystander's face it
fails three ways:

- **The bytes still contain the face.** Anyone with `evidence:read` sees it unobscured by opening the
  original, using a different viewer, or exporting the clip.
- **The overlay is investigation-context data** (§60). Any export path that does not consult the
  investigation carries no redaction at all.
- **A disclosure copy is the one artefact** where "the viewer chose not to paint it" is the whole
  failure. Handing a police force a file whose redaction is a rendering hint is worse than handing
  them the original, because everyone involved believes it is redacted.

So `blur`, `mask` and burnt-in `timestamp` are **not shapes**. They are a `RedactionTreatment` on a
`RedactionRequest`, which runs as a `media.render` job and produces a **new evidence record** with
its own hash and custody log — the rule `CapturePlaybackSnapshotInput` already follows. There is no
`overwriteOriginal` flag and `RedactionResult.irreversible` is `z.literal(true)`: a treatment that
could be undone from the derived copy would mean the pixels were never removed. Now §75.

Revisions supersede rather than mutate: an annotation is a statement a named person made about
evidence, and editing one in place rewrites what somebody said in a context whose value depends on
that being impossible.

### 2. The session field list is UI state, and the requirement's own last line says so

`sessionId`, `resumeToken` and `expiresAt` read like a server-side resource, which `PlaybackSession`
decision 1 refuses. The requirement ended _"session restoration must restore only UI state, never
business state"_ — which resolves it, once each field is read for what it is for:

| Field         | What it actually is                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`   | a client-generated correlation id for the audit trail. Grants nothing.                                                                               |
| `resumeToken` | an opaque encoding of a **query and a position**. ⚠️ **Not a bearer credential** — restoring re-runs the query under the restorer's own permissions. |
| `expiresAt`   | the signed-URL horizon, derived from the **earliest** segment expiry.                                                                                |

⚠️ **`activeBookmarks` and `activeAnnotations` are id lists, never records.** Persisting the records
would put business state in `localStorage`, where it survives the incident closing, the annotation
being revised and the operator's access being withdrawn — and would be read back and rendered as
current. Now §76.

A token that carried authority would let a link pasted into a chat outlive the revocation of the
person who made it. That is why restoration is re-derivation, and it also works after a deploy, in a
second tab, and on a machine where a token would be unknown.

### 3. A 16-tile grid is a display grid, not a resolution budget

The request was 1/2/4/9/16 synchronized cameras. `PLAYBACK_SYNC_MAX_SOURCES` is 9 because each
member is a full session resolution — nine members is nine upstream fan-outs on the busiest screen in
the product (§54).

Both are honoured: `PlaybackGridLayout` offers all five arrangements, and `resolvableMembers()`
bounds what a grid may actually resolve by the fan-out budget. A 16-grid is sixteen tiles of which at
most nine are resolved and the rest are **empty tiles an operator can fill by swapping a source out**.
Silently resolving sixteen moves the cost onto the timeline's budget; silently refusing the layout
looks like a bug.

`resolvableMembers()` derives from the constant rather than repeating it, so raising the budget moves
every grid with no second number to keep in step. A `leaderOrder` drives the followers, and
⚠️ the leader's clock confidence becomes the wall's — which is already visible, because
`PlaybackSyncGroup.alignmentVerified` is derived from the members.

### 4. ⚠️ Export profiles are records, and a profile may require a redaction but never perform one

Written as `z.enum(['court', 'police', …])` the seven profiles would put six jurisdiction nouns into
the platform's type system, which §36 refuses and `ReportThemeId` already refused. So the id is an
opaque slug and the seven ship as `EXPORT_PROFILE_PRESETS` — **data, not vocabulary**. A deployment
adds an eighth without a release.

The hard case is that a court profile differs from an internal one by _what has been removed_, and
removal is content. A profile that could redact would be a presentation object silently changing
evidence. So `requiresRedactionReview` is a **gate**: the profile declines to export until the
accountable act has happened, and `exportBlockers()` returns reasons rather than transforming
anything. `PROFILE_FORBIDDEN_KEYS` is asserted by a test so no future change adds content selection.
Now §77.

### 5. ⚠️ Two metrics could not be computed, and one is a staff-monitoring surface

- **A false negative is, by construction, not in the data.** A false positive was raised and can be
  counted; a false negative was _never raised_ — no document, no event, no trace. A dashboard
  computing "false negatives: 0" from platform data states the one thing it cannot know, on the
  metric a customer is most likely to buy on. So `falseNegatives` is a `ReportedMetric` with a
  required source, and absent means _not measured_. Now §79.
- **A false positive needs a declaration, never an inference.** Resolved quickly, resolved with no
  evidence, closed without escalation — every one of those is also what a well-handled real incident
  looks like. Counted only from a recorded `IncidentDisposition`, with `undisposedCount` reported
  separately; `falsePositiveRate()` excludes it from the denominator so an unreviewed backlog cannot
  silently improve the number.
- **⚠️ Operator workload is staff monitoring**, and it is the same finding as `audit:read` one
  milestone later in a friendlier costume. `metrics:workload` takes a distinct action verb so no
  `*:read` wildcard reaches it; the aggregate form, naming nobody, stays on the ordinary read path.
  `OperatorWorkload` deliberately carries **no quality measure**: an operator does not choose which
  incidents reach them, so a badly tuned rule on a site they cover would show up as their failure.
  Now §78.

## Consequences

**Good.** Every remaining implementation milestone has frozen vocabulary to build against, and four
hazards were found at contract time rather than in a disclosure.

**Costs.** `AnnotationOverlayKind` extends the P-5.2 enum, which is additive for the platform and
**not** for a strict external parser — the fourth time this trade-off has been accepted, and recorded
as such. Twelve areas now carry frozen contracts with no producer.

**Deliberately not done.** No service, route, worker or screen. Face recognition, LPR, PTZ, audio
analytics, GIS, drone and edge sync are recorded in the roadmap queue, **not** as contracts —
reserving a `face-recognition` type today creates vocabulary with no producer and invites biometric
processing into a platform with no DPIA, no consent model and no legal-basis record. Those need a
legal review before a schema, not after.

## Alternatives considered

- **A second annotation vocabulary** instead of extending the enum — rejected: two spellings for the
  same shape, and stored P-5.2 annotations become unreadable.
- **`blur` as an overlay kind with a "burn in on export" flag** — rejected: the flag is the failure
  (decision 1). Every path that forgets to read it ships the unredacted frame.
- **A server-side playback session with a lifecycle** — rejected: goes stale while claiming to be
  current (decision 2).
- **Raising `PLAYBACK_SYNC_MAX_SOURCES` to 16** — rejected: sixteen fan-outs on the busiest screen.
- **`ExportProfileId` as an enum** — rejected on §36 (decision 4).
- **Inferring false positives from resolution shape** — rejected: indistinguishable from a
  well-handled real incident (decision 5).
- **`metrics:read` covering per-operator figures** — rejected: `*:read` grants it to every viewer.

---

## Addendum — P-5.4.1: the final refinements before implementation (2026-08-03)

The Architect approved P-5.4 and issued seven refinements as the **final architecture review before
implementation**, with an explicit freeze after it. Three were already satisfied and are recorded as
such rather than reimplemented; four were genuine correctness gaps.

**Already satisfied — no change made.**

- _"Resolve concurrent edits honestly · never silently overwrite · prefer optimistic concurrency."_
  Delivered in P-5.3 and pinned as §74: every incident write is version-guarded, a 409 refetches,
  keeps the operator's text and explains, and is **never** retried.
- _"Never overwrite or mutate originals."_ §75, with no `overwriteOriginal` flag anywhere in the
  contract surface and `RedactionResult.irreversible` typed as `z.literal(true)`.
- _"Continue lazy loading, virtualized rendering, bundle budget."_ Route splitting, vendor chunking
  and `check-bundle-budget.mjs` are wired into `build` (§71).

**Four gaps closed.**

### A. A derived artefact needs the renderer, not just the source (§80)

`sourceEvidenceId` answers _what it came from_; it does not answer _whether this is what that
renderer would produce today_. A blur radius, a codec default or a scaling filter that changed
between releases yields a visibly different artefact from identical inputs. `DerivedArtifact` carries
`renderProfileId`, `rendererVersion` and the **ordered** `appliedOperations`.

⚠️ **Ordered, because rendering is not commutative.** Masking then downscaling is not the picture
that downscaling then masking produces — and the second order can leave recoverable detail at the
region's edge. The schema refuses duplicate orders.

⚠️ **And it refuses `derivedEvidenceId === sourceEvidenceId`.** A "derivation" whose output id equals
its input is an in-place mutation wearing a provenance record, which is exactly the shape a
well-meaning optimisation would take.

Modelled once and composed by `RedactionResult` rather than restated — a snapshot, a redaction and an
export are the same shape of thing, and three copies would drift.

### B. Three timestamps, because one gets read as the wrong one (§81)

`recordedAt` · `playbackOffsetSeconds` · `exportedAt`. An artefact carrying a single timestamp is
read as _when this happened_ by whoever receives it, which turns "exported at 14:05" into a claim
about the world. Clock confidence travels with the artefact and defaults to `unknown`, and an
estimated alignment carries its caveat **out of the platform** — "never imply synchronization if
clock alignment is estimated" only holds if the caveat survives the export.

### C. The viewer needs four modes, and provenance outranks adjustment (§82)

`EvidenceViewMode` was `original | enhanced`. A redacted copy shown as `original` is §75's failure one
layer up: the operator concludes the bystander was never in frame. Now four —

| Mode       | What it means                                                                |
| ---------- | ---------------------------------------------------------------------------- |
| `original` | the stored bytes                                                             |
| `enhanced` | reversible display adjustment, **in the viewer**                             |
| `redacted` | information irreversibly removed — a different artefact                      |
| `derived`  | non-destructive render (transcode, scale, watermark) — also a different file |

⚠️ **`viewMode()` checks the derivation first.** Brightening a redacted clip does not make it
"enhanced"; it makes it a brightened redaction, and the stronger claim is the one an operator needs on
screen. Everything except `original` requires a persistent label, not a tooltip —
`MODES_REQUIRING_PROMINENT_LABEL` exists so the console asserts on it.

⚠️ This is the **fifth** enum extension recorded as additive for the platform and not for a strict
external parser. Accepted for the same reason: the alternative is a second mode vocabulary.

### D. A produced report must be reproducible; a preview need not be (§83)

`templateVersion` was missing — `security` in 2026 and `security` in 2029 are the same slug and
potentially a different document. So are the **evidence integrity hashes**: evidence is immutable, so
an id looks sufficient, but an item can be **purged under retention**, and a report re-rendered
afterwards is a different document that looks identical.

⚠️ `platformVersion` and `templateVersion` stay **optional on `ReportProvenance`** and are required by
a `superRefine` on **`RenderedReport`**. `ReportPreview` shares the provenance shape and is computed
before anything is rendered; requiring them there would be a breaking change to a frozen contract for
no gain. Requiring them on the thing that leaves the building is the additive way to get the
guarantee.

## Status after this addendum

⚠️ **Contracts and foundations are frozen.** Further change requires a real implementation issue and
an ADR. The next milestones are implementation, UX and testing: evidence playback, search, reporting,
dashboards, notifications, branding, and Demo Readiness v1.

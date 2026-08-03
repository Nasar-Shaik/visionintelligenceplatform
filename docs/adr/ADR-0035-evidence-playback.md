# ADR-0035 — P-5.5 evidence playback: the first implementation milestone after the freeze

- **Status:** Accepted
- **Date:** 2026-08-03 · **Accepted:** 2026-08-03 (Architect decision, P-5.4.1 approval + implementation directives)
- **Deciders:** Principal Architect + development
- **Touches:** `services/evidence` (`domain/playback.ts`, `EvidenceService.playbackSession`, `GET /evidence/:id/playback`); `services/workflow` (`application/bookmark-store.ts`, in-memory + Mongo adapters, `BOOKMARK_INDEXES`, three bookmark routes); `apps/console` (`features/playback/*`, registry wiring, `VideoPlayerContainer` aspect); `@vip/contracts` (`WORKSPACE_COMMANDS.available` flags only). Relates to [ADR-0031]–[ADR-0034], CONSTRAINTS §44, §46, §54, §57, §60, §82.

## Context

The architecture freeze landed with a directive: implementation over abstraction, every milestone
usable from the browser, no backend feature more than one milestone ahead of its UI. P-5.5 is the
first milestone under it, and it takes the largest `not-built` on the screen — **evidence playback**.

⚠️ **No contract was added.** The only change inside `@vip/contracts` is flipping
`WORKSPACE_COMMANDS[…].available` from `false` to `true` for the ten transport commands a player now
consumes. That field exists to say what a deployment can actually do; leaving it stale would be the
lie it was added to prevent.

Four decisions were not mechanical.

## Decision

### 1. ⚠️ Watching evidence is accessing evidence, and it is audited as such

`playbackSession` issues a signed URL exactly as `download` does; the only difference is what the
operator does with it. Leaving playback out of the custody log would mean an investigator could
review a clip a hundred times and the chain of custody would show that nobody ever opened it —
which is the single question a custody log exists to answer.

So the resolver appends an `accessed` entry with `via: 'playback'`, distinguishable from
`via: 'signed-url'`, and the hash chain still verifies afterwards. Both are asserted.

### 2. Capabilities are read off the media, and two are permanently false

A control offered on a source that cannot perform it is worse than an absent one. `seek` and
`frameStep` are derived from the manifest; `snapshot` and `export` are **false on everything**,
because no renderer extracts a still and no packager builds an export (TD-16).

⚠️ **`frameStep` requires a declared codec**, and that is a deliberate under-claim: frame-accurate
stepping needs keyframe-dense video, which the manifest cannot prove. A clip with no declared codec
is a container nobody has looked inside.

⚠️ **A snapshot gets zero duration, not a nominal one.** A still frame given an invented second of
duration draws a scrubber that can be dragged on an image that cannot move.

### 3. Bookmarks are their own collection, in the Workflow context

Notes live on the incident document because they are bounded by design (`MAX_NOTES`) and every read
of an incident wants them. Bookmarks are neither: an investigator reviewing an hour of footage may
leave dozens, they are wanted only when a player is open, and growing the incident document with
them would make every queue listing carry playback detail nobody asked for.

⚠️ **They are deletable, and notes are not.** A note is a statement in an investigation record and
rewriting it destroys the record's value. A bookmark is a navigational marker — deleting one removes
a pointer, not a claim.

⚠️ **An unconfigured store refuses rather than returning `[]`.** An empty list tells an operator they
have bookmarked nothing, and they go on not-bookmarking things into a void (§44). The console
renders that 409 as _unavailable_ with the server's own sentence.

⚠️ The index ends in `(at, id)` **ascending** — the opposite of every incident index — because a
bookmark list is read oldest-first, as a route through the footage. An index that does not serve the
sort is a blocking in-memory sort that looks fine against a fixture.

### 4. ⚠️ Bookmarks and evidence metadata went _inside_ existing panels, not into new panel ids

The frozen registry has seventeen panel ids and none of them is `bookmarks` or `evidence-metadata`.
Adding two would have been a contract change, and the freeze is explicit that only a real
implementation problem justifies one. This is not one: a bookmark strip belongs beside the transport
it navigates, and a metadata block belongs next to the item it describes. Both are sections of the
panels that already own them.

Likewise the selected evidence id is **session-scoped React state**, not `WorkspaceViewState`. The
frozen state contract carries preferences worth restoring; a selected evidence id is not one — the
incident may be closed, the item purged, or access withdrawn, and a restored id fails a fetch for
reasons the operator cannot see.

## Consequences

**Good.** An investigator can open an incident, watch its footage, scrub a timeline that shows the
holes, mark moments, and read the item's provenance — from the browser, with the access recorded.
Three `not-built` placeholders are gone and `playback` is no longer reported as unbuilt in workspace
health.

**Costs.** The player is one component with local transport state; a second surface (a multi-camera
wall) will need that state lifted. The bookmark collection is the Workflow context's second
collection, so its integration tests now need two.

**Deliberately not done.** Multi-camera walls, annotations, hover thumbnails, export packaging,
snapshot rendering. All contract-frozen, all visible on screen as unavailable with a reason.

## Alternatives considered

- **A `playback:read` permission** — rejected: playback resolves an evidence record that is already
  permissioned, and a second gate over the same authority resolves in whichever direction the code
  happens to check (`REFUSED_WORKSPACE_PERMISSIONS`).
- **Bookmarks embedded on the incident** — rejected on document growth and read shape (decision 3).
- **New panel ids for bookmarks and metadata** — rejected: a contract change with no implementation
  problem behind it (decision 4).
- **Caching the playback session like other evidence reads** — rejected: its signed URLs expire, so
  `staleTime` is derived from the session's own earliest segment expiry, less a margin.
- **Probing `canPlayType` with the manifest codec** — rejected after measuring: it declares every
  H.264 clip undecodable. See the UI review artifact.

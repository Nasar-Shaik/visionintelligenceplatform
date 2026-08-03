# Investigation Workspace — the canonical specification

**Frozen 2026-08-03 (P-5.2.0).** This is the reference layout the Architect asked for. It is a
specification, not an implementation: the workspace slice (P-5.2) builds against it.

The parts that must not drift are **data**, not prose — `INVESTIGATION_WORKSPACE_LAYOUT` and
`WORKSPACE_COMMANDS` in `@vip/contracts`, asserted by `packages/contracts/test/workspace.test.ts`.
This document explains the reasoning and covers what a schema cannot: what the surfaces look like,
how they degrade, and how they behave under a keyboard.

Visual language: [DESIGN_SYSTEM](phase2/DESIGN_SYSTEM.md) v2 §10–22.

---

## 1. The layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Top bar — tenant · global search (/) · command palette (⌘K) · clock · user  │
├───────────────┬──────────────────────────────────────┬───────────────────────┤
│ LEFT  320px   │ CENTER            (min 480px)        │ RIGHT  380px          │
│               │                                      │                       │
│ Incident      │ Evidence                             │ Details               │
│   Queue       │ Playback                             │ Why This Fired        │
│ Saved         │ ─────────────────────────────────    │ Assignment            │
│   Investig.   │ Timeline              (180px)        │ Comments              │
│ Filters       │                                      │ Attachments           │
│               │                                      │ AI Recommendations    │
├───────────────┴──────────────────────────────────────┴───────────────────────┤
│ BOTTOM  220px — Related Events │ Related Incidents │ Audit Trail             │
└──────────────────────────────────────────────────────────────────────────────┘
```

Four regions, fifteen panels. `left`/`right` resize horizontally, `bottom` vertically, `center`
takes the remainder — which is why panel size bounds are stated along an **axis** (`minSizePx`)
rather than as a width.

### Panels

| Panel                | Region | Source   | Permission           | State        |
| -------------------- | ------ | -------- | -------------------- | ------------ |
| Incident Queue       | left   | workflow | `incident:read`      | available    |
| Saved Investigations | left   | workflow | `investigation:read` | **deferred** |
| Filters              | left   | client   | `incident:read`      | available    |
| Evidence             | center | evidence | `evidence:read`      | available    |
| Playback             | center | media    | `stream:read`        | available    |
| Timeline             | center | workflow | `incident:read`      | available    |
| Details              | right  | workflow | `incident:read`      | available    |
| Why This Fired       | right  | rules    | `rule:read`          | available    |
| Assignment           | right  | workflow | `incident:read`      | available    |
| Comments             | right  | workflow | `incident:read`      | available    |
| Attachments          | right  | workflow | `incident:read`      | available    |
| AI Recommendations   | right  | workflow | `incident:read`      | **deferred** |
| Related Events       | bottom | events   | `event:read`         | available    |
| Related Incidents    | bottom | workflow | `incident:read`      | available    |
| Audit Trail          | bottom | workflow | `incident:read`      | available    |

**A panel whose permission the principal lacks is omitted, not disabled.** A greyed-out control
still tells a viewer that the capability exists and who holds it.

### ⚠️ Two panels are deferred, and they say so

`availability` is a first-class field because two panels in the approved layout have no producer:

- **AI Recommendations.** `IncidentRecommendation` was frozen in P-5.1 with no model emitting one. A
  panel that renders "no recommendations" for an incident nothing has analysed is a confident false
  statement sitting inside an investigation record. It renders the reason instead.
- **Saved Investigations.** Contract-frozen in P-5.2.0; no store exists.

They render their header and stated reason at 60% opacity rather than vanishing, so the layout does
not reflow when the capability arrives. This is DESIGN_SYSTEM §11's fourth render state —
**Unavailable**, distinct from Empty — and it is CONSTRAINTS §44 and §63 applied to a screen.

---

## 2. Dock behaviour

Modelled on VS Code, Azure Portal and Grafana, with one deliberate restriction: **a panel is not
relocatable until someone decides it is.** `allowedRegions` defaults to the panel's own region,
because "draggable everywhere" produces layouts that cannot be supported and screenshots that do not
match the documentation.

| Behaviour | Rule                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Resize    | 4px handle, 8px grab area; clamped to `minSizePx`/`maxSizePx`; centre never below 480px                                           |
| Collapse  | Header stays visible. A collapsed panel that vanishes cannot be found again                                                       |
| Hide      | Only where `hideable`. **Incident Queue, Evidence, Playback and Details are not hideable** — an operator cannot work without them |
| Float     | Queue, Evidence and Playback only. A second monitor is how control rooms actually work                                            |
| Persist   | Per panel, under `persistenceKey` (`vip.workspace.<slug>`), scoped per tenant + principal                                         |

⚠️ **`persistenceKey` never contains the layout version.** A key carrying it would silently reset
every operator's layout the next time a panel was added — data loss that reads as a browser bug.

---

## 3. Keyboard

Every binding comes from `WORKSPACE_COMMANDS`. **No component binds a key**, because a component
cannot: the binding lives on the command, and the palette and the key handler read the same array.

| Chord      | Command                                | Scope     |
| ---------- | -------------------------------------- | --------- |
| `⌘/Ctrl+K` | Command Palette                        | global    |
| `/`        | Search                                 | global    |
| `⌘+1…4`    | Queue · Evidence · Playback · Timeline | workspace |
| `Space`    | Play / Pause                           | playback  |
| `←` `→`    | Previous / Next frame                  | playback  |
| `⌘+B`      | Bookmark this moment                   | playback  |
| `⌘⇧A`      | Assign incident                        | workspace |
| `⌘⇧R`      | Resolve incident                       | workspace |
| `⌘⇧E`      | Export report                          | workspace |

Three rules the schema enforces rather than documents:

1. **A mutating command may not bind a bare key.** `r` for Resolve is one keystroke from a state
   change whenever focus is not in a text field — which, in an investigation UI, is constantly.
   Hence `⌘⇧R`.
2. **Chords are written `Mod+K`, never `Ctrl+K`.** `Mod` resolves to ⌘ on macOS and Ctrl elsewhere.
   Hard-coding either ships the wrong shortcut to half the operators — the half that files no bug,
   because they assume the product has no shortcuts.
3. **No two commands share a chord in the same scope**, and a `global` chord shadows every nested
   scope. Conflicts are silent: one handler wins consistently and the other command simply never
   fires.

The palette lists only commands the principal has permission for, and **omits** the rest.

---

## 4. Playback

The immediate customer priority is **recorded CCTV — no live camera required**.

### Controls

Play/pause · scrub · frame step · rate · zoom · marker jump · bookmark · snapshot · export.

⚠️ **Every control is offered only if the source supports it.** `PlaybackCapabilities` is declared
per session because it genuinely varies: frame-accurate stepping needs seekable, keyframe-dense
video, and an un-materialised Media clip is _a reference to a time range across segments_, which
cannot be stepped frame-accurately at all. Rendering the button anyway produces a control that works
on some footage and silently does nothing on the rest, with no way for an operator to tell which.

`frameRate` is absent when the source does not declare one. It is never assumed to be 30 — every
frame-step calculation downstream would be quietly wrong.

### ⚠️ Gaps

Recorded CCTV is not continuous: a camera drops, a disk fills, a retention sweep purges the middle
of a day. A player that concatenates segments shows 14:00 running into 14:20, and an operator reads
that as twenty uneventful minutes. It is twenty minutes of missing footage — and that is usually
what the investigation is about.

So the scrubber is drawn against **wall-clock time**, not against the sum of the segments. Every
discontinuity is a `PlaybackGap` with a reason — `no-recording`, `purged`, `forbidden`,
`unavailable` — rendered as a hatched region sized to the real elapsed time.
`durationSeconds - playableSeconds` is the total missing time, and it is shown.

### View state is not a contract

Zoom, rate, frame position and the current scrub point are the operator's browser. Modelling them
server-side would invent persistence for something nobody stores and put a write on every scrub.
What _is_ persisted is a **bookmark** — a deliberate act of saving a moment — and it stores wall
clock `at` as the authority, with `offsetSeconds` recomputed on read.

### Ownership

**Bookmarks and annotations belong to the Incident context.** Evidence is immutable, and that
immutability is the entire value of the Evidence Foundation. An annotation is an investigator's
_statement about_ evidence; it references the evidence by id and lives with the investigation —
[CONTEXT_OWNERSHIP](CONTEXT_OWNERSHIP.md) line 1. Nothing in the playback contract adds a mutable
field to an evidence record.

Annotation coordinates are **normalised [0,1]**. Pixel coordinates drift the first time someone
reviews a downscaled copy of a 4K stream, and the box lands somewhere else without anyone noticing.

⚠️ **A snapshot creates a new Evidence record.** "Export a snapshot" must never mean "write a frame
into the clip it came from". The new record carries its own integrity hash and custody log, with
`source` pointing back at what it was taken from.

---

## 5. State restoration

Persisted workspace state is **references and view state only** — never records.

> A reference may be persisted. A record may not.

`incidentId: "abc"` is a pointer that goes stale safely: you re-fetch and get a 404, a 403, or the
truth. `{id, status, title}` is a copy in a browser with no invalidation, no tenant check and no
permission check — and it renders a stale status confidently, after access has been revoked.

**Restore is a re-fetch, not a rehydrate.** Every id is resolved under the current principal's
permissions, and anything that fails is reported in `WorkspaceStateRestore.dropped` with a reason
(`not-found` · `forbidden` · `wrong-tenant` · `invalid` · `stale-schema`). An operator whose
workspace quietly loses a tab assumes they closed it.

State is keyed by **tenant and principal** — `vip.workspace.state.<tenant>.<principal>`. The scope
is in the key, not in a field a reader is trusted to compare: a shared control-room browser must not
restore the previous shift's open incidents, and an id must never cross a tenant boundary.

---

## 6. How it degrades

| Missing                      | The workspace shows                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| Events context down          | Timeline entries from the incident, **plus a typed `unavailable` gap** naming events |
| No evidence for the incident | Evidence panel Empty — a real, correct "there is none"                               |
| No AI advisor                | AI panel **Unavailable** with its reason. Never "no recommendations"                 |
| No SLA policy configured     | SLA badge reads `unknown` / "not measured". **Never** met                            |
| Footage missing              | Hatched gap on the scrubber, sized to real elapsed time                              |
| Upstream timeout (2s)        | Partial timeline, gap recorded, the rest still rendered                              |

The rule underneath all six rows: **returning the partial view is right; returning it silently is
not.**

⚠️ **Closed in P-5.2.** The joins are wired (`HttpTimelineSources`), so a configured deployment
answers from all four sources. A source with **no configured URL** still degrades to a named
`unavailable` gap — identical behaviour to the unwired state, so a partly-wired deployment does not
fork into a second code path.

⚠️ **A fifth gap reason exists: `forbidden`.** The joins run under the **caller's own permissions**,
never a service key — otherwise the timeline would show an operator events they cannot open in the
Events panel. That makes 403 routine, and it is not an outage: reporting it as `unavailable` sends
someone to an engineer for what a role grant fixes.

---

## Related

- Contracts: `@vip/contracts` — `workspace/`, `playback/`, `search/`, `jobs/`, `reporting/`, `audit/`
- [ADR-0031](../adr/ADR-0031-workspace-prerequisites.md) · [P-5-INCIDENT-MANAGEMENT](P-5-INCIDENT-MANAGEMENT.md) · [INCIDENT_BOUNDARY](INCIDENT_BOUNDARY.md) · [CONTEXT_OWNERSHIP](CONTEXT_OWNERSHIP.md)
- [DESIGN_SYSTEM](phase2/DESIGN_SYSTEM.md) v2 · [CONSTRAINTS](../project/CONSTRAINTS.md) §64–69

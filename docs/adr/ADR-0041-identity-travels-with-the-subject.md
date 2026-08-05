# ADR-0041 — Identity travels with the subject, or rules under-fire silently

- **Status:** Accepted
- **Date:** 2026-08-06
- **Milestone:** P-8 Phase 5 (Live Event Bridge)
- **Amends:** the frozen `EventSubject` and `Detection` contracts — **additively**
- **Related:** [ADR-0038](ADR-0038-track-identity-across-gaps.md) (re-entry is a link),
  [ADR-0040](ADR-0040-one-event-envelope-many-payload-schemas.md) (one envelope),
  [L-42](../project/KNOWN_LIMITATIONS.md)

## Context

ADR-0038 established that a track which leaves and returns gets a **new `trackId`**, linked to its
predecessor by `identityId` and `precededBy`. The `trackId` is never reused, because recycling it
would break the contract's one guarantee silently for every consumer already holding it.

`EventSubject` — the part of an `EventEnvelope` that says _who the event is about_ — carries
`trackId`. It does not carry `identityId`.

### ⚠️ The consequence is a rule that never fires, with nothing to see

A loitering rule accumulates dwell per subject. If it accumulates by `trackId`, a person who is
briefly occluded — behind a pillar, behind another person, at the edge of a frame — becomes **two
short visits instead of one long one**. A sixty-second threshold is never crossed. There is no error,
no dropped message, no alert, no failed health check. The incident simply does not happen.

Under [L-42](../project/KNOWN_LIMITATIONS.md) this is not hypothetical: identity fragments as a host
saturates, and the two measured ladder runs disagree on how much (6 % and 31 % overhead at sixteen
cameras). ⚠️ **The rule engine's correctness would therefore depend on host load** — the same scene,
the same rule and the same person produce an incident on a quiet host and no incident on a busy one.

That is the worst class of defect this platform can ship: wrong, silent, and load-dependent.

## Decision

**`identityId` and `precededBy` are added to `EventSubject`, optional and additive — and to
`Detection`, for the same reason, because otherwise nothing can carry them there.**

```
Track (identityId, precededBy)        ← RuntimeTracker, ADR-0038
   │  stamped onto the detection it matched
   ▼
Detection (trackingId, identityId, precededBy)   ← additive, this ADR
   │  carried in the DetectionResult the runtime returns
   ▼
EventSubject (trackId, identityId, precededBy)   ← additive, this ADR
   │
   ▼
Rules aggregate by identityId, not trackId
```

⚠️ **Two frozen contracts are touched, and only one was named in the approval.** `EventSubject` was
approved explicitly. `Detection` follows necessarily: a field on the subject that nothing can
populate is decoration. Both changes are optional fields on existing shapes — an archived payload
still parses, and a producer that does not set them is unchanged.

### The consumer chooses, and both choices stay legitimate

- **`trackId`** — "this uninterrupted observation". Correct for "show me this exact track's path".
- **`identityId`** — "the same subject across gaps the tracker could bridge". Correct for dwell,
  loitering, occupancy and anything that accumulates over time.

Both questions are real and they are **different questions**. Neither field is a correction of the
other, which is why both are carried rather than one being derived.

## Consequences

**Good.** A dwell rule can be correct in the presence of ordinary occlusion, which is most real
scenes. The fix is a contract field rather than tracker tuning, so it does not trade identity
stability against anything else. Downstream consumers that do not care are unaffected.

⚠️ **It makes dwell correctable, not correct.** Two fragments the tracker never linked still look
like two subjects — `identityId` only carries the links that were actually made. Re-entry is
appearance-blind (L-42): outside the gap, distance and size gates, no link forms, and the rule still
under-fires. **This closes the gap the platform can close and discloses the rest**; it is not a
solution to fragmentation and must not be described as one.

⚠️ **A rule author can still choose wrong.** Nothing forces aggregation by `identityId`. The rule
configuration must make the choice explicit and the default must be `identityId` for accumulating
rules, because the failure of the wrong default is invisible.

⚠️ **`identityId` is advisory, and an incident built on it inherits that.** ADR-0038 established that
re-entry linking is geometric, not appearance-based, and can link the wrong person. An incident that
says "this person loitered for ninety seconds" where the ninety seconds spans a re-entry link is
asserting something the platform believes rather than something it observed. The operator surface
must show both ids, as the track pages already do.

## Alternatives considered

**Put identity in `subject.attributes`.** Rejected. It avoids touching a frozen contract, and that
was genuinely attractive. But `attributes` is a free-form bag: identity would be stringly typed,
undiscoverable, unvalidated, and easy for a rule author to misspell into silence. The field that
decides whether a rule fires must be the most visible one, not the least.

**Have rules resolve `trackId → identityId` by querying the tracker.** Rejected. It puts a
synchronous lookup on the evaluation path, couples the rule engine to the runtime's live state, and
fails entirely for a replayed or archived event — where the tracker's memory is long gone. An event
must be self-describing.

**Recycle `trackId` on re-entry so one id spans the gap.** Rejected in ADR-0038 and rejected again
here for the same reason. It would make dwell work by breaking the guarantee that a `trackId` refers
to one uninterrupted observation, silently, for every consumer already holding one.

**Do nothing and disclose it.** Rejected. The failure is invisible, load-dependent and changes a
verdict rather than a number. Disclosure is the right answer for a limit that cannot be fixed; this
one can be, cheaply.

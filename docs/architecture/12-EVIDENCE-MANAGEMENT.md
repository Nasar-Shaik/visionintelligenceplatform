# 12 — Evidence Management

## Purpose

Define the evidence platform: snapshots, video clips, metadata, timelines, bookmarks, annotations, export, retention, legal hold, and chain of custody — the defensible record of "what happened." Delivers the ≥90% storage-reduction NFR.

## Responsibilities

- Produce and store event/incident evidence (clips + snapshots + metadata) efficiently.
- Provide timeline, bookmarks, annotations, and export with integrity guarantees.
- Enforce retention, legal hold, and chain of custody.

---

## 1. Smart-clip principle (storage economics)

Never store continuous video in the cloud by default — store **only event/incident clips with context**, achieving **~90–95% reduction** vs 24/7 recording. Optional low-bitrate continuous "background" recording can be kept **on-prem** for compliance while cloud holds only event clips (configurable per policy).

## 2. Clip generation

1. **Pre-roll ring buffer** per camera (30–60s) → the seconds _before_ the trigger already exist. → [07 §2](07-DATA-AND-PIPELINE-FLOWS.md)
2. **Window**: `T_pre` before + `T_post` after the trigger; **dynamic extension** while behavior continues (capped).
3. **Merge overlapping** windows (same/nearby cameras) into one clip with multiple event markers → no duplicate storage.
4. **Transcode** to MP4 (H.264/H.265) + **thumbnail/keyframe sprite** for the timeline.
5. **Store** to object storage `{tenantId}/{cameraId}/{eventId}.mp4`, KMS-encrypted, retention-tagged; metadata → OLTP; embeddings → vector store for search.

## 3. Snapshots & metadata

- Key-frame **snapshots** attached at event creation (low cost, instant preview).
- **Metadata** per evidence item: event refs, capabilities/models that produced it, bounding boxes, tracks, zones, identities (permission-gated), severity, producing rule, and integrity hash.

## 4. Timeline

- Per camera/site/day **timeline** of event markers (severity-colored, filterable, jump-to-clip) — the review surface. Derived read model over the event store ([09 §9](09-EVENT-PLATFORM.md)).

## 5. Bookmarks & annotations

- Operators **bookmark** moments and **annotate** clips (notes, tags, redaction regions, drawn markers). Annotations are versioned and audited; they never mutate the original media (overlay/sidecar model), preserving evidentiary integrity.

## 6. Export

- Export single clips, incident bundles, or case bundles as signed packages: **watermarked** (tenant/user/time), with an included **manifest** (hashes, chain-of-custody log, event metadata). Export is a **permission-gated, audited, approvable** action ([11 §5](11-WORKFLOW-ENGINE.md)). Formats suitable for handoff to authorities.

## 7. Retention & tiering

- Per-plan and per-camera retention; lifecycle **hot → cold → archive → delete**; safety-critical and legal-hold items retained longer. Automated, **verifiable purge** with audit. Retention policies drive scheduled sweeps. → [18](18-DATA-ARCHITECTURE.md)

## 8. Legal hold

- Placing a legal hold on an incident/case/camera/time-range **overrides deletion** for matching evidence until released. Holds are audited; released holds resume normal retention. Essential for litigation and investigations.

## 9. Chain of custody

- Every evidence item records an **append-only custody log**: created (by which capability/model), accessed (who/when/why — reason-for-access), annotated, exported, held, deleted. Integrity via content hashing (and hash-chaining of the log); tamper-evident. Exports carry the custody manifest. This makes evidence admissible and defensible for banks/government/law-enforcement handoff.

## Design decisions

- **Ring-buffer-derived clips** give pre-event context without continuous recording — the core of the storage-economics win.
- **Overlay annotations + content hashing** preserve original-media integrity while allowing rich review.
- **Custody + legal hold + watermarked export** are built-in, not a vertical add-on, because many target industries are regulated.

## Advantages

- Drastic storage/bandwidth savings; only relevant footage to review.
- Defensible, exportable evidence suitable for regulated and legal contexts.
- Search-ready (embeddings) and timeline-navigable.

## Tradeoffs

- Smart-clip-only can miss un-triggered footage; mitigated by optional on-prem continuous background recording and by tunable pre/post-roll and rules.
- Chain-of-custody rigor adds write overhead; acceptable given its value and low relative volume.

## Future expansion

- Redaction automation (auto-blur non-subjects for export), multi-camera synchronized evidence playback, blockchain-anchored custody attestations, cross-site evidence correlation.

## Cross-references

[07-DATA-AND-PIPELINE-FLOWS](07-DATA-AND-PIPELINE-FLOWS.md) · [09-EVENT-PLATFORM](09-EVENT-PLATFORM.md) · [11-WORKFLOW-ENGINE](11-WORKFLOW-ENGINE.md) · [15-SECURITY-ARCHITECTURE](15-SECURITY-ARCHITECTURE.md) · [18-DATA-ARCHITECTURE](18-DATA-ARCHITECTURE.md)

# ADR-0055 · Re-identification governance

- **Status:** ⛔ **Proposed — awaiting Architect approval. No Re-ID code may be written until this is Accepted.**
- **Date:** 2026-08-10
- **Milestone:** P-12 Professional Perception, P3.5 (gate only — implementation not started)
- **Relates to:** [ADR-0038](ADR-0038-track-identity-across-gaps.md), [ADR-0041](ADR-0041-identity-id-is-not-tracking-id.md), [ADR-0051](ADR-0051-track-history-becomes-durable.md), [ADR-0052](ADR-0052-behaviour-reasoning-is-not-perception.md)

## Context

Re-identification would let VIP recognise that the person on camera 3 at 14:20 is the person who was
on camera 1 at 14:05 — the capability that makes multi-camera estates and re-entry coherent. It is
requested, it is architecturally straightforward, and it is the first capability in this platform's
history whose **principal risk is not technical**.

⛔ **An appearance embedding is a biometric identifier.** It is a vector derived from a person's
body, computed for the purpose of distinguishing that person from other people. Under UK GDPR /
EU GDPR Article 9 that is *special category* data when used for unique identification, and it
attracts a materially higher bar than anything VIP stores today: a movement path is personal data
about a *track*, while an embedding is a key that can match a person across sessions, cameras, sites
and — in principle — across customers.

⚠️ **The platform's existing identity model is deliberately weaker than this, and that was a
decision.** [ADR-0038](ADR-0038-track-identity-across-gaps.md) bridges an occlusion gap using
*geometry and time*, not appearance. [ADR-0041](ADR-0041-identity-id-is-not-tracking-id.md) makes
`identityId` a within-analysis construct. Nothing in VIP today can recognise a person it has seen
before, and that limitation is also a privacy property.

⭐ **Getting this wrong is not a bug that ships and is fixed.** An embedding store is a biometric
database; building one and later deciding it should not have existed leaves the data already
collected.

## Decision

**Deferred, pending explicit approval of the terms below.** Re-ID is *not* approved by the approval
of Phase 3. It requires this ADR to be Accepted on its own.

The terms proposed, each of which the Architect should accept, amend or reject:

| # | Question | Proposed position |
| --- | --- | --- |
| 1 | **Purpose** | Re-entry and cross-camera continuity **within one tenant's estate**, for investigating a specific incident. ⛔ Never watchlisting, never matching a person against a stored gallery of known individuals |
| 2 | **What is computed** | A fixed-length appearance embedding per identity, from the person crop |
| 3 | **What is stored** | ⭐ **Proposed: nothing, by default.** Embeddings live for the analysis and are discarded with it — same lifetime as the tracker state, not the evidence |
| 4 | **Persistence** | If persistence is ever enabled it is **per tenant, opt-in, off by default**, and the embedding is stored beside the movement path under the same retention clock — never longer |
| 5 | **Retention** | Bound to `DEFAULT_RETENTION_HOURS` (72 h) at most. ⚠️ Never a separate, longer-lived gallery — that is precisely how a short-retention promise becomes false |
| 6 | **Tenant isolation** | Structural, like every other read: an embedding never leaves its tenant, and cross-tenant matching is **not implementable**, not merely disabled |
| 7 | **Deletion** | Tenant erasure removes embeddings in the same operation as track history — [ADR-0051](ADR-0051-track-history-becomes-durable.md)'s `forget_tenant` covers the live buffer *and* the store, and this must too |
| 8 | **Access control** | Behind a permission **stricter** than `track:read`. An appearance match is more revealing than the path it links |
| 9 | **Default state** | ⛔ **Disabled.** A deployment acquires Re-ID because an operator enabled it, not because it was imported |
| 10 | **Explainability** | A match is an **observation with a similarity score and a threshold**, exactly like every other primitive ([ADR-0052](ADR-0052-behaviour-reasoning-is-not-perception.md)). It must be visible in a WHY chain and contestable. ⛔ Never a silent identity merge |
| 11 | **Model licence** | Apache-2.0/MIT only, artifact checksummed and provenanced, on the same terms as every other model |

## Consequences

**Good.** The decision is made before the code, which is the only order in which it can be made
freely. If persistence stays off, VIP gains cross-camera continuity *within a run* while storing no
biometric identifier at all — which is a genuinely defensible position and a commercial asset in a
market where competitors cannot say it.

**Costs, stated.** Embeddings that do not persist cannot link a person across *sessions* — so
"this is the same man who was here on Tuesday" remains unanswerable. ⚠️ That is a real product
limitation and the Architect should decide it deliberately rather than discover it later.

**Bad.** A per-frame crop and embedding on the inference path costs latency the CPU budget may not
have; sizing is part of P3.5 and not assumed here.

## Alternatives considered

| Alternative | ⚠️ Why not proposed |
| --- | --- |
| Persist embeddings by default | Creates a biometric database as a side effect of a feature flag nobody consciously set |
| Store embeddings with their own longer retention | Makes the 72-hour promise false for the most sensitive field in the system |
| Treat an embedding as "just another attribute" | It is the one attribute that identifies a person *across* the boundaries every other control is scoped to |
| Skip Re-ID entirely | Forfeits multi-camera estates, which is a stated long-term objective |

## ⛔ Gate

**No Re-ID implementation — no model, no adapter, no schema field, no catalogue entry — until this
ADR's status is `Accepted`.** Approving Phase 3 does not approve this. It is listed at P3.5 in the
phase order, and P3.1 through P3.4 do not depend on it.

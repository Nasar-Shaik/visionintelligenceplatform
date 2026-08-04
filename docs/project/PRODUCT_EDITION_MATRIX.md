# Product Edition Matrix

> **Commercial packaging.** Which capabilities belong to which edition, and what each edition meters.

⚠️ **Capabilities are defined once, in
[PRODUCT_CAPABILITY_MATRIX](PRODUCT_CAPABILITY_MATRIX.md).** This file references them by id
(`C-nn`) and never restates what one is. If you find yourself explaining a capability here, the
explanation belongs there.

---

## Read this first

**Nothing in this file is enforced.** `C-61` (licensing & entitlements) does not exist — there is no
entitlement record, no camera-count check and no feature gate anywhere in the platform. **Every
deployment today behaves as Enterprise**, because there is nothing to make it behave otherwise.

That is not a defect; enforcement is scheduled at P-14. It is stated at the top because an edition
matrix reads like a description of the product, and this one is a description of an **intention**.

Three consequences worth being explicit about:

1. **Do not quote these editions to a customer as though they are switchable today.** They are not.
2. **Do not build feature gates before C-61 exists.** Scattering `if (edition === …)` through the
   console is how a product acquires a licensing model no one designed. Entitlements are resolved
   once, server-side, and the UI asks one question.
3. **The pilot customer gets everything.** A first pilot on a metered edition would be measuring the
   meter rather than the product.

---

## The commercial model, before the feature list

A feature checklist is not a pricing model. What a CCTV platform actually sells is **scale and
autonomy**, and the meters below are what a customer's invoice should move with. Getting these right
matters more than which tier a checkbox lands in.

| Meter                       | Why it is the meter                                                                                           | Enforced by         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------- |
| **Cameras**                 | The one number that tracks both customer value and our cost — storage, decode and inference all scale with it | C-61 · camera       |
| **Sites** (hierarchy roots) | Distinguishes one shop from a chain. Maps to `OrgNode` depth, which already exists                            | C-61 · tenant       |
| **Evidence retention**      | The dominant storage cost, and a genuine compliance differentiator                                            | C-56                |
| **AI capability**           | Detection is cheap; behaviour analytics is the expensive, valuable part                                       | C-61 · ai/inference |
| **Deployment autonomy**     | Hosted → self-hosted → air-gapped. A support-cost and trust axis, not a feature axis                          | packaging           |

⚠️ **Do not meter operators.** Per-seat pricing on a security product pushes a customer toward shared
logins, which destroys the audit trail (`C-33`, `C-39`) that makes the evidence admissible. The
platform's core value proposition is undermined by its own pricing model. Meter cameras; give away
users.

---

## Editions

|                | **Starter**           | **Professional**      | **Enterprise**                   | **Government**                     |
| -------------- | --------------------- | --------------------- | -------------------------------- | ---------------------------------- |
| **For**        | One site, one manager | A chain or a campus   | A national estate, or a reseller | Regulated, air-gapped, evidentiary |
| **Cameras**    | up to 25              | up to 250             | unlimited                        | unlimited                          |
| **Sites**      | 1                     | up to 25              | unlimited                        | unlimited                          |
| **Retention**  | 30 days               | 90 days               | configurable                     | configurable + legal hold          |
| **Deployment** | hosted                | hosted or self-hosted | self-hosted                      | **air-gapped**                     |
| **Support**    | community             | business hours        | 24×7                             | 24×7 + named engineer              |

## Feature availability

**✅ Available · ⛔ Not available · 🕒 Planned** (with the milestone that delivers it).

Everything marked 🕒 is unavailable in **every** edition today — the tier column says where it will
land, not where it is.

### Core — every edition, always

These are not differentiators. A security platform that meters its own integrity guarantees is not
one.

| id                 | Capability                                        |   Starter   | Professional | Enterprise  | Government  |
| ------------------ | ------------------------------------------------- | :---------: | :----------: | :---------: | :---------: |
| C-01 · C-02        | Authentication · tenant isolation                 |     ✅      |      ✅      |     ✅      |     ✅      |
| C-03               | User administration                               |   🕒 P-6    |    🕒 P-6    |   🕒 P-6    |   🕒 P-6    |
| C-07 · C-08        | Location hierarchy · camera onboarding            |     ✅      |      ✅      |     ✅      |     ✅      |
| C-16               | Event pipeline                                    |     ✅      |      ✅      |     ✅      |     ✅      |
| C-24 · C-25        | Rule authoring · editing                          | ✅ · 🕒 P-6 | ✅ · 🕒 P-6  | ✅ · 🕒 P-6 | ✅ · 🕒 P-6 |
| C-29 · C-30        | Incident lifecycle · assignment · SLA             |     ✅      |      ✅      |     ✅      |     ✅      |
| C-31 · C-32        | Investigation workspace · evidence playback       |     ✅      |      ✅      |     ✅      |     ✅      |
| **C-33**           | **Chain of custody · integrity hashes**           |     ✅      |      ✅      |     ✅      |     ✅      |
| C-34 · C-35 · C-36 | Timeline · bookmarks · marked display adjustments |     ✅      |      ✅      |     ✅      |     ✅      |
| C-41 · C-42        | In-app notifications · notification centre        | ✅ · 🕒 P-6 | ✅ · 🕒 P-6  | ✅ · 🕒 P-6 | ✅ · 🕒 P-6 |
| C-49               | Evidence download + integrity verification        |     ✅      |      ✅      |     ✅      |     ✅      |
| C-52 · C-54        | System health · observability                     | 🕒 P-6 · ✅ | 🕒 P-6 · ✅  | 🕒 P-6 · ✅ | 🕒 P-6 · ✅ |
| C-53               | Backup · restore · upgrade · rollback             |     ✅      |      ✅      |     ✅      |     ✅      |
| C-64               | Accessibility (WCAG AA)                           |     ✅      |      ✅      |     ✅      |     ✅      |

### Estate management

| id          | Capability                                |     Starter     | Professional | Enterprise | Government |
| ----------- | ----------------------------------------- | :-------------: | :----------: | :--------: | :--------: |
| C-09        | ONVIF discovery                           | ⛔ manual entry |      ✅      |     ✅     |     ✅     |
| C-10 · C-11 | Capabilities · probes · measured health   |       ✅        |      ✅      |     ✅     |     ✅     |
| C-12        | Lifecycle — retire · reinstate · **bulk** |       ⛔        |      ✅      |     ✅     |     ✅     |
| C-13        | NVR / DVR channel onboarding              |       ⛔        |      ✅      |     ✅     |     ✅     |
| C-14        | Media catalogue                           |     🕒 P-6      |    🕒 P-6    |   🕒 P-6   |   🕒 P-6   |
| C-05        | Tenant settings                           |     🕒 P-6      |    🕒 P-6    |   🕒 P-6   |   🕒 P-6   |

### Perception — where the product earns its name

| id       | Capability                                                 | Starter | Professional | Enterprise | Government |
| -------- | ---------------------------------------------------------- | :-----: | :----------: | :--------: | :--------: |
| C-17     | Detection — person · vehicle · fire · smoke                | 🕒 P-8  |    🕒 P-8    |   🕒 P-8   |   🕒 P-8   |
| C-18     | Tracking · zones · counting                                |   ⛔    |    🕒 P-8    |   🕒 P-8   |   🕒 P-8   |
| **C-20** | **Behaviour analytics** — loitering · intrusion · crowding |   ⛔    |    🕒 P-8    |   🕒 P-8   |   🕒 P-8   |
| C-21     | Upload a recording and analyse it                          |   ⛔    |    🕒 P-8    |   🕒 P-8   |   🕒 P-8   |
| **C-22** | **Live video**                                             | 🕒 P-8  |    🕒 P-8    |   🕒 P-8   |   🕒 P-8   |
| C-23     | Auto-captured evidence                                     | 🕒 P-8  |    🕒 P-8    |   🕒 P-8   |   🕒 P-8   |

⚠️ **C-20 is the Starter/Professional boundary**, and it is the only feature boundary in this file
that is genuinely about value rather than scale. Detection tells a customer _something moved_.
Behaviour analytics tells them _something is wrong_. That is the upgrade conversation.

### Alerting

| id   | Capability                         | Starter | Professional | Enterprise | Government |
| ---- | ---------------------------------- | :-----: | :----------: | :--------: | :--------: |
| C-43 | Email notifications                | 🕒 P-7  |    🕒 P-7    |   🕒 P-7   |   🕒 P-7   |
| C-43 | SMS · Slack · Teams                |   ⛔    |    🕒 P-7    |   🕒 P-7   |   🕒 P-7   |
| C-44 | Notification policies · escalation |   ⛔    |    🕒 P-7    |   🕒 P-7   |   🕒 P-7   |
| C-45 | Real-time delivery (SSE)           |   ✅    |      ✅      |     ✅     |     ✅     |

### Investigation at scale

| id       | Capability                      | Starter | Professional | Enterprise | Government |
| -------- | ------------------------------- | :-----: | :----------: | :--------: | :--------: |
| C-37     | Saved investigations · pins     |   ⛔    |   🕒 P-12    |  🕒 P-12   |  🕒 P-12   |
| C-38     | Unified search                  |   ⛔    |      ⛔      |  🕒 P-12   |  🕒 P-12   |
| **C-39** | **Access audit**                |   ⛔    |      ⛔      |  🕒 P-12   |  🕒 P-12   |
| C-40     | Point-in-time evidence ancestry |   ✅    |      ✅      |  🕒 P-11   |  🕒 P-11   |

### Reporting & analytics

| id          | Capability                             | Starter | Professional | Enterprise | Government |
| ----------- | -------------------------------------- | :-----: | :----------: | :--------: | :--------: |
| C-47        | Report generation                      |   ⛔    |   🕒 P-11    |  🕒 P-11   |  🕒 P-11   |
| **C-48**    | **Signed, watermarked export bundles** |   ⛔    |   🕒 P-11    |  🕒 P-11   |  🕒 P-11   |
| C-46 · C-50 | Background jobs · monitoring           |   ⛔    |   🕒 P-11    |  🕒 P-11   |  🕒 P-11   |
| C-51        | Dashboards & analytics                 |   ⛔    |   🕒 P-13    |  🕒 P-13   |  🕒 P-13   |
| C-51        | Scheduled reports                      |   ⛔    |      ⛔      |  🕒 P-13   |  🕒 P-13   |

### Enterprise & compliance

| id       | Capability                          |  Starter   | Professional |   Enterprise   |   Government   |
| -------- | ----------------------------------- | :--------: | :----------: | :------------: | :------------: |
| C-59     | Runtime white-label branding        |     ⛔     |      ⛔      |       ✅       |       ✅       |
| C-60     | **Per-tenant** branding             |     ⛔     |      ⛔      |    🕒 P-14     |    🕒 P-14     |
| C-56     | Retention sweeps · tier transitions |     ⛔     |   🕒 P-14    |    🕒 P-14     |    🕒 P-14     |
| **C-57** | **Legal hold · redaction**          |     ⛔     |      ⛔      |    🕒 P-14     |    🕒 P-14     |
| C-55     | Point-in-time backup                |     ⛔     |      ⛔      |    🕒 P-14     |    🕒 P-14     |
| C-58     | Rate limiting at the edge           | ✅ hosted  |  ✅ hosted   |    🕒 P-14     |    🕒 P-14     |
| C-28     | Multi-replica rule state            |     ⛔     |      ⛔      |    🕒 P-14     |    🕒 P-14     |
| C-04     | Fine-grained roles                  | ✅ 4 roles |  ✅ 4 roles  | 🕒 P-14 custom | 🕒 P-14 custom |
| —        | SSO / OIDC federation               |     ⛔     |      ⛔      |   🕒 post-GA   |   🕒 post-GA   |
| —        | Air-gapped install · data residency |     ⛔     |      ⛔      |       ⛔       |   🕒 post-GA   |
| —        | FIPS-validated crypto posture       |     ⛔     |      ⛔      |       ⛔       |   🕒 post-GA   |

⚠️ **Government is the one edition that is not a superset with more zeros.** Air-gapped installation,
data residency and a validated crypto posture are _different engineering_, not a larger allocation —
no ACME certificate issuance, no outbound telemetry, no registry pull at deploy time. It should not
be sold before an air-gapped install has actually been performed, for exactly the reason no camera
model may be called supported before one has been connected.

---

## What is deliberately **not** an edition boundary

Stating these prevents a future "quick win" from quietly making the product worse.

| Never gated                                                            | Why                                                                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chain of custody, integrity hashes, immutable audit history** (C-33) | Selling tamper-evidence as an upgrade means selling a cheaper tier whose evidence is worth less in a dispute. The whole product loses credibility |
| **Tenant isolation** (C-02)                                            | A security boundary is not a feature                                                                                                              |
| **Accessibility** (C-64)                                               | Not negotiable at any price                                                                                                                       |
| **Operator seats**                                                     | See the meter note above — per-seat pricing produces shared logins and destroys the audit trail                                                   |
| **Honest empty and `not-built` states**                                | The product tells the truth in every edition                                                                                                      |
| **Backup and restore** (C-53)                                          | A tier whose data cannot be recovered is not a cheaper product, it is a liability                                                                 |

---

## Open commercial decisions

Engineering has a recommendation for each; the call is the business's.

| #       | Decision                                                                                  | Recommendation                                                                                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E-1** | Is Starter worth building? It costs a metered tier, a support path and a hosted footprint | **Defer past 1.0.** Every early customer will be Professional or Enterprise; Starter is a self-serve motion the product has no funnel for yet                                       |
| **E-2** | Camera-count enforcement: hard block, or soft overage?                                    | **Soft, with a visible warning.** A hard block on camera 26 of a burglary investigation is a support escalation and a bad story                                                     |
| **E-3** | Is behaviour analytics the Professional boundary?                                         | **Yes** — it is the only capability that changes what the product _is_, rather than how much of it you get                                                                          |
| **E-4** | Does Government need a separate build?                                                    | **No — same code, different deployment profile.** The moment it forks, every future milestone ships twice. Air-gap is configuration and packaging                                   |
| **E-5** | Reseller / MSP model?                                                                     | Blocked on **C-60** (per-tenant branding), which is blocked on **D-1** (tenant identity at sign-in). Decide D-1 first — see [IMPLEMENTATION_READINESS](IMPLEMENTATION_READINESS.md) |

---

## Related

- [PRODUCT_CAPABILITY_MATRIX](PRODUCT_CAPABILITY_MATRIX.md) — what every `C-nn` is, and its real state
- [RELEASE_PLAN](RELEASE_PLAN.md) — when each 🕒 becomes ✅
- [PRODUCT_ROADMAP](PRODUCT_ROADMAP.md) — the milestone that does it

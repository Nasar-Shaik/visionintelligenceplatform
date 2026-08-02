# Product Principles

**Mandatory reading before adding a product feature.**

Status: permanent · Established P-3 · Recorded 2026-08-02 at the transition from platform
engineering to product engineering.

---

[FOUNDATION_PRINCIPLES](FOUNDATION_PRINCIPLES.md) governs how the platform is built. This document
governs **what gets built on it**. The foundations are frozen; from here the question is no longer
"is this correct?" but "does a customer get something out of it?" — and both answers still have to be
yes.

The test that sits above all ten:

> **Can a customer understand the value of this during a product demonstration?**
>
> If not, the justification has to be written down, not assumed.

That is not anti-engineering. Every principle below has an engineering consequence, and most of them
are constraints on what we are allowed to build rather than encouragements to build more.

---

## 1. Customer workflows first

A feature is a **workflow a person completes**, not an endpoint that exists. "Onboard a site's
cameras", "find out why this camera stopped", "prove what happened at 14:20" are features. "A
hierarchy API" is not one until someone can walk the estate in the console.

_Consequence:_ a slice is not done when the service returns the right JSON. It is done when the
workflow closes end to end — contract, service, console, test.

## 2. Configuration over customization

Customers differ by **configuration**, never by code. A profile, a template, a rule, a threshold, a
node type — not a branch, not a build flag, not a fork.

_Consequence:_ when a customer need arrives, the first question is which existing knob expresses it.
If none does, add a knob to the generic model. This is the principle that keeps the Solution Layer
from becoming eight products.

## 3. Industry-neutral core

There is no `RetailCamera`, no `HospitalZone`, no `FactoryRule`, no `SchoolBehavior`, and there never
will be. There is a Camera, a Zone, a Rule, a Behavior.

Industry solutions are **configuration, profiles and templates** over the same core. A retail
deployment and a hospital deployment run identical code and differ in their data.

_Consequence:_ an industry noun in a type name is a design review failure, not a naming nit. The
AI-4 behavior profiles are the pattern: one generic engine, many named configurations.

## 4. Multi-tenant by default

Every record carries its `tenantId` and every read goes through the scope guard. A feature that
"only needs to work for one customer" does not exist — the single-tenant path is the multi-tenant
path with one tenant in it.

_Consequence:_ new stores go through `TenantRepository`. A raw driver call on tenant data is a
defect, regardless of what it returns.

## 5. Explainability before automation

Never automate an action the product cannot yet explain. Show the operator what the system concluded
and why, let them act on it, and only then consider acting for them.

_Consequence:_ an automated action ships **after** its explanation, not with it. Explanations are
derived from evidence rather than recorded ([Foundation Principle 2](FOUNDATION_PRINCIPLES.md)), so
they improve retroactively — an automation built before its explanation is one nobody can audit later.

## 6. Evidence before assumptions

The product shows what was measured. Where something is inferred, it says so and names what it was
inferred from. Where nothing was measured, it says **"not measured"** rather than filling the gap
with a plausible default.

_Consequence:_ empty states are honest. "No probe has run yet" is a correct answer; a green tick that
means "we have not looked" is a lie the customer will eventually catch, at the worst moment.

## 7. Simple operational workflows

The common path is the short one. Minimal clicks, good defaults, context-sensitive actions, no
mandatory field a reasonable default could fill.

_Consequence:_ an eight-level hierarchy that **requires** eight levels is unusable for the customer
with one building. Depth is available, not compulsory.

## 8. Progressive disclosure

Show the answer; keep the derivation one click away. Summary → detail → evidence → raw record. Each
layer is complete at its own level and never a teaser for the next.

_Consequence:_ the diagnostic depth built in P-2 is reachable from the surface, not resident on it.
An operator sees a state; an installer opens the probe; a support engineer replays the stages.

## 9. Consistent user experience

Same words, same shapes, same interactions, everywhere. A lifecycle state means one thing in the
camera list, the detail sheet, the timeline and the API. Terminology comes from the contract, not
from whoever wrote the screen.

_Consequence:_ presentation helpers are shared, not re-invented per feature — and the console renders
from the evidence envelope rather than switching on the producer, so consistency is structural rather
than remembered.

## 10. Security by default

Tenant isolation, permission checks, audit trails, least privilege, secure defaults, and never trust
client input. Every customer action stays auditable.

_Consequence:_ a new route is permission-gated at the moment it is written. Deny-by-default means a
route with no declared permission is unreachable, not public.

---

## Never expose the internals

The customer's vocabulary is cameras, sites, incidents and evidence — not services, collections,
ports or probe stages. Where an internal name leaks into a screen it is a bug: `on_default` in a zone
field is the canonical example, and removing it was P-3's first act.

## What a demonstration must be able to show

A prospective customer, in one sitting, should see:

**What** happened · **why** it happened · **how** it was detected · **where** it occurred ·
**who** is responsible · **what evidence** exists · **what actions** are available.

Every milestone from P-3 onward should move at least one of those from "we could build that" to "here,
look". A milestone that improves none of them needs an explicit reason to exist.

## Discipline that does not change

The engineering discipline from G-1 through P-2 carries forward unchanged: contract-first ·
deterministic testing · additive evolution · explainability · replayability · auditability ·
evidence-driven decisions · measure before optimising · no architectural shortcuts · stop after each
milestone for review.

Product urgency is not a reason to spend the foundation. It is the thing the foundation was built to
survive.

## Related

- [FOUNDATION_PRINCIPLES](FOUNDATION_PRINCIPLES.md) — how the platform is built. Frozen.
- [PLATFORM_ROADMAP](PLATFORM_ROADMAP.md) — the four layers and what sits in each.
- [PLATFORM_BOUNDARIES](../architecture/PLATFORM_BOUNDARIES.md) — who owns what, permanently.
- [DEFINITION_OF_DONE](DEFINITION_OF_DONE.md) — the gates every slice passes.

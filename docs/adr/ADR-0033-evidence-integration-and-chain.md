# ADR-0033 — P-5.3 evidence integration, collaboration and the evidence chain: measure the client, and let the chain break honestly

- **Status:** Accepted
- **Date:** 2026-08-03 · **Accepted:** 2026-08-03 (Architect decision, P-5.2 approval + 21 recommendations + 10 mid-milestone requirements)
- **Deciders:** Principal Architect + development
- **Touches:** `@vip/contracts` (`incidents/chain.ts`, `workspace/health.ts`, `workspace/surfaces.ts`, `tenant/branding.ts`, workspace profiles, per-panel versioning, playback alignment, search facets, AI categories, player surfaces, realtime kinds); `services/workflow` (`domain/incident-chain.ts`, `GET /incidents/:id/chain`); `apps/console` (`lib/api/evidence.ts`, `features/workspace/{health,useCollaboration,panels-p53}`, route splitting, `scripts/check-bundle-budget.mjs`). Relates to [ADR-0031], [ADR-0032], CONSTRAINTS §44, §46, §51, §54, §71–74.

## Context

P-5.2 was approved with 21 recommendations; ten further requirements arrived mid-milestone. P-5.3 is
the approved next implementation slice — evidence integration and collaboration — and it folds those
in: most as reserved contracts, the rest as working surfaces.

Five decisions were not mechanical.

## Decision

### 1. ⚠️ The console was one 1.41 MB chunk, and nobody had ever looked

Recommendation 17 said _continue measuring, never assume_. Measuring the production build first —
before changing anything — showed the console shipped as **a single chunk: 1,410 kB, 403 kB gzip**.
Every page, including the rule editor, Recharts and the whole workspace, downloaded before an
operator could see the login form.

Nothing was broken. Nothing had been measured. Route-level `lazy()` boundaries plus vendor chunking
took the entry chunk to **42.9 kB (13.4 kB gzip)** and the workspace route to 34 kB.

⚠️ **The gate is a byte budget, and that needs justifying against §51**, which forbids turning a
recorded number into a threshold. The reason it is allowed here: **bytes are not milliseconds.** A
bundle's size is reproducible from the source and the lockfile on any machine, so a byte regression
is a fact rather than a measurement artefact — unlike a timing threshold, which a loaded CI runner
moves. The budget carries headroom so ordinary feature work does not trip it; it exists to catch a
_category_ change, such as an eager import putting a heavy page back in the entry chunk.

⚠️ The script **fails when `dist/` is absent** rather than skipping. A budget that passes because
nobody built is §44 in a build script.

### 2. A chain that cannot break is not traceability

`camera → detection → rule → incident → evidence → playback → export → report`, derived. The value
is entirely in the breaks: in this build **three of the eight stages have no producer**, and in most
tenants a fourth (evidence) is empty because automatic capture is a no-op pending the media frame
source (TD-15).

So an unresolved stage carries a **required reason** — aged out of retention · archived · never
produced · not built · forbidden · unreachable — and the schema refuses a link without one. Omitting
the three unbuilt stages would let a viewer believe the chain ends at evidence; drawing every gap
identically would let them believe the platform lost something. `complete` is derived from the links,
so the summary flag cannot disagree with the diagram.

⚠️ **One upstream call, not eight.** Four stages come from the incident document — it carries the
camera, the triggering event and the rule as **provenance copied at promotion time**, which is the
right answer for a chain explaining why the incident exists. Resolving the camera's _current_ name
would answer a different question and cost two more calls on a panel that already rides the
timeline's budget (§54).

### 3. Health is projected from reads already made — never a probe fan-out

The obvious workspace-health implementation probes seven services on every load. That is seven
upstream calls added to the busiest screen in the product, to answer a question the screen already
answered: the timeline came back with typed gaps, the panels came back with data or errors, and the
registry records which capabilities have no producer.

So the health panel fetches **nothing** (`enabled: false` — it reads the timeline's cache) and
reports three distinct kinds of "not working":

| State                                    | What fixes it                          |
| ---------------------------------------- | -------------------------------------- |
| `not-built`                              | a release                              |
| `not-configured`                         | a config change                        |
| `unreachable` / `degraded` / `forbidden` | an engineer, capacity, or a role grant |

⚠️ Plus **`unknown` for anything nothing exercised**, never rendered as healthy: an unexercised
dependency and a working one are indistinguishable from here, and only one of them is a claim the
platform can make.

### 4. A 409 is reported to the person, never retried

P-5.0 widened the version guard to cover notes precisely so two operators commenting at the same
instant get a conflict instead of one losing their words. That only pays off if the client says so.
An automatic retry re-applies a write against a state that has since moved — a resolution note
landing on an incident somebody else just escalated.

So a conflict refetches, keeps the operator's text, and explains. The composer clears **only on
success**. A closed incident offers no controls at all, because it is sealed (§57) and a disabled
button promises an operation the server refuses.

### 5. ⚠️ Three requests were answered differently than asked, each for a stated reason

- **"Saved layouts should carry layoutVersion, panelVersion and migrationVersion."** Two of those
  answer distinct questions and a third answers none. `schemaVersion` asks _can this be parsed_
  (mismatch discards everything); `layoutVersion` asks _which panels existed_ (mismatch discards
  nothing, because per-panel state defaults independently); `panelVersion` — added, and **per
  panel** — asks _is this one panel's state still meaningful_. A migration counter would have to
  mean one of those three, and then two numbers would have to agree forever. The requirement
  ("panel evolution must never invalidate saved layouts") is met by the per-panel version, not by a
  global one: P-5.3 added two panels (layout v2) and every saved layout still applies.
- **"AI must never mutate without explicit human approval."** The platform goes further: an AI
  cannot mutate **with** approval either. An approval flow requires an AI-authored mutation to
  exist, and it would then enter an immutable audit trail attributed to a machine. Acting on a
  recommendation is an ordinary operator action, recorded against the human who decided.
- **"Reserve a WebSocket-ready architecture."** SSE already exists, multiplexed, with cursor replay
  (P2-2 G-5), and everything reserved here is server→client. A second transport means two connection
  lifecycles, two backpressure policies and two auth paths. The **vocabulary** is reserved on the
  transport that exists; a genuine client→server need is a transport decision with its own ADR.

## Consequences

**Good.** The workspace reads real evidence and can be worked in, not just read. Provenance is one
object a customer can be shown. The client is measured and gated. Health explains itself.

**Costs.** Route splitting adds a request per first visit to a route — mitigated by a shape-matched
skeleton, and paid back many times over on first load. The chain adds one bounded evidence read per
open. `panels-p53.tsx` splits the panel bodies across two files; the registry stays in one.

**Deliberately not done.** No playback session resolver, no evidence player, no annotations, no
report generator, no job worker, no search federator, no audit writer, no dashboard, no notification
centre, no demo mode, no branding application, no profiles UI. All are contract-frozen and all
appear on the screen as `not-built` with a stated reason, which is the point.

## Alternatives considered

- **A `manualChunks` split without route splitting** — rejected: it moves bytes between chunks and
  still downloads all of them.
- **A gzip-size budget** — rejected: compression ratios vary with the compressor version, which
  reintroduces exactly the machine-dependence §51 warns about. Raw bytes are the reproducible number.
- **Probing dependencies for health** — rejected on the fan-out (decision 3).
- **Resolving camera and rule names for the chain** — rejected: it answers "what is it called now",
  not "what fired this", and costs two calls (decision 2).
- **Retrying a 409 automatically** — rejected: it silently re-applies a write against a moved state
  (decision 4).
- **A third `migrationVersion`** — rejected: no distinct question (decision 5).

# Known Limitations

> **Everything a customer can see, be surprised by, or be let down by.** Written to be read **with** a
> customer, not sent to them.

**Customer-visible only.** Internal engineering debt lives in
[tracking/TECH-DEBT.md](../../tracking/TECH-DEBT.md) and does not belong here — a `TD-nn` reference
appears below only to point an engineer at the fix, never because the debt itself is the limitation.

**Last verified: 2026-08-04** against the running production deployment.

⚠️ **An unrecorded limitation is a defect.** A limitation a customer discovers for themselves is a
defect that has already cost something. Add rows here freely; the cost of an extra row is nil and the
cost of a missing one is a relationship.

---

## L-1 · No camera has ever been connected

**The most important sentence in this document, and it has not changed.**

|                       |                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Camera onboarding, ONVIF discovery, stream probing and health checks are implemented and exercised — **against synthetic sources only**. No Hikvision, Dahua, CP Plus, UNV or Axis device, and no NVR of any make, has ever been connected to this platform |
| **Customer impact**   | Every statement about vendor compatibility is a prediction. Their estate may work perfectly on the first attempt, or expose firmware behaviour nobody has seen. **The pilot is the validation**                                                             |
| **Planned**           | **P-9** · one camera per vendor family in H.264 and H.265, plus a four-channel NVR. ~2 engineer-weeks once hardware is present                                                                                                                              |

> Do not sell on camera compatibility. Sell on the investigation workflow, and let the pilot answer
> the compatibility question honestly.

## L-2 · The platform does not detect behaviour yet

|                       |                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | The perception runtime detects **person · vehicle · fire · smoke**. It does **not** detect theft, loitering, intrusion, falls, fights or PPE violations. Those event types exist and rules match them, but nothing produces them from video |
| **Customer impact**   | The phrase "suspicious activity" describes the roadmap, not the product. In a demonstration these events come from the demo dataset — see [CUSTOMER_JOURNEYS](CUSTOMER_JOURNEYS.md)                                                         |
| **Planned**           | **P-8** · loitering, intrusion and crowding first — all three are geometric and time-windowed, so they can be proved from track data. Theft is inferential and will produce false positives on real footage                                 |

## L-3 · No live view

|                       |                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current behaviour** | `/live` is not a working page. **No browser plays RTSP natively**, and the server-side repackager (WebRTC or LL-HLS) does not exist. The platform investigates **recorded** evidence |
| **Customer impact**   | Immediate and highly visible — it is one click from the login screen of a CCTV product. **State this in the first meeting**, not the first demo                                      |
| **Planned**           | **P-8** · needs a transport decision (ADR) as well as implementation                                                                                                                 |

## L-4 · Notifications are in-app and webhook only

|                       |                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | An incident notifies inside the console and can POST to a webhook. **No email, no SMS, no Slack, no Teams, no push**                          |
| **Customer impact**   | An operator who is not looking at the screen learns nothing. For an out-of-hours site this is the difference between a system and a recording |
| **Planned**           | **P-7** · email, SMS, Slack and Teams, plus notification policies and escalation                                                              |

## ~~L-5 · A user account cannot be disabled~~ — **CLOSED 2026-08-04 (P-6.2)**

|                       |                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Users could be **created** and **listed** and nothing else — no role change, no password reset, **no deactivation**                                                                                                 |
| **Customer impact**   | ⛔ **An offboarded employee kept their access.** A customer's own security policy requires this before they sign                                                                                                    |
| **Resolved**          | **P-6.2.** A user can be created, re-roled, disabled, re-enabled and given a new password from the console. Disabling **ends every open session immediately** and reports how many. Verified against the deployment |

> ⚠️ **This was the last pilot blocker.** With L-5 and L-6 closed, no limitation in this register
> blocks a first customer pilot. See L-21, L-22 and L-23 for what user administration deliberately
> does **not** do.

## ~~L-6 · A rule cannot be edited~~ — **CLOSED 2026-08-04 (P-6)**

|                       |                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Rules can be created, versioned, dry-run and rolled back — but the edit form fails validation on submit, so changes never save. Workaround: author a replacement rule and retire the original |
| **Customer impact**   | ⛔ Acceptable for a demonstration; unacceptable for a customer who will tune thresholds weekly, which every customer does in the first fortnight                                              |
| **Resolved**          | **P-6.** Rules can be created, edited, versioned and rolled back in the console. Verified against the deployment: PATCH 200, version 1→2, lifecycle and severity preserved                    |

## L-7 · No reports, and no evidence export bundle

|                       |                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Evidence can be **downloaded individually**, with its integrity hash and custody record intact. There is no report generator and **no signed, watermarked bundle** to hand to a third party |
| **Customer impact**   | "Send this to the police / the insurer / HR" is a manual assembly job today. The evidence is defensible; the packaging is not built                                                         |
| **Planned**           | **P-11** · background jobs → report generation → signed export bundles                                                                                                                      |

## L-8 · No search across the platform

|                       |                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | The incident queue filters by status and severity; the estate browses by hierarchy; events filter by type and camera. There is **no unified search**, and the search box in the top bar does not work |
| **Customer impact**   | Manageable at 50 cameras. At 500 it is the difference between finding an incident in seconds and not finding it                                                                                       |
| **Planned**           | ⚠️ The **non-working search box** is fixed in **P-6** — it will search or it will be visibly disabled, never both. Federated search is **P-12**                                                       |

## L-9 · No saved investigations

|                       |                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | The workspace layout and open incident are per-session. Signing out clears them — deliberately, so a shared terminal does not leak an investigation to the next shift |
| **Customer impact**   | An investigator working one case across several shifts rebuilds their context each time                                                                               |
| **Planned**           | **P-12**                                                                                                                                                              |

## L-10 · No AI recommendations

|                       |                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | The AI panel says: _"No AI advisor is configured. This is not 'no recommendations' — nothing has analysed this incident."_                                        |
| **Customer impact**   | None, if read correctly — and the wording exists precisely so it is read correctly. ⚠️ **Absence of a recommendation is not a judgement that everything is fine** |
| **Planned**           | Post-GA. AI remains **advisory** and may never mutate an incident, approve an investigation or generate evidence                                                  |

## L-11 · No dashboards beyond the operational overview

|                       |                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | The dashboard shows current counts — active incidents, cameras online, recent alerts. **No trends, no deltas, no history, no scheduled reporting** |
| **Customer impact**   | It answers _"what is happening now?"_ and cannot answer _"is this getting worse?"_ — which is the question a security manager reports upward       |
| **Planned**           | **P-13**                                                                                                                                           |

## L-12 · One brand per installation

|                       |                                                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Logo, product name, favicon, colour and support footer are configured at runtime, with no rebuild. But branding is read **before sign-in**, which is what makes the login screen brandable — so it is per **deployment**, not per tenant |
| **Customer impact**   | A reseller or MSP serving several brands needs one installation per brand                                                                                                                                                                |
| **Planned**           | **P-14** · depends on deciding how a tenant is identified at sign-in                                                                                                                                                                     |

## L-13 · The tenant must be typed at sign-in

|                       |                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | An operator types their tenant identifier, then email and password. The sign-in screen cannot look the tenant up |
| **Customer impact**   | Small, constant friction on the **first screen every operator sees, every day**                                  |
| **Planned**           | **P-6**                                                                                                          |

## L-14 · Dark theme only

|                       |                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | One theme, designed for a control room. No light mode exists                                                           |
| **Customer impact**   | None in a security office. Real for a brightly lit reception or a customer with a light-mode accessibility requirement |
| **Planned**           | **Deliberately not planned.** Revisited on a customer requirement, not before                                          |

## L-15 · Phone layout is broken

|                       |                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Desktop and tablet are correct at every width from 1024 px up. Below ~768 px the navigation does not collapse, and **the user menu — including Sign out — is pushed off-screen** |
| **Customer impact**   | The console is not usable on a phone. Tablet and desktop are unaffected                                                                                                          |
| **Planned**           | **P-6**                                                                                                                                                                          |

## L-16 · H.265 in some browsers

|                       |                                                                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Chrome, Edge and Safari play H.265. **Open-source Chromium and Firefox refuse it** — a browser licensing decision, not a platform fault. The console detects this, says so plainly, and offers the original file for download |
| **Customer impact**   | An operator on Firefox with an H.265 estate cannot play in-browser. ⚠️ H.265 has been **probed but never actually decoded** — no HEVC encoder was available for testing                                                       |
| **Planned**           | Decode verified at **P-9** with real hardware                                                                                                                                                                                 |

## L-17 · Single host, no failover

|                       |                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | One host runs everything. Restarting a service is a brief outage for that service; the console recovers without a page refresh, and this has been verified for every dependency under a live investigation |
| **Customer impact**   | Correct for a pilot and a single site. Not a high-availability deployment                                                                                                                                  |
| **Planned**           | Post-GA                                                                                                                                                                                                    |

## L-18 · Recovery point equals the backup interval

|                       |                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current behaviour** | Backup and **restore are proven** — volumes destroyed, stack rebuilt, evidence bytes and custody chain intact. But backups are per-collection consistent, **not point-in-time across collections**, and there is no continuous replication |
| **Customer impact**   | Nightly backups mean up to 24 hours of loss in a disaster. A backup taken mid-write can hold an incident without its notification                                                                                                          |
| **Planned**           | **P-14** · ⚠️ meanwhile, **agree the backup interval explicitly with the customer** and write it down                                                                                                                                      |

## L-19 · No rate limiting at the edge

|                       |                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Every request is authenticated and authorised, but not throttled                                                                                         |
| **Customer impact**   | Brute-force protection on sign-in needs a limiter in front of the deployment. Their existing WAF or reverse proxy will usually already do this — **ask** |
| **Planned**           | **P-14**                                                                                                                                                 |

## L-20 · Sizing above ~100 cameras is arithmetic

|                       |                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current behaviour** | Capacity was **measured** through the real pipeline — 3,000 detections → 3,000 events → 27 incidents, ≥600 events/s, 1,309 bytes per event, reads p50 9 ms. The 500-camera sizing extrapolates from those per-unit costs |
| **Customer impact**   | The 10- and 50-camera figures are measured. The 500-camera figure is an estimate and is labelled as one                                                                                                                  |
| **Planned**           | Measured at the scale a real customer brings                                                                                                                                                                             |

## L-21 · A user's email address cannot be changed

|                       |                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | The address is the login identity and is fixed at creation. A role can be changed, a password reset, the account disabled — the address cannot                                                                                                                                                                                                          |
| **Customer impact**   | Someone who changes their name or their employer's domain needs a **new account**, with the old one disabled. ⚠️ Deliberate: editing the address silently changes who can sign in to an account that already owns incidents, assignments and audit lines — a takeover that reads as a typo fix. Two accounts leave a trail; one edited account does not |
| **Planned**           | Not planned. It would be reconsidered only alongside an identity-provider integration (SSO/OIDC, post-GA), where the provider owns the address                                                                                                                                                                                                          |

## L-22 · There is no self-service password change

|                       |                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | An administrator can set anyone's password. A user cannot change their own, and there is no "forgot password" email                                                          |
| **Customer impact**   | Every password change goes through an administrator, who must communicate the new one over a channel the user already trusts. Workable for a pilot; a helpdesk cost at scale |
| **Planned**           | **P-7**, with the notification channels — a reset link needs email delivery (L-4) before it can exist, so it is genuinely blocked rather than deferred                       |

## L-23 · Disabling an account leaves an access token valid for up to 15 minutes

|                       |                                                                                                                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Disabling a user **revokes every refresh token immediately** — they cannot obtain a new access token and cannot sign in. An access token already issued stays valid until it expires: `JWT_ACCESS_TTL`, **15 minutes** in the shipped configuration |
| **Customer impact**   | A dismissed employee with the console already open keeps read access for up to 15 minutes. Measured, not estimated. Shorten `JWT_ACCESS_TTL` to trade this against token-refresh traffic                                                            |
| **Planned**           | Not planned as architecture. Closing it entirely means a revocation lookup on **every** request at the gateway; that is a real cost to pay against a real requirement, and no customer has stated one. Raise it in the pilot security review        |

## L-24 · Suspending a tenant does not lock anyone out

|                       |                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | A tenant carries a lifecycle status (`provisioning · active · suspended · deprovisioning`) and it is stored faithfully. ⚠️ **No code path reads it.** Nothing in identity, the gateway or the tenancy guard refuses a request because a tenant is suspended |
| **Customer impact**   | None today, because the console shows the status **read-only** and does not offer a Suspend control — a button that claimed to lock everybody out and did nothing would be far worse than its absence. A reseller managing several tenants will want it     |
| **Planned**           | **P-14**, with licensing and entitlements, where refusing a tenant at the boundary already has to exist                                                                                                                                                     |

## L-25 · Settings changes are audited to the log, not to a queryable trail

|                       |                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Every tenant settings change emits `tenant.updated` with **before/after, the actor, the correlation id and the timestamp** — verified in the deployment's logs. It goes to the service log, not to a store anyone can query from the console                |
| **Customer impact**   | "Who renamed the organisation last March?" is answerable from log retention, not from the product. An auditor asking for it in writing will not accept a `docker logs` pipe. ⚠️ Before P-6.3 a rename emitted **nothing at all**, so this is a floor rising |
| **Planned**           | **P-13** · the access-audit surface. `AccessAuditEntry` is already frozen in the contracts with no consumer; the event is emitted in the shape that consumer will want                                                                                      |

## L-26 · Branding is per-deployment, not per-tenant

|                       |                                                                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Branding is runtime configuration — edit `branding.json`, reload, done; **no rebuild and no redeploy**, verified by overwriting it inside the running container. It applies to the **whole deployment**: every tenant sees the same brand |
| **Customer impact**   | A reseller hosting several customers in one deployment cannot brand them separately. ⚠️ The Settings screen states this on the page rather than leaving it to be discovered after a colour is set "for one customer"                      |
| **Planned**           | Depends on **D-1** — branding is loaded before sign-in so the login screen can carry it, which means the tenant is not yet known. Per-tenant branding is impossible until a tenant is identifiable pre-authentication                     |

## L-27 · An API client that skips the version token can log a stale "before" value

|                       |                                                                                                                                                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | A tenant update reads the document, then writes it conditionally. The write is exactly-once — concurrent identical submissions produce **one** audit record, proven against real MongoDB — but the `from` value in that record is the one the winner _read_, not the one stored when it wrote        |
| **Customer impact**   | None through the console, which always sends `expectedUpdatedAt`; a racing caller is refused with 409 before it can write. Reachable only by an API client that omits the token **and** races another writer. The `to` value and the actor are always correct; only `from` can be one revision stale |
| **Planned**           | Closed by returning the pre-image from the write itself (`findOneAndUpdate`). Deferred because it means adding a method to the frozen `@vip/tenancy` repository that nothing else in the platform needs — a foundation change to improve one field of one log line                                   |

## L-28 · System Health is a live reading, not a history

|                       |                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current behaviour** | `/system` reports what every service says about itself **right now**, refreshed every 15 seconds while the page is open. Nothing is stored: no trend, no uptime figure, no record that a service was unavailable at 03:10 if nobody was looking. ⚠️ It also **samples** — a component that fails and recovers inside the 15-second window is never seen, and a three-second container restart is invisible by arithmetic (measured, P-6.4) |
| **Customer impact**   | "Was it down last night?" is not answerable from the product. It is answerable from the container logs and from whatever the customer's own monitoring recorded — ⚠️ which is why the deployment exposes `/health` and `/ready` for an uptime monitor to poll, and why they kept the path                                                                                                                                                  |
| **Planned**           | **P-13**, with dashboards and the metrics history they need. ⚠️ Alerting on platform health belongs to the customer's monitoring, not to a page an operator has to be watching                                                                                                                                                                                                                                                             |

## L-29 · A hung dependency makes a service look unreachable, not degraded

|                       |                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current behaviour** | Readiness is asked with a 2-second budget. A service whose database has **stopped answering** (rather than refused) blocks inside its own check and times out, so it is reported `Unavailable` — the same word as a stopped container. Measured by pausing MongoDB |
| **Customer impact**   | An operator sees ten unavailable services rather than "one dependency is hung". ⚠️ Mitigated on the page: the dependency keeps its own row and reads `Unknown — nothing can speak for it`, which is the signal that the services share a cause                     |
| **Planned**           | Closed by a readiness check that fails fast rather than blocking. That is a change in every service's Mongo probe, not in the health page                                                                                                                          |

## L-30 · The inbox has no per-operator read state

|                       |                                                                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | The only state an alert carries is **acknowledged**, by one named operator, for the whole tenant. There is no personal read/unread: an operator who looked at an incident and did not take it leaves the entry emphasised for everybody               |
| **Customer impact**   | Correct for a shared control-room queue and wrong for an organisation where several people each want their own list. ⚠️ Worth saying out loud in a demonstration, because the word "inbox" sets an expectation of per-person state that email created |
| **Planned**           | Not scheduled. It becomes a real requirement only alongside notification policies (**P-7**), where "who was told" starts differing per person                                                                                                         |

## L-31 · There is no "acknowledge all", and no snooze

|                       |                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current behaviour** | Acknowledging acts on **one incident** — every channel it reached, at once. There is no bulk clear, no snooze, and no assignment from the inbox                                                                                                  |
| **Customer impact**   | An operator returning to fifty alerts after a busy night acknowledges fifty times. ⚠️ **Deliberate**: clearing a queue of alerts nobody read is the fastest way to make a queue worthless, and the control that offers it is the one used at 6am |
| **Planned**           | Revisited with escalation in **P-7**, where "nobody answered" needs a defined outcome. Any bulk control must make the number being cleared unmissable                                                                                            |

## L-32 · A failed delivery is never retried, and nothing re-sends it

|                       |                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Each channel is attempted **once**. Measured on the deployment across four real transports: `attempts` is 1 on every delivery, successful or failed. A webhook that is down for thirty seconds loses those alerts permanently — the incident is redelivered on the backbone, but the fan-out skips any channel that already has a record, so nothing tries again. There is no re-send control in the console either |
| **Customer impact**   | ⚠️ **Say this out loud before a customer wires their SOC to a webhook.** The failure is visible in the Inbox with its reason, and visibility is the whole of what the platform offers here — an operator has to notice and act. A flapping endpoint means permanently missing alerts on the customer's side, while the in-app inbox still shows everything                                                          |
| **Planned**           | Retry with backoff is **TD-53**, ranked high. It needs the idempotency guard to tell "already delivered" from "already attempted", which is why it is a change to the engine rather than a loop around `send`                                                                                                                                                                                                       |

## L-33 · A delivery interrupted mid-flight stays `pending` for ever

|                       |                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | A delivery record is inserted as `pending` and moves to `sent` one database round trip later. P-6.5 produced that state deliberately — freezing the engine mid-fan-out and reading the log straight from MongoDB — and confirmed it advances as soon as the process runs again. ⚠️ But if the process **dies** in that window, the redelivered incident finds a record already there and skips the channel, so the row never moves again |
| **Customer impact**   | Rare and small: it needs a crash inside a window of about one millisecond per delivery. The consequence is one alert that reached nobody, sitting in the queue as `Pending`, indistinguishable to an operator from one that is simply in flight                                                                                                                                                                                          |
| **Planned**           | Falls out of **TD-53**: a retry that reasons about outcome rather than existence would pick these up. ⚠️ The permanence is _inferred_ from two measured facts — the state exists between two writes, and a redelivered incident never re-attempts — not observed directly, and this entry says so rather than overclaiming                                                                                                               |

## L-34 · The Inbox shows the most recent 500 deliveries, and then stops

|                       |                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | "Load more" stops after ten pages and says so on screen. Older alerts are reachable by narrowing the triage filter or by opening the incident, but not by paging further                                                                                                                                                                                                    |
| **Customer impact**   | Low for a queue, which is worked from the top. ⚠️ **Deliberate, and measured**: the screen polls every page it has loaded, so the background cost grew with each click — 29 KB per tick at one page, 610 KB at twenty, roughly 800 MB per operator per shift. A bounded queue with an honest message beats an unbounded one that quietly costs a customer bandwidth all day |
| **Planned**           | **TD-54** — poll only the first page, and the cap can be lifted. Low priority: a five-hundred-deep inbox is a reporting question, not a triage one                                                                                                                                                                                                                          |

## L-35 · A notification does not name the service that produced it

|                       |                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current behaviour** | Every delivery record carries a correlation id, the tenant, the causing incident, its channel, its timestamps, and — once acknowledged — the person who took it. It does **not** carry a `sourceService` field; the producer is implicit in the subject it was published on (`t.{tenant}.notification.{kind}`), and notify is the only publisher                   |
| **Customer impact**   | None for tracing an incident, which follows the correlation id end to end. It matters only to someone consuming the delivery log outside the platform and wanting provenance without knowing the subject convention. ⚠️ Recorded rather than fixed: adding a field to a frozen contract that exactly one writer would ever set is a checklist answer, not a design |
| **Planned**           | Not scheduled. Revisit if an external consumer of the notification stream ever needs it                                                                                                                                                                                                                                                                            |

## L-36 · Acknowledging takes a delivery, not the incident

|                       |                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current behaviour** | An acknowledgement applies to one **delivery**, and the console's Acknowledge button applies it to every delivery on the incident at once. Each delivery is exclusive — measured, 13 rounds, one winner every time — but an incident that reached two channels can be **split** between two operators pressing together, one taking each. Both acknowledgements are genuine and the record names both people |
| **Customer impact**   | ⚠️ Two people can be attending one incident. The console now tells each of them so — _"Alert acknowledged — {other} is on this incident too"_ — which is what a freeze can honestly deliver; what it does not do is stop the second person, because nothing in the platform claims an **incident** for one operator                                                                                          |
| **Planned**           | **P-7.** Exclusivity at the incident is a claim on the incident, not a message: it needs an owner field, a conditional write, and a decision about whether an unclaimed incident may be worked at all. That is a design change, deliberately not made inside a freeze                                                                                                                                        |

## L-37 · AI processing cannot be assigned to a camera, and no camera is analysed

|                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | ⚠️ **Updated 2026-08-05 (P-8 Phase 3): every analysed camera is analysed, and there is no way to choose which.** Real inference now runs in the deployed runtime — YOLOX-nano over ONNX Runtime, measured at 2 people found in a photograph of two people and **zero** in a test pattern. What does not exist is _selection_: no per-camera AI assignment, no profile, no priority, no schedule, no cost estimate. Analysis is a property of the deployment, not of a camera |
| **Customer impact**   | ⚠️ **Say this before anyone assumes selective AI is a configuration exercise.** A customer who expects to enable analysis on 20 of 500 cameras is describing a milestone, not a screen. Today every recording camera's frames are offered to the runtime, and the runtime drops what it cannot keep up with — a capacity limit, not a customer choice. The camera page states it per camera rather than leaving the absence to be discovered                                 |
| **Planned**           | **P-8 Phase 4** — `CameraProcessingIntent` plus an enforcement point in the frame path. ⚠️ Building the UI first would be a control that configures nothing. Designed in 🔒 [SELECTIVE_AI_PROCESSING](../architecture/future/SELECTIVE_AI_PROCESSING.md). The AI Runtime page added in Phase 3 **reports** and configures nothing, deliberately                                                                                                                              |

## L-38 · A camera's recording state is held in memory and is not configuration

|                       |                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current behaviour** | Recording is started and stopped per camera through the media service, and the camera page shows and controls it. ⚠️ That state lives in the media service's **memory** (TD-4): restarting it stops every worker, and nothing in the camera record remembers the camera was ever recording |
| **Customer impact**   | After a media restart, cameras an operator started are silently no longer recording. The page says so where the control is, rather than presenting the reading as durable configuration                                                                                                    |
| **Planned**           | Persisting stream intent is part of the media work in **P-8**; until then the honest treatment is the disclosure                                                                                                                                                                           |

## L-39 · Health and "not retired" filter the rows loaded, not the estate

|                       |                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Search, location and an exact lifecycle state are `CameraQuery` fields and narrow the result on the **server**. Two controls are not: filtering by health, and the "active (not retired)" convenience, which is the complement of a state the query can only express positively. Both refine what is loaded, and the page says so on screen |
| **Customer impact**   | On an estate larger than the loaded pages, "3 offline" means three offline **among the rows loaded**. The count line states this whenever a refinement is active                                                                                                                                                                            |
| **Planned**           | Two additive `CameraQuery` fields (`health`, `lifecycleNot`) would move both to the server. That is a change to a **frozen foundation's** contract and needs an implementation issue and an ADR — deliberately not made inside a UI milestone                                                                                               |

## L-40 · Camera names resolve from the first 200 cameras

|                       |                                                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Screens that store a `cameraId` — the incident queue, events, the dashboard — resolve it to a name from a bounded page of camera names. Beyond that page an unresolved id renders **as the id**           |
| **Customer impact**   | On an estate over 200 cameras, an incident on camera 900 can show `cam_…` where a name belongs. Visible, not wrong                                                                                        |
| **Planned**           | A batch resolve (`GET /cameras?ids=…`) is the fix and is additive to the camera API. ⚠️ Loading the whole estate to build a name map is what P-6.6 removed, and would be a worse answer than an honest id |

## L-41 · One host analyses two cameras repeatably, not sixteen

|                       |                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current behaviour** | Measured on a 10-core CPU-only host: **2 cameras** at 2 fps each are analysed inside a 2 % frame-loss budget, at **0.0 % across three runs of the same commit**. ⚠️ **4 cameras is provisional and must not be quoted**: the same commit measured 0.4 %, 4.4 % and 4.7 % there, so the rung straddles the budget line. At 8 cameras 8.0–14.2 % is dropped, at 16 cameras 18.9–24.4 % — see [AI_RUNTIME_BENCHMARK](AI_RUNTIME_BENCHMARK.md) |
| **Customer impact**   | ⚠️ **The video tier and the AI tier have different capacities and only one of them is advertised.** Recording carried 16 cameras with zero loss; perception sustains 2. Beyond that, analysis **samples** the stream rather than covering it — detections stay correct (exactly 2.00 per frame at every rung) but some frames are never examined                                                                                           |
| **Planned**           | GPU execution is the real answer and is why the provider is a registry field rather than a constant. Before that, `cpus:` on the perception tier ([TD-63](../../tracking/TECH-DEBT.md)) so inference cannot starve the decode path that writes evidence. ⚠️ Any per-host camera number quoted to a customer must state the fps and the hardware                                                                                            |

## L-42 · Tracking links a returning person by geometry, not by appearance

|                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | When someone leaves a camera's view and returns, the platform issues a **new track id** and links it to the previous one (`identityId`). The link is decided on **position, size, elapsed time and object class** — where they vanished, where one reappeared, and whether they could plausibly have walked there. There is no re-identification model: no appearance embedding, no clothing colour, no gait, no face                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Customer impact**   | ⚠️ **Two similarly-sized people passing through the same doorway within about twelve seconds are indistinguishable to this logic, and it can link the wrong one.** The console states this on the track itself — "a strong hint, not proof that this is the same person" — and the two track ids are always shown separately so the join can be questioned. An investigator must not treat a linked identity as established fact                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Also**              | ⚠️ **Identity fragments as a host saturates, and the MAGNITUDE is provisional.** One walking person per camera returned exactly one identity up to 4 cameras in both runs. Above that, two runs of the same commit disagree by a factor of five: 11 vs **9** identities for 8 cameras, and 21 vs **17** for 16 — a 31 % overhead in the first run and 6 % in the second. The mechanism is not in doubt (fewer analysed frames per camera means a bigger gap between observations, and past the engine's tolerance a new identity is the correct answer); the size of it is, and by enough that no customer-facing figure is published until three runs agree. ⚠️ Fragmentation, **not** swapping — different failures, and only the second is dangerous. Both runs measured **0 identity switches** against the authored crossing clip |
| **Planned**           | Re-identification is a capability of its own, not a tuning change. It needs an appearance model, a per-tenant embedding store and a validation set — and validating it needs real footage, so it follows **P-9**. Until then the gate is deliberately tight: a link is refused across a long gap, a long distance, an implausible size change, or a different class                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## L-43 · An identity does not follow a person between cameras

|                       |                                                                                                                                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | A track id is scoped to **one tenant, one camera, one runtime session**. Walking from the car park camera to the entrance camera produces two unrelated identities, and the platform makes no claim that they are the same person                                                                        |
| **Customer impact**   | "Follow this person through the site" is not a thing the product does. A multi-camera journey is reconstructed by an operator reading tracks per camera, which is what they do today with footage — tracking makes each leg easier, not the join                                                         |
| **Planned**           | Cross-camera association depends on the same re-identification work as [L-42](#l-42--tracking-links-a-returning-person-by-geometry-not-by-appearance), plus a site topology the platform does not yet model. ⚠️ Not on the roadmap before a pilot has said whether it is what customers actually ask for |

## L-44 · Speeds and distances are fractions of the frame, not metres

|                       |                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Track speed is reported in **frame widths per second** and travelled distance in **frame widths**. Direction is image-space (which way across the picture), not a compass bearing                                                                                                                                                                                                                           |
| **Customer impact**   | ⚠️ **Two people walking at identical real speeds report very different numbers** if one is near the lens and the other far from it. The figures compare a subject against itself over time — "faster than they were" — and must not be read as physical measurements. Every reading on the console carries its unit for this reason                                                                         |
| **Planned**           | Metres per second requires camera calibration: lens intrinsics, mounting height, tilt and a ground-plane homography, per camera. That is a real feature with a real onboarding cost, and it is not worth building until a customer asks for a speed threshold. ⚠️ The platform will not infer it from an assumed camera height — a plausible number from an invented parameter is worse than an honest unit |

## L-45 · There is no live accuracy number for tracking, and one metric is not measured at all

|                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Identity switches, re-identification success and false recoveries are reported as **not measurable** by any live runtime, because each asks whether an identity was _correct_ — a question defined against which real object each track belonged to, which no camera carries. They are measured against **authored** scenarios, and `/tracking` reports `null` rather than `0` ([ADR-0039](../adr/ADR-0039-absent-metrics-are-unavailable-never-zero.md))                                     |
| **Customer impact**   | ⚠️ **"How accurate is your tracking?" has no live answer, and there is no tracking health score or accuracy SLA.** What exists is six measurements against clips whose trajectories were written down first — they certify the tracking **logic**, never the platform against real footage ([L-1](#l-1--no-real-camera-has-ever-been-connected)). A blended accuracy figure would hide which parts were measured and will not be published                                                    |
| **Also**              | ⚠️ **`falseRecoveries` is not measured even against ground truth.** A false link needs a _departed_ identity to link back to; both subjects appear at the start of the crossing clip and neither is retired inside the window, so no gate width can produce a link and the check cannot fail. This was found by a mutation that opened the re-entry gate to ten thousand seconds and left the run **green** — the check was reported as `null` rather than kept as a green that means nothing |
| **Planned**           | A fixture presenting a genuine stranger after a departure, plus a labelled real-footage set for the rest. ⚠️ Neither is free: under [L-42](#l-42--tracking-links-a-returning-person-by-geometry-not-by-appearance) an appearance-blind engine _should_ link a similar person arriving near the exit point inside the window, so a naive clip would assert against documented correct behaviour. Follows **P-9**, when real footage exists                                                     |

## L-46 · Event delivery is at-least-once, and duplicate suppression is a window

|                       |                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | The same detection reaching the platform twice produces **one** event — but only inside two bounded windows. JetStream collapses a repeated message id for **2 minutes**; the events service collapses a repeated dedup key inside a **10-second** bucket. Measured on the deployment: six deliveries of one result → one event inside the window, **two** across it        |
| **Customer impact**   | ⚠️ **"Exactly once" is not a guarantee this platform makes, and an integration built on that assumption will double-count.** A connector, a report or a customer's own consumer must be **idempotent** — key on the event id, not on arrival. In normal operation duplicates are rare; they appear during a broker reconnection or a deliberate replay                      |
| **Also**              | ⚠️ **The same windows are what make replay safe.** Replaying a range twice inside the JetStream window re-publishes nothing downstream — measured: 0 re-evaluations, 0 additional incidents. After the window, the same replay does re-evaluate                                                                                                                             |
| **Planned**           | Nothing. Exactly-once across a broker boundary requires transactional delivery the backbone does not offer, and claiming it would be worse than documenting the window. The windows are configurable per deployment, so ⚠️ **a deployment that widens them changes what is promised here** ([ADR-0042](../adr/ADR-0042-at-least-once-delivery-with-bounded-suppression.md)) |

## L-47 · Events are dropped under pressure, deliberately, and recording is not

|                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | The Event Publisher holds a bounded queue **per camera** (16 by default) and retries a bounded number of times. When the broker is unreachable or the queue is full, the **oldest events are discarded and counted**. Measured during a 20-second broker outage: 16 dropped, 4 lost after exhausting retries — and **segments kept being written throughout**                                                                                                       |
| **Customer impact**   | ⚠️ **A broker outage costs events, and the events lost during it are gone.** Nothing replays them, because they were never persisted. What is never lost is the recording — the bridge refuses to apply back-pressure to the process writing evidence. An incident that would have been raised during the outage is not raised late; it is not raised at all                                                                                                        |
| **Also**              | The console reports `dropped`, `out of order`, `rejected` and `suppressed` as **four separate figures**, because only one of them is a fault. Combining them would make a healthy busy site look identical to a broken one                                                                                                                                                                                                                                          |
| **Planned**           | A disk-backed spill queue would trade the loss for bounded disk, and is not built. ⚠️ It is a real feature, not a setting: it needs its own retention, its own replay ordering and its own failure mode. Deferred until a customer says lost events during an outage matter more than the simplicity ([ADR-0042](../adr/ADR-0042-at-least-once-delivery-with-bounded-suppression.md), which also records why blocking the frame path instead was rejected outright) |

## L-48 · An incident names one frame, not every frame that contributed

|                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Identical incident candidates collapse on `tenant + rule + group + time-bucket` (60 seconds by default), so a burst of matching frames raises **one** incident. That incident carries the correlation id and event id of the **first** frame in its bucket                                                                                                                                                                                                        |
| **Customer impact**   | ⚠️ **An operator asking "which frame triggered this?" gets the first one, not necessarily the one they are looking at.** The collapse is correct — the alternative is one incident per frame — but the incident is a summary of a window, and the single event it names is a sample of that window rather than the whole of it. Every contributing event is still retrievable by querying events over the incident's window; the incident does not enumerate them |
| **Also**              | ⚠️ **`trackId` and `identityId` reach an incident by LINK, not by copy.** They are read back through `triggeredBy.eventId`. An event that ages out of retention while its incident has not breaks that link — the incident stays valid, the subject detail does not                                                                                                                                                                                               |
| **Planned**           | Carrying a contributing-event list on the incident is a Rule Engine milestone decision, not a bridge one. Recorded here so it is not discovered during an investigation                                                                                                                                                                                                                                                                                           |

## L-49 · A future envelope version is accepted rather than refused

|                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | `EventEnvelope.envelopeVersion` is carried and reported, and **no consumer checks it**. Measured: an envelope declaring `2.0.0` was accepted and evaluated exactly like a `1.0.0` one. Payload versions are genuinely free to move — payload `1.0.0`, `2.0.0` and `3.0.0`, including unknown nested objects, all travelled inside envelope `1.0.0` and were evaluated identically ([ADR-0040](../adr/ADR-0040-one-event-envelope-many-payload-schemas.md)) |
| **Customer impact**   | None today — the platform emits exactly one envelope version. ⚠️ It matters for a **third-party producer**: a partner publishing a future breaking envelope would have it silently consumed as though understood, rather than dead-lettered                                                                                                                                                                                                                |
| **Planned**           | A major-version gate at every consumer, landing with the first breaking envelope change and not before. Adding a check now would ship a rejection path nothing exercises, which is how a fail-closed gate quietly becomes wrong                                                                                                                                                                                                                            |

## L-57 · Dwell resolution is bounded by the event dedup window, not by the frame rate

|                       |                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | `services/events` collapses repeated detections of one subject into one event per dedup bucket (`EVENTS_DEDUP_WINDOW_MS`, **10 s** by default). A dwell rule therefore observes a *continuously present* person about **once every ten seconds**, however fast the camera runs. Measured: a 52.5 s loiter at 2 fps produced **7 observations**, a typical gap of 10.0 s and a longest gap of 10.0 s        |
| **Customer impact**   | ⚠️ **A dwell threshold under about 20 seconds is measuring the platform's sampling as much as the customer's policy.** A 60-second loitering rule is unaffected — it sees six observations and crosses cleanly. A 15-second one may cross on the second sighting or the third depending on where the buckets fall                                                                                          |
| **Also**              | ⚠️ **`resetAfterSeconds` must exceed this interval, not the frame interval.** A reset below it restarts the visit on almost every observation and the threshold is never reached — on a rule that saves, enables and reports healthy. Validation enforces the floor and names the dedup window as the reason; the first version of that check used the frame interval and would have blessed a 3-second reset |
| **Planned**           | Nothing for now. Lowering the window would raise event volume for every consumer to improve one stage's resolution. The honest fix, if a customer needs sub-10-second dwell, is a per-type dedup window — recorded here rather than built speculatively                                                                                                                                                     |

## L-58 · "Inside the zone" is the subject's feet in normalised image coordinates, never a place on the floor

|                       |                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current behaviour** | Zone membership is a point-in-polygon test on the **bottom centre of the bounding box** — the subject's floor contact point — against a polygon drawn in normalised `[0,1]` image coordinates. There is no camera calibration, no ground plane and no perspective correction anywhere in the platform                                                                    |
| **Customer impact**   | ⚠️ **A zone drawn on a picture is not a zone drawn on a floor.** For a camera looking along a room, a polygon covering the far half of the image covers a much larger physical area than one covering the near half. A subject the camera sees from directly above, or one whose feet are hidden by a counter or a shelf, is placed wrongly and no field reports that   |
| **Also**              | ⚠️ **Nothing in this milestone was measured against a physical camera.** Lens distortion, mounting angle and field of view all move where a floor polygon actually lies, and the accuracy of zone membership on real hardware is **unknown**. It is validated only against normalised coordinates                                                                        |
| **Planned**           | P-9 (hardware validation). Perspective correction needs a calibration step the product does not have and should not acquire speculatively                                                                                                                                                                                                                                |

## L-59 · A dwell in progress restarts its clock when the rules service restarts

|                       |                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Dwell state is held **in memory**, bounded and swept. A rules service redeployed or restarted while somebody is standing in a monitored zone forgets their visit; they must then be present for the full threshold again before anything fires                                                                                            |
| **Customer impact**   | ⚠️ **A deployment during business hours can miss an incident that was about to be raised.** For a 60-second threshold the exposure is under a minute per restart. Cool-downs are forgotten too, so a subject already alerted on may produce a second candidate immediately after a restart                                                 |
| **Also**              | ⚠️ Unlike windowed state, dwell is **not** re-derivable from event replay in the general case: replaying the last hour rebuilds a visit only if the whole visit falls inside that hour. The store also evicts under memory pressure, and `dwellStateEvicted` on the Live Rule Status page is non-zero when it has                          |
| **Planned**           | A Redis-backed `DwellStateStore` — the port exists and is unchanged, exactly as `RuleStateStore` already anticipates for windows. Not built here because a durable write on the per-event path puts a disk between a camera and an alert                                                                                                   |

## L-56 · Camera-scoped rules could not be enabled in any deployment before P-8 Phase 7

|                       |                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | ✅ **Closed by P-8 Phase 7.** Until then, no composition root wired a `CameraDirectory` into the rules service, so `unavailableCameraDirectory` reported `available: false`, every validation report said `verified: false`, and a rule naming any camera **could not be activated**. Only tenant-wide rules were enablable                        |
| **Customer impact**   | ⚠️ Historic. Anyone who tried to scope a rule to a camera would have been told the reference could not be checked, with no way to proceed. Nobody had reported it, because nothing in the product had ever tried — the P-4 rule designer shipped the capability and no verification exercised it                                                  |
| **Also**              | ⚠️ **The verification that would have caught it did not exist until the feature that needed it did.** The loitering run's step 3 is now that check: if `CAMERA_SERVICE_URL` is missing, enabling a camera-scoped rule goes red and names the reason                                                                                              |
| **Planned**           | Done. Recorded because "it was never wired" is a different class of defect from "it broke", and the second is the one people look for                                                                                                                                                                                                              |

## L-54 · A camera must be assigned before anything analyses it — including a verification

|                       |                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | From P-8 Phase 6 a camera whose stream is started is **not** analysed until AI is enabled on it. Before Phase 6 perception was one deployment variable and applied to everything. ⚠️ Twelve existing verification scripts assumed the old default; the Phase 5 bridge run went red with 12 failures the moment the gate was switched on |
| **Customer impact**   | ⚠️ **An integration or runbook written before this milestone that starts a stream and waits for detections will wait for ever.** Starting a stream and enabling AI are now two operations, deliberately — that separation is the feature                                                                                                |
| **Also**              | Every affected verification now assigns the cameras it creates (`docs/review/p8/_assign.mjs`), which is the scripts catching up with the platform rather than a workaround. The alternative — shipping the gate switched off so the old scripts kept passing — would have left a control plane the deployment does not obey             |
| **Planned**           | Nothing. This is the milestone. It is recorded so that a red verification after an upgrade is diagnosed in seconds rather than investigated as a bridge failure                                                                                                                                                                         |

## L-50 · An assignment change takes up to two poll cycles to be confirmed

|                       |                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | The enforcement point polls the plan every **5 seconds** and reports back on the same tick, so an accepted change is applied within one cycle and _confirmed_ within two. The console shows the control plane's state immediately and the confirmation when it lands. Measured on the deployment: frames stopped within 10 seconds of a pause, and zero frames in the following window |
| **Customer impact**   | ⚠️ **An operator who pauses a camera sees "Paused" at once and may still see a frame or two land behind it.** Those are the in-flight queue draining, not the gate failing. A camera switched off is never analysed after its confirmation, and the confirmation is what the audit trail records                                                                                       |
| **Also**              | ⚠️ **The control plane's view of what is running is always one report old**, and `observed.stale` makes an expired measurement visible rather than silently confident. That is the price of refusing to infer "running" from having published a plan                                                                                                                                   |
| **Planned**           | Nothing. Push delivery would be faster and would still need reconciliation — a missed message leaves the enforcement point wrong with nothing to correct it, whereas polling a versioned document converges whatever happened ([ADR-0043](../adr/ADR-0043-assignment-is-a-control-plane-with-a-measured-data-plane.md))                                                                |

## L-51 · Bulk assignment is validated atomically, not written atomically

|                       |                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | The deployment runs a **standalone MongoDB**, which offers no multi-document transactions. A bulk operation validates **every** item and computes every new document before writing any, so a bad request writes nothing at all. A fault _during_ the write phase can leave some items applied — the response then carries `partial: true`, an HTTP **207**, and a per-item outcome |
| **Customer impact**   | ⚠️ **A partial bulk result is possible and is reported rather than hidden.** An operator enabling AI on 50 cameras during an infrastructure fault may find 30 enabled; the response says which. Re-running the operation is safe — every action is idempotent from the state it left behind                                                                                         |
| **Planned**           | Running MongoDB as a single-node **replica set** enables `withTransaction` and closes this without a contract change. It is a deployment change with its own operational cost and has not been made ([ADR-0043](../adr/ADR-0043-assignment-is-a-control-plane-with-a-measured-data-plane.md))                                                                                       |

## L-52 · Runtime occupancy is visible across tenants

|                       |                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current behaviour** | An AI runtime is shared infrastructure — a container several tenants' cameras run on. Its **occupancy** (`14 / 16`) and utilisation are therefore counted across every tenant and shown to each. The _cameras_ on a runtime are always filtered to the caller's own tenant; no other tenant's camera id, name or tenant id is ever exposed |
| **Customer impact**   | ⚠️ On a multi-tenant install a customer can infer that **other cameras exist** on the same runtime, from a count. They cannot learn whose, where, or what they watch. On a single-tenant install — which is how this product is sold today — the number is entirely their own                                                              |
| **Planned**           | Nothing, and the alternative is worse: hiding it leaves an operator unable to understand why placement was refused with "every eligible runtime is at capacity". A per-tenant runtime pool would remove the sharing altogether and is a deployment topology, not a code change                                                             |

## L-53 · Four of the six shipped processing profiles cannot run on this deployment

|                       |                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Current behaviour** | The catalogue ships **Disabled · Person Tracking · Retail Monitoring · Queue Analytics · Vehicle Analytics · Safety Monitoring**. The deployed runtime advertises exactly one capability (`perception.person-detection`), so the first three run and the last three do not. Binding a camera to an unrunnable profile is **refused (409)** |
| **Customer impact**   | ⚠️ **Queue, vehicle and safety analytics are catalogue entries, not features.** The profiles page marks them "No runtime" and the refusal names the capability. Nothing silently accepts a camera and produces nothing — but a customer reading the profile list without the page would over-estimate what is available                    |
| **Also**              | The seeded catalogue is deliberately larger than what runs. Seeding only what happens to work would hide the shape of the product and re-introduce the assumption that there is one runtime with one model                                                                                                                                 |
| **Planned**           | Each unrunnable profile closes when a runtime advertising its capability exists. That is a model and runtime question, not an assignment one — the assignment layer will place a camera on it the moment one is registered                                                                                                                 |

---

## How to use this in a pilot

1. **Read L-1 through L-7 aloud with the customer before they sign.** Every one of them is something
   they would otherwise discover in week one.
2. ✅ **No limitation here blocks a pilot any more.** L-5 and L-6 were the two, and both closed in
   P-6. ⚠️ L-23 belongs in the customer's security review, not in the sales conversation.
3. **Agree the backup interval (L-18) in writing**, because it is the only limitation here whose
   impact is unbounded.
4. **Never claim a behaviour that L-2 says does not exist**, and never claim a camera model that L-1
   says has not been connected.

## Adding a limitation

Add a row the moment you know, not when the milestone that fixes it is scheduled. A limitation with
no planned milestone is honest; a limitation nobody wrote down is not.

Format: **Description · Current behaviour · Customer impact · Planned milestone.** Say what the
customer will _see_, not what the code does.

---

## Related

- [PRODUCT_CAPABILITY_MATRIX](PRODUCT_CAPABILITY_MATRIX.md) — the state behind each limitation
- [PRODUCT_ROADMAP](PRODUCT_ROADMAP.md) — the milestone that closes it
- [CUSTOMER_JOURNEYS](CUSTOMER_JOURNEYS.md) — what does work, end to end
- [tracking/TECH-DEBT.md](../../tracking/TECH-DEBT.md) — internal debt, deliberately not here

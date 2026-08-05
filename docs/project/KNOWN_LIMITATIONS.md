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

## L-41 · One host analyses about four cameras, not sixteen

|                       |                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Measured on a 10-core CPU-only host: **4 cameras** at 2 fps each are analysed inside a 2 % frame-loss budget (0.4 % measured). At 8 cameras 8.0 % of offered frames are dropped, at 16 cameras 18.9 % — see [AI_RUNTIME_BENCHMARK](AI_RUNTIME_BENCHMARK.md)                                                                                     |
| **Customer impact**   | ⚠️ **The video tier and the AI tier have different capacities and only one of them is advertised.** Recording carried 16 cameras with zero loss; perception sustains 4. Beyond 4, analysis **samples** the stream rather than covering it — detections stay correct (exactly 2.00 per frame at every rung) but some frames are never examined   |
| **Planned**           | GPU execution is the real answer and is why the provider is a registry field rather than a constant. Before that, `cpus:` on the perception tier ([TD-63](../../tracking/TECH-DEBT.md)) so inference cannot starve the decode path that writes evidence. ⚠️ Any per-host camera number quoted to a customer must state the fps and the hardware |

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

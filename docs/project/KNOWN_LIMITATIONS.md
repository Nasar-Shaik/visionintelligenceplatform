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

## L-5 · A user account cannot be disabled

|                       |                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current behaviour** | Users can be **created** and **listed**. There is no way — console, API or CLI — to change a role, reset a password, or **deactivate an account** |
| **Customer impact**   | ⛔ **An offboarded employee keeps their access.** A customer's own security policy will require this before they sign                             |
| **Planned**           | **P-6** · with L-6 now closed, this is the **last remaining pilot blocker**                                                                       |

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

---

## How to use this in a pilot

1. **Read L-1 through L-7 aloud with the customer before they sign.** Every one of them is something
   they would otherwise discover in week one.
2. **L-5 and L-6 are pilot blockers** — do not start a pilot before P-6 closes them.
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

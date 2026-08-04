# Customer Acceptance Checklist

Signed by the customer, in their environment, on their hardware. Every line is something they do
themselves and can see the result of — nothing here is taken on trust.

**Rule for the whole document:** if a step needs a developer, a terminal or a database, it does not
belong in an acceptance test. Sections 1 and 8 are the only ones an administrator runs from a shell.

```
Customer: ______________________   Site: ______________________

Date: ____________   Platform version (git sha): ____________________

Customer signatory: ______________________   Supplier: ______________________
```

---

## 1 · Installation (administrator)

| #   | Check                                                             | Pass | Notes      |
| --- | ----------------------------------------------------------------- | ---- | ---------- |
| 1.1 | Platform deploys from the documented steps alone, no manual edits | ☐    |            |
| 1.2 | Installation completed in under 60 minutes                        | ☐    | time: ____ |
| 1.3 | `prod.sh ps` shows every service healthy                          | ☐    |            |
| 1.4 | **Only the edge publishes a host port**                           | ☐    |            |
| 1.5 | `https://<host>/` serves the console; `http://` redirects         | ☐    |            |
| 1.6 | Certificate is the intended one                                   | ☐    |            |
| 1.7 | `/health` returns JSON; `/ready` lists dependency checks          | ☐    |            |

## 2 · Sign-in and access control

| #   | Check                                                                           | Pass |
| --- | ------------------------------------------------------------------------------- | ---- |
| 2.1 | Each named operator can sign in with their own account                          | ☐    |
| 2.2 | An operator sees only their own organisation's data                             | ☐    |
| 2.3 | A `viewer` cannot modify a rule (control absent, API refuses)                   | ☐    |
| 2.4 | Signing out returns to login; **the back button does not reveal the workspace** | ☐    |
| 2.5 | All bootstrap passwords changed; unused accounts disabled                       | ☐    |

## 3 · The estate

| #   | Check                                                                          | Pass |
| --- | ------------------------------------------------------------------------------ | ---- |
| 3.1 | Customer's real hierarchy created (sites, buildings, zones)                    | ☐    |
| 3.2 | Cameras registered against the correct zones                                   | ☐    |
| 3.3 | Camera list shows **names the customer recognises**                            | ☐    |
| 3.4 | Camera health reflects reality — a camera unplugged on purpose reports offline | ☐    |
| 3.5 | A wrong password fails at the `authentication` stage, not "offline"            | ☐    |

> ⚠️ 3.4 and 3.5 are the first tests against **real hardware**. Expect surprises; record them.
> See [CCTV_READINESS.md](CCTV_READINESS.md).

## 4 · Detection and incidents

| #   | Check                                                                   | Pass |
| --- | ----------------------------------------------------------------------- | ---- |
| 4.1 | At least one rule configured for the customer's actual use case         | ☐    |
| 4.2 | A staged trigger raises an incident within the expected window          | ☐    |
| 4.3 | The incident names the right camera, zone and severity                  | ☐    |
| 4.4 | **Why this fired** shows the rule, its version and the triggering event | ☐    |
| 4.5 | Repeated triggers collapse into one incident with a count               | ☐    |

## 5 · Investigation — the core workflow

Run by a **customer operator**, not by the supplier.

| #   | Check                                                            | Pass                    |
| --- | ---------------------------------------------------------------- | ----------------------- |
| 5.1 | Operator finds the incident in the queue unaided                 | ☐                       |
| 5.2 | **Open investigation** is discoverable without being pointed at  | ☐                       |
| 5.3 | Evidence is listed against the incident                          | ☐                       |
| 5.4 | **A recording plays** — moving picture, not a black rectangle    | ☐                       |
| 5.5 | Timeline scrubs; playhead responds                               | ☐                       |
| 5.6 | A bookmark can be created and is found again                     | ☐                       |
| 5.7 | A comment can be added and is visible to a second operator       | ☐                       |
| 5.8 | Incident can be acknowledged, resolved with a reason, and closed | ☐                       |
| 5.9 | Whole workflow completed **without supplier assistance**         | ☐ clicks: ___ time: ___ |

> Do not skip 5.4. Every health check was green throughout a deployment in which playback was
> completely broken (P-5.8). A person pressing play is the only thing that found it.

## 6 · Evidence integrity

| #   | Check                                                                   | Pass |
| --- | ----------------------------------------------------------------------- | ---- |
| 6.1 | Evidence chain shows who accessed the recording, when, and why          | ☐    |
| 6.2 | Opening a recording **appends a new custody entry**                     | ☐    |
| 6.3 | Brightness/zoom adjustments are marked and do not alter the stored file | ☐    |
| 6.4 | A copied playback URL stops working after its expiry                    | ☐    |
| 6.5 | Customer's evidence-handling policy is satisfied by the above           | ☐    |

## 7 · Presentation and access

| #   | Check                                                    | Pass            |
| --- | -------------------------------------------------------- | --------------- |
| 7.1 | Console usable on the customer's actual operator screens | ☐ sizes: ______ |
| 7.2 | Usable on the control-room tablet, if one is used        | ☐               |
| 7.3 | Branding applied — name, logo, favicon, colour           | ☐               |
| 7.4 | Keyboard navigation works; focus is always visible       | ☐               |
| 7.5 | Wording is clear to staff with no technical background   | ☐               |

## 8 · Operational readiness (administrator)

| #   | Check                                                                 | Pass        |
| --- | --------------------------------------------------------------------- | ----------- |
| 8.1 | Backup runs and produces all three artefacts                          | ☐           |
| 8.2 | **A restore has been performed and verified**                         | ☐           |
| 8.3 | `CREDENTIAL_ENCRYPTION_KEY` backed up somewhere off this host         | ☐           |
| 8.4 | Backup schedule agreed; **RPO understood and accepted**               | ☐ RPO: ____ |
| 8.5 | Uptime monitor points at `/ready`                                     | ☐           |
| 8.6 | Alerting distinguishes 503 from unreachable                           | ☐           |
| 8.7 | Customer administrator has completed an upgrade or rollback in a test | ☐           |
| 8.8 | Customer staff hold the Operator and Administrator guides             | ☐           |

## 9 · Limitations acknowledged

The customer confirms they have been told, in writing, that this deployment does **not** provide:

| #   | Limitation                                                                                                                 | Acknowledged |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 9.1 | **Live streaming / live view**                                                                                             | ☐            |
| 9.2 | **Reports, exports and analytics dashboards**                                                                              | ☐            |
| 9.3 | **Email or SMS notification** (in-app and webhook only)                                                                    | ☐            |
| 9.4 | **AI analysis** — advisory only, none configured                                                                           | ☐            |
| 9.5 | **Failover** — single host; a service restart is a brief outage                                                            | ☐            |
| 9.6 | **Point-in-time backup consistency**                                                                                       | ☐            |
| 9.7 | **Rate limiting** — required in front for internet-facing use                                                              | ☐            |
| 9.8 | **Camera-model validation** — the customer's models have not been certified against this platform before this installation | ☐            |

Full list: [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

---

## Acceptance

```
Sections 1–8 complete: ☐        Section 9 acknowledged: ☐

Defects raised: ______     Blocking: ______

Customer ____________________  Date ________

Supplier ____________________  Date ________
```

> A blocking defect is one that prevents an operator completing section 5 unaided. Everything else
> is a punch-list item and should not hold acceptance.

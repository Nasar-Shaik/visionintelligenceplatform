# Pilot Installation Checklist

A single-host customer pilot, start to finish. Sequenced so nothing blocks on something later in
the list.

Budget: **half a day on site**, plus lead time on section 1.

---

## 1 · Before the visit — with the customer, by email

| #    | Item                                                                                                                                | Done |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1.1  | Host provisioned: 4 vCPU / 8 GB minimum, Docker 24+ with Compose v2                                                                 | ☐    |
| 1.2  | Disk sized from the camera count — **recordings dominate everything else** ([CAPACITY.md](../review/p58/CAPACITY.md))               | ☐    |
| 1.3  | Hostname agreed; DNS A record created and resolving                                                                                 | ☐    |
| 1.4  | Ports 80 and 443 reachable (ACME needs :80)                                                                                         | ☐    |
| 1.5  | Host can reach the camera VLAN                                                                                                      | ☐    |
| 1.6  | Camera inventory received: make, model, firmware, IP, credentials                                                                   | ☐    |
| 1.7  | **Camera models checked against [CCTV_READINESS.md](../review/p59/CCTV_READINESS.md)** — expectations set that they are unvalidated | ☐    |
| 1.8  | Backup destination agreed (path or share, off this host)                                                                            | ☐    |
| 1.9  | Named operators and roles agreed                                                                                                    | ☐    |
| 1.10 | Site hierarchy sketched — sites, buildings, zones                                                                                   | ☐    |
| 1.11 | Branding assets received: logo (SVG), colour, support contact                                                                       | ☐    |

## 2 · Install — ~30 minutes

Follow [DEPLOYMENT.md](DEPLOYMENT.md). Do not improvise; if a step is wrong, fix the guide.

| #   | Item                                                                | Done |
| --- | ------------------------------------------------------------------- | ---- |
| 2.1 | Repository cloned to the host                                       | ☐    |
| 2.2 | `.env.production` created; **every secret independently generated** | ☐    |
| 2.3 | `VIP_PUBLIC_URL` set to the agreed hostname                         | ☐    |
| 2.4 | `prod.sh up -d --build` completed                                   | ☐    |
| 2.5 | All services healthy; **one host-port row only**                    | ☐    |
| 2.6 | HTTPS serves the console; HTTP redirects                            | ☐    |
| 2.7 | `/health` and `/ready` return JSON                                  | ☐    |

> ⚠️ **Back up `CREDENTIAL_ENCRYPTION_KEY` before going further.** It cannot be rotated; losing it
> makes every stored camera credential permanently unreadable.

## 3 · Tenant and people — ~20 minutes

| #   | Item                                                  | Done |
| --- | ----------------------------------------------------- | ---- |
| 3.1 | Tenant seeded (`--profile seed run --rm seed`)        | ☐    |
| 3.2 | Real accounts created for named staff                 | ☐    |
| 3.3 | Bootstrap passwords changed; unused accounts disabled | ☐    |
| 3.4 | Each operator signs in successfully                   | ☐    |

## 4 · Estate — ~30 minutes

| #   | Item                                                           | Done |
| --- | -------------------------------------------------------------- | ---- |
| 4.1 | Hierarchy built to match the sketch, **before** adding cameras | ☐    |
| 4.2 | Node names are the customer's own words, not ours              | ☐    |
| 4.3 | Cameras added (Discovery first; manual where it finds nothing) | ☐    |
| 4.4 | Every camera assigned to the correct zone                      | ☐    |
| 4.5 | Camera names match the customer's signage                      | ☐    |

## 5 · Camera validation — allow 1–2 hours, and expect surprises

**This is the first time the platform meets these camera models.** Budget generously and write
everything down.

| #   | Item                                                                  | Done |
| --- | --------------------------------------------------------------------- | ---- |
| 5.1 | Each camera probes to `first-frame`                                   | ☐    |
| 5.2 | Codec, resolution and frame rate reported for each                    | ☐    |
| 5.3 | Deliberate wrong password fails at `authentication`                   | ☐    |
| 5.4 | Deliberately unplugged camera fails at `tcp`/`dns`                    | ☐    |
| 5.5 | **Every deviation recorded** — vendor, model, firmware, what happened | ☐    |
| 5.6 | Findings sent back to engineering against TD-27                       | ☐    |

> 5.5 is the most valuable output of the entire pilot. It is the data that turns
> [CCTV_READINESS.md](../review/p59/CCTV_READINESS.md) from a plan into a supported-hardware list.

## 6 · Rules — ~30 minutes

| #   | Item                                                                 | Done |
| --- | -------------------------------------------------------------------- | ---- |
| 6.1 | At least one rule for the customer's real use case                   | ☐    |
| 6.2 | Scoped to a **zone**, not to a list of camera ids                    | ☐    |
| 6.3 | Schedules configured (trading hours, deliveries, lettings, cleaning) | ☐    |
| 6.4 | Staged trigger raises an incident                                    | ☐    |
| 6.5 | Incident names the right camera, zone and severity                   | ☐    |

## 7 · Branding — ~10 minutes

| #   | Item                                                                                  | Done |
| --- | ------------------------------------------------------------------------------------- | ---- |
| 7.1 | `branding/branding.json` created and **bind-mounted** so upgrades do not overwrite it | ☐    |
| 7.2 | Logo, name, favicon, colour, support footer applied                                   | ☐    |
| 7.3 | Colour passes the contrast check (no console warning)                                 | ☐    |
| 7.4 | Verified on the login screen and in the shell                                         | ☐    |

## 8 · Operations — ~30 minutes

| #   | Item                                                           | Done |
| --- | -------------------------------------------------------------- | ---- |
| 8.1 | Backup runs successfully                                       | ☐    |
| 8.2 | **Restore performed and verified** — not just "the backup ran" | ☐    |
| 8.3 | Backup scheduled; destination confirmed off-host               | ☐    |
| 8.4 | Uptime monitor points at `/ready`                              | ☐    |
| 8.5 | **Health check proven able to fail** (stop NATS, confirm 503)  | ☐    |
| 8.6 | Administrator has performed one upgrade in a test              | ☐    |
| 8.7 | Log retention agreed                                           | ☐    |

## 9 · Handover — ~30 minutes

| #   | Item                                                                                                    | Done |
| --- | ------------------------------------------------------------------------------------------------------- | ---- |
| 9.1 | Operator walked through a real incident, start to finish, unaided                                       | ☐    |
| 9.2 | [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md) handed over                                                      | ☐    |
| 9.3 | [ADMINISTRATOR_GUIDE.md](ADMINISTRATOR_GUIDE.md) handed over                                            | ☐    |
| 9.4 | [KNOWN_LIMITATIONS.md](../review/p59/KNOWN_LIMITATIONS.md) **read together, not just sent**             | ☐    |
| 9.5 | [CUSTOMER_ACCEPTANCE_CHECKLIST.md](../review/p59/CUSTOMER_ACCEPTANCE_CHECKLIST.md) completed and signed | ☐    |
| 9.6 | Support route and escalation agreed                                                                     | ☐    |
| 9.7 | Pilot review date booked                                                                                | ☐    |

---

## Rolling back the visit

If section 5 goes badly — cameras will not onboard, or recordings will not play — **stop and do not
force it**. The platform is not the problem to debug on the customer's time; the vendor behaviour is
the finding.

Leave the deployment installed with the demo dataset so the customer can see the product
(`infra/docker/demo.sh reset`), record every deviation, and book a return visit. A pilot that
honestly reports "your camera model does something we have not seen before" is worth more than one
that half-works and is called done.

---

## Timing observed

| Phase                 | Budget                   |
| --------------------- | ------------------------ |
| Install               | 30 min                   |
| Tenant + people       | 20 min                   |
| Estate                | 30 min                   |
| **Camera validation** | **1–2 h — the variable** |
| Rules                 | 30 min                   |
| Branding              | 10 min                   |
| Operations            | 30 min                   |
| Handover              | 30 min                   |
| **Total**             | **~4–5 hours**           |

Everything except camera validation is predictable. Camera validation is not, because nothing has
been validated before. Say so when booking the visit.

# Known limitations — P-5.9 snapshot

> ⚠️ **Superseded as the living record.** This is the state as it stood at P-5.9 customer
> certification (2026-08-03), kept because the review package it belongs to must stay readable
> as it was reviewed.
>
> **The canonical, maintained list is
> [docs/project/KNOWN_LIMITATIONS.md](../../project/KNOWN_LIMITATIONS.md)** — read that one with
> a customer, and add new limitations there.

Everything a customer would reasonably expect that this platform does not do. Written to be handed
over, not to be discovered.

A limitation found by a prospect after you glossed over it discounts everything else you said.
Reading this list aloud costs two minutes and buys the credibility of every claim beside it.

---

## 1 · The big one: no camera has ever been connected

**No CCTV camera and no NVR has been connected to this platform at any point.** Not one, in any
milestone.

Everything about camera onboarding, ONVIF discovery, connectivity probing and recording playback is
_implemented_ and verified against synthetic media — real H.264 and H.265 in real MP4 containers,
which exercises the player honestly. None of it has met a vendor device.

Unknown as a result: vendor muxing quirks, variable-bitrate seeking accuracy, real recording gaps,
camera clock drift, night-vision encoder behaviour, NVR export formats, and whether ONVIF discovery
finds anything.

**TD-27.** Plan: [CCTV_READINESS.md](CCTV_READINESS.md). This is the single largest gap and the one
to close first.

---

## 2 · Not built

Each of these is _announced by the product_ rather than hidden — the console shows "not built" or
"not configured for this deployment" instead of an empty panel that reads as broken.

| Not built                                      | Consequence                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live streaming / live view**                 | No browser plays RTSP natively; a transcode path (WebRTC or LL-HLS) does not exist. Investigation is recorded-playback only. **TD-28**          |
| **Reports and exports**                        | The Export entry point exists; no report is generated. Evidence can be downloaded individually                                                  |
| **Dashboards beyond the operational overview** | No analytics, trends or scheduled reporting                                                                                                     |
| **Email / SMS notification**                   | Notifications are in-app and webhook only                                                                                                       |
| **Search federation**                          | No unified search across incidents, events and evidence                                                                                         |
| **Saved investigations**                       | The workspace state is per-session, not a saved artefact                                                                                        |
| **AI advisor**                                 | AI is contract-frozen and advisory. Nothing analyses incidents. The console says so explicitly rather than showing an empty recommendations box |
| **PTZ control**                                | Contract exists; no control path                                                                                                                |
| **Background jobs**                            | Contract-frozen; no worker runs                                                                                                                 |

---

## 3 · Operational limits

| Limit                                 | Detail                                                                                                                                                  | Debt  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **Single host, no failover**          | Restarting a service is a brief outage for that service. The console recovers without a page refresh                                                    | —     |
| **MongoDB is a single node**          | Backups are per-collection consistent, **not point-in-time across collections**. A backup taken mid-write can hold an incident without its notification | TD-38 |
| **RPO = your backup interval**        | No continuous replication. Nightly backups mean up to 24 hours of loss                                                                                  | —     |
| **No rate limiting at the edge**      | The gateway authorizes every request but does not throttle. Brute-force protection on `/auth/login` needs a limiter in front                            | TD-39 |
| **No log shipping**                   | JSON on stdout, rotated locally at 10 MB × 5                                                                                                            | —     |
| **Verified to ~100 cameras in shape** | 500-camera sizing is arithmetic on measured per-unit costs, not a measurement                                                                           | —     |

---

## 4 · Interface and browser

| Limitation                                | Detail                                                                                                                                                                                                                | Debt  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **Dark theme only**                       | Deliberate for a SOC product. Tokens exist for a light palette; none has been produced or reviewed                                                                                                                    | TD-43 |
| **Tenant must be typed at login**         | An operator must know their tenant slug. Correct for multi-tenancy, and the first thing a customer sees                                                                                                               | TD-40 |
| **H.265 refused by open-source Chromium** | A browser licensing decision, not a platform fault. Branded Chrome, Edge and Safari play it. The console explains this and offers the original                                                                        | —     |
| **Tablet hides panels**                   | At 1024×768 the workspace shows 10 of 17 panels and says how many are hidden. Detailed work wants a wider display                                                                                                     | —     |
| **Zod's JIT probe trips the CSP**         | Zod tests for codegen with `new Function("")`; the CSP correctly denies it and Zod falls back to interpreted validation. Logs one violation per load. **Adding `'unsafe-eval'` to silence it would be the wrong fix** | TD-37 |
| **`style-src 'unsafe-inline'`**           | Required by runtime-computed layout geometry (playhead position, gap widths). The one genuine CSP relaxation                                                                                                          | TD-36 |

---

## 5 · Branding

|                                                                                                                |       |
| -------------------------------------------------------------------------------------------------------------- | ----- |
| ✅ Deployment branding — name, logo, favicon, accent colour, login footer — with **no rebuild**                |       |
| ❌ **Per-tenant branding within one deployment.** Branding is read before sign-in, so it cannot vary by tenant | TD-42 |
| ➖ Report and email branding — those features do not exist yet                                                 |       |

---

## 6 · Demonstration data

The demo dataset is **entirely invented**: four fictional organisations, 33 fictional cameras, 18
scripted incidents. Recordings are ffmpeg test patterns.

What it does _not_ fake, deliberately: evidence bytes and custody go through the real API so the
integrity hash and chain of custody are genuine; no AI output is fabricated; no camera probe
measurements are invented.

See [DEMO_DATASET.md](../../demo/DEMO_DATASET.md).

---

## 7 · How to talk about this

> "It deploys, it backs up, it restores, and every screen works — we proved that by deploying it and
> breaking it on purpose. What we have not done is connect your cameras. We would rather do that
> with you in a pilot than tell you it will work and find out together on go-live day."

Honest, and stronger than a claim that cannot be supported.

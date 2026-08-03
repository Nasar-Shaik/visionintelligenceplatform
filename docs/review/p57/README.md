# P-5.7 — production verification against the running product

P-5.6 verified playback against files and a component harness. P-5.7 **deployed the whole stack and
used it**: Mongo, MinIO, NATS, ten services, the console, seeded data, a real browser.

That found seven defects no test suite could have found, because every one of them lived in the gap
between "the code is correct" and "the product works when you run it".

Companions: [BROWSER_MATRIX.md](BROWSER_MATRIX.md) (Edge added; two P-5.6 conclusions corrected) ·
[VERIFICATION.md](VERIFICATION.md) (every check and its result) ·
[../p56/NVR_VALIDATION.md](../p56/NVR_VALIDATION.md) (still no CCTV hardware).

## ⚠️ The seven defects

**1. The Investigation Workspace was unreachable.** `/workspace/:incidentId` had been routed since
P-5.2 and **nothing in the product linked to it** — no navigation entry, no action on an incident.
Five milestones of playback, timeline, bookmarks, evidence chain and metadata could only be reached
by typing a URL. To a customer they did not exist. Now: an **Open investigation** action on the
incident sheet, and an **Investigations** entry in the sidebar.

**2. Two services would not start against a database with history.** Camera and tenant both exited
at boot with `IndexOptionsConflict` — an index had gained its `_id` cursor key under an existing
name. Every test runs against a fresh database, so the conflict cannot occur there; on a customer's
machine it is an upgrade that takes the fleet offline. The evidence and events stores already
reconciled; these two now do too.

**3. Playback could not work at all in the default configuration.** The `local` storage provider
presigns `{base}/{key}?expires=<epoch>` — **with no signature** — and nothing served that route, so
the player 404'd. Serving it would have been worse than the 404: any key plus any future timestamp
would read any tenant's evidence. Dev now uses MinIO, which presigns for real and is what production
runs.

**4. One panel's error blanked the whole workspace.** An incident document predating the `notes`
field made a panel throw, React unmounted the route, and the investigator got a white page — no
footage, no timeline, no explanation. Panels are now individually contained: one fails, one says so,
the other sixteen keep working.

**5. One bad row blanked a whole page.** With no `errorElement`, React Router's built-in fallback
rendered nothing. There is now a route error page that shows the message and offers a way back —
what an operator quotes to support instead of "it went blank".

**6. The timeline route returned 500.** Same root cause as (4): `buildTimeline` read
`incident.notes.map` on a document that had no `notes`. Fixed **at the storage boundary** — a schema
default is a promise about parsing, not about every document ever written — so every consumer is
covered, not the two that happened to crash.

**7. The product contradicted itself about its own health.** The workspace reported events, evidence,
playback and notifications as _"not configured for this deployment"_ while the console was reading
those same services successfully. The workflow service had no URLs for its siblings. Honest
"not configured" reporting is only honest when the deployment is actually configured;
`.env.example` now documents them.

Plus, from the browser: **a missing video decoder plays the audio and shows black** with no error at
all (`videoWidth === 0`) — now detected and named — and the workspace **overflowed horizontally at
1024×768**, the tablet an operator carries.

## The operator workflow, browser only

Incident → Investigation Workspace → Playback → Timeline → Bookmark → Metadata → Evidence chain →
Export entry point → evidence switching → keyboard sheet.

**14/14 steps, zero console errors, zero failed requests.** No API calls, no database edits, no
developer tools. Screenshots `e2e-01…e2e-14`.

Reproducible by anyone:

```
pnpm dev:stack && pnpm seed && pnpm dev:services && pnpm seed:evidence && pnpm dev:web
```

`pnpm seed:evidence` is new. It registers through the **real API**, so the chain of custody is
genuinely opened and the integrity hash genuinely computed — a hand-written row would have
demonstrated a tamper-evidence feature that had been bypassed.

## Screenshots

| File                                                          | What it shows                            |
| ------------------------------------------------------------- | ---------------------------------------- |
| `e2e-01…14`                                                   | The full operator workflow, step by step |
| `scale-incidents.png`                                         | The queue with 5,000 incidents behind it |
| `scale-workspace.png`                                         | The workspace under load                 |
| `net-slow3g.png` · `net-offline.png` · `net-backend-down.png` | Degraded network and a stopped backend   |
| `ui-desktop/laptop/tablet/phone.png`                          | Responsive review at four widths         |

## Honest limitations

- ⚠️ **Still no CCTV hardware.** No Hikvision, Dahua, CP Plus, UNV or ONVIF device; no NVR. And **no
  browser plays RTSP**, so live view remains a missing server-side component rather than a testing
  gap. Unchanged from P-5.6: [NVR_VALIDATION.md](../p56/NVR_VALIDATION.md), TD-27/TD-28.
- **Real Safari refused every MP4 tested on this machine**, including properly-encoded H.264, while
  playing WebM. Recorded as an unexplained local result, not as a product claim.
- **The demo clips are ffmpeg test patterns.** Real H.264/H.265 in real containers — which is what
  the player depends on — but not footage.
- **Production deployment was not verified**: no reverse proxy, HTTPS, CSP, compression or cache
  headers were exercised. The stack ran as `pnpm dev:*` against containerised infrastructure. That
  is a genuinely different thing from a production deployment and is not claimed. TD-32.
- **Scale figures come from scaffolded rows** inserted directly into Mongo, which is legitimate for
  measuring paging and rendering and is _not_ the demo path. The rows were removed afterwards.

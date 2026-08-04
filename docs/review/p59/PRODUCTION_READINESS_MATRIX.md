# Production readiness matrix

Where the platform stands, by area, with the evidence for each verdict.

**Legend** — ✅ verified by measurement · ⚙️ built, not validated against reality · ➖ not built ·
❌ known gap

---

## 1 · Deploy and operate

| Area                             | Verdict | Evidence                                                                                                                                    |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Single-host deployment           | ✅      | 16 containers, one command, from a clean clone (P-5.8)                                                                                      |
| TLS, HSTS, CSP, security headers | ✅      | Measured on every response; HTTP 308s to HTTPS                                                                                              |
| Compression + cache policy       | ✅      | zstd negotiated; `immutable` assets, `no-cache` index, `no-store` API                                                                       |
| Attack surface                   | ✅      | Exactly one host-port row (the edge). Datastores unreachable from the host                                                                  |
| Health / readiness               | ✅      | JSON at the edge; `/ready` **proven able to fail** (503 in 1.01 s with NATS down)                                                           |
| Graceful restart                 | ✅      | `tini` PID 1, 20 s drain                                                                                                                    |
| Structured logging               | ✅      | JSON, rotated; no secret, password or token in any log                                                                                      |
| Correlation ids                  | ✅      | Propagate edge → gateway → upstream; returned as `correlationId` on errors                                                                  |
| Metrics                          | ✅      | Prometheus on all 10 services, internal-only                                                                                                |
| Recovery from restarts           | ✅      | Every dependency restarted under a live investigation; UI recovers with no page refresh                                                     |
| **Backup + restore**             | ✅      | Volumes destroyed, stack rebuilt, restore returned login, incidents, evidence, **HTTP 206 real media bytes**, custody intact — proven twice |
| Upgrade / rollback               | ✅      | Documented and exercised; guides written                                                                                                    |
| Point-in-time backup consistency | ❌      | Single-node `mongodump`. **TD-38**                                                                                                          |
| Failover / HA                    | ❌      | Single host by design for a pilot                                                                                                           |
| Rate limiting at the edge        | ❌      | **TD-39**                                                                                                                                   |

## 2 · Security

| Area                         | Verdict | Evidence                                                                                           |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| Authentication               | ✅      | Unauthenticated → 401 on every surface; re-signed and `alg:none` tokens rejected                   |
| Authorization                | ✅      | Deny-by-default; `viewer` refused rule creation at the API (403)                                   |
| Tenant isolation             | ✅      | Forged `x-tenant-id` cannot widen scope; scope derives from the token                              |
| Internal header injection    | ✅      | `x-principal-id` / `x-roles` / `x-internal-key` stripped at the gateway                            |
| Signed evidence URLs         | ✅      | Tampered signature 403; rewritten key 403; unsigned GET 403; **expiry enforced** (206 → 206 → 403) |
| Evidence immutability        | ✅      | No delete/update route exists; verified intact after attempts                                      |
| Custody chain                | ✅      | Append-only; every access appends                                                                  |
| Browser hygiene after logout | ✅      | `localStorage` empty; no JWT ever persisted; back button redirects                                 |
| Penetration test             | ➖      | Never performed                                                                                    |

## 3 · The product

| Area                          | Verdict | Evidence                                                                                  |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| Operator workflow             | ✅      | **6 clicks, 22 s** queue → bookmarked evidence, browser only                              |
| Recorded playback             | ✅      | Decodes 1280×720 in Chromium, Firefox, WebKit against the deployment                      |
| Timeline + bookmarks          | ✅      | 1-hour recording scrubbed; bookmarks created from the UI                                  |
| Evidence chain in the UI      | ✅      | Custody visible; access appends                                                           |
| Rule versioning               | ✅      | Immutable versions; "Why this fired" cites the version that fired                         |
| Estate hierarchy              | ✅      | 28 locations across 4 tenants; cameras scoped to zones                                    |
| Camera health                 | ✅      | Staged probe naming the failing stage                                                     |
| Honest failure states         | ✅      | Codec refusal, network drop, expiry and "not built" each say something different and true |
| **Against real cameras**      | ❌      | **Never connected.** TD-27 — the largest gap                                              |
| Live streaming                | ➖      | TD-28                                                                                     |
| Reports / exports / analytics | ➖      | Not built; announced by the product                                                       |

## 4 · Commercial polish

| Area                                                  | Verdict | Evidence                                                                        |
| ----------------------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| Responsive layout                                     | ✅      | **Zero horizontal overflow** across 11 pages × 5 viewports (1920 → 390)         |
| Tablet usability                                      | ✅      | 1024×768 clipping fixed; 10 of 17 panels shown, count disclosed                 |
| Keyboard support                                      | ✅      | Every tab stop shows a visible focus ring; playback shortcuts with a help sheet |
| Tap targets (WCAG 2.5.8)                              | ✅      | **0 targets below 24 px** across all pages, after fixes                         |
| Heading structure                                     | ✅      | No skipped levels                                                               |
| Accessible names                                      | ✅      | 0 controls without one                                                          |
| Dark mode consistency                                 | ✅      | Single token source; dark-only by design                                        |
| Empty / loading / error / unavailable / failed states | ✅      | Five distinct states, each saying something different                           |
| Typography + spacing                                  | ✅      | Reviewed at four widths against a realistic estate                              |
| Data presentation                                     | ✅      | Camera **names**, not ids (fixed this milestone)                                |
| Light theme                                           | ➖      | Dark-only. **TD-43**                                                            |

## 5 · White-label

| Area                        | Verdict | Evidence                                                      |
| --------------------------- | ------- | ------------------------------------------------------------- |
| Product name, tagline, logo | ✅      | Runtime `branding.json`, **no rebuild**                       |
| Favicon                     | ✅      | Emoji → data-URI SVG at runtime, or a path                    |
| Accent colour / theme       | ✅      | Applied to real tokens; **WCAG-checked**, refused below 4.5:1 |
| Login branding + footer     | ✅      | Verified in the browser                                       |
| Fails soft                  | ✅      | Missing/malformed file → defaults; never blocks loading       |
| Per-tenant branding         | ❌      | **TD-42**                                                     |
| Report / email branding     | ➖      | Those features do not exist                                   |

## 6 · Demonstration

| Area                       | Verdict | Evidence                                                          |
| -------------------------- | ------- | ----------------------------------------------------------------- |
| Demo Mode                  | ✅      | `demo.sh reset` — one command, ~2 min, scoped to `tnt_demo_*`     |
| Dataset realism            | ✅      | 4 verticals, 33 cameras, full lifecycle, investigator-grade notes |
| Evidence authenticity      | ✅      | Registered through the real API; custody and hash genuine         |
| Four scripted walkthroughs | ✅      | Retail, warehouse, school, hospital                               |
| Demo certification         | ✅      | Browser only; no dev tools, DB edits, API calls or scripts        |

## 7 · Documentation

| Document                                                    | Status            |
| ----------------------------------------------------------- | ----------------- |
| Deployment, Backup/DR, Upgrade, Rollback, Troubleshooting   | ✅ P-5.8          |
| Operator Guide, Administrator Guide, Branding               | ✅ this milestone |
| Demo Guide, Demo Dataset Guide                              | ✅                |
| Pilot Installation Checklist, Customer Acceptance Checklist | ✅                |
| CCTV readiness plan, Known Limitations                      | ✅                |

---

## Summary

|                                       | Count                                        |
| ------------------------------------- | -------------------------------------------- |
| ✅ Verified by measurement            | 44                                           |
| ⚙️ Built, unvalidated against reality | camera onboarding path (blocked on hardware) |
| ➖ Not built, and announced as such   | 9                                            |
| ❌ Known gaps with debt raised        | 6                                            |

**The platform is deployable, recoverable, secure, demonstrable and documented. It has never seen a
camera.**

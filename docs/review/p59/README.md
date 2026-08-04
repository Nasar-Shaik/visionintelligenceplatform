# P-5.9 — Customer certification: review package

**Milestone:** commercial product certification — demo experience, UI quality, walkthroughs, seed
data, white-label, documentation, pilot readiness.
**Method:** load a realistic estate into the production deployment, then review every screen as if
it were shipping to a paying customer.

|                   |                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Demo dataset      | 4 tenants · 28 locations · 33 cameras · 13 operators · 13 rules · 126 events · 18 incidents · 12 evidence |
| Demo Mode         | `infra/docker/demo.sh reset` — one command, ~2 min                                                        |
| Operator workflow | **6 clicks · 21.7 s** — queue to bookmarked evidence                                                      |
| Screens reviewed  | 11 pages × 5 viewports (1920 → 390)                                                                       |
| Defects found     | **7**, all fixed and re-verified                                                                          |
| Final audit       | **0 high · 0 medium · 0 low**                                                                             |
| Gate              | tests · typecheck · lint · contracts · imports · format                                                   |

Contents: [PRODUCTION_READINESS_MATRIX.md](PRODUCTION_READINESS_MATRIX.md) ·
[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) · [CCTV_READINESS.md](CCTV_READINESS.md) ·
[CUSTOMER_ACCEPTANCE_CHECKLIST.md](CUSTOMER_ACCEPTANCE_CHECKLIST.md) ·
[UI_REVIEW.md](UI_REVIEW.md) · [`screens/`](screens/)
Guides: [Demo](../../demo/DEMO_GUIDE.md) · [Dataset](../../demo/DEMO_DATASET.md) ·
[Operator](../../runbooks/OPERATOR_GUIDE.md) · [Administrator](../../runbooks/ADMINISTRATOR_GUIDE.md) ·
[Branding](../../runbooks/BRANDING.md) · [Pilot](../../runbooks/PILOT_INSTALLATION_CHECKLIST.md)

---

## The headline

**Realistic data was the instrument.** Every defect below was invisible against the single-camera
development seed, and none of them was a logic error — they were the difference between software
that works and a product someone would pay for.

The clearest example: the incident queue and the dashboard rendered **raw database ids** in the
column headed CAMERA. `cam_retail_electronics2`, where a security manager expects "Electronics —
High Value Cabinet". It had been that way for five milestones, and it was invisible because the only
seeded camera was `cam_dev_1` — an id short enough to read like a name.

That is the same lesson as P-5.8's, moved one level up. P-5.8: a test suite describes the
environment it ran in. P-5.9: **a UI review describes the data it was run against.**

---

## The seven defects

### 1. Raw camera ids where names belong — _high, commercial_

Dashboard and incident queue showed `cam_retail_electronics2`. In `ActiveIncidentsPanel` the prop was
literally named `cameraName` and handed a `cameraId`.
**Fix:** `useCameraName()` — a display-layer resolver, falling back to the id for a decommissioned
camera. Deliberately **not** a contract change: an incident stores `cameraId` because an id is stable
and a name is editable; denormalising the name would freeze whatever the camera was called that day.

### 2. Panel titles clipped mid-word on a tablet — _high, commercial_

At 1024×768 — the standard control-room iPad — queue titles read "Suspected concealment — Elec",
hard-clipped with **no ellipsis**. Clipping mid-word reads as a rendering fault.
**First diagnosis was wrong.** I fixed a missing `min-w-0` on the flex row; the screenshot showed no
change. The real cause was `sizeStyle()` applying an **inline pixel width** from the persisted panel
layout, which knows nothing about the viewport it lands in — a 320 px panel inside a 256 px region.
**Fix:** panel sizes are a preference, not a promise — `maxWidth: 100%` alongside the stored width.

### 3. Nine panels hidden with 280 px of empty space — _medium_

The laptop tier capped panels at 8; the eight rendered used 430 px of 712 available while the footer
reported nine hidden.
**Fix:** capacity 8 → 10, tuned against the measurement rather than raised until it looked full. Still
a cap, and the footer still discloses the count.

### 4–6. Accessibility conformance — _medium_

- 16 px disclosure chevrons on Locations and 18 px panel-collapse buttons: below WCAG 2.5.8's 24 px
  minimum. **Fixed** with 24 px hit areas around unchanged glyphs.
- Workspace status chips at 22 px, location rows at 20 px, rule links at 16 px. **Fixed** with
  `min-h-6`. The rule links are block links in a table cell, not the "inline in a sentence" case
  WCAG exempts.
- `CardTitle` rendered `h3` under a page `h1`, so a screen reader's heading list skipped a level.
  **Fixed** to `h2`; the visual size comes from the class, so nothing moved.

### 7. Branding required a rebuild — _high, commercial_

The product name was hard-coded in three files, there was **no favicon at all**, and no runtime
configuration mechanism existed. Every white-label change meant rebuilding the image.
**Fix:** `branding.json`, fetched before first render. Name, tagline, logo, favicon, accent colour
and login footer. Verified by copying a file into the **running container** — no rebuild, no restart:
tab title, favicon, orange accent, login heading, footer and sidebar all changed.

> ⚠️ **My first attempt at this reported success while nothing changed.** It set an invented
> `--brand` custom property; the real tokens are `--color-brand` and `--color-primary`, so every
> button stayed blue while the log said "themed". Caught by looking at the screenshot instead of the
> return value.
>
> The corrected version also **checks contrast**: `theme.css` deliberately makes primary darker than
> brand so white labels clear WCAG AA, and a customer colour carries no such guarantee. The
> foreground now flips to near-black when white would fail, and a colour that cannot reach 4.5:1
> either way is refused with a warning rather than shipping unreadable buttons. `#e8590c` renders
> with black text, correctly.

---

## What was measured

**Operator workflow — 6 clicks, 21.7 seconds**, sign-in to bookmarked evidence:

|                                       | clicks | at     |
| ------------------------------------- | ------ | ------ |
| signed in                             | 0      | 5.9 s  |
| incident queue                        | 1      | 8.1 s  |
| incident opened                       | 2      | 10.0 s |
| investigation open                    | 3      | 13.5 s |
| evidence playing (1280×720, no error) | 4      | 18.6 s |
| timeline scrubbed                     | 5      | 19.8 s |
| bookmarked                            | 6      | 21.7 s |

**Responsive** — 11 pages × 5 viewports, 1920 / 1440 / 1024 / 768 / 390:
**zero horizontal overflow** at any combination.

**Accessibility** — after fixes: 0 controls without an accessible name, 0 targets below 24 px, 0
skipped heading levels, and **every tab stop shows a visible focus indicator**.

**White-label** — proven with no rebuild, contrast-checked.

**Demo Mode** — `demo.sh reset` in ~2 minutes, scoped to `tnt_demo_*` so it is safe on a deployment
holding real data.

---

## Deliberate non-changes

Things I looked at and left alone, with the reason:

- **Tenant typed at login.** Friction, and the first thing a customer sees — but deriving the tenant
  from a hostname or remembering the last one is a product decision about multi-tenancy, not polish.
  Recorded as TD-40.
- **Dark theme only.** A deliberate choice for a SOC product. A light palette is a design exercise
  that has never been done; inventing one during a certification pass would ship an unreviewed theme.
  TD-43.
- **Zod's CSP violation.** Adding `'unsafe-eval'` would trade a real security boundary for a quieter
  console. Refused. TD-37.
- **No new UI framework.** Tailwind only, as instructed. No Bootstrap, no Material UI, no component
  library added.

---

## Go / No-Go

### ✅ GO — customer demonstrations

Unconditional. Four scripted verticals, one-command reset, no developer tools, and the product looks
and reads like a commercial SaaS application at every width reviewed.

### ✅ GO — single-host customer pilot, with two conditions

1. The [Pilot Installation Checklist](../../runbooks/PILOT_INSTALLATION_CHECKLIST.md) is followed,
   including the restore test — not just the backup.
2. [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) is **read with the customer**, not merely sent, and
   §9 of the acceptance checklist is signed.

Budget 1–2 hours for camera validation and expect surprises: it is the first time the platform meets
those models.

### ❌ NO-GO — production installation sold on camera compatibility

**No camera has ever been connected.** Camera onboarding, ONVIF discovery, staged probing and
recording playback are all implemented and none has met a vendor device. Selling a production
installation on that basis would be a claim with no evidence behind it.

The path is [CCTV_READINESS.md](CCTV_READINESS.md): roughly two engineer-weeks and one camera per
vendor family. **Every defect in P-5.8 and P-5.9 was found by running the thing for real. This one
will only be found by connecting a camera.**

### Recommended sequence

1. **Demo now.** It is ready.
2. **Pilot with a friendly customer**, using their cameras, running CCTV Phases 1–2 as part of it.
3. **Then** Demo Readiness v1 — dashboards, reports, branding polish — informed by what the pilot
   found.

Doing (3) before (2) builds reporting features on top of an unvalidated ingestion path.

---

## Architecture

Unchanged. No new service, no new abstraction, no contract change, no ADR required. Every fix was a
display-layer change, a CSS constraint, a tuning constant, or a runtime configuration file.

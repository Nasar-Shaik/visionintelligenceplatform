# P-9 · Real Camera Validation — Implementation Plan

**Written 2026-08-07**, after P-8 Phase 7 froze. Planning only; this authorises nothing.
Builds on [CCTV_READINESS](../review/p59/CCTV_READINESS.md) (the test plan of record) and
[ADR-0023](../adr/ADR-0023-onvif-discovery-placement.md).

> ⚠️ **The research changed the shape of this milestone, and the change is the most useful thing in
> this document.** P-9 reads like "build a hardware validation system". It is not. **Almost all of it
> is already built, tested, and has never been switched on.**

---

## 0 · What the research found

| Component                                   | State                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| ONVIF stack (WS-Discovery + SOAP)           | ✅ `ai/inference/onvif.py`, 651 lines, 22 unit tests                                                    |
| `POST /discovery/onvif`                     | ✅ implemented (`server.py:592`) with HTTP tests                                                        |
| `POST /stream/validate` (staged probe)      | ✅ implemented, with HTTP tests                                                                         |
| `HttpDiscoveryProvider` / `HttpStreamProbe` | ✅ implemented in `services/camera`                                                                     |
| Certification contracts                     | ✅ frozen — bundle, summary, checks, `evidenceClass`                                                    |
| Certification procedure + CLI               | ✅ `certify_cli.py` — discovery → compatibility → capability → benchmark → soak → bundle                |
| Device registry                             | ✅ 11 targets: Hikvision · Dahua · CP Plus · UNV · Axis · DVR · NVR · ONVIF · RTSP · USB · recorded-MP4 |
| `profiles/cameras/*.json`                   | ✅ 11 files, every one `Pending Validation` / `simulated`                                               |
| Compatibility, confidence, capability-diff  | ✅ in `services/camera/src/domain/`                                                                     |
| **`CAMERA_DISCOVERY_URL` in production**    | ⛔ **NOT SET — so both are `Unavailable` in every deployment ever run**                                 |

⛔ **Both ends of ONVIF discovery and staged stream probing are built, tested, ADR'd and wired to a
port — and gated on one environment variable that no deployment has ever set.**

⚠️ **This is [L-56](KNOWN_LIMITATIONS.md) exactly.** Camera-scoped rules were enablable in the
contract and unusable in every deployment for four milestones, because nothing had tried. This is the
same shape, found the same way, and it is the reason the first task below is a configuration change
rather than a feature.

**Measured, not assumed** — `certify_cli.py --target hikvision-generic` run today produces a
well-formed bundle and refuses to certify:

```
status   : PENDING VALIDATION      evidence : simulated
checks   : 2 passed · 2 failed · 9 total
blockers : evidence class is 'simulated' — certification requires a run against physical hardware
           required check 'reconnect-recovery' was not executed
           required check 'clean-shutdown' was not executed
```

⭐ **That blocker list is the hardware requirement, measured rather than guessed.**

---

## 1 · Scope

**In:** switching on what exists, closing the gaps a real device will expose, and validating against
physical hardware. **Out:** live video transport (its own milestone, needs an ADR), any new service,
any change to a frozen contract without a verification proving an architectural issue first.

**The milestone's exit criterion is unchanged:** `CCTV_READINESS.md` stops being a plan and becomes a
**supported-hardware list**, and nothing is marked certified without hardware evidence
([CONSTRAINTS §18](CONSTRAINTS.md)).

---

## 2 · Tasks

Each is independently verifiable and independently revertible. ⏱ = daytime-safe (fast verification).

### Track 0 · Procurement — starts today, not engineering

| Task     | What                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------ |
| **P0-1** | Raise the hardware request (§4). ⚠️ **The only item on this plan not under engineering control** |

### Track A · Pre-hardware engineering — no camera required

| Task   | ⏱   | What                                                                                                                  | Verification                                                                                                                                               |
| ------ | --- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** | ⏱   | ⭐ **Set `CAMERA_DISCOVERY_URL` in the production compose** and find out what breaks                                  | `POST /cameras/discover` returns a result rather than `unavailable`; `/ready` unchanged; **a new deployment verification asserts discovery is configured** |
| **A2** | ⏱   | Staged probe against the synthetic RTSP fixture through the now-wired `HttpStreamProbe`                               | Probe reaches `first-frame`; a wrong password fails at `authentication`; an unroutable host fails at `tcp` — **each stage named**                          |
| **A3** | ⏱   | Run `certify_cli` where its dependencies exist (in the runtime container, not the host — `cv2` is absent on the host) | `--target generic-rtsp` against the fixture: `connect` and `stream-acquisition` **pass**, status stays `pending-validation`                                |
| **A4** | ⏱   | **Commit the simulated baseline bundle** as the diff target every hardware run is compared against                    | Bundle committed; a unit test asserts its status is `pending-validation` and evidence `simulated`                                                          |
| **A5** | ⏱   | **H.265 decode (TD-29)** — one real HEVC fixture, played in four browsers. ⚠️ **Needs a file, not a camera**          | Playback verification records decode result per engine; `canPlayType` claim confirmed or contradicted                                                      |
| **A6** | ⏱   | **Bundle → profile promotion**: a `hardware` bundle updates `profiles/cameras/*.json`; a `simulated` one **cannot**   | Unit test both ways. ⚠️ **The refusal test is the important one** — it is CONSTRAINTS §18 in code                                                          |
| **A7** | ⏱   | **Field kit**: one command an installer runs on site, credentials from env, writes a bundle                           | Dry-run on the fixture produces a complete bundle with no repo checkout assumptions                                                                        |
| **A8** | —   | Register certification as a **nightly** stage in the `hardware` profile (which already exists)                        | Stage registered; ⚠️ **runs overnight, never in the working day**                                                                                          |

### Track B · Hardware validation — gated on P0-1

| Task   | What                                                                     | Verification                                              |
| ------ | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| **B1** | Phase 1 — one camera onboarded, probed, capability-refreshed             | `CCTV_READINESS` §3 tests 1.1–1.5 against a real device   |
| **B2** | Phase 2 — NVR + real exported recordings, including a stop/restart gap   | Tests 2.1–2.8; playback in four browsers                  |
| **B3** | Phase 3 — repeat across five vendor families; **record every deviation** | One `CertificationBundle` per device, `hardware` evidence |
| **B4** | ⭐ **Zone geometry against a real lens** at three mounting angles        | ⚠️ Closes [L-58](KNOWN_LIMITATIONS.md)/R-031 — see §3     |
| **B5** | H.265 **from a camera**, not a file — decode end to end                  | Completes A5 with device-produced HEVC                    |

### Track C · Governance — after Track B

| Task   | What                                                                                                           |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| **C1** | `CCTV_READINESS.md` becomes a **supported-hardware list** — the §2 table gains a real right column             |
| **C2** | Close/downgrade **L-1**, **L-58**, **R-016**, **R-031**; update the capability matrix rows C-09/C-10/C-11/C-13 |
| **C3** | ADR if any device forces a contract change — additive only, and only on evidence                               |

---

## 3 · ⭐ Why B4 is not optional, and belongs to this milestone

The Phase 8 architecture review put it plainly: **all ten configuration-only capabilities and the one
shipped capability are the same polygon test**, and that polygon has only ever been validated against
synthetic normalised coordinates.

Zone membership is a point-in-polygon test on the subject's **feet** in normalised image coordinates,
with no calibration and no ground plane (L-58). On a camera looking along a room, equal areas of image
are wildly unequal areas of floor. **If perspective turns out to matter, the repair is a calibration
step the product does not have, and it lands underneath every capability rather than inside one.**

⚠️ **The soak harness made this concrete this week.** A two-percent inset on a zone polygon put the
subject's feet outside it and the dwell stage silently never evaluated — on a fixture, in a
controlled scene, with the geometry fully understood. A real lens is less forgiving than that.

**B4 is one afternoon with a camera, a tape measure and a person standing in marked positions.** It
is the cheapest measurement on this plan and the one with the widest blast radius.

---

## 4 · Hardware requirements

| Item                                                                            | Why                                                                          | Blocks   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| **1× Hikvision** IP camera (DS-2CD series)                                      | Largest installed base                                                       | B1, B4   |
| **1× Dahua** IP camera (IPC series)                                             | Second largest; CP Plus is Dahua-derived                                     | B3       |
| **1× CP Plus**                                                                  | Dominant in the target market                                                | B3       |
| **1× UNV (Uniview)**                                                            | Vendor family in the registry                                                | B3       |
| **1× Axis**                                                                     | Standards reference — deviations elsewhere are measured against it           | B3       |
| **1× NVR, ≥4 channels**, ≥72 h recording **with a deliberate stop/restart gap** | ⚠️ A DVR/NVR is a **different integration**; `generic-nvr` has never met one | B2       |
| **PoE switch + a VLAN the platform host can reach**                             | —                                                                            | all of B |
| **One HEVC video file**                                                         | ⚠️ **Needs no camera** — A5 can start immediately                            | A5       |

**Minimum to start Track B:** one camera (B1, B4). **Minimum to finish:** all five plus the NVR.
Effort once hardware is present: **~2 engineer-weeks** for B1–B5, consistent with CCTV_READINESS §4.

⚠️ **Lead time is the risk, not effort.** Every day P0-1 is not raised is a day on the critical path,
and no amount of Track A buys it back.

---

## 5 · Reusable components

**Nothing on this plan needs a new service, and almost nothing needs a new component.**

| Reused                                                      | For                                      |
| ----------------------------------------------------------- | ---------------------------------------- |
| `ai/inference/onvif.py` + `/discovery/onvif`                | A1, B1 — discovery                       |
| `/stream/validate` + `HttpStreamProbe`                      | A2, B1 — staged probing                  |
| `certify_cli.py` + `certification.py`                       | A3, A7, B1–B3 — the whole procedure      |
| `CertificationBundle` and friends (frozen contracts)        | A4, A6, B3 — the artifact                |
| `profiles/cameras/*.json` (11 rows)                         | A6, C1 — the output                      |
| `compatibility.ts` · `confidence.ts` · `capability-diff.ts` | B1 — scoring and firmware-change diffing |
| `probe-archive.ts`                                          | B1 — probe history                       |
| `hardware` nightly profile                                  | A8 — already exists, unused              |
| `platform-soak.mjs` + profiles                              | Post-B: a soak on **real** cameras       |

**New, and small:** a deployment verification for A1; a promotion function for A6; an installer
wrapper for A7; one HEVC fixture for A5.

---

## 6 · Dependencies

```
P0-1 procurement ─────────────────────────────(lead time)────────────────▶ B1 ─▶ B2 ─▶ B3 ─▶ C1 ─▶ C2
                                                                            │      │
A1 wire CAMERA_DISCOVERY_URL ─┬─▶ A2 staged probe ──────────────────────────┘      │
                              └─▶ A3 certify in-container ─▶ A4 baseline bundle ───┤
                                                             └─▶ A6 promotion ─────┤
                                                             └─▶ A7 field kit ─────┘
                                                             └─▶ A8 nightly stage
A5 H.265 fixture (independent) ────────────────────────────────────────────▶ B5
B1 ─▶ B4 zone geometry vs lens ────────────────────────────────────────────▶ C2
```

**Critical path:** `P0-1 → B1 → B2 → B3 → C1`. Everything in Track A is off it and should be finished
before hardware lands, so hardware time is spent measuring rather than improvising.

⚠️ **A1 gates A2 and A3**, and A1 is one environment variable. It is also the task most likely to
surface a surprise, which is exactly why it is first.

---

## 7 · Recommended implementation order

| #   | Task                  | Why here                                                                                                  |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | **P0-1**              | ⭐ Lead time is the only thing that cannot be compressed. Raise it before writing any code                |
| 2   | **A1**                | ⭐ One env var, and it switches on two capabilities no deployment has ever run. Highest surprise-per-hour |
| 3   | **A2**                | Proves the probe stages are honest before a real device is there to blame                                 |
| 4   | **A3**                | The harness must run somewhere its dependencies exist before it can run on site                           |
| 5   | **A5**                | Independent of everything; needs only a file. Good parallel work                                          |
| 6   | **A4**                | The baseline a hardware run diffs against — worthless if written after the first hardware run             |
| 7   | **A6**                | ⚠️ The refusal test must exist **before** the first hardware bundle, or promotion is unguarded            |
| 8   | **A7**, **A8**        | Field kit and nightly registration; A8 registers only, runs overnight                                     |
| 9   | **B1 → B4 → B2 → B3** | ⭐ B4 immediately after B1: it needs one camera and invalidates the most if it fails                      |
| 10  | **C1 → C2 → C3**      | Governance last, on evidence                                                                              |

⭐ **B4 before B2** is a deliberate reordering of CCTV_READINESS §3. The existing plan does recordings
second; this plan does zone geometry second, because zone geometry is what every shipped and planned
capability rests on and recordings are not.

---

## 8 · Daytime execution policy

**Track A is entirely daytime-safe.** Every verification is seconds to a couple of minutes: a
discovery call, a staged probe, a certification against a fixture, four browser playbacks, unit tests.

⚠️ **What is explicitly deferred to overnight:** the certification **soak** stage (`SoakReport` in the
bundle), the `hardware` nightly profile, any capacity ladder against real devices, and the platform
soak on real cameras. A8 **registers** the stage; it does not run it.

⚠️ **And one rule specific to this milestone:** a certification run against physical hardware is
**not** a daytime background task either — it needs an engineer watching the device, and a bundle
produced by an unattended run nobody observed is a bundle nobody can defend.

---

## 9 · Risks

| Risk                                                                                           | Mitigation                                                            |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| ⛔ **Hardware does not arrive** — the whole of Track B stalls                                  | Track A has ~8 tasks of real value and no hardware dependency         |
| ⚠️ **A1 turns out to break something** in a deployment that has never had discovery configured | It is one variable and trivially revertible; finding out is the point |
| ⚠️ **A device forces a contract change**                                                       | Additive only, on evidence, with an ADR (C3). Never speculatively     |
| ⚠️ **Perspective turns out to matter** (B4 fails)                                              | ⭐ Found in one afternoon rather than after six capability packs      |
| ⚠️ **Credentials on a customer site**                                                          | `certify_cli` already reads env, never argv — argv is world-readable  |
| ⚠️ **A bundle gets promoted from simulated evidence**                                          | A6's refusal test, written before the first hardware run              |

---

## 10 · What needs a decision

**Only one, and it is not architectural:** ⭐ **approve the hardware purchase (P0-1)**, or tell me the
budget/timeline so the plan can be re-cut around what is actually obtainable.

Everything else is decided. ADR-0023 already placed ONVIF discovery; the certification contracts are
frozen; the device registry exists; no new service is required and none is proposed.

⚠️ **If hardware cannot be obtained this quarter**, say so and I will re-cut this as Track A only — a
milestone that switches on discovery, probing and certification against synthetic sources and states
plainly that it has certified nothing. That is a smaller, honest milestone, and it is much better
than a P-9 that quietly slips.

# Real CCTV readiness — hardware validation plan

## Status: unverified, and this is the plan to change that

**No CCTV camera and no NVR has been connected to this platform at any point.** Not in P-5.5, not in
P-5.6, not in P-5.7, not in P-5.8, not here. That is stated first because everything below is a
_plan_, and a plan read as a result is worse than no document.

Previous milestone record: [P-5.8 CCTV_VALIDATION](../p58/CCTV_VALIDATION.md). Tracked as **TD-27**
(no hardware) and **TD-28** (no browser plays RTSP).

---

## 1 · What the platform supports today, by evidence

The table separates what is **implemented and exercised**, what is **implemented but never met real
hardware**, and what is **not built**. The middle column is the one that matters commercially — it is
where a pilot will find surprises.

### Recorded playback (the investigation path)

| Capability                    | Status                                           | Evidence                                                                                                                          |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| H.264 (`avc1`) in MP4         | ✅ **Verified**                                  | Decodes and plays in Chromium, Firefox and WebKit against the production deployment                                               |
| H.265 (`hvc1`) in MP4         | ✅ **Verified, with a documented browser split** | Open-source Chromium refuses it; the console explains why and offers the original. Branded Chrome/Edge/Safari carry HEVC licences |
| Seeking in a 1-hour recording | ✅ Verified                                      | Range requests against a signed URL, across the proxy                                                                             |
| Recording gaps                | ⚙️ Implemented, **never met a real gap**         | The gap model has only ever seen synthetic gaps                                                                                   |
| Variable bitrate              | ⚙️ Implemented, **unverified**                   | Test clips are CBR-ish; real cameras vary with scene activity                                                                     |
| Camera clock drift / DST      | ⚙️ Implemented, **unverified**                   | Timeline correctness depends on camera timestamps no camera has supplied                                                          |
| Corrupted / truncated clips   | ⚙️ Partially verified                            | Verified against _deliberately_ damaged files; a real power-loss-mid-write has different structure                                |

### Camera onboarding

| Capability                                                                        | Status                                        |
| --------------------------------------------------------------------------------- | --------------------------------------------- |
| RTSP camera registration + credential encryption at rest                          | ⚙️ Implemented, unverified against hardware   |
| ONVIF discovery                                                                   | ⚙️ Implemented, **nothing has ever answered** |
| Staged connectivity probe (`dns → tcp → auth → rtsp → first-frame → codec → fps`) | ⚙️ Implemented, unverified against hardware   |
| Capability/profile diffing across firmware                                        | ⚙️ Implemented, unverified                    |

### Not built

|                                   |                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Live streaming in the browser** | No browser plays RTSP natively. Needs a transcode path (WebRTC or LL-HLS) that does not exist. **TD-28** |
| NVR proprietary export formats    | Not attempted                                                                                            |
| PTZ control                       | Contract exists; no control path built                                                                   |
| Two-way audio                     | Not in scope                                                                                             |

---

## 2 · Explicit vendor position

**No vendor is "supported" today**, because support is a claim about tested behaviour and nothing has
been tested. What can be said honestly:

| Vendor                  | Expected to work, because                           | Actually verified |
| ----------------------- | --------------------------------------------------- | ----------------- |
| Hikvision               | Standard RTSP + ONVIF Profile S; H.264/H.265 in MP4 | ❌ Nothing        |
| Dahua                   | Same                                                | ❌ Nothing        |
| CP Plus                 | Same (Dahua-derived firmware in most models)        | ❌ Nothing        |
| UNV (Uniview)           | Same                                                | ❌ Nothing        |
| Axis                    | Standard RTSP + ONVIF; strong standards conformance | ❌ Nothing        |
| Generic ONVIF Profile S | The discovery path targets it                       | ❌ Nothing        |

> ⚠️ **Do not turn this table into a "supported cameras" datasheet.** The left column is an
> expectation derived from the standards each vendor claims to implement. Vendors deviate — that is
> the entire reason hardware validation exists.

---

## 3 · The validation plan

### Phase 1 — one camera, one day

**Goal:** find out whether a real camera can be onboarded at all.

Equipment: one Hikvision or Dahua IP camera, PoE switch, a laptop on the same VLAN.

| #   | Test                                                  | Pass condition                                     |
| --- | ----------------------------------------------------- | -------------------------------------------------- |
| 1.1 | ONVIF discovery finds the device                      | Appears in Discovery with make/model/serial        |
| 1.2 | Register with credentials                             | Stored encrypted; probe reaches `first-frame`      |
| 1.3 | Staged probe reports honestly on a **wrong password** | Fails at `authentication`, not at `tcp`            |
| 1.4 | Staged probe on an **unplugged** camera               | Fails at `tcp` or `dns`, with the stage named      |
| 1.5 | Capability refresh after a firmware change            | Profile diff classified `minor`/`major`/`security` |

**Exit:** a real camera in the registry with a real probe history. Everything after this depends on
it.

### Phase 2 — recordings, two days

**Goal:** the investigation path against real footage.

Equipment: Phase 1 plus an NVR (Hikvision or Dahua) with ≥72 hours of continuous recording including
**at least one deliberate stop/restart gap**.

| #   | Test                                                | Pass condition                                      |
| --- | --------------------------------------------------- | --------------------------------------------------- |
| 2.1 | Export a 1-hour recording from the NVR; register it | Registers; hash computed; custody opens             |
| 2.2 | Play it in Chrome, Edge, Firefox, Safari            | Decodes, or fails with the honest codec message     |
| 2.3 | Seek across the recording                           | Accurate within one GOP                             |
| 2.4 | Play an 8–24 hour export                            | Timeline usable; memory stable                      |
| 2.5 | **Seek across a real recording gap**                | Gap rendered; playhead behaves; no silent skip      |
| 2.6 | Night-vision / IR segment                           | Plays; no assumption about resolution or frame rate |
| 2.7 | Variable-bitrate segment                            | Seeking stays accurate                              |
| 2.8 | Compare camera timestamp with platform time         | Drift measured and recorded                         |

**Exit:** a written statement of which vendor/codec/container combinations play, in which browsers.
That statement is the "supported cameras" table this document currently cannot write.

### Phase 3 — multi-vendor, one week

Repeat Phase 1 + 2 across Hikvision, Dahua, CP Plus, UNV and Axis. **Record every deviation.** The
value is entirely in the differences.

### Phase 4 — live streaming (a separate milestone)

Live view needs a transcode path; it is not a validation exercise but a build. Sketch only:

- RTSP → WebRTC (sub-second, per-stream cost) **or** RTSP → LL-HLS (2–5 s, cheaper, cacheable).
- Either introduces a media-transcoding component. **That is a new service and therefore an ADR and
  an architecture decision**, which is why it is not being smuggled in here.

---

## 4 · What is needed to start

1. One camera per vendor family — Hikvision, Dahua, CP Plus, UNV, Axis.
2. One NVR with a few days of recordings including a stop/restart gap.
3. A PoE switch and a VLAN the platform host can reach.
4. Roughly two engineer-weeks for Phases 1–3.

**None of this is a software problem.** Every defect found in P-5.8 was found by deploying the
platform and using it; this one will only be found by connecting a camera.

---

## 5 · Recommendation

**Do not sell a production installation against unvalidated hardware.** A pilot is defensible —
the platform is deployable, recoverable and demonstrable, and a pilot is exactly the setting in
which to run Phases 1–2 with the customer's own cameras.

Suggested framing for a customer conversation:

> "The platform is production-ready as a deployment: it installs, backs up, restores, and every
> screen works. What we have not done is connect your cameras — and we would rather do that with you,
> in a pilot, than tell you it will work and find out together on go-live day."

That is both true and stronger than a claim we cannot support.

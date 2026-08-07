# Field installation guide

**For the engineer standing at the camera.** Written 2026-08-07 (P-9 Track A).

> ⚠️ **What is measured here and what is convention.** Everything in §1–§4 about _the platform_ was
> measured this week and is linked to the verification that measured it. Everything about **mounting
> height, angle and lens choice is industry convention**, because no camera has been mounted yet —
> [L-1](KNOWN_LIMITATIONS.md) stands until Track B. The two are kept visibly apart so nobody reads a
> recommendation as a result.

---

## 1 · Before you leave the office

| #   | Check                                                           | Why                                                                          |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | The cameras are on **the same subnet** as the platform host     | ⛔ ONVIF discovery is WS-Discovery **multicast**. It does not cross a router |
| 2   | Every camera has a **reserved DHCP lease** or a static address  | ⭐ Measured: a camera left on an address that moves fails at `tcp` (§5, S6)  |
| 3   | Cameras are set to write **`hvc1`**, not `hev1`, if using H.265 | ⭐ Measured: Safari/WebKit cannot decode `hev1` (§4)                         |
| 4   | Credentials are in a password manager, not on the work order    | They go into `VIP_CAMERA_USERNAME` / `VIP_CAMERA_PASSWORD`, never into argv  |
| 5   | NTP is reachable by the cameras                                 | Timeline correctness depends on camera clocks nobody has checked             |

---

## 2 · Mounting

⚠️ **Convention, not measurement.** These are the starting points a CCTV installer would use; the
numbers move once [B4](P9_IMPLEMENTATION_PLAN.md) measures zone geometry against a real lens.

### Height

| Placement              | Height        | Why                                                                          |
| ---------------------- | ------------- | ---------------------------------------------------------------------------- |
| **Indoor, general**    | **2.7–3.0 m** | Above reach, below the point where faces become foreshortened                |
| Indoor, identification | 2.2–2.5 m     | Lower gives usable faces; accept that it is reachable                        |
| Outdoor, general       | 3.0–4.0 m     | Above vehicle roofs and casual interference                                  |
| Outdoor, perimeter     | 4.0–6.0 m     | Wider coverage; ⚠️ identification is lost at this height                     |
| ⛔ **Above 6 m**       | avoid         | People become top-down blobs. Detection degrades and re-identification fails |

### Angle

⭐ **Tilt 10–20° below horizontal is the working range for this platform, and the reason is specific
to how zones work.** Zone membership is a point-in-polygon test on the subject's **feet** in
normalised image coordinates, with no calibration and no ground plane
([L-58](KNOWN_LIMITATIONS.md)).

| Tilt       | Consequence                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------- |
| **10–20°** | ⭐ Recommended. Feet stay in frame across the useful depth, so zone tests behave               |
| 25–40°     | Acceptable for counting and presence. ⚠️ Perspective compresses distance badly                 |
| Near 0°    | ⛔ Feet leave the bottom of the frame at close range — **the subject stops being in any zone** |
| Beyond 45° | ⛔ Near top-down. Person detection was not trained for it                                      |

⚠️ **The near-0° failure is silent, and it has already been observed on a fixture.** During the P-8.7
soak a two-percent inset on a zone polygon put the subject's feet outside it, the dwell stage never
evaluated, and nothing errored — the signature was `dwellStateEntries: 0`. On a real lens, a camera
mounted flat produces the same nothing. **If a zone never triggers, check the tilt before checking
the rule.**

### Distance

| Purpose                          | Subject distance | Note                                                |
| -------------------------------- | ---------------- | --------------------------------------------------- |
| Detection ("someone is there")   | up to ~25 m      | The platform's shipped capability                   |
| Tracking / dwell                 | 3–15 m           | ⭐ Identity across occlusion needs pixels on target |
| Identification (a human decides) | 2–6 m            | ⚠️ The platform does no face recognition            |

⚠️ **Do not mount a single camera to do all three.** A camera at 20 m detecting a person is doing its
job; the same camera cannot support a dwell rule that needs the same identity for 60 seconds.

---

## 3 · Lens and lighting

### Lens

| Scene                 | Focal length | Horizontal field                                                                                          |
| --------------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| Corridor, doorway     | 6–8 mm       | ~40–55°                                                                                                   |
| Retail aisle, office  | 4–6 mm       | ~55–80°                                                                                                   |
| Open floor, forecourt | 2.8–4 mm     | ~80–110°                                                                                                  |
| ⛔ Fisheye / 360°     | —            | **Not supported.** The platform has no dewarp step; a fisheye's geometry breaks the polygon test entirely |

### Lighting

| Condition                    | What to do                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------- |
| ⭐ **Backlight** (a window)  | **The hardest case there is.** Re-aim, or fit the camera with WDR and enable it |
| Low light                    | IR illumination. ⚠️ The image goes monochrome — a different scene to the model  |
| **IR cut-filter switching**  | ⚠️ Happens nightly. Expect a detection dip across the transition                |
| Direct sun into the lens     | Re-aim. No setting fixes it                                                     |
| Flicker (fluorescent, 50 Hz) | Set the camera's anti-flicker/shutter to match mains frequency                  |

⚠️ **Nothing in this section has been measured by this platform.** The Golden Camera Dataset
([spec](GOLDEN_CAMERA_DATASET.md)) exists to turn these into measurements, and its `backlight` and
`lighting changes` scenarios are exactly this list.

---

## 4 · Camera settings that the platform actually cares about

| Setting                      | Value                           | Why                                                                         |
| ---------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| **RTSP transport**           | **TCP**                         | UDP loses packets on congested or wireless links and the loss is invisible  |
| **Codec tag**                | ⭐ **`hvc1`** if H.265          | ⛔ **Measured**: WebKit/Safari cannot decode `hev1` — an iPad shows nothing |
| Analysis stream              | **sub-stream**, ~720p, 5–15 fps | The platform analyses the sub-stream and records the main one               |
| Recording stream             | main, camera's native rate      | Evidence quality is a recording concern, not a perception one               |
| Audio                        | off, unless required            | Not analysed; it is only storage and privacy exposure                       |
| Camera-side motion detection | off                             | The platform does its own; two triggers means two answers                   |
| Timestamp overlay            | off in the analysis stream      | Burned-in text is something a detector can be wrong about                   |
| ONVIF                        | **enabled**                     | Otherwise discovery finds nothing and every camera is added by hand         |

---

## 5 · PoE vs WiFi

|                  | **PoE — recommended**       | **WiFi**                            |
| ---------------- | --------------------------- | ----------------------------------- |
| Power            | One cable                   | Separate supply at the camera       |
| Reliability      | ⭐ Deterministic            | Contended, and it degrades silently |
| ⭐ Certification | **Possible**                | ⛔ **Not possible** — see below     |
| Reboot           | Remote, via the switch port | Someone visits the camera           |

⛔ **A WiFi camera cannot be certified by this platform**, and the reason is mechanical rather than
philosophical. Certification requires `reconnect-recovery`: a **deliberate, repeatable** link
interruption at a known moment. On PoE that is one switch port toggled from a web UI. On WiFi there
is no equivalent — and a check produced by walking over and unplugging something cannot be re-run to
confirm a fix. See [P9_HARDWARE_PROCUREMENT](P9_HARDWARE_PROCUREMENT.md) §2, item 7.

⚠️ WiFi cameras still **work**. They are onboarded, probed and analysed normally. They just cannot
carry a certified row in the compatibility matrix.

### Topology

```
  RECOMMENDED — one L2 segment, discovery works
    [cameras] ──PoE── [managed PoE switch] ──trunk── [platform host]
                        │  per-port power = reconnect-recovery
                        └─ camera VLAN, reserved DHCP leases

  WORKS, DISCOVERY DOES NOT — routed
    [cameras] ── [switch] ── [router] ── [platform host]
       ⛔ multicast stops at the router. Add cameras by address; ONVIF discovery finds nothing.
       ⚠️ Report discovery as UNTESTED here, never as failing.

  NOT SUPPORTED
    [fisheye/360 camera]        no dewarp step exists
    [camera behind NAT]         the platform must reach the camera, not the reverse
```

---

## 6 · On site, in order

1. **Cable and power.** Confirm each camera's link light before touching software.
2. **Addresses.** Reserve a DHCP lease per camera. ⚠️ Record the MAC — it is what survives.
3. **Camera settings.** §4, on every camera, before onboarding. Cheaper now than after.
4. **Run the toolkit.**
   ```
   python installer_cli.py --site "<customer>" --engineer "<you>" \
       --camera rtsp://<address>:554/<path> --output ./report-<camera>
   ```
   It runs network diagnostics, ONVIF discovery and negotiation, the staged probe, latency, frame
   delivery and a snapshot, and writes `INSTALLATION_REPORT.md`.
5. **⭐ Look at the snapshot.** Every check can pass on a camera aimed at a ceiling. Nothing in the
   toolkit will notice; you will.
6. **Onboard** in the console, by **hostname or reserved address**.
7. **Draw zones**, then stand in them. ⚠️ Watch that your **feet** are inside the polygon on screen —
   that is what the rule tests, not your head.
8. **Trigger one rule deliberately** and confirm the incident appears.

---

## 7 · Common mistakes

| ⛔ Mistake                                | What it looks like                       | Fix                                |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------- |
| Camera on a different subnet              | "Discovery finds nothing"                | Same L2 segment, or add by address |
| ⭐ Mounted flat (0° tilt)                 | Zones never trigger. **No error at all** | Tilt 10–20° down                   |
| Zone drawn around bodies, not feet        | Rule fires rarely and unpredictably      | Extend the polygon to the floor    |
| Camera left on DHCP without a reservation | Works for weeks, then `tcp-failure`      | Reserve the lease                  |
| H.265 left on `hev1`                      | Safari/iPad show nothing; Chrome is fine | Set `hvc1`                         |
| Analysing the main stream                 | High CPU, few cameras per box            | Analyse the sub-stream             |
| Camera motion detection left on           | Duplicate and disagreeing events         | Turn it off at the camera          |
| One camera asked to do detection _and_ ID | Neither is good                          | Two cameras, two purposes          |
| Fisheye fitted                            | Detections in impossible places          | ⛔ Not supported                   |
| Credentials typed into a command          | They enter shell history                 | Environment variables              |

---

## 8 · Deployment checklist

- [ ] Every camera powered, linked, and on a reserved address
- [ ] ONVIF enabled; RTSP transport TCP; `hvc1` if H.265; camera motion detection off
- [ ] Sub-stream configured for analysis (~720p, 5–15 fps)
- [ ] `installer_cli.py` run per camera; report and snapshot filed
- [ ] ⭐ Every snapshot reviewed by a person — framing, focus, obstruction
- [ ] Cameras onboarded by hostname or reserved address, never a casual IP
- [ ] Zones drawn to the floor and walked through
- [ ] One rule triggered deliberately, one incident confirmed
- [ ] Recording confirmed, and one clip played back in the customer's own browser
- [ ] ⚠️ If any camera is H.265, played back in **Safari** too

---

## 9 · Customer acceptance checklist

⚠️ **Sign-off is a conversation about what was demonstrated, not about what was installed.** Every
line is something the customer watches happen.

- [ ] Each camera named, located, and visible in the console
- [ ] Live view demonstrated per camera — ⚠️ **state that live view is a demonstration mode**, not the
      shipping feature ([TD-28](KNOWN_LIMITATIONS.md) is open)
- [ ] A person walks into a zone; the customer sees the detection
- [ ] A rule fires; the customer sees the incident, with its evidence
- [ ] The customer plays back a recording, **in their own browser**
- [ ] Retention explained, and the figure agreed in writing
- [ ] ⭐ **The limits stated out loud** — no face recognition, no fisheye, no live video product path,
      and every camera's certification status read from the
      [compatibility matrix](CAMERA_COMPATIBILITY_MATRIX.md)
- [ ] Installation reports handed over
- [ ] ⛔ Nothing described as "certified" unless its row in the matrix says `Certified`

> ⛔ **Today every row in that matrix reads `Pending Validation`.** Until Track B runs, the honest
> statement is: _"these cameras work with the platform and we have not yet completed our formal
> hardware certification programme for this model."_

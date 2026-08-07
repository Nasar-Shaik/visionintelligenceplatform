# P-9 · Hardware procurement request (P0-1)

**Raised 2026-08-07.** Task **P0-1** of [P9_IMPLEMENTATION_PLAN](P9_IMPLEMENTATION_PLAN.md). This is
the only item on that plan not under engineering control, and lead time is the only thing on the
milestone that cannot be compressed.

> ⚠️ **What this buys is not "cameras to test with".** It is the ability to move eleven rows of
> [`ai/inference/profiles/cameras/`](../../ai/inference/profiles/cameras/) off `Pending Validation`,
> and to close [L-1](KNOWN_LIMITATIONS.md) — _no physical camera has ever been connected to this
> platform_. Every one of those rows is a claim the product currently cannot make.

---

## 1 · Why the list is what it is — the specification comes from the code

The certification procedure ([`certification.py:191`](../../ai/inference/certification.py)) requires
six checks. Two of them **cannot be produced by any amount of software**:

```
REQUIRED_CHECKS = (
    "connect", "stream-acquisition", "credential-redaction",
    "frame-accounting",
    "reconnect-recovery",   ← requires a deliberate link interruption on the physical device
    "clean-shutdown",       ← requires a full teardown observation on the physical device
)
```

Run today against the shipped simulated source, `certify_cli.py --target hikvision-generic` produces
a complete, well-formed bundle and **refuses to certify**, naming those two by name plus
`evidence class is 'simulated'`.

⭐ **That refusal is the procurement specification, measured rather than guessed.** Every line item
below exists to satisfy a named check, and nothing is on the list because it seemed useful to have.

⚠️ **The consequence for the switch line item is the one people cut first.** `reconnect-recovery`
needs the link interrupted _deliberately and repeatably_ — the same interruption, at a known moment,
observable from the platform side. Unplugging a cable by hand is neither repeatable nor timed, and a
check produced that way cannot be re-run to confirm a fix. **A managed switch with per-port PoE
control is therefore a required instrument, not an accessory.**

---

## 2 · Line items

Quantities are **one each** unless stated. Every camera must be **ONVIF Profile S** and expose
**H.264 on at least one stream profile**; the H.265 column is what makes B5 and TD-29 possible.

| #   | Item                              | Minimum specification                                                                                                | Satisfies                | Priority                        |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------- |
| 1   | **Hikvision IP camera**           | DS-2CD2xxx series · PoE · ONVIF Profile S · dual stream (main H.265 + sub H.264) · ≥2 MP                             | B1, B4, B5, TD-29        | ⭐ **P0 — unblocks Track B**    |
| 2   | **Dahua IP camera**               | IPC-HFW/HDW2xxx series · PoE · ONVIF Profile S · dual stream · ≥2 MP                                                 | B3                       | P1                              |
| 3   | **CP Plus IP camera**             | CP-UNC series · PoE · ONVIF Profile S                                                                                | B3 — dominant in market  | P1                              |
| 4   | **Uniview (UNV) IP camera**       | IPC2xxx series · PoE · ONVIF Profile S                                                                               | B3                       | P2                              |
| 5   | **Axis IP camera**                | M-line (e.g. M2036-LE) · PoE · ONVIF Profile S                                                                       | B3 — standards reference | P2                              |
| 6   | **NVR**                           | ≥4 channels · PoE ports or separate switch · ≥1 TB · **HTTP/RTSP export of recorded segments** · ONVIF where offered | B2                       | ⭐ **P0 — its own integration** |
| 7   | **Managed PoE switch**            | ≥8 ports · **per-port PoE on/off via web UI or CLI** · VLAN capable · ≥120 W budget                                  | ⭐ `reconnect-recovery`  | ⭐ **P0 — the instrument**      |
| 8   | **Cabling**                       | 6× Cat6 patch leads, mixed 1 m / 5 m                                                                                 | all of Track B           | P0                              |
| 9   | **Mounting**                      | 2× adjustable wall/ceiling mounts + tripod, **with a protractor or inclinometer**                                    | ⭐ B4 — see §4           | P1                              |
| 10  | **Tape measure + floor markers**  | 5 m tape; removable floor tape                                                                                       | ⭐ B4                    | P1                              |
| 11  | **HEVC video file**               | ⚠️ **Costs nothing and needs no camera** — see §5                                                                    | A5, TD-29                | ⭐ **Today**                    |
| 12  | **USB webcam** _(likely on hand)_ | Any UVC device · 720p+                                                                                               | A9 — see §6              | ⭐ **Today**                    |

### Minimum viable purchase

**Items 1, 6, 7, 8** — one Hikvision camera, one NVR, one managed PoE switch, cabling. That set
alone unblocks **B1, B2, B4, B5** — the first camera, recordings, ⭐ zone geometry against a real
lens, and H.265 from a device. It is the difference between a milestone that stalls and one that
delivers most of its value.

⚠️ **Do not buy cameras 2–5 without item 7.** Five cameras and no managed switch produces five
devices that can be connected and **not one that can be certified**, because `reconnect-recovery`
stays `not-executed` on every one of them. The blocker list above is explicit about this.

---

## 3 · Network requirements — the part that is not a purchase

| Requirement                                                                    | Why                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A VLAN or subnet the platform host can reach directly**                      | ⛔ ONVIF discovery is **WS-Discovery multicast**. It does **not** cross a routed boundary. A camera on another subnet is invisible to discovery by design.    |
| Static or reserved DHCP leases for each device                                 | Probe archives and capability diffs compare a device with its own past. An address that moves turns one device into several in the record.                    |
| The platform host on the same L2 segment, **or** a documented unicast fallback | The camera service can negotiate a single `endpoint` directly, which is how a routed estate is meant to work — but that path must then be the one B1 measures |
| NTP reachable by the cameras                                                   | Camera clock drift is an open unverified item in [CCTV_READINESS](../review/p59/CCTV_READINESS.md); an unsynchronised estate confounds it with a real defect  |

⚠️ **The multicast constraint is the most common way a hardware trial fails on day one**, and it
fails looking like a software defect. If the only available network is routed, say so now — B1 is
still runnable via direct-endpoint negotiation, but the _discovery_ result then has to be reported
as untested rather than as failing.

---

## 4 · ⭐ Why the tape measure is on a hardware request

[B4](P9_IMPLEMENTATION_PLAN.md#3--why-b4-is-not-optional-and-belongs-to-this-milestone) validates
zone geometry against a real lens. Zone membership is a point-in-polygon test on the subject's
**feet** in normalised image coordinates, with no calibration and no ground plane
([L-58](KNOWN_LIMITATIONS.md)) — and **every configuration-only capability on the roadmap is that
same polygon test.**

To measure whether perspective matters, the physical scene has to be known: marked floor positions,
a measured mounting height, and a recorded tilt angle. Without the protractor and the tape, B4
degrades from a measurement into an impression.

⚠️ This week the platform soak showed a **two-percent inset on a zone polygon silently disabled the
capability** — on a fixture, in a controlled scene, with the geometry fully understood. A real lens
is less forgiving than that.

---

## 5 · Two items that need no purchase order and start today

**Item 11 — an HEVC file.** ✅ **Done, and it needed no hardware.** [A5](../review/p9/h265.mjs)
closed **TD-29** on 2026-08-07: `infra/docker/fixtures/media/codec/` holds real `hvc1`, `hev1` and
H.264 clips, decoded in five engines. ⭐ **`canPlayType` told the truth in all fifteen
measurements** — no engine claimed a codec it could not decode, and none refused one it could — so
the product's codec verdicts can be trusted.

⛔ **One result became a procurement requirement.** WebKit/Safari answers `''` to `hev1` **and
genuinely cannot decode it**, while decoding `hvc1` perfectly. The two tags are otherwise
indistinguishable to any casual inspection of a file.

> ⭐ **Every camera must be configured to write `hvc1`, not `hev1`.** A camera left on `hev1`
> produces recordings no Safari or iOS user can play. The platform will correctly report them as
> undecodable and offer the download — but an investigator on an iPad sees no video, and the camera
> looks healthy in every other respect. Confirm at commissioning; it is on the field checklist.

**Item 12 — a USB webcam.** [A9](P9_IMPLEMENTATION_PLAN.md) validates the ingestion path against a
real lens today. ⛔ **It is not a substitute for ONVIF certification, and §6 records why in terms the
code will enforce.**

---

## 6 · ⛔ What a USB webcam does **not** buy — and a finding it exposed

`certification.py` maps evidence class from the **source type**:

```python
_SOURCE_EVIDENCE = { "simulated": "simulated", "file": "recorded-footage",
                     "rtsp": "hardware", "onvif": "hardware", "usb": "hardware", ... }
```

Its own comment calls it _"the single place where the platform decides 'does this count as real'"_ —
and it decides on the **transport**: _"everything that opens a live transport is `hardware` because
you cannot reach one without one existing."_ That reasoning is sound and it is exactly why a webcam
slips through.

⛔ **A USB webcam therefore yields `hardware` evidence** — which is true, and dangerously
under-specified. The webcam is genuinely physical, so the evidence class is not lying. But the
conclusion it supports is narrow to the point of being unrelated to the milestone:

| A USB webcam **does** prove                                | A USB webcam proves **nothing** about                       |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| A real lens, real optics, real noise reach the decode path | ONVIF discovery, capability negotiation, vendor SOAP quirks |
| Frame accounting holds on a non-synthetic source           | RTSP transport, TCP-vs-UDP behaviour, authentication        |
| The detector sees real-world scenes, not fixture loops     | Reconnect behaviour of an IP device on a network            |
| Zone geometry can be sanity-checked against a real scene   | NVR export formats, recording gaps, camera clock drift      |

⭐ **The finding: evidence class is a property of the source, not of the conclusion.** The registry
can record _that_ a run met hardware; it has no way to record _which kind_. A9 therefore ships with
an explicit guard — the `usb-webcam` row is `kind: "encoder"` and is barred from ever standing in
for a vendor row — and the reasoning is recorded here rather than in a commit message, because the
next person to point `certify_cli` at a laptop camera will not read the commit.

---

## 7 · Cost, timeline, and what happens if the answer is no

**Effort once hardware is present:** ~2 engineer-weeks for B1–B5, consistent with
[CCTV_READINESS §4](../review/p59/CCTV_READINESS.md). **Effort before it arrives:** Track A, ~9
tasks, already under way and not blocked by any of this.

| Outcome                                   | Consequence                                                                                                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full list approved                        | P-9 completes as planned; `CCTV_READINESS` becomes a supported-hardware list                                                                                                                       |
| ⭐ Minimum viable only (items 1, 6, 7, 8) | B1, B2, B4, B5 complete. **B3 (five vendor families) does not.** One vendor row certifies, four stay pending — an honest and much smaller support claim                                            |
| Managed switch cut                        | ⛔ **Nothing certifies at all.** `reconnect-recovery` stays `not-executed` and the bundle refuses on every device. Cameras without item 7 are a demo, not a certification                          |
| Nothing this quarter                      | ⚠️ P-9 is re-cut as **Track A only**: discovery, probing and certification are switched on and exercised against synthetic sources, and the milestone states plainly that it has certified nothing |

⚠️ **The last row is a real option and a defensible milestone.** It is much better than a P-9 that
quietly slips while waiting on a purchase order. What it must not become is a P-9 that claims
hardware support on simulated evidence — [CONSTRAINTS §18](CONSTRAINTS.md) forbids exactly that, and
[A6](P9_IMPLEMENTATION_PLAN.md) makes the code refuse it.

---

## 8 · Decision required

⭐ **Approve, reduce, or decline the list in §2** — and if reducing, say whether item 7 (the managed
switch) survives, because that single line decides whether anything can be certified at all.

Everything else in P-9 is decided: [ADR-0023](../adr/ADR-0023-onvif-discovery-placement.md) placed
ONVIF discovery, the certification contracts are frozen, and no new service is required or proposed.
</content>
</invoke>

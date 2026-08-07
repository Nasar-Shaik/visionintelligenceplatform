# Golden Camera Dataset — specification

**Written 2026-08-07** (P-9 Track A). ⚠️ **A specification, not a corpus.** Nothing has been captured.
Capture happens in Track B, against certified hardware, and this document exists so the first
capture session produces something reusable rather than something that has to be redone.

> ⛔ **What this dataset can and cannot do.** It is `recorded-footage` evidence
> ([`certification.py`](../../ai/inference/certification.py) maps `file → recorded-footage`). It can
> regression-test **the platform's perception** — detection, tracking, rules, incidents — for the
> rest of the product's life. It can **never certify a camera**: certification requires a live
> transport plus two checks only a person standing at the device can produce
> ([CONSTRAINTS §18](CONSTRAINTS.md)). A dataset recorded _from_ a certified camera does not inherit
> that camera's certification, and no code path lets it try.

---

## 1 · It reuses the dataset library that already exists

⭐ **No new format, no new loader, no new directory convention.** `ai/inference/dataset.py` already
provides `DatasetCase`, `Expectation`, `FootageReference` with sha256 verification, and
`DatasetLibrary` with per-scenario coverage reporting. Eighteen scenario categories exist under
`ai/datasets/`. Today the corpus holds **3 template cases and 0 footage**, and
`render_coverage()` prints that fact rather than hiding it.

| Reused                                     | For                                                               |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `ai/datasets/<category>/cases/<slug>.json` | Every golden case is an ordinary case. Nothing special-cases it.  |
| `FootageReference.sha256`                  | ⭐ A clip whose bytes changed voids every result derived from it  |
| `Expectation` (temporal + countable)       | Ground truth that is checkable without pixel-exact annotation     |
| `DatasetLibrary.coverage()`                | The honest scoreboard — a scenario with zero cases prints as zero |
| `evaluation.py`                            | Running a case. The golden corpus needs no runner of its own.     |

**The one addition:** a `golden` sub-namespace inside each category, plus the `capture` metadata
block in §4 that records which physical camera and which conditions produced the clip.

⚠️ **Why not a new top-level `golden/` category.** A clip of a person loitering is a loitering case.
Filing it away from the loitering cases would give the platform two places to look for the same
question, and the second one is always the one nobody runs.

---

## 2 · The two axes

A clip is described by **what happens** (scenario) and **under what conditions** it was captured.
They are independent, and conflating them is what makes a corpus unusable later: "we have 40 clips"
means nothing if all 40 are indoor daylight.

### 2.1 · Scenarios — what happens in the scene

| #   | Scenario             | The claim it supports                                        | Primary capability           |
| --- | -------------------- | ------------------------------------------------------------ | ---------------------------- |
| 1   | **walking**          | A moving subject is detected and tracked across the frame    | detection · tracking         |
| 2   | **standing**         | A stationary subject is not lost — ⚠️ the dwell prerequisite | tracking · loitering         |
| 3   | **entering**         | A subject crossing INTO a zone is attributed to it           | zones · intrusion            |
| 4   | **exiting**          | And crossing OUT is a distinct, opposite event               | zones · occupancy            |
| 5   | **two people**       | Two identities stay two, and do not swap                     | tracking identity            |
| 6   | **crowd**            | Counting degrades gracefully, and says when it is unsure     | crowd counting               |
| 7   | **occlusion**        | ⭐ An identity survives being hidden and re-emerging         | tracking identity            |
| 8   | **blur**             | Motion blur and defocus reduce confidence, not correctness   | detection confidence         |
| 9   | **lighting changes** | A light switching on is not a scene change                   | detection stability          |
| 10  | **backlight**        | ⭐ A silhouette against a window is still a person           | detection — the hardest case |
| 11  | **empty scene**      | ⛔ **The control.** Nothing must be detected.                | false-positive rate          |

⭐ **Scenario 11 is the most important one and the easiest to skip.** A detector that finds a person
in an empty room is worse than one that misses a real person, because it destroys the operator's
trust in every alert that follows. The P-8 fixture already keeps a `blank` path for exactly this
reason: the stub backend returns a fabricated detection for any bytes at all, and only an empty
scene separates a real model from a fabricating one.

### 2.2 · Conditions — when and where it was captured

| Axis         | Values                                        | Why it changes the answer                                         |
| ------------ | --------------------------------------------- | ----------------------------------------------------------------- |
| **Time**     | `morning` · `afternoon` · `evening` · `night` | Colour temperature, IR cut-filter switching, sensor gain          |
| **Place**    | `indoor` · `outdoor`                          | Dynamic range, weather, insects on the lens at night              |
| **Activity** | `motion` · `static` · `busy` · `empty`        | Bitrate varies with activity — the VBR gap in CCTV_READINESS      |
| **Optics**   | `frontlit` · `backlit` · `mixed`              | ⭐ Backlit is where detectors fail and customers photograph doors |

⚠️ **The IR cut-filter transition deserves naming.** Most cameras switch to infrared at dusk: the
image goes monochrome, the illuminator throws a hotspot, and the scene the model sees is not the
scene it was trained on. A corpus with no `evening` clip has never seen the transition, and the
transition is a nightly event in every real deployment.

---

## 3 · The minimum viable corpus

⛔ **11 scenarios × 16 condition combinations = 176 clips is not a plan, it is a wish.** The corpus
below is what one certified camera can produce in two sessions, and it is ordered so that stopping
early still leaves something usable.

| Tier      | Clips  | Content                                                                                       |
| --------- | ------ | --------------------------------------------------------------------------------------------- |
| **T1** ⭐ | **13** | All 11 scenarios, `indoor` `afternoon` `frontlit` · plus `empty` and `backlit` repeats        |
| **T2**    | +6     | `walking`, `standing`, `empty` repeated at `evening` and `night` — ⚠️ the IR transition       |
| **T3**    | +6     | `walking`, `two people`, `empty` repeated `outdoor` at `morning` and `afternoon`              |
| **T4**    | +N     | One `walking` + one `empty` per **additional certified camera** — the cross-vendor comparison |

**T1 alone is a usable regression corpus.** T4 is what makes it a _golden_ dataset: the same scene,
the same two clips, from every camera the platform supports, is the only way to tell a model
regression from a camera difference.

**Clip length:** 45–90 s. Long enough for a 60 s dwell threshold plus lead-in; short enough that a
full corpus run fits in a nightly stage.

---

## 4 · The `capture` block — what makes a clip re-shootable

Every golden case adds this to its `footage` block. ⚠️ **Without it a clip cannot be reproduced**,
and a clip that cannot be reproduced is a clip that can only ever be retired, never repaired.

```json
{
  "footage": {
    "path": "ai/datasets/loitering/footage/golden/hikvision-ds2cd-standing-indoor-afternoon-01.mp4",
    "origin": "internal-capture",
    "licence": "written consent on file — see ai/datasets/CONSENT.md",
    "sha256": "…",
    "durationSeconds": 60.0,
    "fps": 15.0,
    "resolution": "1920x1080",
    "anonymisation": "none — consenting colleagues, no members of the public in frame",
    "capture": {
      "cameraProfileId": "hikvision-generic",
      "certificationBundleId": "cert_hikvision-generic",
      "codec": "h264",
      "bitrateKbps": 2048,
      "streamProfile": "sub",
      "mountHeightM": 2.7,
      "tiltDegrees": 15,
      "subjectDistanceM": [2.0, 8.0],
      "scenario": "standing",
      "conditions": {
        "time": "afternoon",
        "place": "indoor",
        "activity": "static",
        "optics": "frontlit"
      },
      "sceneNotes": "office corridor, marked floor positions at 2/4/6/8 m"
    }
  }
}
```

⭐ **`mountHeightM` and `tiltDegrees` are load-bearing, not documentation.** They are what lets B4's
zone-geometry measurement be repeated, and what tells a future reader whether a detection failure was
the model or a camera pointed at the ceiling.

### Naming

```
<camera-profile-id>-<scenario>-<place>-<time>-<NN>.mp4
hikvision-ds2cd-backlight-indoor-morning-01.mp4
```

Case id follows the library's existing convention: `<category>/golden-<same-stem>`.

---

## 5 · Where the bytes live

⛔ **Not in git.** A 90 s 1080p clip is 15–25 MB; the T1–T4 corpus is 400 MB–1 GB and grows with
every certified camera. [KI-04](KNOWN_ISSUES.md) already records what large binaries in this
repository cost.

| Layer                | Holds                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| **Git**              | The case manifests — small JSON, including the **sha256 of each clip**                |
| **Object storage**   | The clips. MinIO is already deployed; a `vip-datasets` bucket needs no new service    |
| **`DatasetLibrary`** | Reports a clip as absent on a machine that has not fetched it — already the behaviour |

⭐ **The digest in git is the contract.** A machine without the footage reports `footage-missing` and
runs nothing; a machine whose footage has drifted reports `verify() == False` and **voids the
result** rather than producing a green tick against different bytes.

⚠️ **A fetch helper is Track B work, not now.** `ai/inference/fetch_models.py` already does exactly
this shape for model artifacts — checksum-verified download into a directory outside the repo — and
is the pattern to copy rather than a new mechanism to design.

---

## 6 · Consent and licence — the gate before the first clip

⛔ **This is CCTV footage of identifiable people, and no clip may be captured before this is
settled.** `FootageReference` refuses a case with no licence string, which is the right default and
is not by itself compliance.

| Requirement                | Position                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subjects**               | ⭐ Consenting colleagues only. **No members of the public**, in any tier.                                                                                |
| **Written consent**        | Recorded in `ai/datasets/CONSENT.md`, referenced by every case's `licence` field                                                                         |
| **Withdrawal**             | ⚠️ A subject may withdraw. The case is retired and the object deleted — so **one subject per clip** where practical, or withdrawal costs the whole scene |
| **Customer pilot footage** | ⛔ **Never** enters this corpus without a separate written agreement. `origin: customer-pilot` exists in the library and is not authorised here.         |
| **Retention**              | Indefinite for consented internal capture; that is the point of a regression corpus, and it must be what the consent form actually says                  |

---

## 7 · How it gets used, and how it does not

| Use                                                                  | Status                                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Model regression across releases — same clips, same expectations     | ⭐ The primary purpose                                                                    |
| Rule and capability validation (loitering, intrusion, occupancy, …)  | ✅ Ordinary `DatasetCase` expectations                                                    |
| Cross-vendor comparison — the same scene from five cameras           | ⭐ What T4 buys                                                                           |
| Tuning thresholds against real footage instead of synthetic fixtures | ✅                                                                                        |
| Demonstrating the product to a customer                              | ⚠️ Only with the consent basis re-checked                                                 |
| **Certifying a camera**                                              | ⛔ **Never** — see the header                                                             |
| **Claiming a capability is production-ready**                        | ⛔ Never. `recorded-footage` is not `hardware`, and the maturity model already refuses it |

---

## 8 · Acceptance criteria for the specification (Track A)

- [x] Scenarios enumerated — all 11, each with the claim it supports and its primary capability
- [x] Conditions enumerated — 4 axes, with why each changes the answer
- [x] Reuses the existing dataset library rather than inventing a format
- [x] `capture` metadata block defined, including the geometry B4 depends on
- [x] Storage and integrity settled — manifests in git, bytes in object storage, sha256 the contract
- [x] Consent position stated before any capture
- [x] ⛔ The certification boundary stated explicitly and in the header

**Not done, by design:** no footage captured, no `CONSENT.md` drafted, no fetch helper written. All
three are Track B, and two of them need a camera that does not exist yet.

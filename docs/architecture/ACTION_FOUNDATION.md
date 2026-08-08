# Action Foundation — interface design

**Design only. No action recognition is implemented, and none is authorised by this document.**

> ⭐ **An action is not a frame.** It is a statement about a *span*, and that is why
> `perception.py` has `FrameLabel` with a `span` field and no bounding box. A contract that could
> only describe rectangles in single frames would have forced the first action model to invent a
> side-channel — which is the failure this foundation exists to prevent.

---

## 1. The interface

```python
PerceptionOutput(
    task=TASK_ACTION,
    frame_labels=[FrameLabel(label="bending", confidence=0.78, span=(120, 147))],
)
```

Per-subject actions attach to the instance instead, via `attributes["action"]` (`ATTR_ACTION`), so
"this person is reaching" and "someone in this frame fell" are distinguishable. ⚠️ **They are
different claims and conflating them is a real risk**: a frame-level "fall" with no subject cannot be
routed to an incident about a person, and a per-subject fall that is reported frame-level loses the
identity the whole workflow is built on.

## 2. The vocabulary

| Tier | Actions | What they need |
| --- | --- | --- |
| **Postural** | standing · sitting · bending · lying | Pose alone, single frame |
| **Locomotor** | walking · running · falling | Pose + trajectory over a span |
| **Manipulative** | reaching · lifting · carrying · placing · picking · throwing | ⛔ Pose + **object interaction** — see §3 |

⭐ **The tiers are ordered by what they require, not by difficulty.** Postural actions are reachable
as soon as a pose model exists; manipulative ones are not reachable at all without object
interaction, and no amount of a better action model changes that.

## 3. ⛔ The dependency that decides the retail roadmap

**"Picking" and "placing" are the same skeleton.** The difference is whether an object left the hand
or entered it — that is not in the pose, and it is not in the trajectory. It requires:

1. detecting the object (a non-person class the current detector does not have), and
2. associating it with a hand across frames, and
3. knowing which side of the shelf boundary it ended on.

⚠️ This is the single most under-estimated step on the path to theft detection. A demo distinguishing
"reach toward shelf" from "reach away from shelf" is achievable with pose alone and looks like
progress; it cannot tell taking from replacing, which is the entire question.
[RETAIL_AI_ROADMAP](RETAIL_AI_ROADMAP.md) sequences this honestly.

## 4. Time, and the two clocks

An action spans frames, so it needs a window — `temporal_window.py` already exists.

⛔ **Spans are expressed in frame numbers, not timestamps**, because a frame number is unambiguous
under replay and a timestamp is not. Offline replay never moves footage time (P-9 finding), and live
capture stamps with the *service* clock. A span in wall-clock seconds means two different things
depending on which path produced it.

⚠️ **Frame rate changes the meaning of a window.** A 30-frame window is 7.5 s at 4 fps and 1 s at
30 fps. Any action model declares the frame rate it was trained for, and the registry records it —
otherwise the same model silently classifies different amounts of time on two cameras.

## 5. Where interpretation happens

Action **recognition** is perception and belongs behind a `PerceptionModule`. Action
**consequence** — "bending in the stockroom is routine, bending behind the counter is not" — is
business logic and belongs in the rule engine.

⭐ The line is already drawn by the standing guardrail (*the runtime emits `EventEnvelope` and never
creates incidents*), and it is what lets one action model serve retail, hospital and factory packs
without a fork.

## 6. Verification an action milestone must include

- **Negative controls per class**, not one overall. A model that never emits "falling" scores well on
  footage where nobody falls.
- ⛔ **Prove each class can fire before trusting a clean run.** The most likely failure is a class
  that is never emitted at all — indistinguishable from "the action did not occur".
- **Span boundaries**, not just presence: a fall detected 40 frames late is a different product.

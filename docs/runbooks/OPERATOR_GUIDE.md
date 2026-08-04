# Operator Guide

For the person watching the queue. No technical background assumed — if a step here needs one, that
is a defect in this guide.

---

## Signing in

You need three things: your **tenant**, your **email**, and your **password**. The tenant is your
organisation's identifier — your administrator gives it to you, and it is the same every time.

If you forget it, the sign-in screen cannot look it up for you. Ask your administrator.

---

## The screens

|                    | What it is for                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Dashboard**      | The shift view. Active incidents, how many cameras are online, recent alerts. Refreshes itself every 15 seconds |
| **Incidents**      | The queue. Everything raised, filterable by status and severity                                                 |
| **Investigations** | The workspace — one incident, everything about it, side by side                                                 |
| **Events**         | The raw detections. Below incidents: most events never become one                                               |
| **Cameras**        | The registry, and each camera's real health                                                                     |
| **Locations**      | Your estate — sites, buildings, zones. Cameras live inside it                                                   |
| **Alerts**         | Notifications that were sent, and whether they were acknowledged                                                |
| **Rules**          | What turns an event into an incident. Usually an administrator's screen                                         |
| **System Health**  | Whether the platform itself is well                                                                             |

---

## Working an incident

### 1 · Pick it up

**Incidents** → click the row. The detail panel shows severity, status, the camera, and when it was
raised.

**Acknowledge** it. That records that a human has seen it, and it takes it out of the unattended
count for everyone else.

### 2 · Investigate

Press **Open investigation**. This is the workspace, and it is where the real work happens.

| Panel              | What it tells you                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| **Incident queue** | The rest of the queue, so you can switch without leaving                                         |
| **Evidence**       | Recordings attached to this incident                                                             |
| **Playback**       | The player                                                                                       |
| **Timeline**       | Events, evidence and bookmarks on one time axis                                                  |
| **Details**        | Severity, status, and **Why this fired** — the rule that matched and the event that triggered it |
| **Evidence chain** | Who has accessed this evidence, when, and why                                                    |
| **Assignment**     | Who owns it                                                                                      |
| **Comments**       | Your notes. Append-only — they cannot be edited or deleted afterwards                            |

### 3 · Watch the recording

Click a clip, press play. Keyboard: **Space** play/pause, **←/→** step, **J/K/L** shuttle. Press
**?** for the full list.

**The ORIGINAL badge matters.** If you adjust brightness, contrast or zoom, the badge changes to say
so. The stored recording is never altered — adjustments are yours, for looking, and the file stays
exactly as it was recorded.

**Bookmark** anything worth returning to. Bookmarks appear on the timeline and in the evidence chain.

### 4 · Write it down

Add a comment saying what you found. Write for the next person, not for yourself — they will not
have your context.

Good: _"Checkout footage for the same window shows no corresponding transaction. Escalating to the
duty manager."_

Not useful: _"Checked, fine."_

### 5 · Close it out

| Action       | When                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **Resolve**  | You know what happened and it needs no more work. **Give the reason** — that is what stops the next person re-investigating it |
| **Escalate** | Someone else needs to take it                                                                                                  |
| **Close**    | Administratively finished. After closing, no more comments can be added                                                        |

---

## When something looks wrong

The console tells you what it does not know, rather than showing you an empty box. Learn these four
— they mean different things.

| What you see                               | What it means                                                                             | What to do                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **"This browser cannot decode this file"** | Your browser has no decoder for this format (usually H.265). The recording is fine        | Open it in Chrome, Edge or Safari, or download the original                                                    |
| **"The connection dropped"**               | The recording stopped loading. A network or storage problem, not a damaged file           | Press **Retry**. If it keeps failing, tell your administrator                                                  |
| **"This playback link expired"**           | Playback links are deliberately short-lived so evidence cannot be shared by copying a URL | Press **Resume playback**                                                                                      |
| **"This recording could not be decoded"**  | The file opened and then failed — it may be truncated or damaged                          | Download the original and check its integrity hash **before** treating it as evidence. Tell your administrator |

Other things you may see, all deliberate:

- **"not configured for this deployment"** on a panel — that service is not switched on here. Not an
  error, and not something you can fix.
- **"not built"** — that feature does not exist yet. The console says so rather than showing a blank
  panel that looks broken.
- **"No AI advisor is configured. This is not 'no recommendations' — nothing has analysed this
  incident."** Exactly what it says. Nothing looked at it; absence of a recommendation is not a
  judgement that everything is fine.
- **A camera showing offline** — the platform measured that, it did not assume it. Report it.

---

## Things worth knowing

**Your comments are permanent.** Append-only, by design. Evidence handling depends on the record
being unalterable — including yours.

**Every time you open a recording, it is recorded.** Who, when, and the reason you gave. That is
what makes it evidence rather than a video file, and it applies to you as much as anyone.

**Adjusting the picture never changes the recording.** Brightness, contrast and zoom are display
only, always marked, and never written back.

**Signing out clears this workstation.** Your session, and which incidents you had open, are removed
— so the next person on a shared terminal cannot see what you were investigating.

**On a tablet**, some panels are hidden to fit. The workspace says how many at the bottom of the
screen. Use a wider display for detailed work.

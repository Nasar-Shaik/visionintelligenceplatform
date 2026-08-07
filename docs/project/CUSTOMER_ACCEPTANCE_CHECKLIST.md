# Customer Acceptance Checklist

> **A click-by-click walkthrough of the whole product.** ~30 minutes. Every step says which page to
> open, what to do there, and exactly what you should see. Every expected result was measured on
> 2026-08-07, not predicted.

**You do not need to know anything about the platform to run this.** If a step does not match what is
on your screen, that is a finding — write it down and carry on to the next step.

**Deployment:** ☐ `https://localhost`  **Date:** ☐ ________  **Run by:** ☐ ________

---

## 🔑 Login credentials

### How to log in

1. Open **`https://localhost`** in a browser.
2. ⚠️ Accept the certificate warning. Caddy uses its own internal CA locally — TLS is real, the CA is
   simply not in your trust store. Click *Advanced → Proceed*.
3. The form asks for **three** fields. All three are required:

| Field | Type this |
| --- | --- |
| **Tenant** | `tnt_demo_retail` |
| **Email** | `security.manager@northgate.demo` |
| **Password** | `12345678` |

> ⛔ **The Tenant field trips most first-time testers.** It is not the company name and not your
> email domain — it is the tenant **id**, exactly as written above. Getting it wrong returns
> "invalid credentials", which reads like a wrong password.

### Every account

**Password for all 17 accounts: `12345678`** — verified by a real login on 2026-08-07.

#### `tnt_demo_retail` — Northgate Retail Group ⭐ *use this one for the checklist*

| Role | Email | Tenant | Password | User ID |
| --- | --- | --- | --- | --- |
| **Admin** ⭐ | `security.manager@northgate.demo` | `tnt_demo_retail` | `12345678` | `usr_demo_retail_mgr` |
| Operator | `day.operator@northgate.demo` | `tnt_demo_retail` | `12345678` | `usr_demo_retail_op1` |
| Operator | `night.operator@northgate.demo` | `tnt_demo_retail` | `12345678` | `usr_demo_retail_op2` |
| **Viewer** | `loss.prevention@northgate.demo` | `tnt_demo_retail` | `12345678` | `usr_demo_retail_loss` |

#### `tnt_demo_warehouse` — Meridian Logistics

| Role | Email | Tenant | Password | User ID |
| --- | --- | --- | --- | --- |
| Admin | `site.manager@meridian.demo` | `tnt_demo_warehouse` | `12345678` | `usr_demo_wh_mgr` |
| Operator | `gatehouse@meridian.demo` | `tnt_demo_warehouse` | `12345678` | `usr_demo_wh_guard` |
| Operator | `hse.officer@meridian.demo` | `tnt_demo_warehouse` | `12345678` | `usr_demo_wh_hse` |

#### `tnt_demo_school` — Ashford Academy Trust

| Role | Email | Tenant | Password | User ID |
| --- | --- | --- | --- | --- |
| Admin | `site.lead@ashford.demo` | `tnt_demo_school` | `12345678` | `usr_demo_sch_head` |
| Operator | `caretaker@ashford.demo` | `tnt_demo_school` | `12345678` | `usr_demo_sch_care` |
| Viewer | `reception@ashford.demo` | `tnt_demo_school` | `12345678` | `usr_demo_sch_recep` |

#### `tnt_demo_hospital` — St Aldate's Hospital

| Role | Email | Tenant | Password | User ID |
| --- | --- | --- | --- | --- |
| Admin | `security.lead@staldates.demo` | `tnt_demo_hospital` | `12345678` | `usr_demo_hosp_sec` |
| Operator | `control.room@staldates.demo` | `tnt_demo_hospital` | `12345678` | `usr_demo_hosp_ctrl` |
| Viewer | `ward.matron@staldates.demo` | `tnt_demo_hospital` | `12345678` | `usr_demo_hosp_matron` |

#### `tnt_dev` — Dev Tenant *(engineering only, no demo data)*

| Role | Email | Tenant | Password | User ID |
| --- | --- | --- | --- | --- |
| Owner | `owner@vip.dev` | `tnt_dev` | `12345678` | `usr_dev_owner` |
| Admin | `admin@vip.dev` | `tnt_dev` | `12345678` | `usr_dev_admin` |
| Operator | `operator@vip.dev` | `tnt_dev` | `12345678` | `usr_dev_operator` |
| Viewer | `viewer@vip.dev` | `tnt_dev` | `12345678` | `usr_dev_viewer` |

### What each role can do

| Role | Upload & analyse | Capture stills | Manage rules/cameras | Read |
| --- | --- | --- | --- | --- |
| **Owner** | ✅ | ✅ | ✅ + billing/users | ✅ |
| **Admin** ⭐ | ✅ | ✅ | ✅ | ✅ |
| **Operator** | ✅ | ✅ | ⚠️ partial | ✅ |
| **Viewer** | ❌ | ❌ | ❌ | ✅ |

⭐ Use **Admin** for the whole walkthrough. Use **Viewer** once, in **§10**, which proves a
read-only user is not shown controls they cannot use.

### ⛔ Read before using these anywhere else

> **`12345678` is a deliberately trivial password on entirely synthetic data.** These tenants hold
> generated fixtures and no real footage or real people. ⛔ **A real deployment must change
> `SEED_PASSWORD` in `.env.production` before first login** — the file says so at the variable
> itself — and `tools/validation/reset-demo-passwords.mjs` refuses to touch any tenant that is not
> `tnt_dev` or `tnt_demo_*` for exactly this reason.

### If a login fails

```sh
# Re-set and re-verify every demo password, then print the table above:
node tools/validation/reset-demo-passwords.mjs

# List the accounts without changing anything:
node tools/validation/reset-demo-passwords.mjs --list
```

A `✓` in that output means the account was logged into through the real endpoint, not that a
database row was written.

### Getting an API token

```sh
TOKEN=$(curl -sk -X POST https://localhost/api/identity/auth/login \
  -H 'content-type: application/json' -H 'x-tenant-id: tnt_demo_retail' \
  -d '{"email":"security.manager@northgate.demo","password":"12345678"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["accessToken"])')
```

> ⚠️ **`x-tenant-id` is needed on the login call only.** Every request afterwards takes the tenant
> from the **token**, which is why §1's cross-tenant check cannot be defeated by editing the header —
> worth demonstrating if a customer's security reviewer is in the room.
>
> ⚠️ Access tokens expire in ~15 minutes. If a `curl` starts returning 401 part-way through, re-run
> the command above rather than assuming a service failed.

---

## 🗺️ Where everything is

After you sign in you land on the **Dashboard** at `https://localhost/`. The left sidebar has five
groups. ⚠️ **This walkthrough only uses four pages** — ignore the rest:

| Page | Sidebar item | URL | What it is |
| --- | --- | --- | --- |
| ⭐ **Recorded Video** | INVESTIGATE → **Recorded Video** | `https://localhost/investigations` | ⭐ **The main page for this test.** Upload a recording and analyse it |
| Incidents | INVESTIGATE → **Incidents** | `https://localhost/incidents` | The live work queue — used in §5 to prove offline findings stay out of it |
| Cameras | MONITOR → **Cameras** | `https://localhost/cameras` | Just to confirm cameras exist |
| Camera Assignment | AI ASSIGNMENT → **Camera Assignment** | `https://localhost/assignment` | Used in §0 to confirm AI is switched on |

> ⛔ **"Recorded Video" is the one you want.** There is a separate "Incident Workspace" further down
> the sidebar — that is a *different* feature for working incidents that already exist. (Until
> 2026-08-07 both were labelled "Investigations" and it was genuinely confusing; that was finding
> **V-6** and it is fixed.)

## 📁 The video files you will need

They live in this folder on the machine running the platform:

```
/Users/mac/projects/VisionIntelligencePlatform/infra/docker/fixtures/media/validation/
```

If that folder is empty or missing, generate it (takes ~10 minutes, needs the stack running):

```sh
node tools/dataset/generate.mjs --verify
```

You will use exactly **four** of the 37 files:

| File | What is in it | What should happen |
| --- | --- | --- |
| `multiple-people.mp4` | Two people crossing, 30 s | Finds **2 people** |
| `crowd.mp4` | Eight people, 30 s | Finds **8 people** |
| `empty-scene.mp4` | ⭐ **Nobody at all**, 30 s | Finds **nothing** — and says so |
| `corrupt-not-a-video.mp4` | A text file renamed `.mp4` | **Refused**, with a reason |

---

## 0 · Before you start — is the platform actually ready?

⛔ **Do not skip this.** If AI processing is switched off, every analysis will report **success**
having looked at **zero frames**, and you will spend an hour testing nothing.

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | Open **`https://localhost/assignment`** (sidebar: AI ASSIGNMENT → **Camera Assignment**) | Page heading **"Camera assignment"** |
| ☐ | ⭐ Read the four big numbers across the top | **CAMERAS** 9 · **AI ENABLED** ≥ 1 · ⭐ **CONFIRMED RUNNING ≥ 1** · ⛔ **IN ERROR 0** |
| ☐ | Open **`https://localhost/cameras`** | 9 cameras listed, most `enabled` |

**Those four numbers are the whole check.** `CONFIRMED RUNNING` must be at least **1** and `IN ERROR`
must be **0**.

**If `CONFIRMED RUNNING` is 0, or `IN ERROR` is not 0:** find a camera row on the Assignment page
whose state is *Not assigned*, click **Enable**, and wait ~30 seconds for the numbers to move.

*(Engineers: `node tools/validation/verify-deployment.mjs` must report **31/31**, and
`curl -sk https://localhost/api/media/perception/assignment -H "authorization: Bearer $TOKEN"` must
show `plannedCameras > 0`.)*

> ⛔ This check exists because of finding **V-1**: a runtime restart used to leave every camera stuck
> and unable to recover, and analyses then reported `succeeded` at "×280 real time" having analysed
> nothing. It is fixed, but it is still the first thing to confirm.

---

## 1 · Login

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | Open `https://localhost` and accept the certificate warning | The sign-in form |
| ☐ | Tenant `tnt_demo_retail`, email `security.manager@northgate.demo`, password `12345678` → **Sign in** | The Dashboard, with the sidebar on the left |
| ☐ | Sign out (top right), then try password `wrongpassword` | Refused, no session created |
| ☐ | Sign back in as the admin | Dashboard again |

---

## 2 · Upload a recording ⭐ the main workflow starts here

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | Click **Recorded Video** in the sidebar (or go to `https://localhost/investigations`) | Page heading **"Investigations"** |
| ☐ | Look at the grey box near the top | A **Camera** dropdown, an **Upload a recording** button, and the text **"MP4 only, up to 2 GB and 4 hours"** |
| ☐ | ⛔ **Before choosing a camera**, look at the Upload button | It is **greyed out / disabled** |
| ☐ | Click the **Camera** dropdown and choose **Main Entrance** | The Upload button becomes clickable |
| ☐ | Click **Upload a recording**, navigate to the validation folder, choose **`multiple-people.mp4`** | Within ~5 s a new row appears in the table below, named `multiple-people.mp4` |

> ⚠️ **The disabled button is deliberate, not a bug.** The camera carries the detection zones and the
> rule scope, so a recording attached to the wrong camera gets judged against the wrong policy and
> produces a **confident wrong answer**. The product refuses to let you get that far.

---

## 3 · Run the analysis

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | Click the row name **`multiple-people.mp4`** | A detail page. Heading is the filename. Two buttons top-right: **Demonstrate at real time** and **Run analysis** |
| ☐ | Note the message in the middle | *"This recording has not been analysed yet"* |
| ☐ | Click **Run analysis** | A **Runs** table appears with run **#1** |
| ☐ | Watch the Runs row for ~5 s | State moves `queued` → `starting`/`running` → **`succeeded`** |

**When it finishes, the Runs row should read:**

| Column | Expected value |
| --- | --- |
| RUN | `#1` |
| STATE | **`succeeded`** |
| PROGRESS | `As fast as possible` |
| FRAMES | **`60 / 60`** |
| DETECTIONS | ~`116` |
| MODEL | `yolox-nano` |
| (speed) | ~**`6–9× real time`** |

| ☐ | Check | Expect |
| --- | --- | --- |
| ☐ | A **yellow banner** appears under the Runs table | *"the file carried no creation time, so the upload time was used as the footage start…"* |

> ⭐ **That yellow banner is a feature, not a warning to dismiss.** The platform is telling you the
> incident times in this analysis are offsets from your upload, not real clock times — because the
> MP4 carried no creation date. A product that silently guessed would misdate every incident in a
> court bundle.

---

## 3b · ⭐ Watch the recording, with the AI's boxes on it *(new in P-8.6)*

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | Look just under the page title, at **Recording** | Your video, playing in the page. A portrait phone clip gets a tall stage, not a letterboxed stripe |
| ☐ | Press ▶ and let it run | Blue outlines appear over people, labelled `person · #3` and a percentage |
| ☐ | ⭐ Read the label on a box | The number after `#` is the **track id** — the same person keeps it |
| ☐ | Watch the badge in the top-right of the video | Either `N stored at 00:06`, or **"no analysed frame at this instant"** |
| ☐ | ⚠️ Notice the boxes are not on screen the whole time | **Expected — and the line under the player says why.** Boxes exist only where the platform *kept* a detection: one per person per ten seconds. The gaps are retention, not blindness **[L-68]** |
| ☐ | Use the ⏮ ⏭ buttons instead of the scrubber | They jump between **analysed frames** — the moments that actually have something stored |
| ☐ | Toggle **Detection overlay** off, then on | Boxes disappear and come back; the video keeps playing |

> ⛔ **Say this out loud in a demo.** *"The boxes are what the system stored, not everything it saw.
> It looked at 67 frames and found 285 detections; it kept 24 of them. Showing a box between those
> would be us drawing something we did not measure."* That sentence is the difference between a
> credible product and an overclaiming one.

---

## 3c · What the run actually was *(new in P-8.6)*

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | Find the **Analysis details** panel below the Runs table | Resolution, codec, container, duration, file size, source frame rate |
| ☐ | Read **Footage started** | The time **and** how much it can be trusted — e.g. *"⚠️ read from the file's own metadata, unconfirmed"* |
| ☐ | Read the model row | `yolox-nano`, plus runtime version, pipeline version, capability and execution provider |
| ☐ | Read **Analysis frame rate** | `2 fps`, and beneath it *"2 of every 25 source frames were examined"* |
| ☐ | Read **Time remaining** on a finished run | `—` with a reason, never `0 s` |

---

## 4 · The timeline — all four lanes *(expanded in P-8.6)*

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | Scroll to **Timeline** | A row of numbers first: **Frames analysed · Detections returned · Events persisted · Tracks · Incidents** |
| ☐ | ⭐ Compare *Detections returned* with *Events persisted* | They differ a lot (e.g. 285 vs 24). That is the dedup window, and the page labels it |
| ☐ | Read the line about tracks | *"Tracks are not a headcount"* — it must be there |
| ☐ | Click the **Incidents** tab | Columns **At · Incident · Raised by · Status · From event**. "Raised by" names the **rule and version** |
| ☐ | Click the **Events** tab | Every stored event with **confidence**, **track**, and the **bounding box numbers** |
| ☐ | Find a row badged `incident` | That is the exact event that caused an incident — a recorded link, not a guess |
| ☐ | Click the **Tracks** tab, then **Show me** on any row | The video seeks to that person's first appearance and outlines **only them** |
| ☐ | Click the **Density** tab | A bar chart labelled **persisted events**, with a warning that it is *not* a detection histogram |
| ☐ | Click any `▶ 00:16` time button | The video jumps to exactly that point |
| ☐ | Look for *"Incidents could not be looked up for this run"* | ⛔ It must **NOT** be there |

---

## 5 · Incidents, and that they stay out of the live queue

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | On the Timeline, read the incident titles | Real rule names, e.g. *"Person detected — any camera: perception.person.detected"* |
| ☐ | ⚠️ Check no title names a **place or a time** your recording does not show | Renamed in V-10: the seeded rule used to be called *"After-hours presence — stock room"* and was scoped to neither. **[L-67]** the rule engine has no schedule condition, so no rule can honestly be named for one |
| ☐ | Open **`https://localhost/incidents`** (sidebar: INVESTIGATE → Incidents) | The live work queue |
| ☐ | ⛔ Look for the incidents you just saw on the Timeline | **They must NOT be here** |
| ☐ | Go back to Recorded Video → your analysis | Its incidents are still on its own Timeline |

> ⭐ **This is one of the most important checks in the document.** An incident found by replaying
> last month's footage is a real finding — and it is **not** something anybody is being dispatched to
> right now. If offline findings appeared in the live queue, an investigation would flood an
> operator's work list and they would stop trusting the queue entirely.

---

## 6 · Evidence — capture a still

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | On the Timeline, click **Capture still** on any incident row | Within ~1 s a **real photograph** appears below the table |
| ☐ | Read the caption under the image | Something like *"00:24 into the recording · 14 Feb 2026, 18:30:24"* |

> ⭐ The caption dates the picture by the **footage**, not by when you clicked. That is the difference
> between "this happened at 18:30 on 14 February" and "somebody pressed a button today".
>
> ⚠️ **Known limitation:** the still is not yet under evidence retention custody. It exists and it is
> real; formal chain-of-custody is still to come (TD-15).

---

## 6b · Export the record *(new in P-8.6)*

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | Click **Export report** at the top right | A `.json` file downloads, named for the recording **and the run** |
| ☐ | Open it | Source file, footage start **and its source**, start/finish times, all six provenance fields, counts, findings, tracks, incidents |
| ☐ | ⭐ Compare `counts.incidents` with the incidents listed inside | They must agree — a report that contradicts itself is worse than one that omits the number |

> ⭐ Named for the **run**, not the recording: two analyses of one file are two different answers and
> must never overwrite each other on disk.
>
> ⚠️ The export contains `tracks` and `incidents` but **not** the individual events. Note it if you
> need them — the Events tab and the Events explorer have them.

---

## 7 · ⭐ The honesty test — the most important step here

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | Go to **Recorded Video**, choose camera **Main Entrance**, upload **`empty-scene.mp4`** | New row appears |
| ☐ | Open it and click **Run analysis** | Finishes in ~4 s |
| ☐ | Check the Runs row | **`succeeded`**, **`60 / 60`** frames, **`0`** detections |
| ☐ | ⭐ Read the message where the Timeline would be | **"Nothing was detected in this recording"** |
| ☐ | Check the live Incidents queue again | No new incidents |

> ⭐ **Every other step asks whether the platform finds things. This one asks whether it INVENTS
> them.** A surveillance product that raises a false alarm on an empty shop has lost the customer
> permanently, and no accuracy anywhere else buys that back. It analysed all 60 frames, found
> nothing, and **said so in words** rather than showing you an empty panel you have to interpret.

---

## 8 · A crowd

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | Upload and run **`crowd.mp4`** on the same camera | `succeeded`, `60 / 60` |
| ☐ | Compare its incident count with `multiple-people.mp4` | ⭐ Noticeably **more** activity — 8 people produce ~24 events and **8 separate identities** |

> ⭐ **Worth knowing:** until 2026-08-07 this clip produced exactly the same 3 events as a single
> person walking — eight people were indistinguishable from one. Running this file and asking "why
> does that number look wrong?" is what uncovered two critical defects (**V-2**, **V-3**).

---

## 9 · Run it again — reruns must not overwrite

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | Open `multiple-people.mp4` again and click **Run analysis** a second time | A run **#2** appears |
| ☐ | Check run **#1** | ⛔ Still there, unchanged — **not** replaced |
| ☐ | Compare the two rows | Same frames, same detections |

> ⭐ Two analyses of one recording are two independent records. So when you change a rule next month
> and re-run, you can compare the new result against today's — instead of destroying it.

---

## 10 · Permissions — a viewer must not see controls they cannot use

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | Sign out. Sign in as tenant `tnt_demo_retail`, email `loss.prevention@northgate.demo`, password `12345678` | Signed in as the viewer |
| ☐ | Go to **Recorded Video** | The list is readable |
| ☐ | Look for **Upload a recording** | **Absent or disabled** |
| ☐ | Sign out and sign back in as the admin | — |

> ⚠️ A button that returns "403 Forbidden" when clicked is **worse** than no button at all — it
> teaches an operator the product is broken.

---

## 11 · Bad files must be refused, with a reason

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | Upload **`corrupt-not-a-video.mp4`** | ⛔ **Refused.** A red message appears |
| ☐ | Read the message | It names the reason — *"this file could not be read as a video…"* |
| ☐ | ⛔ Check the message text carefully | It must **NOT** contain a web address, `X-Amz-Credential`, or `minio:9000` |

> ⛔ That last check is finding **V-5**, a real security defect found during this validation: the
> error used to hand the caller a **live object-storage credential**. Fixed 2026-08-07.

---

## 12 · Refresh and bookmarking

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | On an analysis page, copy the URL from the address bar | e.g. `https://localhost/investigations/ana_...` |
| ☐ | Press **F5** | The same page, still showing the runs |
| ☐ | Open a new tab and paste the URL | The same page again |

---

## 13 · Demonstration mode

| ☐ | Do this | Expect |
| --- | --- | --- |
| ☐ | Open any analysis and click **Demonstrate at real time** | A new run starts |
| ☐ | Watch the clock | ⭐ It takes about **30 seconds** for a 30-second clip — instead of ~4 s |

> ⭐ Same pipeline, one parameter. It is not a playback animation: the AI is genuinely being fed at
> footage speed, which is what makes a live demonstration credible.

---

## 14 · Browser compatibility *(optional — engineers)*

| ☐ | Browser | Verified 2026-08-07 |
| --- | --- | --- |
| ☐ | Chrome / Chromium | ✅ 20/20 automated |
| ☐ | Microsoft Edge | ✅ 4/4 |
| ☐ | Firefox | ✅ 4/4 |
| ☐ | Safari / WebKit | ✅ 4/4 — ⚠️ about 2× slower; ⛔ cannot play `hev1`-tagged HEVC (TD-29) |

Repeat §1–3 by hand in one other browser, or run `pnpm --filter @vip/e2e-browser certify`.

---

## Result

| Section | ☐ |
| --- | --- |
| 0 · Platform ready, a camera is assigned | ⬜ |
| 1 · Login works, wrong password refused | ⬜ |
| 2 · Upload — camera required, limits stated | ⬜ |
| 3 · Analysis succeeds, 60/60, model named, footage-time banner | ⬜ |
| 4 · Timeline lists incidents at footage offsets | ⬜ |
| 5 · ⭐ Offline incidents stay OUT of the live queue | ⬜ |
| 6 · Evidence still is a real image, dated by the footage | ⬜ |
| 7 · ⭐ **Empty recording detects nothing and says so** | ⬜ |
| 8 · Crowd produces more identities than one person | ⬜ |
| 9 · Rerun is independent, does not overwrite | ⬜ |
| 10 · Viewer cannot upload | ⬜ |
| 11 · Bad file refused with a reason, no credential leaked | ⬜ |
| 12 · Refresh and deep link survive | ⬜ |
| 13 · Demonstration mode is visibly slower | ⬜ |
| 14 · Second browser *(optional)* | ⬜ |

**Acceptance passes when 0–13 all pass.** For any failure, record: the step number, a screenshot, and
the `correlationId` shown in any error message.

---

## Performance you should see

| What | Expected | Investigate if |
| --- | --- | --- |
| 30-second clip analysed | ~4 s | > 30 s |
| Capture still | ~1 s | > 5 s |
| Timeline loads | instant | > 2 s |
| 30-minute recording | ~3.5 min | > 15 min |

---

## ⛔ Say these out loud before a customer sees any of it

Not a disclaimer to bury. A customer who hears them from you trusts the rest; one who discovers them
later does not.

| ☐ | Statement |
| --- | --- |
| ☐ | **"No real camera has ever been connected to this platform."** Every vendor-compatibility statement is a prediction until the pilot ([L-1]) |
| ☐ | **"It detects person, vehicle, fire and smoke."** Not theft, falls, fights or PPE ([L-2]) |
| ☐ | **"These recordings are synthetic."** Real person pixels, authored motion — nothing here measures accuracy in *your* building ([L-63]) |
| ☐ | **"The timeline shows incidents; the underlying event detail is computed but not yet displayed"** ([V-7]) |
| ☐ | **"Evidence stills are not yet under retention custody"** ([TD-15]) |

---

## Troubleshooting

| Problem | Why | Fix |
| --- | --- | --- |
| ⛔ Analysis says `succeeded` but 0 detections and a huge speed (×200+) | The camera has no AI assignment — §0 exists for this | Assign the camera on `/assignment`, wait 30 s, re-run |
| Cannot log in | Wrong **Tenant** field — it is `tnt_demo_retail`, not a company name | See [credentials](#-login-credentials); `node tools/validation/reset-demo-passwords.mjs` re-verifies every account |
| Browser blocks the page | Caddy's internal CA | Accept the warning (*Advanced → Proceed*) |
| Upload button stays greyed out | No camera chosen | Choose one — required by design |
| No `.mp4` files in the folder | Dataset not generated | `node tools/dataset/generate.mjs --verify` |
| Analysis stuck in `queued` | One analysis at a time ([L-41]) | Wait for the previous one |
| Everything is slow | Docker under-provisioned | Give Docker ≥ 8 GB and ≥ 4 CPUs |

---

## Sign-off

| | |
| --- | --- |
| ☐ **Sections 0–13 pass** | ________ |
| ☐ **Limitations stated out loud** | ________ |
| ☐ **Demo clips chosen** | [DEMO_VIDEO_LIBRARY.md](DEMO_VIDEO_LIBRARY.md) |
| **Verdict** | ☐ Ready for supervised demonstration ☐ Not ready |
| **Findings** | ________ |

> 🟡 **The standing verdict is GO for supervised demonstration, NO-GO for unsupervised production.**
> Reasoning: [FIRST_PRODUCT_VALIDATION.md](FIRST_PRODUCT_VALIDATION.md#go--no-go).

## Related

- [UAT_GUIDE.md](UAT_GUIDE.md) — the same walkthrough with more background on *why* each step matters
- [DEMO_VIDEO_LIBRARY.md](DEMO_VIDEO_LIBRARY.md) — which clip tells which story
- [END_TO_END_TEST_GUIDE.md](END_TO_END_TEST_GUIDE.md) — the engineer's version, with commands
- [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) · [FIRST_PRODUCT_VALIDATION.md](FIRST_PRODUCT_VALIDATION.md)

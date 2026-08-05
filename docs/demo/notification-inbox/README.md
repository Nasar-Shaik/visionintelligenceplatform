# The Inbox

**Milestone P-6.5 · recorded 2026-08-04 against the production deployment**

▶ [`notification-inbox.webm`](notification-inbox.webm) — 1280×720

## What this demonstrates

The operator's queue: every incident the platform tried to tell somebody about, and whether anybody
has taken it. The clip opens the queue, expands one entry to show the per-channel delivery records
including **a webhook that never arrived and why**, switches to what has been handled, and returns.

⚠️ The acknowledge button is pointed at, not pressed — acknowledging is one-way, and a recording
that consumed the demo queue would leave the next demonstration with an empty inbox.

Three things worth pointing at while it plays:

- **One incident is one entry.** An alert that fanned out to an in-app inbox and a webhook is one
  thing to deal with, not two. The screen this replaced listed it twice.
- **The count follows you.** The bell in the top bar carries the number of incidents waiting on
  every screen in the console, and it moves the moment somebody takes one. A queue you have to
  remember to visit is a page.
- **"Taken by" is a name.** Every acknowledgement records the authenticated operator, so a shift
  handover can answer who has what.

## The engineering claim behind it

The queue filter is answered by the **server** (`?acknowledged=false`), not by filtering the loaded
rows in the browser — the difference between a count that is right and one that is right only about
the first fifty records. Grouping runs over the accumulated pages, so an incident split across a
page boundary is re-joined rather than double-counted.

New alerts arrive over the SSE connection the shell already holds, which invalidates the same cache
the page reads; the 20-second poll underneath is the fallback for a dropped stream, not a second
source of truth.

⚠️ **Delivery failure and acknowledgement are kept apart.** A failed webhook stays visible after an
operator takes the incident, because taking an incident says nothing about whether the customer's
own system was ever told.

## Screenshots

[the queue](../../review/p6/screens/inbox-01-queue.png) ·
[a delivery that never arrived](../../review/p6/screens/inbox-02-delivery-failure.png) ·
[after acknowledging](../../review/p6/screens/inbox-03-after-acknowledge.png) ·
[what has been handled](../../review/p6/screens/inbox-04-handled.png) ·
[an empty queue](../../review/p6/screens/inbox-05-empty-queue.png) ·
[phone](../../review/p6/screens/inbox-06-phone.png) ·
[as a viewer](../../review/p6/screens/inbox-07-viewer.png)

## ⚠️ Known limitations — say these before a customer finds them

- **In-app and webhook only** (L-4). No email, no SMS, no Slack, no Teams, no push. An operator who
  is not looking at the console learns nothing. **P-7.**
- **There is no per-operator read state.** The only state is "somebody acknowledged this". An
  operator who looked but did not act leaves the entry bold — deliberate for a shared operations
  queue, and worth saying out loud.
- ⚠️ **Two operators can both come away owning one incident** (L-36). Acknowledging is per delivery
  and the button is per incident: two people pressing together on an incident that reached two
  channels take one delivery each, and both acknowledgements are genuine. The console tells each of
  them the other is there — _"Alert acknowledged — day.operator@northgate.demo is on this incident
  too"_ — but nothing **stops** the second person. A claim on the incident arrives in **P-7**.
- **No snooze, no assignment from the inbox, no bulk clear.** Acknowledging acts on one incident.
  ⚠️ "Acknowledge all" is refused on purpose: clearing twenty alerts nobody read is the fastest way
  to make a queue worthless.
- **No notification policies or escalation** — who gets told what, and what happens when nobody
  answers, arrives with the delivery channels in **P-7**.
- **The alerts in a demonstration come from the demo dataset**, like the incidents they belong to
  (L-2). Nothing here was produced by watching video.
- ⛔ **A failed delivery is never retried** (L-32). Each channel is attempted **once** — measured
  across four real transports, `attempts: 1` on every delivery. A customer's webhook that blips for
  thirty seconds loses those alerts permanently, and there is no re-send control anywhere. The
  failure is visible with its reason, and **visibility is the whole of what this feature offers**.
  ⚠️ Say this out loud before a customer wires their SOC to a webhook. **TD-53**, ranked high.
- **The queue shows the most recent 500 deliveries** and then says so (L-34). Older alerts are
  reached by narrowing the filter or opening the incident. Deliberate: the screen polls every page it
  has loaded, and unbounded paging cost around 800 MB per operator per shift.
- **`Pending` does not distinguish "in flight" from "stranded"** (L-33, PB-24). One resolves in a
  millisecond; the other never will, if a process died at the wrong moment.

## What the freeze pass changed

Recorded 2026-08-04, after the production-grade verification pass:

- ⚠️ **Two operators could both take the same alert.** Twelve simultaneous acknowledgements produced
  two to four winners in nine rounds out of twelve — each told they had the incident. The transition
  is now decided by the database write, and the loser is told **who** beat them to it rather than
  that something failed. Worth demonstrating live in two windows: it is the moment the product looks
  like it was built by people who have worked a control room.
- ⚠️ **The demo dataset used to claim three delivery attempts.** It now says one, because one is what
  the platform does.
- **Delivery failures now read in an operator's words** — _"the endpoint rejected it (HTTP 503)"_,
  _"no response within 5s"_ — instead of `fetch failed`.

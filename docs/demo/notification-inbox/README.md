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
- **No snooze, no assignment from the inbox, no bulk clear.** Acknowledging acts on one incident.
  ⚠️ "Acknowledge all" is refused on purpose: clearing twenty alerts nobody read is the fastest way
  to make a queue worthless.
- **No notification policies or escalation** — who gets told what, and what happens when nobody
  answers, arrives with the delivery channels in **P-7**.
- **The alerts in a demonstration come from the demo dataset**, like the incidents they belong to
  (L-2). Nothing here was produced by watching video.

# User administration

**Milestone P-6.2 · recorded 2026-08-04 against the production deployment**

▶ [`user-administration.webm`](user-administration.webm) — 1280×720

## What this demonstrates

The operator directory, then the two controls that made this a pilot blocker until P-6.2: **change
roles** and **disable**. ⚠️ Both dialogs are opened and **cancelled** in the clip — disabling a real
demo account inside a recording would leave the dataset changed by an artefact, and the point is the
control and the consequence it states, not the act.

- **Disabling ends every open session immediately** — and reports how many. It is not a status flip
  that leaves the leaver signed in until their refresh token expires a week later.
- **You cannot disable yourself.** Refused at the service, not only in the UI: locking yourself out
  of a security product mid-shift has no undo from inside the console.

## The engineering claim behind it

`UpdateUserInput` carries **roles only**. Email is immutable (it is the login identity and half the
unique key); disabling is a named act with its own route and its own audit line, so a PATCH can never
lock somebody out by accident; a password reset has its own route so one audit entry never covers two
different acts.

⚠️ A defect only the deployment found: the session count reported **3** for a user with **2** open
sessions, because rotating a refresh token leaves the used record behind. **A family is a session.**

## Screenshots

[directory](../../review/p6/screens/users-desktop.png) ·
[roles dialog](../../review/p6/screens/users-roles-dialog.png) ·
[disable dialog](../../review/p6/screens/users-disable-dialog.png) ·
[as an operator](../../review/p6/screens/users-operator.png) ·
[phone](../../review/p6/screens/users-phone.png)

## ⚠️ Known limitations — say these before a customer finds them

- **A disabled user's access token stays valid for up to 15 minutes** (L-23). Refresh tokens are
  revoked instantly; access tokens are stateless, so the window is bounded by their TTL. This belongs
  in a customer's security review.
- **An email address cannot be changed** (L-21). A new account plus a disabled old one leaves a trail;
  editing the address would be an account takeover that reads as a typo fix.
- **No self-service password change** (L-22) — it needs email delivery, which arrives in P-7.
- **No custom roles.** Four roles: owner, admin, operator, viewer.

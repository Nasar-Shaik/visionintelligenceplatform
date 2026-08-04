# Tenant Settings

**Milestone P-6.3 · recorded 2026-08-04 against the production deployment**

▶ [`tenant-settings.webm`](tenant-settings.webm) — 1280×720

## What this demonstrates

An administrator opens their organisation's settings, clears the name to show the validation, renames
the organisation, saves, and scrolls to the branding panel. The name is restored before the clip
ends.

- **It is a management surface, not a PATCH form.** Every field the backend cannot safely change is
  shown read-only **with the reason on screen** — the slug is a key and namespace prefix, so changing
  it would strand every reference that already spells it.
- **Status is read-only and labelled "not enforced".** `TenantStatus` is stored and **no code path
  reads it**: nothing refuses a request because a tenant is suspended. A Suspend button would claim
  to lock a customer out and do nothing.
- **Branding reports its measured WCAG contrast ratio** rather than asserting compliance. A colour
  below 4.5:1 against both light and dark text is refused rather than applied.

## The engineering claim behind it

Optimistic concurrency: two administrators editing at once produce a visible **409**, never a silent
overwrite. The check lives **in the update filter**, not in a comparison above it — read-compare-write
reintroduces the race it exists to close. Every change writes one audit event with before/after, the
actor and the correlation id, and **exactly one** even under a double-click.

Branding is runtime configuration: edit `branding.json`, reload, done. **No rebuild, no redeploy** —
verified by overwriting the file inside the running container.

## Screenshots

[populated](../../review/p6/screens/settings-02-populated.png) ·
[validation](../../review/p6/screens/settings-03-validation.png) ·
[saving](../../review/p6/screens/settings-04-saving.png) ·
[saved](../../review/p6/screens/settings-05-saved.png) ·
[conflict (409)](../../review/p6/screens/settings-06-conflict.png) ·
[backend failure](../../review/p6/screens/settings-07-backend-failure.png) ·
[permission denied](../../review/p6/screens/settings-09-permission-denied.png) ·
[unavailable](../../review/p6/screens/settings-10-unavailable.png) ·
[phone](../../review/p6/screens/settings-08-phone.png) ·
[white-label](../../review/p6/screens/branding-01-white-label.png) ·
[contrast refused](../../review/p6/screens/branding-02-contrast-refused.png)

## ⚠️ Known limitations — say these before a customer finds them

- **Suspending a tenant does not lock anyone out** (L-24 · TD-48). The status is stored and unenforced,
  which is exactly why there is no button.
- **Settings changes are audited to the log, not to a queryable trail** (L-25 · TD-49). "Who renamed
  the organisation last March?" is answerable from log retention, not from the product.
- **Branding is per-deployment, not per-tenant** (L-26). It is loaded before anyone signs in so the
  login screen can carry it, which means the tenant is not yet known. A reseller hosting several
  customers in one deployment cannot brand them separately.
- **The organisation name is the only editable field.** Everything else the backend supports is
  either immutable identity or unenforced.

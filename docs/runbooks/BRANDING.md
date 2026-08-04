# White-label branding

Change the product name, logo, favicon, accent colour and login footer **without rebuilding or
redeploying the application**. One JSON file, read at runtime.

---

## 1 · The file

`/branding.json`, served beside the console bundle:

```json
{
  "productName": "Northgate SecureView",
  "productTagline": "Northgate Retail Group — Security Operations",
  "logoUrl": "/brand/logo.svg",
  "favicon": "🏬",
  "brandColor": "#e8590c",
  "footerNote": "Support: securityops@northgate.demo · +44 20 7946 0000"
}
```

| Field            | Appears                                        | Notes                                                                   |
| ---------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `productName`    | Browser tab, sidebar, login heading            |                                                                         |
| `productTagline` | Under the login heading                        |                                                                         |
| `logoUrl`        | Sidebar and login, replacing the built-in mark | **Same-origin path.** The CSP blocks external hosts                     |
| `favicon`        | Browser tab icon                               | An emoji is rendered to a data-URI SVG at runtime; a path is used as-is |
| `brandColor`     | Buttons, links, focus rings, the brand mark    | Any CSS colour — `#rgb`, `#rrggbb`, `rgb()`                             |
| `footerNote`     | Under the login form                           | Support contact, classification marking, or a legal notice              |

Every field is optional. Omit one and the built-in default applies.

---

## 2 · Applying it

### Persistently — bind-mount (recommended)

Survives image upgrades, because the mount is outside the image:

```yaml
# docker-compose.prod.yml → console service
volumes:
  - ./branding/branding.json:/srv/branding.json:ro
  - ./branding/assets:/srv/brand:ro # logo, if you use one
```

```sh
mkdir -p branding/assets
cp your-logo.svg branding/assets/logo.svg
$EDITOR branding/branding.json
infra/docker/prod.sh up -d console
```

### Immediately — for a demo, in seconds

```sh
docker cp branding.json "$(infra/docker/prod.sh ps -q console)":/srv/branding.json
```

Reload the browser. That is the whole procedure — verified in P-5.9 against the running deployment,
with no image rebuild and no container restart.

---

## 3 · Colour and contrast

`brandColor` is applied to `--color-brand`, `--color-primary`, `--color-primary-hover`,
`--color-brand-muted`, `--color-brand-border` and `--color-ring`.

> ⚠️ **Contrast is checked, not assumed.** The console computes the WCAG contrast of your colour
> against both light and dark text, picks whichever passes, and **refuses the colour entirely** if
> neither reaches 4.5:1 — logging a warning instead of shipping unreadable buttons. A mid-tone
> yellow or pale grey will be rejected; that is the check working.
>
> Verified: `#e8590c` renders an orange button with **near-black** label text, because white on that
> orange measures ~3.1:1 and would fail.

Pick a colour that carries white or near-black text at 4.5:1. Most corporate primaries do.

---

## 4 · What it never breaks

The file is read before the app renders, and **failure is always soft**:

- Missing file → defaults.
- Malformed JSON → defaults.
- Unknown fields → ignored.
- A field that is not a string, or is empty → that one field falls back.

An operator locked out of an incident queue because a logo could not be parsed would be a far worse
outcome than an unbranded screen. There is no branding state that prevents the console from loading.

---

## 5 · Scope and limits

**This brands the deployment, not each tenant inside it.** Branding is read before anyone signs in —
that is what lets the login screen carry the customer's identity. A single deployment serving several
customers under separate brands would need branding to come from the tenant record after
authentication, which is a product decision, not a configuration one. Recorded as **TD-42**.

| Surface                                    | Brandable today                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Login screen (name, tagline, logo, footer) | ✅                                                                                                                                  |
| Browser tab title + favicon                | ✅                                                                                                                                  |
| Sidebar (name + logo)                      | ✅                                                                                                                                  |
| Accent colour / theme                      | ✅ contrast-checked                                                                                                                 |
| Per-tenant branding within one deployment  | ❌ TD-42                                                                                                                            |
| Report branding                            | ➖ **Reports are not built** — there is nothing to brand yet                                                                        |
| Email branding                             | ➖ **Email delivery is not built.** Notifications are in-app and webhook only                                                       |
| Light theme                                | ➖ The console is dark-only by design (a SOC product). Tokens exist; a light palette has never been produced or reviewed. **TD-43** |

The last three are marked ➖ rather than ❌ deliberately: they are not branding gaps, they are
features that do not exist. When reports and email are built, they should read the same file.

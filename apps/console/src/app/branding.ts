/**
 * Runtime branding — white-label without a rebuild (P-5.9).
 *
 * ### ⚠️ Why this is fetched, not imported
 *
 * The console is a static bundle. Anything imported at build time is baked into a hashed asset, so
 * changing the product name or the accent colour would mean rebuilding the image and re-deploying
 * it — which is exactly what a reseller or a white-label customer cannot do. Before this, the
 * product name was hard-coded in three separate files and there was no favicon at all.
 *
 * `branding.json` sits **beside** the bundle and is fetched before the app renders. An operator
 * edits one file and reloads. Nothing is recompiled, and the file can be bind-mounted over the one
 * in the image, so an upgrade does not overwrite a customer's branding.
 *
 * ### ⚠️ Fails soft, always
 *
 * A missing, unreadable or malformed file must never stop the console from loading — an operator
 * locked out of an incident queue because a logo could not be parsed is a far worse outcome than an
 * unbranded screen. Every field falls back to a default, and a bad file logs once and is ignored.
 *
 * ### ⚠️ Not a tenant-level feature
 *
 * This brands the **deployment**, not each tenant inside it: it is read before anyone signs in, so
 * the login screen can carry the customer's identity. Per-tenant theming inside one deployment
 * needs the branding to come from the tenant record after authentication, which is a product
 * decision and is recorded as debt rather than half-built here.
 */

export interface Branding {
  /** Shown in the sidebar, the browser tab and the login heading. */
  productName: string;
  /** Second line on the login screen. */
  productTagline: string;
  /** Same-origin path to a logo (SVG or PNG). Empty string = use the built-in mark. */
  logoUrl: string;
  /** Emoji or a same-origin path. Emoji is rendered to a data-URI favicon at runtime. */
  favicon: string;
  /** Accent colour, applied to the `--brand` token. Any CSS colour. */
  brandColor: string;
  /** Optional footer line — support contact, classification marking, or a legal notice. */
  footerNote: string;
}

export const DEFAULT_BRANDING: Branding = {
  productName: 'VIP Console',
  productTagline: 'Sign in to continue',
  logoUrl: '',
  favicon: '🛡️',
  brandColor: '',
  footerNote: '',
};

/** Where the file lives, relative to the bundle. Same origin, so the CSP needs no exception. */
const BRANDING_URL = '/branding.json';

let cached: Branding = DEFAULT_BRANDING;

/** The branding in force. Safe to call before {@link loadBranding} — returns defaults. */
export function branding(): Branding {
  return cached;
}

/**
 * Fetch and apply branding. Called once, before render.
 *
 * Resolves to the branding in force whether the fetch succeeded or not, so the caller never has to
 * decide what to do about a failure.
 */
export async function loadBranding(): Promise<Branding> {
  try {
    const response = await fetch(BRANDING_URL, { cache: 'no-cache' });
    if (!response.ok) return cached;
    const raw: unknown = await response.json();
    cached = merge(raw);
  } catch {
    /* Absent or malformed — the defaults stand. Never block the console on branding. */
  }
  apply(cached);
  return cached;
}

/** Take only known string fields; ignore anything else the file happens to contain. */
function merge(raw: unknown): Branding {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_BRANDING;
  const source = raw as Record<string, unknown>;
  const pick = (key: keyof Branding): string => {
    const value = source[key];
    return typeof value === 'string' && value.trim() !== '' ? value : DEFAULT_BRANDING[key];
  };
  return {
    productName: pick('productName'),
    productTagline: pick('productTagline'),
    logoUrl: pick('logoUrl'),
    favicon: pick('favicon'),
    brandColor: pick('brandColor'),
    footerNote: pick('footerNote'),
  };
}

/** Push the parts of branding that live outside React: the tab title, favicon and accent token. */
function apply(b: Branding): void {
  document.title = b.productName;

  if (b.brandColor !== '') applyBrandColor(b.brandColor);

  const href = faviconHref(b.favicon);
  if (href !== undefined) {
    const link =
      document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
      document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
    link.href = href;
  }
}

/**
 * Re-tint the accent tokens.
 *
 * ⚠️ The names matter: `theme.css` defines `--color-brand`, `--color-primary` and `--color-ring`,
 * and Tailwind's utilities read those. Setting an invented `--brand` changed nothing at all — the
 * first attempt at this reported "themed" while every button stayed the original blue, which is
 * exactly the sort of claim a certification pass exists to catch.
 *
 * ⚠️ Contrast is checked, not assumed. `theme.css` deliberately makes `--color-primary` darker than
 * `--color-brand` so white label text clears WCAG AA (4.59:1). A customer's colour has no such
 * guarantee, so the foreground flips to near-black when white would fail, and a colour that cannot
 * reach AA either way is refused with a console warning rather than shipping an unreadable button.
 */
function applyBrandColor(color: string): void {
  const rgb = parseColor(color);
  if (rgb === undefined) return;

  const onWhite = contrast(rgb, [255, 255, 255]);
  const onBlack = contrast(rgb, [18, 20, 24]);
  if (Math.max(onWhite, onBlack) < 4.5) {
    // eslint-disable-next-line no-console
    console.warn(
      `[branding] brandColor ${color} reaches only ${Math.max(onWhite, onBlack).toFixed(2)}:1 against ` +
        'both light and dark text — below WCAG AA (4.5:1). Ignoring it rather than rendering ' +
        'unreadable controls.',
    );
    return;
  }

  const root = document.documentElement.style;
  root.setProperty('--color-brand', color);
  root.setProperty('--color-primary', color);
  root.setProperty('--color-primary-hover', shade(rgb, 0.85));
  root.setProperty('--color-primary-foreground', onWhite >= onBlack ? '#ffffff' : '#121418');
  root.setProperty('--color-brand-muted', shade(rgb, 0.28));
  root.setProperty('--color-brand-border', shade(rgb, 0.6));
  root.setProperty('--color-ring', color);
}

/**
 * What the accent colour actually scores, so the Settings screen can show it rather than assert it.
 *
 * ⚠️ Reports the **same numbers `applyBrandColor` decided on**, computed by the same functions —
 * a second implementation for display would be free to disagree with the one that enforces, and
 * the screen would then confidently show a passing ratio for a colour that was rejected.
 *
 * `applied` is false when the colour was refused for failing AA in both directions; the built-in
 * accent stands in that case.
 */
export interface BrandContrast {
  /** The configured colour, or `''` when none is set and the built-in accent is in use. */
  color: string;
  /** Best achievable ratio against white or near-black text. `undefined` if unparseable. */
  ratio: number | undefined;
  /** Which foreground wins, and therefore what the buttons use. */
  foreground: 'light' | 'dark' | undefined;
  applied: boolean;
}

export function brandContrast(b: Branding = cached): BrandContrast {
  if (b.brandColor === '') {
    return { color: '', ratio: undefined, foreground: undefined, applied: false };
  }
  const rgb = parseColor(b.brandColor);
  if (rgb === undefined) {
    return { color: b.brandColor, ratio: undefined, foreground: undefined, applied: false };
  }
  const onWhite = contrast(rgb, [255, 255, 255]);
  const onBlack = contrast(rgb, [18, 20, 24]);
  const ratio = Math.max(onWhite, onBlack);
  return {
    color: b.brandColor,
    ratio,
    foreground: onWhite >= onBlack ? 'light' : 'dark',
    applied: ratio >= 4.5,
  };
}

type Rgb = [number, number, number];

/** `#rgb`, `#rrggbb` and `rgb(r g b)` — the forms a customer will actually paste into JSON. */
function parseColor(value: string): Rgb | undefined {
  const hex = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    const [r, g, b] = [...hex].map((c) => parseInt(c + c, 16));
    return [r!, g!, b!];
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  const m = value.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function shade([r, g, b]: Rgb, factor: number): string {
  const to = (v: number) =>
    Math.round(factor <= 1 ? v * factor : v + (255 - v) * (factor - 1))
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** WCAG 2.1 relative-luminance contrast ratio. */
function contrast(a: Rgb, b: Rgb): number {
  const lum = ([r, g, b2]: Rgb): number => {
    const channel = (v: number): number => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b2);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/**
 * An emoji becomes an inline SVG data URI; anything else is treated as a same-origin path.
 *
 * ⚠️ `data:` is why the CSP allows `img-src data:` — the favicon is generated in the browser rather
 * than shipped as a file, so branding needs no build step and no extra asset to deploy.
 */
function faviconHref(favicon: string): string | undefined {
  if (favicon === '') return undefined;
  if (favicon.startsWith('/') || favicon.startsWith('data:')) return favicon;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="0.9em" font-size="88">${escapeXml(favicon)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

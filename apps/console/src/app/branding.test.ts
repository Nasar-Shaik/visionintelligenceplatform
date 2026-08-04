/**
 * ⚠️ Pins the two things that went wrong while building runtime branding (P-5.9).
 *
 * 1. The first implementation set an invented `--brand` custom property and reported success. The
 *    real tokens are `--color-brand` / `--color-primary`, so the log said "themed" while every
 *    button stayed the original blue. These tests assert the **token names**, because that is
 *    exactly what was wrong and nothing else would have caught it.
 * 2. A customer colour carries no contrast guarantee. `theme.css` deliberately makes primary darker
 *    than brand so white labels clear WCAG AA; an arbitrary colour can fail either way, and shipping
 *    an unreadable button is worse than shipping an unbranded one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BRANDING, branding, loadBranding } from './branding';

const mockFetch = (body: unknown, ok = true): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response),
  );
};

const cssVar = (name: string): string =>
  document.documentElement.style.getPropertyValue(name).trim();

describe('loadBranding', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('style');
    document.querySelector('link[rel="icon"]')?.remove();
  });

  it('applies a supplied product name to the document title', async () => {
    mockFetch({ productName: 'Northgate SecureView' });
    const result = await loadBranding();
    expect(result.productName).toBe('Northgate SecureView');
    expect(document.title).toBe('Northgate SecureView');
    expect(branding().productName).toBe('Northgate SecureView');
  });

  it('⚠️ never blocks the console when the file is missing — resolves with the branding in force', async () => {
    /* Resolves rather than rejects, and returns whatever is currently in force. Within a page load
       `loadBranding` runs once, so "in force" is the defaults; the promise never rejects either way. */
    mockFetch({}, false);
    const before = branding();
    await expect(loadBranding()).resolves.toEqual(before);
  });

  it('⚠️ falls back to defaults when the fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(loadBranding()).resolves.toEqual(
      expect.objectContaining({ productName: expect.any(String) }),
    );
  });

  it('⚠️ falls back per field, so a partial file is not an all-or-nothing failure', async () => {
    mockFetch({ productName: 'Acme Watch', logoUrl: '', favicon: 42 });
    const result = await loadBranding();
    expect(result.productName).toBe('Acme Watch');
    expect(result.productTagline).toBe(DEFAULT_BRANDING.productTagline);
    expect(result.favicon).toBe(DEFAULT_BRANDING.favicon); // not a string → default
  });

  it('ignores a malformed body entirely', async () => {
    mockFetch('not an object');
    expect(await loadBranding()).toEqual(DEFAULT_BRANDING);
  });

  it('renders an emoji favicon to a data URI', async () => {
    mockFetch({ favicon: '🏬' });
    await loadBranding();
    const href = document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? '';
    expect(href.startsWith('data:image/svg+xml,')).toBe(true);
  });

  it('uses a same-origin path as the favicon verbatim', async () => {
    mockFetch({ favicon: '/brand/icon.png' });
    await loadBranding();
    expect(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.getAttribute('href')).toBe(
      '/brand/icon.png',
    );
  });
});

describe('brandColor', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('style');
  });

  it('⚠️ writes the REAL token names — the first version set an invented `--brand` and changed nothing', async () => {
    mockFetch({ brandColor: '#e8590c' });
    await loadBranding();
    expect(cssVar('--color-brand')).toBe('#e8590c');
    expect(cssVar('--color-primary')).toBe('#e8590c');
    expect(cssVar('--color-ring')).toBe('#e8590c');
    expect(cssVar('--color-primary-hover')).not.toBe('');
    /* The property that did nothing. If this ever comes back, the theme is silently broken again. */
    expect(cssVar('--brand')).toBe('');
  });

  it('⚠️ picks a dark label when white would fail AA on the supplied colour', async () => {
    /* Measured: #e8590c is 3.58:1 on white (fails AA) and 5.15:1 on near-black (passes). */
    mockFetch({ brandColor: '#e8590c' });
    await loadBranding();
    expect(cssVar('--color-primary-foreground')).toBe('#121418');
  });

  it('picks a white label on a dark brand colour', async () => {
    mockFetch({ brandColor: '#0b3d91' });
    await loadBranding();
    expect(cssVar('--color-primary-foreground')).toBe('#ffffff');
  });

  it('⚠️ REFUSES a colour that cannot reach AA against either — an unreadable button is worse than an unbranded one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    /* ⚠️ #7a7a7a is the *worst* grey there is: 4.29:1 on white, 4.30:1 on near-black — the only
       band where a colour fails both. My first attempt used #9a9a9a, which actually reaches 6.55:1
       against dark text and passes comfortably; the test failed because the example was wrong, not
       the code. Measured, not guessed. */
    mockFetch({ brandColor: '#7a7a7a' });
    await loadBranding();
    expect(cssVar('--color-brand')).toBe('');
    expect(cssVar('--color-primary')).toBe('');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('accepts shorthand hex and rgb()', async () => {
    mockFetch({ brandColor: '#036' });
    await loadBranding();
    expect(cssVar('--color-primary')).toBe('#036');

    document.documentElement.removeAttribute('style');
    mockFetch({ brandColor: 'rgb(11, 61, 145)' });
    await loadBranding();
    expect(cssVar('--color-primary')).toBe('rgb(11, 61, 145)');
  });

  it('leaves the tokens alone when no colour is supplied', async () => {
    mockFetch({ productName: 'Acme' });
    await loadBranding();
    expect(cssVar('--color-primary')).toBe('');
  });
});

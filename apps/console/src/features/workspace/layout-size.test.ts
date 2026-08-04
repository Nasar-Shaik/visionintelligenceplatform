/**
 * ⚠️ Pins the fix for the tablet clipping defect (P-5.9).
 *
 * A panel size comes from the registry or an operator's resize and knows nothing about the viewport
 * it will be rendered into. Applied unbounded on a 1024×768 tablet, a panel wider than its 256 px
 * region overflowed and the incident queue rendered titles as "Suspected concealment — Elec":
 * hard-clipped mid-word, with no ellipsis, because the text never reached a box small enough to
 * trigger one.
 *
 * ⚠️ Worth knowing how this was found: the first diagnosis was a missing `min-w-0` on the flex row.
 * That is a real trap and the fix was correct in itself — and the screenshot after it was unchanged,
 * because it was not the cause. A test that only asserted `min-w-0` would have passed while the
 * product stayed broken. This asserts the bound instead.
 */
import { describe, expect, it } from 'vitest';
import { sizeStyle } from './layout';

describe('sizeStyle', () => {
  it('⚠️ bounds a horizontal size to the region — a stored width is a preference, not a promise', () => {
    expect(sizeStyle('left', 320)).toEqual({ width: 320, maxWidth: '100%' });
    expect(sizeStyle('right', 384)).toEqual({ width: 384, maxWidth: '100%' });
  });

  it('⚠️ bounds a vertical size the same way', () => {
    expect(sizeStyle('bottom', 224)).toEqual({ height: 224, maxHeight: '100%' });
  });

  it('returns nothing when a panel declares no size, so the layout decides', () => {
    expect(sizeStyle('left', undefined)).toBeUndefined();
    expect(sizeStyle('bottom', undefined)).toBeUndefined();
  });

  it('never returns a bare dimension without its bound', () => {
    /* The regression guard: any future edit that drops the `max*` key reintroduces the clipping. */
    for (const region of ['left', 'right', 'center', 'bottom'] as const) {
      const style = sizeStyle(region, 300);
      expect(style).toBeDefined();
      const keys = Object.keys(style as object);
      expect(keys.some((k) => k.startsWith('max'))).toBe(true);
      expect(keys).toHaveLength(2);
    }
  });
});

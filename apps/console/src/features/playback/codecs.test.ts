/**
 * The codec verdict, checked against **answers measured in five real engines** (P-5.6).
 *
 * ⚠️ Every table below is transcribed from `docs/review/p56/BROWSER_MATRIX.md`, which was produced
 * by running `canPlayType` in Chromium 151, branded Chrome 150, Firefox 153, Playwright WebKit 26.5
 * and Safari 26.5.2 on macOS. Nothing here is invented: the point of the suite is that the decision
 * logic is pinned to what browsers actually answer rather than to what the specification implies,
 * because the specification implied the P-5.5 defect.
 */
import { describe, expect, it } from 'vitest';
import { codecCandidates, codecVerdict, type CanPlayType } from './codecs';

/** Measured answers, engine by engine. Any type not listed answered `''`. */
const MEASURED: Record<string, Record<string, string>> = {
  chromium: {
    'video/mp4': 'maybe',
    'video/mp4; codecs="avc1.42E01E"': 'probably',
    'video/mp4; codecs="avc1.4D401E"': 'probably',
    'video/mp4; codecs="avc1.64001F"': 'probably',
    'video/webm': 'maybe',
    'video/webm; codecs="vp8"': 'probably',
    'video/webm; codecs="vp9"': 'probably',
    /* ⚠️ No HEVC: the open-source build ships no proprietary decoder. */
  },
  chrome: {
    'video/mp4': 'maybe',
    'video/mp4; codecs="avc1.42E01E"': 'probably',
    'video/mp4; codecs="avc1.4D401E"': 'probably',
    'video/mp4; codecs="avc1.64001F"': 'probably',
    'video/mp4; codecs="hvc1.1.6.L93.B0"': 'probably',
    'video/mp4; codecs="hev1.1.6.L93.B0"': 'probably',
    'video/webm': 'maybe',
  },
  firefox: {
    'video/mp4': 'maybe',
    'video/mp4; codecs="avc1.42E01E"': 'probably',
    'video/mp4; codecs="avc1.4D401E"': 'probably',
    'video/mp4; codecs="avc1.64001F"': 'probably',
    'video/mp4; codecs="hvc1.1.6.L93.B0"': 'probably',
    'video/mp4; codecs="hev1.1.6.L93.B0"': 'probably',
    'video/quicktime': 'maybe',
    'video/quicktime; codecs="avc1.42E01E"': 'probably',
    'video/quicktime; codecs="hvc1.1.6.L93.B0"': 'probably',
    'video/webm': 'maybe',
  },
  safari: {
    'video/mp4': 'maybe',
    'video/mp4; codecs="avc1.42E01E"': 'probably',
    'video/mp4; codecs="avc1.4D401E"': 'probably',
    'video/mp4; codecs="avc1.64001F"': 'probably',
    /* ⚠️ `hvc1` yes, `hev1` **no** — the divergence that makes a single probe string wrong. */
    'video/mp4; codecs="hvc1.1.6.L93.B0"': 'probably',
    'video/quicktime': 'maybe',
    'video/quicktime; codecs="avc1.42E01E"': 'probably',
    'video/quicktime; codecs="hvc1.1.6.L93.B0"': 'probably',
    'video/webm': 'maybe',
  },
};

const probeFor = (engine: keyof typeof MEASURED): CanPlayType => {
  const table = MEASURED[engine]!;
  return (type: string) => table[type] ?? '';
};

describe('the friendly codec name is never handed to the browser', () => {
  it('⚠️ every engine answers "" to the stored name, which is why it must be translated', () => {
    for (const engine of Object.keys(MEASURED)) {
      expect(probeFor(engine)('video/mp4; codecs="h264"')).toBe('');
      expect(probeFor(engine)('video/mp4; codecs="h265"')).toBe('');
    }
  });

  it('translates h264 to representative RFC 6381 profiles', () => {
    expect(codecCandidates('h264')).toEqual(['avc1.42E01E', 'avc1.4D401E', 'avc1.64001F']);
  });

  it('⚠️ offers both H.265 sample entries, because Safari accepts only one of them', () => {
    expect(codecCandidates('h265')).toEqual(['hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0']);
  });

  it('⚠️ a codec the platform does not recognise yields no candidates, never a false refusal', () => {
    /* The enum-extension hazard: a value added to `CameraCodec` later must degrade to "unchecked". */
    expect(codecCandidates('mjpeg')).toEqual([]);
    expect(codecCandidates(undefined)).toEqual([]);
  });

  it('passes through a string that is already RFC 6381', () => {
    expect(codecCandidates('av01.0.04M.08')).toEqual(['av01.0.04M.08']);
  });
});

describe('H.264 — the format almost all evidence arrives in', () => {
  it.each(['chromium', 'chrome', 'firefox', 'safari'] as const)('plays on %s', (engine) => {
    expect(codecVerdict('video/mp4', 'h264', probeFor(engine)).support).toBe('supported');
  });
});

describe('H.265 — where the engines genuinely disagree', () => {
  it('⚠️ is refused by the open-source Chromium build, and said so by name', () => {
    const verdict = codecVerdict('video/mp4', 'h265', probeFor('chromium'));
    expect(verdict.support).toBe('unsupported');
    expect(verdict.reason).toMatch(/HEVC/);
    /* ⚠️ The operator must be told the file is fine. This is the sentence that stops an escalation. */
    expect(verdict.reason).toMatch(/evidence is intact/i);
  });

  it('plays on branded Chrome, Firefox and Safari', () => {
    for (const engine of ['chrome', 'firefox', 'safari'] as const) {
      expect(codecVerdict('video/mp4', 'h265', probeFor(engine)).support).toBe('supported');
    }
  });

  it('⚠️ Safari passes only because `hvc1` is tried — `hev1` alone would report a false negative', () => {
    const safari = probeFor('safari');
    expect(safari('video/mp4; codecs="hev1.1.6.L93.B0"')).toBe('');
    expect(safari('video/mp4; codecs="hvc1.1.6.L93.B0"')).toBe('probably');
    expect(codecVerdict('video/mp4', 'h265', safari).support).toBe('supported');
  });
});

describe('the container gate', () => {
  it('⚠️ refuses QuickTime on Chrome, which genuinely cannot open it', () => {
    const verdict = codecVerdict('video/quicktime', 'h264', probeFor('chrome'));
    expect(verdict.support).toBe('unsupported');
    expect(verdict.reason).toMatch(/video\/quicktime/);
  });

  it('accepts the same file on Firefox and Safari', () => {
    for (const engine of ['firefox', 'safari'] as const) {
      expect(codecVerdict('video/quicktime', 'h264', probeFor(engine)).support).toBe('supported');
    }
  });

  it('⚠️ a container that opens with an untranslatable codec is "unknown", not "supported"', () => {
    const verdict = codecVerdict('video/mp4', 'mjpeg', probeFor('chrome'));
    expect(verdict.support).toBe('unknown');
  });
});

describe('a probe that is not measuring anything', () => {
  it('⚠️ jsdom answers "" to everything, and must never be believed', () => {
    const jsdom: CanPlayType = () => '';
    expect(codecVerdict('video/mp4', 'h265', jsdom).support).toBe('unknown');
  });

  it('an absent probe is unknown, never supported', () => {
    expect(codecVerdict('video/mp4', 'h264', undefined).support).toBe('unknown');
  });

  it('a still image is not this check’s business', () => {
    expect(codecVerdict('image/jpeg', undefined, probeFor('chrome')).support).toBe('unknown');
  });
});

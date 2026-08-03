/**
 * Deciding whether **this browser** can decode **this evidence** (P-5.6).
 *
 * Every rule below was measured, in five engines, against the probe recorded in
 * `docs/review/p56/BROWSER_MATRIX.md`. Nothing here is reasoned from documentation, because the
 * previous version of this check was reasoned from documentation and it was wrong in the worst
 * possible direction — it declared every H.264 clip in the product undecodable (P-5.5, §86).
 *
 * ### ⚠️ Why the container alone is not enough
 *
 * `canPlayType('video/mp4')` answers **`maybe` on all five engines**. It is a claim about the
 * container, and every engine can open an MP4. So a container-only check can never return
 * "unsupported" for the format almost all CCTV arrives in — which means the H.265 clip that
 * genuinely will not decode on a Chromium build falls straight through to the `<video>` element and
 * surfaces as *"the media could not be loaded"*: the same message a dead signed URL produces. The
 * operator is told the evidence is broken when the evidence is fine.
 *
 * ### ⚠️ Why the codec name cannot be passed through
 *
 * `canPlayType`'s codecs parameter is **RFC 6381** (`avc1.42E01E`). `CameraCodec` stores the
 * friendly name (`'h264'`). Measured: every engine answers `''` — *unsupported* — to
 * `codecs="h264"` and `codecs="h265"`. Handing the stored name straight to the browser is a false
 * negative on 100% of files. So the friendly name is translated here, and only here.
 *
 * ### ⚠️ Why a codec gets several candidate strings
 *
 * H.265 in MP4 has two legal sample entries — `hvc1` (parameter sets in the sample description) and
 * `hev1` (in band). Measured: Safari 26.5 answers `probably` to `hvc1` and **`''` to `hev1`**;
 * Chrome and Firefox answer `probably` to both. Probing only `hev1` would report "Safari cannot play
 * H.265", which is false. So each codec carries a list of candidates and **the best answer wins**.
 * H.264 profiles are listed for the same reason: a browser refusing one profile does not refuse the
 * codec, and after §86 this check fails *open* on the codec question by design.
 */
import type { CameraCodec } from '@vip/contracts';

/**
 * Three-valued on purpose.
 *
 * ⚠️ `unknown` is not a synonym for `supported`. It means the probe could not be run — no `document`
 * (server render), or a container the platform has no candidate strings for — and a check that could
 * not run is not a check that passed (§44). The player treats `unknown` as *play it and let a real
 * decode failure speak*, never as a claim.
 */
export type CodecSupport = 'supported' | 'unsupported' | 'unknown';

export interface CodecVerdict {
  support: CodecSupport;
  /** Operator-facing sentence when `unsupported`. Names the codec, never the probe string. */
  reason?: string;
  /** The exact strings handed to the browser — kept so a support ticket can reproduce the answer. */
  probed: readonly string[];
}

/**
 * Representative RFC 6381 strings per stored codec name.
 *
 * ⚠️ These are *representative profiles*, not the file's actual profile — the manifest does not
 * record one. So a `supported` verdict means "this engine decodes common profiles of this codec",
 * which is the strongest claim the available data supports. It is deliberately the optimistic
 * reading: the cost of wrongly refusing a playable file is an investigator who cannot see evidence,
 * and the cost of wrongly attempting an unplayable one is an error message they were going to get
 * anyway.
 */
export const RFC6381_CANDIDATES: Readonly<Record<CameraCodec, readonly string[]>> = {
  /* Baseline 3.0 · Main 3.0 · High 3.1 — measured `probably` on all five engines. */
  h264: ['avc1.42E01E', 'avc1.4D401E', 'avc1.64001F'],
  /* ⚠️ Both sample entries. Safari answers `''` to `hev1` and `probably` to `hvc1`. */
  h265: ['hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0'],
};

/**
 * Codecs whose absence is worth explaining rather than just reporting.
 *
 * ⚠️ Measured: the **Chromium open-source build answers `''` to both H.265 candidates while branded
 * Chrome answers `probably`** — proprietary decoders are a build-time licensing decision, not a
 * version difference. Same engine, same version, different answer. That is why this file exists as
 * measurement rather than as a browser-name lookup: sniffing the user agent would have said "Chrome,
 * so HEVC is fine" and been wrong on every Chromium-derived deployment, including Electron shells.
 */
const CODEC_ADVICE: Readonly<Record<CameraCodec, string>> = {
  h264: 'This browser reports no H.264 decoder, which is unusual — the evidence itself is intact.',
  h265:
    'This browser has no H.265 (HEVC) decoder. HEVC support is a licensing decision made when the ' +
    'browser is built, so an open-source Chromium build refuses files that branded Chrome, Edge, ' +
    'Safari and Firefox all play. The evidence is intact — open it in one of those, or download it.',
};

/** A probe function, injectable so tests can supply another engine's measured answers. */
export type CanPlayType = (type: string) => string;

function defaultProbe(): CanPlayType | undefined {
  if (typeof document === 'undefined') return undefined;
  const element = document.createElement('video');
  /* jsdom defines the method and answers `''` to everything — see the note in `probeAvailable`. */
  if (typeof element.canPlayType !== 'function') return undefined;
  return (type: string) => element.canPlayType(type);
}

/**
 * ⚠️ **jsdom answers `''` to every probe**, which reads as "nothing is playable".
 *
 * That is why the P-5.5 defect survived a green test suite: no rendered-outcome test could see it.
 * A test environment that claims every format is undecodable is not measuring, so this module
 * detects the condition — an engine that refuses even a bare `video/mp4` container, which no real
 * browser does — and answers `unknown` rather than papering the whole player with a false alarm.
 * Tests that *do* want to assert a verdict inject a probe explicitly.
 */
function probeIsHonest(probe: CanPlayType): boolean {
  return probe('video/mp4') !== '' || probe('video/webm') !== '';
}

/**
 * Can this browser decode it?
 *
 * @param contentType the stored MIME type, e.g. `video/mp4`
 * @param codec the manifest's friendly codec name, when it declared one
 * @param probe injected for tests; defaults to a detached `<video>` element
 */
export function codecVerdict(
  contentType: string,
  codec?: CameraCodec | string | undefined,
  probe: CanPlayType | undefined = defaultProbe(),
): CodecVerdict {
  if (probe === undefined) return { support: 'unknown', probed: [] };
  if (!probeIsHonest(probe)) return { support: 'unknown', probed: [] };

  /* Still images and audio are not this check's business — the `<img>` tag has no codec question. */
  if (!contentType.startsWith('video/')) return { support: 'unknown', probed: [] };

  const container = contentType.split(';')[0]?.trim() ?? contentType;

  /*
   * ⚠️ The container gate comes first and it is the one that fails closed. Measured: Chrome and
   * Chromium answer `''` to `video/quicktime` while Firefox and Safari answer `maybe` — a `.mov`
   * export, which is ordinary for CCTV, genuinely will not open in Chrome. No codec string rescues
   * a container the engine will not demux.
   */
  if (probe(container) === '') {
    return {
      support: 'unsupported',
      reason: `This browser cannot open ${container} files. The evidence is intact — download the original to review it elsewhere.`,
      probed: [container],
    };
  }

  const candidates = codecCandidates(codec);
  if (candidates.length === 0) {
    /*
     * ⚠️ The container opens and the manifest declares no codec we can translate. That is genuinely
     * unknown, not "fine" — the file may still fail to decode, and the error overlay will say so.
     */
    return { support: 'unknown', probed: [container] };
  }

  const probed = candidates.map((c) => `${container}; codecs="${c}"`);
  /* Best answer wins — see the `hvc1`/`hev1` note above. */
  const playable = probed.some((type) => probe(type) !== '');
  if (playable) return { support: 'supported', probed };

  const advice = isKnownCodec(codec) ? CODEC_ADVICE[codec] : undefined;
  return {
    support: 'unsupported',
    reason:
      advice ??
      `This browser reports no decoder for ${String(codec)}. The evidence is intact — download the original to review it elsewhere.`,
    probed,
  };
}

function isKnownCodec(codec: unknown): codec is CameraCodec {
  return codec === 'h264' || codec === 'h265';
}

/** The RFC 6381 strings to try for a stored codec name. Empty when we cannot translate it. */
export function codecCandidates(codec?: string | undefined): readonly string[] {
  if (codec === undefined) return [];
  if (isKnownCodec(codec)) return RFC6381_CANDIDATES[codec];
  /*
   * ⚠️ An unrecognised codec is passed through **only if it already looks like RFC 6381** (it has a
   * dot-separated profile suffix). A bare friendly name we do not know — `mjpeg`, a future enum
   * member — yields no candidates and therefore `unknown`, never a false "unsupported". This is the
   * enum-extension hazard again: a value added to `CameraCodec` after this file was written must
   * degrade to "we did not check", not to "your browser cannot play it".
   */
  return /^[a-z0-9]+\.[\w.]+$/i.test(codec) ? [codec] : [];
}

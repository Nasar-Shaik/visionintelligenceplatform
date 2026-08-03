/**
 * Domain: resolving a **playback session** over one evidence item (P-5.5).
 *
 * Pure. Handed an evidence document and a signed target, it decides the wall-clock range, the
 * segments, and — the part that matters — **what the player is honestly allowed to offer**.
 *
 * ### ⚠️ Capabilities are read off the media, never assumed
 *
 * `PlaybackCapabilities` exists because a control offered on a source that cannot perform it is
 * worse than an absent one: the operator presses it, nothing happens, and they conclude the product
 * is unreliable. So every flag here is derived from what the record actually says.
 *
 * ⚠️ **`frameStep` is the honest one.** Frame-accurate stepping needs seekable, keyframe-dense
 * video. A single materialised MP4 is seekable; whether its keyframes are dense enough for
 * *accurate* stepping is not knowable from the manifest. This resolver claims `frameStep` only for
 * a video clip whose codec the manifest declares — a still image cannot step at all, and a clip
 * with no declared codec is a container we have not looked inside.
 */
import type { Evidence, PlaybackCapabilities, PlaybackSession } from '@vip/contracts';

/** Playback speeds the platform offers for a seekable video source. */
const VIDEO_RATES = [0.25, 0.5, 1, 2, 4, 8] as const;

export interface PlaybackResolution {
  /** The signed target for the stored object. */
  url: string;
  expiresInSeconds: number;
  now: Date;
}

function isVideo(contentType: string): boolean {
  return contentType.startsWith('video/');
}

/**
 * What this item can actually do.
 *
 * ⚠️ `snapshot` and `export` are both **false, always, in this build** — no renderer extracts a
 * still and no packager builds an export (TD-16). Advertising either would put a button on the
 * screen that fails, which is the failure this whole structure exists to prevent.
 */
export function capabilitiesFor(evidence: Evidence): PlaybackCapabilities {
  const video = isVideo(evidence.media.contentType);
  const hasCodec = evidence.media.codec !== undefined;
  return {
    /* Byte-range requests: the object stores serve them, so scrubbing does not pull the whole file. */
    seek: video,
    /* ⚠️ See the module note — a declared codec is the weakest evidence that stepping will be true. */
    frameStep: video && hasCodec,
    rates: video ? [...VIDEO_RATES] : [1],
    /* No snapshot renderer exists. */
    snapshot: false,
    /* No export packager exists (TD-16). */
    export: false,
  };
}

/**
 * Resolve the session.
 *
 * ⚠️ **`durationSeconds` is wall clock and `playableSeconds` is footage**, and they are equal here
 * because a single stored object is genuinely continuous — the difference only becomes non-zero
 * when a source spans several recordings. `gaps` is therefore empty and that emptiness is a *fact*
 * about this item, not a shrug: an evidence clip has no holes in it, because it is one file.
 *
 * ⚠️ A **snapshot has zero duration**, not a nominal one. A still frame given an invented second of
 * duration draws a scrubber that can be dragged, on an image that cannot move.
 */
export function resolveSession(
  evidence: Evidence,
  resolution: PlaybackResolution,
): PlaybackSession {
  const startedAt = evidence.interval?.startedAt ?? evidence.capturedAt;
  const endedAt = evidence.interval?.endedAt ?? evidence.capturedAt;
  const durationSeconds = evidence.interval?.durationSeconds ?? 0;

  const segments =
    durationSeconds > 0
      ? [
          {
            id: `${evidence.id}-0`,
            key: evidence.media.storageKey,
            url: resolution.url,
            expiresInSeconds: resolution.expiresInSeconds,
            contentType: evidence.media.contentType,
            ...(evidence.media.codec !== undefined ? { codec: evidence.media.codec } : {}),
            startedAt,
            endedAt,
            durationSeconds,
            offsetSeconds: 0,
            sizeBytes: evidence.media.integrity.sizeBytes,
          },
        ]
      : /*
         * ⚠️ A snapshot still gets a segment — the player needs the signed URL to show the image —
         * but with zero duration, so nothing downstream computes a timeline over it.
         */
        [
          {
            id: `${evidence.id}-0`,
            key: evidence.media.storageKey,
            url: resolution.url,
            expiresInSeconds: resolution.expiresInSeconds,
            contentType: evidence.media.contentType,
            startedAt,
            endedAt,
            durationSeconds: 0,
            offsetSeconds: 0,
            sizeBytes: evidence.media.integrity.sizeBytes,
          },
        ];

  return {
    tenantId: evidence.tenantId,
    source: { kind: 'evidence', id: evidence.id },
    startedAt,
    endedAt,
    durationSeconds,
    playableSeconds: durationSeconds,
    segments,
    /* ⚠️ Genuinely continuous — one stored object. See the note above. */
    gaps: [],
    /*
     * ⚠️ Empty because **nothing produces them**, not because none were found. No marker extractor,
     * bookmark store or annotation store exists in this build; the workspace reports each as
     * `not-built` rather than as an empty result.
     */
    markers: [],
    bookmarks: [],
    annotations: [],
    capabilities: capabilitiesFor(evidence),
    derivedAt: resolution.now.toISOString(),
  };
}

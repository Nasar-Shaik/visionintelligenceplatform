import type { Camera, StreamStatus } from '@vip/contracts';

/**
 * **What this camera can actually do — and how the platform knows.**
 *
 * ### ⚠️ Why this file exists
 *
 * A capability list is the easiest place in a security product to lie. Every field below could be
 * filled from a vendor datasheet, a model number, or an assumption that "ONVIF cameras do PTZ", and
 * the screen would look identical to one built from measurements. The difference only shows up on
 * the night somebody needs the capability and it is not there.
 *
 * So each row carries **where the belief came from**, using the platform's existing evidence
 * vocabulary rather than a new one:
 *
 * | class          | meaning                                                                    |
 * | -------------- | -------------------------------------------------------------------------- |
 * | `measured`     | the platform read it off the device — a probe decoded frames, ONVIF answered |
 * | `validated`    | a real exchange with the device confirmed it, short of decoding pixels       |
 * | `declared`     | discovery or an operator wrote it down. It has never been tested             |
 * | `not-built`    | the **platform** cannot do this for any camera yet, and the milestone says so |
 *
 * ⚠️ **`declared` is not a lesser shade of `supported`.** A camera whose PTZ is declared and never
 * exercised is a camera nobody has panned. The UI renders the class, never just the tick.
 *
 * ⚠️ **Nothing here is inferred from a vendor or model string.** If the platform has not measured or
 * been told, the answer is `unknown`, which is a fact about the platform and not about the camera.
 */
export type CapabilityEvidence = 'measured' | 'validated' | 'declared' | 'not-built' | 'unknown';

export interface CapabilityRow {
  /** Stable key, for tests and for the DOM. */
  id: string;
  label: string;
  /** `true` supported · `false` not supported · `null` nobody knows. */
  supported: boolean | null;
  evidence: CapabilityEvidence;
  /** One line an operator can act on: what was seen, or what would settle it. */
  detail: string;
}

/** ISO timestamp → "3 days ago"-ish, short enough for a table cell. */
function ago(iso: string | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return 'unknown';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The capability table for one camera.
 *
 * ⚠️ Ordered by what an operator asks first (can I see it, can I keep it, can I search it), not by
 * the order the fields happen to appear in the contract.
 */
/**
 * @param stream `undefined` = the console did not ask, or media did not answer · `null` = media
 * answered and there is **no worker** for this camera · an object = a live worker. ⚠️ Collapsing the
 * first two would turn "we cannot tell whether this is being recorded" into "it is not being
 * recorded", which is the reading that lets somebody assume footage exists when it does not.
 */
export function capabilityTruth(
  camera: Camera,
  stream: StreamStatus | null | undefined,
): CapabilityRow[] {
  const caps = camera.capabilities;
  const op = camera.operational;
  const cache = camera.capabilityCache;
  const probed = op !== undefined;
  const framesSeen = op?.streamAvailable === true || op?.lastFrameAt !== undefined;

  /** Declared capabilities all share one provenance line — where the list came from, and when. */
  const declaredFrom = cache
    ? `declared by ${cache.source === 'operator' ? 'an operator' : cache.source}, read ${ago(cache.lastRefreshedAt ?? cache.discoveredAt)}`
    : 'declared at onboarding and never re-read';

  const rows: CapabilityRow[] = [
    {
      id: 'rtsp',
      label: 'RTSP stream',
      supported: framesSeen ? true : probed ? (op?.reachable ?? null) : null,
      evidence: framesSeen ? 'measured' : probed ? 'validated' : 'unknown',
      detail: framesSeen
        ? `frames decoded from the stream, last ${ago(op?.lastFrameAt)}`
        : probed
          ? op?.reachable === true
            ? 'the device answered, but no frame has been decoded'
            : 'the device did not answer the last probe'
          : 'never probed — run a stream probe to find out',
    },
    {
      id: 'live',
      label: 'Live view',
      supported: false,
      evidence: 'not-built',
      detail:
        'no browser plays RTSP and the platform has no repackager — live view is P-8 (L-3, TD-28)',
    },
    {
      /*
       * ⚠️ Recording is a fact about a **stream worker**, not about a device, so it comes from the
       * media service and not from the camera record. `undefined` means the console did not ask or
       * could not reach media — reported as unknown rather than as "not recording", which is the
       * one reading that would let somebody assume footage exists when it does not.
       */
      id: 'recording',
      label: 'Recording',
      supported: stream === undefined ? null : stream === null ? false : stream.recording,
      evidence: stream === undefined ? 'unknown' : 'measured',
      detail:
        stream === undefined
          ? 'the media service did not answer — recording state is unknown, not "off"'
          : stream === null
            ? 'the media service has no worker for this camera — nothing is being recorded'
            : stream.recording
              ? `segments are being written · state ${stream.state} since ${ago(stream.since)}${
                  stream.lastSegmentAt ? `, last segment ${ago(stream.lastSegmentAt)}` : ''
                }`
              : `a worker exists but is not recording · state ${stream.state}${
                  stream.lastError ? ` · ${stream.lastError}` : ''
                }`,
    },
    {
      id: 'playback',
      label: 'Playback of recorded video',
      supported: stream?.lastSegmentAt !== undefined ? true : null,
      evidence: stream?.lastSegmentAt !== undefined ? 'measured' : 'unknown',
      detail:
        stream?.lastSegmentAt !== undefined
          ? `at least one segment has been written (last ${ago(stream.lastSegmentAt)})`
          : 'playback needs recorded segments or attached evidence; none is known to this panel',
    },
    {
      id: 'export',
      label: 'Evidence export bundle',
      supported: false,
      evidence: 'not-built',
      detail: 'no export generator exists in the platform — P-11 (C-48)',
    },
    {
      id: 'snapshot',
      label: 'Snapshot',
      supported: caps.snapshot,
      evidence: 'declared',
      detail: caps.snapshot ? declaredFrom : 'the device is not recorded as offering a still image',
    },
    {
      id: 'ptz',
      label: 'PTZ',
      supported: caps.ptz,
      evidence: 'declared',
      detail: caps.ptz
        ? `${declaredFrom} — ⚠️ never exercised: the platform has no PTZ control surface`
        : 'not declared by discovery or by an operator',
    },
    {
      id: 'audio',
      label: 'Audio track',
      supported: caps.audio,
      evidence: 'declared',
      detail: caps.audio ? declaredFrom : 'no audio track was declared for this stream',
    },
    {
      /*
       * ⚠️ **There is no declared ONVIF flag, so there is no declared ONVIF answer.**
       *
       * `CameraProtocol` is `rtsp | rtmp`; ONVIF is a device service, not a stream transport, and
       * the only place the platform records it is `operational.onvifAvailable` — which is set by a
       * probe that actually spoke to the device. A camera that has never been probed therefore reads
       * **unknown** here. Reading a model number and answering "yes, it is an ONVIF camera" is
       * exactly the vendor-assumption this panel exists to refuse.
       */
      id: 'onvif',
      label: 'ONVIF',
      supported: op?.onvifAvailable ?? caps.onvif,
      evidence: op?.onvifAvailable !== undefined ? 'measured' : caps.onvif ? 'declared' : 'unknown',
      detail:
        op?.onvifAvailable !== undefined
          ? `the device ${op.onvifAvailable ? 'answered' : 'did not answer'} ONVIF when probed ${ago(op.observedAt)}`
          : caps.onvif
            ? declaredFrom
            : 'no probe has spoken ONVIF to this device, and none was declared',
    },
    {
      /*
       * ⚠️ The device may *offer* an analytics/metadata stream; the platform does not consume one.
       * Both halves are said, because "supported" alone would read as "we are using it".
       */
      id: 'metadata-stream',
      label: 'ONVIF metadata stream',
      supported: caps.metadataStream ? true : null,
      evidence: caps.metadataStream ? 'declared' : 'unknown',
      detail: caps.metadataStream
        ? `the device offers one (${declaredFrom}) — ⚠️ the platform does not read it`
        : 'not declared, and the platform would not read one today',
    },
    {
      id: 'codecs',
      label: 'Codecs',
      supported: caps.codecs.length > 0 ? true : null,
      evidence: camera.compatibility.length > 0 ? 'measured' : 'declared',
      detail:
        caps.codecs.length > 0
          ? `${caps.codecs.map((c) => c.toUpperCase()).join(', ')} — ${
              camera.compatibility.length > 0
                ? 'seen in a real stream'
                : `${declaredFrom}, not yet seen in a stream`
            }`
          : 'no codec has been declared or observed',
    },
    {
      id: 'resolutions',
      label: 'Resolutions',
      supported: caps.resolutions.length > 0 ? true : null,
      evidence: 'declared',
      detail:
        caps.resolutions.length > 0
          ? `${caps.resolutions.join(', ')} — ${declaredFrom}`
          : 'no resolution list has been read from this device',
    },
    {
      id: 'health',
      label: 'Health reporting',
      supported: probed,
      evidence: probed ? 'measured' : 'unknown',
      detail: probed
        ? `last observed ${ago(op?.observedAt)} via ${op?.source}`
        : 'nothing has ever probed this camera — which is not the same as it being offline',
    },
    {
      id: 'motion',
      label: 'Motion events from the device',
      supported: null,
      evidence: 'unknown',
      detail:
        'the platform does not subscribe to device-side motion events; events come from rules over what it sees',
    },
    {
      id: 'ai',
      label: 'AI analysis',
      supported: false,
      evidence: 'not-built',
      detail:
        'no camera is analysed: the media service discards frames (NullFrameSink) and nothing consumes them — P-8',
    },
  ];

  return rows;
}

/** Grouped counts for the panel's one-line summary. */
export function capabilitySummaryCounts(rows: CapabilityRow[]): {
  measured: number;
  declared: number;
  unavailable: number;
  unknown: number;
} {
  return {
    measured: rows.filter((r) => r.evidence === 'measured' || r.evidence === 'validated').length,
    declared: rows.filter((r) => r.evidence === 'declared').length,
    unavailable: rows.filter((r) => r.evidence === 'not-built').length,
    unknown: rows.filter((r) => r.evidence === 'unknown').length,
  };
}

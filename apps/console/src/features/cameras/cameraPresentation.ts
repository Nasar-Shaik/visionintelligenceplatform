import type {
  Camera,
  CameraCapabilities,
  CameraEvidenceSeverity,
  CameraEvidenceSource,
  EvidenceProducer,
  OperationalDecisionKind,
  CameraHealthStatus,
  CameraLifecycleState,
  CapabilityCache,
  CapabilityChangeSeverity,
  CapabilityDrift,
  CompatibilityStatus,
  IdentityConfidence,
  OperationalConfidenceBand,
  ProbeOutcome,
  StreamProbeCheck,
  StreamProbeFailureCode,
  ValidationProvider,
} from '@vip/contracts';
import type { StatusKind } from '@/lib/status';

/** Camera health → design-system status token. Shared by the list, the detail sheet and the dashboard. */
export const HEALTH_KIND: Record<CameraHealthStatus, StatusKind> = {
  online: 'ok',
  unhealthy: 'warn',
  offline: 'error',
  unknown: 'idle',
};

export const HEALTH_LABEL: Record<CameraHealthStatus, string> = {
  online: 'Online',
  unhealthy: 'Unhealthy',
  offline: 'Offline',
  unknown: 'Unknown',
};

/**
 * The stream profile the runtime will actually analyze, and why it matters to show it.
 *
 * Analyzing a 4K main stream when a 640×360 sub-stream would do wastes decode and inference budget
 * on every frame, forever — it is the cheapest performance decision in the platform. An operator who
 * cannot see which profile is selected cannot tell whether their site is making it.
 */
export function analysisProfile(capabilities?: CameraCapabilities) {
  const profiles = capabilities?.streamProfiles ?? [];
  return profiles.find((p) => p.preferredForAnalysis) ?? null;
}

/** A one-line capability summary for a list row. Empty when nothing has been declared or discovered. */
export function capabilitySummary(capabilities?: CameraCapabilities): string {
  if (!capabilities) return '';
  const parts: string[] = [];
  const profile = analysisProfile(capabilities);
  if (profile?.resolution) parts.push(profile.resolution);
  else if (capabilities.resolutions[0]) parts.push(capabilities.resolutions[0]);
  if (capabilities.codecs.length > 0) parts.push(capabilities.codecs.join('/').toUpperCase());
  if (capabilities.fpsRange)
    parts.push(`${capabilities.fpsRange.min}–${capabilities.fpsRange.max} fps`);
  if (capabilities.onvif) parts.push('ONVIF');
  if (capabilities.ptz) parts.push('PTZ');
  return parts.join(' · ');
}

/** Free-text match across the fields an operator would actually search a camera list by. */
export function matchesSearch(camera: Camera, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (needle === '') return true;
  return [
    camera.name,
    camera.streamUrl,
    camera.zoneId,
    camera.metadata.manufacturer,
    camera.metadata.model,
    camera.metadata.location,
    ...camera.metadata.tags,
  ]
    .filter((v): v is string => typeof v === 'string')
    .some((v) => v.toLowerCase().includes(needle));
}

/**
 * Build the per-channel cameras for a DVR/NVR (P-1).
 *
 * DVR channel URLs are formulaic — `?channel=N&subtype=1` for Dahua, `/Streaming/Channels/N02` for
 * Hikvision — which is precisely why adding 16 of them by hand is both tedious and error-prone. The
 * template carries `{channel}` and is expanded here; the caller submits the result as one bulk add
 * and gets a per-channel outcome back.
 */
export function dvrChannels(options: {
  namePrefix: string;
  zoneId: string;
  baseUrl: string;
  pathTemplate: string;
  channels: number;
  startAt?: number;
}): Array<{ zoneId: string; name: string; protocol: 'rtsp'; streamUrl: string }> {
  const start = options.startAt ?? 1;
  const base = options.baseUrl.replace(/\/+$/, '');
  return Array.from({ length: options.channels }, (_, i) => {
    const channel = start + i;
    const path = options.pathTemplate.replaceAll('{channel}', String(channel));
    return {
      zoneId: options.zoneId,
      name: `${options.namePrefix} ${channel}`,
      protocol: 'rtsp' as const,
      streamUrl: `${base}${path.startsWith('/') ? path : `/${path}`}`,
    };
  });
}

/** Channel-path templates for the estates the pilot market actually has. */
export const DVR_TEMPLATES = [
  {
    id: 'hikvision',
    label: 'Hikvision (sub-stream)',
    template: '/Streaming/Channels/{channel}02',
  },
  {
    id: 'dahua',
    label: 'Dahua / CP Plus (sub-stream)',
    template: '/cam/realmonitor?channel={channel}&subtype=1',
  },
  { id: 'uniview', label: 'UNV (sub-stream)', template: '/media/video{channel}_2' },
  { id: 'custom', label: 'Custom template', template: '/channel/{channel}' },
] as const;

// --- P-2: lifecycle presentation ---------------------------------------------------------------

export const LIFECYCLE_LABEL: Record<CameraLifecycleState, string> = {
  discovered: 'Discovered',
  validated: 'Validated',
  configured: 'Configured',
  connected: 'Connected',
  monitoring: 'Monitoring',
  degraded: 'Degraded',
  offline: 'Offline',
  retired: 'Retired',
};

/**
 * Lifecycle state → design-system status token.
 *
 * `configured` is deliberately `idle` rather than `ok`: a camera that has been set up but never
 * measured is not a healthy camera, and colouring it green is how an operator comes to believe an
 * estate is working when nothing has ever connected to it.
 */
export const LIFECYCLE_KIND: Record<CameraLifecycleState, StatusKind> = {
  discovered: 'idle',
  validated: 'idle',
  configured: 'idle',
  connected: 'ok',
  monitoring: 'ok',
  degraded: 'warn',
  offline: 'error',
  retired: 'idle',
};

/** One line explaining what a lifecycle state actually means, for the operator who has not read the ADR. */
export const LIFECYCLE_MEANING: Record<CameraLifecycleState, string> = {
  discovered: 'Found on the network. Nothing about it has been verified.',
  validated: 'Its configuration passes the checks. No device has been contacted.',
  configured: 'Ready to be tested. Nothing has measured this camera yet.',
  connected: 'Measured: frames were read from the physical device.',
  monitoring: 'Measured: analysis is running on this camera.',
  degraded: 'Measured: reachable, but not working properly.',
  offline: 'Measured: the device could not be reached.',
  retired: 'Decommissioned. The record and its history are kept.',
};

/** Probe check status → the glyph an installer scans down the list for. */
export const CHECK_GLYPH: Record<StreamProbeCheck['status'], string> = {
  pass: '✓',
  fail: '✗',
  warn: '!',
  skipped: '·',
  'not-executed': '–',
};

export const CHECK_KIND: Record<StreamProbeCheck['status'], StatusKind> = {
  pass: 'ok',
  fail: 'error',
  warn: 'warn',
  skipped: 'idle',
  'not-executed': 'idle',
};

/** Human labels for the ordered probe stages. */
export const CHECK_LABEL: Record<string, string> = {
  dns: 'Name resolved',
  tcp: 'Device reachable',
  authentication: 'Authentication',
  'rtsp-negotiation': 'RTSP negotiated',
  'stream-open': 'Stream opened',
  'first-frame': 'First frame received',
  'frames-received': 'Video stream started',
  codec: 'Codec',
  resolution: 'Resolution',
  fps: 'Frame rate',
  'stream-profile': 'Stream profile',
  latency: 'Latency',
  jitter: 'Jitter',
};

/**
 * The failure headline, keyed on the code **the runtime assigned**.
 *
 * P-2 derived this in the console by finding the first failing check. That was inference — business
 * logic in the visualization tier (Architect P-2.1 rec 10) — and it would have drifted from the
 * runtime the first time a stage was renamed. The runtime now names the failure; this map is the
 * only thing the console adds, and it adds words, not judgement.
 */
export const FAILURE_LABEL: Record<StreamProbeFailureCode, string> = {
  'configuration-invalid': 'The configuration cannot work',
  'dns-failure': 'The hostname did not resolve',
  'tcp-failure': 'The device could not be reached',
  'authentication-failure': 'The device rejected the credentials',
  'rtsp-negotiation-failure': 'The device would not serve this stream',
  'codec-unsupported': 'The codec is not supported',
  timeout: 'The stream opened but sent no video',
  'no-first-frame': 'No frame arrived',
  'stream-interrupted': 'The stream dropped',
};

/** What to try next. Static copy per code — no inspection of the result, by design. */
export const FAILURE_REMEDY: Record<StreamProbeFailureCode, string> = {
  'configuration-invalid': 'Check the stream URL and protocol.',
  'dns-failure': 'Check DNS, or use the IP address instead of a hostname.',
  'tcp-failure': 'Check power, cabling, the port and any firewall between here and the camera.',
  'authentication-failure': 'Check the username and password on the camera itself.',
  'rtsp-negotiation-failure':
    'Check the stream path — the camera is reachable but rejects this one.',
  'codec-unsupported': 'Set the camera to H.264 or H.265.',
  timeout: 'The camera may be set to a profile it cannot encode. Try the sub-stream.',
  'no-first-frame': 'The camera accepted the connection then sent nothing. Reboot it and retry.',
  'stream-interrupted': 'The link is unstable. Check wireless signal or switch port errors.',
};

/** Severity of a capability change → design-system token. */
export const SEVERITY_KIND: Record<CapabilityChangeSeverity, StatusKind> = {
  minor: 'idle',
  major: 'warn',
  security: 'error',
};

/** Cache freshness → design-system token. `unknown` is idle, not ok: nothing has confirmed it. */
export const FRESHNESS_KIND: Record<NonNullable<CapabilityCache['freshness']>, StatusKind> = {
  fresh: 'ok',
  aging: 'warn',
  expired: 'error',
  unknown: 'idle',
};

export const FRESHNESS_LABEL: Record<NonNullable<CapabilityCache['freshness']>, string> = {
  fresh: 'Fresh',
  aging: 'Aging',
  expired: 'Expired',
  unknown: 'Never confirmed',
};

/** How an identity match should be described. A low match is shown as low, never as a match. */
export const CONFIDENCE_LABEL: Record<IdentityConfidence, string> = {
  high: 'Matched by device identity',
  medium: 'Matched by hardware address',
  low: 'Matched by network address only',
  unknown: 'No reliable identifier',
};

/**
 * Drift → design-system token (P-2.2). `expected` is deliberately `idle` rather than `ok`: a change
 * that was accounted for is not good news, it is merely explained.
 */
export const DRIFT_KIND: Record<CapabilityDrift, StatusKind> = {
  expected: 'idle',
  unexpected: 'warn',
};

export const DRIFT_LABEL: Record<CapabilityDrift, string> = {
  expected: 'Expected',
  unexpected: 'Unexpected',
};

/** Operational confidence → token. Never used for AI confidence; they are different measurements. */
export const CONFIDENCE_BAND_KIND: Record<OperationalConfidenceBand, StatusKind> = {
  stable: 'ok',
  intermittent: 'warn',
  failing: 'error',
  'insufficient-evidence': 'idle',
};

export const CONFIDENCE_BAND_LABEL: Record<OperationalConfidenceBand, string> = {
  stable: 'Stable',
  intermittent: 'Intermittent',
  failing: 'Frequently failing',
  'insufficient-evidence': 'Not enough evidence',
};

/** Compatibility status → token. `pending-validation` is idle: nothing has been claimed either way. */
export const COMPATIBILITY_KIND: Record<CompatibilityStatus, StatusKind> = {
  supported: 'ok',
  'pending-validation': 'idle',
  unsupported: 'error',
};

export const COMPATIBILITY_LABEL: Record<CompatibilityStatus, string> = {
  supported: 'Supported',
  'pending-validation': 'Pending validation',
  unsupported: 'Unsupported',
};

export const PROBE_OUTCOME_KIND: Record<ProbeOutcome, StatusKind> = {
  succeeded: 'ok',
  failed: 'error',
  // A probe that could not run measured nothing. That is neither a pass nor a camera fault.
  unavailable: 'idle',
};

export const PROBE_OUTCOME_LABEL: Record<ProbeOutcome, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  unavailable: 'Could not run',
};

/**
 * Which record an evidence entry came from.
 *
 * **Partial by design, and read through `evidenceSourceLabel`.** The unified timeline is the
 * platform's only investigation API (P-2.3 rec 6), which means a future producer must be able to
 * appear in it without a console release. An exhaustive `Record` would make that a compile error
 * here and a blank cell in production; a lookup with a fallback renders the new source's own name.
 */
export const EVIDENCE_SOURCE_LABEL: Partial<Record<CameraEvidenceSource, string>> = {
  lifecycle: 'State',
  identity: 'Identity',
  capability: 'Capabilities',
  probe: 'Probe',
  compatibility: 'Compatibility',
  configuration: 'Configuration',
  diagnostics: 'Diagnostics',
  recovery: 'Recovery',
  certification: 'Certification',
  session: 'Session',
};

/** Title-case an unrecognised machine name, so an unknown source reads as words rather than a blank. */
function humanize(value: string): string {
  return value.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function evidenceSourceLabel(source: CameraEvidenceSource | string): string {
  return EVIDENCE_SOURCE_LABEL[source as CameraEvidenceSource] ?? humanize(source);
}

/** Evidence severity → design-system token. */
export const EVIDENCE_SEVERITY_KIND: Record<CameraEvidenceSeverity, StatusKind> = {
  info: 'idle',
  // `notice` is "worth reading", not "good". `ok` would put a green tick beside a state change,
  // which reads as an all-clear on the one row that is telling you something changed.
  notice: 'idle',
  warning: 'warn',
};

/** Who produced a piece of evidence — the chain of custody, in words. */
export const PRODUCER_LABEL: Partial<Record<EvidenceProducer, string>> = {
  'camera-service': 'Camera service',
  'ai-runtime': 'AI runtime',
  discovery: 'Discovery',
  operator: 'Operator',
};

export function producerLabel(producer: EvidenceProducer | string): string {
  return PRODUCER_LABEL[producer as EvidenceProducer] ?? humanize(producer);
}

/** What kind of decision the platform made. Read through a fallback for the same reason as above. */
export const DECISION_KIND_LABEL: Partial<Record<OperationalDecisionKind, string>> = {
  'lifecycle-state': 'Lifecycle state',
  'probe-outcome': 'Probe outcome',
  'capability-refresh': 'Capability refresh',
  'capability-drift': 'Capability drift',
  'compatibility-status': 'Compatibility',
  confidence: 'Confidence',
};

export function decisionKindLabel(kind: OperationalDecisionKind | string): string {
  return DECISION_KIND_LABEL[kind as OperationalDecisionKind] ?? humanize(kind);
}

/** How each validation provider should be named to an operator. */
export const PROVIDER_LABEL: Record<ValidationProvider, string> = {
  rtsp: 'RTSP',
  rtsps: 'RTSP over TLS',
  rtmp: 'RTMP',
  rtmps: 'RTMP over TLS',
  http: 'HTTP / MJPEG',
  https: 'HTTPS / MJPEG',
  srt: 'SRT',
  webrtc: 'WebRTC',
  'onvif-pullpoint': 'ONVIF PullPoint',
  'recorded-video': 'Recorded video',
  'dvr-export': 'DVR export',
  'nvr-playback': 'NVR playback',
  'usb-camera': 'USB camera',
  'edge-stream': 'Edge stream',
  simulated: 'Simulated source',
  unknown: 'Unknown source',
};

/** Format a stage duration the way an installer reads it. */
export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

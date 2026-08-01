import type {
  Camera,
  CameraCapabilities,
  CameraHealthStatus,
  CameraLifecycleState,
  StreamProbeCheck,
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
  'not-executed': '–',
};

export const CHECK_KIND: Record<StreamProbeCheck['status'], StatusKind> = {
  pass: 'ok',
  fail: 'error',
  warn: 'warn',
  'not-executed': 'idle',
};

/** Human labels for the ordered probe checks. */
export const CHECK_LABEL: Record<string, string> = {
  reachability: 'Device reachable',
  authentication: 'Authentication',
  'stream-open': 'RTSP opened',
  'frames-received': 'Stream started',
  codec: 'Codec',
  resolution: 'Resolution',
  fps: 'Frame rate',
  latency: 'Latency',
  jitter: 'Jitter',
};

/**
 * The one line to lead a failed test-connection with.
 *
 * The **first** failing check in the ordered list, because the checks are ordered by causation:
 * everything after the first failure is a consequence, and leading with a consequence is what sends
 * an installer to re-run cable for a password problem.
 */
export function probeHeadline(checks: readonly StreamProbeCheck[]): string | null {
  const failed = checks.find((c) => c.status === 'fail');
  if (failed) return `${CHECK_LABEL[failed.name] ?? failed.name} failed`;
  const warned = checks.find((c) => c.status === 'warn');
  if (warned) return `${CHECK_LABEL[warned.name] ?? warned.name} is below par`;
  return null;
}

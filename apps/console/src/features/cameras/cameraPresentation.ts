import type { Camera, CameraCapabilities, CameraHealthStatus } from '@vip/contracts';
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

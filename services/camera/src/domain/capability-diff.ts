/**
 * Domain: what changed between two capability reads (P-2.1, Architect P-2 rec 2 + P-2.1 rec 2).
 *
 * "Capabilities refreshed" is not an answer. A camera that silently moved from 1080p H.264 to 4K
 * H.265 has just quadrupled what the platform spends decoding it on every frame, forever — and the
 * only place that becomes visible is a diff. Firmware strings change constantly and mean nothing
 * operationally; those two facts must not be presented with equal weight, which is what `severity`
 * is for.
 *
 * Pure and deterministic. Field paths are dotted (`streamProfiles.sub.resolution`) so a change can be
 * pointed at in a UI without the UI knowing the capability schema.
 */
import type {
  CameraCapabilities,
  CameraStreamProfile,
  CapabilityChange,
  CapabilityChangeSeverity,
} from '@vip/contracts';

/**
 * How much a field's change matters.
 *
 * The `major` set is exactly the set that changes what analysis **costs or receives**. Everything
 * that only changes what a screen says is `minor`. There is currently no `security` field in
 * `CameraCapabilities` — authentication mode and TLS live on the connection, not the capability set
 * — so the classifier is written to grow into it rather than pretending it already applies.
 */
const MAJOR_FIELDS = new Set([
  'codecs',
  'resolutions',
  'fpsRange',
  'streamProfiles',
  'protocols',
  'ptz',
]);
const SECURITY_FIELDS = new Set(['authentication', 'tls', 'credentialsRequired']);

export function severityFor(field: string): CapabilityChangeSeverity {
  const root = field.split('.')[0] ?? field;
  if (SECURITY_FIELDS.has(root)) return 'security';
  if (MAJOR_FIELDS.has(root)) return 'major';
  return 'minor';
}

/** Render a value the way an operator reads it. `undefined` means the field was absent. */
function render(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ');
  if (typeof value === 'object') {
    const range = value as { min?: number; max?: number };
    if (typeof range.min === 'number' && typeof range.max === 'number') {
      return `${range.min}–${range.max}`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function profileKey(profile: CameraStreamProfile): string {
  return profile.name;
}

/**
 * Diff two capability sets.
 *
 * Stream profiles are compared **by name**, not by position: devices reorder them between firmware
 * versions, and a positional diff would report every profile as changed every time a camera was
 * upgraded — noise that would train operators to ignore the feature.
 */
export function diffCapabilities(
  before: CameraCapabilities | undefined,
  after: CameraCapabilities,
): CapabilityChange[] {
  const changes: CapabilityChange[] = [];
  if (!before) return changes;

  const scalarFields: Array<keyof CameraCapabilities> = [
    'ptz',
    'audio',
    'snapshot',
    'onvif',
    'metadataStream',
    'codecs',
    'resolutions',
    'protocols',
    'fpsRange',
  ];

  for (const field of scalarFields) {
    const from = render(before[field]);
    const to = render(after[field]);
    if (from === to) continue;
    changes.push({
      field: String(field),
      severity: severityFor(String(field)),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    });
  }

  const beforeProfiles = new Map(before.streamProfiles.map((p) => [profileKey(p), p]));
  const afterProfiles = new Map(after.streamProfiles.map((p) => [profileKey(p), p]));

  for (const [name, profile] of afterProfiles) {
    const previous = beforeProfiles.get(name);
    if (!previous) {
      changes.push({
        field: `streamProfiles.${name}`,
        severity: 'major',
        to: describeProfile(profile),
      });
      continue;
    }
    for (const attr of ['resolution', 'fps', 'codec', 'preferredForAnalysis'] as const) {
      const from = render(previous[attr]);
      const to = render(profile[attr]);
      if (from === to) continue;
      changes.push({
        field: `streamProfiles.${name}.${attr}`,
        severity: 'major',
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      });
    }
  }

  for (const [name, profile] of beforeProfiles) {
    if (!afterProfiles.has(name)) {
      // A profile the platform was analysing that the device no longer publishes. Losing this
      // silently is how a camera ends up quietly falling back to its main stream.
      changes.push({
        field: `streamProfiles.${name}`,
        severity: 'major',
        from: describeProfile(profile),
      });
    }
  }

  return changes.slice(0, 50);
}

function describeProfile(profile: CameraStreamProfile): string {
  return [profile.resolution, profile.fps ? `${profile.fps} fps` : null, profile.codec]
    .filter(Boolean)
    .join(' · ');
}

/** The strongest severity present, or `null` for no changes — what a summary line should lead with. */
export function highestSeverity(
  changes: readonly CapabilityChange[],
): CapabilityChangeSeverity | null {
  if (changes.some((c) => c.severity === 'security')) return 'security';
  if (changes.some((c) => c.severity === 'major')) return 'major';
  if (changes.length > 0) return 'minor';
  return null;
}

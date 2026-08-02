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
  CapabilityChangeDirection,
  CapabilityChangeSeverity,
  CapabilityDrift,
  CapabilityDriftCause,
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

/**
 * What the diff produces: the fields that moved. Drift *classification* — whether a change was
 * accounted for and which way it went — is a separate step (`classifyDrift`), because it needs
 * context the diff does not have: what firmware was reported, and who asked for the write.
 */
export type CapabilityDelta = Omit<CapabilityChange, 'direction' | 'cause' | 'drift'>;

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
): CapabilityDelta[] {
  const changes: CapabilityDelta[] = [];
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
  changes: readonly Pick<CapabilityChange, 'severity'>[],
): CapabilityChangeSeverity | null {
  if (changes.some((c) => c.severity === 'security')) return 'security';
  if (changes.some((c) => c.severity === 'major')) return 'major';
  if (changes.length > 0) return 'minor';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Drift classification (P-2.2, Architect P-2.2 rec 3)
// ---------------------------------------------------------------------------------------------

/**
 * The fields that are **never** expected to change on their own, whatever else happened.
 *
 * The Architect's list, exactly: codec, resolution, FPS, authentication, and a profile going
 * missing. What these have in common is that every one of them changes what the platform receives or
 * what it costs to analyse — and none of them is a thing an operator upgrading firmware *intended*
 * to change. Attributing them to the upgrade would file the single most investigation-worthy event
 * on a camera under "explained, no action needed".
 */
const ALWAYS_UNEXPECTED = new Set(['codecs', 'resolutions', 'fpsRange', 'streamProfiles']);

/** Fields whose numeric magnitude is comparable, so a change can be called a regression. */
function magnitudeOf(field: string, value: string | undefined): number | null {
  if (value === undefined) return null;
  const leaf = field.split('.').pop() ?? field;
  if (leaf === 'resolution' || field === 'resolutions') {
    // Compare pixel counts, and for a list compare its largest member: a camera that dropped 4K but
    // kept VGA has lost something, and comparing list *lengths* would miss it entirely.
    const areas = [...value.matchAll(/(\d{2,5})x(\d{2,5})/g)].map(
      (m) => Number(m[1]) * Number(m[2]),
    );
    return areas.length > 0 ? Math.max(...areas) : null;
  }
  if (leaf === 'fps' || field === 'fpsRange') {
    const numbers = [...value.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    return numbers.length > 0 ? Math.max(...numbers) : null;
  }
  return null;
}

/** Which way a change moved. `changed` when the two values are not comparable as magnitudes. */
export function directionOf(change: CapabilityDelta): CapabilityChangeDirection {
  if (change.from === undefined) return 'added';
  if (change.to === undefined) return 'removed';
  const before = magnitudeOf(change.field, change.from);
  const after = magnitudeOf(change.field, change.to);
  if (before === null || after === null || before === after) return 'changed';
  return after < before ? 'reduced' : 'increased';
}

export interface DriftContext {
  /** The device reported different firmware in the same read. */
  firmwareChanged: boolean;
  /** This platform performed the write itself (an operator edit, a configuration update). */
  operatorInitiated?: boolean;
  /** Nothing was on file before — a first observation is not a change to explain. */
  firstObservation?: boolean;
}

/**
 * Attribute each change and decide whether it should raise operator attention (rec 3).
 *
 * Two rules, and the second is the one that matters:
 *
 * 1. **Cause is only ever what was observed.** A firmware string that moved in the same read, or a
 *    write this platform performed. Everything else is `unexplained` — which is not a shrug but the
 *    finding: a camera reconfigured by somebody outside this platform.
 * 2. **A named cause does not make a change expected.** Codec, resolution, FPS and stream profiles
 *    stay `unexpected` even under a firmware upgrade, and so does any *reduction* in anything.
 *    Nobody upgrades a camera intending to lose a stream profile, and "explained by the upgrade" is
 *    precisely how that would stop being investigated.
 */
export function classifyDrift(
  changes: readonly CapabilityDelta[],
  context: DriftContext,
): CapabilityChange[] {
  const cause: CapabilityDriftCause = context.firstObservation
    ? 'first-observation'
    : context.firmwareChanged
      ? 'firmware-upgrade'
      : context.operatorInitiated
        ? 'operator-update'
        : 'unexplained';

  return changes.map((change) => {
    const direction = directionOf(change);
    const root = change.field.split('.')[0] ?? change.field;
    const drift: CapabilityDrift =
      cause === 'first-observation'
        ? 'expected'
        : ALWAYS_UNEXPECTED.has(root) ||
            change.severity === 'security' ||
            direction === 'reduced' ||
            direction === 'removed' ||
            cause === 'unexplained'
          ? 'unexpected'
          : 'expected';
    return { ...change, direction, cause, drift };
  });
}

/** True when anything in this diff should be put in front of an operator. */
export function hasUnexpectedDrift(changes: readonly CapabilityChange[]): boolean {
  return changes.some((change) => change.drift === 'unexpected');
}

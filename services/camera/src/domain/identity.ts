/**
 * Domain: stable device identity and how a discovered device is matched to a managed camera (P-2).
 *
 * The platform keeps three identities for one camera and must never conflate them:
 *
 *   - **Device identity** — ONVIF UUID, serial, MAC. The hardware. Never changes.
 *   - **Network identity** — stream URL, IP, hostname. Changes freely and without warning.
 *   - **Operational identity** — tenant, zone, name. Changes when the estate is reorganised.
 *
 * P-1 matched discovered devices to existing cameras on the **network** identity alone, which is
 * correct until the first DHCP lease expires. After that the same physical camera answers from a new
 * address, fails to match, and is offered to the installer as a new device — who onboards it, and
 * now the estate has one camera twice, one of which will never connect again.
 *
 * Matching on device identity first fixes that, and turns the address change into information: the
 * console can offer to update the address instead of creating a duplicate.
 */
import type {
  CameraDeviceIdentity,
  CameraIdentityChange,
  IdentityAttribute,
  IdentityConfidence,
} from '@vip/contracts';

/** How many identity changes a camera keeps. Matches the `CameraIdentityHistory` contract bound. */
export const IDENTITY_HISTORY_LIMIT = 30;

/**
 * Normalize a stream URL for comparison. Scheme and host are case-insensitive per RFC 3986; the path
 * is not, because plenty of DVRs serve case-sensitive channel paths. A trailing slash is dropped —
 * `/live` and `/live/` are the same endpoint, and a false mismatch would have an installer onboard a
 * duplicate that then fails on the unique index.
 */
export function normalizeStreamUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const separator = trimmed.indexOf('://');
  if (separator < 0) return trimmed.toLowerCase();
  const scheme = trimmed.slice(0, separator).toLowerCase();
  const rest = trimmed.slice(separator + 3);
  const slash = rest.indexOf('/');
  if (slash < 0) return `${scheme}://${rest.toLowerCase()}`;
  return `${scheme}://${rest.slice(0, slash).toLowerCase()}${rest.slice(slash)}`;
}

/**
 * The strongest available identifier, as a comparable key — or `null` when the device offered none.
 *
 * Ordered by how much each one actually guarantees. An ONVIF UUID is assigned by the device and
 * survives a factory reset; a serial number is stamped on the hardware but is only as unique as the
 * manufacturer bothered to make it; a MAC identifies the *interface*, which is usually but not
 * always the same thing. `null` is a real answer: a device that will not identify itself must fall
 * back to network matching, not be assigned a fabricated identity.
 */
export function identityKey(identity: CameraDeviceIdentity | undefined): string | null {
  if (!identity) return null;
  if (identity.onvifUuid) return `uuid:${identity.onvifUuid.trim().toLowerCase()}`;
  if (identity.serialNumber) return `serial:${identity.serialNumber.trim().toLowerCase()}`;
  if (identity.macAddress) return `mac:${identity.macAddress.trim().toLowerCase()}`;
  if (identity.hardwareId) return `hw:${identity.hardwareId.trim().toLowerCase()}`;
  return null;
}

/** Normalize a MAC into the one spelling the contract accepts, or drop it if it is not one. */
export function normalizeMac(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[-.\s]/g, ':');
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(cleaned) ? cleaned : undefined;
}

export interface IdentifiableCamera {
  _id: string;
  streamUrl: string;
  identity?: CameraDeviceIdentity;
}

export interface DeviceMatch<T extends IdentifiableCamera> {
  camera: T;
  /** Which identity matched — the difference between "already added" and "it moved". */
  matchedOn: 'identity' | 'stream-url';
  /** True when identity matched but the network address did not. */
  addressChanged: boolean;
}

/**
 * Index a tenant's cameras for matching. Built once per discovery run rather than per device: a
 * 64-camera site scanned against 200 existing cameras is 12,800 comparisons done linearly, and a
 * discovery probe is already the slowest thing an installer waits on.
 */
export function buildMatchIndex<T extends IdentifiableCamera>(cameras: readonly T[]) {
  const byIdentity = new Map<string, T>();
  const byUrl = new Map<string, T>();
  for (const camera of cameras) {
    const key = identityKey(camera.identity);
    if (key) byIdentity.set(key, camera);
    byUrl.set(normalizeStreamUrl(camera.streamUrl), camera);
  }
  return { byIdentity, byUrl };
}

/**
 * Match one discovered device against the index. **Device identity wins over network identity** —
 * that ordering is the entire point of the module.
 */
export function matchDevice<T extends IdentifiableCamera>(
  index: ReturnType<typeof buildMatchIndex<T>>,
  device: { identity?: CameraDeviceIdentity; suggestedStreamUrl?: string },
): DeviceMatch<T> | null {
  const key = identityKey(device.identity);
  if (key) {
    const byIdentity = index.byIdentity.get(key);
    if (byIdentity) {
      const sameAddress =
        device.suggestedStreamUrl !== undefined &&
        normalizeStreamUrl(byIdentity.streamUrl) === normalizeStreamUrl(device.suggestedStreamUrl);
      return {
        camera: byIdentity,
        matchedOn: 'identity',
        // No suggested URL means discovery could not derive one; that is unknown, not changed.
        addressChanged: device.suggestedStreamUrl !== undefined && !sameAddress,
      };
    }
  }
  if (device.suggestedStreamUrl) {
    const byUrl = index.byUrl.get(normalizeStreamUrl(device.suggestedStreamUrl));
    if (byUrl) return { camera: byUrl, matchedOn: 'stream-url', addressChanged: false };
  }
  return null;
}

/**
 * Confidence in a match (P-2.1, Architect rec 3).
 *
 * Ordered by what each identifier actually guarantees. A UUID or serial is assigned by the device; a
 * MAC identifies the interface, which is usually but not always the same unit; an address is
 * reassigned by DHCP to whatever asks next. **A low-confidence match is reported as low**, never
 * silently accepted — merging two cameras on the strength of a recycled lease is a worse outcome
 * than onboarding one of them twice.
 */
export function confidenceFor(
  matchedOn: 'identity' | 'stream-url',
  key: string | null,
): IdentityConfidence {
  if (matchedOn === 'stream-url') return 'low';
  if (key === null) return 'unknown';
  if (key.startsWith('uuid:') || key.startsWith('serial:')) return 'high';
  return 'medium';
}

/** The identity attributes worth tracking over time, paired with their accessor. */
const TRACKED: ReadonlyArray<
  [IdentityAttribute, (id: CameraDeviceIdentity) => string | undefined]
> = [
  ['onvifUuid', (id) => id.onvifUuid],
  ['serialNumber', (id) => id.serialNumber],
  ['macAddress', (id) => id.macAddress],
  ['hardwareId', (id) => id.hardwareId],
  ['address', (id) => id.lastKnownAddress],
];

/**
 * What changed between a stored identity and a freshly observed one (P-2.1, Architect rec 1).
 *
 * **Identity is appended to, never overwritten.** A camera whose serial number changed is either a
 * unit somebody swapped without telling anyone or a re-used record, and both are worth knowing about
 * months later. Overwriting makes an estate that was quietly re-cabled indistinguishable from one
 * that was not — and leaves "when did this become a different device?" unanswerable.
 *
 * A previously-unknown attribute produces an entry with no `from`: a first observation, not a change.
 */
export function identityChanges(
  previous: CameraDeviceIdentity | undefined,
  observed: CameraDeviceIdentity,
  options: { at: Date; source: CameraIdentityChange['source'] },
): CameraIdentityChange[] {
  const at = options.at.toISOString();
  const changes: CameraIdentityChange[] = [];
  for (const [attribute, read] of TRACKED) {
    const to = read(observed);
    if (!to) continue;
    const from = previous ? read(previous) : undefined;
    if (from === to) continue;
    changes.push({
      at,
      attribute,
      ...(from ? { from } : {}),
      to,
      source: options.source,
    });
  }
  return changes;
}

/** Merge an observed identity over a stored one. Absent observations never erase what is known. */
export function mergeIdentity(
  previous: CameraDeviceIdentity | undefined,
  observed: CameraDeviceIdentity,
): CameraDeviceIdentity {
  return {
    ...(previous ?? {}),
    // Only defined observations win — a device that declined to report its serial this time has not
    // told us the serial is gone.
    ...Object.fromEntries(Object.entries(observed).filter(([, v]) => v !== undefined)),
  };
}

/** Append to the bounded identity history, dropping the oldest entries first. */
export function appendIdentityHistory(
  history: readonly CameraIdentityChange[],
  ...changes: readonly CameraIdentityChange[]
): CameraIdentityChange[] {
  const next = [...history, ...changes];
  return next.slice(Math.max(0, next.length - IDENTITY_HISTORY_LIMIT));
}

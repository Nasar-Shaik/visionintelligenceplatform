/**
 * Domain: when to re-read a camera's capabilities, and when to answer from cache (P-2).
 *
 * An ONVIF capability negotiation is several SOAP round trips against a device with an embedded web
 * server that was never designed for load. Asking one for its profiles every time a session starts
 * is how a camera that worked in testing starts refusing connections in production. So capabilities
 * are read once and cached, and this module owns the only question that matters: **is what we have
 * still true?**
 *
 * That question is only answerable because the cache records what the capabilities were read
 * *against* (Architect P-2 rec 2). Without the firmware and the timestamp, "has anything changed?"
 * has no answer, and the only safe behaviour left is to re-query every time — the exact cost the
 * cache exists to avoid.
 *
 * Pure and deterministic: the clock is passed in.
 */
import type { CapabilityCache, CapabilityRefreshReason } from '@vip/contracts';

/** Fraction of the cache window after which capabilities are `aging` rather than `fresh`. */
const AGING_AT = 0.5;

/**
 * How long a capability read stays fresh. Twenty-four hours because camera capabilities change on
 * firmware upgrades and re-configurations — events measured in months — while the cost of being a
 * day stale is that a newly added sub-stream is not offered until tomorrow, or until someone presses
 * refresh. A shorter window would spend real device load to shorten a delay nobody is waiting on.
 */
export const CAPABILITY_TTL_HOURS = 24;

/**
 * The current capability-extraction version. **Bump this when discovery starts extracting something
 * new** (audio channels, PTZ presets, SD-card status — Architect P-2 rec 8). A cache filled by an
 * older extractor is stale even though the device has not changed, and without a version the
 * platform cannot tell those two situations apart: every camera would silently keep reporting the
 * narrower capability set it was first read with.
 */
export const CAPABILITY_CACHE_VERSION = 1;

export interface RefreshDecision {
  refresh: boolean;
  reason: CapabilityRefreshReason;
  /** Human explanation, shown to the operator who pressed the button. */
  detail: string;
}

export interface RefreshInput {
  cache: CapabilityCache | undefined;
  now: Date;
  force?: boolean;
  /** Firmware as most recently observed from the device, when it is known. */
  observedFirmware?: string;
  ttlHours?: number;
}

/**
 * Decide whether to go back to the device.
 *
 * The order of the checks is the order of certainty. `forced` first because an operator pressing
 * refresh has a reason the platform cannot see. Then the two cases where the cache is *known* to be
 * wrong (never filled, or filled against different firmware), and only then the heuristic one (age).
 */
export function capabilityRefreshDecision(input: RefreshInput): RefreshDecision {
  const { cache, now, force, observedFirmware } = input;
  const ttlHours = input.ttlHours ?? CAPABILITY_TTL_HOURS;

  if (force) {
    return { refresh: true, reason: 'forced', detail: 'an operator requested a refresh' };
  }
  if (!cache || !cache.discoveredAt) {
    return {
      refresh: true,
      reason: 'never-discovered',
      detail: 'capabilities have never been confirmed against this device',
    };
  }
  if (cache.cacheVersion < CAPABILITY_CACHE_VERSION) {
    return {
      refresh: true,
      reason: 'stale',
      detail: `cached by capability extractor v${cache.cacheVersion}; v${CAPABILITY_CACHE_VERSION} reads more`,
    };
  }
  if (observedFirmware && cache.firmware && observedFirmware !== cache.firmware) {
    return {
      refresh: true,
      reason: 'firmware-changed',
      detail: `firmware changed from ${cache.firmware} to ${observedFirmware}`,
    };
  }

  const reference = cache.lastRefreshedAt ?? cache.discoveredAt;
  const ageHours = (now.getTime() - new Date(reference).getTime()) / 3_600_000;
  if (ageHours >= ttlHours) {
    return {
      refresh: true,
      reason: 'stale',
      detail: `last confirmed ${Math.floor(ageHours)}h ago (cache window is ${ttlHours}h)`,
    };
  }
  return {
    refresh: false,
    reason: 'cached',
    detail: `confirmed ${Math.floor(ageHours)}h ago — the device was not contacted`,
  };
}

/** The cache entry to persist after a read. `refreshed: false` records the attempt without claiming one. */
export function recordRefresh(
  previous: CapabilityCache | undefined,
  outcome: {
    reason: CapabilityRefreshReason;
    refreshed: boolean;
    firmware?: string;
    at: Date;
    source?: CapabilityCache['source'];
  },
): CapabilityCache {
  const at = outcome.at.toISOString();
  const firmware = outcome.firmware ?? previous?.firmware;
  return {
    cacheVersion: outcome.refreshed ? CAPABILITY_CACHE_VERSION : (previous?.cacheVersion ?? 1),
    ...(firmware ? { firmware } : {}),
    // `discoveredAt` is when the device was FIRST confirmed and never moves afterwards — it is what
    // an operator reads as "we have actually talked to this camera", and resetting it on every
    // refresh would erase the distinction between a device known for a year and one seen once.
    ...(previous?.discoveredAt
      ? { discoveredAt: previous.discoveredAt }
      : outcome.refreshed
        ? { discoveredAt: at }
        : {}),
    lastRefreshedAt: at,
    refreshReason: outcome.reason,
    refreshCount: (previous?.refreshCount ?? 0) + (outcome.refreshed ? 1 : 0),
    source: outcome.refreshed
      ? (outcome.source ?? 'onvif-directed')
      : (previous?.source ?? 'declared'),
    // Written for storage; `freshnessOf` recomputes it against the clock on every read.
    freshness: outcome.refreshed ? 'fresh' : (previous?.freshness ?? 'unknown'),
  };
}

/** An empty cache for a camera whose capabilities were declared rather than discovered. */
export function declaredCache(): CapabilityCache {
  return {
    cacheVersion: CAPABILITY_CACHE_VERSION,
    refreshCount: 0,
    source: 'declared',
    // Never confirmed against a device. Deliberately `unknown`, not `expired` — the second implies
    // it was true once, and this has never been true.
    freshness: 'unknown',
  };
}

/**
 * How much the cached capabilities can be trusted right now (P-2.1, Architect rec 6).
 *
 * Computed on read rather than trusted from storage, because freshness is a function of the clock: a
 * stored value is wrong the moment after it is written, which is precisely the silent staleness the
 * recommendation is about.
 */
export function freshnessOf(
  cache: CapabilityCache | undefined,
  now: Date,
  ttlHours = CAPABILITY_TTL_HOURS,
): CapabilityCache['freshness'] {
  const reference = cache?.lastRefreshedAt ?? cache?.discoveredAt;
  if (!cache || !reference || !cache.discoveredAt) return 'unknown';
  const ageHours = (now.getTime() - new Date(reference).getTime()) / 3_600_000;
  if (ageHours >= ttlHours) return 'expired';
  if (ageHours >= ttlHours * AGING_AT) return 'aging';
  return 'fresh';
}

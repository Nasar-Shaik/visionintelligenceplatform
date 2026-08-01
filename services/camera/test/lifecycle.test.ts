/**
 * P-2 domain tests: the lifecycle state machine, device identity, the capability cache and health
 * trends. All pure — no database, no network, no clock.
 *
 * Two tests here are **negative controls** and should be treated as load-bearing:
 * `a flawless simulated probe does not connect a camera` and `a retired camera cannot be revived by
 * a health check`. Both encode rules that are invisible when they work and expensive when they stop.
 */
import { describe, expect, it } from 'vitest';
import type { CameraTimelineEntry, StreamProbeResult } from '@vip/contracts';
import {
  LifecycleError,
  appendTimeline,
  canTransition,
  derivedLifecycle,
  healthFromProbe,
  initialLifecycle,
  isMeasuredState,
  stateForProbe,
  transition,
} from '../src/domain/lifecycle.js';
import {
  appendIdentityHistory,
  buildMatchIndex,
  confidenceFor,
  identityChanges,
  identityKey,
  matchDevice,
  mergeIdentity,
  normalizeMac,
  normalizeStreamUrl,
} from '../src/domain/identity.js';
import { diffCapabilities, highestSeverity, severityFor } from '../src/domain/capability-diff.js';
import {
  CAPABILITY_CACHE_VERSION,
  capabilityRefreshDecision,
  declaredCache,
  freshnessOf,
  recordRefresh,
} from '../src/domain/capability-cache.js';
import { WINDOW_HOURS, summarizeHealth } from '../src/domain/health-history.js';

const AT = new Date('2026-08-02T10:00:00.000Z');
const LATER = new Date('2026-08-02T11:00:00.000Z');

const probe = (over: Partial<StreamProbeResult> = {}): StreamProbeResult => ({
  probedAt: AT.toISOString(),
  evidenceClass: 'hardware',
  checks: [],
  reachable: true,
  framesRead: 3,
  authentication: 'unknown',
  profiles: [],
  warnings: [],
  ...over,
});

describe('lifecycle transitions', () => {
  it('starts a newly onboarded camera at configured, on declared evidence', () => {
    const lifecycle = initialLifecycle(AT);
    expect(lifecycle.state).toBe('configured');
    expect(lifecycle.evidence).toBe('declared');
  });

  it('moves through the legal path and records why', () => {
    const outcome = transition(initialLifecycle(AT), {
      to: 'connected',
      evidence: 'measured',
      evidenceClass: 'hardware',
      reasonCode: 'hardware-evidence',
      reason: 'probe read 3 frames',
      at: LATER,
    });
    expect(outcome.changed).toBe(true);
    expect(outcome.lifecycle.state).toBe('connected');
    expect(outcome.entry).toMatchObject({
      kind: 'state-changed',
      from: 'configured',
      to: 'connected',
      detail: 'probe read 3 frames',
    });
  });

  it('re-affirming the current state is not a transition and adds no timeline noise', () => {
    const connected = {
      state: 'connected' as const,
      since: AT.toISOString(),
      evidence: 'measured' as const,
    };
    const outcome = transition(connected, {
      to: 'connected',
      evidence: 'measured',
      evidenceClass: 'hardware',
      reasonCode: 'hardware-evidence',
      reason: 'still connected',
      at: LATER,
    });
    expect(outcome.changed).toBe(false);
    expect(outcome.entry).toBeNull();
    // A camera probed every five minutes must not bury the one time it went offline.
    expect(outcome.lifecycle.since).toBe(AT.toISOString());
  });

  it('rejects a transition that is not in the map', () => {
    const discovered = {
      state: 'discovered' as const,
      since: AT.toISOString(),
      evidence: 'declared' as const,
    };
    expect(() =>
      transition(discovered, {
        to: 'monitoring',
        evidence: 'measured',
        evidenceClass: 'hardware',
        reasonCode: 'hardware-evidence',
        reason: 'session started',
        at: LATER,
      }),
    ).toThrow(LifecycleError);
  });

  it('NEGATIVE CONTROL: a retired camera cannot be revived by a health check', () => {
    const retired = {
      state: 'retired' as const,
      since: AT.toISOString(),
      evidence: 'administrative' as const,
    };
    // A camera someone deliberately decommissioned must not quietly re-enter the estate because a
    // scheduled probe happened to reach it — the device may have been redeployed elsewhere entirely.
    expect(() =>
      transition(retired, {
        to: 'connected',
        evidence: 'measured',
        evidenceClass: 'hardware',
        reasonCode: 'hardware-evidence',
        reason: 'probe succeeded',
        at: LATER,
      }),
    ).toThrow(/reinstated/);
    expect(canTransition('retired', 'configured')).toBe(true);
  });

  it('reinstatement returns a camera to configured, not to whatever it was before', () => {
    const retired = {
      state: 'retired' as const,
      since: AT.toISOString(),
      evidence: 'administrative' as const,
    };
    const outcome = transition(retired, {
      to: 'configured',
      evidence: 'administrative',
      reasonCode: 'operator-action',
      reason: 'reinstated',
      at: LATER,
    });
    expect(outcome.lifecycle.state).toBe('configured');
    expect(outcome.lifecycle.evidence).toBe('administrative');
  });
});

describe('the evidence gate', () => {
  it('knows which states are claims about a physical device', () => {
    expect(['connected', 'monitoring', 'degraded', 'offline'].every(isMeasuredState)).toBe(true);
    expect(['discovered', 'validated', 'configured', 'retired'].some(isMeasuredState)).toBe(false);
  });

  it('refuses a measured state on declared evidence', () => {
    expect(() =>
      transition(initialLifecycle(AT), {
        to: 'connected',
        evidence: 'declared',
        reasonCode: 'operator-action',
        reason: 'an operator said so',
        at: LATER,
      }),
    ).toThrow(/cannot be entered/);
  });

  it('refuses a measured state without hardware evidence', () => {
    expect(() =>
      transition(initialLifecycle(AT), {
        to: 'connected',
        evidence: 'measured',
        evidenceClass: 'recorded-footage',
        reasonCode: 'hardware-evidence',
        reason: 'a file played back perfectly',
        at: LATER,
      }),
    ).toThrow(/hardware evidence/);
  });

  it('NEGATIVE CONTROL: a flawless simulated probe does not connect a camera', () => {
    // Every check passes. The frame rate is perfect. It is still a simulation, and a simulation is
    // not a camera. Deleting this rule makes a demo environment report an estate that does not exist.
    const perfect = probe({
      evidenceClass: 'simulated',
      framesRead: 30,
      fps: 25,
      resolution: '1920x1080',
      checks: [{ name: 'reachability', status: 'pass' }],
    });
    expect(stateForProbe(perfect)).toBeNull();
  });

  it('derives no state from recorded footage either', () => {
    expect(stateForProbe(probe({ evidenceClass: 'recorded-footage' }))).toBeNull();
  });
});

describe('what a hardware probe justifies', () => {
  it('connects a camera that answered and delivered frames', () => {
    expect(stateForProbe(probe())).toBe('connected');
  });

  it('marks a device that did not answer as offline', () => {
    expect(stateForProbe(probe({ reachable: false, framesRead: 0 }))).toBe('offline');
  });

  it('marks a rejected credential as degraded, not offline — the device is right there', () => {
    expect(stateForProbe(probe({ authentication: 'failed', framesRead: 0 }))).toBe('degraded');
  });

  it('marks a stream that opened and then stalled as degraded', () => {
    expect(stateForProbe(probe({ framesRead: 0 }))).toBe('degraded');
  });

  it('treats a warning as degraded rather than healthy', () => {
    const slow = probe({ checks: [{ name: 'fps', status: 'warn', measured: '0.4 fps' }] });
    expect(stateForProbe(slow)).toBe('degraded');
  });

  it('carries the probe into an operational-health snapshot without inventing fields', () => {
    const health = healthFromProbe(probe({ framesRead: 0, reachable: false }));
    expect(health.source).toBe('stream-probe');
    expect(health.streamAvailable).toBe(false);
    // Nothing measured a latency, so none is reported — not zero.
    expect(health.rtspLatencyMs).toBeUndefined();
    expect(health.lastFrameAt).toBeUndefined();
  });
});

describe('pre-P-2 records', () => {
  it('derives configured rather than manufacturing measured evidence', () => {
    const lifecycle = derivedLifecycle(AT.toISOString());
    expect(lifecycle.state).toBe('configured');
    expect(lifecycle.evidence).toBe('declared');
  });
});

describe('timeline', () => {
  const entry = (n: number): CameraTimelineEntry => ({
    at: new Date(AT.getTime() + n * 1000).toISOString(),
    kind: 'state-changed',
    evidence: 'measured',
    reasonCode: 'hardware-evidence',
    detail: `entry ${n}`,
  });

  it('drops the oldest entries once the bound is reached', () => {
    let timeline: CameraTimelineEntry[] = [];
    for (let i = 0; i < 60; i += 1) timeline = appendTimeline(timeline, entry(i));
    expect(timeline).toHaveLength(50);
    expect(timeline[0]!.detail).toBe('entry 10');
    expect(timeline.at(-1)!.detail).toBe('entry 59');
  });

  it('ignores nulls, so a no-op transition appends nothing', () => {
    expect(appendTimeline([entry(1)], null)).toHaveLength(1);
  });
});

describe('device identity', () => {
  it('prefers the strongest identifier the device offered', () => {
    expect(identityKey({ onvifUuid: 'urn:uuid:ABC', serialNumber: 'S1' })).toBe(
      'uuid:urn:uuid:abc',
    );
    expect(identityKey({ serialNumber: 'S1', macAddress: 'a4:14:37:0b:2c:9d' })).toBe('serial:s1');
    expect(identityKey({ macAddress: 'A4:14:37:0B:2C:9D' })).toBe('mac:a4:14:37:0b:2c:9d');
  });

  it('returns null for a device that will not identify itself, rather than inventing an id', () => {
    expect(identityKey(undefined)).toBeNull();
    expect(identityKey({ lastKnownAddress: '10.0.0.64' })).toBeNull();
  });

  it('normalizes the MAC spellings devices actually use', () => {
    expect(normalizeMac('A4-14-37-0B-2C-9D')).toBe('a4:14:37:0b:2c:9d');
    expect(normalizeMac('a4.14.37.0b.2c.9d')).toBe('a4:14:37:0b:2c:9d');
    expect(normalizeMac('not-a-mac')).toBeUndefined();
  });

  it('normalizes URLs case-insensitively on host but not on path', () => {
    expect(normalizeStreamUrl('RTSP://Cam.Local:554/Live/')).toBe('rtsp://cam.local:554/Live');
  });
});

describe('matching a discovered device to a managed camera', () => {
  const cameras = [
    {
      _id: 'cam_1',
      streamUrl: 'rtsp://10.0.0.64:554/sub',
      identity: { onvifUuid: 'urn:uuid:abc' },
    },
    { _id: 'cam_2', streamUrl: 'rtsp://10.0.0.65:554/sub' },
  ];
  const index = buildMatchIndex(cameras);

  it('THE DHCP CASE: recognises a camera that moved and says the address changed', () => {
    const match = matchDevice(index, {
      identity: { onvifUuid: 'urn:uuid:abc' },
      suggestedStreamUrl: 'rtsp://10.0.0.99:554/sub',
    });
    // Without identity matching this is a new device, the installer onboards it, and the estate now
    // has one physical camera twice — one of which will never connect again.
    expect(match).toMatchObject({ matchedOn: 'identity', addressChanged: true });
    expect(match!.camera._id).toBe('cam_1');
  });

  it('does not claim the address changed when it did not', () => {
    const match = matchDevice(index, {
      identity: { onvifUuid: 'urn:uuid:abc' },
      suggestedStreamUrl: 'rtsp://10.0.0.64:554/sub',
    });
    expect(match).toMatchObject({ matchedOn: 'identity', addressChanged: false });
  });

  it('does not claim the address changed when discovery could not derive one', () => {
    // Unknown is not changed. Offering to "update" an address the platform never learned would
    // overwrite a working configuration with nothing.
    const match = matchDevice(index, { identity: { onvifUuid: 'urn:uuid:abc' } });
    expect(match).toMatchObject({ matchedOn: 'identity', addressChanged: false });
  });

  it('falls back to the stream URL for a device with no identity', () => {
    const match = matchDevice(index, { suggestedStreamUrl: 'rtsp://10.0.0.65:554/sub' });
    expect(match).toMatchObject({ matchedOn: 'stream-url', addressChanged: false });
  });

  it('returns null for a genuinely new device', () => {
    expect(
      matchDevice(index, {
        identity: { onvifUuid: 'urn:uuid:new' },
        suggestedStreamUrl: 'rtsp://10.0.0.70:554/sub',
      }),
    ).toBeNull();
  });
});

describe('capability cache', () => {
  const cache = (over = {}) => ({
    cacheVersion: CAPABILITY_CACHE_VERSION,
    refreshCount: 1,
    discoveredAt: '2026-08-02T09:00:00.000Z',
    lastRefreshedAt: '2026-08-02T09:00:00.000Z',
    firmware: 'V5.7.3',
    ...over,
  });

  it('serves from cache inside the window and says the device was not contacted', () => {
    const decision = capabilityRefreshDecision({ cache: cache(), now: LATER });
    expect(decision).toMatchObject({ refresh: false, reason: 'cached' });
    expect(decision.detail).toMatch(/not contacted/);
  });

  it('refreshes when the firmware moved underneath it', () => {
    const decision = capabilityRefreshDecision({
      cache: cache(),
      now: LATER,
      observedFirmware: 'V5.7.9',
    });
    expect(decision).toMatchObject({ refresh: true, reason: 'firmware-changed' });
  });

  it('refreshes a cache that has never been filled', () => {
    expect(capabilityRefreshDecision({ cache: declaredCache(), now: AT })).toMatchObject({
      refresh: true,
      reason: 'never-discovered',
    });
  });

  it('refreshes when the window has passed', () => {
    const later = new Date('2026-08-04T10:00:00.000Z');
    expect(capabilityRefreshDecision({ cache: cache(), now: later })).toMatchObject({
      refresh: true,
      reason: 'stale',
    });
  });

  it('refreshes a cache filled by an older extractor even though the device has not changed', () => {
    const decision = capabilityRefreshDecision({ cache: cache({ cacheVersion: 0 }), now: LATER });
    expect(decision).toMatchObject({ refresh: true, reason: 'stale' });
    expect(decision.detail).toMatch(/extractor/);
  });

  it('an operator override wins over a perfectly fresh cache', () => {
    expect(capabilityRefreshDecision({ cache: cache(), now: AT, force: true })).toMatchObject({
      refresh: true,
      reason: 'forced',
    });
  });

  it('keeps the first-confirmed timestamp across refreshes', () => {
    const next = recordRefresh(cache(), { reason: 'forced', refreshed: true, at: LATER });
    // A device known for a year and one seen once must not look the same.
    expect(next.discoveredAt).toBe('2026-08-02T09:00:00.000Z');
    expect(next.lastRefreshedAt).toBe(LATER.toISOString());
    expect(next.refreshCount).toBe(2);
  });

  it('records a failed attempt without claiming the device was read', () => {
    const next = recordRefresh(cache(), { reason: 'stale', refreshed: false, at: LATER });
    expect(next.refreshCount).toBe(1);
    expect(next.lastRefreshedAt).toBe(LATER.toISOString());
  });
});

describe('health trends', () => {
  const entry = (minutes: number, over: Partial<CameraTimelineEntry>): CameraTimelineEntry => ({
    at: new Date(AT.getTime() + minutes * 60_000).toISOString(),
    kind: 'state-changed',
    evidence: 'measured',
    detail: '',
    ...over,
  });

  it('refuses to report an availability percentage it cannot support', () => {
    const summary = summarizeHealth({
      cameraId: 'cam_1',
      timeline: [entry(1, { from: 'configured', to: 'connected' })],
      window: 'day',
      windowStart: AT,
      windowEnd: LATER,
    });
    // One observation is a snapshot, not a trend.
    expect(summary.observations).toBe(1);
    expect(summary.availabilityPercent).toBeUndefined();
  });

  it('computes availability from time spent, not from how many events occurred', () => {
    const summary = summarizeHealth({
      cameraId: 'cam_1',
      timeline: [
        entry(0, { from: 'configured', to: 'connected' }),
        entry(30, { from: 'connected', to: 'offline' }),
        entry(45, { from: 'offline', to: 'connected' }),
        entry(50, { from: 'connected', to: 'offline' }),
        entry(55, { from: 'offline', to: 'connected' }),
      ],
      window: 'day',
      windowStart: AT,
      windowEnd: LATER,
    });
    // Healthy 0–30, 45–50, 55–60 = 40 min of 60. A count of events would say "mostly down".
    expect(summary.availabilityPercent).toBeCloseTo(66.7, 0);
    expect(summary.offlineSeconds).toBe(20 * 60);
  });

  it('counts recoveries but not the original installation', () => {
    const summary = summarizeHealth({
      cameraId: 'cam_1',
      timeline: [
        entry(0, { from: 'configured', to: 'connected' }),
        entry(10, { from: 'connected', to: 'offline' }),
        entry(20, { from: 'offline', to: 'connected' }),
        entry(30, { from: 'connected', to: 'degraded' }),
        entry(40, { from: 'degraded', to: 'connected' }),
      ],
      window: 'day',
      windowStart: AT,
      windowEnd: LATER,
    });
    // An estate report where every camera "reconnected once" on the day it was installed is noise.
    expect(summary.reconnects).toBe(2);
  });

  it('counts the operational events an investigation actually starts from', () => {
    const summary = summarizeHealth({
      cameraId: 'cam_1',
      timeline: [
        entry(5, { kind: 'firmware-changed', detail: 'V5.7.3 → V5.7.9' }),
        entry(6, { kind: 'capability-refreshed', detail: 'firmware changed' }),
        entry(7, {
          kind: 'probe-failed',
          // Read from the TYPED reason, not from the prose — a message reworded upstream must not
          // silently zero this counter.
          reasonCode: 'authentication-failure',
          detail: 'the device rejected the credentials',
        }),
      ],
      window: 'day',
      windowStart: AT,
      windowEnd: LATER,
    });
    expect(summary.firmwareChanges).toBe(1);
    expect(summary.capabilityRefreshes).toBe(1);
    expect(summary.credentialFailures).toBe(1);
  });

  it('excludes entries outside the window', () => {
    const summary = summarizeHealth({
      cameraId: 'cam_1',
      timeline: [entry(-60, { from: 'connected', to: 'offline' })],
      window: 'day',
      windowStart: AT,
      windowEnd: LATER,
    });
    expect(summary.observations).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// P-2.1: capability diff, identity history + confidence, cache freshness, trend windows
// -------------------------------------------------------------------------------------------

const caps = (over: Partial<Parameters<typeof diffCapabilities>[1]> = {}) => ({
  ptz: false,
  audio: false,
  snapshot: true,
  codecs: ['h264' as const],
  resolutions: ['1920x1080'],
  protocols: ['rtsp' as const],
  streamProfiles: [{ name: 'sub', resolution: '640x360', fps: 15, preferredForAnalysis: true }],
  onvif: true,
  metadataStream: false,
  ...over,
});

describe('capability diff', () => {
  it('says what changed, not that something changed', () => {
    const changes = diffCapabilities(caps(), caps({ codecs: ['h265'] }));
    expect(changes).toEqual([{ field: 'codecs', severity: 'major', from: 'h264', to: 'h265' }]);
  });

  it('classifies impact so the expensive change is not buried under a firmware string', () => {
    expect(severityFor('codecs')).toBe('major');
    expect(severityFor('streamProfiles.sub.resolution')).toBe('major');
    expect(severityFor('audio')).toBe('minor');
    expect(severityFor('tls')).toBe('security');
    expect(highestSeverity([{ field: 'audio', severity: 'minor' }])).toBe('minor');
  });

  it('catches the change that quadruples the decode bill', () => {
    const before = caps();
    const after = caps({
      streamProfiles: [
        { name: 'sub', resolution: '3840x2160', fps: 30, preferredForAnalysis: true },
      ],
    });
    const fields = diffCapabilities(before, after).map((c) => c.field);
    expect(fields).toContain('streamProfiles.sub.resolution');
    expect(fields).toContain('streamProfiles.sub.fps');
  });

  it('compares profiles by name, so reordering after a firmware upgrade is not a change', () => {
    const before = caps({
      streamProfiles: [
        { name: 'main', resolution: '1920x1080', preferredForAnalysis: false },
        { name: 'sub', resolution: '640x360', preferredForAnalysis: true },
      ],
    });
    const reordered = caps({
      streamProfiles: [
        { name: 'sub', resolution: '640x360', preferredForAnalysis: true },
        { name: 'main', resolution: '1920x1080', preferredForAnalysis: false },
      ],
    });
    // A positional diff would report every profile as changed on every upgrade — noise that trains
    // operators to ignore the feature entirely.
    expect(diffCapabilities(before, reordered)).toEqual([]);
  });

  it('reports a profile the device stopped publishing', () => {
    const after = caps({ streamProfiles: [] });
    expect(diffCapabilities(caps(), after)).toEqual([
      { field: 'streamProfiles.sub', severity: 'major', from: '640x360 · 15 fps' },
    ]);
  });

  it('has nothing to say about a camera whose capabilities were never read', () => {
    expect(diffCapabilities(undefined, caps())).toEqual([]);
  });
});

describe('identity history', () => {
  it('records a first observation without claiming something changed', () => {
    const changes = identityChanges(
      undefined,
      { serialNumber: 'DS-0001' },
      {
        at: AT,
        source: 'discovery',
      },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.from).toBeUndefined();
  });

  it('answers "when did this camera become a different device?"', () => {
    const changes = identityChanges(
      { serialNumber: 'DS-0001', lastKnownAddress: '10.0.0.64' },
      { serialNumber: 'DS-0002', lastKnownAddress: '10.0.0.64' },
      { at: LATER, source: 'discovery' },
    );
    // A swapped unit, or a re-used record. Overwriting in place makes both invisible.
    expect(changes).toEqual([
      {
        at: LATER.toISOString(),
        attribute: 'serialNumber',
        from: 'DS-0001',
        to: 'DS-0002',
        source: 'discovery',
      },
    ]);
  });

  it('says nothing when nothing moved', () => {
    const identity = { onvifUuid: 'urn:uuid:abc', lastKnownAddress: '10.0.0.64' };
    expect(identityChanges(identity, identity, { at: LATER, source: 'probe' })).toEqual([]);
  });

  it('never erases a known identifier the device declined to report this time', () => {
    const merged = mergeIdentity(
      { onvifUuid: 'urn:uuid:abc', serialNumber: 'DS-0001' },
      { onvifUuid: 'urn:uuid:abc' },
    );
    expect(merged.serialNumber).toBe('DS-0001');
  });

  it('bounds the history, dropping the oldest first', () => {
    const change = {
      at: AT.toISOString(),
      attribute: 'address' as const,
      to: '10.0.0.9',
      source: 'discovery' as const,
    };
    let history: (typeof change)[] = [];
    for (let i = 0; i < 40; i += 1) {
      history = appendIdentityHistory(history, { ...change, to: `10.0.0.${i}` });
    }
    expect(history).toHaveLength(30);
    expect(history[0]!.to).toBe('10.0.0.10');
  });
});

describe('identity confidence', () => {
  it('grades a match by what the identifier actually guarantees', () => {
    expect(confidenceFor('identity', 'uuid:urn:uuid:abc')).toBe('high');
    expect(confidenceFor('identity', 'serial:ds-1')).toBe('high');
    expect(confidenceFor('identity', 'mac:a4:14:37:0b:2c:9d')).toBe('medium');
    // Addresses are reassigned by DHCP to whatever asks next.
    expect(confidenceFor('stream-url', null)).toBe('low');
    expect(confidenceFor('identity', null)).toBe('unknown');
  });
});

describe('capability cache freshness', () => {
  const cache = (over = {}) => ({
    cacheVersion: 1,
    refreshCount: 1,
    source: 'onvif-directed' as const,
    freshness: 'fresh' as const,
    discoveredAt: '2026-08-02T09:00:00.000Z',
    lastRefreshedAt: '2026-08-02T09:00:00.000Z',
    ...over,
  });

  it('never confirmed is unknown, not expired — those are different facts', () => {
    expect(freshnessOf(undefined, AT)).toBe('unknown');
    expect(freshnessOf(declaredCache(), AT)).toBe('unknown');
  });

  it('ages through the window rather than flipping at the end of it', () => {
    expect(freshnessOf(cache(), new Date('2026-08-02T10:00:00.000Z'))).toBe('fresh');
    expect(freshnessOf(cache(), new Date('2026-08-02T22:00:00.000Z'))).toBe('aging');
    expect(freshnessOf(cache(), new Date('2026-08-03T10:00:00.000Z'))).toBe('expired');
  });

  it('records where the capabilities came from', () => {
    const refreshed = recordRefresh(cache(), {
      reason: 'forced',
      refreshed: true,
      at: LATER,
      source: 'onvif-directed',
    });
    expect(refreshed.source).toBe('onvif-directed');
    // A declared cache that failed to refresh must not start claiming a device confirmed it.
    const failed = recordRefresh(declaredCache(), { reason: 'stale', refreshed: false, at: LATER });
    expect(failed.source).toBe('declared');
  });
});

describe('health trend windows', () => {
  it('offers bounded windows so last night is not hidden behind a year of uptime', () => {
    expect(WINDOW_HOURS).toEqual({ hour: 1, day: 24, week: 168, month: 720 });
  });

  it('counts drops separately from time spent down', () => {
    const flap = (minutes: number, from: string, to: string) => ({
      at: new Date(AT.getTime() + minutes * 60_000).toISOString(),
      kind: 'state-changed' as const,
      evidence: 'measured' as const,
      reasonCode: 'hardware-evidence' as const,
      from: from as 'connected',
      to: to as 'offline',
      detail: '',
    });
    const summary = summarizeHealth({
      cameraId: 'cam_1',
      window: 'hour',
      timeline: [
        flap(0, 'configured', 'connected'),
        flap(10, 'connected', 'offline'),
        flap(11, 'offline', 'connected'),
        flap(20, 'connected', 'offline'),
        flap(21, 'offline', 'connected'),
      ],
      windowStart: AT,
      windowEnd: LATER,
    });
    // Two one-minute blips and one two-minute outage produce the same `offlineSeconds` and mean
    // entirely different things about the camera.
    expect(summary.offlineCount).toBe(2);
    expect(summary.offlineSeconds).toBe(120);
    expect(summary.window).toBe('hour');
  });
});

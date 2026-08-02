/**
 * Domain tests for the operational evidence layer (P-2.2): drift classification, the immutable
 * archive, replay, the compatibility register, operational confidence and the unified timeline.
 *
 * The tests to be most suspicious of anyone "fixing" are the negative ones — a simulated probe that
 * must not mark a firmware supported, a credential failure that must not mark one unsupported, and a
 * single probe that must not produce a confidence score. Each of them makes the platform report less
 * than it technically could, which is the entire point.
 */
import { describe, expect, it } from 'vitest';
import type { CameraCapabilities, CameraProbeRecord, StreamProbeResult } from '@vip/contracts';
import { classifyDrift, diffCapabilities, directionOf } from '../src/domain/capability-diff.js';
import { compareProbes, replayProbe } from '../src/domain/probe-archive.js';
import { recordCompatibility, statusFor } from '../src/domain/compatibility.js';
import { operationalConfidence } from '../src/domain/confidence.js';
import { evidenceTimeline, producersIn } from '../src/domain/evidence-timeline.js';
import { explainDecisions } from '../src/domain/decisions.js';
import { confidenceTrend } from '../src/domain/confidence.js';
import { probeMetrics } from '../src/domain/probe-metrics.js';

const CAPS = (over: Partial<CameraCapabilities> = {}): CameraCapabilities => ({
  ptz: false,
  audio: false,
  snapshot: true,
  codecs: ['h264'],
  resolutions: ['1920x1080'],
  protocols: ['rtsp'],
  streamProfiles: [{ name: 'sub', resolution: '640x360', fps: 10, preferredForAnalysis: true }],
  onvif: true,
  metadataStream: false,
  ...over,
});

const RESULT = (over: Partial<StreamProbeResult> = {}): StreamProbeResult => ({
  probedAt: '2026-08-02T10:00:00.000Z',
  evidenceClass: 'hardware',
  probeVersion: '3',
  provider: 'rtsp',
  checks: [
    { name: 'dns', status: 'pass', durationMs: 10 },
    { name: 'tcp', status: 'pass', durationMs: 5 },
    { name: 'first-frame', status: 'pass', durationMs: 400 },
  ],
  reachable: true,
  framesRead: 3,
  totalMs: 500,
  firstFrameMs: 400,
  authentication: 'ok',
  profiles: [],
  warnings: [],
  ...over,
});

const RECORD = (over: Partial<CameraProbeRecord> = {}): CameraProbeRecord => ({
  probeId: 'prb_1',
  cameraId: 'cam_1',
  at: '2026-08-02T10:00:00.000Z',
  sequence: 1,
  outcome: 'succeeded',
  evidenceClass: 'hardware',
  probeVersion: '3',
  provider: 'rtsp',
  configuration: {
    protocol: 'rtsp',
    streamUrl: 'rtsp://cam.local/sub',
    provider: 'rtsp',
    credentialsSupplied: true,
    firmware: 'V5.7.3',
  },
  result: RESULT(),
  lifecycleBefore: 'configured',
  lifecycleAfter: 'connected',
  ...over,
});

describe('drift classification (rec 3)', () => {
  it('calls an unexplained codec change unexpected', () => {
    const changes = classifyDrift(diffCapabilities(CAPS(), CAPS({ codecs: ['h265'] })), {
      firmwareChanged: false,
    });
    expect(changes[0]).toMatchObject({
      field: 'codecs',
      cause: 'unexplained',
      drift: 'unexpected',
    });
  });

  it('still calls a codec change unexpected after a firmware upgrade', () => {
    const changes = classifyDrift(diffCapabilities(CAPS(), CAPS({ codecs: ['h265'] })), {
      firmwareChanged: true,
    });
    // The cause is named, and the change is still unexpected: nobody upgrades firmware intending to
    // change the codec, and filing it under "explained" is how the one event worth investigating
    // stops being investigated.
    expect(changes[0]).toMatchObject({ cause: 'firmware-upgrade', drift: 'unexpected' });
  });

  it('treats a purely descriptive change under a named cause as expected', () => {
    const changes = classifyDrift(diffCapabilities(CAPS(), CAPS({ audio: true })), {
      firmwareChanged: true,
    });
    expect(changes[0]).toMatchObject({ field: 'audio', drift: 'expected' });
  });

  it('recognises a regression as a reduction rather than merely a change', () => {
    expect(
      directionOf({ field: 'resolutions', severity: 'major', from: '3840x2160', to: '640x360' }),
    ).toBe('reduced');
    expect(
      directionOf({ field: 'streamProfiles.sub.fps', severity: 'major', from: '25', to: '5' }),
    ).toBe('reduced');
    expect(
      directionOf({ field: 'streamProfiles.sub.fps', severity: 'major', from: '5', to: '25' }),
    ).toBe('increased');
  });

  it('flags a stream profile the device stopped publishing', () => {
    const changes = classifyDrift(diffCapabilities(CAPS(), CAPS({ streamProfiles: [] })), {
      firmwareChanged: true,
    });
    // Losing this silently is how a camera quietly falls back to its 4K main stream and quadruples
    // the platform's decode cost without anyone noticing.
    expect(changes[0]).toMatchObject({ direction: 'removed', drift: 'unexpected' });
  });
});

describe('replay (rec 6)', () => {
  it('reconstructs the stage order, timings and failure point from the record alone', () => {
    const record = RECORD({
      outcome: 'failed',
      failureCode: 'authentication-failure',
      result: RESULT({
        framesRead: 0,
        failureCode: 'authentication-failure',
        checks: [
          { name: 'dns', status: 'pass', durationMs: 10 },
          { name: 'tcp', status: 'pass', durationMs: 5 },
          { name: 'authentication', status: 'fail', detail: '401' },
          { name: 'stream-open', status: 'not-executed' },
        ],
      }),
    });
    const replay = replayProbe(record, new Date('2026-08-09T12:00:00.000Z'));
    expect(replay.stages.map((s) => s.name)).toEqual([
      'dns',
      'tcp',
      'authentication',
      'stream-open',
    ]);
    expect(replay.failedStage).toBe('authentication');
    expect(replay.failureCode).toBe('authentication-failure');
    expect(replay.evidenceClass).toBe('hardware');
    // The measurement's own timestamp and the reconstruction's are separate fields, so a replayed
    // report can never be mistaken for a fresh one.
    expect(replay.recordedAt).toBe('2026-08-02T10:00:00.000Z');
    expect(replay.replayedAt).toBe('2026-08-09T12:00:00.000Z');
  });

  it('names what changed between two probes', () => {
    const previous = RECORD({ probeId: 'prb_1', sequence: 1 });
    const current = RECORD({
      probeId: 'prb_2',
      sequence: 2,
      outcome: 'failed',
      failureCode: 'authentication-failure',
      result: RESULT({
        framesRead: 0,
        totalMs: 900,
        failureCode: 'authentication-failure',
        checks: [
          { name: 'dns', status: 'pass', durationMs: 10 },
          { name: 'tcp', status: 'pass', durationMs: 5 },
          { name: 'first-frame', status: 'not-executed' },
        ],
      }),
    });
    const comparison = compareProbes(current, previous);
    expect(comparison.outcomeChanged).toBe(true);
    expect(comparison.previousOutcome).toBe('succeeded');
    // The comparison is the diagnosis: first-frame used to pass and now never runs.
    expect(comparison.stageChanges).toContainEqual({
      name: 'first-frame',
      from: 'pass',
      to: 'not-executed',
    });
    expect(comparison.totalMsDelta).toBe(400);
    expect(comparison.configurationChanged).toBe(false);
  });
});

describe('compatibility register (rec 5)', () => {
  it('marks a firmware supported only from hardware evidence', () => {
    expect(statusFor(RECORD())).toBe('supported');
    expect(statusFor(RECORD({ evidenceClass: 'simulated' }))).toBe('pending-validation');
    expect(statusFor(RECORD({ evidenceClass: 'recorded-footage' }))).toBe('pending-validation');
  });

  it('claims unsupported only for a device-side failure', () => {
    expect(statusFor(RECORD({ outcome: 'failed', failureCode: 'no-first-frame' }))).toBe(
      'unsupported',
    );
    // A wrong password, a dead switch port and a broken DNS say nothing about a firmware.
    for (const code of ['authentication-failure', 'dns-failure', 'tcp-failure'] as const) {
      expect(statusFor(RECORD({ outcome: 'failed', failureCode: code }))).toBe(
        'pending-validation',
      );
    }
  });

  it('keeps the row for a firmware the camera has moved off', () => {
    const first = recordCompatibility([], RECORD());
    const second = recordCompatibility(
      first,
      RECORD({
        probeId: 'prb_2',
        sequence: 2,
        at: '2026-08-05T10:00:00.000Z',
        configuration: { ...RECORD().configuration, firmware: 'V5.8.0' },
        outcome: 'failed',
        failureCode: 'no-first-frame',
      }),
    );
    const firmware = second.filter((row) => row.dimension === 'firmware');
    // Both rows survive. "Worked on V5.7.3, fails on V5.8.0" IS the diagnosis, and a register that
    // only ever showed the current firmware would erase it.
    expect(firmware.map((row) => [row.value, row.status])).toEqual([
      ['V5.7.3', 'supported'],
      ['V5.8.0', 'unsupported'],
    ]);
  });

  it('does not let a simulated probe demote a firmware hardware proved', () => {
    const proved = recordCompatibility([], RECORD());
    const after = recordCompatibility(
      proved,
      RECORD({ probeId: 'prb_2', sequence: 2, evidenceClass: 'simulated', outcome: 'failed' }),
    );
    expect(after.find((row) => row.dimension === 'firmware')?.status).toBe('supported');
  });
});

describe('operational confidence (rec 4)', () => {
  const base = {
    offlineCount: 0,
    credentialFailures: 0,
    stateObservations: 0,
    unexpectedCapabilityChanges: 0,
    identityChanges: 0,
  };

  it('refuses to score a single probe', () => {
    const confidence = operationalConfidence({ ...base, probes: [RECORD()], stateObservations: 1 });
    expect(confidence.band).toBe('insufficient-evidence');
    expect(confidence.score).toBeUndefined();
  });

  it('ignores probes that never touched hardware', () => {
    const simulated = [1, 2, 3, 4].map((n) =>
      RECORD({ probeId: `prb_${n}`, sequence: n, evidenceClass: 'simulated' }),
    );
    expect(operationalConfidence({ ...base, probes: simulated }).band).toBe(
      'insufficient-evidence',
    );
  });

  it('scores a consistently working camera as stable', () => {
    const probes = [1, 2, 3].map((n) => RECORD({ probeId: `prb_${n}`, sequence: n }));
    const confidence = operationalConfidence({ ...base, probes, availabilityPercent: 99.5 });
    expect(confidence.band).toBe('stable');
    expect(confidence.score).toBeGreaterThanOrEqual(85);
    expect(confidence.basis.join(' ')).toContain('3 of 3 probes succeeded');
  });

  it('drops a flapping camera out of stable even with good availability', () => {
    const probes = [1, 2, 3].map((n) => RECORD({ probeId: `prb_${n}`, sequence: n }));
    const confidence = operationalConfidence({
      ...base,
      probes,
      availabilityPercent: 97,
      offlineCount: 5,
      identityChanges: 1,
    });
    // Availability alone would call this healthy. Five drops in a day is a camera nobody should be
    // relying on, and the basis says so in words rather than only in a number.
    expect(confidence.band).not.toBe('stable');
    expect(confidence.basis.join(' ')).toContain('dropped 5 times');
  });

  it('credits a recovery on the most recent probe', () => {
    const probes = [
      RECORD({ probeId: 'prb_3', sequence: 3, at: '2026-08-02T12:00:00.000Z' }),
      RECORD({ probeId: 'prb_2', sequence: 2, outcome: 'failed', failureCode: 'timeout' }),
      RECORD({ probeId: 'prb_1', sequence: 1, outcome: 'failed', failureCode: 'timeout' }),
    ];
    expect(operationalConfidence({ ...base, probes }).basis).toContain(
      'recovered on the most recent probe',
    );
  });
});

describe('the unified evidence timeline (rec 8)', () => {
  it('merges four records into one chronology, newest first', () => {
    const timeline = evidenceTimeline({
      cameraId: 'cam_1',
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-03T00:00:00.000Z'),
      timeline: [
        {
          at: '2026-08-01T09:00:00.000Z',
          kind: 'state-changed',
          evidence: 'declared',
          reasonCode: 'onboarded',
          to: 'configured',
          detail: 'onboarded',
        },
      ],
      identityHistory: [
        {
          at: '2026-08-02T08:00:00.000Z',
          attribute: 'address',
          from: '10.0.0.60',
          to: '10.0.0.64',
          source: 'discovery',
        },
      ],
      tenantId: 'tnt_a',
      probes: [RECORD()],
      compatibility: [
        {
          dimension: 'firmware',
          value: 'V5.7.3',
          status: 'supported',
          firstSeenAt: '2026-08-02T09:00:00.000Z',
          lastSeenAt: '2026-08-02T10:00:00.000Z',
          evidenceClass: 'hardware',
          successfulProbes: 1,
          failedProbes: 0,
        },
      ],
    });
    expect(timeline.entries.map((e) => e.source)).toEqual([
      'probe',
      'compatibility',
      'identity',
      'lifecycle',
    ]);
    expect(timeline.sources).toEqual(['compatibility', 'identity', 'lifecycle', 'probe']);
    expect(timeline.truncated).toBe(false);
    // Every entry answers what/when/why in the same fields, whichever record it came from.
    expect(timeline.entries.every((e) => e.at && e.summary && e.reasonCode)).toBe(true);
  });

  it('does not report an archived probe twice', () => {
    const timeline = evidenceTimeline({
      cameraId: 'cam_1',
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-03T00:00:00.000Z'),
      timeline: [
        {
          at: '2026-08-02T10:00:00.000Z',
          kind: 'probe-succeeded',
          evidence: 'measured',
          reasonCode: 'hardware-evidence',
          probeId: 'prb_1',
          detail: 'read 3 frames',
        },
      ],
      tenantId: 'tnt_a',
      identityHistory: [],
      probes: [RECORD()],
      compatibility: [],
    });
    // The archive is authoritative; the timeline echo is dropped. Two rows for one probe would make
    // the camera look twice as busy as it was.
    expect(timeline.entries.filter((e) => e.source === 'probe')).toHaveLength(1);
  });
});

describe('probe metrics (rec 7)', () => {
  it('averages only the stages that actually ran', () => {
    const metrics = probeMetrics({
      cameraId: 'cam_1',
      window: 'day',
      windowStart: new Date('2026-08-02T00:00:00.000Z'),
      windowEnd: new Date('2026-08-03T00:00:00.000Z'),
      records: [
        RECORD(),
        RECORD({
          probeId: 'prb_2',
          sequence: 2,
          result: RESULT({
            totalMs: 700,
            checks: [
              { name: 'dns', status: 'pass', durationMs: 20 },
              { name: 'rtsp-negotiation', status: 'skipped' },
              { name: 'stream-open', status: 'not-executed' },
            ],
          }),
        }),
      ],
      timeline: [],
    });
    expect(metrics.probes).toBe(2);
    expect(metrics.averageTotalMs).toBe(600);
    expect(metrics.stages.find((s) => s.stage === 'dns')).toEqual({
      stage: 'dns',
      averageMs: 15,
      samples: 2,
    });
    // A skipped stage has no duration and a not-executed one was never reached. Averaging either as
    // zero would make a fleet of HTTP cameras look like it had instant RTSP negotiation.
    expect(metrics.stages.find((s) => s.stage === 'rtsp-negotiation')).toBeUndefined();
    expect(metrics.stages.find((s) => s.stage === 'stream-open')).toBeUndefined();
  });

  it('omits a success rate when nothing was probed, rather than reporting 0%', () => {
    const metrics = probeMetrics({
      cameraId: 'cam_1',
      window: 'day',
      windowStart: new Date('2026-08-02T00:00:00.000Z'),
      windowEnd: new Date('2026-08-03T00:00:00.000Z'),
      records: [],
      timeline: [],
    });
    expect(metrics.successRatePercent).toBeUndefined();
    expect(metrics.probes).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// P-2.3 — provenance, navigation, decisions, trend
// ---------------------------------------------------------------------------------------------

const TIMELINE = (over: Partial<Parameters<typeof evidenceTimeline>[0]> = {}) =>
  evidenceTimeline({
    cameraId: 'cam_1',
    tenantId: 'tnt_a',
    from: new Date('2026-08-01T00:00:00.000Z'),
    to: new Date('2026-08-03T00:00:00.000Z'),
    timeline: [],
    identityHistory: [],
    probes: [],
    compatibility: [],
    ...over,
  });

describe('evidence provenance (P-2.3 rec 1)', () => {
  it('gives every entry the same envelope whatever produced it', () => {
    const timeline = TIMELINE({
      timeline: [
        {
          at: '2026-08-01T09:00:00.000Z',
          kind: 'state-changed',
          evidence: 'declared',
          reasonCode: 'onboarded',
          to: 'configured',
          detail: 'onboarded',
        },
      ],
      probes: [RECORD()],
      compatibility: [
        {
          dimension: 'firmware',
          value: 'V5.7.3',
          status: 'supported',
          firstSeenAt: '2026-08-02T09:00:00.000Z',
          lastSeenAt: '2026-08-02T10:00:00.000Z',
          evidenceClass: 'hardware',
          successfulProbes: 1,
          failedProbes: 0,
        },
      ],
    });
    // A consumer reading the envelope never has to know what it is looking at — which is what lets a
    // future evidence type appear without a renderer change (rec 6).
    for (const entry of timeline.entries) {
      expect(entry.evidenceId).toBeTruthy();
      expect(entry.evidenceType).toBeTruthy();
      expect(entry.tenantId).toBe('tnt_a');
      expect(entry.producer).toBeTruthy();
      expect(entry.links.cameraId).toBe('cam_1');
      expect(entry.at).toBeTruthy();
    }
  });

  it('attributes a probe to the runtime that measured it, not the service that stored it', () => {
    const timeline = TIMELINE({ probes: [RECORD({ runtimeVersion: '0.1.0' })] });
    expect(timeline.entries[0]).toMatchObject({
      producer: 'ai-runtime',
      producerVersion: '3',
      runtimeVersion: '0.1.0',
    });
    expect(producersIn(timeline.entries)).toEqual(['ai-runtime']);
  });

  it('derives evidence ids that survive a second read', () => {
    const input = {
      timeline: [
        {
          at: '2026-08-01T09:00:00.000Z',
          kind: 'state-changed' as const,
          evidence: 'declared' as const,
          reasonCode: 'onboarded' as const,
          to: 'configured' as const,
          detail: 'onboarded',
        },
      ],
      probes: [RECORD()],
    };
    // Every link in the timeline points at an id derived from stored data. A generated id would make
    // all of them dangle the moment the page was refreshed.
    expect(TIMELINE(input).entries.map((e) => e.evidenceId)).toEqual(
      TIMELINE(input).entries.map((e) => e.evidenceId),
    );
  });
});

describe('investigation navigation (P-2.3 rec 2/3)', () => {
  it('links each entry to the previous one of the same type, not the row above', () => {
    const timeline = TIMELINE({
      probes: [
        RECORD({ probeId: 'prb_2', sequence: 2, at: '2026-08-02T11:00:00.000Z' }),
        RECORD({ probeId: 'prb_1', sequence: 1, at: '2026-08-02T10:00:00.000Z' }),
      ],
      identityHistory: [
        {
          at: '2026-08-02T10:30:00.000Z',
          attribute: 'address',
          from: '10.0.0.60',
          to: '10.0.0.64',
          source: 'discovery',
        },
      ],
    });
    const newest = timeline.entries.find((e) => e.evidenceId === 'probe:prb_2');
    // The identity change sits between them in time and is deliberately not the answer to
    // "the probe before this one".
    expect(newest?.links.previousEvidenceId).toBe('probe:prb_1');
  });

  it('walks causation in both directions', () => {
    const timeline = TIMELINE({
      timeline: [
        {
          at: '2026-08-02T10:00:01.000Z',
          kind: 'state-changed',
          evidence: 'measured',
          reasonCode: 'hardware-evidence',
          probeId: 'prb_other',
          from: 'configured',
          to: 'degraded',
          detail: 'first-frame failed',
        },
      ],
      probes: [RECORD({ probeId: 'prb_other', correlationId: 'corr-1' })],
    });
    const probe = timeline.entries.find((e) => e.evidenceId === 'probe:prb_other');
    const state = timeline.entries.find((e) => e.source === 'lifecycle');
    // Backwards answers "why did this happen"; forwards answers "what did it break", which is what
    // decides whether an incident is over.
    expect(state?.links.rootCauseEvidenceId).toBe('probe:prb_other');
    expect(probe?.links.causedEvidenceIds).toContain(state?.evidenceId);
    // And nothing is ever its own root cause.
    expect(probe?.links.rootCauseEvidenceId).toBeUndefined();
  });
});

describe('operational decisions (P-2.3 rec 8)', () => {
  const log = (over: Partial<Parameters<typeof explainDecisions>[0]> = {}) =>
    explainDecisions({
      cameraId: 'cam_1',
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-03T00:00:00.000Z'),
      timeline: [],
      probes: [],
      compatibility: [],
      confidence: { band: 'insufficient-evidence', observations: 0, basis: [] },
      ...over,
    });

  it("explains why a probe was marked failed, in the runtime's own terms", () => {
    const decisions = log({
      probes: [RECORD({ outcome: 'failed', failureCode: 'no-first-frame' })],
    }).decisions;
    const outcome = decisions.find((d) => d.kind === 'probe-outcome');
    expect(outcome).toMatchObject({ decision: 'failed', actor: 'runtime' });
    expect(outcome?.reason).toContain('no-first-frame');
    // A decision with no supporting evidence is an opinion, and the platform does not issue those.
    expect(outcome?.supportingEvidence).toEqual(['probe:prb_1']);
  });

  it('explains why a flawless simulated probe moved nothing', () => {
    const decisions = log({ probes: [RECORD({ evidenceClass: 'simulated' })] }).decisions;
    const unchanged = decisions.find((d) => d.decision === 'unchanged');
    // The negative control, made legible. Without this the state staying put looks like a bug to
    // whoever is watching it not move.
    expect(unchanged?.reason).toContain('hardware evidence');
    expect(unchanged?.evidenceClass).toBe('simulated');
  });

  it('explains a compatibility status by naming what it deliberately ignores', () => {
    const decisions = log({
      compatibility: [
        {
          dimension: 'firmware',
          value: 'V5.8.0',
          status: 'unsupported',
          firstSeenAt: '2026-08-02T09:00:00.000Z',
          lastSeenAt: '2026-08-02T10:00:00.000Z',
          evidenceClass: 'hardware',
          successfulProbes: 0,
          failedProbes: 3,
        },
      ],
    }).decisions;
    const status = decisions.find((d) => d.kind === 'compatibility-status');
    expect(status?.reason).toContain('network and credential failures are deliberately excluded');
  });
});

describe('confidence trend (P-2.3 rec 4)', () => {
  it('leaves a gap where nothing was measured rather than interpolating one', () => {
    const trend = confidenceTrend({
      cameraId: 'cam_1',
      window: 'month',
      windowStart: new Date('2026-07-03T00:00:00.000Z'),
      windowEnd: new Date('2026-08-02T00:00:00.000Z'),
      probes: [],
      current: { band: 'insufficient-evidence', observations: 0, basis: [] },
    });
    expect(trend.points).toHaveLength(12);
    // Interpolating would draw a confident line through a period nobody measured — the same lie as a
    // lifetime average, just prettier.
    expect(trend.points.every((p) => p.score === undefined)).toBe(true);
    expect(trend.points.every((p) => p.band === 'insufficient-evidence')).toBe(true);
  });

  it('scores a bucket that has enough probes in it', () => {
    const at = '2026-08-01T23:00:00.000Z';
    const trend = confidenceTrend({
      cameraId: 'cam_1',
      window: 'month',
      windowStart: new Date('2026-07-03T00:00:00.000Z'),
      windowEnd: new Date('2026-08-02T00:00:00.000Z'),
      probes: [1, 2, 3].map((n) => RECORD({ probeId: `prb_${n}`, sequence: n, at })),
      current: { band: 'stable', score: 100, observations: 3, basis: [] },
    });
    const scored = trend.points.filter((p) => p.score !== undefined);
    expect(scored).toHaveLength(1);
    expect(scored[0]?.band).toBe('stable');
  });
});

/**
 * Production certification contract tests (AI-5e). These shapes exist to stop the platform claiming
 * something it has not measured, so the tests are mostly about what the shapes REFUSE: a certification
 * with no evidence class, a promotion with no report ids, a default that is anything other than
 * "pending-validation".
 */
import { describe, expect, it } from 'vitest';
import {
  CertificationCheck,
  CertificationTarget,
  TargetKind,
  CertificationStatus,
  CompatibilityReport,
  CapabilityReport,
  DriftMeasurement,
  SoakReport,
  CertificationSummary,
  CertificationBundle,
  CameraRegistryEntry,
  MaturityLevel,
  MaturityEvidence,
  MaturityPromotion,
  HardwareRecommendation,
} from '../src/certification/certification.js';
import { EvidenceClass, isHardwareEvidence } from '../src/common/evidence.js';

const AT = '2026-08-01T10:00:00.000Z';

const target = {
  id: 'hikvision-ds2cd2143g2',
  label: 'Hikvision DS-2CD2143G2 (RTSP/ONVIF)',
  device: { manufacturer: 'Hikvision', model: 'DS-2CD2143G2' },
  transports: ['rtsp', 'onvif'],
  kind: 'camera' as const,
};

describe('EvidenceClass', () => {
  it('has one predicate for the rule that governs certification, maturity and device lifecycle', () => {
    expect(isHardwareEvidence('hardware')).toBe(true);
    expect(isHardwareEvidence('recorded-footage')).toBe(false);
    expect(isHardwareEvidence('simulated')).toBe(false);
  });

  it('orders weakest to strongest — simulation never certifies', () => {
    expect(EvidenceClass.options).toEqual(['simulated', 'recorded-footage', 'hardware']);
  });
});

describe('CertificationStatus', () => {
  it('offers pending-validation, which is the honest default for an untested device', () => {
    expect(CertificationStatus.options).toContain('pending-validation');
    expect(CertificationStatus.options).toContain('certified');
  });
});

describe('CertificationCheck', () => {
  it('parses a measured check and defaults to mandatory', () => {
    const c = CertificationCheck.parse({
      name: 'sustained-fps',
      status: 'pass',
      measured: 7.2,
      expected: 5,
      unit: 'fps',
      evidenceClass: 'hardware',
    });
    expect(c.mandatory).toBe(true);
    expect(c.evidenceClass).toBe('hardware');
  });

  it('requires an evidence class — a check that cannot say what it ran on is an opinion', () => {
    expect(() => CertificationCheck.parse({ name: 'connect', status: 'pass' })).toThrow();
  });

  it('distinguishes not-executed from skipped', () => {
    expect(CertificationCheck.shape.status.options).toEqual([
      'pass',
      'fail',
      'warn',
      'skipped',
      'not-executed',
    ]);
  });
});

describe('CertificationTarget', () => {
  it('parses a device target and defaults to a camera', () => {
    const t = CertificationTarget.parse({
      id: 'generic-onvif',
      label: 'Generic ONVIF camera',
      device: {},
    });
    expect(t.kind).toBe('camera');
    expect(t.transports).toEqual([]);
  });

  it('accepts DVR/NVR estates as first-class targets', () => {
    expect(TargetKind.options).toContain('dvr');
    expect(TargetKind.options).toContain('nvr');
    expect(
      CertificationTarget.parse({ id: 'nvr', label: 'NVR', device: {}, kind: 'nvr' }).kind,
    ).toBe('nvr');
  });
});

describe('CompatibilityReport', () => {
  it('parses a pending report with simulated evidence', () => {
    const r = CompatibilityReport.parse({
      id: 'compat_1',
      target,
      runtimeVersion: '1.0.0',
      status: 'pending-validation',
      evidenceClass: 'simulated',
      recordedAt: AT,
    });
    expect(r.checks).toEqual([]);
    expect(r.status).toBe('pending-validation');
  });
});

describe('CapabilityReport', () => {
  it('records what a capability produced, with the maturity it held going in', () => {
    const r = CapabilityReport.parse({
      id: 'cap_1',
      targetId: target.id,
      runtimeVersion: '1.0.0',
      evidenceClass: 'recorded-footage',
      recordedAt: AT,
      observations: [
        {
          capabilityId: 'person-detection',
          eventType: 'perception.person.detected',
          maturity: 'beta',
          exercised: true,
          detections: 412,
          evidenceClass: 'recorded-footage',
        },
      ],
    });
    expect(r.observations[0].behaviors).toBe(0);
    expect(r.observations[0].maturity).toBe('beta');
  });
});

describe('DriftMeasurement + SoakReport', () => {
  it('parses a memory drift measurement', () => {
    const d = DriftMeasurement.parse({
      metric: 'memoryMb',
      unit: 'MB',
      first: 118,
      last: 121,
      min: 116,
      max: 124,
      drift: 3,
      driftPercent: 2.54,
      toleratedPercent: 10,
      status: 'pass',
    });
    expect(d.driftPercent).toBeCloseTo(2.54);
  });

  it('does not pass a soak by default', () => {
    const s = SoakReport.parse({
      id: 'soak_1',
      targetId: target.id,
      runtimeVersion: '1.0.0',
      plannedHours: 24,
      actualHours: 24,
      evidenceClass: 'simulated',
      startedAt: AT,
      recordedAt: AT,
    });
    expect(s.passed).toBe(false);
    expect(s.blockers).toEqual([]);
    expect(s.drift).toEqual([]);
  });
});

describe('CertificationSummary', () => {
  it('parses a summary that names its blockers', () => {
    const s = CertificationSummary.parse({
      id: 'cert_1',
      target,
      runtimeVersion: '1.0.0',
      status: 'pending-validation',
      evidenceClass: 'simulated',
      blockers: ['no physical device tested'],
      recordedAt: AT,
    });
    expect(s.certificationVersion).toBe('1.0.0');
    expect(s.blockers).toHaveLength(1);
    expect(s.benchmarkIds).toEqual([]);
  });
});

describe('CertificationBundle', () => {
  it('parses the customer validation package with only a summary', () => {
    const b = CertificationBundle.parse({
      id: 'bundle_1',
      runtimeVersion: '1.0.0',
      generatedAt: AT,
      summary: {
        id: 'cert_1',
        target,
        runtimeVersion: '1.0.0',
        status: 'pending-validation',
        evidenceClass: 'simulated',
        recordedAt: AT,
      },
    });
    expect(b.benchmarks).toEqual([]);
    expect(b.logs).toEqual([]);
    expect(b.configuration).toEqual({});
  });
});

describe('CameraRegistryEntry', () => {
  it('defaults a new entry to pending-validation with no evidence', () => {
    const e = CameraRegistryEntry.parse({
      id: 'cp-plus-generic',
      manufacturer: 'CP Plus',
      model: 'Generic RTSP',
      status: 'pending-validation',
      updatedAt: AT,
    });
    expect(e.evidence).toEqual([]);
    expect(e.evidenceClass).toBe('simulated');
    expect(e.certifiedAt).toBeUndefined();
    expect(e.knownIssues).toEqual([]);
  });
});

describe('MaturityPromotion', () => {
  it('enumerates the ladder from CAPABILITY_MATURITY §1', () => {
    expect(MaturityLevel.options).toEqual(['experimental', 'beta', 'production', 'deprecated']);
  });

  it('requires an evidence class on the evidence itself', () => {
    expect(() => MaturityEvidence.parse({})).toThrow();
  });

  it('parses a refused promotion carrying its reasons', () => {
    const p = MaturityPromotion.parse({
      capabilityId: 'person-detection',
      from: 'beta',
      to: 'production',
      granted: false,
      evidence: { evidenceClass: 'simulated' },
      blockers: ['production requires hardware evidence'],
      decidedAt: AT,
    });
    expect(p.granted).toBe(false);
    expect(p.evidence.evaluationReportIds).toEqual([]);
  });
});

describe('HardwareRecommendation', () => {
  it('marks an unmeasured recommendation as an estimate by default', () => {
    const r = HardwareRecommendation.parse({
      profile: 'retail-store',
      cameras: 8,
      targetFps: 5,
      recommendedClass: 'mini-pc-i5',
      requiredCapacityUnits: 64,
      availableCapacityUnits: 100,
      headroomPercent: 36,
    });
    expect(r.estimated).toBe(true);
    expect(r.basis).toBeUndefined();
    expect(r.feasible).toBe(true);
  });
});

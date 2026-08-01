/**
 * CCTV dataset + accuracy-evaluation contract tests (AI-5e). The two properties worth protecting here
 * are that footage must declare a licence (surveillance footage of real people is not casually
 * collected) and that `footage-missing` is a status of its own — never a pass.
 */
import { describe, expect, it } from 'vitest';
import {
  ScenarioCategory,
  FootageReference,
  ExpectedOccurrence,
  DatasetCase,
  EvaluationOutcome,
  EvaluationFinding,
  EvaluationStatus,
  EvaluationReport,
  EvaluationSummary,
} from '../src/dataset/dataset.js';

const AT = '2026-08-01T10:00:00.000Z';

const footage = {
  path: 'ai/datasets/loitering/entrance-dwell-01.mp4',
  origin: 'public-dataset' as const,
  licence: 'CC-BY-4.0',
};

describe('ScenarioCategory', () => {
  it('covers the AI-5e priority-1 scenario list', () => {
    for (const c of [
      'shoplifting',
      'cashier_theft',
      'suspicious_behavior',
      'loitering',
      'queue',
      'crowd',
      'intrusion',
      'restricted_area',
      'fire',
      'smoke',
      'violence',
      'abandoned_object',
      'fall_detection',
      'ppe',
      'customer_movement',
      'staff_movement',
    ]) {
      expect(ScenarioCategory.options).toContain(c);
    }
  });
});

describe('FootageReference', () => {
  it('parses a reference with a licence', () => {
    const f = FootageReference.parse(footage);
    expect(f.licence).toBe('CC-BY-4.0');
    expect(f.sha256).toBeUndefined();
  });

  it('rejects footage with no recorded licence or consent basis', () => {
    expect(() => FootageReference.parse({ path: 'x.mp4', origin: 'customer-pilot' })).toThrow();
  });

  it('rejects a malformed digest — results pin to exact bytes or to none', () => {
    expect(() => FootageReference.parse({ ...footage, sha256: 'nope' })).toThrow();
  });
});

describe('ExpectedOccurrence', () => {
  it('parses a windowed behavior expectation', () => {
    const e = ExpectedOccurrence.parse({
      kind: 'behavior',
      type: 'loitering',
      count: 1,
      fromSeconds: 12,
      toSeconds: 31,
    });
    expect(e.countTolerance).toBe(0);
    expect(e.absent).toBe(false);
  });

  it('expresses a negative expectation — false positives are assertable', () => {
    const e = ExpectedOccurrence.parse({
      kind: 'event',
      type: 'security.intrusion.detected',
      absent: true,
    });
    expect(e.absent).toBe(true);
  });
});

describe('DatasetCase', () => {
  it('parses a case with expectations and defaults', () => {
    const c = DatasetCase.parse({
      id: 'loitering/entrance-dwell-01',
      category: 'loitering',
      title: 'Single subject dwelling at the entrance',
      footage,
      expectations: [{ kind: 'behavior', type: 'loitering', count: 1 }],
    });
    expect(c.zones).toEqual([]);
    expect(c.options).toEqual({});
    expect(c.futureImprovements).toEqual([]);
  });
});

describe('EvaluationReport', () => {
  it('names both failure directions', () => {
    expect(EvaluationOutcome.options).toEqual([
      'match',
      'missing',
      'unexpected',
      'out-of-tolerance',
      'deferred',
    ]);
  });

  it('keeps footage-missing distinct from pass and fail', () => {
    expect(EvaluationStatus.options).toEqual(['pass', 'fail', 'footage-missing', 'error']);
  });

  it('parses a skipped evaluation with null accuracy rather than a zero', () => {
    const r = EvaluationReport.parse({
      id: 'eval_1',
      caseId: 'loitering/entrance-dwell-01',
      category: 'loitering',
      status: 'footage-missing',
      runtimeVersion: '1.0.0',
      evidenceClass: 'recorded-footage',
      recordedAt: AT,
    });
    expect(r.precision).toBeNull();
    expect(r.recall).toBeNull();
    expect(r.findings).toEqual([]);
  });

  it('parses a finding for a false negative', () => {
    const f = EvaluationFinding.parse({
      kind: 'behavior',
      type: 'loitering',
      outcome: 'missing',
      expectedCount: 1,
      window: '12.0-31.0s',
    });
    expect(f.observedCount).toBe(0);
  });
});

describe('EvaluationSummary', () => {
  it('does not accept a run by default', () => {
    const s = EvaluationSummary.parse({
      id: 'evalsum_1',
      runtimeVersion: '1.0.0',
      evidenceClass: 'recorded-footage',
      recordedAt: AT,
    });
    expect(s.accepted).toBe(false);
    expect(s.skipped).toBe(0);
    expect(s.byCategory).toEqual({});
  });
});

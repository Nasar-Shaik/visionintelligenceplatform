/**
 * P-5.2.0 — background jobs (rec 4) and the report model (rec 5 + refinement 4).
 *
 * Two assertions carry most of the weight: a job result holds a **storage key and never a URL**,
 * and a report **omits** what it cannot know rather than zeroing it.
 */
import { describe, expect, it } from 'vitest';
import {
  Job,
  JobProgress,
  JobResult,
  JobSchedule,
  JobState,
  SubmitJobInput,
  TERMINAL_JOB_STATES,
  isTerminalJobState,
  jobPercent,
} from '../src/jobs/job.js';
import {
  REPORT_SECTION_ORDER,
  ReportModel,
  ReportPresentation,
  ReportSectionKind,
  ReportThemeId,
} from '../src/reporting/report.js';

const job = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tnt_a',
  kind: 'report.render' as const,
  owner: 'workflow' as const,
  state: 'queued' as const,
  requestKey: 'report:inc_1:v7:pdf',
  requestedBy: 'usr_1',
  queuedAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
};

describe('Job — the four failure modes', () => {
  it('parses and defaults', () => {
    const parsed = Job.parse(job);
    expect(parsed.attempts).toBe(0);
    expect(parsed.input).toEqual({});
  });

  /*
   * ⚠️ Failure mode 2. A signed URL written into a job record outlives its own expiry — a broken
   * link at best, a credential in a queryable collection at worst.
   */
  it('⚠️ a result holds a storage key, never a URL', () => {
    const parsed = JobResult.parse({
      storageKey: 'tnt_a/exports/report-1.pdf',
      contentType: 'application/pdf',
      sizeBytes: 100,
      url: 'https://signed.example/abc',
    });
    expect(parsed).not.toHaveProperty('url');
    expect(parsed.storageKey).toBe('tnt_a/exports/report-1.pdf');
  });

  /* Failure mode 3 — a double-click must not produce two 400 MB exports. */
  it('carries an idempotency key on every job', () => {
    const { requestKey: _omit, ...withoutKey } = job;
    expect(Job.safeParse(withoutKey).success).toBe(false);
    expect(SubmitJobInput.parse({ kind: 'export.bulk' }).requestKey).toBeUndefined();
  });

  /* Failure mode 1 — an eternal spinner is a worker that died holding a claim. */
  it('supports a lease so a dead worker does not leave a job running forever', () => {
    const parsed = Job.parse({
      ...job,
      state: 'running',
      leaseExpiresAt: '2026-08-03T00:05:00.000Z',
    });
    expect(parsed.leaseExpiresAt).toBe('2026-08-03T00:05:00.000Z');
  });

  /*
   * ⚠️ There is no `partial`. "Partly succeeded" is where the archive missing four clips ends up,
   * handed to someone who assumes it is complete.
   */
  it('⚠️ has no partial-success state', () => {
    expect(JobState.options).toEqual(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
    expect(JobState.safeParse('partial').success).toBe(false);
  });

  it('knows which states are terminal', () => {
    expect(TERMINAL_JOB_STATES).toEqual(['succeeded', 'failed', 'cancelled']);
    expect(isTerminalJobState('running')).toBe(false);
    expect(isTerminalJobState('failed')).toBe(true);
  });
});

describe('JobProgress — unknown is not zero', () => {
  const at = '2026-08-03T00:00:00.000Z';

  /* Failure mode 4. `0%` reads as "nothing has happened"; indeterminate reads as "working". */
  it('⚠️ returns undefined, not 0, when the total is unknown', () => {
    expect(jobPercent(JobProgress.parse({ completed: 12, updatedAt: at }))).toBeUndefined();
    expect(
      jobPercent(JobProgress.parse({ completed: 0, total: 0, updatedAt: at })),
    ).toBeUndefined();
  });

  it('computes a percentage only when the total is known', () => {
    expect(jobPercent(JobProgress.parse({ completed: 5, total: 10, updatedAt: at }))).toBe(50);
  });

  it('never exceeds 100 even if a worker over-counts', () => {
    expect(jobPercent(JobProgress.parse({ completed: 30, total: 10, updatedAt: at }))).toBe(100);
  });

  it('stores no percent field, so the two can never disagree', () => {
    expect(JobProgress.parse({ completed: 5, total: 10, updatedAt: at })).not.toHaveProperty(
      'percent',
    );
  });
});

describe('JobSchedule — a schedule is not a job', () => {
  it('is a separate record, and is disabled by default', () => {
    const parsed = JobSchedule.parse({
      id: '22222222-2222-4222-8222-222222222222',
      tenantId: 'tnt_a',
      name: 'Weekly incident summary',
      kind: 'report.render',
      cron: '0 9 * * 1',
      timezone: 'Europe/London',
      createdBy: 'usr_1',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    });
    /* ⚠️ Frozen with no runner. Declared so the shape settles, not so it quietly switches on. */
    expect(parsed.enabled).toBe(false);
    expect(parsed).not.toHaveProperty('state');
  });

  it('requires a timezone — "9am" is a local claim', () => {
    expect(
      JobSchedule.safeParse({
        id: '22222222-2222-4222-8222-222222222222',
        tenantId: 'tnt_a',
        name: 'x',
        kind: 'report.render',
        cron: '0 9 * * 1',
        createdBy: 'usr_1',
        createdAt: '2026-08-03T00:00:00.000Z',
        updatedAt: '2026-08-03T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('ReportModel — provenance and omission', () => {
  const model = {
    tenantId: 'tnt_a',
    title: 'Incident report',
    provenance: {
      incidentId: '33333333-3333-4333-8333-333333333333',
      incidentVersion: 7,
      correlationId: 'corr_1',
      generatedAt: '2026-08-03T00:00:00.000Z',
      generatedBy: 'usr_1',
    },
  };

  /*
   * ⚠️ Decision 1. Without the version, two PDFs of "the incident report" circulate and nothing
   * distinguishes the one someone acted on from the one that superseded it.
   */
  it('⚠️ pins the exact incident version it describes', () => {
    const parsed = ReportModel.parse(model);
    expect(parsed.provenance.incidentVersion).toBe(7);
    const { incidentVersion: _omit, ...withoutVersion } = model.provenance;
    expect(ReportModel.safeParse({ ...model, provenance: withoutVersion }).success).toBe(false);
  });

  /* Decision 2 — "AI Findings: none" and "no AI has looked at this" are different claims. */
  it('⚠️ distinguishes no-data from not-available in an omission', () => {
    const parsed = ReportModel.parse({
      ...model,
      omissions: [
        { kind: 'ai-findings', reason: 'not-available', detail: 'no AI advisor configured' },
        { kind: 'operator-notes', reason: 'no-data', detail: 'no notes were written' },
      ],
    });
    expect(parsed.omissions.map((o) => o.reason)).toEqual(['not-available', 'no-data']);
  });

  it('defaults to no sections and no omissions rather than empty placeholders', () => {
    const parsed = ReportModel.parse(model);
    expect(parsed.sections).toEqual([]);
    expect(parsed.omissions).toEqual([]);
  });

  it('covers every requested section kind', () => {
    expect([...REPORT_SECTION_ORDER].sort()).toEqual([...ReportSectionKind.options].sort());
  });
});

describe('ReportPresentation — a theme may not choose content', () => {
  /*
   * ⚠️ Decision 3. If a theme could drop the audit trail, "the Executive report" and "the Police
   * report" of one incident would say different things while both claiming to be the report.
   */
  it('⚠️ carries no field that can include or exclude a section', () => {
    const parsed = ReportPresentation.parse({});
    expect(parsed).not.toHaveProperty('sections');
    expect(parsed).not.toHaveProperty('excludeSections');
    expect(parsed).not.toHaveProperty('includeSections');
    /* Reordering is presentation; selection is not. */
    expect(ReportPresentation.parse({ sectionOrder: ['timeline'] }).sectionOrder).toEqual([
      'timeline',
    ]);
  });

  /*
   * ⚠️ Decision 4 + CONSTRAINTS §36 — no industry noun enters a platform type. The six named
   * themes ship as configuration presets, so a customer can add one without a contract release.
   */
  it('⚠️ treats a theme as an opaque configured slug, not an enum of industries', () => {
    for (const preset of [
      'executive',
      'security',
      'retail',
      'manufacturing',
      'healthcare',
      'police',
    ]) {
      expect(ReportThemeId.safeParse(preset).success).toBe(true);
    }
    expect(ReportThemeId.safeParse('logistics').success).toBe(true);
    expect(ReportThemeId.safeParse('Retail Store').success).toBe(false);
  });

  it('defaults to a complete, printable report', () => {
    const parsed = ReportPresentation.parse({});
    expect(parsed.format).toBe('pdf');
    expect(parsed.includeCoverPage).toBe(true);
    expect(parsed.embedEvidence).toBe(true);
  });
});

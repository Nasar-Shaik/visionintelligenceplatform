/**
 * Rule-engine evaluation metrics (P1-7 Architect review #4) — observability for the automation brain.
 * Registered on the service's Prometheus registry (the same one `/metrics` serves), so evaluation
 * throughput, match/candidate rates, skips, and per-event latency are all scrapeable. Kept as a
 * small injected collaborator so the engine stays testable (a no-op instance is fine in unit tests).
 */
import { Counter, Histogram, type Registry } from 'prom-client';

export class RuleMetrics {
  readonly eventsConsumed: Counter<string>;
  readonly eventsDeadLettered: Counter<string>;
  readonly rulesEvaluated: Counter<string>;
  readonly rulesMatched: Counter<string>;
  readonly candidatesRaised: Counter<string>;
  readonly evaluationDuration: Histogram<string>;
  // --- P-8 Phase 7 -----------------------------------------------------------------------------
  readonly dwellWithoutIdentity: Counter<string>;
  readonly dwellSuppressedByCooldown: Counter<string>;
  readonly candidatesSuppressedByDryRun: Counter<string>;
  readonly zoneNameUnresolved: Counter<string>;
  readonly candidateLatency: Histogram<string>;
  readonly ingestLatency: Histogram<string>;

  constructor(registry: Registry) {
    this.eventsConsumed = new Counter({
      name: 'rules_events_consumed_total',
      help: 'Events received from the backbone for evaluation',
      registers: [registry],
    });
    this.eventsDeadLettered = new Counter({
      name: 'rules_events_dead_lettered_total',
      help: 'Events dead-lettered (invalid envelope — fail-closed)',
      registers: [registry],
    });
    this.rulesEvaluated = new Counter({
      name: 'rules_evaluated_total',
      help: 'Individual rule evaluations performed',
      registers: [registry],
    });
    this.rulesMatched = new Counter({
      name: 'rules_matched_total',
      help: 'Rule evaluations that matched (stateless + window)',
      registers: [registry],
    });
    this.candidatesRaised = new Counter({
      name: 'rules_incident_candidates_total',
      help: 'Incident candidates published',
      labelNames: ['severity'],
      registers: [registry],
    });
    this.evaluationDuration = new Histogram({
      name: 'rules_event_evaluation_duration_seconds',
      help: "Time to evaluate one event against all of a tenant's enabled rules",
      buckets: [0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
      registers: [registry],
    });

    /*
     * ⚠️ A non-zero rate here means a dwell rule is receiving events it cannot accumulate: the
     * producer is not stamping identity. The rule looks enabled and healthy and will never fire, so
     * this counter is the only thing standing between that state and a silent product failure.
     */
    this.dwellWithoutIdentity = new Counter({
      name: 'rules_dwell_without_identity_total',
      help: 'Dwell evaluations skipped because the event carried no identity or track id',
      registers: [registry],
    });
    this.dwellSuppressedByCooldown = new Counter({
      name: 'rules_dwell_cooldown_suppressed_total',
      help: 'Dwell thresholds met but held silent by the rule cool-down',
      registers: [registry],
    });
    this.candidatesSuppressedByDryRun = new Counter({
      name: 'rules_dry_run_withheld_total',
      help: 'Candidates built and deliberately not published because the rule is in dry run',
      registers: [registry],
    });
    /*
     * ⚠️ A zoned event whose zone the catalogue could not name. The candidate is raised regardless —
     * this must never block an alert — but it carries no `zoneVersion`, so the incident detail page
     * cannot fetch the geometry it was judged against and silently shows today's instead. Non-zero
     * here means some incidents cannot be re-examined against their own evidence.
     */
    this.zoneNameUnresolved = new Counter({
      name: 'rules_zone_name_unresolved_total',
      help: 'Candidates whose detection zone the catalogue could not name (no zoneName, no zoneVersion)',
      registers: [registry],
    });

    /*
     * The three latencies the Architect asked to be able to separate (P-8 Phase 7 rec 6).
     *
     * ⚠️ Two of the three are measurable here and the third is not, so only two are recorded:
     *
     *  - `ingestLatency`  — event `occurredAt` → this engine consuming it. **Event → Rule.**
     *  - `candidateLatency` — event `occurredAt` → candidate published. **End-to-end from the frame.**
     *
     * `evaluationDuration` is already the pure Rule → Candidate cost, measured with one clock inside
     * one process. Subtracting it from `candidateLatency` gives the transport share. What is NOT
     * measured here is the camera→event half, because this service never sees the frame — that lives
     * on the media side and is reported there. Reconstructing it by differencing two services' wall
     * clocks would be measuring skew and calling it latency.
     *
     * ⚠️ Buckets reach 30s because a dwell candidate's `occurredAt` is the frame's capture time and a
     * backlog after an outage is legitimately minutes old. A histogram whose top bucket is 0.5s
     * reports every one of those identically, which is the failure mode that hides a recovering
     * pipeline.
     */
    this.ingestLatency = new Histogram({
      name: 'rules_event_ingest_latency_seconds',
      help: 'From an event occurring to the rule engine consuming it (event → rule)',
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [registry],
    });
    this.candidateLatency = new Histogram({
      name: 'rules_candidate_latency_seconds',
      help: 'From an event occurring to its incident candidate being published (end to end)',
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [registry],
    });
  }
}

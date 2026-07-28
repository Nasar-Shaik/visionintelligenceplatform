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
  }
}

/**
 * Incident lifecycle metrics — observability for the Workflow context. Registered on the service's
 * Prometheus registry (the same one `/metrics` serves) so promotion throughput, dedup collapse, and
 * lifecycle transitions are scrapeable. A small injected collaborator (a no-op instance is fine in
 * unit tests that don't assert metrics).
 */
import { Counter, Histogram, type Registry } from 'prom-client';

export class IncidentMetrics {
  readonly candidatesConsumed: Counter<string>;
  readonly candidatesDeadLettered: Counter<string>;
  readonly incidentsRaised: Counter<string>;
  readonly candidatesDeduplicated: Counter<string>;
  readonly transitions: Counter<string>;
  readonly promotionDuration: Histogram<string>;

  constructor(registry: Registry) {
    this.candidatesConsumed = new Counter({
      name: 'workflow_incident_candidates_consumed_total',
      help: 'Incident candidates received from the automation backbone',
      registers: [registry],
    });
    this.candidatesDeadLettered = new Counter({
      name: 'workflow_incident_candidates_dead_lettered_total',
      help: 'Candidates dead-lettered (invalid contract — fail-closed)',
      registers: [registry],
    });
    this.incidentsRaised = new Counter({
      name: 'workflow_incidents_raised_total',
      help: 'Incidents promoted (raised) from a candidate',
      labelNames: ['severity'],
      registers: [registry],
    });
    this.candidatesDeduplicated = new Counter({
      name: 'workflow_incident_candidates_deduplicated_total',
      help: 'Candidates that collapsed into an already-raised incident (idempotent promotion)',
      registers: [registry],
    });
    this.transitions = new Counter({
      name: 'workflow_incident_transitions_total',
      help: 'Incident lifecycle transitions applied',
      labelNames: ['to'],
      registers: [registry],
    });
    this.promotionDuration = new Histogram({
      name: 'workflow_incident_promotion_duration_seconds',
      help: 'Time to promote one candidate into an incident',
      buckets: [0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
      registers: [registry],
    });
  }
}

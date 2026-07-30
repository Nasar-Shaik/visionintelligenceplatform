/**
 * Evidence metrics — observability for the Evidence context, registered on the service's Prometheus
 * registry (the same one `/metrics` serves). A small injected collaborator (a no-op is fine in unit
 * tests that don't assert metrics).
 */
import { Counter, type Registry } from 'prom-client';

export class EvidenceMetrics {
  readonly registered: Counter<string>;
  readonly registrationsDeduplicated: Counter<string>;
  readonly downloads: Counter<string>;
  readonly metadataUpdates: Counter<string>;
  readonly retentionSets: Counter<string>;
  readonly incidentsConsumed: Counter<string>;
  readonly incidentsDeadLettered: Counter<string>;
  readonly extractionErrors: Counter<string>;

  constructor(registry: Registry) {
    this.registered = new Counter({
      name: 'evidence_registered_total',
      help: 'Evidence items registered',
      labelNames: ['kind'],
      registers: [registry],
    });
    this.registrationsDeduplicated = new Counter({
      name: 'evidence_registrations_deduplicated_total',
      help: 'Re-registrations of an already-known object (idempotent)',
      registers: [registry],
    });
    this.downloads = new Counter({
      name: 'evidence_downloads_total',
      help: 'Signed download/playback URLs issued (audited access)',
      registers: [registry],
    });
    this.metadataUpdates = new Counter({
      name: 'evidence_metadata_updates_total',
      help: 'Version-safe metadata updates applied',
      registers: [registry],
    });
    this.retentionSets = new Counter({
      name: 'evidence_retention_sets_total',
      help: 'Retention / legal-hold changes applied',
      registers: [registry],
    });
    this.incidentsConsumed = new Counter({
      name: 'evidence_incidents_consumed_total',
      help: 'Raised incidents received from the automation backbone',
      registers: [registry],
    });
    this.incidentsDeadLettered = new Counter({
      name: 'evidence_incidents_dead_lettered_total',
      help: 'Incidents dead-lettered (invalid contract — fail-closed)',
      registers: [registry],
    });
    this.extractionErrors = new Counter({
      name: 'evidence_extraction_errors_total',
      help: 'Errors during incident → evidence extraction',
      registers: [registry],
    });
  }
}

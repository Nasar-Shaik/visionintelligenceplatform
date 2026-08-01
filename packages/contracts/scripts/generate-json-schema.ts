/**
 * Codegen: emit JSON Schema for the published contracts into ./generated.
 * These artifacts feed OpenAPI generation, cross-language SDKs, and contract testing
 * (docs/architecture/03 §Contract testing, 21 §3). Run: `pnpm --filter @vip/contracts codegen`.
 *
 * Uses Zod 4's NATIVE `z.toJSONSchema()` (no external converter dependency).
 * JSON Schema (not TS types) is the language-neutral wire form; TS types come from Zod inference.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { EventEnvelope } from '../src/events/envelope.js';
import { EventCatalogEntry } from '../src/events/catalog.js';
import { EventQuery } from '../src/events/query.js';
import { Rule, CreateRuleInput, IncidentCandidate, RuleDryRunResult } from '../src/rules/rules.js';
import { Incident, IncidentQuery } from '../src/incidents/incident.js';
import {
  Notification,
  NotificationChannel,
  CreateChannelInput,
} from '../src/notifications/notification.js';
import { CapabilityDescriptor, CapabilityRegistryRecord } from '../src/capability/descriptor.js';
import { TenantContext } from '../src/common/tenant-context.js';
import { ApiError } from '../src/common/api-envelope.js';
import { ConfigNode } from '../src/config/hierarchy.js';
import { Tenant, OrgNode } from '../src/tenant/tenant.js';
import { User, Principal, TokenPair } from '../src/auth/auth.js';
import { Camera, CaptureProfile, CameraHealth } from '../src/camera/camera.js';
import {
  StreamStatus,
  RecordingSegment,
  Recording,
  CreateClipInput,
  Clip,
  PlaybackTarget,
  StreamHealthSummary,
} from '../src/media/media.js';
import { Detection, DetectionResult, InferenceRequest } from '../src/perception/perception.js';
import { Track, Zone, ZoneTransition, CountingSnapshot } from '../src/tracking/tracking.js';
import {
  BehaviorResult,
  TrackSnapshot,
  BehaviorConfig,
  BehaviorAnalyzerMetrics,
  CompositeBehavior,
  BehaviorProfile,
} from '../src/behavior/behavior.js';
import {
  BenchmarkReport,
  BenchmarkWorkload,
  PerformanceBudget,
  BenchmarkKpis,
  EnvironmentFingerprint,
} from '../src/benchmark/benchmark.js';
import {
  Evidence,
  EvidenceManifest,
  RegisterEvidenceInput,
  UpdateEvidenceMetadataInput,
  SetRetentionInput,
  EvidenceQuery,
  EvidencePage,
  EvidenceDownloadTarget,
  EvidenceCustodyEntry,
  EvidenceCustodyPage,
} from '../src/evidence/evidence.js';
import {
  ModelRegistration,
  RegisterModelInput,
  ModelVersion,
  ModelCapabilityProfile,
  InferenceSession,
  StartInferenceSessionInput,
  RuntimeMetrics,
  PipelineDefinition,
  StreamSourceConfig,
  StreamIngestionStats,
  StreamBackpressureStats,
  RuntimeFailureSummary,
  SessionIdentity,
  SessionDiagnostics,
  SessionSupervisorStats,
  SchedulerPolicy,
  SchedulerStats,
  SchedulerDecision,
  SessionResourceUsage,
  SessionSla,
  ComputeResource,
  ResourceSnapshot,
  AdmissionVerdict,
  DeploymentProfile,
  HealthScore,
  HealthIndicator,
  HealthPolicy,
  RecoveryReason,
  RecoveryAttempt,
  RecoveryPolicy,
  RecoveryRecord,
  FailureAnalytics,
  RestoreStep,
  ModelTransition,
  ModelValidationResult,
  ModelLifecycleHistory,
  ModelLifecyclePolicy,
  DiagnosticEntry,
  TimelineEntry,
  SessionOperationalDiagnostics,
} from '../src/inference/inference.js';
import { StreamEnvelope, StreamControl } from '../src/stream/stream.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'generated');

const schemas: Record<string, z.ZodType> = {
  'event-envelope': EventEnvelope,
  'event-catalog-entry': EventCatalogEntry,
  'event-query': EventQuery,
  rule: Rule,
  'create-rule-input': CreateRuleInput,
  'incident-candidate': IncidentCandidate,
  'rule-dry-run-result': RuleDryRunResult,
  incident: Incident,
  'incident-query': IncidentQuery,
  notification: Notification,
  'notification-channel': NotificationChannel,
  'create-channel-input': CreateChannelInput,
  'capability-descriptor': CapabilityDescriptor,
  'capability-registry-record': CapabilityRegistryRecord,
  'tenant-context': TenantContext,
  'api-error': ApiError,
  'config-node': ConfigNode,
  tenant: Tenant,
  'org-node': OrgNode,
  user: User,
  principal: Principal,
  'token-pair': TokenPair,
  camera: Camera,
  'capture-profile': CaptureProfile,
  'camera-health': CameraHealth,
  'stream-status': StreamStatus,
  'recording-segment': RecordingSegment,
  recording: Recording,
  'create-clip-input': CreateClipInput,
  clip: Clip,
  'playback-target': PlaybackTarget,
  'stream-health-summary': StreamHealthSummary,
  detection: Detection,
  'detection-result': DetectionResult,
  'inference-request': InferenceRequest,
  'model-registration': ModelRegistration,
  'register-model-input': RegisterModelInput,
  'model-version': ModelVersion,
  'model-capability-profile': ModelCapabilityProfile,
  'inference-session': InferenceSession,
  'start-inference-session-input': StartInferenceSessionInput,
  'runtime-metrics': RuntimeMetrics,
  'pipeline-definition': PipelineDefinition,
  'stream-source-config': StreamSourceConfig,
  'stream-ingestion-stats': StreamIngestionStats,
  'stream-backpressure-stats': StreamBackpressureStats,
  'runtime-failure-summary': RuntimeFailureSummary,
  'session-identity': SessionIdentity,
  'session-diagnostics': SessionDiagnostics,
  'session-supervisor-stats': SessionSupervisorStats,
  'scheduler-policy': SchedulerPolicy,
  'scheduler-stats': SchedulerStats,
  'scheduler-decision': SchedulerDecision,
  'session-resource-usage': SessionResourceUsage,
  'session-sla': SessionSla,
  'compute-resource': ComputeResource,
  'resource-snapshot': ResourceSnapshot,
  'admission-verdict': AdmissionVerdict,
  'deployment-profile': DeploymentProfile,
  // AI-5d — health, recovery, model lifecycle, operational diagnostics.
  'health-score': HealthScore,
  'health-indicator': HealthIndicator,
  'health-policy': HealthPolicy,
  'recovery-reason': RecoveryReason,
  'recovery-attempt': RecoveryAttempt,
  'recovery-record': RecoveryRecord,
  'failure-analytics': FailureAnalytics,
  'recovery-policy': RecoveryPolicy,
  'restore-step': RestoreStep,
  'model-transition': ModelTransition,
  'model-validation-result': ModelValidationResult,
  'model-lifecycle-history': ModelLifecycleHistory,
  'model-lifecycle-policy': ModelLifecyclePolicy,
  'diagnostic-entry': DiagnosticEntry,
  'timeline-entry': TimelineEntry,
  'session-operational-diagnostics': SessionOperationalDiagnostics,
  evidence: Evidence,
  'evidence-manifest': EvidenceManifest,
  'register-evidence-input': RegisterEvidenceInput,
  'update-evidence-metadata-input': UpdateEvidenceMetadataInput,
  'set-retention-input': SetRetentionInput,
  'evidence-query': EvidenceQuery,
  'evidence-page': EvidencePage,
  'evidence-download-target': EvidenceDownloadTarget,
  'evidence-custody-entry': EvidenceCustodyEntry,
  'evidence-custody-page': EvidenceCustodyPage,
  'stream-envelope': StreamEnvelope,
  'stream-control': StreamControl,
  track: Track,
  zone: Zone,
  'zone-transition': ZoneTransition,
  'counting-snapshot': CountingSnapshot,
  'behavior-result': BehaviorResult,
  'track-snapshot': TrackSnapshot,
  'behavior-config': BehaviorConfig,
  'behavior-analyzer-metrics': BehaviorAnalyzerMetrics,
  'composite-behavior': CompositeBehavior,
  'behavior-profile': BehaviorProfile,
  'benchmark-report': BenchmarkReport,
  'benchmark-workload': BenchmarkWorkload,
  'performance-budget': PerformanceBudget,
  'benchmark-kpis': BenchmarkKpis,
  'environment-fingerprint': EnvironmentFingerprint,
};

mkdirSync(outDir, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  writeFileSync(join(outDir, `${name}.schema.json`), JSON.stringify(json, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(`generated generated/${name}.schema.json`);
}

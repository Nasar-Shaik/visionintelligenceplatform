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
import { CapabilityDescriptor, CapabilityRegistryRecord } from '../src/capability/descriptor.js';
import { TenantContext } from '../src/common/tenant-context.js';
import { ApiError } from '../src/common/api-envelope.js';
import { ConfigNode } from '../src/config/hierarchy.js';
import { Tenant, OrgNode } from '../src/tenant/tenant.js';
import { User, Principal, TokenPair } from '../src/auth/auth.js';
import { Camera, CaptureProfile, CameraHealth } from '../src/camera/camera.js';
import { StreamStatus, RecordingSegment } from '../src/media/media.js';
import { Detection, DetectionResult, InferenceRequest } from '../src/perception/perception.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'generated');

const schemas: Record<string, z.ZodType> = {
  'event-envelope': EventEnvelope,
  'event-catalog-entry': EventCatalogEntry,
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
  detection: Detection,
  'detection-result': DetectionResult,
  'inference-request': InferenceRequest,
};

mkdirSync(outDir, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  writeFileSync(join(outDir, `${name}.schema.json`), JSON.stringify(json, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(`generated generated/${name}.schema.json`);
}

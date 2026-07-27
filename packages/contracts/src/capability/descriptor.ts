/**
 * Capability descriptor & registry record (docs/architecture/05-CAPABILITY-ARCHITECTURE.md §2–§3).
 * A capability is a reusable, model-agnostic, industry-neutral building block. The descriptor is
 * the law: it declares inputs/outputs/params/models(by selector)/resource-profile/placement.
 * Capabilities NEVER hardcode a model, vendor, or downstream consumer (Law 2; ADR-0002/0012).
 */
import { z } from 'zod';
import { CapabilityId, EventType, SemVer } from '../common/primitives.js';

/** Capability family (docs/architecture/05 §1). */
export const CapabilityKind = z.enum(['media', 'perception', 'spatial', 'reasoning', 'platform']);
export type CapabilityKind = z.infer<typeof CapabilityKind>;

/** Where a capability MAY run; the scheduler decides where it DOES (docs/architecture/05 §4). */
export const Placement = z.enum(['edge', 'cloud']);
export type Placement = z.infer<typeof Placement>;

/** Lifecycle state gating exposure (docs/architecture/05 §3). */
export const LifecycleState = z.enum(['experimental', 'stable', 'deprecated']);
export type LifecycleState = z.infer<typeof LifecycleState>;

/** A typed input the capability consumes. */
export const CapabilityInput = z.object({
  type: z.string(), // a contract type id, e.g. "media.frame" or another capability output
  rate: z.union([z.literal('adaptive'), z.number().positive()]).optional(),
});

/** A model selector — model-agnostic binding by task/family/version (ADR-0002). Never a file/vendor. */
export const ModelSelector = z.object({
  task: z.string(),
  family: z.string().default('*'),
  versionRange: z.string().optional(),
  accelerator: z.array(z.enum(['gpu', 'cpu'])).optional(),
});
export type ModelSelector = z.infer<typeof ModelSelector>;

/** Resource profile used by the Execution Scheduler (docs/architecture/05 §4b). */
export const ResourceProfile = z.object({
  accelerator: z.array(z.enum(['gpu', 'cpu'])).default(['cpu']),
  estLoad: z
    .object({
      perStreamMs: z.number().nonnegative().optional(),
      memMb: z.number().nonnegative().optional(),
    })
    .default({}),
});

/** The descriptor authored alongside a capability implementation. */
export const CapabilityDescriptor = z.object({
  id: CapabilityId,
  version: SemVer,
  kind: CapabilityKind,
  inputs: z.array(CapabilityInput).default([]),
  outputs: z.array(z.object({ type: z.string() })).default([]),
  /** Tenant/camera-tunable parameters (generic; NO industry semantics). JSON-Schema-ish shape. */
  parameters: z.record(z.string(), z.unknown()).default({}),
  models: z.object({ selector: ModelSelector }).optional(),
  resourceProfile: ResourceProfile.default({ accelerator: ['cpu'], estLoad: {} }),
  placement: z.array(Placement).default(['cloud']),
  extensionPoints: z.array(z.string()).default([]),
  /** Event types this capability may emit (must exist in the catalog). */
  generatedEvents: z.array(EventType).default([]),
});
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptor>;

/**
 * The runtime registry record (docs/architecture/05 §3) — descriptor + governance/ops metadata
 * captured when a capability self-registers.
 */
export const CapabilityRegistryRecord = CapabilityDescriptor.extend({
  owner: z.string(),
  description: z.string(),
  dependencies: z.array(CapabilityId).default([]),
  requiredGpu: z.boolean().default(false),
  license: z.string().default('proprietary'),
  lifecycleState: LifecycleState.default('experimental'),
});
export type CapabilityRegistryRecord = z.infer<typeof CapabilityRegistryRecord>;

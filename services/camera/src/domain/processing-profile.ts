/**
 * Domain: **Processing Profiles** (P-8 Phase 6 §2) — the reusable, named capability sets a camera is
 * bound to. Pure and deterministic.
 *
 * ### ⚠️ Bind cameras to profiles, never to analytics (Architect rec 1)
 *
 * "Cash Counter → Retail Monitoring" survives the retail analytics being rewritten; "Cash Counter →
 * loitering-detector-v3" does not. A profile therefore names **capability ids** — the frozen
 * `<family>.<name>` identifiers the AI runtime publishes — and carries no thresholds, no zones and
 * no conditions. Everything conditional belongs to the Rule Engine, which this milestone does not
 * touch.
 *
 * ### ⚠️ The seeded catalogue is mostly UNSUPPORTED on today's deployment, deliberately
 *
 * The runtime advertises exactly one capability (`perception.person-detection`). Four of the six
 * seeded profiles name capabilities nothing can run, and `supported` says so on every read. The
 * alternative — seeding only what happens to work — would hide the shape of the product from the
 * operator and quietly re-introduce the assumption that there is one runtime with one model.
 */
import type {
  BUILT_IN_PROFILE_IDS,
  CreateProcessingProfileInput,
  ProcessingProfile,
} from '@vip/contracts';
import type { TenantScoped } from '@vip/tenancy';

/** MongoDB-persisted profile. `_id` is `{tenantId}:{profileId}`. */
export interface ProfileDoc extends TenantScoped {
  _id: string;
  tenantId: string;
  profileId: string;
  name: string;
  description?: string;
  capabilities: string[];
  targetFps: number | null;
  builtIn: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
}

export function profileDocId(tenantId: string, profileId: string): string {
  return `${tenantId}:${profileId}`;
}

/**
 * The catalogue every tenant is seeded with.
 *
 * ⚠️ `disabled` is a real profile rather than the absence of one: "deliberately not analysed" and
 * "nobody has configured this yet" are different operational facts, and a site survey that cannot
 * tell them apart re-asks the same question at every review. It names the person-detection
 * capability so that binding a camera to it is a well-formed, refusable operation — the camera still
 * never processes, because `disabled` is not something the assignment ever starts.
 */
export const BUILT_IN_PROFILES: readonly {
  id: (typeof BUILT_IN_PROFILE_IDS)[number];
  name: string;
  description: string;
  capabilities: string[];
  targetFps: number | null;
}[] = [
  {
    id: 'disabled',
    name: 'Disabled',
    description: 'Recording only. The camera is deliberately excluded from AI processing.',
    capabilities: ['perception.person-detection'],
    targetFps: null,
  },
  {
    id: 'person-tracking',
    name: 'Person Tracking',
    description: 'Detect and track people. The baseline profile every deployment can run.',
    capabilities: ['perception.person-detection'],
    targetFps: null,
  },
  {
    id: 'retail-monitoring',
    name: 'Retail Monitoring',
    description: 'Person tracking tuned for shop floors, tills and high-value displays.',
    capabilities: ['perception.person-detection'],
    targetFps: null,
  },
  {
    id: 'queue-analytics',
    name: 'Queue Analytics',
    description: 'Queue length and waiting time at service points.',
    capabilities: ['perception.queue-analytics'],
    targetFps: null,
  },
  {
    id: 'vehicle-analytics',
    name: 'Vehicle Analytics',
    description: 'Vehicle detection for car parks, loading bays and barriers.',
    capabilities: ['perception.vehicle-detection'],
    targetFps: null,
  },
  {
    id: 'safety-monitoring',
    name: 'Safety Monitoring',
    description: 'PPE, restricted areas and hazard proximity for industrial sites.',
    capabilities: ['perception.safety-monitoring'],
    targetFps: null,
  },
];

export function seedProfile(
  tenantId: string,
  seed: (typeof BUILT_IN_PROFILES)[number],
  at: Date,
): ProfileDoc {
  const ts = at.toISOString();
  return {
    _id: profileDocId(tenantId, seed.id),
    tenantId,
    profileId: seed.id,
    name: seed.name,
    description: seed.description,
    capabilities: [...seed.capabilities],
    targetFps: seed.targetFps,
    builtIn: true,
    version: 1,
    createdAt: ts,
    updatedAt: ts,
    updatedBy: 'system',
  };
}

export function newProfile(
  tenantId: string,
  input: CreateProcessingProfileInput,
  actor: string,
  at: Date,
): ProfileDoc {
  const ts = at.toISOString();
  return {
    _id: profileDocId(tenantId, input.id),
    tenantId,
    profileId: input.id,
    ...(input.description === undefined ? {} : { description: input.description }),
    name: input.name,
    capabilities: [...input.capabilities],
    targetFps: input.targetFps ?? null,
    builtIn: false,
    version: 1,
    createdAt: ts,
    updatedAt: ts,
    updatedBy: actor,
  };
}

/**
 * The capability a bound camera actually runs.
 *
 * ⚠️ The **first** entry. The runtime's `/infer` takes one capability per frame, so a profile with
 * several declares an intention the pipeline cannot yet honour. Naming which one is used — rather
 * than silently taking `[0]` at the call site — is what keeps the future multi-capability change to
 * one function.
 */
export function primaryCapability(profile: Pick<ProfileDoc, 'capabilities'>): string {
  return profile.capabilities[0] as string;
}

/**
 * Whether any runtime advertises this profile's primary capability.
 *
 * ⚠️ Returns `null`, not `false`, when **no runtime has been observed** — the ADR-0039 rule. A fresh
 * deployment whose first observation has not landed must not tell an operator that every profile is
 * unsupported; it must say it does not know yet.
 */
export function profileSupported(
  profile: Pick<ProfileDoc, 'capabilities'>,
  advertised: readonly (readonly string[] | null)[],
): boolean | null {
  const known = advertised.filter((c): c is readonly string[] => c !== null);
  if (known.length === 0) return null;
  const required = primaryCapability(profile);
  return known.some((caps) => caps.includes(required));
}

export function toProfile(
  doc: ProfileDoc,
  advertised: readonly (readonly string[] | null)[],
): ProcessingProfile {
  return {
    id: doc.profileId,
    tenantId: doc.tenantId,
    name: doc.name,
    ...(doc.description === undefined ? {} : { description: doc.description }),
    capabilities: [...doc.capabilities],
    targetFps: doc.targetFps,
    builtIn: doc.builtIn,
    supported: profileSupported(doc, advertised),
    version: doc.version,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...(doc.updatedBy === undefined ? {} : { updatedBy: doc.updatedBy }),
  };
}

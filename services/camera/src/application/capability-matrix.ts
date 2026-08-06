/**
 * Application: the **camera capability matrix** (P-8 Phase 6, Architect rec 1) — the one read-only
 * answer to "what can this camera do right now".
 *
 * ### ⚠️ "Future features should never infer capability from configuration"
 *
 * That requirement is only achievable if the answer says **on what authority** it knows each fact.
 * A bare boolean cannot: `false` from a measurement and `false` from an unread field look identical
 * at the call site, and the consumer that needs the first will silently accept the second. So every
 * entry is a `CapabilityFact` carrying `available`, `evidence` and `at`, and an unmeasured
 * capability is `{ available: null, evidence: 'unknown' }` — never `false`.
 *
 * ### ⚠️ Composed on read, never stored
 *
 * Each fact is owned by whatever can prove it: recording by the stream supervisor, AI and tracking by
 * the enforcement point, events by the publisher, rules by the rule catalogue, snapshots by the
 * camera record. Persisting a copy here would create a second version of each, and the copy is the
 * one that goes stale. `FOUNDATIONS.md` rule 1 — *persist measurements, derive conclusions*.
 *
 * ### ⚠️ The measured facts arrive by REPORT, not by a call to media
 *
 * The control plane does not fetch anything from media. Media already reports every few seconds, so
 * its facts ride that channel and are stored as observations with a timestamp. Fetching them would
 * have made the two services call each other, and would have made this endpoint's latency depend on
 * a service that is deliberately allowed to be slow.
 */
import type { CameraCapabilityMatrix, CapabilityFact, RuntimeHealth } from '@vip/contracts';
import { assignmentAiEnabled, UNKNOWN_CAPABILITY } from '@vip/contracts';
import type { CameraDoc } from '../domain/camera.js';
import type { AssignmentDoc } from '../domain/assignment.js';
import { OBSERVATION_TTL_MS } from '../domain/assignment.js';

/** What an enforcement point last measured for one camera. Stored; never derived here. */
export interface ProcessingFactsDoc {
  _id: string;
  tenantId: string;
  cameraId: string;
  at: string;
  reportedBy: string;
  /** `undefined` where the observer did not measure it — never coerced to `false`. */
  recording?: boolean;
  recordingHealth?: 'healthy' | 'degraded' | 'down';
  tracking?: boolean;
  eventsPublished?: number;
}

/**
 * Whether the tenant has any rule that could act on this camera's events.
 *
 * ⚠️ A port with an `Unavailable` default rather than a hard dependency. A deployment that has not
 * configured a rules URL gets `unknown` — which is the truth — instead of `false`, which would tell
 * an operator their rules are missing when nobody has looked.
 */
export interface RuleAvailability {
  /** `null` when it could not be determined. `authorization` is the caller's own header, forwarded. */
  enabledRuleCount(tenantId: string, authorization: string | undefined): Promise<number | null>;
}

export const UnavailableRules: RuleAvailability = {
  async enabledRuleCount() {
    return null;
  },
};

/**
 * Reads the tenant's enabled rule count by forwarding the **caller's own** access token.
 *
 * ⚠️ The caller's token, not a service credential. Forwarding preserves their authority exactly: a
 * principal without `rule:read` gets a 403 from the rules service, which becomes `unknown` here
 * rather than a number they were not entitled to see. Using an internal key would have quietly
 * widened every reader's access in order to populate one field.
 */
export class HttpRuleAvailability implements RuleAvailability {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 2_000,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  async enabledRuleCount(
    _tenantId: string,
    authorization: string | undefined,
  ): Promise<number | null> {
    if (authorization === undefined) return null;
    try {
      const res = await this.doFetch(`${this.baseUrl.replace(/\/+$/, '')}/rules`, {
        headers: { authorization },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: unknown };
      const rows = Array.isArray(body.data)
        ? body.data
        : Array.isArray((body.data as { items?: unknown })?.items)
          ? (body.data as { items: unknown[] }).items
          : null;
      if (rows === null) return null;
      return rows.filter((r) => (r as { lifecycle?: unknown }).lifecycle === 'enabled').length;
    } catch {
      return null;
    }
  }
}

const measured = (available: boolean, at: string, detail?: string): CapabilityFact => ({
  available,
  evidence: available ? 'measured' : 'unavailable',
  at,
  ...(detail === undefined ? {} : { detail }),
});

const declared = (available: boolean, detail?: string): CapabilityFact => ({
  available,
  evidence: 'declared',
  at: null,
  ...(detail === undefined ? {} : { detail }),
});

/**
 * Compose the matrix.
 *
 * ⚠️ A measurement older than the observation TTL is **not used**. It falls back to `unknown` with a
 * detail saying so, because a confident four-minute-old "recording: yes" is worse than an honest "we
 * have not heard from the enforcement point".
 */
export function buildCapabilityMatrix(input: {
  camera: CameraDoc;
  assignment: AssignmentDoc;
  facts: ProcessingFactsDoc | null;
  runtimeHealth: RuntimeHealth | null;
  enabledRules: number | null;
  now: Date;
}): CameraCapabilityMatrix {
  const { camera, assignment, runtimeHealth, enabledRules, now } = input;
  const fresh =
    input.facts !== null && now.getTime() - Date.parse(input.facts.at) <= OBSERVATION_TTL_MS
      ? input.facts
      : null;
  const staleDetail =
    input.facts === null
      ? 'no enforcement point has reported on this camera'
      : 'the last report from the enforcement point has expired';

  const fromFacts = (read: (f: ProcessingFactsDoc) => boolean | undefined): CapabilityFact => {
    if (fresh === null) return { ...UNKNOWN_CAPABILITY, detail: staleDetail };
    const value = read(fresh);
    if (value === undefined)
      return { ...UNKNOWN_CAPABILITY, detail: 'not measured by this observer' };
    return measured(value, fresh.at);
  };

  /*
   * ⚠️ AI processing is the one fact with TWO sources, and they are not interchangeable. The
   * assignment says what an operator authorised; the observation says what is happening. Reporting
   * the authorisation as the capability is precisely the inference-from-configuration this matrix
   * exists to replace — so an authorised camera nothing has confirmed reads `declared`, not
   * `measured`, and a consumer that needs proof can tell.
   */
  let aiProcessing: CapabilityFact;
  if (!assignmentAiEnabled(assignment.state)) {
    aiProcessing = declared(false, 'no AI assignment');
  } else if (assignment.observedState === 'active' && assignment.observedAt !== null) {
    aiProcessing = measured(true, assignment.observedAt);
  } else if (assignment.observedState === 'failed' && assignment.observedAt !== null) {
    aiProcessing = measured(
      false,
      assignment.observedAt,
      assignment.lastError ?? 'processing failed',
    );
  } else {
    aiProcessing = declared(true, `assigned (${assignment.state}); not yet confirmed processing`);
  }

  return {
    tenantId: camera.tenantId,
    cameraId: camera._id,
    generatedAt: now.toISOString(),
    recording: fromFacts((f) => f.recording),
    aiProcessing,
    tracking: fromFacts((f) => f.tracking),
    events: fromFacts((f) => (f.eventsPublished === undefined ? undefined : f.eventsPublished > 0)),
    /*
     * ⚠️ `declared`, and honestly so. A rule existing is a configuration fact — nothing has proven
     * one would fire for this camera. `unknown` when no rules source is configured or the caller may
     * not read rules.
     */
    rules:
      enabledRules === null
        ? { ...UNKNOWN_CAPABILITY, detail: 'the rule catalogue could not be read' }
        : declared(enabledRules > 0, `${enabledRules} enabled rule(s) in this tenant`),
    /* Declared by the device record — nothing has pulled a still to check. */
    snapshots: declared(
      camera.capabilities?.snapshot ?? false,
      'declared by the camera record; not verified against the device',
    ),
    recordingHealth:
      fresh === null || fresh.recordingHealth === undefined
        ? { ...UNKNOWN_CAPABILITY, detail: staleDetail }
        : measured(fresh.recordingHealth === 'healthy', fresh.at, fresh.recordingHealth),
    aiHealth:
      runtimeHealth === null
        ? { ...UNKNOWN_CAPABILITY, detail: 'this camera is not placed on a runtime' }
        : runtimeHealth === 'unknown'
          ? { ...UNKNOWN_CAPABILITY, detail: 'the assigned runtime has not been observed' }
          : measured(
              runtimeHealth === 'healthy' || runtimeHealth === 'recovering',
              assignment.observedAt ?? now.toISOString(),
              runtimeHealth,
            ),
    assignment: {
      state: assignment.state,
      profileId: assignment.profileId,
      runtimeId: assignment.runtimeId,
    },
  };
}

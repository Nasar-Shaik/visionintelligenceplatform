import type {
  CreateDetectionZoneInput,
  DetectionZone,
  DetectionZoneVersionRecord,
  IncidentCandidate,
  LiveRuleStatus,
  RuleTemplate,
  UpdateDetectionZoneInput,
} from '@vip/contracts';
import { http } from './http';

/**
 * Detection zones — the reusable spatial assets rules point at (P-8 Phase 7), through the gateway.
 *
 * ⚠️ **Not location-hierarchy zones.** Those are places, owned by the Tenant context and reached
 * through `organizationApi`. These are polygons on one camera's image plane, owned by the Camera
 * context. Two id spaces with one word — see ADR-0044. The console never mixes them: the zone editor
 * only ever shows zones for a chosen camera, and the rule editor labels the field "detection zones".
 */
export const zonesApi = {
  /** Every zone in the tenant, or one camera's. */
  list: (cameraId?: string) =>
    http.get<DetectionZone[]>(
      `/camera/zones${cameraId ? `?cameraId=${encodeURIComponent(cameraId)}` : ''}`,
    ),

  get: (zoneId: string) => http.get<DetectionZone>(`/camera/zones/${zoneId}`),

  create: (body: CreateDetectionZoneInput) => http.post<DetectionZone>('/camera/zones', body),

  update: (zoneId: string, body: UpdateDetectionZoneInput) =>
    http.patch<DetectionZone>(`/camera/zones/${zoneId}`, body),

  remove: (zoneId: string) => http.del<void>(`/camera/zones/${zoneId}`),

  /**
   * A zone's whole history, newest first.
   *
   * ⚠️ Available for a **deleted** zone too — the history outlives the zone, because an incident
   * that names it must still resolve to the geometry that produced it.
   */
  versions: (zoneId: string) =>
    http.get<DetectionZoneVersionRecord[]>(`/camera/zones/${zoneId}/versions`),

  /**
   * The geometry **as it was**.
   *
   * ⚠️ This is what an incident detail page must draw over old footage. Drawing today's polygon over
   * March's video is wrong in a way that looks exactly like being right.
   */
  versionAt: (zoneId: string, version: number) =>
    http.get<DetectionZoneVersionRecord>(`/camera/zones/${zoneId}/versions/${version}`),
};

/**
 * Live rule status — what the engine is doing right now (P-8 Phase 7).
 *
 * ⚠️ **Per node, and the payload says which one.** A deployment running several rule processes gets
 * whichever answered; summing across them would produce a number that is wrong in a way nobody could
 * detect. The page renders `node` beside every figure for that reason.
 *
 * ⚠️ A `503` here means *this node does not evaluate*, which is a real deployment shape and NOT an
 * error to retry into oblivion. The page says so instead of showing zeroes, because "0 active rules"
 * and "this node has no engine" look identical and only one of them needs somebody's attention.
 */
export const ruleLiveApi = {
  status: () => http.get<LiveRuleStatus>('/rules/rules/live'),
  dryRuns: () =>
    http.get<
      {
        ruleId: string;
        ruleName: string;
        withheld: number;
        retained: number;
        firstAt?: string;
        lastAt?: string;
        maxDurationSeconds?: number;
      }[]
    >('/rules/rules/live/dry-runs'),
  /** The candidates a dry-run rule built and deliberately did not publish. */
  dryRunCandidates: (ruleId: string) =>
    http.get<IncidentCandidate[]>(`/rules/rules/${ruleId}/dry-run-candidates`),
  templates: () => http.get<RuleTemplate[]>('/rules/rules/templates'),
};

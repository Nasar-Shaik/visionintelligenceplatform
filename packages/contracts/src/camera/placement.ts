/**
 * Camera placement and the camera map (P-5.4, Architect rec 5) — Building → Floor → Zone → Camera,
 * with status, orientation and placement.
 *
 * ⚠️ **Additive to the frozen Camera Foundation and the frozen Location Hierarchy. Neither is
 * touched.** A placement is a new record that *references* a camera and a floor; nothing here adds
 * a field to a camera or invents a level.
 *
 * ### ⚠️ A placement is not a location, and must never become one
 *
 * The hierarchy already answers "which zone is this camera in" — it is the `zone` level of
 * `CONFIG_LEVELS`, it drives config inheritance, and it is what rules and incidents resolve
 * against. A placement answers a different and much weaker question: *where on a drawing should the
 * pin go.*
 *
 * So a placement carries **no `zoneId`**. It carries a camera and a floor, and the zone is read
 * from the camera. If it carried its own zone there would be two answers to a question that decides
 * which rules apply, and the drawing — the one nobody re-checks after a camera is re-homed — would
 * eventually be the one someone believed.
 *
 * ### ⚠️ Orientation is declared, never measured
 *
 * A bearing and a field-of-view angle drawn as a cone on a floor plan looks exactly like a coverage
 * map, and it is not one: it is what somebody typed in. The real view is cut by pillars, doors,
 * shelving and a lens nobody re-checked after the camera was knocked. `CoverageBasis` is on the
 * record so the map can say which it is, and so nothing downstream can quietly treat a declaration
 * as a survey — "this area was covered" is the kind of claim that ends up in a report.
 *
 * ⚠️ **Frozen with no producer.** Nothing stores a placement or renders a map.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId } from '../common/primitives.js';

/** A point on a floor plan, normalised `[0,1]` so it survives the plan being re-exported. */
export const PlanPoint = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type PlanPoint = z.infer<typeof PlanPoint>;

/**
 * How much the platform knows about what a camera actually sees.
 *
 * ⚠️ The distinction the whole record exists for. Only `surveyed` supports a statement about
 * coverage; the others support a statement about *intent*.
 */
export const CoverageBasis = z.enum([
  /** Somebody typed a bearing into a form. The usual case. */
  'declared',
  /** Derived from the camera's reported lens and mount data. Better, still not the room. */
  'calculated',
  /** Walked and confirmed on site, with a date. The only basis that supports "this was covered". */
  'surveyed',
  /** ⚠️ Nothing is known. Never drawn as a cone. */
  'unknown',
]);
export type CoverageBasis = z.infer<typeof CoverageBasis>;

/**
 * Which way a camera points.
 *
 * ⚠️ Every field is optional and **absent means unknown, never a default**. A `bearingDegrees` of 0
 * is due north, not "unspecified"; defaulting it would draw every unconfigured camera pointing the
 * same way and make the map look surveyed when it is empty.
 */
export const CameraOrientation = z.object({
  /** Compass bearing, 0–360, 0 = north. */
  bearingDegrees: z.number().min(0).max(360).optional(),
  /** Horizontal field of view. */
  fieldOfViewDegrees: z.number().positive().max(360).optional(),
  /** Useful range in metres. ⚠️ Nominal: it is not a guarantee anything at that distance is legible. */
  rangeMetres: z.number().positive().max(1000).optional(),
  /** Downward tilt, for a camera drawn on a plan. */
  tiltDegrees: z.number().min(-90).max(90).optional(),
  basis: CoverageBasis.default('unknown'),
  /** ⚠️ Required when the basis is `surveyed` — a survey with no date is a claim with no shelf life. */
  surveyedAt: IsoDateTime.optional(),
});
export type CameraOrientation = z.infer<typeof CameraOrientation>;

/**
 * Where a camera sits on a floor plan.
 *
 * ⚠️ No `zoneId`. See the module note.
 */
export const CameraPlacement = z
  .object({
    tenantId: TenantId,
    cameraId: z.string().min(1),
    /** The `floor` node from the frozen hierarchy. The plan this pin is on. */
    floorId: z.string().min(1),
    position: PlanPoint,
    orientation: CameraOrientation.default({ basis: 'unknown' }),
    /** A short label for the pin. Absent ⇒ the camera's own name is used. */
    label: z.string().min(1).max(120).optional(),
    updatedBy: z.string().min(1),
    updatedAt: IsoDateTime,
  })
  .superRefine((placement, ctx) => {
    const { basis, surveyedAt, bearingDegrees, fieldOfViewDegrees } = placement.orientation;
    if (basis === 'surveyed' && surveyedAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['orientation', 'surveyedAt'],
        message: 'a surveyed orientation must record when the survey was made',
      });
    }
    /*
     * ⚠️ A cone needs both a direction and a width. One without the other renders as either a
     * wedge pointing nowhere or a full circle, and both read as coverage the camera does not have.
     */
    const hasOne = bearingDegrees !== undefined || fieldOfViewDegrees !== undefined;
    const hasBoth = bearingDegrees !== undefined && fieldOfViewDegrees !== undefined;
    if (hasOne && !hasBoth) {
      ctx.addIssue({
        code: 'custom',
        path: ['orientation'],
        message:
          'bearing and field of view are drawn together: supply both, or neither and no cone is drawn',
      });
    }
  });
export type CameraPlacement = z.infer<typeof CameraPlacement>;

/** A floor plan a tenant uploaded. ⚠️ A storage key, never a URL — the same rule as branding. */
export const FloorPlan = z.object({
  tenantId: TenantId,
  floorId: z.string().min(1),
  buildingId: z.string().min(1),
  storageKey: z.string().min(1).max(500),
  contentType: z.string().min(1).max(120),
  /** Real-world width of the plan in metres, when known. Absent ⇒ no scale, so no distances drawn. */
  widthMetres: z.number().positive().optional(),
  uploadedAt: IsoDateTime,
});
export type FloorPlan = z.infer<typeof FloorPlan>;

/**
 * A camera as it appears on the map: the pin, plus the health the map colours it by.
 *
 * ⚠️ **`health` is copied from the Camera Foundation's `CameraHealthStatus`, not redefined.** Its
 * `unknown` member matters most here: a camera nobody has heard from is not offline and not online,
 * and a map that colours it green because it has no bad news is the map that gets someone hurt.
 */
export const CameraMapPin = z.object({
  cameraId: z.string().min(1),
  name: z.string().min(1).max(200),
  position: PlanPoint,
  orientation: CameraOrientation,
  /** From `CameraHealth.status`. `unknown` is rendered distinctly from both online and offline. */
  health: z.enum(['unknown', 'online', 'offline', 'unhealthy']),
  /** From `CameraStatus`. A disabled camera is drawn, and drawn as disabled. */
  enabled: z.boolean(),
  /** Derived from the camera's own record. ⚠️ Read-only here — the placement never sets it. */
  zoneId: z.string().min(1).optional(),
});
export type CameraMapPin = z.infer<typeof CameraMapPin>;

/**
 * One floor's map.
 *
 * ⚠️ `plan` is optional and its absence is a first-class state: a tenant that has not uploaded a
 * floor plan still has cameras, and the map falls back to a list rather than an empty rectangle.
 */
export const CameraMap = z.object({
  tenantId: TenantId,
  buildingId: z.string().min(1),
  floorId: z.string().min(1),
  plan: FloorPlan.optional(),
  /** Bounded: a floor with more pins than this is a data problem, not a rendering problem. */
  pins: z.array(CameraMapPin).max(500).default([]),
  /** ⚠️ Cameras on this floor with no placement — listed, never silently dropped from the map. */
  unplacedCameraIds: z.array(z.string().min(1)).max(500).default([]),
  derivedAt: IsoDateTime,
});
export type CameraMap = z.infer<typeof CameraMap>;

/**
 * Whether a pin's cone may be drawn as coverage.
 *
 * ⚠️ Only a dated survey qualifies. Exported so the rule lives in one place and a test can pin it:
 * the difference between "we pointed a camera that way" and "we checked what it sees" is the
 * difference between a plan and a claim.
 */
export function coverageIsSurveyed(orientation: CameraOrientation): boolean {
  return orientation.basis === 'surveyed' && orientation.surveyedAt !== undefined;
}

import { cn } from '@/lib/cn';

/**
 * A single COCO-17 joint as the runtime reports it — normalized to the **frame**, not to the
 * person's box, so it composes with the same absolute layer the bounding boxes use.
 */
export interface PoseKeypoint {
  name: string;
  x: number;
  y: number;
  confidence: number;
  /**
   * ⛔ **"The model localized this joint above threshold." Nothing more.**
   *
   * It is not a claim that the joint is physically unoccluded, and the overlay must never present
   * it as one. RTMPose is top-down: told a person is in the crop, it answers for all 17 joints
   * whatever is actually there. On an empty room it returned every joint at 0.21–0.57 during P3.3a.
   */
  visible: boolean;
}

export interface PoseSkeleton {
  id: string;
  keypoints: PoseKeypoint[];
}

export interface PoseOverlayProps {
  skeletons: PoseSkeleton[];
  className?: string;
}

/**
 * The 19 COCO-17 limb connections, by joint name.
 *
 * ⚠️ **By name, not by index.** An index pair silently draws a different limb the moment a model
 * with another joint order is catalogued; a name pair simply finds nothing and draws nothing.
 */
export const POSE_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['left_ankle', 'left_knee'],
  ['left_knee', 'left_hip'],
  ['right_ankle', 'right_knee'],
  ['right_knee', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'],
  ['right_shoulder', 'right_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_elbow', 'right_wrist'],
  ['left_eye', 'right_eye'],
  ['nose', 'left_eye'],
  ['nose', 'right_eye'],
  ['left_eye', 'left_ear'],
  ['right_eye', 'right_ear'],
  ['left_ear', 'left_shoulder'],
  ['right_ear', 'right_shoulder'],
];

/**
 * The 17-keypoint skeleton layer, drawn over the same un-mirrored frame the boxes use.
 *
 * ### ⛔ Only what the model localized
 *
 * A joint below the visibility threshold is **not drawn**, and a limb is drawn only when *both* of
 * its endpoints are visible. The alternative — drawing a faint line to a low-confidence guess — puts
 * a plausible human shape on screen that the model never asserted, and a reviewer cannot tell the
 * two apart. Missing limbs are the honest rendering of an uncertain pose.
 */
export function PoseOverlay({ skeletons, className }: PoseOverlayProps) {
  return (
    <svg
      className={cn('pointer-events-none absolute inset-0 h-full w-full', className)}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
      data-testid="pose-overlay"
    >
      {skeletons.map((skeleton) => {
        const byName = new Map(skeleton.keypoints.map((k) => [k.name, k]));
        return (
          <g key={skeleton.id} data-testid={`pose-${skeleton.id}`}>
            {POSE_EDGES.map(([from, to]) => {
              const a = byName.get(from);
              const b = byName.get(to);
              if (a === undefined || b === undefined || !a.visible || !b.visible) return null;
              return (
                <line
                  key={`${from}-${to}`}
                  x1={a.x * 100}
                  y1={a.y * 100}
                  x2={b.x * 100}
                  y2={b.y * 100}
                  stroke="currentColor"
                  strokeWidth={0.4}
                  strokeLinecap="round"
                  className="text-brand"
                  data-testid={`limb-${from}-${to}`}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            {skeleton.keypoints
              .filter((k) => k.visible)
              .map((k) => (
                <circle
                  key={k.name}
                  cx={k.x * 100}
                  cy={k.y * 100}
                  r={0.6}
                  className="fill-brand"
                  data-testid={`joint-${k.name}`}
                />
              ))}
          </g>
        );
      })}
    </svg>
  );
}

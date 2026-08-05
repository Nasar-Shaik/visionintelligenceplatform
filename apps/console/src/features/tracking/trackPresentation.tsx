import { Badge } from '@/ui';
import type { TrackMotion, TrackState, TrackingOverview } from './useTracking';

/**
 * Shared presentation for the tracking pages (P-8 Phase 4).
 *
 * ⚠️ **One place decides how a measurement is worded**, because the alternative is four pages that
 * each round differently and disagree in front of a customer.
 */

/** Lifecycle states, worded for someone who has not read the contract. */
export const STATE_LABEL: Record<TrackState, string> = {
  created: 'New',
  tentative: 'Tentative',
  confirmed: 'Confirmed',
  lost: 'Lost',
  removed: 'Ended',
};

export const STATE_DESCRIPTION: Record<TrackState, string> = {
  created: 'Just seen for the first time.',
  tentative: 'Seen more than once but not yet trusted.',
  confirmed: 'A trusted, continuous identity.',
  lost: 'Not visible right now — the engine is holding the identity open.',
  removed: 'Gone long enough that the identity was closed.',
};

const STATE_VARIANT: Record<TrackState, 'neutral' | 'outline' | 'warning' | 'success'> = {
  created: 'outline',
  tentative: 'outline',
  confirmed: 'success',
  lost: 'warning',
  removed: 'neutral',
};

export function TrackStateBadge({ state }: { state: TrackState }) {
  return (
    <Badge variant={STATE_VARIANT[state]} title={STATE_DESCRIPTION[state]}>
      {STATE_LABEL[state]}
    </Badge>
  );
}

/**
 * ⚠️ **"Not measured", never "0".**
 *
 * The single rule this whole feature is written around. A runtime that has tracked nothing and a
 * runtime whose tracks averaged zero seconds look identical the moment either is rendered as a
 * number, and only one of those is a working deployment.
 */
export function measured(
  value: number | null | undefined,
  format: (n: number) => string,
): { text: string; measured: boolean } {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return { text: 'Not measured', measured: false };
  }
  return { text: format(value), measured: true };
}

export const asSeconds = (n: number): string =>
  n >= 60 ? `${Math.floor(n / 60)}m ${Math.round(n % 60)}s` : `${n.toFixed(1)}s`;
export const asMs = (n: number): string => `${n.toFixed(2)} ms`;
export const asRatio = (n: number): string => n.toFixed(2);
export const asPercent = (n: number): string => `${(n * 100).toFixed(0)}%`;

/**
 * Speed, worded so it cannot be misread as a physical quantity.
 *
 * ⚠️ **"frame widths/s", not "m/s"**, and the unit is spelled out on every single reading rather
 * than once in a footnote. A number labelled only "speed" on a CCTV product will be read as metres
 * per second by the next person who looks at it, and converting genuinely needs camera calibration
 * — intrinsics, mounting height, tilt, a ground plane — that this platform neither has nor asks for.
 * Two people walking at identical real speeds, one near the lens and one far from it, produce very
 * different numbers here.
 */
export const asSpeed = (n: number): string => `${n.toFixed(3)} fw/s`;

/** The travelled path, in the same normalized units, spelled out for the same reason. */
export const asDistance = (n: number): string => `${n.toFixed(3)} fw`;

/** An eight-point image-space heading, with the arrow an operator actually reads. */
export const HEADING_ARROW: Record<string, string> = {
  right: '→',
  'down-right': '↘',
  down: '↓',
  'down-left': '↙',
  left: '←',
  'up-left': '↖',
  up: '↑',
  'up-right': '↗',
};

export function headingText(motion: TrackMotion | undefined): string {
  if (motion?.headingLabel === undefined) return 'Not measured';
  const arrow = HEADING_ARROW[motion.headingLabel] ?? '';
  return `${arrow} ${motion.headingLabel.replace('-', ' ')}`;
}

/**
 * Why the page has nothing to show, said precisely.
 *
 * ⚠️ Four different reasons produce an empty table, and an operator needs to know which one. "No
 * tracks" during an incident is a very different sentence from "the runtime is not answering", and a
 * page that renders both as an empty state is actively misleading at the worst possible moment.
 */
export function unavailableReason(
  overview: TrackingOverview | undefined,
): { title: string; description: string } | null {
  if (overview === undefined) return null;
  if (overview.unreachable === true) {
    return {
      title: 'The runtime is not answering',
      description:
        overview.detail ??
        'Tracking cannot be read right now. Recording and evidence are unaffected: frames may go unanalysed, segments are never dropped.',
    };
  }
  if (overview.enabled === false) {
    return {
      title: 'Tracking is not enabled here',
      description:
        overview.detail ??
        'This deployment has no object tracking, so no identities are being followed between frames.',
    };
  }
  return null;
}

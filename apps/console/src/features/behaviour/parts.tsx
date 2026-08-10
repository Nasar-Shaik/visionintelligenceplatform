import { Crosshair, Play } from 'lucide-react';
import { Button } from '@/ui';
import { formatOffset } from '../investigations/format';
import { placeInRecording, type RecordingClock } from './footage';

/**
 * Shared pieces of the behaviour surface (Phase 2.4 slice 2.8).
 *
 * ⛔ **`SeekControl` is the one place a behaviour fact becomes a click**, and it is the reason this
 * file exists rather than the button being inlined five times. Every surface — timeline, graph,
 * identity history, primitive inspector, reasoning chain — must place a fact in the video the same
 * way, or two panels will disagree about where the same moment is and the operator will believe
 * whichever they looked at second.
 */

export interface SeekControlProps {
  /** ⚠️ The **absolute** footage second. Never `atSeconds` — see `footage.ts` on the three clocks. */
  footageSeconds: number | undefined;
  clock: RecordingClock;
  onSeek: (offsetSeconds: number) => void;
  label?: string;
  size?: 'sm' | 'xs';
}

/**
 * "Play from here", or a stated refusal.
 *
 * ⛔ **A fact that cannot be placed in this recording disables the button and says so.** The
 * tempting alternative — seek to `atSeconds`, or to 0, or to the nearest thing — puts an operator on
 * a frame where the thing being explained is not happening, presented with the same confidence as a
 * correct seek. That is worse than no button: they draw a conclusion from the wrong evidence and
 * nothing on the screen contradicts them.
 */
export function SeekControl({ footageSeconds, clock, onSeek, label, size = 'sm' }: SeekControlProps) {
  const placed = placeInRecording(footageSeconds, clock);
  const placeable = placed.offsetSeconds !== null;

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={!placeable}
      className={size === 'xs' ? 'h-6 px-1.5 text-2xs' : undefined}
      data-testid="behaviour-seek"
      data-basis={placed.basis}
      data-offset={placed.offsetSeconds ?? ''}
      title={
        placeable
          ? `Play from ${formatOffset(placed.offsetSeconds!)}${
              placed.basis === 'relative' ? ' (the runtime reported this against the recording)' : ''
            }`
          : 'This fact carries a footage instant that does not fall inside this recording, so there is no frame to seek to.'
      }
      onClick={() => {
        if (placed.offsetSeconds !== null) onSeek(placed.offsetSeconds);
      }}
    >
      <Play className="h-3 w-3" aria-hidden />
      <span className="ml-1">{label ?? (placeable ? formatOffset(placed.offsetSeconds!) : 'unplaceable')}</span>
    </Button>
  );
}

/**
 * The frame and track a fact came from.
 *
 * ⛔ **Rendered even when empty, as "no frame recorded".** A fact with no evidence is an assertion,
 * and an assertion that renders as blank space is indistinguishable from one whose evidence merely
 * did not fit on the row.
 */
export function EvidenceTag({
  evidence,
}: {
  evidence: { frameIndex?: number | undefined; trackId?: string | undefined } | undefined;
}) {
  const frame = evidence?.frameIndex;
  const track = evidence?.trackId;
  if (frame === undefined && track === undefined) {
    return (
      <span className="text-2xs text-muted-foreground" data-testid="evidence-tag">
        no frame recorded
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-2xs tabular text-muted-foreground"
      data-testid="evidence-tag"
    >
      <Crosshair className="h-3 w-3" aria-hidden />
      {frame === undefined ? null : <span>frame {frame}</span>}
      {track === undefined ? null : <span>· track {track}</span>}
    </span>
  );
}

/** `12.4 s`, or `—`. ⚠️ An instant has no duration and must not render as `0.0 s`. */
export function Seconds({ value }: { value: number | undefined }) {
  if (value === undefined || !Number.isFinite(value)) {
    return <span className="text-muted-foreground">—</span>;
  }
  return <span className="tabular">{value.toFixed(1)} s</span>;
}

/**
 * ⛔ A banner for every way an answer can be incomplete. Rendered above the facts, not below them.
 *
 * Truncation is the failure mode this platform keeps meeting: a capped list looks like a short list,
 * and a capped *scene* looks like a complete one in which nothing social happened.
 */
export function Incompleteness({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul
      className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-500"
      data-testid="behaviour-incompleteness"
      role="status"
    >
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

/** ⚠️ Re-exported so panels import one module for the clock type. */
export type { RecordingClock };

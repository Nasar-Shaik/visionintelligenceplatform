/**
 * The keyboard shortcut sheet (P-5.6).
 *
 * ### ⚠️ Generated from the registry, never written by hand
 *
 * "Keyboard shortcuts must be fully discoverable" is not satisfied by a documentation page, because
 * a documentation page is a second copy of the bindings and the copy is wrong within one milestone.
 * Every row below is read out of the frozen command registry at render time, so a binding that
 * exists is listed and a binding that is listed exists.
 *
 * ⚠️ Commands the registry marks `available: false` are **shown, greyed, with their reason**. An
 * operator who has heard the product can capture a snapshot needs to learn that it is not built
 * yet — omitting the row teaches them the shortcut is broken and that they should stop trusting the
 * sheet.
 */
import { Keyboard } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/ui';
import { cn } from '@/lib/cn';
import { PLAYBACK_COMMANDS, formatChord } from './shortcuts';

/** Reasons a registered binding does nothing yet, keyed by command id. */
const UNAVAILABLE_REASON: Readonly<Record<string, string>> = {
  'playback.snapshot': 'No snapshot renderer is built yet.',
};

export interface ShortcutSheetProps {
  /** Capabilities gate some rows: a still image cannot step frames whatever the registry says. */
  frameStepAvailable?: boolean;
  className?: string;
}

export function ShortcutSheet({ frameStepAvailable = true, className }: ShortcutSheetProps) {
  const rows = PLAYBACK_COMMANDS.filter((command) => command.shortcut !== undefined);

  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Keyboard shortcuts"
              aria-keyshortcuts="Shift+?"
              className={cn('size-8 pointer-coarse:size-11', className)}
            >
              <Keyboard className="size-4" aria-hidden />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Keyboard shortcuts</TooltipContent>
      </Tooltip>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Playback shortcuts</DialogTitle>
          <DialogDescription>
            These are read from the platform&apos;s command registry, so this list is what the
            player actually does.
          </DialogDescription>
        </DialogHeader>

        <ul className="divide-y divide-border" data-testid="shortcut-list">
          {rows.map((command) => {
            const gated = !frameStepAvailable && command.id.endsWith('-frame');
            const unavailable = !command.available || gated;
            const reason = gated
              ? 'This source cannot step frames.'
              : UNAVAILABLE_REASON[command.id];
            return (
              <li
                key={command.id}
                className={cn(
                  'flex items-baseline justify-between gap-4 py-2',
                  unavailable && 'opacity-55',
                )}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-text">{command.title}</p>
                  {unavailable ? (
                    <p className="text-[11px] text-text-subtle">
                      {reason ?? 'Not implemented in this build.'}
                    </p>
                  ) : null}
                </div>
                <kbd className="shrink-0 rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-text-muted">
                  {formatChord(command.shortcut!)}
                </kbd>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

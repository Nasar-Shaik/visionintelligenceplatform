/**
 * The command palette — the discoverability surface, rendered entirely from the frozen registry.
 *
 * ⚠️ It lists only what the principal may run and something implements. A greyed-out "Resolve
 * Incident" would tell a viewer exactly which capabilities exist and which roles hold them, which
 * is a disclosure the omission avoids.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandId, WorkspaceCommand } from '@vip/contracts';
import { Dialog, DialogContent, DialogTitle } from '@/ui';
import { cn } from '@/lib/cn';
import { displayChord } from './useCommands';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: readonly WorkspaceCommand[];
  onRun: (id: CommandId) => void;
}

function matches(command: WorkspaceCommand, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    command.title.toLowerCase().includes(needle) ||
    command.keywords.some((keyword) => keyword.includes(needle))
  );
}

export function CommandPalette({ open, onOpenChange, commands, onRun }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(
    () => commands.filter((command) => matches(command, query)),
    [commands, query],
  );

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(results.length - 1, 0)));
  }, [results.length]);

  function run(command: WorkspaceCommand): void {
    onOpenChange(false);
    onRun(command.id);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((current) => Math.min(current + 1, results.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((current) => Math.max(current - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const command = results[active];
              if (command) run(command);
            }
          }}
          placeholder="Type a command…"
          aria-label="Command"
          aria-controls="command-palette-results"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-base text-text outline-none placeholder:text-text-subtle"
        />
        <ul
          id="command-palette-results"
          ref={listRef}
          role="listbox"
          className="max-h-80 overflow-auto py-1"
        >
          {results.length === 0 ? (
            <li className="px-4 py-6 text-center text-xs text-text-subtle">No matching command</li>
          ) : (
            results.map((command, index) => (
              <li key={command.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => run(command)}
                  className={cn(
                    'focus-ring flex w-full items-center gap-3 px-4 py-2 text-left text-sm',
                    index === active ? 'bg-surface-3 text-text' : 'text-text-muted',
                  )}
                >
                  <span className="flex-1 truncate">{command.title}</span>
                  <span className="text-2xs uppercase tracking-wide text-text-subtle">
                    {command.category}
                  </span>
                  {command.shortcut ? (
                    <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-text-subtle">
                      {displayChord(command.shortcut)}
                    </kbd>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

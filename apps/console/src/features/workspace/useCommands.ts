/**
 * The command surface — **the keyboard handler and the palette read the same array**.
 *
 * `WORKSPACE_COMMANDS` is frozen in `@vip/contracts`. Nothing in this file names a key: a component
 * cannot bind one, because the binding lives on the command. That is what "do not hardcode
 * shortcuts inside components" has to mean if it is to survive the second developer.
 *
 * ### ⚠️ Three rules enforced here because the contract cannot enforce them at runtime
 *
 * **`Mod` resolves per platform.** ⌘ on macOS, Ctrl everywhere else. The contract stores `Mod+K`
 * precisely so this decision happens once, here, rather than in fifteen components — half of which
 * would have shipped `Ctrl` and been wrong for every Mac operator.
 *
 * **A chord does not fire while the operator is typing.** `Space` pauses playback; it also puts a
 * space in a comment. Any key event originating in an input, textarea or contenteditable is left
 * alone — except an escape, which is always a dismissal.
 *
 * **A command the principal cannot run is not registered at all.** Not hidden, not disabled:
 * absent. A disabled "Resolve Incident" in the palette tells a viewer which capabilities exist and
 * who holds them.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  WORKSPACE_COMMANDS,
  type CommandId,
  type CommandScope,
  type WorkspaceCommand,
} from '@vip/contracts';

/** True on a platform where `Mod` means ⌘. Read once — it cannot change mid-session. */
const IS_APPLE =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/u.test(navigator.platform ?? '');

/** Render a contract chord for display: `Mod+Shift+E` → `⌘⇧E` or `Ctrl+Shift+E`. */
export function displayChord(chord: string): string {
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  const mods = parts.map((mod) => {
    if (mod === 'Mod') return IS_APPLE ? '⌘' : 'Ctrl';
    if (mod === 'Shift') return IS_APPLE ? '⇧' : 'Shift';
    if (mod === 'Alt') return IS_APPLE ? '⌥' : 'Alt';
    return mod;
  });
  const label =
    { Space: '␣', ArrowLeft: '←', ArrowRight: '→', Slash: '/', Comma: ',', Period: '.' }[key] ??
    key.toUpperCase();
  return IS_APPLE ? [...mods, label].join('') : [...mods, label].join('+');
}

/** Does a keyboard event match a contract chord? */
export function matchesChord(event: KeyboardEvent, chord: string): boolean {
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  const wantMod = parts.includes('Mod');
  const wantCtrl = parts.includes('Ctrl');
  const wantShift = parts.includes('Shift');
  const wantAlt = parts.includes('Alt');

  const modPressed = IS_APPLE ? event.metaKey : event.ctrlKey;
  if (wantMod !== modPressed) return false;
  if (wantCtrl && !event.ctrlKey) return false;
  if (wantShift !== event.shiftKey) return false;
  if (wantAlt !== event.altKey) return false;
  /* A bare chord must not fire while a modifier is held — `Space` is not `⌘Space`. */
  if (!wantMod && !wantCtrl && (event.metaKey || event.ctrlKey)) return false;

  const named: Record<string, string> = {
    Space: ' ',
    Slash: '/',
    Comma: ',',
    Period: '.',
    Backslash: '\\',
  };
  const expected = named[key] ?? key;
  if (expected.length === 1) return event.key.toLowerCase() === expected.toLowerCase();
  return event.key === expected;
}

/** Is the event coming from somewhere the operator is typing? */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export type CommandHandlers = Partial<Record<CommandId, () => void>>;

export interface UseCommandsInput {
  /** Concrete permissions the principal holds. */
  can: (permission: string) => boolean;
  /** Which scopes are live right now. `global` is always live. */
  activeScopes: readonly CommandScope[];
  handlers: CommandHandlers;
}

export interface CommandSurface {
  /** Commands the principal may run, that something implements, in palette order. */
  available: WorkspaceCommand[];
  run: (id: CommandId) => void;
}

export function useCommands({ can, activeScopes, handlers }: UseCommandsInput): CommandSurface {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const available = useMemo(
    () =>
      WORKSPACE_COMMANDS.commands.filter(
        (command) =>
          /*
           * ⚠️ Three filters, all of them omissions rather than disablements. `available: false`
           * covers a command whose feature is contract-frozen but unbuilt — a palette entry that
           * opens nothing teaches an operator the product is broken rather than incomplete.
           */
          command.available &&
          can(command.permission) &&
          handlersRef.current[command.id] !== undefined,
      ),
    [can],
  );

  const run = useCallback((id: CommandId) => {
    handlersRef.current[id]?.();
  }, []);

  useEffect(() => {
    const scopes = new Set<CommandScope>(['global', ...activeScopes]);

    function onKeyDown(event: KeyboardEvent): void {
      if (isTypingTarget(event.target) && event.key !== 'Escape') return;

      for (const command of WORKSPACE_COMMANDS.commands) {
        if (command.shortcut === undefined || !command.available) continue;
        if (!scopes.has(command.scope)) continue;
        if (!can(command.permission)) continue;
        if (!matchesChord(event, command.shortcut)) continue;

        const handler = handlersRef.current[command.id];
        if (handler === undefined) continue;
        event.preventDefault();
        handler();
        return;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeScopes, can]);

  return { available, run };
}

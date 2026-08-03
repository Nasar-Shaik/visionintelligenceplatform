/**
 * Turning a keystroke into a **command id from the frozen registry** (P-5.6).
 *
 * ### ⚠️ The player no longer contains a `switch` on `event.key`
 *
 * P-5.5's handler read the registry's chords in a comment and then re-typed them into a switch
 * statement. That is the exact failure the command contract was written to prevent: two tables
 * holding the same bindings, drifting apart silently, with the help sheet documenting one of them
 * and the code implementing the other. The registry is now *executed* — a chord is normalised from
 * the event, looked up in the `playback` scope, and dispatched by command id. A binding that is not
 * in the registry cannot fire, and a binding that is in the registry appears in the help sheet
 * whether or not anyone remembered to document it.
 *
 * ### ⚠️ `Mod` is resolved once, from the platform
 *
 * The registry writes `Mod+B` because the correct key is ⌘ on macOS and Ctrl everywhere else, and
 * hard-coding either ships the wrong shortcut to half the operators — the half that files no bug,
 * because they assume the product has no shortcuts.
 */
import { WORKSPACE_COMMANDS, type CommandId, type WorkspaceCommand } from '@vip/contracts';

/** Every registry command scoped to a playback surface, in registry order. */
export const PLAYBACK_COMMANDS: readonly WorkspaceCommand[] = WORKSPACE_COMMANDS.commands.filter(
  (command) => command.scope === 'playback',
);

/** The ones an operator can actually run today — `available` is the registry's honesty flag. */
export const AVAILABLE_PLAYBACK_COMMANDS: readonly WorkspaceCommand[] = PLAYBACK_COMMANDS.filter(
  (command) => command.available,
);

/** True on Apple platforms, where `Mod` means ⌘. Guarded for the server render. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

/**
 * Registry key names that differ from `KeyboardEvent.key`.
 *
 * ⚠️ The registry writes `Period` and `Comma` because a chord notation cannot contain a bare `.`
 * next to a `+` and stay readable, and because `event.key` for those is the *printed character*,
 * which changes with the keyboard layout. Mapping by name here keeps a French AZERTY layout firing
 * the same command as a US QWERTY one.
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  ' ': 'Space',
  '.': 'Period',
  ',': 'Comma',
  '>': 'Period',
  '<': 'Comma',
};

/**
 * Normalise a keyboard event into registry chord notation.
 *
 * ⚠️ Modifier order is fixed (`Mod+Alt+Shift+Key`) because a chord is compared as a string, and
 * `Shift+Mod+B` would silently fail to match `Mod+Shift+B`.
 */
export function chordOf(event: KeyboardEvent, apple = isApplePlatform()): string {
  const parts: string[] = [];
  const mod = apple ? event.metaKey : event.ctrlKey;
  if (mod) parts.push('Mod');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  const raw = event.key;
  const key =
    KEY_ALIASES[raw] ??
    /* Single printable characters are upper-cased so `b` and `B` are one chord, not two. */
    (raw.length === 1 ? raw.toUpperCase() : raw);
  parts.push(key);
  return parts.join('+');
}

/** chord → command id, for available playback commands only. Built once. */
const CHORD_INDEX: ReadonlyMap<string, CommandId> = new Map(
  AVAILABLE_PLAYBACK_COMMANDS.flatMap((command) =>
    command.shortcut === undefined ? [] : [[command.shortcut, command.id] as const],
  ),
);

/** Which command this keystroke runs, if any. */
export function commandForEvent(
  event: KeyboardEvent,
  apple = isApplePlatform(),
): CommandId | undefined {
  return CHORD_INDEX.get(chordOf(event, apple));
}

/**
 * Whether a keystroke aimed at this element should be ignored.
 *
 * ⚠️ Typing "Space" into the bookmark-label field must not stop the video. Text entry always wins;
 * this is checked before the registry is consulted, not after.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (element === null) return false;
  if (element.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName ?? '');
}

/** Render a chord for display: `Mod+Shift+S` → `⌘⇧S` on Apple, `Ctrl+Shift+S` elsewhere. */
export function formatChord(chord: string, apple = isApplePlatform()): string {
  const glyphs: Readonly<Record<string, string>> = apple
    ? { Mod: '⌘', Alt: '⌥', Shift: '⇧' }
    : { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
  const keys: Readonly<Record<string, string>> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Space: 'Space',
    Period: '.',
    Comma: ',',
  };
  const parts = chord.split('+').map((part) => glyphs[part] ?? keys[part] ?? part);
  /* ⚠️ Apple convention joins with nothing; everywhere else uses `+`. Mixing them looks broken. */
  return apple ? parts.join('') : parts.join('+');
}

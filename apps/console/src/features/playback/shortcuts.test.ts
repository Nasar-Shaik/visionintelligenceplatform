/**
 * Keystrokes resolve to **registry command ids** (P-5.6).
 *
 * ⚠️ The property under test is that there is one table, not two. P-5.5 read the registry's chords
 * in a comment and re-typed them into a `switch`; these tests assert that a chord fires the command
 * the registry says it fires, which is the same statement the help sheet renders.
 */
import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_PLAYBACK_COMMANDS,
  PLAYBACK_COMMANDS,
  chordOf,
  commandForEvent,
  formatChord,
  isTypingTarget,
} from './shortcuts';

const key = (init: Partial<KeyboardEvent> & { key: string }) =>
  ({
    key: init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  }) as KeyboardEvent;

describe('chords are normalised into registry notation', () => {
  it('names the space bar', () => {
    expect(chordOf(key({ key: ' ' }), true)).toBe('Space');
    expect(chordOf(key({ key: ' ', shiftKey: true }), true)).toBe('Shift+Space');
  });

  it('⚠️ resolves Mod to ⌘ on Apple and Ctrl elsewhere', () => {
    expect(chordOf(key({ key: 'b', metaKey: true }), true)).toBe('Mod+B');
    expect(chordOf(key({ key: 'b', ctrlKey: true }), false)).toBe('Mod+B');
    /* And the wrong modifier for the platform is not a chord at all. */
    expect(chordOf(key({ key: 'b', ctrlKey: true }), true)).toBe('B');
  });

  it('⚠️ fixes the modifier order, because chords are compared as strings', () => {
    expect(chordOf(key({ key: 's', metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+S');
  });

  it('⚠️ maps punctuation by name, so a non-US layout fires the same command', () => {
    expect(chordOf(key({ key: '.', shiftKey: true }), true)).toBe('Shift+Period');
    expect(chordOf(key({ key: '>', shiftKey: true }), true)).toBe('Shift+Period');
    expect(chordOf(key({ key: ',', shiftKey: true }), true)).toBe('Shift+Comma');
  });

  it('upper-cases single characters so case is not a second binding', () => {
    expect(chordOf(key({ key: 'f' }), true)).toBe('F');
    expect(chordOf(key({ key: 'F' }), true)).toBe('F');
  });
});

describe('a keystroke resolves to the command the registry bound it to', () => {
  it('plays and stops', () => {
    expect(commandForEvent(key({ key: ' ' }), true)).toBe('playback.play-pause');
    expect(commandForEvent(key({ key: ' ', shiftKey: true }), true)).toBe('playback.stop');
  });

  it('steps and seeks', () => {
    expect(commandForEvent(key({ key: 'ArrowLeft' }), true)).toBe('playback.previous-frame');
    expect(commandForEvent(key({ key: 'ArrowLeft', shiftKey: true }), true)).toBe(
      'playback.back-5',
    );
    expect(commandForEvent(key({ key: 'ArrowRight', altKey: true }), true)).toBe(
      'playback.forward-30',
    );
  });

  it('bookmarks with a modifier — a mutation is never one bare keystroke away', () => {
    expect(commandForEvent(key({ key: 'b', metaKey: true }), true)).toBe('playback.bookmark');
    expect(commandForEvent(key({ key: 'b' }), true)).toBeUndefined();
  });

  it('⚠️ a chord the registry does not bind fires nothing', () => {
    expect(commandForEvent(key({ key: 'q' }), true)).toBeUndefined();
  });

  it('⚠️ a command marked unavailable is not dispatchable, however documented its chord is', () => {
    /* Snapshot has a reserved binding and no renderer. Reserving it must not make it fire. */
    const snapshot = PLAYBACK_COMMANDS.find((c) => c.id === 'playback.snapshot');
    expect(snapshot?.available).toBe(false);
    expect(commandForEvent(key({ key: 's', metaKey: true, shiftKey: true }), true)).toBeUndefined();
  });
});

describe('text entry always wins', () => {
  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('ignores keystrokes aimed at a %s', (tagName) => {
    expect(isTypingTarget({ tagName, isContentEditable: false } as HTMLElement)).toBe(true);
  });

  it('ignores contenteditable', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as HTMLElement)).toBe(true);
  });

  it('does not ignore the page', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: false } as HTMLElement)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('the sheet renders what the handler dispatches', () => {
  it('⚠️ every available playback binding is dispatchable', () => {
    for (const command of AVAILABLE_PLAYBACK_COMMANDS) {
      if (command.shortcut === undefined) continue;
      /* Reconstructing the event from the chord and resolving it must return the same command. */
      const parts = command.shortcut.split('+');
      const keyName = parts[parts.length - 1]!;
      const event = key({
        key:
          keyName === 'Space'
            ? ' '
            : keyName === 'Period'
              ? '.'
              : keyName === 'Comma'
                ? ','
                : keyName,
        metaKey: parts.includes('Mod'),
        altKey: parts.includes('Alt'),
        shiftKey: parts.includes('Shift'),
      });
      expect(commandForEvent(event, true)).toBe(command.id);
    }
  });
});

describe('chords are displayed the way the platform writes them', () => {
  it('uses glyphs on Apple and words elsewhere', () => {
    expect(formatChord('Mod+Shift+S', true)).toBe('⌘⇧S');
    expect(formatChord('Mod+Shift+S', false)).toBe('Ctrl+Shift+S');
  });

  it('draws the arrows', () => {
    expect(formatChord('Alt+ArrowLeft', true)).toBe('⌥←');
    expect(formatChord('Shift+Period', false)).toBe('Shift+.');
  });
});

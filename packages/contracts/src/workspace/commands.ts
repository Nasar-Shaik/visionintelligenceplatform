/**
 * Command + keyboard registry (P-5.2.0, refinements 2 and 5) — **one registry, not two**.
 *
 * The refinements arrived as two requests: a centralized keyboard shortcut contract, and a global
 * command registry for the command palette. They are modelled as **one thing** here, because a
 * shortcut is not an independent concept — it is a *binding to a command*. Two tables would need
 * the same names in both, and the first divergence is a shortcut firing a command that was renamed
 * or removed: it fails at runtime, on a keystroke, for one user, in a way no test reaches. This is
 * the same reasoning that kept `IncidentActivityKind` from duplicating `IncidentStatus`
 * ([ADR-0030](../../../../docs/adr/ADR-0030-incident-prerequisites.md) decision 4).
 *
 * So: a command declares its own key binding, and the palette and the key handler read the same
 * array. `Do not hardcode shortcuts inside components` becomes structurally true — a component
 * cannot bind a key, because the binding lives on the command.
 *
 * ### ⚠️ Three rules the schema enforces rather than documents
 *
 * 1. **A mutating command may not have a bare, unmodified key.** `r` for Resolve is one keystroke
 *    away from changing an incident's state whenever focus is not in a text field. Mutations
 *    require a modifier — asserted below, not left to reviewer attention.
 * 2. **Chords are written `Mod+K`, never `Ctrl+K`.** `Mod` is Cmd on macOS and Ctrl everywhere
 *    else. Hard-coding either one ships the wrong shortcut to half the operators, and it is the
 *    half that files no bug because they assume the product has no shortcuts.
 * 3. **No two commands in the same scope share a chord.** Conflicts are silent: one handler wins,
 *    consistently, and the other command simply never fires.
 */
import { z } from 'zod';

/**
 * Where a command is live. Scopes are disjoint contexts, so the *same* chord may mean different
 * things in different ones — `ArrowLeft` steps a frame in `playback` and moves the selection in
 * `queue`, which is correct and is why conflicts are checked per scope rather than globally.
 */
export const CommandScope = z.enum([
  /** Available anywhere in the console. */
  'global',
  /** Only inside the Investigation Workspace. */
  'workspace',
  /** Only while a playback surface has focus. */
  'playback',
  /** Only while the incident queue has focus. */
  'queue',
]);
export type CommandScope = z.infer<typeof CommandScope>;

/** Palette grouping. Presentation only — it never affects what a command does. */
export const CommandCategory = z.enum([
  'navigation',
  'search',
  'playback',
  'incident',
  'evidence',
  'report',
]);
export type CommandCategory = z.infer<typeof CommandCategory>;

/**
 * Every command the platform knows about. **Extends additively.** A console that meets an unknown
 * id ignores it — which is why the palette renders from this list rather than from a switch.
 */
export const CommandId = z.enum([
  // palette + search
  'command-palette.open',
  'search.open',
  'search.camera',
  'search.incident',
  'search.rule',
  // navigation
  'workspace.open-incident-queue',
  'workspace.open-timeline',
  'workspace.open-evidence',
  'workspace.open-playback',
  // playback transport
  'playback.play-pause',
  'playback.previous-frame',
  'playback.next-frame',
  'playback.bookmark',
  // incident actions
  'incident.assign',
  'incident.resolve',
  // export
  'report.export',
]);
export type CommandId = z.infer<typeof CommandId>;

/**
 * A key chord in platform-neutral notation: zero or more modifiers then one key, joined by `+`.
 *
 * `Mod` resolves to Cmd on macOS and Ctrl elsewhere (rule 2). `Ctrl` is accepted for the rare
 * binding that genuinely means the physical Control key on every platform.
 */
export const KeyChord = z
  .string()
  .regex(
    /^(?:(?:Mod|Ctrl|Shift|Alt)\+)*(?:[A-Za-z0-9]|F[1-9]|F1[0-2]|Space|Enter|Escape|Tab|Comma|Period|Slash|Backslash|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/,
    'must be modifiers (Mod|Ctrl|Shift|Alt) then one key, joined by +, e.g. "Mod+K"',
  );
export type KeyChord = z.infer<typeof KeyChord>;

/** True when the chord carries at least one modifier — the test rule 1 applies. */
export function hasModifier(chord: string): boolean {
  return chord.includes('+');
}

export const WorkspaceCommand = z.object({
  id: CommandId,
  title: z.string().min(1).max(80),
  category: CommandCategory,
  scope: CommandScope,
  /**
   * The permission required to run it. ⚠️ A command the principal lacks is **omitted from the
   * palette entirely**, not shown disabled: a disabled "Resolve Incident" entry tells a viewer
   * exactly which capabilities exist and which roles hold them.
   */
  permission: z.string().min(1),
  /**
   * Whether running this changes stored state. Drives rule 1, drives whether the palette asks for
   * confirmation, and — the reason it is on the contract rather than in the handler — makes
   * "which keystrokes can change data" a question with a checkable answer.
   */
  mutates: z.boolean().default(false),
  /** The default binding. Absent means palette-only, which is a legitimate and common choice. */
  shortcut: KeyChord.optional(),
  /** Extra words the palette matches on, for operators who look for "video" rather than "playback". */
  keywords: z.array(z.string().min(1).max(40)).max(10).default([]),
  /**
   * ⚠️ Whether anything implements it yet. A palette entry that opens nothing is worse than a
   * missing one — the operator concludes the feature is broken rather than absent. Deferred
   * commands are registered (so the binding is reserved and cannot be reused) and **not shown**.
   */
  available: z.boolean().default(true),
});
export type WorkspaceCommand = z.infer<typeof WorkspaceCommand>;

export const CommandRegistry = z
  .object({
    version: z.number().int().min(1),
    commands: z.array(WorkspaceCommand).min(1),
  })
  .superRefine((registry, ctx) => {
    const ids = new Set<string>();
    /** scope → chord, so the same chord may repeat across disjoint scopes (see `CommandScope`). */
    const bound = new Map<string, string>();

    for (const command of registry.commands) {
      if (ids.has(command.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate command: ${command.id}` });
      }
      ids.add(command.id);

      if (command.shortcut === undefined) continue;

      // Rule 1 — a mutation is never one unmodified keystroke away.
      if (command.mutates && !hasModifier(command.shortcut)) {
        ctx.addIssue({
          code: 'custom',
          message: `${command.id} mutates state and must not bind a bare key (${command.shortcut})`,
        });
      }

      // Rule 3 — conflicts are silent, so they are refused here.
      const slot = `${command.scope}:${command.shortcut}`;
      const existing = bound.get(slot);
      if (existing !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `${command.shortcut} is bound twice in scope ${command.scope}: ${existing} and ${command.id}`,
        });
      }
      bound.set(slot, command.id);

      /*
       * A `global` chord shadows the same chord in every nested scope, so it conflicts with all of
       * them — checked explicitly because the per-scope map above would not catch it.
       */
      if (command.scope !== 'global') {
        const shadowed = bound.get(`global:${command.shortcut}`);
        if (shadowed !== undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `${command.id} binds ${command.shortcut}, already global on ${shadowed}`,
          });
        }
      }
    }
  });
export type CommandRegistry = z.infer<typeof CommandRegistry>;

/**
 * **The frozen registry** (P-5.2.0). The workspace consumes this; it does not define commands
 * locally.
 *
 * Bindings follow the conventions operators already have from other tools: `Mod+K` opens the
 * palette, `/` focuses search, `Space` plays and pauses, arrows step frames. Every mutating command
 * carries a modifier (rule 1), which is why Assign is `Mod+Shift+A` rather than `a`.
 */
export const WORKSPACE_COMMANDS: CommandRegistry = {
  version: 1,
  commands: [
    {
      id: 'command-palette.open',
      title: 'Command Palette',
      category: 'navigation',
      scope: 'global',
      permission: 'incident:read',
      mutates: false,
      shortcut: 'Mod+K',
      keywords: ['commands', 'actions', 'palette'],
      available: true,
    },
    {
      id: 'search.open',
      title: 'Search',
      category: 'search',
      scope: 'global',
      permission: 'incident:read',
      mutates: false,
      shortcut: 'Slash',
      keywords: ['find', 'lookup'],
      available: true,
    },
    {
      id: 'search.camera',
      title: 'Search Cameras',
      category: 'search',
      scope: 'global',
      permission: 'camera:read',
      mutates: false,
      keywords: ['camera', 'device'],
      available: true,
    },
    {
      id: 'search.incident',
      title: 'Search Incidents',
      category: 'search',
      scope: 'global',
      permission: 'incident:read',
      mutates: false,
      keywords: ['incident', 'alarm'],
      available: true,
    },
    {
      id: 'search.rule',
      title: 'Search Rules',
      category: 'search',
      scope: 'global',
      permission: 'rule:read',
      mutates: false,
      keywords: ['rule', 'policy'],
      available: true,
    },
    {
      id: 'workspace.open-incident-queue',
      title: 'Open Incident Queue',
      category: 'navigation',
      scope: 'workspace',
      permission: 'incident:read',
      mutates: false,
      shortcut: 'Mod+1',
      keywords: ['queue', 'list'],
      available: true,
    },
    {
      id: 'workspace.open-evidence',
      title: 'Open Evidence',
      category: 'navigation',
      scope: 'workspace',
      permission: 'evidence:read',
      mutates: false,
      shortcut: 'Mod+2',
      keywords: ['evidence', 'snapshot', 'clip'],
      available: true,
    },
    {
      id: 'workspace.open-playback',
      title: 'Open Playback',
      category: 'navigation',
      scope: 'workspace',
      permission: 'stream:read',
      mutates: false,
      shortcut: 'Mod+3',
      keywords: ['video', 'footage', 'player'],
      available: true,
    },
    {
      id: 'workspace.open-timeline',
      title: 'Open Timeline',
      category: 'navigation',
      scope: 'workspace',
      permission: 'incident:read',
      mutates: false,
      shortcut: 'Mod+4',
      keywords: ['timeline', 'history', 'narrative'],
      available: true,
    },
    {
      id: 'playback.play-pause',
      title: 'Play / Pause',
      category: 'playback',
      scope: 'playback',
      permission: 'stream:read',
      mutates: false,
      shortcut: 'Space',
      keywords: ['play', 'pause', 'stop'],
      available: true,
    },
    {
      id: 'playback.previous-frame',
      title: 'Previous Frame',
      category: 'playback',
      scope: 'playback',
      permission: 'stream:read',
      mutates: false,
      shortcut: 'ArrowLeft',
      keywords: ['step', 'back', 'rewind'],
      available: true,
    },
    {
      id: 'playback.next-frame',
      title: 'Next Frame',
      category: 'playback',
      scope: 'playback',
      permission: 'stream:read',
      mutates: false,
      shortcut: 'ArrowRight',
      keywords: ['step', 'forward', 'advance'],
      available: true,
    },
    {
      id: 'playback.bookmark',
      title: 'Bookmark This Moment',
      category: 'playback',
      scope: 'playback',
      permission: 'incident:comment',
      /* Writes a `PlaybackBookmark` — hence a modifier (rule 1). */
      mutates: true,
      shortcut: 'Mod+B',
      keywords: ['mark', 'save', 'moment'],
      available: false,
    },
    {
      id: 'incident.assign',
      title: 'Assign Incident',
      category: 'incident',
      scope: 'workspace',
      permission: 'incident:assign',
      mutates: true,
      shortcut: 'Mod+Shift+A',
      keywords: ['assign', 'owner', 'handover'],
      available: true,
    },
    {
      id: 'incident.resolve',
      title: 'Resolve Incident',
      category: 'incident',
      scope: 'workspace',
      permission: 'incident:resolve',
      mutates: true,
      shortcut: 'Mod+Shift+R',
      keywords: ['resolve', 'complete', 'done'],
      available: true,
    },
    {
      id: 'report.export',
      title: 'Export Report',
      category: 'report',
      scope: 'workspace',
      permission: 'incident:export',
      /* Queues a background job, which is a stored record — so it mutates. */
      mutates: true,
      shortcut: 'Mod+Shift+E',
      keywords: ['export', 'pdf', 'report', 'download'],
      available: false,
    },
  ],
};

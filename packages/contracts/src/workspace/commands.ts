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
  // P-5.4 reserved these; P-5.5 built all but `snapshot`.
  'playback.stop',
  'playback.back-5',
  'playback.forward-5',
  'playback.back-30',
  'playback.forward-30',
  'playback.speed-up',
  'playback.speed-down',
  'playback.speed-reset',
  'playback.fullscreen',
  'playback.picture-in-picture',
  'playback.snapshot',
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

// ---------------------------------------------------------------------------------------------
// P-5.2 rec 5 — one command registry, many bindings.
// ---------------------------------------------------------------------------------------------

/**
 * How a command can be invoked. **Reserved: only `keyboard` and `palette` are implemented.**
 *
 * The recommendation was "one command registry, many bindings" — keyboard, mouse, touch,
 * automation, voice, AI assistant. Reserving the *kinds* here costs nothing and settles the shape;
 * what it must not do is quietly widen who can do what.
 *
 * ### ⚠️ The one that changes a security boundary
 *
 * `ai-assistant` is the reason this enum needed a rule rather than a comment. P-5.1 froze the AI
 * boundary — *AI may recommend, summarise, correlate, prioritise, suggest and explain; it may never
 * assign, resolve, close, delete, modify or escalate* — and enforced it in the permission catalog
 * and a domain guard. A binding surface is a **third** way in, and it is the one that looks
 * harmless: "let the assistant run the Resolve command" reads like UI plumbing, not like granting
 * an AI the ability to close an incident.
 *
 * So `CommandRegistry` **refuses** an `ai-assistant` or `automation` binding on any command with
 * `mutates: true`. Not by convention, and not by prompt — the registry will not parse.
 */
export const CommandBindingKind = z.enum([
  /** A key chord. Implemented. */
  'keyboard',
  /** Selected from the command palette. Implemented. */
  'palette',
  /** A toolbar button, context menu item or gesture. Reserved. */
  'mouse',
  /** A touch gesture on a tablet in the field. Reserved. */
  'touch',
  /** A configured automation acting on a policy someone wrote. ⚠️ Reserved; read-only commands. */
  'automation',
  /** Spoken, hands-free in a control room. Reserved. */
  'voice',
  /** ⚠️ An AI assistant. Reserved, and **read-only commands only** — see the note above. */
  'ai-assistant',
]);
export type CommandBindingKind = z.infer<typeof CommandBindingKind>;

/**
 * Binding kinds that may **never** invoke a state-changing command. Exported as data so the rule is
 * greppable and testable rather than buried in a refinement.
 */
export const NON_MUTATING_BINDING_KINDS: readonly CommandBindingKind[] = [
  'ai-assistant',
  'automation',
];

/**
 * Which invocation surfaces a command exposes. Absent ⇒ `['keyboard', 'palette']`, the two that
 * exist today.
 */
export const CommandBindings = z.array(CommandBindingKind).min(1).max(7);
export type CommandBindings = z.infer<typeof CommandBindings>;

/**
 * Does this command's binding set violate the AI boundary?
 *
 * Returns the offending kinds, so an error can name them. Empty means the command is safe.
 */
export function forbiddenBindings(
  mutates: boolean,
  bindings: readonly CommandBindingKind[] | undefined,
): CommandBindingKind[] {
  if (!mutates || bindings === undefined) return [];
  return bindings.filter((kind) => NON_MUTATING_BINDING_KINDS.includes(kind));
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
  /**
   * Which invocation surfaces may run this (P-5.2 rec 5). Defaults to the two that exist.
   *
   * ⚠️ `ai-assistant` and `automation` are **refused on a mutating command** by `CommandRegistry`.
   * See `CommandBindingKind` — a binding surface is a third way past the AI boundary, and it is the
   * one that looks like UI plumbing rather than like granting an AI the ability to close an incident.
   */
  bindings: z.array(CommandBindingKind).min(1).max(7).default(['keyboard', 'palette']),
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

      /*
       * ⚠️ Rule 4 (P-5.2 rec 5) — the AI boundary, enforced a third time. P-5.1 locked it in the
       * permission catalog and in a domain guard; a binding surface is the way past both, because
       * "let the assistant run Resolve" reads like plumbing rather than like authorising an AI to
       * close an incident.
       */
      const forbidden = forbiddenBindings(command.mutates, command.bindings);
      if (forbidden.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `${command.id} mutates state and must not be bound to ${forbidden.join(', ')} — AI and automation are advisory (P-5.1 boundary)`,
        });
      }

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
      bindings: ['keyboard', 'palette', 'mouse'],
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
      bindings: ['keyboard', 'palette', 'mouse', 'voice', 'ai-assistant'],
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
      bindings: ['keyboard', 'palette', 'mouse', 'voice', 'ai-assistant'],
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
      bindings: ['keyboard', 'palette', 'mouse', 'voice', 'ai-assistant'],
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
      bindings: ['keyboard', 'palette', 'mouse', 'voice', 'ai-assistant'],
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
      bindings: ['keyboard', 'palette', 'mouse', 'touch', 'voice', 'ai-assistant'],
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
      bindings: ['keyboard', 'palette', 'mouse', 'touch', 'voice', 'ai-assistant'],
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
      bindings: ['keyboard', 'palette', 'mouse', 'touch', 'voice', 'ai-assistant'],
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
      bindings: ['keyboard', 'palette', 'mouse', 'touch', 'voice', 'ai-assistant'],
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
      bindings: ['keyboard', 'palette', 'mouse', 'touch', 'voice'],
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
      bindings: ['keyboard', 'palette', 'mouse', 'touch', 'voice'],
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
      bindings: ['keyboard', 'palette', 'mouse', 'touch', 'voice'],
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
      bindings: ['keyboard', 'palette', 'mouse'],
      /* P-5.6: the bookmark store, the API and the player action all exist, so the binding fires. */
      available: true,
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
      bindings: ['keyboard', 'palette', 'mouse'],
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
      bindings: ['keyboard', 'palette', 'mouse'],
      available: true,
    },
    /*
     * P-5.4 reserved these; **P-5.5 built them** and flipped `available` to true. That field exists
     * to say what a deployment can actually do, so keeping it stale would be the lie it was added
     * to prevent.
     *
     * ⚠️ `playback.snapshot` stays `false`: no renderer extracts a still, so offering it would put
     * a control on the screen that fails.
     */
    {
      id: 'playback.stop',
      title: 'Stop',
      category: 'playback',
      scope: 'playback',
      permission: 'stream:read',
      mutates: false,
      shortcut: 'Shift+Space',
      keywords: ['stop', 'halt', 'reset'],
      bindings: ['keyboard', 'palette', 'mouse', 'touch'],
      available: true,
    },
    {
      id: 'playback.back-5',
      title: 'Back 5 Seconds',
      category: 'playback',
      scope: 'playback',
      permission: 'stream:read',
      mutates: false,
      shortcut: 'Shift+ArrowLeft',
      keywords: ['back', 'rewind', 'skip', '5'],
      bindings: ['keyboard', 'palette', 'mouse', 'touch'],
      available: true,
    },
    {
      id: 'playback.forward-5',
      title: 'Forward 5 Seconds',
      category: 'playback',
      scope: 'playback',
      permission: 'stream:read',
      mutates: false,
      shortcut: 'Shift+ArrowRight',
      keywords: ['forward', 'skip', '5'],
      bindings: ['keyboard', 'palette', 'mouse', 'touch'],
      available: true,
    },
    {
      id: 'playback.back-30',
      title: 'Back 30 Seconds',
      category: 'playback',
      scope: 'playback',
      permission: 'stream:read',
      mutates: false,
      shortcut: 'Alt+ArrowLeft',
      keywords: ['back', 'rewind', 'skip', '30'],
      bindings: ['keyboard', 'palette', 'mouse', 'touch'],
      available: true,
    },
    {
      id: 'playback.forward-30',
      title: 'Forward 30 Seconds',
      category: 'playback',
      scope: 'playback',
      permission: 'stream:read',
      mutates: false,
      shortcut: 'Alt+ArrowRight',
      keywords: ['forward', 'skip', '30'],
      bindings: ['keyboard', 'palette', 'mouse', 'touch'],
      available: true,
    },
    {
      id: 'playback.speed-up',
      title: 'Increase Speed',
      category: 'playback',
      scope: 'playback',
      permission: 'stream:read',
      mutates: false,
      shortcut: 'Shift+Period',
      keywords: ['speed', 'faster', 'rate'],
      bindings: ['keyboard', 'palette', 'mouse'],
      available: true,
    },
    {
      id: 'playback.speed-down',
      title: 'Decrease Speed',
      category: 'playback',
      scope: 'playback',
      permission: 'stream:read',
      mutates: false,
      shortcut: 'Shift+Comma',
      keywords: ['speed', 'slower', 'rate'],
      bindings: ['keyboard', 'palette', 'mouse'],
      available: true,
    },
    {
      id: 'playback.speed-reset',
      title: 'Normal Speed',
      category: 'playback',
      scope: 'playback',
      permission: 'stream:read',
      mutates: false,
      shortcut: 'Mod+0',
      keywords: ['speed', 'normal', '1x', 'reset'],
      bindings: ['keyboard', 'palette', 'mouse'],
      available: true,
    },
    {
      id: 'playback.fullscreen',
      title: 'Fullscreen',
      category: 'playback',
      scope: 'playback',
      permission: 'stream:read',
      mutates: false,
      shortcut: 'F',
      keywords: ['fullscreen', 'expand', 'maximise'],
      bindings: ['keyboard', 'palette', 'mouse', 'touch'],
      available: true,
    },
    {
      id: 'playback.picture-in-picture',
      title: 'Picture in Picture',
      category: 'playback',
      scope: 'playback',
      permission: 'stream:read',
      mutates: false,
      shortcut: 'Shift+F',
      keywords: ['pip', 'picture', 'float', 'detach'],
      bindings: ['keyboard', 'palette', 'mouse'],
      available: true,
    },
    {
      id: 'playback.snapshot',
      title: 'Capture Snapshot',
      category: 'evidence',
      scope: 'playback',
      permission: 'evidence:create',
      /*
       * ⚠️ Mutates. A snapshot is not a screenshot: it creates a **new Evidence record** with its
       * own integrity hash and custody log (`CapturePlaybackSnapshotInput`). That is why it needs a
       * modifier under rule 1 and why it sits in the `evidence` category rather than `playback`.
       */
      mutates: true,
      shortcut: 'Mod+Shift+S',
      keywords: ['snapshot', 'capture', 'still', 'frame', 'evidence'],
      bindings: ['keyboard', 'palette', 'mouse'],
      available: false,
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
      bindings: ['keyboard', 'palette', 'mouse'],
      available: false,
    },
  ],
};

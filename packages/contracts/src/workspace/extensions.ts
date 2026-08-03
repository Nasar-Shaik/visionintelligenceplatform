/**
 * Extension point register (P-5.2, Architect rec 9) — **reserved points, and deliberately no
 * plugin loader**.
 *
 * The instruction was: reserve extension points, do not implement, no runtime dependency today.
 *
 * ### ⚠️ What is reserved, and what is not
 *
 * Reserved: **where** the platform will accept an extension, and what each point may contribute.
 * That is a register — the same shape as the panel and search registers, and it costs nothing.
 *
 * **Not** reserved: a plugin manifest, a loader, a sandbox, a capability grant model, or any notion
 * of third-party code executing in this platform. Those are not contract details that can be
 * settled early and filled in later; they are a **security architecture**, and the questions they
 * answer — what may a plugin read, whose tenant does it act in, what happens when it hangs, how is
 * it revoked — have no defensible default. Writing a `PluginManifest` now would settle those
 * questions by accident, in a file nobody read as a security decision.
 *
 * So this file names the seams and stops. When an extension model is actually needed it gets its
 * own milestone and its own ADR, and it will consume this register rather than replace it.
 */
import { z } from 'zod';

/**
 * Where the platform will accept an extension. **Nothing loads any of these.**
 */
export const ExtensionPoint = z.enum([
  /** A new panel in the Investigation Workspace, entered in the panel register. */
  'workspace.panel',
  /** A new command in the command registry — subject to the same binding rules, including the AI one. */
  'workspace.command',
  /** An overlay or control on the playback surface (a detector's boxes, a measurement tool). */
  'playback.overlay',
  /** A section generator for the report model. Consumes `ReportModel`; never rewrites it. */
  'report.section',
  /** An additional entity for unified search. ⚠️ Must declare an indexed `SearchMatchMode` (G-4). */
  'search.provider',
  /** A read-only investigation tool: a calculator, a converter, a lookup. */
  'investigation.tool',
]);
export type ExtensionPoint = z.infer<typeof ExtensionPoint>;

/**
 * What the platform will guarantee an extension at a given point, stated now so the guarantees are
 * not invented under delivery pressure later.
 */
export const ExtensionPointReservation = z.object({
  point: ExtensionPoint,
  /**
   * ⚠️ Whether an extension at this point may change stored state. **Every point is read-only
   * today, and `search.provider` and `playback.overlay` must stay that way** — a search provider
   * that could write is a search provider that can be made to write by whoever controls the query.
   */
  mutates: z.literal(false),
  /** The permission an extension's contribution is gated behind — the host's, never its own. */
  permission: z.string().min(1),
  /** Why this seam exists, so a future implementer knows what it was for. */
  intent: z.string().min(1).max(300),
});
export type ExtensionPointReservation = z.infer<typeof ExtensionPointReservation>;

/** **The reserved seams** (P-5.2). Nothing consumes this; it is the record of the decision. */
export const EXTENSION_POINTS: readonly ExtensionPointReservation[] = [
  {
    point: 'workspace.panel',
    mutates: false,
    permission: 'incident:read',
    intent:
      'A contributed panel joins the panel register and obeys every rule in it — region, availability, persistence key, four render states.',
  },
  {
    point: 'workspace.command',
    mutates: false,
    permission: 'incident:read',
    intent:
      'A contributed command joins the command registry. The binding rules apply unchanged, including the refusal of ai-assistant and automation bindings on anything mutating.',
  },
  {
    point: 'playback.overlay',
    mutates: false,
    permission: 'stream:read',
    intent:
      'Draws over the video surface using normalised [0,1] coordinates. It never writes to an evidence record and never alters the decoded frame.',
  },
  {
    point: 'report.section',
    mutates: false,
    permission: 'incident:export',
    intent:
      'Contributes a ReportSection to the shared model. It may not choose which other sections appear, for the reason a theme may not.',
  },
  {
    point: 'search.provider',
    mutates: false,
    permission: 'incident:read',
    intent:
      'Adds an entity to unified search. ⚠️ It must declare an indexed SearchMatchMode — a provider that scans is the failure entry criterion G-4 exists to prevent, and a third party is exactly who would ship one.',
  },
  {
    point: 'investigation.tool',
    mutates: false,
    permission: 'incident:read',
    intent: 'A read-only utility surfaced in the workspace. No platform data leaves the browser.',
  },
];

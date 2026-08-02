/**
 * The platform's frozen foundations, as **governance metadata** (P-2.3, Architect rec 1).
 *
 * > **Nothing in the platform may branch on anything in this file, and nothing does.** There is no
 * > feature gate here, no compatibility check, no version negotiation. If a code path ever reads a
 * > foundation version to decide what to do, the freeze has become a runtime concern and this file
 * > has become the thing it was written to avoid.
 *
 * It exists for one reason: a conversation about what is frozen needs a noun in it. "The Camera
 * Foundation is frozen" is a sentence someone can disagree with; `CAMERA_FOUNDATION.version === 1.0,
 * status: frozen, evolution: additive-only` is a fact with a location.
 *
 * The authoritative records are the documents each entry points at. This is the index.
 */

/** How a frozen foundation may evolve. `additive-only` is the only value any foundation has today. */
export type FoundationEvolution = 'additive-only' | 'open';

export type FoundationStatus = 'frozen' | 'active';

export interface Foundation {
  /** Human name, as it appears in review. */
  readonly name: string;
  /** Architectural version. Bumped only by an ADR that unfreezes and re-freezes. */
  readonly version: string;
  readonly status: FoundationStatus;
  readonly evolution: FoundationEvolution;
  /** ISO date the freeze was declared. */
  readonly frozenAt: string;
  /** Repo-relative path to the authoritative record. */
  readonly record: string;
}

/**
 * Every frozen foundation, in the order they were completed.
 *
 * Infrastructure is complete as of 2026-08-02. Work from P-3 onward is customer-facing product built
 * **on** these, not into them — see `docs/project/FOUNDATION_PRINCIPLES.md`.
 */
export const FOUNDATIONS: readonly Foundation[] = [
  {
    name: 'Platform Core',
    version: '1.0',
    status: 'frozen',
    evolution: 'additive-only',
    frozenAt: '2026-07-01',
    record: 'docs/project/PHASE1_EXIT_REVIEW.md',
  },
  {
    name: 'AI Runtime',
    version: '1.0',
    status: 'frozen',
    evolution: 'additive-only',
    frozenAt: '2026-08-01',
    record: 'docs/project/CONSTRAINTS.md',
  },
  {
    name: 'Operational Runtime',
    version: '1.0',
    status: 'frozen',
    evolution: 'additive-only',
    frozenAt: '2026-08-01',
    record: 'docs/project/CONSTRAINTS.md',
  },
  {
    name: 'Camera Foundation',
    version: '1.0',
    status: 'frozen',
    evolution: 'additive-only',
    frozenAt: '2026-08-02',
    record: 'docs/architecture/CAMERA_FOUNDATION_V1.md',
  },
  {
    name: 'Evidence Foundation',
    version: '1.0',
    status: 'frozen',
    evolution: 'additive-only',
    frozenAt: '2026-08-02',
    record: 'docs/architecture/CAMERA_FOUNDATION_V1.md',
  },
  {
    /*
     * The first **product-layer** subsystem to be frozen (P-3), and frozen for the same reason the
     * foundations were: everything else attaches to it. Rules, incidents, permissions, analytics,
     * notifications and reports all reference a location, and a subsystem that keeps moving is one
     * nobody can build on.
     *
     * Named "Location Hierarchy" here — it models the physical world rather than organizational
     * ownership. The code keeps its `Org*` names: renaming published contracts is the one change the
     * freeze forbids without an ADR, and clarity of prose does not buy a breaking change.
     */
    name: 'Location Hierarchy',
    version: '1.0',
    status: 'frozen',
    evolution: 'additive-only',
    frozenAt: '2026-08-02',
    record: 'docs/architecture/HIERARCHY_FOUNDATION_V1.md',
  },
] as const;

/** Look up a foundation by name. For tooling and documentation generation — never for a decision. */
export function foundation(name: string): Foundation | undefined {
  return FOUNDATIONS.find((entry) => entry.name === name);
}

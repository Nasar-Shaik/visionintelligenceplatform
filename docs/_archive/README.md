# Archive — Legacy Analyses (Frozen Provenance)

> **Not authoritative. Do not build from this.** These are the three original AI-authored analyses (Fable, Grok, Gemini) that preceded and informed the ratified architecture. They are retained **only** for historical traceability.

The authoritative architecture is [`docs/`](../) (the Engineering Constitution + numbered sections). Everything of lasting value from these analyses has been **merged, reconciled, or superseded**:

- Architecture, vision, SaaS, pipeline, engines, security, MLOps, roadmap → reframed into `docs/` (capability/plugin/event-driven model).
- Dev-environment setup → [`docs/reference/DEV-ENVIRONMENT.md`](../reference/DEV-ENVIRONMENT.md).
- Hardware sizing & deployment models → [`docs/reference/HARDWARE-SIZING.md`](../reference/HARDWARE-SIZING.md).
- Model datasets/accuracy → [`docs/reference/MODEL-REFERENCE.md`](../reference/MODEL-REFERENCE.md).

Where these legacy documents conflict with `docs/`, **`docs/` wins**. Where a decision changed direction (e.g. product-first → platform-first), the rationale is recorded in [`docs/adr/`](../adr/).

## Contents
- `legacy-analysis/` — the original `AnalysisAndPlanning/` tree (Fable, Grok, Gemini) and the source ZIP.

This folder may be deleted at any time with no impact on the project; it is kept purely as a record of how the architecture was derived.

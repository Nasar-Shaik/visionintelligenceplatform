/**
 * Deterministic time + id sources for the E2E harness. The whole point of G-3.5 is a pipeline that
 * behaves identically on every run (replay + regression), so nothing may call `Date.now()` or
 * `crypto.randomUUID()`. Every service component in the harness is injected with these instead.
 *
 *  - `Clock` advances by a fixed step on each read, so `ingestedAt`/incident/notification timestamps
 *    are stable AND monotonically ordered across the run.
 *  - `uuidFactory` emits sequential, contract-valid v4-shaped UUIDs from a single shared counter, so
 *    ids are unique across every service (event, candidate, incident, notification) and reproducible.
 */

/** A monotonic, deterministic clock. Each `now()` returns a fresh Date `stepMs` after the previous. */
export class Clock {
  private t: number;
  constructor(
    startISO = '2026-07-30T00:00:00.000Z',
    private readonly stepMs = 1,
  ) {
    this.t = Date.parse(startISO);
  }
  /** Read-and-advance: the returned instant is consumed; the next read is `stepMs` later. */
  now = (): Date => {
    const d = new Date(this.t);
    this.t += this.stepMs;
    return d;
  };
  /** Peek without advancing (for capturedAt/window math). */
  peekISO(): string {
    return new Date(this.t).toISOString();
  }
}

/**
 * A single monotonic counter rendered as a valid UUID (`...-4xxx-8xxx-...`). Sharing one factory
 * across all services guarantees global uniqueness; the sequence is reproducible from a fresh factory,
 * which is what makes replay produce byte-identical ids.
 */
export function uuidFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    const hex = n.toString(16).padStart(12, '0'); // 12 hex digits → the node field
    return `00000000-0000-4000-8000-${hex}`;
  };
}

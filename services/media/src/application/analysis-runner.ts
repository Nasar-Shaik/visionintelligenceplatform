/**
 * Application: the **analysis runner** (P-8 Phase 8, slice 3) — what actually makes a queued session
 * run, in-process, inside the media service.
 *
 * ### ⭐ Why in-process, and why that is not a shortcut
 *
 * The frames have to reach `FrameSink`, which lives here and holds the assignment gate, the zone
 * plan and the event publisher. A separate worker process would need its own copy of all three —
 * which is the "second pipeline" this milestone exists to avoid. So the runner is a loop in the
 * service that already owns the frame path, and multi-worker execution stays available exactly as
 * slice 2 designed it: `workerId` identifies the process, the lease is in the record, and a second
 * media replica needs no code change.
 *
 * ### ⛔ Bounded concurrency, and why it is 1 by default
 *
 * L-41 measured this host at **two cameras at 2 fps**. Offline analysis competes for the same
 * runtime, so a second concurrent session does not halve the wall-clock time — it doubles the
 * latency of both and starves the live cameras that are recording a customer's premises right now.
 * One at a time is the honest default; the ceiling is configuration for a deployment that has
 * measured its own headroom.
 *
 * ### ⚠️ What this deliberately does not do
 *
 * It does not sweep for orphaned sessions across tenants. Every store operation requires a
 * `TenantScope` (Law 5) and this service has no way to enumerate tenants — inventing a cross-tenant
 * read to serve a background loop would put a hole in the isolation guarantee for the convenience of
 * a sweeper. A session orphaned by a restart is instead repaired **at read time**, tenant-scoped,
 * where a caller who is entitled to see it asks for it. See `AnalysisService.detail`.
 */
import { ANALYSIS_LIMITS } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import type { AnalysisWorker } from './analysis-worker.js';

export interface AnalysisRunnerDeps {
  worker: AnalysisWorker;
  /** ⛔ Sessions running at once. See the header for why the default is 1. */
  maxConcurrent?: number;
  /** Heartbeat period. Divides the lease with room for a missed beat. */
  heartbeatMs?: number;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

interface Pending {
  scope: TenantScope;
  sessionId: string;
}

export class AnalysisRunner {
  readonly #deps: AnalysisRunnerDeps;
  readonly #max: number;
  readonly #heartbeatMs: number;
  readonly #queue: Pending[] = [];
  readonly #heartbeats = new Map<string, NodeJS.Timeout>();
  #active = 0;
  #stopped = false;

  constructor(deps: AnalysisRunnerDeps) {
    this.#deps = deps;
    this.#max = Math.max(1, deps.maxConcurrent ?? 1);
    this.#heartbeatMs = deps.heartbeatMs ?? ANALYSIS_LIMITS.heartbeatSeconds * 1000;
  }

  /** Offer a queued session. ⚠️ Returns immediately — the caller is an HTTP request. */
  submit(scope: TenantScope, sessionId: string): void {
    if (this.#stopped) return;
    this.#queue.push({ scope, sessionId });
    void this.#drain();
  }

  /** Cancel a session running in this process. Returns whether it was here to cancel. */
  cancel(sessionId: string): boolean {
    /*
     * ⚠️ Queued-but-not-started is removed as well. A session cancelled before its turn must not
     * start thirty seconds later because the queue still held a reference to it.
     */
    const queuedAt = this.#queue.findIndex((p) => p.sessionId === sessionId);
    if (queuedAt >= 0) {
      this.#queue.splice(queuedAt, 1);
      return true;
    }
    return this.#deps.worker.cancelLocal(sessionId);
  }

  /** Sessions waiting and running, for the health view. */
  depth(): { queued: number; running: number } {
    return { queued: this.#queue.length, running: this.#active };
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#queue.length = 0;
    for (const timer of this.#heartbeats.values()) clearInterval(timer);
    this.#heartbeats.clear();
    /*
     * ⚠️ Running sessions are cancelled rather than waited for. A deploy must not be held open by a
     * four-hour analysis; the session checkpoints every chunk, so it resumes from where it stopped
     * rather than from the beginning — that is what the checkpoint is for.
     */
    for (const sessionId of [...this.#heartbeats.keys()]) this.#deps.worker.cancelLocal(sessionId);
  }

  async #drain(): Promise<void> {
    while (!this.#stopped && this.#active < this.#max) {
      const next = this.#queue.shift();
      if (next === undefined) return;
      this.#active += 1;
      void this.#run(next).finally(() => {
        this.#active -= 1;
        void this.#drain();
      });
    }
  }

  async #run(pending: Pending): Promise<void> {
    const { worker, onLog } = this.#deps;
    const { scope, sessionId } = pending;
    try {
      const session = await worker.sessionFor(scope, sessionId);
      if (session === null) return;
      const claimed = await worker.claim(scope, session);
      if (!claimed) {
        /* ⚠️ Ordinary under two replicas, not an error. Logging it as one makes the log useless. */
        onLog?.('info', 'analysis session claimed elsewhere', { sessionId });
        return;
      }

      /*
       * ⚠️ The heartbeat runs for as long as the session does, and it is what keeps the lease alive
       * across a chunk that takes longer than `leaseSeconds`. Without it a slow chunk would lose its
       * own lease and the session would be reclaimed while still being decoded.
       */
      const timer = setInterval(() => {
        void worker.heartbeat(scope, sessionId).then((held) => {
          if (!held) onLog?.('warn', 'analysis lease lost while running', { sessionId });
        });
      }, this.#heartbeatMs);
      this.#heartbeats.set(sessionId, timer);

      try {
        const outcome = await worker.runSession(scope, sessionId);
        onLog?.(outcome.state === 'succeeded' ? 'info' : 'warn', 'analysis session finished', {
          sessionId,
          state: outcome.state,
          frames: outcome.framesProcessed,
          chunks: outcome.chunksCompleted,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        });
      } finally {
        clearInterval(timer);
        this.#heartbeats.delete(sessionId);
      }
    } catch (err) {
      /*
       * ⛔ Never rethrown. This runs detached from any request, so an escaping rejection would be an
       * unhandled promise rejection and, under Node's default, would take the media service down —
       * stopping every camera's recording because one analysis failed.
       */
      onLog?.('error', 'analysis session crashed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

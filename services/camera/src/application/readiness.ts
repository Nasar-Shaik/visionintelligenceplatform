/**
 * Application: readiness model. A service is *live* as soon as the process is up, but *ready*
 * only when its dependencies (Mongo, …) are reachable. Adapters register a named check here;
 * `/ready` runs them, and overall status is `pass` only if every check passes. See docs/architecture/16.
 */

export type CheckStatus = 'pass' | 'fail';

export interface ReadinessCheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail?: string;
}

export interface ReadinessReport {
  readonly status: CheckStatus;
  readonly checks: readonly ReadinessCheckResult[];
}

/** An async probe for one dependency. Must resolve quickly and never throw for "not ready". */
export type ReadinessCheck = () => Promise<Omit<ReadinessCheckResult, 'name'>>;

export class ReadinessRegistry {
  readonly #checks = new Map<string, ReadinessCheck>();

  register(name: string, check: ReadinessCheck): void {
    this.#checks.set(name, check);
  }

  async run(): Promise<ReadinessReport> {
    const entries = [...this.#checks.entries()];
    const results = await Promise.all(
      entries.map(async ([name, check]): Promise<ReadinessCheckResult> => {
        try {
          const outcome = await check();
          return outcome.detail === undefined
            ? { name, status: outcome.status }
            : { name, status: outcome.status, detail: outcome.detail };
        } catch (err) {
          return {
            name,
            status: 'fail',
            detail: err instanceof Error ? err.message : 'check threw',
          };
        }
      }),
    );
    const status: CheckStatus = results.every((r) => r.status === 'pass') ? 'pass' : 'fail';
    return { status, checks: results };
  }
}

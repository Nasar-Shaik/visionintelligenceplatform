/**
 * Application: the stream-validation port (P-2).
 *
 * Same shape and same reasoning as `DiscoveryProvider` (ADR-0023): the AI runtime owns the decode
 * path, so it is the only component that can answer "does this camera actually stream?" — and the
 * camera service owns onboarding and lifecycle, so it asks through a port rather than reaching for
 * an HTTP client. The service, its tests and every consumer see `StreamProbe`.
 *
 * A deployment with no probe configured is supported, not broken: plenty of estates are onboarded
 * from a list of URLs long before the runtime is reachable. `UnavailableStreamProbe` reports that
 * explicitly, because "we cannot test connections here" and "this camera failed its test" must never
 * look the same — the first is a deployment gap, the second is a camera on a ladder somewhere.
 */
import type { StreamProbeResult } from '@vip/contracts';

export interface StreamProbeInput {
  protocol: 'rtsp' | 'rtmp';
  streamUrl: string;
  /** Plaintext, transiently. Resolved from the vault by the caller and never persisted here. */
  credentials?: { username: string; password: string };
  timeoutSeconds?: number;
  frames?: number;
  /** Declared capabilities, so the probe can report the codec it was told to expect. */
  capabilities?: unknown;
}

export interface StreamProbeOutcome {
  result?: StreamProbeResult;
  /** Set when no probe could be run at all — never when one ran and failed. */
  unavailable?: string;
}

export interface StreamProbe {
  probe(input: StreamProbeInput): Promise<StreamProbeOutcome>;
}

/** The default when no probe is configured. Honest about being absent. */
export class UnavailableStreamProbe implements StreamProbe {
  constructor(
    private readonly reason = 'stream validation is not configured for this deployment',
  ) {}

  async probe(): Promise<StreamProbeOutcome> {
    return { unavailable: this.reason };
  }
}

export interface HttpStreamProbeOptions {
  /** Base URL of the runtime exposing `POST /streams/validate`. */
  baseUrl: string;
  /** Shared internal key — this is a service-to-service call, never a user-facing one. */
  internalKey: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Calls the runtime's stream validation endpoint.
 *
 * **Every failure mode resolves to `unavailable`, never to a thrown error.** An installer pressing
 * "Test connection" gets an answer either way; a 502 from a service they have never heard of is not
 * one.
 */
export class HttpStreamProbe implements StreamProbe {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpStreamProbeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async probe(input: StreamProbeInput): Promise<StreamProbeOutcome> {
    const timeoutSeconds = input.timeoutSeconds ?? 8;
    // The probe window is the runtime's; this timeout is the transport's, and must be the longer of
    // the two or a successful test would be cancelled by its own caller.
    const budgetMs = this.options.requestTimeoutMs ?? timeoutSeconds * 1000 + 10_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}/streams/validate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-key': this.options.internalKey,
        },
        body: JSON.stringify({
          protocol: input.protocol,
          streamUrl: input.streamUrl,
          ...(input.credentials ? { credentials: input.credentials } : {}),
          timeoutSeconds,
          ...(input.frames !== undefined ? { frames: input.frames } : {}),
          ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return { unavailable: `the stream validator returned ${response.status}` };
      }
      const payload = (await response.json()) as { data?: StreamProbeResult };
      const data = payload.data;
      if (!data || typeof data.reachable !== 'boolean') {
        return { unavailable: 'malformed stream validation response' };
      }
      return { result: data };
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'AbortError'
          ? `stream validation timed out after ${Math.round(budgetMs / 1000)}s`
          : `the stream validator is unreachable${err instanceof Error ? `: ${err.message}` : ''}`;
      return { unavailable: reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

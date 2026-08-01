/**
 * Application: the network-discovery port (P-1).
 *
 * **Why this is a port and not an implementation.** ONVIF discovery is a WS-Discovery multicast probe
 * plus a SOAP negotiation, and the platform already has exactly one tested implementation of it —
 * `ai/inference/onvif.py`, built for the AI-5e certification harness. Re-implementing that protocol
 * here in TypeScript would give the platform two ONVIF stacks that drift, and the drift would surface
 * as a camera that onboards with one set of capabilities and streams with another.
 *
 * So the camera service **owns the onboarding workflow** — which is a device-management concern —
 * and treats discovery as a capability it calls. The port keeps that a detail: the service, its
 * tests, and every consumer see `DiscoveryProvider`, not an HTTP client. See ADR-0023.
 *
 * A deployment with no discovery provider configured is a supported state, not a broken one: plenty
 * of estates are onboarded from a spreadsheet of RTSP URLs. `UnavailableDiscoveryProvider` reports
 * that explicitly, because "discovery is not configured here" and "no cameras answered" must never
 * look the same to an installer — the first sends them to their settings, the second to their switch.
 */
import type { CameraCapabilities, CameraDeviceIdentity, CameraMetadata } from '@vip/contracts';

/** One device as the discovery provider reported it, before any tenant reconciliation. */
export interface DiscoveredDevice {
  endpoint: string;
  address?: string;
  metadata: CameraMetadata;
  capabilities: CameraCapabilities;
  suggestedStreamUrl?: string;
  registryId?: string;
  warning?: string;
  /** Stable device identity as the device reported it (P-2) — how it survives an address change. */
  identity?: CameraDeviceIdentity;
}

export interface DiscoveryProbe {
  devices: DiscoveredDevice[];
  probedSeconds: number;
  /** Set when discovery could not run at all — never when it ran and found nothing. */
  unavailable?: string;
}

export interface DiscoveryOptions {
  timeoutSeconds: number;
  /**
   * Negotiate this one device directly instead of broadcasting (P-2). A capability refresh is about
   * a specific camera, and re-scanning the whole segment to re-read one device's profiles is both
   * wasteful and wrong across a routed network, where multicast never arrives.
   */
  endpoint?: string;
}

export interface DiscoveryProvider {
  probe(options: DiscoveryOptions): Promise<DiscoveryProbe>;
}

/** The default when no provider is configured. Honest about being absent. */
export class UnavailableDiscoveryProvider implements DiscoveryProvider {
  constructor(
    private readonly reason = 'network discovery is not configured for this deployment',
  ) {}

  async probe(): Promise<DiscoveryProbe> {
    return { devices: [], probedSeconds: 0, unavailable: this.reason };
  }
}

export interface HttpDiscoveryProviderOptions {
  /** Base URL of the runtime exposing `POST /discovery/onvif`. */
  baseUrl: string;
  /** Shared internal key — this is a service-to-service call, never a user-facing one. */
  internalKey: string;
  /** Ceiling on the whole call, independent of the probe window the runtime is asked for. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Calls the runtime's read-only discovery endpoint.
 *
 * **Every failure mode resolves to `unavailable`, never to a thrown error.** An installer pressing
 * "Scan" gets an answer either way; a 502 from a service they have never heard of is not one. The
 * reason is carried through so the answer is actionable.
 */
export class HttpDiscoveryProvider implements DiscoveryProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpDiscoveryProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async probe({ timeoutSeconds, endpoint }: DiscoveryOptions): Promise<DiscoveryProbe> {
    // The probe window is the runtime's; this timeout is the transport's, and must be the longer of
    // the two or a successful scan would be cancelled by its own caller.
    const budgetMs = this.options.requestTimeoutMs ?? timeoutSeconds * 1000 + 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}/discovery/onvif`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-key': this.options.internalKey,
        },
        body: JSON.stringify({ timeoutSeconds, ...(endpoint ? { endpoint } : {}) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          devices: [],
          probedSeconds: 0,
          unavailable: `the discovery provider returned ${response.status}`,
        };
      }
      const payload = (await response.json()) as { data?: DiscoveryProbe };
      const data = payload.data;
      if (!data || !Array.isArray(data.devices)) {
        return { devices: [], probedSeconds: 0, unavailable: 'malformed discovery response' };
      }
      return data;
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'AbortError'
          ? `discovery timed out after ${Math.round(budgetMs / 1000)}s`
          : `the discovery provider is unreachable${err instanceof Error ? `: ${err.message}` : ''}`;
      return { devices: [], probedSeconds: 0, unavailable: reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

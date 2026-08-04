/**
 * Application: the channel transport seam. A `ChannelSender` turns a notification + its channel into
 * an actual delivery attempt and reports the outcome (never throws — a transport failure is a normal
 * `{ ok: false }`). Phase 1 ships two credential-free senders:
 *   - `in-app`  — the delivery log itself is the inbox; delivery is immediate/local.
 *   - `webhook` — HTTP POST the notification to a configured URL; 2xx = delivered.
 * Real email/SMS/push providers are integration-only and deferred (TECH-DEBT). Senders are injected
 * so the alert engine is testable without real HTTP.
 */
import type { Notification, NotificationChannel } from '@vip/contracts';

export interface DeliveryOutcome {
  ok: boolean;
  error?: string;
}

export interface ChannelSender {
  send(channel: NotificationChannel, notification: Notification): Promise<DeliveryOutcome>;
}

/** In-app: the record in the delivery log IS the delivery — always succeeds. */
export class InAppSender implements ChannelSender {
  async send(): Promise<DeliveryOutcome> {
    return { ok: true };
  }
}

/**
 * Why a delivery did not arrive, in words an operator can act on.
 *
 * ### ⚠️ "fetch failed" is not a reason
 *
 * `undici` reports every connection problem as the string `fetch failed` and puts the actual cause —
 * refused, no such host, timed out, TLS — one level down in `error.cause`. Measured against the
 * deployment, a webhook to a dead host recorded `fetch failed` and a webhook to a host that never
 * answered recorded `This operation was aborted`: two different faults needing two different people,
 * both rendered on the queue as noise.
 *
 * ⚠️ *"A failed delivery is visible in the console, **with the reason**"* is a release exit criterion
 * for 0.5, and a reason nobody can act on does not meet it. Same lesson as the gateway's readiness
 * probes in P-6.4, in a second place — which is why it is written down here too.
 */
function deliveryFailure(err: unknown, timedOut: boolean, timeoutMs: number): string {
  if (timedOut) return `no response within ${timeoutMs / 1000}s`;
  const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  switch (cause?.code) {
    case 'ECONNREFUSED':
      return 'connection refused by the endpoint';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'the endpoint’s host name could not be resolved';
    case 'ECONNRESET':
      return 'the endpoint closed the connection';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'the endpoint is unreachable from this network';
    case 'CERT_HAS_EXPIRED':
      return 'the endpoint’s TLS certificate has expired';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'the endpoint’s TLS certificate could not be verified';
    default:
      break;
  }
  /* Last resort: the cause's own message beats the wrapper's, and both beat "webhook request failed". */
  return cause?.message ?? (err instanceof Error ? err.message : 'webhook request failed');
}

/** Webhook: POST the notification JSON to the channel's URL; a 2xx is a delivery. */
export class WebhookSender implements ChannelSender {
  constructor(private readonly timeoutMs = 5_000) {}

  async send(channel: NotificationChannel, notification: Notification): Promise<DeliveryOutcome> {
    const url = channel.config['url'];
    if (typeof url !== 'string') return { ok: false, error: 'webhook channel missing url' };
    const headers = (channel.config['headers'] as Record<string, string> | undefined) ?? {};
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(notification),
        signal: controller.signal,
      });
      return res.ok
        ? { ok: true }
        : { ok: false, error: `the endpoint rejected it (HTTP ${res.status})` };
    } catch (err) {
      return { ok: false, error: deliveryFailure(err, timedOut, this.timeoutMs) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Maps a channel type to its sender. Unknown types fail closed (no silent drop). */
export class ChannelSenderRegistry {
  private readonly senders = new Map<string, ChannelSender>();

  register(type: string, sender: ChannelSender): this {
    this.senders.set(type, sender);
    return this;
  }

  senderFor(type: string): ChannelSender | undefined {
    return this.senders.get(type);
  }
}

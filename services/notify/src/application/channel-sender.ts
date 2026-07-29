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

/** Webhook: POST the notification JSON to the channel's URL; a 2xx is a delivery. */
export class WebhookSender implements ChannelSender {
  constructor(private readonly timeoutMs = 5_000) {}

  async send(channel: NotificationChannel, notification: Notification): Promise<DeliveryOutcome> {
    const url = channel.config['url'];
    if (typeof url !== 'string') return { ok: false, error: 'webhook channel missing url' };
    const headers = (channel.config['headers'] as Record<string, string> | undefined) ?? {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(notification),
        signal: controller.signal,
      });
      return res.ok ? { ok: true } : { ok: false, error: `webhook responded ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'webhook request failed' };
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

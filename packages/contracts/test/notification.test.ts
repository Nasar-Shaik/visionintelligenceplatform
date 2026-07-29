import { describe, expect, it } from 'vitest';
import {
  CreateChannelInput,
  Notification,
  NotificationStatus,
  WebhookChannelConfig,
} from '../src/notifications/notification.js';
import { EVENT_CATALOG } from '../src/events/catalog.js';

describe('CreateChannelInput', () => {
  it('applies defaults (enabled, empty config)', () => {
    const parsed = CreateChannelInput.parse({ name: 'ops inbox', type: 'in-app' });
    expect(parsed.enabled).toBe(true);
    expect(parsed.config).toEqual({});
  });

  it('accepts a webhook channel', () => {
    const parsed = CreateChannelInput.parse({
      name: 'siem',
      type: 'webhook',
      config: { url: 'https://example.test/hook' },
    });
    expect(parsed.type).toBe('webhook');
  });
});

describe('WebhookChannelConfig', () => {
  it('requires a valid url', () => {
    expect(() => WebhookChannelConfig.parse({ url: 'not-a-url' })).toThrow();
    expect(WebhookChannelConfig.parse({ url: 'https://x.test/h' }).url).toBe('https://x.test/h');
  });
});

describe('Notification', () => {
  it('parses a delivery record and defaults attempts to 0', () => {
    const parsed = Notification.parse({
      id: '44444444-4444-4444-8444-444444444444',
      tenantId: 'tnt_a',
      incidentId: '11111111-1111-4111-8111-111111111111',
      channelId: 'ch_1',
      channelType: 'in-app',
      status: 'pending',
      severity: 'critical',
      title: 'High-confidence person',
      correlationId: '33333333-3333-4333-8333-333333333333',
      causationId: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
    });
    expect(parsed.attempts).toBe(0);
  });

  it('enumerates the delivery states', () => {
    expect(NotificationStatus.options).toEqual(['pending', 'sent', 'delivered', 'failed', 'acked']);
  });
});

describe('notification catalog entries', () => {
  it('registers every notification event as a system event', () => {
    for (const type of [
      'notification.sent',
      'notification.delivered',
      'notification.failed',
      'notification.acked',
    ]) {
      const entry = EVENT_CATALOG.find((e) => e.type === type);
      expect(entry, type).toBeDefined();
      expect(entry?.category).toBe('system');
    }
  });
});

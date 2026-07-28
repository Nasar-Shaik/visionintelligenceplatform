import { describe, it, expect } from 'vitest';
import { InMemoryEventBus, JetStreamEventPublisher } from '../src/index.js';

describe('JetStreamEventPublisher', () => {
  it('publishes a domain event to t.{tenantId}.event.{type} with the payload intact', async () => {
    const bus = new InMemoryEventBus();
    const publisher = new JetStreamEventPublisher(bus);

    await publisher.publish({
      type: 'camera.registered',
      tenantId: 'tnt_a',
      payload: { cameraId: 'cam_1' },
    });

    expect(bus.published).toHaveLength(1);
    expect(bus.published[0]?.subject).toBe('t.tnt_a.event.camera.registered');
    expect((bus.published[0]?.data as { payload: unknown }).payload).toEqual({ cameraId: 'cam_1' });
  });

  it('uses the event id as the JetStream dedup id (retry does not double-publish)', async () => {
    const bus = new InMemoryEventBus();
    const publisher = new JetStreamEventPublisher(bus);
    const event = { type: 'tenant.created', tenantId: 'tnt_a', id: 'evt-1' } as const;
    await publisher.publish(event);
    await publisher.publish(event);
    expect(bus.published).toHaveLength(1);
  });

  it('refuses to publish for an unsafe tenant id (fail-closed)', async () => {
    const bus = new InMemoryEventBus();
    const publisher = new JetStreamEventPublisher(bus);
    await expect(
      publisher.publish({ type: 'tenant.created', tenantId: 'bad.tenant' }),
    ).rejects.toThrow();
    expect(bus.published).toHaveLength(0);
  });
});

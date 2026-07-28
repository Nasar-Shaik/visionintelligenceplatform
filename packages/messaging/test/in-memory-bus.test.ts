import { describe, it, expect } from 'vitest';
import {
  InMemoryEventBus,
  capabilityOutputSubject,
  eventSubject,
  ALL_CAPABILITY_OUTPUTS,
  CAPABILITY_OUTPUT_STREAM,
  type BusMessage,
} from '../src/index.js';

describe('InMemoryEventBus', () => {
  it('routes a published message to subscribers whose filter matches', async () => {
    const bus = new InMemoryEventBus();
    await bus.ensureStream(CAPABILITY_OUTPUT_STREAM, [ALL_CAPABILITY_OUTPUTS]);

    const seen: string[] = [];
    await bus.subscribe(
      {
        stream: CAPABILITY_OUTPUT_STREAM,
        durable: 'events',
        filterSubject: ALL_CAPABILITY_OUTPUTS,
      },
      (m: BusMessage) => {
        seen.push(m.json<{ tenantId: string }>().tenantId);
        m.ack();
      },
    );

    await bus.publish(capabilityOutputSubject('tnt_a', 'perception.person-detection'), {
      tenantId: 'tnt_a',
    });
    // different domain — must NOT match the capability-output filter
    await bus.publish(eventSubject('tnt_a', 'perception.person.detected'), { tenantId: 'tnt_a' });

    expect(seen).toEqual(['tnt_a']);
    expect(bus.delivered.map((d) => d.disposition)).toEqual(['ack']);
  });

  it('dedups publishes carrying the same msgId', async () => {
    const bus = new InMemoryEventBus();
    let count = 0;
    await bus.subscribe({ stream: 'S', durable: 'd', filterSubject: 't.*.event.>' }, (m) => {
      count++;
      m.ack();
    });
    const subject = eventSubject('tnt_a', 'perception.person.detected');
    await bus.publish(subject, { n: 1 }, { msgId: 'dup-1' });
    await bus.publish(subject, { n: 2 }, { msgId: 'dup-1' });
    expect(count).toBe(1);
    expect(bus.published).toHaveLength(1);
  });

  it('records term() as the dead-letter disposition', async () => {
    const bus = new InMemoryEventBus();
    await bus.subscribe({ stream: 'S', durable: 'd', filterSubject: 't.*.event.>' }, (m) => {
      m.term();
    });
    await bus.publish(eventSubject('tnt_a', 'perception.person.detected'), {});
    expect(bus.delivered[0]?.disposition).toBe('term');
  });
});

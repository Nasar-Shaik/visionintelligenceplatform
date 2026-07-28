import { describe, it, expect } from 'vitest';
import {
  MessagingError,
  assertTenantToken,
  capabilityOutputSubject,
  eventSubject,
  tenantIdFromSubject,
  subjectMatches,
  ALL_CAPABILITY_OUTPUTS,
  ALL_EVENTS,
} from '../src/index.js';

describe('subject taxonomy', () => {
  it('builds tenant-partitioned capability-output and event subjects', () => {
    expect(capabilityOutputSubject('tnt_a', 'perception.person-detection')).toBe(
      't.tnt_a.capability.output.perception.person-detection',
    );
    expect(eventSubject('tnt_a', 'perception.person.detected')).toBe(
      't.tnt_a.event.perception.person.detected',
    );
  });

  it('rejects unsafe tenant ids fail-closed (dot/wildcard/space break partitioning)', () => {
    for (const bad of ['tnt.a', 't*', 't>', 'a b', '', 'x/y']) {
      expect(() => assertTenantToken(bad)).toThrow(MessagingError);
    }
    expect(assertTenantToken('tnt_A-1')).toBe('tnt_A-1');
  });

  it('extracts the tenant token from a subject, undefined when not tenant-rooted', () => {
    expect(tenantIdFromSubject('t.tnt_a.event.perception.person.detected')).toBe('tnt_a');
    expect(tenantIdFromSubject('x.tnt_a.event.foo')).toBeUndefined();
    expect(tenantIdFromSubject('t')).toBeUndefined();
  });
});

describe('subjectMatches (NATS routing semantics)', () => {
  it('* matches exactly one token; > matches one or more trailing tokens', () => {
    const capSubject = 't.tnt_a.capability.output.perception.person-detection';
    expect(subjectMatches(ALL_CAPABILITY_OUTPUTS, capSubject)).toBe(true);
    expect(subjectMatches(ALL_EVENTS, 't.tnt_b.event.perception.person.detected')).toBe(true);

    // wrong tenant partition is still one token for `*`, but the domain segment must line up
    expect(subjectMatches('t.*.event.>', 't.tnt_a.capability.output.x')).toBe(false);
    // `*` does not span dots
    expect(subjectMatches('t.*.event.foo', 't.tnt_a.b.event.foo')).toBe(false);
    // `>` requires at least one trailing token
    expect(subjectMatches('t.*.event.>', 't.tnt_a.event')).toBe(false);
    expect(subjectMatches('t.tnt_a.event.x', 't.tnt_a.event.x')).toBe(true);
  });
});

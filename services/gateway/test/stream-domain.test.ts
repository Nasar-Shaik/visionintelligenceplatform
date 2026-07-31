/**
 * Pure stream-domain tests (P2-2 G-5): subject↔topic classification, priority derivation, and the
 * source/permission maps. No I/O — these are the rules the hub and transport both rely on.
 */
import { describe, expect, it } from 'vitest';
import {
  STREAM_SOURCES,
  TOPIC_PERMISSION,
  classifyPriority,
  sourcesForTopics,
  subjectToTopic,
  typeFromSubject,
} from '../src/domain/stream.js';

describe('subjectToTopic', () => {
  it('classifies incident lifecycle → incidents but drops internal candidates', () => {
    expect(subjectToTopic('t.tnt_a.incident.raised')).toBe('incidents');
    expect(subjectToTopic('t.tnt_a.incident.acknowledged')).toBe('incidents');
    expect(subjectToTopic('t.tnt_a.incident.candidate')).toBeUndefined();
  });
  it('classifies notifications → alerts', () => {
    expect(subjectToTopic('t.tnt_a.notification.sent')).toBe('alerts');
  });
  it('splits event.system.* → system from other events → events', () => {
    expect(subjectToTopic('t.tnt_a.event.system.camera.offline')).toBe('system');
    expect(subjectToTopic('t.tnt_a.event.perception.object.detected')).toBe('events');
  });
  it('returns undefined for non-streamable families (rule.matched, capability.output)', () => {
    expect(subjectToTopic('t.tnt_a.rule.matched')).toBeUndefined();
    expect(subjectToTopic('t.tnt_a.capability.output.person')).toBeUndefined();
  });
});

describe('typeFromSubject', () => {
  it('strips the t.{tenant}. prefix', () => {
    expect(typeFromSubject('t.tnt_a.incident.raised')).toBe('incident.raised');
    expect(typeFromSubject('t.tnt_a.event.system.camera.offline')).toBe(
      'event.system.camera.offline',
    );
  });
});

describe('classifyPriority', () => {
  it('elevates critical/high severity to high', () => {
    expect(classifyPriority('alerts', 'notification.sent', { severity: 'critical' })).toBe('high');
    expect(classifyPriority('incidents', 'incident.raised', { severity: 'high' })).toBe('high');
  });
  it('elevates safety/security categories and fire/weapon/camera-offline types to high', () => {
    expect(classifyPriority('events', 'event.safety.fire.detected', {})).toBe('high');
    expect(classifyPriority('events', 'event.x', { category: 'security' })).toBe('high');
    expect(classifyPriority('system', 'event.system.camera.offline', {})).toBe('high');
  });
  it('drops analytics/statistics to low', () => {
    expect(classifyPriority('events', 'event.analytics.people.count', {})).toBe('low');
    expect(classifyPriority('events', 'event.x', { category: 'analytics' })).toBe('low');
  });
  it('routine system status is low', () => {
    expect(classifyPriority('system', 'event.system.camera.online', {})).toBe('low');
  });
  it('defaults ordinary incidents/events to medium and never throws on odd payloads', () => {
    expect(classifyPriority('incidents', 'incident.raised', {})).toBe('medium');
    expect(classifyPriority('events', 'event.perception.object.detected', null)).toBe('medium');
    expect(classifyPriority('events', 'event.x', 'not-an-object')).toBe('medium');
  });
});

describe('sources + permissions', () => {
  it('needs only the EVENTS source for events/system (shared, never doubled)', () => {
    const keys = sourcesForTopics(['events', 'system']).map((s) => s.key);
    expect(keys).toEqual(['events']);
  });
  it('needs all three sources for the full topic set', () => {
    expect(
      sourcesForTopics(['incidents', 'alerts', 'events'])
        .map((s) => s.key)
        .sort(),
    ).toEqual(['alerts', 'events', 'incidents']);
    expect(STREAM_SOURCES).toHaveLength(3);
  });
  it('maps each topic to its read permission', () => {
    expect(TOPIC_PERMISSION).toEqual({
      incidents: 'incident:read',
      alerts: 'notification:read',
      events: 'event:read',
      system: 'camera:read',
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  RecordingSegment,
  StreamConnection,
  StreamState,
  StreamStatus,
} from '../src/media/media.js';
import { isKnownEventType } from '../src/events/catalog.js';

const now = '2026-07-28T00:00:00.000Z';

describe('StreamState', () => {
  it('enumerates the worker lifecycle', () => {
    expect(StreamState.options).toEqual(['idle', 'connecting', 'connected', 'lost', 'stopped']);
  });
});

describe('StreamStatus', () => {
  it('parses a valid status', () => {
    const s = StreamStatus.parse({
      cameraId: 'cam_1',
      tenantId: 'tnt_a',
      state: 'connected',
      since: now,
      recording: true,
      reconnectAttempts: 0,
      framesReceived: 42,
    });
    expect(s.state).toBe('connected');
    expect(s.lastError).toBeUndefined();
  });

  it('rejects negative counters', () => {
    expect(
      StreamStatus.safeParse({
        cameraId: 'cam_1',
        tenantId: 'tnt_a',
        state: 'connected',
        since: now,
        recording: false,
        reconnectAttempts: -1,
        framesReceived: 0,
      }).success,
    ).toBe(false);
  });
});

describe('RecordingSegment', () => {
  it('parses segment metadata (relative key)', () => {
    const seg = RecordingSegment.parse({
      cameraId: 'cam_1',
      tenantId: 'tnt_a',
      key: 'cam_1/recordings/seg-0001.mp4',
      startedAt: now,
      durationSeconds: 6,
      sizeBytes: 1024,
      contentType: 'video/mp4',
    });
    expect(seg.key).toContain('cam_1/recordings');
  });
});

describe('StreamConnection (internal DTO)', () => {
  it('carries protocol + url + optional credentials', () => {
    const c = StreamConnection.parse({
      cameraId: 'cam_1',
      protocol: 'rtsp',
      streamUrl: 'rtsp://cam/1',
      username: 'admin',
      password: 'pw',
    });
    expect(c.protocol).toBe('rtsp');
  });
});

describe('media event catalog', () => {
  it('registers the media lifecycle events', () => {
    for (const t of ['media.stream.connected', 'media.stream.lost', 'media.recording.segment']) {
      expect(isKnownEventType(t)).toBe(true);
    }
  });
});

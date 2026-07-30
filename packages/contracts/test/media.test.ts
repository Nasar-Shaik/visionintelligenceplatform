import { describe, expect, it } from 'vitest';
import {
  Clip,
  CreateClipInput,
  PlaybackTarget,
  Recording,
  RecordingQuery,
  RecordingSegment,
  StreamConnection,
  StreamHealthState,
  StreamHealthSummary,
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

describe('Recording (G-2)', () => {
  it('extends the segment with id/endedAt/createdAt', () => {
    const r = Recording.parse({
      id: 'rec_abc',
      cameraId: 'cam_1',
      tenantId: 'tnt_a',
      key: 'cam_1/recordings/seg-0001.mp4',
      startedAt: now,
      endedAt: '2026-07-28T00:00:06.000Z',
      durationSeconds: 6,
      sizeBytes: 1024,
      contentType: 'video/mp4',
      createdAt: now,
    });
    expect(r.id).toBe('rec_abc');
  });
});

describe('RecordingQuery (G-2)', () => {
  it('defaults limit to 50 and coerces a string limit', () => {
    expect(RecordingQuery.parse({}).limit).toBe(50);
    expect(RecordingQuery.parse({ limit: '25' }).limit).toBe(25);
  });
  it('caps limit at 200', () => {
    expect(RecordingQuery.safeParse({ limit: 500 }).success).toBe(false);
  });
});

describe('CreateClipInput (G-2)', () => {
  it('requires endedAt after startedAt', () => {
    expect(
      CreateClipInput.safeParse({ cameraId: 'cam_1', startedAt: now, endedAt: now }).success,
    ).toBe(false);
    expect(
      CreateClipInput.safeParse({
        cameraId: 'cam_1',
        startedAt: now,
        endedAt: '2026-07-28T00:00:10.000Z',
      }).success,
    ).toBe(true);
  });
});

describe('Clip (G-2)', () => {
  it('defaults segmentKeys to [] and key to null (pending)', () => {
    const c = Clip.parse({
      id: 'clip_1',
      tenantId: 'tnt_a',
      cameraId: 'cam_1',
      startedAt: now,
      endedAt: '2026-07-28T00:00:10.000Z',
      durationSeconds: 10,
      status: 'pending',
      createdBy: 'usr_1',
      createdAt: now,
      updatedAt: now,
    });
    expect(c.segmentKeys).toEqual([]);
    expect(c.key).toBeNull();
  });
});

describe('PlaybackTarget (G-2)', () => {
  it('requires a positive TTL', () => {
    expect(
      PlaybackTarget.safeParse({ key: 'k', url: 'https://s/k', expiresInSeconds: 0 }).success,
    ).toBe(false);
  });
});

describe('StreamHealth (G-2)', () => {
  it('enumerates health states', () => {
    expect(StreamHealthState.options).toEqual(['healthy', 'degraded', 'down', 'unknown']);
  });
  it('parses an aggregate summary', () => {
    const s = StreamHealthSummary.parse({
      tenantId: 'tnt_a',
      total: 0,
      healthy: 0,
      degraded: 0,
      down: 0,
      streams: [],
    });
    expect(s.total).toBe(0);
  });
});

describe('media event catalog', () => {
  it('registers the media lifecycle events', () => {
    for (const t of ['media.stream.connected', 'media.stream.lost', 'media.recording.segment']) {
      expect(isKnownEventType(t)).toBe(true);
    }
  });
});

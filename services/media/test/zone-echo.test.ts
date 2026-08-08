/**
 * The zone membership echo (P-11 slice 2.3, ADR-0053) — media's half of the join.
 *
 * Slice 2.2 shipped the zone primitives and measured them never running: a polygon test needs the
 * boxes inference produces, so membership is resolved *after* `/infer` answers. This carries it back
 * on the next request for the same camera, where the runtime attaches it to the movement path it
 * already holds.
 *
 * ⛔ **The three things that would break it silently**, each asserted below:
 *
 * 1. sending an echo that names the frame CARRYING it rather than the frame it DESCRIBES;
 * 2. suppressing the empty echo, which makes "nobody was in a zone" identical to "the membership
 *    never arrived" — and every duration computed across that gap a lower bound nothing labelled;
 * 3. holding an echo across a released assignment, delivering it into whatever stream that camera
 *    starts next, against identities that no longer exist.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rectanglePoints, type PlanZone } from '@vip/contracts';
import { HttpFrameSink } from '../src/adapters/http-frame-sink.js';
import { AssignmentGate } from '../src/application/assignment-gate.js';
import { membershipEcho } from '../src/application/zone-resolver.js';

const TENANT = 'tnt_a';
const CAMERA = 'cam1';

const till: PlanZone = {
  zoneId: 'zn-till',
  name: 'Till',
  kind: 'area',
  points: rectanglePoints(0.2, 0.5, 0.6, 0.4),
  version: 1,
};

const frame = (seq: number) => ({
  seq,
  at: new Date('2026-08-09T10:00:00.000Z'),
  data: new Uint8Array([0xff, 0xd8, seq & 0xff]),
});

/** A standing person with feet inside the till zone, carrying an identity the tracker assigned. */
const inside = (identityId: string) => ({
  bbox: [0.45, 0.4, 0.1, 0.3],
  identityId,
  attributes: {},
});
const outside = (identityId: string) => ({
  bbox: [0.9, 0.05, 0.1, 0.3],
  identityId,
  attributes: {},
});

function gateFor(zones: PlanZone[], zoneVersion: number): AssignmentGate {
  const gate = new AssignmentGate();
  gate.applyPlan({
    version: 1,
    generatedAt: '2026-08-09T10:00:00.000Z',
    entries: [
      {
        tenantId: TENANT,
        cameraId: CAMERA,
        intent: 'process',
        capabilityId: 'perception.person-detection',
        profileId: 'person-tracking',
        runtimeId: 'rt1',
        runtimeUrl: 'http://rt1:8085',
        targetFps: null,
        assignmentVersion: 1,
        sessionEpoch: 1,
        zones,
        zoneVersion,
      },
    ],
    runtimes: [],
  });
  return gate;
}

/** A runtime that answers with the detections it is told to, so zones resolve against real boxes. */
function runtimeAnswering(detections: unknown[]): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { frame: Record<string, unknown> };
    sent.push(body.frame);
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({ success: true, data: { detections: JSON.parse(JSON.stringify(detections)) } }),
        ),
    });
  });
}

let sent: Record<string, unknown>[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  sent = [];
});

async function settle(sink: HttpFrameSink, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    const st = sink.stats();
    if (st.queueDepth === 0 && st.inflight === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('membershipEcho — what goes back to the runtime', () => {
  it('names the frame it describes, keyed by identity', () => {
    const echo = membershipEcho(
      [{ identityId: 'idn_1', attributes: { zoneIds: ['zn-till'] } }],
      41,
      7,
    );
    expect(echo).toEqual({
      frameSeq: 41,
      zoneVersion: 7,
      subjects: [{ identityId: 'idn_1', zoneIds: ['zn-till'] }],
    });
  });

  /**
   * ⛔ The load-bearing case. An echo with no subjects says "this whole frame was decided and nobody
   * was inside a zone". Suppressing it makes that indistinguishable from a membership that never
   * arrived, and the runtime then holds the frame undecided for ever — which ends a zone visit that
   * never ended.
   */
  it('returns an empty decision rather than nothing when no subject was inside a zone', () => {
    const echo = membershipEcho([{ identityId: 'idn_1', attributes: {} }], 41, 7);
    expect(echo).toEqual({ frameSeq: 41, zoneVersion: 7, subjects: [] });
  });

  /** ⚠️ `identityId`, never `trackingId` — a membership keyed by track id would split one person's
   * dwell in two the first time they walked behind a display (ADR-0038, ADR-0041). */
  it('skips a detection the tracker gave no identity', () => {
    const echo = membershipEcho([{ attributes: { zoneIds: ['zn-till'] } }], 1, 0);
    expect(echo.subjects).toEqual([]);
  });

  it('is bounded, because a frame with more identities than the cap has a perception problem', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      identityId: `idn_${String(i)}`,
      attributes: { zoneIds: ['zn-till'] },
    }));
    expect(membershipEcho(many, 1, 0).subjects).toHaveLength(64);
  });
});

describe('HttpFrameSink — carrying the echo back', () => {
  it('sends nothing on the first frame and the previous frame’s membership on the next', async () => {
    vi.stubGlobal('fetch', runtimeAnswering([inside('idn_1')]));
    const sink = new HttpFrameSink({
      url: 'http://rt1:8085',
      internalKey: 'k'.repeat(16),
      capabilityId: 'perception.person-detection',
      maxInflight: 1,
      gate: gateFor([till], 4),
    });

    sink.push(TENANT, CAMERA, frame(10));
    await settle(sink);
    sink.push(TENANT, CAMERA, frame(11));
    await settle(sink);

    expect(sent[0]?.zoneMembership).toBeUndefined();
    expect(sent[1]?.zoneMembership).toEqual({
      // ⛔ 10, not 11: the frame the membership DESCRIBES, not the one carrying it.
      frameSeq: 10,
      zoneVersion: 4,
      subjects: [{ identityId: 'idn_1', zoneIds: ['zn-till'] }],
    });
  });

  it('sends an empty decision for a frame where nobody was inside a zone', async () => {
    vi.stubGlobal('fetch', runtimeAnswering([outside('idn_1')]));
    const sink = new HttpFrameSink({
      url: 'http://rt1:8085',
      internalKey: 'k'.repeat(16),
      capabilityId: 'perception.person-detection',
      maxInflight: 1,
      gate: gateFor([till], 4),
    });

    sink.push(TENANT, CAMERA, frame(1));
    await settle(sink);
    sink.push(TENANT, CAMERA, frame(2));
    await settle(sink);

    expect(sent[1]?.zoneMembership).toEqual({ frameSeq: 1, zoneVersion: 4, subjects: [] });
  });

  /** ⚠️ No zones configured ⇒ nothing is resolved and nothing is echoed. A deployment that draws no
   * zones must cost nothing at all on the frame path. */
  it('sends no echo at all when the camera has no zones', async () => {
    vi.stubGlobal('fetch', runtimeAnswering([inside('idn_1')]));
    const sink = new HttpFrameSink({
      url: 'http://rt1:8085',
      internalKey: 'k'.repeat(16),
      capabilityId: 'perception.person-detection',
      maxInflight: 1,
      gate: gateFor([], 0),
    });

    sink.push(TENANT, CAMERA, frame(1));
    await settle(sink);
    sink.push(TENANT, CAMERA, frame(2));
    await settle(sink);

    expect(sent.every((f) => f.zoneMembership === undefined)).toBe(true);
    expect(sink.zoneStats().zoneEchoesSent).toBe(0);
  });

  /**
   * ⛔ An echo held across a released assignment would be delivered into whatever stream that camera
   * starts next — describing a frame from a run that has ended, against identities that no longer
   * exist. It goes with the queue.
   */
  it('drops the pending echo when the camera is released', async () => {
    vi.stubGlobal('fetch', runtimeAnswering([inside('idn_1')]));
    const sink = new HttpFrameSink({
      url: 'http://rt1:8085',
      internalKey: 'k'.repeat(16),
      capabilityId: 'perception.person-detection',
      maxInflight: 1,
      gate: gateFor([till], 4),
    });

    sink.push(TENANT, CAMERA, frame(1));
    await settle(sink);
    sink.release(TENANT, CAMERA);
    sink.push(TENANT, CAMERA, frame(2));
    await settle(sink);

    expect(sent[1]?.zoneMembership).toBeUndefined();
  });

  /**
   * ⛔ The reading that says zones are resolving and the behaviour layer is not hearing about it —
   * exactly the state slice 2.2 shipped while every dashboard looked healthy.
   */
  it('reports what it echoed beside what it resolved', async () => {
    vi.stubGlobal('fetch', runtimeAnswering([inside('idn_1')]));
    const sink = new HttpFrameSink({
      url: 'http://rt1:8085',
      internalKey: 'k'.repeat(16),
      capabilityId: 'perception.person-detection',
      maxInflight: 1,
      gate: gateFor([till], 4),
    });

    for (let seq = 1; seq <= 3; seq += 1) {
      sink.push(TENANT, CAMERA, frame(seq));
      await settle(sink);
    }

    const stats = sink.zoneStats();
    expect(stats.insideDetections).toBeGreaterThan(0);
    expect(stats.zoneEchoesSent).toBe(2);
    /* Nothing was replaced before it could be sent — every frame was awaited. */
    expect(stats.zoneEchoesDropped).toBe(0);
  });
});

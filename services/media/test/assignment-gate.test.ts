/**
 * The **enforcement point** (P-8 Phase 6), driven with fakes: no camera, no runtime, no control
 * plane, no timers. Every assertion is deterministic.
 *
 * ### The tests to be most suspicious of anyone "fixing"
 *
 * - **recording is untouched when AI is switched off.** The whole milestone rests on it, and it is
 *   asserted through the supervisor rather than by reading the gate's code.
 * - **absence from the plan releases the camera.** The failure mode of this system must be "AI
 *   stopped", never "AI kept running on a camera nobody authorised".
 * - **a changed session epoch releases publisher state.** This is the P-8 Phase 5 defect — a
 *   re-enabled camera whose stale ordering gate silently swallowed every event.
 * - **one camera's change does not disturb another's.** Hot assignment, asserted on the counters of
 *   the cameras that were *not* touched.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AssignmentPlan, AssignmentPlanEntry } from '@vip/contracts';
import { AssignmentGate } from '../src/application/assignment-gate.js';
import { HttpFrameSink } from '../src/adapters/http-frame-sink.js';
import { StreamSupervisor } from '../src/application/stream-supervisor.js';
import type {
  CameraSource,
  Decoder,
  DecoderCallbacks,
  DecoderSession,
  Frame,
} from '../src/application/ports.js';

const TENANT = 'tnt_a';
const PERSON = 'perception.person-detection';

function entry(cameraId: string, over: Partial<AssignmentPlanEntry> = {}): AssignmentPlanEntry {
  return {
    tenantId: TENANT,
    cameraId,
    intent: 'process',
    capabilityId: PERSON,
    profileId: 'person-tracking',
    runtimeId: 'rt1',
    runtimeUrl: 'http://rt1:8085',
    targetFps: null,
    assignmentVersion: 1,
    sessionEpoch: 1,
    ...over,
  };
}

function plan(
  version: number,
  entries: AssignmentPlanEntry[],
  runtimes: { runtimeId: string; url: string }[] = [],
): AssignmentPlan {
  return { version, generatedAt: '2026-08-06T10:00:00.000Z', entries, runtimes };
}

const frame = (seq: number): Frame => ({
  seq,
  at: new Date('2026-08-06T10:00:00.000Z'),
  data: new Uint8Array([1, 2, 3]),
});

describe('P-8.6 · the assignment gate', () => {
  it('delivers only what the plan authorises, and names where it goes', () => {
    const gate = new AssignmentGate();
    gate.applyPlan(plan(1, [entry('cam1')]));

    expect(gate.decide(TENANT, 'cam1')).toEqual({
      deliver: true,
      runtimeUrl: 'http://rt1:8085',
      capabilityId: PERSON,
      runtimeId: 'rt1',
      profileId: 'person-tracking',
    });
    expect(gate.decide(TENANT, 'cam2')).toEqual({ deliver: false, reason: 'unassigned' });
    expect(gate.decide('tnt_b', 'cam1')).toEqual({ deliver: false, reason: 'unassigned' });
  });

  it('distinguishes a paused camera from an unassigned one', () => {
    const gate = new AssignmentGate();
    gate.applyPlan(plan(1, [entry('cam1', { intent: 'hold' })]));
    expect(gate.decide(TENANT, 'cam1')).toEqual({ deliver: false, reason: 'held' });
  });

  it('⚠️ releases a camera that vanishes from the plan — absence IS the stop signal', () => {
    const gate = new AssignmentGate();
    gate.applyPlan(plan(1, [entry('cam1'), entry('cam2')]));
    const { release } = gate.applyPlan(plan(2, [entry('cam2')]));
    expect(release).toEqual([{ tenantId: TENANT, cameraId: 'cam1' }]);
    expect(gate.decide(TENANT, 'cam1').deliver).toBe(false);
    expect(gate.decide(TENANT, 'cam2').deliver).toBe(true);
  });

  it('releases a camera the plan explicitly marks for release, and confirms it once', () => {
    const gate = new AssignmentGate();
    gate.applyPlan(plan(1, [entry('cam1')]));
    const { release } = gate.applyPlan(plan(2, [entry('cam1', { intent: 'release' })]));
    expect(release).toEqual([{ tenantId: TENANT, cameraId: 'cam1' }]);
    const observations = gate.observations(Date.now());
    expect(observations).toEqual([
      { tenantId: TENANT, cameraId: 'cam1', state: 'released', runtimeId: null },
    ]);
    /* ⚠️ Reported once. A `released` repeated every cycle would keep re-confirming a stop. */
    expect(gate.observations(Date.now())).toEqual([]);
  });

  it('⚠️ releases when the SESSION EPOCH moves — the P-8 Phase 5 defect', () => {
    const gate = new AssignmentGate();
    gate.applyPlan(plan(1, [entry('cam1', { sessionEpoch: 1 })]));
    const same = gate.applyPlan(plan(2, [entry('cam1', { sessionEpoch: 1 })]));
    expect(same.release).toEqual([]);

    const restarted = gate.applyPlan(plan(3, [entry('cam1', { sessionEpoch: 2 })]));
    expect(restarted.release).toEqual([{ tenantId: TENANT, cameraId: 'cam1' }]);
    /* ⚠️ Still delivering afterwards — a restart releases state, it does not stop the camera. */
    expect(gate.decide(TENANT, 'cam1').deliver).toBe(true);
  });

  it('⚠️ a hot profile change does NOT release, and does not touch other cameras', () => {
    const gate = new AssignmentGate();
    gate.applyPlan(plan(1, [entry('cam1'), entry('cam2')]));
    const hot = gate.applyPlan(
      plan(2, [
        entry('cam1', { capabilityId: 'perception.queue-analytics', assignmentVersion: 2 }),
        entry('cam2'),
      ]),
    );
    expect(hot.release).toEqual([]);
    expect(hot.changed).toBe(true);
    const cam1 = gate.decide(TENANT, 'cam1');
    expect(cam1.deliver && cam1.capabilityId).toBe('perception.queue-analytics');
    const cam2 = gate.decide(TENANT, 'cam2');
    expect(cam2.deliver && cam2.capabilityId).toBe(PERSON);
  });

  it('reports active, idle and paused distinctly, and resets the window each time', () => {
    const gate = new AssignmentGate();
    gate.applyPlan(plan(1, [entry('cam1'), entry('cam2'), entry('cam3', { intent: 'hold' })]));
    gate.delivered(TENANT, 'cam1');

    const first = gate.observations(Date.now());
    expect(first.find((o) => o.cameraId === 'cam1')?.state).toBe('active');
    /* ⚠️ `idle`, not `failed`: cam2 is assigned and no frames are arriving — the STREAM is down. */
    expect(first.find((o) => o.cameraId === 'cam2')?.state).toBe('idle');
    expect(first.find((o) => o.cameraId === 'cam3')?.state).toBe('paused');

    const second = gate.observations(Date.now());
    expect(second.find((o) => o.cameraId === 'cam1')?.state).toBe('idle');
  });

  it('reports failed only inside the failure window', () => {
    const gate = new AssignmentGate();
    gate.applyPlan(plan(1, [entry('cam1')]));
    gate.failed(TENANT, 'cam1', 'connect ECONNREFUSED', 1_000);
    expect(gate.observations(1_500)[0]).toMatchObject({
      state: 'failed',
      detail: 'connect ECONNREFUSED',
    });
    gate.delivered(TENANT, 'cam1');
    expect(gate.observations(1_000_000)[0]?.state).toBe('active');
  });

  it('⚠️ plan version is null before the first plan — never 0, which is a real version', () => {
    const gate = new AssignmentGate();
    expect(gate.planVersion).toBeNull();
    gate.applyPlan(plan(0, []));
    expect(gate.planVersion).toBe(0);
  });

  it('deduplicates the runtimes it asks the health poller to probe', () => {
    const gate = new AssignmentGate();
    gate.applyPlan(
      plan(1, [
        entry('cam1', { runtimeId: 'rt1', runtimeUrl: 'http://rt1:8085' }),
        entry('cam2', { runtimeId: 'rt1', runtimeUrl: 'http://rt1:8085' }),
        entry('cam3', { runtimeId: 'rt2', runtimeUrl: 'http://rt2:8085' }),
      ]),
    );
    expect(gate.runtimes()).toEqual([
      { runtimeId: 'rt1', url: 'http://rt1:8085' },
      { runtimeId: 'rt2', url: 'http://rt2:8085' },
    ]);
  });

  /**
   * ⚠️ **The deployment found this; no unit test could have.**
   *
   * The first version derived the probe list from the plan's ENTRIES, so a registered runtime with
   * no cameras on it was never health-checked. Placement uses runtime health and profile support
   * comes from the capabilities a runtime advertises — so a fresh deployment showed `unknown` and
   * `supported: null` for ever, and the very first assignment had to be made blind. Every unit test
   * assigned a camera first, which is exactly why they all passed.
   */
  it('⚠️ probes a REGISTERED runtime with no cameras on it', () => {
    const gate = new AssignmentGate();
    gate.applyPlan(plan(1, [], [{ runtimeId: 'rt-idle', url: 'http://rt-idle:8085' }]));
    expect(gate.runtimes()).toEqual([{ runtimeId: 'rt-idle', url: 'http://rt-idle:8085' }]);
  });

  it('degrades to the entry-derived list when a control plane sends no runtime registry', () => {
    const gate = new AssignmentGate();
    const legacy = {
      version: 1,
      generatedAt: '2026-08-06T10:00:00.000Z',
      entries: [entry('cam1')],
    };
    gate.applyPlan(legacy as AssignmentPlan);
    expect(gate.runtimes()).toEqual([{ runtimeId: 'rt1', url: 'http://rt1:8085' }]);
  });
});

describe('P-8.6 · the frame sink under a gate', () => {
  const sinkWith = (gate?: AssignmentGate): HttpFrameSink =>
    new HttpFrameSink({
      url: 'http://default:8085',
      internalKey: 'k',
      capabilityId: PERSON,
      queuePerCamera: 4,
      ...(gate === undefined ? {} : { gate }),
    });

  it('⚠️ skipping an unassigned camera is its own counter, not a drop', () => {
    const gate = new AssignmentGate();
    gate.applyPlan(plan(1, [entry('cam1')]));
    const sink = sinkWith(gate);

    sink.push(TENANT, 'cam2', frame(1));
    sink.push(TENANT, 'cam2', frame(2));
    const stats = sink.stats();
    expect(stats.assignmentEnabled).toBe(true);
    expect(stats.skippedUnassigned).toBe(2);
    expect(stats.droppedQueueFull).toBe(0);
    expect(stats.offered).toBe(2);
  });

  it('counts a paused camera separately from an unassigned one', () => {
    const gate = new AssignmentGate();
    gate.applyPlan(plan(1, [entry('cam1', { intent: 'hold' })]));
    const sink = sinkWith(gate);
    sink.push(TENANT, 'cam1', frame(1));
    expect(sink.stats().skippedHeld).toBe(1);
    expect(sink.stats().skippedUnassigned).toBe(0);
  });

  it('⚠️ with NO gate every camera is analysed — an upgrade must not switch AI off', () => {
    const sink = sinkWith();
    sink.push(TENANT, 'cam-nobody-assigned', frame(1));
    const stats = sink.stats();
    expect(stats.assignmentEnabled).toBe(false);
    expect(stats.skippedUnassigned).toBe(0);
    expect(stats.queueDepth + stats.inflight).toBeGreaterThan(0);
  });

  it('exposes per-camera measurements, with null where nothing has been measured', () => {
    const gate = new AssignmentGate();
    gate.applyPlan(plan(1, [entry('cam1')]));
    const sink = sinkWith(gate);
    sink.push(TENANT, 'cam1', frame(1));
    const per = sink.cameraStats(TENANT, 'cam1');
    expect(per?.offered).toBe(1);
    /* ⚠️ Nothing has completed a round trip, so these are null rather than 0. */
    expect(per?.deliverMsAvg).toBeNull();
    expect(per?.fps).toBeNull();
    expect(sink.cameras(TENANT)).toEqual(['cam1']);
    expect(sink.cameras('tnt_b')).toEqual([]);
  });

  it('release() drops the queue without erasing the lifetime counters', () => {
    const gate = new AssignmentGate();
    gate.applyPlan(plan(1, [entry('cam1')]));
    const sink = sinkWith(gate);
    sink.push(TENANT, 'cam1', frame(1));
    sink.release(TENANT, 'cam1');
    const per = sink.cameraStats(TENANT, 'cam1');
    expect(per?.queueDepth).toBe(0);
    expect(per?.offered).toBe(1);
  });
});

/**
 * ⚠️ **The milestone's central invariant, asserted end to end.**
 *
 * Recording is driven by the decoder's `onSegment`; perception by `onFrame`. This drives a real
 * `StreamSupervisor` with a fake decoder and shows that a camera the gate refuses still produces
 * every segment — not by reading the gate's code, but by counting what the storage adapter received.
 */
describe('P-8.6 · recording is independent of assignment', () => {
  class FakeDecoder implements Decoder {
    cb: DecoderCallbacks | undefined;
    open(_conn: unknown, _opts: unknown, cb: DecoderCallbacks): DecoderSession {
      this.cb = cb;
      queueMicrotask(() => cb.onConnected());
      return { stop: async () => {} };
    }
  }

  const source: CameraSource = {
    resolve: async () =>
      ({ cameraId: 'cam1', protocol: 'rtsp', url: 'rtsp://x', options: {} }) as never,
  };

  it('⚠️ writes every segment for a camera the gate refuses to analyse', async () => {
    const decoder = new FakeDecoder();
    const put = vi.fn(async () => {});
    const gate = new AssignmentGate();
    /* cam1 is deliberately NOT in the plan — AI is off for it. */
    gate.applyPlan(plan(1, []));
    const sink = new HttpFrameSink({
      url: 'http://default:8085',
      internalKey: 'k',
      capabilityId: PERSON,
      gate,
    });

    const supervisor = new StreamSupervisor({
      cameraSource: source,
      decoder,
      objectStore: { put, get: async () => null, ping: async () => {} } as never,
      frameSink: sink,
      clock: { now: () => new Date('2026-08-06T10:00:00.000Z') },
      options: { frameRate: 2, segmentSeconds: 6 },
    });
    supervisor.start(TENANT, 'cam1');
    await new Promise((r) => setTimeout(r, 5));

    for (let seq = 1; seq <= 5; seq += 1) decoder.cb?.onFrame(frame(seq));
    for (let n = 0; n < 3; n += 1) {
      await decoder.cb?.onSegment({
        body: new Uint8Array([1]),
        startedAt: new Date('2026-08-06T10:00:00.000Z'),
        durationSeconds: 6,
        contentType: 'video/mp4',
      });
    }

    /* ⚠️ Every segment was written… */
    expect(put).toHaveBeenCalledTimes(3);
    /* …and not one frame reached perception. */
    expect(sink.stats().skippedUnassigned).toBe(5);
    expect(sink.stats().delivered).toBe(0);
    expect(supervisor.status(TENANT, 'cam1').recording).toBe(true);
  });
});

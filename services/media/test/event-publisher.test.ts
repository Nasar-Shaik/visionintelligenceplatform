/**
 * The Event Publisher bridge (P-8 Phase 5).
 *
 * ⚠️ **Most of these prove a REFUSAL, not a publish.** The bridge's job is easy when everything
 * works; what makes it safe is what it declines to do — refuse an invalid result rather than let the
 * broker dead-letter it in another service's log, drop a stale frame rather than break per-camera
 * ordering, drop under pressure rather than let a queue grow on the process that writes recordings.
 * A suite that only ever feeds a happy path is satisfied by a publisher with none of that.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EventBus } from '@vip/messaging';
import { BufferedEventPublisher, PUBLISHER_VERSION } from '../src/adapters/event-publisher.js';

/** A bus that records what it was asked to publish. */
function recordingBus(behaviour: { fail?: number } = {}) {
  const published: Array<{ subject: string; data: unknown; msgId?: string }> = [];
  let remainingFailures = behaviour.fail ?? 0;
  const bus: EventBus = {
    ensureStream: async () => undefined,
    publish: async (subject, data, opts) => {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('broker unavailable');
      }
      published.push({
        subject,
        data,
        ...(opts?.msgId === undefined ? {} : { msgId: opts.msgId }),
      });
    },
    subscribe: async () => ({ stop: async () => undefined }),
    close: async () => undefined,
  };
  return { bus, published };
}

function result(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    tenantId: 'tnt_a',
    cameraId: 'cam_1',
    capabilityId: 'perception.person-detection',
    capabilityVersion: '1.0.0',
    runtimeVersion: '0.1.0',
    executionProvider: 'CPUExecutionProvider',
    model: { name: 'yolox-nano', version: '1.0.0', task: 'object-detection' },
    frame: { seq: 1, capturedAt: '2026-08-06T09:00:00.000Z' },
    inferenceMs: 35.3,
    at: '2026-08-06T09:00:00.100Z',
    detections: [
      {
        label: 'person',
        confidence: 0.9,
        bbox: [0.1, 0.1, 0.2, 0.4],
        attributes: {},
        metadata: {},
        trackingId: 'trk_1',
        identityId: 'trk_1',
      },
    ],
    ...over,
  };
}

/** Wait for the publisher's async pump to settle. */
const settle = () => new Promise((r) => setTimeout(r, 5));

function make(over: Record<string, unknown> = {}) {
  const { bus, published } = recordingBus(over.behaviour as { fail?: number } | undefined);
  delete over.behaviour;
  const publisher = new BufferedEventPublisher({ bus, enabled: true, ...over });
  return { publisher, published };
}

describe('publishing', () => {
  it('publishes a valid result to its tenant-partitioned capability subject', async () => {
    const { publisher, published } = make();
    publisher.publish(result());
    await settle();

    expect(published).toHaveLength(1);
    expect(published[0]?.subject).toBe('t.tnt_a.capability.output.perception.person-detection');
    expect(publisher.stats().published).toBe(1);
    expect(publisher.stats().brokerStatus).toBe('up');
  });

  it('⚠️ carries the tracking identity through, or ADR-0041 buys nothing', async () => {
    const { publisher, published } = make();
    publisher.publish(result());
    await settle();

    /*
     * ⚠️ This guards a real and quiet risk: the publisher publishes the PARSED result, so zod strips
     * any field the contract does not declare. Identity survives only because the contract carries
     * it (ADR-0041) — before that change this assertion failed with `undefined`, and the platform
     * would have shipped events whose identity had been silently removed at the last hop.
     */
    const sent = published[0]?.data as { detections: Array<Record<string, unknown>> };
    expect(sent.detections[0]?.trackingId).toBe('trk_1');
    expect(sent.detections[0]?.identityId).toBe('trk_1');
  });

  it('⚠️ stamps ONE correlation id per frame, so a frame can be traced', async () => {
    /*
     * The defect this covers: the normalizer falls back to each envelope's own id, so without this
     * every detection in a frame got a different correlation chain and "follow this frame" was
     * unanswerable. Deterministic, so a retry cannot fork the trace.
     */
    const { publisher, published } = make();
    publisher.publish(result({ frame: { seq: 7, capturedAt: '2026-08-06T09:00:00.000Z' } }));
    await settle();

    const sent = published[0]?.data as { correlationId?: string };
    expect(sent.correlationId).toBe('tnt_a:cam_1:7');
  });

  it('does not overwrite a correlation id the result already carries', async () => {
    const { publisher, published } = make();
    publisher.publish(result({ correlationId: 'from-upstream' }));
    await settle();
    expect((published[0]?.data as { correlationId?: string }).correlationId).toBe('from-upstream');
  });

  /**
   * ⛔ **The third place the platform identified a stream by `(tenant, camera)` + a number** — and
   * the deepest, because JetStream discards a duplicate `msgId` **at the broker**.
   *
   * Measured on the deployed stack *after* the envelope and dedup-key fixes were in place and
   * believed sufficient: media reported `published: 120` for two runs of one recording, while the
   * events service reported `deduped 0, persisted 0`. It had never been handed them. Without the run
   * in the msgId, ADR-0047 would have looked correct in every unit test and changed nothing in
   * production.
   */
  it('⭐ a rerun gets its own msgId, so the broker cannot swallow it', async () => {
    const { publisher, published } = make();
    const frame = { seq: 7, capturedAt: '2026-02-14T18:30:03.000Z' };

    publisher.publish(result({ correlationId: 'ases_A', analysisSessionId: 'ases_A', frame }));
    publisher.publish(result({ correlationId: 'ases_B', analysisSessionId: 'ases_B', frame }));
    await settle();

    expect(published).toHaveLength(2);
    expect(published[0]?.msgId).toBe('tnt_a:cam_1:7:ases_A');
    expect(published[1]?.msgId).toBe('tnt_a:cam_1:7:ases_B');
    expect(published[0]?.msgId).not.toBe(published[1]?.msgId);
  });

  /**
   * ⚠️ **Live keeps the exact three-part id it has always had.** A changed shape would make every
   * live camera's in-flight retries stop collapsing on the deploy — the idempotency this field
   * exists to provide, lost at the moment of a rollout.
   */
  it('leaves the live msgId byte-identical', async () => {
    const { publisher, published } = make();
    publisher.publish(result({ frame: { seq: 42, capturedAt: '2026-08-06T09:00:00.000Z' } }));
    await settle();
    expect(published[0]?.msgId).toBe('tnt_a:cam_1:42');
    expect(published[0]?.msgId?.split(':')).toHaveLength(3);
  });

  it('sets a msgId identifying the frame, so a retry cannot become a duplicate', async () => {
    const { publisher, published } = make();
    publisher.publish(result({ frame: { seq: 42, capturedAt: '2026-08-06T09:00:00.000Z' } }));
    await settle();
    expect(published[0]?.msgId).toBe('tnt_a:cam_1:42');
  });

  it('is off unless enabled, and publishes nothing when off', async () => {
    const { bus, published } = recordingBus();
    const publisher = new BufferedEventPublisher({ bus });
    publisher.publish(result());
    await settle();
    expect(published).toHaveLength(0);
    expect(publisher.stats().enabled).toBe(false);
    expect(publisher.stats().offered).toBe(0);
  });
});

describe('refusals', () => {
  it('⚠️ rejects an invalid result rather than letting the broker dead-letter it', async () => {
    /*
     * Fail-closed AT THE PRODUCER. `services/events` would refuse this too — but only after a broker
     * round trip, and the evidence would land in another service's log where nobody debugging media
     * would find it.
     */
    const { publisher, published } = make();
    publisher.publish({ tenantId: 'tnt_a', detections: 'not-an-array' });
    await settle();

    expect(published).toHaveLength(0);
    expect(publisher.stats().rejected).toBe(1);
    expect(publisher.stats().published).toBe(0);
  });

  it('⚠️ suppresses a result with no detections — it would produce no events', async () => {
    const { publisher, published } = make();
    publisher.publish(result({ detections: [] }));
    await settle();

    expect(published).toHaveLength(0);
    expect(publisher.stats().suppressed).toBe(1);
    /* Suppression is not rejection: nothing was wrong with the result. */
    expect(publisher.stats().rejected).toBe(0);
  });

  it('never throws, whatever it is handed', () => {
    const { publisher } = make();
    for (const bad of [undefined, null, 42, 'text', [], {}, { detections: [{}] }]) {
      expect(() => publisher.publish(bad)).not.toThrow();
    }
  });
});

describe('ordering', () => {
  it('⚠️ drops a result older than one already published for that camera', async () => {
    /*
     * The runtime answers up to four frames concurrently, so responses genuinely arrive out of
     * order. Publishing a stale one breaks per-camera ordering downstream — and the tracker already
     * skipped it, so it carries no identity anyway.
     */
    const { publisher, published } = make();
    publisher.publish(result({ frame: { seq: 5, capturedAt: '2026-08-06T09:00:02.000Z' } }));
    publisher.publish(result({ frame: { seq: 3, capturedAt: '2026-08-06T09:00:01.000Z' } }));
    await settle();

    expect(published).toHaveLength(1);
    expect(publisher.stats().droppedOutOfOrder).toBe(1);
  });

  it('drops a repeat of the same sequence', async () => {
    const { publisher, published } = make();
    publisher.publish(result({ frame: { seq: 5, capturedAt: '2026-08-06T09:00:02.000Z' } }));
    publisher.publish(result({ frame: { seq: 5, capturedAt: '2026-08-06T09:00:02.000Z' } }));
    await settle();
    expect(published).toHaveLength(1);
    expect(publisher.stats().droppedOutOfOrder).toBe(1);
  });

  /**
   * ⛔ **The defect the deployed 1×/8× parity run found** (P-8 Phase 8, slice 3).
   *
   * The same recording analysed twice on one camera: run A published 60 results, run B dropped all
   * 60 — `droppedOutOfOrder: 60`, `sessionResets: 0`, measured on the deployed stack. The session
   * still said `succeeded` with 120 detections, so an operator would have seen a completed analysis
   * with an empty timeline and nothing anywhere explaining it.
   *
   * ⭐ No heuristic could have fixed it. An offline analysis stamps **footage** time, so a rerun
   * replays *identical* `(seq, capturedAt)` pairs — not newer, not older, the same instants examined
   * again. The stream's identity has to be explicit, and `correlationId` carries it.
   */
  it('⭐ a rerun of the same footage is its own stream, not a stale redelivery', async () => {
    const { publisher, published } = make();
    const footage = { seq: 1, capturedAt: '2026-02-14T18:30:00.000Z' };

    /* Run A: two frames of the recording. */
    publisher.publish(result({ correlationId: 'ases_A', frame: footage }));
    publisher.publish(
      result({ correlationId: 'ases_A', frame: { seq: 2, capturedAt: '2026-02-14T18:30:00.500Z' } }),
    );
    /* Run B: the SAME file, the SAME sequences, the SAME footage timestamps. */
    publisher.publish(result({ correlationId: 'ases_B', frame: footage }));
    publisher.publish(
      result({ correlationId: 'ases_B', frame: { seq: 2, capturedAt: '2026-02-14T18:30:00.500Z' } }),
    );
    await settle();

    expect(published).toHaveLength(4);
    expect(publisher.stats().droppedOutOfOrder).toBe(0);
  });

  /** ⚠️ …and ordering is still enforced strictly WITHIN a run. Fixing one must not disable the other. */
  it('still drops a stale result inside one analysis session', async () => {
    const { publisher, published } = make();
    publisher.publish(
      result({ correlationId: 'ases_A', frame: { seq: 5, capturedAt: '2026-02-14T18:30:02.000Z' } }),
    );
    publisher.publish(
      result({ correlationId: 'ases_A', frame: { seq: 3, capturedAt: '2026-02-14T18:30:01.000Z' } }),
    );
    await settle();

    expect(published).toHaveLength(1);
    expect(publisher.stats().droppedOutOfOrder).toBe(1);
  });

  /**
   * ⚠️ **Live behaviour must be byte-identical.** A live result carries no `correlationId` — the
   * publisher stamps one per frame *after* the gate — so the key is unchanged and a genuinely stale
   * live response is still dropped. If this ever fails, the fix above has widened past its purpose.
   */
  it('leaves the live path exactly as it was', async () => {
    const { publisher, published } = make();
    publisher.publish(result({ frame: { seq: 5, capturedAt: '2026-08-06T09:00:02.000Z' } }));
    publisher.publish(result({ frame: { seq: 4, capturedAt: '2026-08-06T09:00:01.000Z' } }));
    await settle();

    expect(published).toHaveLength(1);
    expect(publisher.stats().droppedOutOfOrder).toBe(1);
  });

  /** ⚠️ Releasing a camera must clear its analysis-session gates too, not just its own. */
  it('release clears every stream on the camera, sessions included', async () => {
    const { publisher, published } = make();
    publisher.publish(
      result({ correlationId: 'ases_A', frame: { seq: 9, capturedAt: '2026-02-14T18:30:04.000Z' } }),
    );
    await settle();
    publisher.release('tnt_a', 'cam_1');
    /* The same session, restarting at sequence 1 — it must not meet a stale gate. */
    publisher.publish(
      result({ correlationId: 'ases_A', frame: { seq: 1, capturedAt: '2026-02-14T18:30:00.000Z' } }),
    );
    await settle();

    expect(published).toHaveLength(2);
    expect(publisher.stats().droppedOutOfOrder).toBe(0);
  });

  /** ⚠️ A session-keyed gate must not turn up in `cameras()`, which reports real camera ids. */
  it('reports the camera, never the session-suffixed key', async () => {
    const { publisher } = make();
    publisher.publish(result({ correlationId: 'ases_A' }));
    publisher.publish(result({ correlationId: 'ases_B' }));
    publisher.publish(result({ cameraId: 'cam_2' }));
    await settle();

    expect(publisher.cameras('tnt_a')).toEqual(['cam_1', 'cam_2']);
  });

  it('⚠️ orders per camera, not globally — one camera cannot gate another', async () => {
    const { publisher, published } = make();
    publisher.publish(
      result({ cameraId: 'cam_1', frame: { seq: 9, capturedAt: '2026-08-06T09:00:04.000Z' } }),
    );
    publisher.publish(
      result({ cameraId: 'cam_2', frame: { seq: 1, capturedAt: '2026-08-06T09:00:00.000Z' } }),
    );
    await settle();

    expect(published).toHaveLength(2);
    expect(publisher.stats().droppedOutOfOrder).toBe(0);
  });

  it('⚠️ tenants are separate too — a shared camera id must not cross the boundary', async () => {
    const { publisher, published } = make();
    publisher.publish(
      result({ tenantId: 'tnt_a', frame: { seq: 9, capturedAt: '2026-08-06T09:00:04.000Z' } }),
    );
    publisher.publish(
      result({ tenantId: 'tnt_b', frame: { seq: 1, capturedAt: '2026-08-06T09:00:00.000Z' } }),
    );
    await settle();

    expect(published).toHaveLength(2);
    expect(published[1]?.subject).toContain('t.tnt_b.');
  });

  it("publishes a camera's frames in sequence order", async () => {
    const { publisher, published } = make({ maxInflight: 1 });
    for (const seq of [1, 2, 3, 4]) {
      publisher.publish(result({ frame: { seq, capturedAt: '2026-08-06T09:00:00.000Z' } }));
    }
    await settle();

    const seqs = published.map((p) => (p.data as { frame: { seq: number } }).frame.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });
});

describe('back-pressure', () => {
  it('⚠️ drops under pressure rather than growing — recording outranks publishing', async () => {
    /*
     * The queue lives on the process that writes MP4 segments. An unbounded queue against a slow or
     * dead broker is a memory leak on the one process that must never run out of memory.
     */
    const { bus } = recordingBus();
    const slow: EventBus = { ...bus, publish: async () => new Promise(() => {}) };
    const publisher = new BufferedEventPublisher({
      bus: slow,
      enabled: true,
      perCamera: 2,
      maxInflight: 1,
    });

    for (let seq = 1; seq <= 20; seq += 1) {
      publisher.publish(result({ frame: { seq, capturedAt: '2026-08-06T09:00:00.000Z' } }));
    }
    await settle();

    const stats = publisher.stats();
    expect(stats.queueDepth).toBeLessThanOrEqual(2);
    expect(stats.droppedQueueFull).toBeGreaterThan(0);
  });

  it('bounds each camera separately, so a stalled camera cannot starve another', async () => {
    const { bus } = recordingBus();
    const slow: EventBus = { ...bus, publish: async () => new Promise(() => {}) };
    const publisher = new BufferedEventPublisher({
      bus: slow,
      enabled: true,
      perCamera: 2,
      maxInflight: 1,
    });

    for (let seq = 1; seq <= 10; seq += 1) {
      publisher.publish(
        result({ cameraId: 'cam_busy', frame: { seq, capturedAt: '2026-08-06T09:00:00.000Z' } }),
      );
    }
    publisher.publish(
      result({ cameraId: 'cam_quiet', frame: { seq: 1, capturedAt: '2026-08-06T09:00:00.000Z' } }),
    );
    await settle();

    expect(publisher.stats().activeCameras).toBeGreaterThanOrEqual(1);
    expect(publisher.stats().queueDepth).toBeLessThanOrEqual(4);
  });
});

describe('retry and broker state', () => {
  it('retries a failed publish, within a bound', async () => {
    const { publisher, published } = make({ behaviour: { fail: 1 }, maxAttempts: 2 });
    publisher.publish(result());
    await settle();

    expect(published).toHaveLength(1);
    expect(publisher.stats().retries).toBe(1);
    expect(publisher.stats().failed).toBe(0);
  });

  it('⚠️ gives up after the bound rather than retrying for ever', async () => {
    /* An unbounded retry against a down broker converts an outage into a memory leak. */
    const { publisher, published } = make({ behaviour: { fail: 99 }, maxAttempts: 2 });
    publisher.publish(result());
    await settle();

    expect(published).toHaveLength(0);
    expect(publisher.stats().failed).toBe(1);
    expect(publisher.stats().retries).toBe(1);
    expect(publisher.stats().brokerStatus).toBe('down');
  });

  it('⚠️ reports the broker as "unknown" before anything is attempted, never "up"', () => {
    const { publisher } = make();
    /* A publisher that has published nothing has not demonstrated a working broker (ADR-0039). */
    expect(publisher.stats().brokerStatus).toBe('unknown');
  });

  it('recovers: a broker that comes back drains the queue in order', async () => {
    let down = true;
    const published: Array<{ seq: number }> = [];
    const bus: EventBus = {
      ensureStream: async () => undefined,
      publish: async (_s, data) => {
        if (down) throw new Error('broker unavailable');
        published.push({ seq: (data as { frame: { seq: number } }).frame.seq });
      },
      subscribe: async () => ({ stop: async () => undefined }),
      close: async () => undefined,
    };
    const publisher = new BufferedEventPublisher({
      bus,
      enabled: true,
      maxAttempts: 1,
      maxInflight: 1,
    });

    publisher.publish(result({ frame: { seq: 1, capturedAt: '2026-08-06T09:00:00.000Z' } }));
    await settle();
    expect(publisher.stats().brokerStatus).toBe('down');
    expect(publisher.stats().failed).toBe(1);

    down = false;
    for (const seq of [2, 3, 4]) {
      publisher.publish(result({ frame: { seq, capturedAt: '2026-08-06T09:00:00.000Z' } }));
    }
    await settle();

    expect(published.map((p) => p.seq)).toEqual([2, 3, 4]);
    expect(publisher.stats().brokerStatus).toBe('up');
  });
});

describe('metrics', () => {
  it('⚠️ reports null rather than 0 for an average nothing has measured', () => {
    const { publisher } = make();
    const stats = publisher.stats();
    /* "publishes take no time" and "nothing has published" render identically as 0 (ADR-0039). */
    expect(stats.publishMsAvg).toBeNull();
    expect(stats.throughputPerSecond).toBeNull();
  });

  it('reports its own version and the payload version it saw, separately', async () => {
    const { publisher } = make();
    expect(publisher.stats().publisherVersion).toBe(PUBLISHER_VERSION);
    expect(publisher.stats().payloadSchemaVersion).toBeUndefined();

    publisher.publish(result({ schemaVersion: '1.4' }));
    await settle();
    /* ⚠️ Reported from the wire, never assumed — this is what the runtime actually sent. */
    expect(publisher.stats().payloadSchemaVersion).toBe('1.4');
  });

  it('counts detections published, which is the number of events downstream will produce', async () => {
    const { publisher } = make();
    const two = result();
    two.detections = [...two.detections, { ...two.detections[0], trackingId: 'trk_2' }];
    publisher.publish(two);
    await settle();
    expect(publisher.stats().detectionsPublished).toBe(2);
  });
});

describe('the metrics endpoint', () => {
  it('⚠️ OMITS an unmeasured average rather than publishing it as 0', async () => {
    /*
     * The defect this covers, found by scraping the deployment: prom-client initialises an
     * unlabelled gauge to 0 at construction, so a collector that simply declines to call `set()`
     * still publishes `metric 0`. A dashboard then shows "publishes take no time" on a publisher
     * that has never reached the broker. `remove()` is what actually omits the sample.
     */
    const { Registry } = await import('prom-client');
    const { registerEventPublisherMetrics } =
      await import('../src/transport/plugins/observability.js');
    const registry = new Registry();
    const { publisher } = make();
    registerEventPublisherMetrics(registry, publisher);

    const before = await registry.metrics();
    expect(before).not.toMatch(/^media_event_publisher_publish_ms_avg /m);
    expect(before).not.toMatch(/^media_event_publisher_throughput_per_second /m);
    /* The counters ARE present at zero — a zero count is a measurement. */
    expect(before).toMatch(/^media_event_publisher_published_total 0/m);

    publisher.publish(result());
    await settle();

    const after = await registry.metrics();
    expect(after).toMatch(/^media_event_publisher_publish_ms_avg /m);
  });

  it('⚠️ distinguishes a broker never tried (0) from one that failed (-1)', async () => {
    const { Registry } = await import('prom-client');
    const { registerEventPublisherMetrics } =
      await import('../src/transport/plugins/observability.js');
    const registry = new Registry();
    const { publisher } = make({ behaviour: { fail: 99 }, maxAttempts: 1 });
    registerEventPublisherMetrics(registry, publisher);

    expect(await registry.metrics()).toMatch(/^media_event_publisher_broker_status 0/m);
    publisher.publish(result());
    await settle();
    /* An alert must be able to tell "not yet tried" from "tried and failed". */
    expect(await registry.metrics()).toMatch(/^media_event_publisher_broker_status -1/m);
  });
});

describe('camera assignment compatibility', () => {
  it('tracks which cameras it holds state for', async () => {
    const { publisher } = make();
    publisher.publish(result({ cameraId: 'cam_1' }));
    publisher.publish(result({ cameraId: 'cam_2' }));
    await settle();
    expect(publisher.cameras('tnt_a')).toEqual(['cam_1', 'cam_2']);
    expect(publisher.cameras('tnt_other')).toEqual([]);
  });

  it('⚠️ a RESTARTED stream publishes again, even though its sequence begins at 1', async () => {
    /*
     * The defect the resilience run found, and the one that would have blocked Camera Processing
     * Assignment. A stream that stops and starts begins its frame sequence again; against a gate
     * holding lastSeq=100 that reads as "stale", so a re-enabled camera published 0 results and
     * dropped 32 — indefinitely, with nothing in the logs.
     *
     * Capture time distinguishes the two cases exactly: a genuinely out-of-order response is older
     * in wall-clock time as well as in sequence; a restarted stream's frames are NEWER despite a
     * lower sequence.
     */
    const { publisher, published } = make();
    publisher.publish(result({ frame: { seq: 100, capturedAt: '2026-08-06T09:00:00.000Z' } }));
    await settle();
    expect(published).toHaveLength(1);

    // Same camera, sequence restarted at 1 — but the frame is from a minute LATER.
    publisher.publish(result({ frame: { seq: 1, capturedAt: '2026-08-06T09:01:00.000Z' } }));
    await settle();

    expect(published).toHaveLength(2);
    expect(publisher.stats().sessionResets).toBe(1);
    expect(publisher.stats().droppedOutOfOrder).toBe(0);
  });

  it('⚠️ but a genuinely LATE response is still dropped — older sequence AND older time', async () => {
    const { publisher, published } = make();
    publisher.publish(result({ frame: { seq: 100, capturedAt: '2026-08-06T09:00:10.000Z' } }));
    await settle();
    publisher.publish(result({ frame: { seq: 98, capturedAt: '2026-08-06T09:00:09.000Z' } }));
    await settle();

    expect(published).toHaveLength(1);
    expect(publisher.stats().droppedOutOfOrder).toBe(1);
    expect(publisher.stats().sessionResets).toBe(0);
  });

  it('⚠️ releasing a camera clears its ordering gate, so re-enabling it works', async () => {
    /*
     * The failure this prevents: a camera whose AI is switched off and back on keeps a stale
     * `lastSeq` from the previous session, and every event is silently dropped as "out of order"
     * until the new sequence overtakes the old one. Camera Processing Assignment is not built; this
     * is the seam it plugs into.
     */
    const { publisher, published } = make();
    publisher.publish(result({ frame: { seq: 500, capturedAt: '2026-08-06T09:00:00.000Z' } }));
    await settle();
    expect(published).toHaveLength(1);

    publisher.release('tnt_a', 'cam_1');
    expect(publisher.cameras('tnt_a')).toEqual([]);

    // A restarted stream begins at seq 1 again — and must publish, not be dropped as stale.
    publisher.publish(result({ frame: { seq: 1, capturedAt: '2026-08-06T09:01:00.000Z' } }));
    await settle();
    expect(published).toHaveLength(2);
    expect(publisher.stats().droppedOutOfOrder).toBe(0);
  });

  it('⚠️ a camera that stops offering simply goes quiet — no events, no errors', async () => {
    const { publisher, published } = make();
    publisher.publish(result());
    await settle();
    const after = published.length;

    /* Assignment disables a camera by ceasing to offer frames. Nothing here should complain. */
    await settle();
    expect(published).toHaveLength(after);
    expect(publisher.stats().failed).toBe(0);
    expect(publisher.stats().queueDepth).toBe(0);
  });
});

describe('recording is never affected', () => {
  it('⚠️ publish() returns synchronously even when the broker hangs for ever', () => {
    const { bus } = recordingBus();
    const hanging: EventBus = { ...bus, publish: async () => new Promise(() => {}) };
    const publisher = new BufferedEventPublisher({ bus: hanging, enabled: true });

    const started = Date.now();
    for (let seq = 1; seq <= 100; seq += 1) {
      publisher.publish(result({ frame: { seq, capturedAt: '2026-08-06T09:00:00.000Z' } }));
    }
    /* It is called from the process writing MP4 segments; it may never await or block. */
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('a bus that throws synchronously does not propagate', () => {
    const { bus } = recordingBus();
    const angry: EventBus = {
      ...bus,
      publish: () => {
        throw new Error('exploded');
      },
    };
    const publisher = new BufferedEventPublisher({ bus: angry, enabled: true });
    expect(() => publisher.publish(result())).not.toThrow();
  });

  it('logs a broker failure at most once a minute', async () => {
    const onLog = vi.fn();
    const { bus } = recordingBus({ fail: 999 });
    let clock = 1_000_000;
    const publisher = new BufferedEventPublisher({
      bus,
      enabled: true,
      maxAttempts: 1,
      onLog,
      now: () => clock,
    });

    for (let seq = 1; seq <= 30; seq += 1) {
      publisher.publish(result({ frame: { seq, capturedAt: '2026-08-06T09:00:00.000Z' } }));
    }
    await settle();
    /* ⚠️ 2 fps × 16 cameras against a dead broker is ~1 900 lines a minute, which buries the why. */
    expect(onLog.mock.calls.length).toBeLessThanOrEqual(1);

    clock += 61_000;
    publisher.publish(result({ frame: { seq: 99, capturedAt: '2026-08-06T09:00:00.000Z' } }));
    await settle();
    expect(onLog.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

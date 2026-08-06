/**
 * Camera Processing Assignment (P-8 Phase 6) — the domain and the control plane, driven in-memory.
 * No Mongo, no network, no runtime, no camera: the clock and every identifier are injected, so every
 * assertion here is deterministic.
 *
 * ### The tests to be most suspicious of anyone "fixing"
 *
 * - **every cell of the transition table**, including the illegal ones. A state machine asserted only
 *   on its happy paths is a state machine that will accept `stopped → paused` the day somebody adds
 *   a row.
 * - **observed states cannot be reached by an operator action.** This is the evidence rule that keeps
 *   the control plane honest; without it, "running" degrades into "we published a plan".
 * - **pause does not bump the session epoch and stop does.** That single difference is the entire
 *   reason both operations exist.
 * - **a bulk operation with one bad item writes nothing.** The only atomicity a standalone MongoDB
 *   can offer, and it is worth exactly nothing if it is not asserted.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { Collection } from 'mongodb';
import { TenantRepository, TenantScope } from '@vip/tenancy';
import {
  ASSIGNMENT_TRANSITIONS,
  OBSERVED_ASSIGNMENT_STATES,
  OBSERVING_ACTIONS,
  assignmentAiEnabled,
  canTransition,
  transition,
  type AssignmentAction,
  type AssignmentState,
} from '@vip/contracts';
import {
  applyAction,
  unassigned,
  actionForObservation,
  observedView,
  OBSERVATION_TTL_MS,
  type AssignmentDoc,
} from '../src/domain/assignment.js';
import {
  LeastLoadedPlacement,
  availableCapacity,
  remainingCapacity,
} from '../src/domain/placement.js';
import {
  newRuntime,
  applyObservation,
  effectiveHealth,
  placeable,
} from '../src/domain/runtime-registry.js';
import { checkAssignmentLimits } from '../src/domain/assignment-limits.js';
import { BUILT_IN_PROFILES, profileSupported } from '../src/domain/processing-profile.js';
import {
  AssignmentService,
  type GroupDoc,
  type HistoryDoc,
  type MetaDoc,
} from '../src/application/assignment-service.js';
import type { ProcessingFactsDoc } from '../src/application/capability-matrix.js';
import type { ProfileDoc } from '../src/domain/processing-profile.js';
import type { RuntimeDoc } from '../src/domain/runtime-registry.js';
import type { CameraDoc } from '../src/domain/camera.js';

// ---------------------------------------------------------------------------------------------
// An in-memory collection supporting exactly the operators the service issues. Anything else throws
// rather than silently matching — a fake that has drifted from the service must fail loudly.
// ---------------------------------------------------------------------------------------------

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = doc[key];
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      return Object.entries(expected as Record<string, unknown>).every(([op, operand]) => {
        switch (op) {
          case '$in':
            return (operand as unknown[]).includes(actual);
          case '$nin_unused':
            return false;
          case '$nin':
            return !(operand as unknown[]).includes(actual);
          case '$ne':
            return actual !== operand;
          default:
            throw new Error(`memoryCollection: unsupported operator ${op}`);
        }
      });
    }
    return actual === expected;
  });
}

function memoryCollection<T extends Record<string, unknown>>(seed: T[] = []): Collection<T> {
  const store: T[] = [...seed];
  return {
    async insertOne(doc: T) {
      if (store.some((d) => d._id === doc._id)) throw new Error('duplicate key');
      store.push({ ...doc });
      return { insertedId: doc._id, acknowledged: true };
    },
    async findOne(filter: Record<string, unknown>) {
      return store.find((d) => matches(d, filter)) ?? null;
    },
    /* ⚠️ A second argument (projection) is accepted and ignored — the service passes one, and a fake
       that threw on it would fail for a reason that has nothing to do with the behaviour. */
    find(filter: Record<string, unknown>) {
      let rows = store.filter((d) => matches(d, filter));
      const cursor = {
        sort(spec: Record<string, 1 | -1>) {
          const entries = Object.entries(spec);
          rows = [...rows].sort((a, b) => {
            for (const [key, dir] of entries) {
              const l = a[key as keyof T] as string;
              const r = b[key as keyof T] as string;
              if (l === r) continue;
              return (l < r ? -1 : 1) * (dir as number);
            }
            return 0;
          });
          return cursor;
        },
        limit(n: number) {
          rows = rows.slice(0, n);
          return cursor;
        },
        skip(n: number) {
          rows = rows.slice(n);
          return cursor;
        },
        toArray: async () => rows.map((r) => ({ ...r })),
      };
      return cursor;
    },
    async countDocuments(filter: Record<string, unknown> = {}) {
      return store.filter((d) => matches(d, filter)).length;
    },
    async updateOne(
      filter: Record<string, unknown>,
      update: { $set?: Partial<T>; $inc?: Record<string, number>; $setOnInsert?: T },
      options: { upsert?: boolean } = {},
    ) {
      const existing = store.find((d) => matches(d, filter));
      if (existing === undefined) {
        if (options.upsert !== true)
          return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
        const created = {
          ...(update.$setOnInsert ?? ({} as T)),
          ...(filter as Partial<T>),
        } as T;
        for (const [k, v] of Object.entries(update.$inc ?? {})) {
          (created as Record<string, unknown>)[k] = ((created[k as keyof T] as number) ?? 0) + v;
        }
        Object.assign(created, update.$set ?? {});
        store.push(created);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, acknowledged: true };
      }
      for (const [k, v] of Object.entries(update.$inc ?? {})) {
        (existing as Record<string, unknown>)[k] = ((existing[k as keyof T] as number) ?? 0) + v;
      }
      Object.assign(existing, update.$set ?? {});
      return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
    },
    async deleteOne(filter: Record<string, unknown>) {
      const i = store.findIndex((d) => matches(d, filter));
      if (i === -1) return { deletedCount: 0, acknowledged: true };
      store.splice(i, 1);
      return { deletedCount: 1, acknowledged: true };
    },
  } as unknown as Collection<T>;
}

const NOW = new Date('2026-08-06T10:00:00.000Z');
const TENANT = 'tnt_a';
const OTHER = 'tnt_b';
const scope = TenantScope.fromTenantId(TENANT);
const otherScope = TenantScope.fromTenantId(OTHER);
const PERSON = 'perception.person-detection';

function doc(overrides: Partial<AssignmentDoc> = {}): AssignmentDoc {
  return { ...unassigned(TENANT, 'cam1', NOW), ...overrides };
}

function runtimeDoc(id: string, overrides: Partial<RuntimeDoc> = {}): RuntimeDoc {
  return {
    ...newRuntime({ id, name: id, url: `http://${id}:8085`, maxCameras: 4 }, 'op', NOW),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------------------------

const ALL_STATES: AssignmentState[] = [
  'unassigned',
  'assigned',
  'starting',
  'running',
  'paused',
  'stopping',
  'stopped',
  'error',
  'recovering',
];

const ALL_ACTIONS: AssignmentAction[] = [
  'assign',
  'start',
  'pause',
  'resume',
  'stop',
  'restart',
  'remove',
  'place-failed',
  'failover',
  'observe-running',
  'observe-error',
  'observe-stopped',
];

describe('P-8.6 · the assignment state machine', () => {
  it('⚠️ refuses every transition the table does not name — all 108 cells asserted', () => {
    let legal = 0;
    let illegal = 0;
    for (const from of ALL_STATES) {
      for (const action of ALL_ACTIONS) {
        const declared = ASSIGNMENT_TRANSITIONS[from][action];
        const applied = transition(from, action);
        expect(applied).toBe(declared ?? null);
        if (declared === undefined) illegal += 1;
        else legal += 1;
      }
    }
    expect(legal + illegal).toBe(ALL_STATES.length * ALL_ACTIONS.length);
    /* Sanity: the table is neither empty nor total — both would make the assertion above vacuous. */
    expect(legal).toBeGreaterThan(20);
    expect(illegal).toBeGreaterThan(20);
  });

  /**
   * ⚠️ The evidence rule, asserted over the **whole table** rather than over the paths somebody
   * remembered: no action outside `OBSERVING_ACTIONS` may *enter* `running` or `stopped`.
   *
   * "Enter" rather than "reach": `running --assign--> running` is a legal self-transition (a hot
   * profile change on a confirmed-running camera must not reset it to `starting`), and it does not
   * manufacture a claim — the camera was already observed running. The first version of this test
   * said "reach" and failed on exactly that, which is how the distinction got written down.
   */
  it('⚠️ no operator action ENTERS running or stopped — those need an observation', () => {
    const observing = new Set<string>(OBSERVING_ACTIONS);
    for (const from of ALL_STATES) {
      for (const action of ALL_ACTIONS) {
        if (observing.has(action)) continue;
        const to = transition(from, action);
        if (to === null || to === from) continue;
        expect(
          (OBSERVED_ASSIGNMENT_STATES as readonly string[]).includes(to),
          `${from} --${action}--> ${to} enters an observed state without an observation`,
        ).toBe(false);
      }
    }
  });

  it('⚠️ and the observing actions are the ONLY way into those two states', () => {
    for (const state of OBSERVED_ASSIGNMENT_STATES) {
      const entrants = ALL_STATES.flatMap((from) =>
        ALL_ACTIONS.filter((a) => from !== state && transition(from, a) === state),
      );
      expect(entrants.length).toBeGreaterThan(0);
      for (const action of entrants) {
        expect((OBSERVING_ACTIONS as readonly string[]).includes(action)).toBe(true);
      }
    }
  });

  it('a retired-equivalent state cannot be resumed: stopped does not accept resume or pause', () => {
    expect(canTransition('stopped', 'resume')).toBe(false);
    expect(canTransition('stopped', 'pause')).toBe(false);
    expect(canTransition('stopped', 'start')).toBe(true);
  });

  it('remove is legal from every state — bulk removal must be idempotent', () => {
    for (const from of ALL_STATES) expect(transition(from, 'remove')).toBe('unassigned');
  });

  it('derives aiEnabled from the state rather than storing a second copy', () => {
    expect(assignmentAiEnabled('unassigned')).toBe(false);
    expect(assignmentAiEnabled('stopped')).toBe(false);
    /* ⚠️ paused counts as enabled: it still occupies capacity on its runtime. */
    expect(assignmentAiEnabled('paused')).toBe(true);
    expect(assignmentAiEnabled('running')).toBe(true);
  });
});

describe('P-8.6 · the session epoch', () => {
  const input = (action: AssignmentAction, extra: Record<string, unknown> = {}) => ({
    action,
    actor: 'op',
    reason: 'operator' as const,
    at: NOW,
    historyId: 'h1',
    ...extra,
  });

  it('⚠️ bumps on start and restart — a re-enabled camera must not inherit the old ordering gate', () => {
    const stopped = doc({ state: 'stopped', sessionEpoch: 3, runtimeId: 'rt1', profileId: 'p' });
    const started = applyAction(stopped, input('start'));
    expect('doc' in started && started.doc.sessionEpoch).toBe(4);
    expect('releasedSession' in started && started.releasedSession).toBe(true);
  });

  it('⚠️ does NOT bump on pause or resume — that is the whole difference from stop', () => {
    const running = doc({ state: 'running', sessionEpoch: 2, runtimeId: 'rt1', profileId: 'p' });
    const paused = applyAction(running, input('pause'));
    expect('doc' in paused && paused.doc.sessionEpoch).toBe(2);
    expect('doc' in paused && paused.doc.state).toBe('paused');
  });

  it('⚠️ bumps when the RUNTIME changes, because the tracks live inside the runtime', () => {
    const running = doc({ state: 'running', sessionEpoch: 1, runtimeId: 'rt1', profileId: 'p' });
    const moved = applyAction(running, input('assign', { runtimeId: 'rt2' }));
    expect('doc' in moved && moved.doc.sessionEpoch).toBe(2);
    expect('doc' in moved && moved.doc.state).toBe('running');
  });

  it('⚠️ does NOT bump when only the PROFILE changes — that is a hot change', () => {
    const running = doc({ state: 'running', sessionEpoch: 1, runtimeId: 'rt1', profileId: 'p' });
    const hot = applyAction(running, input('assign', { runtimeId: 'rt1', profileId: 'q' }));
    expect('doc' in hot && hot.doc.sessionEpoch).toBe(1);
    expect('doc' in hot && hot.doc.profileId).toBe('q');
    expect('doc' in hot && hot.doc.state).toBe('running');
  });

  it('refuses an illegal action instead of throwing, so bulk can report it per item', () => {
    const outcome = applyAction(doc({ state: 'unassigned' }), input('pause'));
    expect('code' in outcome && outcome.code).toBe('illegal_transition');
  });

  it('clears runtime, profile and observation on removal', () => {
    const running = doc({
      state: 'running',
      runtimeId: 'rt1',
      profileId: 'p',
      observedState: 'active',
      observedAt: NOW.toISOString(),
    });
    const removed = applyAction(running, input('remove'));
    expect('doc' in removed && removed.doc.runtimeId).toBeNull();
    expect('doc' in removed && removed.doc.observedState).toBeNull();
  });

  it('records the whole before/after snapshot, not a diff', () => {
    const from = doc({ state: 'running', runtimeId: 'rt1', profileId: 'p', version: 4 });
    const outcome = applyAction(from, input('pause'));
    expect('history' in outcome && outcome.history.before).toEqual({
      state: 'running',
      profileId: 'p',
      runtimeId: 'rt1',
      version: 4,
      sessionEpoch: 0,
    });
    expect('history' in outcome && outcome.history.after.state).toBe('paused');
  });
});

describe('P-8.6 · observations', () => {
  it('⚠️ an idle camera moves nothing — the stream is down, not the assignment', () => {
    expect(actionForObservation('idle')).toBeNull();
    expect(actionForObservation('paused')).toBeNull();
    expect(actionForObservation('active')).toBe('observe-running');
    expect(actionForObservation('released')).toBe('observe-stopped');
    expect(actionForObservation('failed')).toBe('observe-error');
  });

  it('⚠️ disowns a measurement past the TTL without discarding it', () => {
    const observed = doc({ observedState: 'active', observedAt: NOW.toISOString() });
    const later = new Date(NOW.getTime() + OBSERVATION_TTL_MS + 1_000);
    const view = observedView(observed, later);
    expect(view.stale).toBe(true);
    expect(view.state).toBe('active');
    expect(view.at).toBe(NOW.toISOString());
  });

  it('a camera nothing has reported on is not stale — it is unmeasured', () => {
    expect(observedView(doc(), NOW).stale).toBe(false);
    expect(observedView(doc(), NOW).state).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Runtimes and placement
// ---------------------------------------------------------------------------------------------

describe('P-8.6 · the runtime registry', () => {
  it('⚠️ a registered runtime nobody has observed is unknown, never offline and never healthy', () => {
    const rt = runtimeDoc('rt1');
    expect(rt.health).toBe('unknown');
    expect(effectiveHealth(rt, NOW)).toBe('unknown');
  });

  it('⚠️ an expired observation returns to unknown rather than decaying to offline', () => {
    const observed = applyObservation(
      runtimeDoc('rt1'),
      { runtimeId: 'rt1', health: 'healthy', latencyMs: 4, capabilities: [PERSON] },
      'media',
      NOW,
    );
    expect(effectiveHealth(observed, NOW)).toBe('healthy');
    const later = new Date(NOW.getTime() + 60_000);
    expect(effectiveHealth(observed, later)).toBe('unknown');
  });

  it('keeps advertised capabilities when an observation could not read them', () => {
    const healthy = applyObservation(
      runtimeDoc('rt1'),
      { runtimeId: 'rt1', health: 'healthy', latencyMs: 4, capabilities: [PERSON] },
      'media',
      NOW,
    );
    const down = applyObservation(
      healthy,
      { runtimeId: 'rt1', health: 'offline', latencyMs: null, capabilities: null },
      'media',
      NOW,
    );
    expect(down.capabilities).toEqual([PERSON]);
    expect(down.latencyMs).toBeNull();
  });

  it('an unobserved runtime is placeable, or a fresh deployment could never be configured', () => {
    expect(placeable(runtimeDoc('rt1'), NOW)).toBe(true);
    expect(placeable(runtimeDoc('rt1', { enabled: false }), NOW)).toBe(false);
  });
});

describe('P-8.6 · placement', () => {
  const strategy = new LeastLoadedPlacement();
  const healthy = (id: string, max = 4, caps: string[] | null = [PERSON]): RuntimeDoc =>
    runtimeDoc(id, {
      maxCameras: max,
      health: 'healthy',
      observedAt: NOW.toISOString(),
      capabilities: caps,
    });

  it('chooses the least loaded, breaking ties on runtime id — never map order', () => {
    const runtimes = [healthy('rt-b'), healthy('rt-a'), healthy('rt-c')];
    const load = new Map([
      ['rt-a', 2],
      ['rt-b', 2],
      ['rt-c', 3],
    ]);
    const result = strategy.place({ capabilityId: PERSON }, runtimes, load, NOW);
    expect(result).toEqual({ placed: true, runtimeId: 'rt-a', moved: true });
  });

  it('⚠️ keeps a still-valid current placement — hot assignment must not move a running camera', () => {
    const runtimes = [healthy('rt-a'), healthy('rt-b')];
    const load = new Map([
      ['rt-a', 3],
      ['rt-b', 1],
    ]);
    const result = strategy.place(
      { capabilityId: PERSON, currentRuntimeId: 'rt-a' },
      runtimes,
      load,
      NOW,
    );
    expect(result).toEqual({ placed: true, runtimeId: 'rt-a', moved: false });
  });

  it('refuses when every runtime is at capacity', () => {
    const runtimes = [healthy('rt-a', 1)];
    const result = strategy.place({ capabilityId: PERSON }, runtimes, new Map([['rt-a', 1]]), NOW);
    expect(result).toEqual({ placed: false, failure: 'capacity-exceeded' });
  });

  it('⚠️ refuses a capability no runtime advertises rather than accepting a camera that produces nothing', () => {
    const runtimes = [healthy('rt-a')];
    const result = strategy.place(
      { capabilityId: 'perception.vehicle-detection' },
      runtimes,
      new Map(),
      NOW,
    );
    expect(result).toEqual({ placed: false, failure: 'capability-unavailable' });
  });

  it('a runtime whose capabilities were never read is treated as able, not unable', () => {
    const runtimes = [healthy('rt-a', 4, null)];
    const result = strategy.place(
      { capabilityId: 'perception.vehicle-detection' },
      runtimes,
      new Map(),
      NOW,
    );
    expect(result.placed).toBe(true);
  });

  it('re-pinning a camera to the runtime it already occupies is not a capacity failure', () => {
    const runtimes = [healthy('rt-a', 1)];
    const result = strategy.place(
      { capabilityId: PERSON, pinnedRuntimeId: 'rt-a', currentRuntimeId: 'rt-a' },
      runtimes,
      new Map([['rt-a', 1]]),
      NOW,
    );
    expect(result).toEqual({ placed: true, runtimeId: 'rt-a', moved: false });
  });

  it('distinguishes no-runtime-registered from no-healthy-runtime from runtime-disabled', () => {
    expect(strategy.place({ capabilityId: PERSON }, [], new Map(), NOW)).toEqual({
      placed: false,
      failure: 'no-runtime-registered',
    });
    const off = runtimeDoc('rt-a', { enabled: false });
    expect(strategy.place({ capabilityId: PERSON }, [off], new Map(), NOW)).toEqual({
      placed: false,
      failure: 'runtime-disabled',
    });
    const busy = runtimeDoc('rt-a', { health: 'busy', observedAt: NOW.toISOString() });
    expect(strategy.place({ capabilityId: PERSON }, [busy], new Map(), NOW)).toEqual({
      placed: false,
      failure: 'no-healthy-runtime',
    });
  });

  it('⚠️ available capacity is null when nobody declared one — not zero', () => {
    const undeclared = [runtimeDoc('rt-a', { maxCameras: 0 })];
    expect(availableCapacity(undeclared, new Map(), NOW)).toBeNull();
    expect(remainingCapacity(undeclared[0] as RuntimeDoc, 5)).toBeNull();
    expect(availableCapacity([healthy('rt-a', 4)], new Map([['rt-a', 1]]), NOW)).toBe(3);
  });
});

describe('P-8.6 · the licensing extension point', () => {
  it('⚠️ allows everything on a deployment with no limits configured', () => {
    const decision = checkAssignmentLimits('ai-cameras', 10_000, 1);
    expect(decision).toEqual({ allowed: true, limit: null });
  });

  it('refuses once a ceiling is supplied, naming the resource', () => {
    const decision = checkAssignmentLimits('ai-cameras', 4, 1, {
      maxAiCameras: 4,
      maxActiveRuntimes: null,
      maxProcessingProfiles: null,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.message).toContain('4');
  });
});

describe('P-8.6 · profile support is derived, and unknown is not false', () => {
  it('⚠️ returns null when no runtime has ever been observed', () => {
    expect(profileSupported({ capabilities: [PERSON] }, [null, null])).toBeNull();
  });

  it('reports the seeded catalogue honestly against a single-capability runtime', () => {
    const advertised = [[PERSON]];
    const supported = BUILT_IN_PROFILES.filter((p) => profileSupported(p, advertised) === true);
    const unsupported = BUILT_IN_PROFILES.filter((p) => profileSupported(p, advertised) === false);
    expect(supported.map((p) => p.id)).toEqual([
      'disabled',
      'person-tracking',
      'retail-monitoring',
    ]);
    expect(unsupported.map((p) => p.id)).toEqual([
      'queue-analytics',
      'vehicle-analytics',
      'safety-monitoring',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The control plane
// ---------------------------------------------------------------------------------------------

interface Harness {
  service: AssignmentService;
  runtimes: Collection<RuntimeDoc>;
  assignments: Collection<AssignmentDoc>;
  history: Collection<HistoryDoc>;
  facts: Collection<ProcessingFactsDoc>;
  cameras: Collection<CameraDoc>;
  clock: { now: () => Date };
}

function harness(cameraIds: string[] = ['cam1', 'cam2', 'cam3']): Harness {
  let time = NOW.getTime();
  const clock = {
    now: () => new Date(time),
    advance: (ms: number) => {
      time += ms;
    },
  };
  const cameras = memoryCollection<CameraDoc>(
    cameraIds.flatMap((id) =>
      [TENANT, OTHER].map(
        (tenantId) =>
          ({
            _id: tenantId === TENANT ? id : `${id}_b`,
            tenantId,
            zoneId: 'z1',
            name: id,
            protocol: 'rtsp',
            streamUrl: `rtsp://host/${id}`,
            status: 'enabled',
            capture: { ptz: false },
            health: { status: 'unknown' },
            credentialCipher: null,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          }) as CameraDoc,
      ),
    ),
  );
  const assignments = memoryCollection<AssignmentDoc>();
  const runtimes = memoryCollection<RuntimeDoc>();
  const history = memoryCollection<HistoryDoc>();
  const facts = memoryCollection<ProcessingFactsDoc>();
  let n = 0;
  const service = new AssignmentService({
    assignments,
    profiles: memoryCollection<ProfileDoc>(),
    runtimes,
    history,
    groups: memoryCollection<GroupDoc>(),
    facts,
    meta: memoryCollection<MetaDoc>(),
    cameras: new TenantRepository(cameras),
    clock,
    ids: { historyId: () => `h${(n += 1)}` },
  });
  return { service, runtimes, assignments, history, facts, cameras, clock };
}

async function withRuntime(h: Harness, id = 'rt1', maxCameras = 4): Promise<void> {
  await h.service.registerRuntime({ id, name: id, url: `http://${id}:8085`, maxCameras }, 'op');
  await h.service.report({
    reportedBy: 'media',
    at: NOW.toISOString(),
    planVersion: null,
    runtimes: [{ runtimeId: id, health: 'healthy', latencyMs: 3, capabilities: [PERSON] }],
    cameras: [],
  });
}

describe('P-8.6 · the control plane', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('seeds the built-in catalogue on first read, idempotently', async () => {
    const first = await h.service.listProfiles(scope);
    const second = await h.service.listProfiles(scope);
    expect(first).toHaveLength(BUILT_IN_PROFILES.length);
    expect(second).toHaveLength(BUILT_IN_PROFILES.length);
    expect(first.every((p) => p.builtIn)).toBe(true);
  });

  it('⚠️ reports every camera, including ones nobody has ever assigned', async () => {
    const list = await h.service.listAssignments(scope);
    expect(list).toHaveLength(3);
    expect(list.every((a) => a.state === 'unassigned' && a.aiEnabled === false)).toBe(true);
  });

  it('enable → assigned → starting, and the plan carries it', async () => {
    await withRuntime(h);
    const assignment = await h.service.enable(scope, 'cam1', {
      profileId: 'person-tracking',
      actor: 'op',
    });
    expect(assignment.state).toBe('starting');
    expect(assignment.aiEnabled).toBe(true);
    expect(assignment.runtimeId).toBe('rt1');

    const plan = await h.service.plan();
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      cameraId: 'cam1',
      intent: 'process',
      capabilityId: PERSON,
      runtimeUrl: 'http://rt1:8085',
    });
    expect(plan.version).toBeGreaterThan(0);
  });

  it('⚠️ only an observation makes a camera running — publishing a plan does not', async () => {
    await withRuntime(h);
    await h.service.enable(scope, 'cam1', { profileId: 'person-tracking', actor: 'op' });
    expect((await h.service.getAssignment(scope, 'cam1')).state).toBe('starting');

    await h.service.report({
      reportedBy: 'media',
      at: NOW.toISOString(),
      planVersion: 99,
      runtimes: [],
      cameras: [{ tenantId: TENANT, cameraId: 'cam1', state: 'active', runtimeId: 'rt1' }],
    });
    const after = await h.service.getAssignment(scope, 'cam1');
    expect(after.state).toBe('running');
    expect(after.observed.state).toBe('active');
  });

  it('pause holds the camera in the plan; stop releases it and only then is it stopped', async () => {
    await withRuntime(h);
    await h.service.enable(scope, 'cam1', { profileId: 'person-tracking', actor: 'op' });

    await h.service.act(scope, 'cam1', 'pause', { actor: 'op' });
    let plan = await h.service.plan();
    expect(plan.entries[0]?.intent).toBe('hold');

    await h.service.act(scope, 'cam1', 'disable', { actor: 'op' });
    expect((await h.service.getAssignment(scope, 'cam1')).state).toBe('stopping');
    plan = await h.service.plan();
    expect(plan.entries[0]?.intent).toBe('release');

    await h.service.report({
      reportedBy: 'media',
      at: NOW.toISOString(),
      planVersion: null,
      runtimes: [],
      cameras: [{ tenantId: TENANT, cameraId: 'cam1', state: 'released', runtimeId: null }],
    });
    expect((await h.service.getAssignment(scope, 'cam1')).state).toBe('stopped');
    expect((await h.service.plan()).entries).toHaveLength(0);
  });

  it('⚠️ a profile change on a running camera keeps it running and does not bump the epoch', async () => {
    await withRuntime(h);
    await h.service.enable(scope, 'cam1', { profileId: 'person-tracking', actor: 'op' });
    await h.service.report({
      reportedBy: 'media',
      at: NOW.toISOString(),
      planVersion: null,
      runtimes: [],
      cameras: [{ tenantId: TENANT, cameraId: 'cam1', state: 'active', runtimeId: 'rt1' }],
    });
    const before = await h.service.getAssignment(scope, 'cam1');

    const hot = await h.service.enable(scope, 'cam1', {
      profileId: 'retail-monitoring',
      actor: 'op',
    });
    expect(hot.state).toBe('running');
    expect(hot.profileId).toBe('retail-monitoring');
    expect(hot.sessionEpoch).toBe(before.sessionEpoch);
  });

  it('⚠️ changing ONE camera leaves every other camera untouched — hot assignment', async () => {
    await withRuntime(h);
    for (const id of ['cam1', 'cam2', 'cam3']) {
      await h.service.enable(scope, id, { profileId: 'person-tracking', actor: 'op' });
    }
    const before = await h.service.listAssignments(scope);
    await h.service.act(scope, 'cam2', 'pause', { actor: 'op' });
    const after = await h.service.listAssignments(scope);

    for (const id of ['cam1', 'cam3']) {
      const b = before.find((a) => a.cameraId === id);
      const a = after.find((x) => x.cameraId === id);
      expect(a?.state).toBe(b?.state);
      expect(a?.version).toBe(b?.version);
      expect(a?.sessionEpoch).toBe(b?.sessionEpoch);
    }
    expect(after.find((a) => a.cameraId === 'cam2')?.state).toBe('paused');
  });

  it('refuses an enable when no runtime is registered, naming the reason', async () => {
    await expect(
      h.service.enable(scope, 'cam1', { profileId: 'person-tracking', actor: 'op' }),
    ).rejects.toThrow(/no AI runtime is registered/);
    /* ⚠️ Nothing was written — a rejected request leaves no junk assignment behind. */
    expect((await h.service.getAssignment(scope, 'cam1')).state).toBe('unassigned');
  });

  it('refuses a profile no runtime can run, rather than accepting a camera that produces nothing', async () => {
    await withRuntime(h);
    await expect(
      h.service.enable(scope, 'cam1', { profileId: 'vehicle-analytics', actor: 'op' }),
    ).rejects.toThrow(/no runtime advertises/);
  });

  it('refuses to exceed a runtime capacity', async () => {
    await withRuntime(h, 'rt1', 1);
    await h.service.enable(scope, 'cam1', { profileId: 'person-tracking', actor: 'op' });
    await expect(
      h.service.enable(scope, 'cam2', { profileId: 'person-tracking', actor: 'op' }),
    ).rejects.toThrow(/capacity/);
  });

  it('⚠️ moves cameras off a runtime observed offline, and only those cameras', async () => {
    await withRuntime(h, 'rt1', 4);
    await withRuntime(h, 'rt2', 4);
    await h.service.enable(scope, 'cam1', {
      profileId: 'person-tracking',
      runtimeId: 'rt1',
      actor: 'op',
    });
    await h.service.enable(scope, 'cam2', {
      profileId: 'person-tracking',
      runtimeId: 'rt2',
      actor: 'op',
    });
    const cam2Before = await h.service.getAssignment(scope, 'cam2');

    const outcome = await h.service.report({
      reportedBy: 'media',
      at: NOW.toISOString(),
      planVersion: null,
      runtimes: [{ runtimeId: 'rt1', health: 'offline', latencyMs: null, capabilities: null }],
      cameras: [],
    });

    expect(outcome.failover).toBe(1);
    const cam1 = await h.service.getAssignment(scope, 'cam1');
    expect(cam1.runtimeId).toBe('rt2');
    expect(cam1.state).toBe('recovering');
    /* ⚠️ The camera on the healthy runtime was not touched. */
    const cam2 = await h.service.getAssignment(scope, 'cam2');
    expect(cam2.runtimeId).toBe('rt2');
    expect(cam2.version).toBe(cam2Before.version);
  });

  /**
   * ⚠️ **The deployment verification found this; the unit suite did not have it.**
   *
   * A camera parked in `error` while every runtime was down stayed in `error` for ever once one came
   * back, because the failover sweep only looked at cameras whose runtime had become unusable — and
   * a stranded camera's runtime was, by then, perfectly usable. It waited for an operator who had no
   * reason to know they were needed.
   */
  it('⚠️ recovers a stranded camera on its own when a runtime comes back', async () => {
    await withRuntime(h, 'rt1', 4);
    await h.service.enable(scope, 'cam1', { profileId: 'person-tracking', actor: 'op' });

    /* Every runtime goes away — the camera has nowhere to go. */
    await h.service.report({
      reportedBy: 'media',
      at: NOW.toISOString(),
      planVersion: null,
      runtimes: [{ runtimeId: 'rt1', health: 'offline', latencyMs: null, capabilities: null }],
      cameras: [],
    });
    expect((await h.service.getAssignment(scope, 'cam1')).state).toBe('error');

    /* It comes back. Nobody clicks anything. */
    await h.service.report({
      reportedBy: 'media',
      at: NOW.toISOString(),
      planVersion: null,
      runtimes: [{ runtimeId: 'rt1', health: 'healthy', latencyMs: 3, capabilities: [PERSON] }],
      cameras: [],
    });
    const recovered = await h.service.getAssignment(scope, 'cam1');
    expect(recovered.state).toBe('recovering');
    expect(recovered.runtimeId).toBe('rt1');
    expect(recovered.placementFailure).toBeNull();
  });

  it('parks a camera in error when failover has nowhere to put it', async () => {
    await withRuntime(h, 'rt1', 4);
    await h.service.enable(scope, 'cam1', { profileId: 'person-tracking', actor: 'op' });
    const outcome = await h.service.report({
      reportedBy: 'media',
      at: NOW.toISOString(),
      planVersion: null,
      runtimes: [{ runtimeId: 'rt1', health: 'offline', latencyMs: null, capabilities: null }],
      cameras: [],
    });
    expect(outcome.failed).toBe(1);
    const cam1 = await h.service.getAssignment(scope, 'cam1');
    expect(cam1.state).toBe('error');
    expect(cam1.placementFailure).toBe('no-healthy-runtime');
    expect(cam1.lastError).toMatch(/healthy/);
  });

  it('⚠️ a bulk operation with one bad item writes NOTHING', async () => {
    await withRuntime(h);
    const result = await h.service.bulk(
      scope,
      {
        operation: 'enable',
        cameraIds: ['cam1', 'cam2', 'nope'],
        profileId: 'person-tracking',
      },
      'op',
    );
    expect(result.applied).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.partial).toBe(false);
    for (const id of ['cam1', 'cam2']) {
      expect((await h.service.getAssignment(scope, id)).state).toBe('unassigned');
    }
  });

  it('applies a valid bulk operation to every camera and bumps the plan once', async () => {
    await withRuntime(h);
    const before = (await h.service.plan()).version;
    const result = await h.service.bulk(
      scope,
      { operation: 'enable', cameraIds: ['cam1', 'cam2'], profileId: 'person-tracking' },
      'op',
    );
    expect(result.applied).toBe(2);
    expect(result.partial).toBe(false);
    expect((await h.service.plan()).version).toBe(before + 1);
  });

  it('appends an immutable history entry per transition, newest first, with the actor', async () => {
    await withRuntime(h);
    await h.service.enable(scope, 'cam1', { profileId: 'person-tracking', actor: 'priya' });
    await h.service.act(scope, 'cam1', 'pause', { actor: 'sam', note: 'engineer under the till' });
    const history = await h.service.listHistory(scope, { cameraId: 'cam1' });
    expect(history[0]?.action).toBe('pause');
    expect(history[0]?.actor).toBe('sam');
    expect(history[0]?.note).toBe('engineer under the till');
    expect(history.map((e) => e.action)).toContain('assign');
    expect(history.every((e) => e.tenantId === TENANT)).toBe(true);
  });

  it('⚠️ never lets one tenant address another tenant’s camera', async () => {
    await withRuntime(h);
    await h.service.enable(scope, 'cam1', { profileId: 'person-tracking', actor: 'op' });
    await expect(h.service.getAssignment(otherScope, 'cam1')).rejects.toThrow(/no camera/);
    const otherList = await h.service.listAssignments(otherScope);
    expect(otherList.every((a) => a.tenantId === OTHER)).toBe(true);
    expect(otherList.every((a) => a.state === 'unassigned')).toBe(true);
  });

  it('capacity reports idle cameras, utilization and a suggestion from the same placement code', async () => {
    await withRuntime(h, 'rt1', 4);
    await h.service.enable(scope, 'cam1', { profileId: 'person-tracking', actor: 'op' });
    const report = await h.service.capacity(scope);
    expect(report.totalCameras).toBe(3);
    expect(report.assignedCameras).toBe(1);
    expect(report.idleCameras).toBe(2);
    expect(report.availableCapacity).toBe(3);
    expect(report.runtimes[0]).toMatchObject({
      runtimeId: 'rt1',
      assignedCameras: 1,
      remaining: 3,
    });
    expect(report.runtimes[0]?.utilization).toBeCloseTo(0.25);
    expect(report.limits).toEqual({
      maxAiCameras: null,
      maxActiveRuntimes: null,
      maxProcessingProfiles: null,
    });
  });

  it('⚠️ utilization is null for a runtime that declares no capacity — not Infinity, not 100%', async () => {
    await h.service.registerRuntime(
      { id: 'rt0', name: 'rt0', url: 'http://rt0', maxCameras: 0 },
      'op',
    );
    const report = await h.service.capacity(scope);
    expect(report.runtimes[0]?.utilization).toBeNull();
    expect(report.runtimes[0]?.remaining).toBeNull();
    expect(report.availableCapacity).toBeNull();
  });

  it('⚠️ assignment latency is null until a round trip completes — never 0', async () => {
    const cold = await h.service.metrics();
    expect(cold.assignmentLatencyMs).toBeNull();
    expect(cold.assignedCameras).toBe(0);
  });

  /**
   * ⚠️ **The benchmark ladder found this; nothing else could have.**
   *
   * The first version sampled latency on *every* report where the enforcement point was up to date,
   * which measures "time since the last change" rather than "time to apply one". On a quiet
   * deployment that grows without bound — and the tell is that it *falls* as load rises, because
   * more changes means a more recent baseline. The ladder reported 588 s at one camera falling to
   * 196 s at sixteen.
   */
  /**
   * ⚠️ **The second wrong version, also found by the ladder.** Sampling from the meta document's
   * `versionAt` meant the first report after a RESTART measured the age of the last change ever
   * made. One poisoned sample dominated a rolling mean of a hundred: 89 s at one camera.
   */
  it('⚠️ a restarted control plane reports NO latency until it accepts a change', async () => {
    await withRuntime(h);
    await h.service.enable(scope, 'cam1', { profileId: 'person-tracking', actor: 'op' });
    const version = (await h.service.plan()).version;

    /* A fresh process over the SAME database — the plan version is old, and it is not ours. */
    const restarted = harness();
    (restarted.clock as { advance: (ms: number) => void }).advance(3_600_000);
    await restarted.service.report({
      reportedBy: 'media',
      at: NOW.toISOString(),
      planVersion: version + 100,
      runtimes: [],
      cameras: [],
    });
    expect((await restarted.service.metrics()).assignmentLatencyMs).toBeNull();
  });

  it('⚠️ samples assignment latency ONCE per plan version, not once per report', async () => {
    await withRuntime(h);
    await h.service.enable(scope, 'cam1', { profileId: 'person-tracking', actor: 'op' });
    const version = (await h.service.plan()).version;

    const report = async () =>
      h.service.report({
        reportedBy: 'media',
        at: NOW.toISOString(),
        planVersion: version,
        runtimes: [],
        cameras: [{ tenantId: TENANT, cameraId: 'cam1', state: 'active', runtimeId: 'rt1' }],
      });

    (h.clock as { advance: (ms: number) => void }).advance(1_000);
    await report();
    const first = (await h.service.metrics()).assignmentLatencyMs;
    expect(first).not.toBeNull();

    /* Time passes with nothing changing. A per-report sample would climb; a per-version one holds. */
    (h.clock as { advance: (ms: number) => void }).advance(600_000);
    await report();
    await report();
    expect((await h.service.metrics()).assignmentLatencyMs).toBe(first);
  });

  it('refuses to delete a built-in profile, or one a camera is bound to', async () => {
    await withRuntime(h);
    await expect(h.service.deleteProfile(scope, 'person-tracking')).rejects.toThrow(/built-in/);
    await h.service.createProfile(
      scope,
      { id: 'mine', name: 'Mine', capabilities: [PERSON] },
      'op',
    );
    await h.service.enable(scope, 'cam1', { profileId: 'mine', actor: 'op' });
    await expect(h.service.deleteProfile(scope, 'mine')).rejects.toThrow(/assigned to 1 camera/);
  });

  /**
   * ⚠️ A deleted camera's assignment keeps counting against its runtime's capacity for ever. An
   * estate that churns cameras slowly loses the ability to place new ones, with a capacity page that
   * looks full and a camera list that does not explain it.
   */
  it('⚠️ drops assignments whose camera no longer exists', async () => {
    await withRuntime(h);
    await h.service.enable(scope, 'cam1', { profileId: 'person-tracking', actor: 'op' });
    expect((await h.service.capacity(scope)).assignedCameras).toBe(1);

    /* The camera is deleted out from under the assignment, as `DELETE /cameras/:id` does. */
    await h.cameras.deleteOne({ _id: 'cam1' } as never);
    await h.service.report({
      reportedBy: 'media',
      at: NOW.toISOString(),
      planVersion: null,
      runtimes: [],
      cameras: [],
    });

    expect((await h.service.capacity(scope)).assignedCameras).toBe(0);
    expect((await h.service.plan()).entries).toHaveLength(0);
  });

  it('re-places cameras when their runtime is deregistered rather than dropping them', async () => {
    await withRuntime(h, 'rt1', 4);
    await withRuntime(h, 'rt2', 4);
    await h.service.enable(scope, 'cam1', {
      profileId: 'person-tracking',
      runtimeId: 'rt1',
      actor: 'op',
    });
    const outcome = await h.service.removeRuntime('rt1', 'op');
    expect(outcome).toEqual({ reassigned: 1, failed: 0 });
    expect((await h.service.getAssignment(scope, 'cam1')).runtimeId).toBe('rt2');
  });

  it('stores camera groups without letting anything read them for a decision', async () => {
    const group = await h.service.createGroup(
      scope,
      { id: 'cash-counters', name: 'Cash Counters', cameraIds: ['cam1', 'cam2'] },
      'op',
    );
    expect(group.cameraIds).toEqual(['cam1', 'cam2']);
    expect(await h.service.listGroups(scope)).toHaveLength(1);
    expect(await h.service.listGroups(otherScope)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The camera capability matrix (§ Architect rec 1)
// ---------------------------------------------------------------------------------------------

describe('P-8.6 · the camera capability matrix', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('⚠️ every capability is UNKNOWN before anything reports — never false', async () => {
    const matrix = await h.service.capabilityMatrix(scope, 'cam1');
    expect(matrix.recording).toMatchObject({ available: null, evidence: 'unknown' });
    expect(matrix.tracking).toMatchObject({ available: null, evidence: 'unknown' });
    expect(matrix.events).toMatchObject({ available: null, evidence: 'unknown' });
    expect(matrix.aiHealth).toMatchObject({ available: null, evidence: 'unknown' });
    /* ⚠️ The exception, and it is honest: no assignment IS a decision somebody can read. */
    expect(matrix.aiProcessing).toMatchObject({ available: false, evidence: 'declared' });
    expect(matrix.assignment).toEqual({ state: 'unassigned', profileId: null, runtimeId: null });
  });

  it('⚠️ reports recording for a camera with NO assignment — the two axes are independent', async () => {
    await h.service.report({
      reportedBy: 'media',
      at: NOW.toISOString(),
      planVersion: null,
      runtimes: [],
      cameras: [
        {
          tenantId: TENANT,
          cameraId: 'cam1',
          state: 'idle',
          runtimeId: null,
          recording: true,
          recordingHealth: 'healthy',
        },
      ],
    });
    const matrix = await h.service.capabilityMatrix(scope, 'cam1');
    expect(matrix.recording).toMatchObject({ available: true, evidence: 'measured' });
    expect(matrix.recordingHealth).toMatchObject({ available: true, evidence: 'measured' });
    expect(matrix.aiProcessing.available).toBe(false);
  });

  it('⚠️ an authorised camera nothing has confirmed reads DECLARED, not measured', async () => {
    await withRuntime(h);
    await h.service.enable(scope, 'cam1', { profileId: 'person-tracking', actor: 'op' });
    const matrix = await h.service.capabilityMatrix(scope, 'cam1');
    expect(matrix.aiProcessing).toMatchObject({ available: true, evidence: 'declared' });

    await h.service.report({
      reportedBy: 'media',
      at: NOW.toISOString(),
      planVersion: null,
      runtimes: [],
      cameras: [{ tenantId: TENANT, cameraId: 'cam1', state: 'active', runtimeId: 'rt1' }],
    });
    const confirmed = await h.service.capabilityMatrix(scope, 'cam1');
    expect(confirmed.aiProcessing).toMatchObject({ available: true, evidence: 'measured' });
  });

  it('⚠️ disowns a measurement past the TTL rather than presenting it confidently', async () => {
    await h.service.report({
      reportedBy: 'media',
      at: NOW.toISOString(),
      planVersion: null,
      runtimes: [],
      cameras: [
        { tenantId: TENANT, cameraId: 'cam1', state: 'idle', runtimeId: null, recording: true },
      ],
    });
    expect((await h.service.capabilityMatrix(scope, 'cam1')).recording.available).toBe(true);
    (h.clock as { advance: (ms: number) => void }).advance(OBSERVATION_TTL_MS + 5_000);
    const stale = await h.service.capabilityMatrix(scope, 'cam1');
    expect(stale.recording).toMatchObject({ available: null, evidence: 'unknown' });
    expect(stale.recording.detail).toMatch(/expired/);
  });

  it('reports rules as unknown when no rule source is configured', async () => {
    const matrix = await h.service.capabilityMatrix(scope, 'cam1');
    expect(matrix.rules).toMatchObject({ available: null, evidence: 'unknown' });
  });

  it('never answers for another tenant’s camera', async () => {
    await expect(h.service.capabilityMatrix(otherScope, 'cam1')).rejects.toThrow(/no camera/);
  });
});

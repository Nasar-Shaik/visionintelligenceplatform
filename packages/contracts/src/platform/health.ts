/**
 * Platform health (P-6.4) — **what the deployment can actually be said to be doing right now.**
 *
 * ### ⚠️ The seven states already existed, and are reused rather than re-invented
 *
 * `WorkspaceDependencyState` was frozen in P-5.3 to answer exactly this question one level down: a
 * dependency that is *not built*, one that is *not configured in this deployment*, one that is *down
 * right now* and one that *nothing has exercised* are four different facts leading to four different
 * actions. That is the same distinction a System Health page exists to draw, so
 * {@link SystemComponentState} **is** that enum — the same value, aliased, not a copy. A second
 * spelling of a state machine is a second thing to keep in sync, and the first divergence would be
 * silent.
 *
 * ### ⚠️ `/health` is not evidence of health
 *
 * Every service exposes `GET /health` returning `{status:'ok'}` unconditionally: it proves a process
 * is up and its event loop turns, which is what an orchestrator needs to decide whether to restart a
 * container. It cannot fail while the process can answer, so a page built on it would be **green by
 * construction** — the exact failure this contract exists to prevent. Readiness (`GET /ready`) runs
 * the registered dependency checks and is the only probe that can say `no`.
 *
 * ### ⚠️ Infrastructure is derived, never probed directly
 *
 * Nothing here opens a socket to MongoDB. Each service already checks its own dependencies for its
 * own readiness, so the state of MongoDB is the *union of what the services say about it*. That is
 * both cheaper and more truthful: it reports the database as the platform experiences it, which is
 * the only thing an operator can act on. A component nothing reports on is `unknown` — and is never
 * rendered as healthy, because an unexercised dependency and a working one look identical from here
 * and only one of them is a claim we are entitled to make.
 */
import { z } from 'zod';
import { IsoDateTime } from '../common/primitives.js';
import { WorkspaceDependencyState } from '../workspace/health.js';

/**
 * ⚠️ **The same enum as {@link WorkspaceDependencyState}, deliberately.** Aliased for readability at
 * the call site; identical by construction, so the two surfaces cannot drift apart.
 *
 * Read as an operator would: `ready` is Healthy · `degraded` answered but partially · `unreachable`
 * is Unavailable · `not-configured` this deployment did not wire it · `not-built` no release
 * contains it · `forbidden` it is fine and you may not see it · `unknown` nothing reports on it.
 */
export const SystemComponentState = WorkspaceDependencyState;
export type SystemComponentState = z.infer<typeof SystemComponentState>;

/**
 * What kind of thing is being reported, because the three answer different questions.
 *
 * - `service` — one of the platform's own processes. Asked directly.
 * - `infrastructure` — something the services depend on. **Derived from their readiness checks**,
 *   never probed from here.
 * - `capability` — a product capability whose state is a fact about the release rather than about
 *   this morning. This is where `not-built` lives, and why an operator asking "why is there no email
 *   alert?" gets an answer instead of filing a defect.
 */
export const SystemComponentKind = z.enum(['service', 'infrastructure', 'capability']);
export type SystemComponentKind = z.infer<typeof SystemComponentKind>;

/** One dependency check as the owning service reported it. */
export const SystemComponentCheck = z.object({
  name: z.string().min(1).max(60),
  status: z.enum(['pass', 'fail']),
  detail: z.string().max(300).optional(),
});
export type SystemComponentCheck = z.infer<typeof SystemComponentCheck>;

export const SystemComponent = z.object({
  id: z.string().min(1).max(60),
  /** The word an operator reads. The one place an identifier becomes English. */
  label: z.string().min(1).max(80),
  kind: SystemComponentKind,
  state: SystemComponentState,
  /**
   * ⚠️ Required for every state except `ready` — the sentence that turns a colour into an answer.
   * "Events: unavailable" is a light; "did not answer within 2000 ms" is something to act on.
   */
  detail: z.string().min(1).max(300).optional(),
  /** The checks behind the verdict, so the page can show *why* rather than only *what*. */
  checks: z.array(SystemComponentCheck).max(20).default([]),
  /** Round trip to this component's readiness probe. Absent for anything not asked directly. */
  latencyMs: z.number().int().nonnegative().optional(),
  /** When this was observed. ⚠️ Absent ⇒ nothing has observed it — see `unknown`. */
  observedAt: IsoDateTime.optional(),
});
export type SystemComponent = z.infer<typeof SystemComponent>;

/**
 * The platform's own view of itself.
 *
 * ⚠️ `derivedAt` is when the report was assembled, which is **not** when each component was observed.
 * A single timestamp would imply everything was checked at once; `observedAt` per component is the
 * honest version, and it is what lets the page say "as of 4 seconds ago" without lying about the
 * rows it did not re-check.
 */
export const SystemHealth = z.object({
  components: z.array(SystemComponent).max(60).default([]),
  derivedAt: IsoDateTime,
  /** How long this snapshot may be reused before it is re-derived. `0` ⇒ never cached. */
  cacheTtlMs: z.number().int().nonnegative().default(0),
});
export type SystemHealth = z.infer<typeof SystemHealth>;

/**
 * Display order: what an operator can act on comes first, and the things that are fine come last.
 *
 * ⚠️ `unknown` sorts **above** `ready`, for the same reason it does in the workspace: a component
 * nothing reports on is more interesting than one that answered, because it is the one whose failure
 * has not been discovered yet.
 */
export const SYSTEM_STATE_RANK: Record<SystemComponentState, number> = {
  unreachable: 0,
  degraded: 1,
  forbidden: 2,
  'not-configured': 3,
  'not-built': 4,
  unknown: 5,
  ready: 6,
};

/**
 * ⚠️ **Product capabilities the platform does not have, stated as data.**
 *
 * These are facts about the release, not about the deployment, so no probe can discover them — and
 * an operator who cannot see them here will report their absence as a defect, or worse, assume the
 * feature is broken rather than missing. Each names the limitation that explains it, so the register
 * and the product agree.
 *
 * ⚠️ **This list may only shrink.** An entry leaves when the capability ships, and the milestone
 * that ships it is the milestone that removes the row. Adding one means admitting something was
 * claimed that was never true.
 */
export const PLATFORM_CAPABILITIES: readonly {
  id: string;
  label: string;
  state: SystemComponentState;
  detail: string;
}[] = [
  {
    id: 'live-video',
    label: 'Live video',
    state: 'not-built',
    detail:
      'No browser plays RTSP natively and the server-side repackager does not exist. The platform ' +
      'reviews recorded evidence. Planned for P-8 (L-3).',
  },
  {
    id: 'behaviour-analytics',
    label: 'Behaviour analytics',
    state: 'not-built',
    detail:
      'Person, vehicle, fire and smoke are detected. Loitering, intrusion, crowding, falls and PPE ' +
      'are not produced from video by anything. Planned for P-8 (L-2).',
  },
  {
    id: 'email-sms-delivery',
    label: 'Email and SMS delivery',
    state: 'not-built',
    detail:
      'Notifications reach the console and a webhook. There is no email, SMS, Slack or Teams ' +
      'transport. Planned for P-7 (L-4).',
  },
  {
    id: 'ai-advisor',
    label: 'AI incident advisor',
    state: 'not-built',
    detail:
      'The permission and the recommendation shape are frozen and no producer exists in any ' +
      'deployment. AI remains advisory by design: it may never mutate an incident.',
  },
  {
    id: 'global-search',
    label: 'Global search',
    state: 'not-built',
    detail: 'The search contract is frozen; no service answers it yet (TD-46).',
  },
  {
    id: 'background-jobs',
    label: 'Background jobs',
    state: 'not-built',
    detail: 'Exports and reports run inline. No job runner is deployed (TD-46).',
  },
] as const;

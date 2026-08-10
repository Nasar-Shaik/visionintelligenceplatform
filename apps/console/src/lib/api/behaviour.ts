import type {
  BehaviourGraphView,
  BehaviourPrimitivesView,
  BehaviourReasoningResult,
  BehaviourRule,
  BehaviourTimelineView,
  TrackHistoryView,
} from '@vip/contracts';
import { http } from './http';

/**
 * The behaviour surface, through the gateway (Phase 2.4 slice 2.8).
 *
 *   GET  /api/behaviour/timeline     the ordered account
 *   GET  /api/behaviour/graph        the same facts as nodes and edges
 *   GET  /api/behaviour/primitives   the same facts per identity, with the thresholds they used
 *   GET  /api/track-history          the movement paths all three are derived from (ADR-0051)
 *   POST /api/rules/rules/behaviour/evaluate   rules over the graph, with a WHY chain
 *
 * ### ⛔ Four reads of ONE computation, and the console adds no fifth
 *
 * The timeline, the graph and the primitives are three shapes of the same pass over track history —
 * `behaviour_graph.py` is built from `timeline_for`'s entries and nothing else. A console that
 * computed a dwell of its own would eventually disagree with the runtime about one, and nothing on
 * the page could say which was right. So every number this feature renders is a number one of these
 * responses carried; the browser's only arithmetic is `footage.ts`, which places a fact in the video
 * and computes no fact.
 *
 * ⚠️ **`streamId` is the analysis SESSION id (`ases_…`), not the analysis id (`ana_…`).** Track
 * history is keyed per run, because ADR-0047 makes two runs of one recording two independent answers
 * — a lesson this project learned by having them share a history and silently merge.
 */
export const behaviourApi = {
  /**
   * ⭐ `kinds` narrows the answer **in the runtime, before the entry cap**.
   *
   * ⛔ Filtering in the browser cannot recover a fact the cap already dropped: on a live camera 1207
   * of the 2000 permitted entries were `gap`, so every merge and crossing later in the run had
   * already been cut when the payload arrived. `countsByKind` on the response says what exists.
   */
  timeline: (query: {
    streamId?: string;
    cameraId?: string;
    identityId?: string;
    kinds?: string;
  }) => http.get<BehaviourTimelineView>('/behaviour/timeline', { query }),

  graph: (query: { streamId?: string; cameraId?: string; identityId?: string }) =>
    http.get<BehaviourGraphView>('/behaviour/graph', { query }),

  primitives: (query: { streamId?: string; cameraId?: string; identityId?: string }) =>
    http.get<BehaviourPrimitivesView>('/behaviour/primitives', { query }),

  /**
   * Stored movement paths — the trajectory a graph node cannot carry.
   *
   * ⚠️ Not a duplicate source: this is the *input* the three projections above are computed from, and
   * it is the only one that holds per-frame positions. A trajectory is not a behaviour fact.
   */
  trackHistory: (query: { streamId?: string; cameraId?: string; identityId?: string }) =>
    http.get<TrackHistoryView>('/track-history', { query }),

  /**
   * Evaluate behaviour rules over the graph.
   *
   * ⚠️ Through the gateway's generic service proxy, hence the doubled segment: `/api/rules` selects
   * the service and `/rules/behaviour/evaluate` is its own route.
   *
   * ⛔ **Rules travel in the body because there is no behaviour-rule store yet** — slice 2.7's stated
   * boundary. The console composes one and sends it, which is honest: nothing on screen can be
   * mistaken for a configured rule set, because the operator had to write it.
   */
  evaluate: (input: {
    streamId?: string;
    cameraId?: string;
    identityId?: string;
    rules: BehaviourRule[];
  }) => http.post<BehaviourReasoningResult>('/rules/rules/behaviour/evaluate', input),
};

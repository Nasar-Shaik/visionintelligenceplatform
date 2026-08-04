/**
 * Demo dataset — a populated, plausible deployment for customer demonstrations (P-5.9).
 *
 * ### ⚠️ Why this exists alongside `seed.ts`
 *
 * `pnpm seed` writes the smallest self-consistent dataset that lets a developer log in: one tenant,
 * one camera called "Front Entrance", one rule, one incident. It is correct and it is deliberately
 * minimal. It is also useless for two things this milestone needs:
 *
 * 1. **A customer demonstration.** A screen with one row does not show an operator what their
 *    working day looks like, and every empty panel reads as an unfinished feature rather than an
 *    empty state.
 * 2. **A UI review.** Spacing, truncation, wrapping, density, sort order and empty-vs-populated
 *    states are only visible against realistic content. A layout that looks clean with one incident
 *    tells you nothing about the same layout with forty.
 *
 * ### ⚠️ This is demonstration data, and it says so
 *
 * Every site, camera, operator and incident below is invented. The tenant ids are prefixed `tnt_demo_`
 * and the display names are obviously fictional ("Northgate Retail Group"), because a demo dataset
 * that looks like a real customer's estate is one screenshot away from being mistaken for one.
 *
 * ### ⚠️ What it does NOT fabricate
 *
 * - **No evidence bytes.** Evidence is registered through the real evidence API by
 *   `pnpm seed:evidence`, so custody opens and the integrity hash is computed from stored bytes. A
 *   hand-written evidence row would show the Evidence Chain panel a custody log the platform never
 *   produced — a demonstration of tamper-evidence that had been bypassed.
 * - **No AI output.** No incident here carries an AI summary or recommendation, because nothing
 *   analysed them. AI is advisory and must never appear to have done work it did not do.
 * - **No camera health it cannot know.** Cameras are seeded `online` with no probe history rather
 *   than with invented latency and jitter measurements.
 *
 *   pnpm dev:stack && pnpm seed:demo          # development
 *   infra/docker/prod.sh --profile seed run --rm seed-demo   # a deployment
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { hashPassword } from '@vip/auth';
import { loadDotEnv } from '@vip/config';

loadDotEnv(resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'));

const MONGO_URI =
  process.env.MONGO_URI ??
  'mongodb://vip_dev:change_me_dev_only@localhost:47017/vip?authSource=admin';

const DEV_PASSWORD = '123456';
const MIN_PRODUCTION_PASSWORD_LENGTH = 12;

/** Same fail-closed rule as `seed.ts`: a deployment never gets the development password. */
function resolveDemoPassword(env: NodeJS.ProcessEnv): string {
  const supplied = env.SEED_PASSWORD;
  if (env.NODE_ENV !== 'production') {
    return supplied !== undefined && supplied.length > 0 ? supplied : DEV_PASSWORD;
  }
  if (supplied === undefined || supplied.length < MIN_PRODUCTION_PASSWORD_LENGTH) {
    throw new Error(
      `SEED_PASSWORD must be set to ${MIN_PRODUCTION_PASSWORD_LENGTH}+ characters when NODE_ENV=production.`,
    );
  }
  if (supplied === DEV_PASSWORD)
    throw new Error('SEED_PASSWORD must not be the development default.');
  return supplied;
}

const PASSWORD = resolveDemoPassword(process.env);

// ── time helpers ────────────────────────────────────────────────────────────────────────────────
// ⚠️ Every timestamp is relative to *now*, so the dataset never looks stale. A demonstration whose
// most recent incident is three weeks old invites the question "is this thing actually running?".
const NOW = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();
const minsAgo = (m: number): number => NOW - m * 60_000;
const hoursAgo = (h: number): number => NOW - h * 3_600_000;
const daysAgo = (d: number): number => NOW - d * 86_400_000;

/**
 * ⚠️ Deterministic pseudo-randomness, seeded per tenant. Re-running produces the same dataset, so a
 * screenshot taken today matches the demo given next week and a UI review is comparable across runs.
 */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

// ── the four verticals ──────────────────────────────────────────────────────────────────────────

interface CameraSpec {
  id: string;
  name: string;
  /** Which zone (by local key) the camera sits in. */
  zone: string;
  /** `offline` and `degraded` exist so the estate does not look implausibly perfect. */
  health?: 'online' | 'offline' | 'degraded';
}

interface ZoneSpec {
  key: string;
  name: string;
  type: 'site' | 'building' | 'floor' | 'zone';
  parent: string | null;
}

interface IncidentSpec {
  title: string;
  eventType: string;
  category: 'perception' | 'security' | 'safety' | 'analytics';
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'raised' | 'acknowledged' | 'investigating' | 'escalated' | 'resolved' | 'closed';
  camera: string;
  minutesAgo: number;
  /** Operator notes, in order. Written as an investigator would write them. */
  notes?: string[];
  assignee?: string;
  resolution?: string;
}

interface Vertical {
  tenantId: string;
  name: string;
  slug: string;
  zones: ZoneSpec[];
  cameras: CameraSpec[];
  operators: { id: string; email: string; name: string; roles: string[] }[];
  rules: {
    id: string;
    name: string;
    eventTypes: string[];
    severity: string;
    description: string;
  }[];
  incidents: IncidentSpec[];
}

const RETAIL: Vertical = {
  tenantId: 'tnt_demo_retail',
  name: 'Northgate Retail Group',
  slug: 'northgate',
  zones: [
    { key: 'site', name: 'Northgate Superstore', type: 'site', parent: null },
    { key: 'shopfloor', name: 'Shop Floor', type: 'zone', parent: 'site' },
    { key: 'electronics', name: 'Electronics Aisle', type: 'zone', parent: 'shopfloor' },
    { key: 'checkout', name: 'Checkout Lanes', type: 'zone', parent: 'shopfloor' },
    { key: 'stockroom', name: 'Stock Room', type: 'zone', parent: 'site' },
    { key: 'carpark', name: 'Customer Car Park', type: 'zone', parent: 'site' },
  ],
  cameras: [
    { id: 'cam_retail_entrance', name: 'Main Entrance', zone: 'site' },
    { id: 'cam_retail_electronics', name: 'Electronics — Aisle 4', zone: 'electronics' },
    {
      id: 'cam_retail_electronics2',
      name: 'Electronics — High Value Cabinet',
      zone: 'electronics',
    },
    { id: 'cam_retail_checkout1', name: 'Checkout — Lanes 1–4', zone: 'checkout' },
    { id: 'cam_retail_checkout2', name: 'Checkout — Self Service', zone: 'checkout' },
    { id: 'cam_retail_stockroom', name: 'Stock Room — Goods In', zone: 'stockroom' },
    {
      id: 'cam_retail_stockroom2',
      name: 'Stock Room — Rear Fire Exit',
      zone: 'stockroom',
      health: 'degraded',
    },
    { id: 'cam_retail_carpark', name: 'Car Park — North', zone: 'carpark' },
    {
      id: 'cam_retail_carpark2',
      name: 'Car Park — Trolley Bay',
      zone: 'carpark',
      health: 'offline',
    },
  ],
  operators: [
    {
      id: 'usr_demo_retail_mgr',
      email: 'security.manager@northgate.demo',
      name: 'Security Manager',
      roles: ['admin'],
    },
    {
      id: 'usr_demo_retail_op1',
      email: 'day.operator@northgate.demo',
      name: 'Day Shift Operator',
      roles: ['operator'],
    },
    {
      id: 'usr_demo_retail_op2',
      email: 'night.operator@northgate.demo',
      name: 'Night Shift Operator',
      roles: ['operator'],
    },
    {
      id: 'usr_demo_retail_loss',
      email: 'loss.prevention@northgate.demo',
      name: 'Loss Prevention',
      roles: ['viewer'],
    },
  ],
  rules: [
    {
      id: 'rule_demo_retail_theft',
      name: 'Suspected theft — high-value goods',
      eventTypes: ['behavior.theft.suspected'],
      severity: 'high',
      description:
        'Concealment behaviour detected near the high-value cabinet during trading hours.',
    },
    {
      id: 'rule_demo_retail_loiter',
      name: 'Loitering — electronics aisle',
      eventTypes: ['behavior.loitering.detected'],
      severity: 'medium',
      description: 'A person dwelling in the electronics aisle beyond the configured threshold.',
    },
    {
      id: 'rule_demo_retail_afterhours',
      name: 'After-hours presence — stock room',
      eventTypes: ['perception.person.detected'],
      severity: 'critical',
      description: 'Any person detected in the stock room outside trading hours.',
    },
    {
      id: 'rule_demo_retail_queue',
      name: 'Checkout queue exceeded',
      eventTypes: ['analytics.queue.length'],
      severity: 'low',
      description: 'Queue length at staffed checkouts above the service threshold.',
    },
  ],
  incidents: [
    {
      title: 'Suspected concealment — Electronics, high-value cabinet',
      eventType: 'behavior.theft.suspected',
      category: 'security',
      severity: 'high',
      status: 'investigating',
      camera: 'cam_retail_electronics2',
      minutesAgo: 24,
      assignee: 'loss.prevention@northgate.demo',
      notes: [
        'Reviewed the clip from 14:32. Subject removes two boxed items from the cabinet and moves out of frame toward the checkout lanes.',
        'Checkout footage for the same window shows no corresponding transaction. Escalating to the duty manager.',
      ],
    },
    {
      title: 'Loitering — Electronics Aisle 4 (11 minutes)',
      eventType: 'behavior.loitering.detected',
      category: 'security',
      severity: 'medium',
      status: 'acknowledged',
      camera: 'cam_retail_electronics',
      minutesAgo: 68,
      assignee: 'day.operator@northgate.demo',
      notes: ['Floor staff attended. Customer was comparing products; no further action.'],
    },
    {
      title: 'After-hours presence — Stock Room, Goods In',
      eventType: 'perception.person.detected',
      category: 'security',
      severity: 'critical',
      status: 'resolved',
      camera: 'cam_retail_stockroom',
      minutesAgo: 61 * 8,
      assignee: 'night.operator@northgate.demo',
      resolution:
        'Identified as a scheduled overnight delivery. Delivery window added to the rule schedule.',
      notes: [
        'Person detected at 02:14 in Goods In. No delivery was expected on the roster.',
        'Cross-checked against the delivery log — a rescheduled pallet drop. Verified with the supplier.',
      ],
    },
    {
      title: 'Checkout queue exceeded — Lanes 1–4',
      eventType: 'analytics.queue.length',
      category: 'analytics',
      severity: 'low',
      status: 'closed',
      camera: 'cam_retail_checkout1',
      minutesAgo: 61 * 26,
      resolution: 'Additional lane opened; queue cleared within 6 minutes.',
    },
    {
      title: 'Suspected concealment — Electronics Aisle 4',
      eventType: 'behavior.theft.suspected',
      category: 'security',
      severity: 'high',
      status: 'raised',
      camera: 'cam_retail_electronics',
      minutesAgo: 7,
    },
    {
      title: 'Loitering — Car Park North, trolley bay',
      eventType: 'behavior.loitering.detected',
      category: 'security',
      severity: 'low',
      status: 'raised',
      camera: 'cam_retail_carpark',
      minutesAgo: 41,
    },
  ],
};

const WAREHOUSE: Vertical = {
  tenantId: 'tnt_demo_warehouse',
  name: 'Meridian Logistics',
  slug: 'meridian',
  zones: [
    { key: 'site', name: 'Meridian DC-3', type: 'site', parent: null },
    { key: 'perimeter', name: 'Perimeter', type: 'zone', parent: 'site' },
    { key: 'yard', name: 'Loading Yard', type: 'zone', parent: 'site' },
    { key: 'warehouse', name: 'Main Warehouse', type: 'building', parent: 'site' },
    { key: 'racking', name: 'High Racking — Aisles A–F', type: 'zone', parent: 'warehouse' },
    { key: 'dispatch', name: 'Dispatch Bay', type: 'zone', parent: 'warehouse' },
  ],
  cameras: [
    { id: 'cam_wh_fence_n', name: 'Perimeter — North Fence', zone: 'perimeter' },
    { id: 'cam_wh_fence_e', name: 'Perimeter — East Fence', zone: 'perimeter' },
    { id: 'cam_wh_fence_w', name: 'Perimeter — West Fence', zone: 'perimeter', health: 'degraded' },
    { id: 'cam_wh_gate', name: 'Vehicle Gate', zone: 'perimeter' },
    { id: 'cam_wh_yard', name: 'Loading Yard — Overview', zone: 'yard' },
    { id: 'cam_wh_bay3', name: 'Loading Bay 3', zone: 'yard' },
    { id: 'cam_wh_racking_a', name: 'Racking — Aisle A', zone: 'racking' },
    { id: 'cam_wh_racking_d', name: 'Racking — Aisle D', zone: 'racking' },
    { id: 'cam_wh_dispatch', name: 'Dispatch Bay — Outbound', zone: 'dispatch' },
    { id: 'cam_wh_forklift', name: 'Forklift Crossing', zone: 'warehouse' },
  ],
  operators: [
    {
      id: 'usr_demo_wh_mgr',
      email: 'site.manager@meridian.demo',
      name: 'Site Manager',
      roles: ['admin'],
    },
    {
      id: 'usr_demo_wh_guard',
      email: 'gatehouse@meridian.demo',
      name: 'Gatehouse',
      roles: ['operator'],
    },
    {
      id: 'usr_demo_wh_hse',
      email: 'hse.officer@meridian.demo',
      name: 'HSE Officer',
      roles: ['operator'],
    },
  ],
  rules: [
    {
      id: 'rule_demo_wh_intrusion',
      name: 'Perimeter intrusion — out of hours',
      eventTypes: ['security.intrusion.detected'],
      severity: 'critical',
      description: 'A person crossing the perimeter line outside operating hours.',
    },
    {
      id: 'rule_demo_wh_ppe',
      name: 'PPE violation — high-vis required',
      eventTypes: ['safety.ppe.violation'],
      severity: 'high',
      description: 'A person in the yard or racking aisles without high-visibility clothing.',
    },
    {
      id: 'rule_demo_wh_vehicle',
      name: 'Unauthorised vehicle — after hours',
      eventTypes: ['perception.vehicle.detected'],
      severity: 'high',
      description: 'A vehicle in the loading yard outside the booked delivery schedule.',
    },
  ],
  incidents: [
    {
      title: 'Perimeter intrusion — North Fence',
      eventType: 'security.intrusion.detected',
      category: 'security',
      severity: 'critical',
      status: 'investigating',
      camera: 'cam_wh_fence_n',
      minutesAgo: 38,
      assignee: 'gatehouse@meridian.demo',
      notes: [
        'Line crossing at 23:47 on the north fence, moving south toward the yard.',
        'Yard overview picks up the same subject 90 seconds later heading for Bay 3. Police notified.',
      ],
    },
    {
      title: 'PPE violation — no high-vis, Loading Yard',
      eventType: 'safety.ppe.violation',
      category: 'safety',
      severity: 'high',
      status: 'acknowledged',
      camera: 'cam_wh_yard',
      minutesAgo: 96,
      assignee: 'hse.officer@meridian.demo',
      notes: ['Driver left the cab without high-vis. Toolbox talk logged against the haulier.'],
    },
    {
      title: 'Unauthorised vehicle — Loading Yard, out of schedule',
      eventType: 'perception.vehicle.detected',
      category: 'security',
      severity: 'high',
      status: 'resolved',
      camera: 'cam_wh_bay3',
      minutesAgo: 61 * 14,
      resolution: 'Contractor van; booking had not been entered on the gate system.',
    },
    {
      title: 'Perimeter intrusion — East Fence',
      eventType: 'security.intrusion.detected',
      category: 'security',
      severity: 'critical',
      status: 'raised',
      camera: 'cam_wh_fence_e',
      minutesAgo: 12,
    },
    {
      title: 'PPE violation — Racking Aisle D',
      eventType: 'safety.ppe.violation',
      category: 'safety',
      severity: 'medium',
      status: 'closed',
      camera: 'cam_wh_racking_d',
      minutesAgo: 61 * 40,
      resolution: 'Agency staff member; inducted and issued PPE.',
    },
  ],
};

const SCHOOL: Vertical = {
  tenantId: 'tnt_demo_school',
  name: 'Ashford Academy Trust',
  slug: 'ashford',
  zones: [
    { key: 'site', name: 'Ashford Academy', type: 'site', parent: null },
    { key: 'main', name: 'Main Building', type: 'building', parent: 'site' },
    { key: 'science', name: 'Science Block', type: 'building', parent: 'site' },
    { key: 'labstore', name: 'Chemical Store', type: 'zone', parent: 'science' },
    { key: 'grounds', name: 'Grounds', type: 'zone', parent: 'site' },
    { key: 'plant', name: 'Plant Room', type: 'zone', parent: 'main' },
  ],
  cameras: [
    { id: 'cam_sch_reception', name: 'Reception', zone: 'main' },
    { id: 'cam_sch_corridor', name: 'Main Corridor', zone: 'main' },
    { id: 'cam_sch_science', name: 'Science Block — Entrance', zone: 'science' },
    { id: 'cam_sch_labstore', name: 'Chemical Store — Door', zone: 'labstore' },
    { id: 'cam_sch_plant', name: 'Plant Room — Access', zone: 'plant' },
    { id: 'cam_sch_gate', name: 'Main Gate', zone: 'grounds' },
    { id: 'cam_sch_field', name: 'Playing Field', zone: 'grounds', health: 'offline' },
  ],
  operators: [
    {
      id: 'usr_demo_sch_head',
      email: 'site.lead@ashford.demo',
      name: 'Site Lead',
      roles: ['admin'],
    },
    {
      id: 'usr_demo_sch_recep',
      email: 'reception@ashford.demo',
      name: 'Reception',
      roles: ['viewer'],
    },
    {
      id: 'usr_demo_sch_care',
      email: 'caretaker@ashford.demo',
      name: 'Caretaker',
      roles: ['operator'],
    },
  ],
  rules: [
    {
      id: 'rule_demo_sch_restricted',
      name: 'Restricted area entry — Chemical Store',
      eventTypes: ['security.intrusion.detected'],
      severity: 'critical',
      description: 'Any entry to the chemical store outside authorised staff hours.',
    },
    {
      id: 'rule_demo_sch_plant',
      name: 'Restricted area entry — Plant Room',
      eventTypes: ['security.intrusion.detected'],
      severity: 'high',
      description: 'Any entry to the plant room by an unrecognised person.',
    },
    {
      id: 'rule_demo_sch_outofhours',
      name: 'Out-of-hours presence — grounds',
      eventTypes: ['perception.person.detected'],
      severity: 'medium',
      description: 'A person on the grounds outside the school day and booked lettings.',
    },
  ],
  incidents: [
    {
      title: 'Restricted area entry — Chemical Store door',
      eventType: 'security.intrusion.detected',
      category: 'security',
      severity: 'critical',
      status: 'investigating',
      camera: 'cam_sch_labstore',
      minutesAgo: 19,
      assignee: 'site.lead@ashford.demo',
      notes: [
        'Door opened at 16:41, twenty minutes after the science block was due to be locked.',
        'Corridor camera shows the same person arriving from reception. Checking the signing-in record.',
      ],
    },
    {
      title: 'Restricted area entry — Plant Room',
      eventType: 'security.intrusion.detected',
      category: 'security',
      severity: 'high',
      status: 'resolved',
      camera: 'cam_sch_plant',
      minutesAgo: 61 * 30,
      resolution: 'Contracted heating engineer, attendance confirmed against the works order.',
    },
    {
      title: 'Out-of-hours presence — Playing Field',
      eventType: 'perception.person.detected',
      category: 'security',
      severity: 'medium',
      status: 'closed',
      camera: 'cam_sch_gate',
      minutesAgo: 61 * 52,
      resolution: 'Booked community football letting. Letting hours added to the rule schedule.',
    },
  ],
};

const HOSPITAL: Vertical = {
  tenantId: 'tnt_demo_hospital',
  name: 'St Aldate’s Hospital',
  slug: 'st-aldates',
  zones: [
    { key: 'site', name: 'St Aldate’s Hospital', type: 'site', parent: null },
    { key: 'ed', name: 'Emergency Department', type: 'building', parent: 'site' },
    { key: 'edwait', name: 'ED Waiting Area', type: 'zone', parent: 'ed' },
    { key: 'ward', name: 'Ward 4 — Elderly Care', type: 'zone', parent: 'site' },
    { key: 'pharmacy', name: 'Pharmacy Store', type: 'zone', parent: 'site' },
    { key: 'carpark', name: 'Visitor Car Park', type: 'zone', parent: 'site' },
  ],
  cameras: [
    { id: 'cam_hosp_ed_entrance', name: 'ED — Ambulance Entrance', zone: 'ed' },
    { id: 'cam_hosp_ed_wait', name: 'ED — Waiting Area', zone: 'edwait' },
    { id: 'cam_hosp_ed_triage', name: 'ED — Triage Corridor', zone: 'ed' },
    { id: 'cam_hosp_ward_corridor', name: 'Ward 4 — Corridor', zone: 'ward' },
    { id: 'cam_hosp_ward_bay', name: 'Ward 4 — Bay 2', zone: 'ward' },
    { id: 'cam_hosp_pharmacy', name: 'Pharmacy Store — Door', zone: 'pharmacy' },
    { id: 'cam_hosp_carpark', name: 'Visitor Car Park', zone: 'carpark', health: 'degraded' },
  ],
  operators: [
    {
      id: 'usr_demo_hosp_sec',
      email: 'security.lead@staldates.demo',
      name: 'Security Lead',
      roles: ['admin'],
    },
    {
      id: 'usr_demo_hosp_ctrl',
      email: 'control.room@staldates.demo',
      name: 'Control Room',
      roles: ['operator'],
    },
    {
      id: 'usr_demo_hosp_matron',
      email: 'ward.matron@staldates.demo',
      name: 'Ward Matron',
      roles: ['viewer'],
    },
  ],
  rules: [
    {
      id: 'rule_demo_hosp_fall',
      name: 'Patient fall detected — Ward 4',
      eventTypes: ['behavior.fall.detected'],
      severity: 'critical',
      description: 'A fall detected in a ward corridor or bay. Immediate clinical response.',
    },
    {
      id: 'rule_demo_hosp_aggression',
      name: 'Aggression — Emergency Department',
      eventTypes: ['behavior.fight.detected'],
      severity: 'critical',
      description: 'Physical altercation detected in the ED waiting area or triage corridor.',
    },
    {
      id: 'rule_demo_hosp_pharmacy',
      name: 'Pharmacy store access — out of hours',
      eventTypes: ['security.intrusion.detected'],
      severity: 'high',
      description: 'Access to the controlled drugs store outside pharmacy opening hours.',
    },
  ],
  incidents: [
    {
      title: 'Patient fall — Ward 4, Corridor',
      eventType: 'behavior.fall.detected',
      category: 'safety',
      severity: 'critical',
      status: 'escalated',
      camera: 'cam_hosp_ward_corridor',
      minutesAgo: 9,
      assignee: 'control.room@staldates.demo',
      notes: [
        'Fall detected outside Bay 2 at 03:12. Nurse call raised simultaneously.',
        'Clinical team attended within 40 seconds. Escalated to the on-call for a datix report.',
      ],
    },
    {
      title: 'Aggression — ED Waiting Area',
      eventType: 'behavior.fight.detected',
      category: 'safety',
      severity: 'critical',
      status: 'investigating',
      camera: 'cam_hosp_ed_wait',
      minutesAgo: 52,
      assignee: 'security.lead@staldates.demo',
      notes: [
        'Two individuals, verbal escalating to physical near the triage door.',
        'Security attended. Clip retained for the police request; do not purge before the retention review.',
      ],
    },
    {
      title: 'Pharmacy store access — out of hours',
      eventType: 'security.intrusion.detected',
      category: 'security',
      severity: 'high',
      status: 'resolved',
      camera: 'cam_hosp_pharmacy',
      minutesAgo: 61 * 20,
      resolution: 'Night pharmacist, access authorised. Rota added to the rule schedule.',
    },
    {
      title: 'Patient fall — Ward 4, Bay 2',
      eventType: 'behavior.fall.detected',
      category: 'safety',
      severity: 'critical',
      status: 'closed',
      camera: 'cam_hosp_ward_bay',
      minutesAgo: 61 * 36,
      resolution: 'Unwitnessed fall, no injury. Bed rails and falls assessment reviewed.',
    },
  ],
};

const VERTICALS = [RETAIL, WAREHOUSE, SCHOOL, HOSPITAL];

/**
 * ⚠️ The `events` collection has a unique index on `(tenantId, dedupKey)`, so every seeded event
 * needs one — a row without it collides with the next row that also lacks it. The format mirrors
 * `services/events/src/domain/event-normalizer.ts` exactly (tenant | type | camera | zone | track |
 * time-bucket) so demo rows are indistinguishable in shape from ones the pipeline produced. P-5.7
 * hit this same index with hand-written events and recorded it; this is the recorded fix applied.
 */
const DEDUP_WINDOW_MS = 10_000;
function demoDedupKey(
  tenantId: string,
  type: string,
  cameraId: string,
  zoneId: string,
  trackId: string,
  occurredMs: number,
): string {
  return [tenantId, type, cameraId, zoneId, trackId, Math.floor(occurredMs / DEDUP_WINDOW_MS)].join(
    '|',
  );
}

// ── writer ──────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db();
    console.log(`→ seeding demo dataset into "${db.databaseName}"\n`);

    let totals = { tenants: 0, nodes: 0, users: 0, cameras: 0, rules: 0, events: 0, incidents: 0 };

    for (const v of VERTICALS) {
      console.log(`  ${v.name}`);
      const counts = await seedVertical(db, v);
      totals = {
        tenants: totals.tenants + 1,
        nodes: totals.nodes + counts.nodes,
        users: totals.users + counts.users,
        cameras: totals.cameras + counts.cameras,
        rules: totals.rules + counts.rules,
        events: totals.events + counts.events,
        incidents: totals.incidents + counts.incidents,
      };
    }

    console.log(
      `\n✔ Demo dataset ready — ${totals.tenants} tenants · ${totals.nodes} locations · ` +
        `${totals.cameras} cameras · ${totals.users} operators · ${totals.rules} rules · ` +
        `${totals.events} events · ${totals.incidents} incidents\n`,
    );
    console.log('  Sign in with any of:');
    for (const v of VERTICALS) {
      console.log(`    ${v.tenantId.padEnd(22)} ${v.operators[0]?.email ?? ''}`);
    }
    console.log(
      `\n  ⚠️ Demonstration data. Every organisation, site, camera and incident is invented.`,
    );
    console.log(
      '     Evidence bytes are NOT seeded here — run `seed:evidence` so custody is real.',
    );
    console.log('     See docs/demo/DEMO_DATASET.md.');
  } finally {
    await client.close();
  }
}

async function seedVertical(
  db: Db,
  v: Vertical,
): Promise<{
  nodes: number;
  users: number;
  cameras: number;
  rules: number;
  events: number;
  incidents: number;
}> {
  const rand = rng(v.tenantId);
  const now = iso(NOW);

  await put(
    db,
    'tenants',
    { _id: v.tenantId },
    {
      _id: v.tenantId,
      tenantId: v.tenantId,
      slug: v.slug,
      name: v.name,
      status: 'active',
      createdAt: iso(daysAgo(400)),
      updatedAt: now,
    },
  );

  // ── locations ────────────────────────────────────────────────────────────────
  // The root is always an `org` node; the spec's `site` hangs beneath it, so the hierarchy has the
  // shape a real customer's does (organisation → site → building → zone).
  const rootId = `org_${v.slug}_root`;
  await put(
    db,
    'org_nodes',
    { _id: rootId },
    {
      _id: rootId,
      tenantId: v.tenantId,
      parentId: null,
      type: 'org',
      name: v.name,
      path: [],
      status: 'active',
      createdAt: iso(daysAgo(400)),
      updatedAt: now,
    },
  );

  const nodeId = (key: string): string => `org_${v.slug}_${key}`;
  for (const z of v.zones) {
    const parentId = z.parent === null ? rootId : nodeId(z.parent);
    const path = z.parent === null ? [rootId] : [rootId, ...ancestry(v, z.parent).map(nodeId)];
    await put(
      db,
      'org_nodes',
      { _id: nodeId(z.key) },
      {
        _id: nodeId(z.key),
        tenantId: v.tenantId,
        parentId,
        type: z.type,
        name: z.name,
        path,
        status: 'active',
        createdAt: iso(daysAgo(380)),
        updatedAt: now,
      },
    );
  }

  // ── operators ────────────────────────────────────────────────────────────────
  const passwordHash = await hashPassword(PASSWORD);
  for (const u of v.operators) {
    await put(
      db,
      'users',
      { _id: u.id },
      {
        _id: u.id,
        tenantId: v.tenantId,
        email: u.email.toLowerCase(),
        name: u.name,
        passwordHash,
        roles: u.roles,
        status: 'active',
        createdAt: iso(daysAgo(300)),
        updatedAt: now,
      },
    );
  }

  // ── cameras ──────────────────────────────────────────────────────────────────
  // ⚠️ Not every camera is healthy. An estate where all 33 cameras are green is not what a customer
  // recognises, and it hides the degraded/offline states the product spent P-2 learning to measure.
  for (const c of v.cameras) {
    const health = c.health ?? 'online';
    await put(
      db,
      'cameras',
      { _id: c.id },
      {
        _id: c.id,
        tenantId: v.tenantId,
        zoneId: nodeId(c.zone),
        name: c.name,
        protocol: 'rtsp',
        streamUrl: `rtsp://cam.${v.slug}.demo:554/${c.id}`,
        status: health === 'offline' ? 'disabled' : 'enabled',
        capture: { ptz: rand() > 0.75 },
        health: {
          status: health,
          ...(health === 'offline'
            ? { lastSeenAt: iso(hoursAgo(6 + Math.floor(rand() * 40))) }
            : {}),
        },
        credentialCipher: null,
        createdAt: iso(daysAgo(360)),
        updatedAt: iso(minsAgo(Math.floor(rand() * 120))),
      },
    );
  }

  // ── rules (+ the immutable version record) ───────────────────────────────────
  const author = v.operators[0]?.id ?? 'system';
  for (const r of v.rules) {
    const createdAt = iso(daysAgo(120));
    const rule = {
      id: r.id,
      tenantId: v.tenantId,
      name: r.name,
      description: r.description,
      lifecycle: 'enabled',
      priority: 100,
      version: 1,
      eventTypes: r.eventTypes,
      categories: ['perception'],
      condition: { all: [{ field: 'confidence', op: 'gte', value: 0.75 }] },
      severity: r.severity,
      actions: [{ type: 'raise-incident' }],
      createdAt,
      updatedAt: createdAt,
      createdBy: author,
    };
    await put(db, 'rules', { id: r.id, tenantId: v.tenantId }, rule);
    await put(
      db,
      'rule_versions',
      { ruleId: r.id, version: 1, tenantId: v.tenantId },
      {
        tenantId: v.tenantId,
        ruleId: r.id,
        version: 1,
        snapshot: rule,
        createdAt,
        createdBy: author,
      },
    );
  }

  // ── events + incidents ───────────────────────────────────────────────────────
  let events = 0;
  for (const spec of v.incidents) {
    const camera = v.cameras.find((c) => c.id === spec.camera);
    if (camera === undefined) throw new Error(`unknown camera ${spec.camera} in ${v.tenantId}`);
    const rule = v.rules.find((r) => r.eventTypes.includes(spec.eventType)) ?? v.rules[0]!;
    const occurredMs = minsAgo(spec.minutesAgo);
    const eventId = randomUUID();
    const correlationId = randomUUID();
    const zone = nodeId(camera.zone);
    const triggerTrack = `trk-${Math.floor(rand() * 9000) + 1000}`;

    await put(
      db,
      'events',
      { id: eventId, tenantId: v.tenantId },
      {
        id: eventId,
        tenantId: v.tenantId,
        type: spec.eventType,
        envelopeVersion: '1.0.0',
        category: spec.category,
        schemaVersion: '1.0.0',
        cameraId: camera.id,
        zoneId: zone,
        occurredAt: iso(occurredMs),
        ingestedAt: iso(occurredMs + 400),
        producer: {
          capability: 'perception.person-detection',
          capabilityVersion: '1.0.0',
          modelVersion: '2026.06',
        },
        confidence: Number((0.82 + rand() * 0.16).toFixed(2)),
        subjects: [{ trackId: triggerTrack, class: 'person' }],
        correlationId,
        dedupKey: demoDedupKey(
          v.tenantId,
          spec.eventType,
          camera.id,
          zone,
          triggerTrack,
          occurredMs,
        ),
        payload: { zone: camera.name },
        evidenceRefs: [],
        priority: spec.severity,
      },
    );
    events += 1;

    // Extra ambient events per camera so the Events page and timelines are populated. These are
    // low-priority perception primitives — the traffic a real deployment produces continuously.
    for (let i = 0; i < 6; i += 1) {
      const id = randomUUID();
      const at = minsAgo(spec.minutesAgo + 3 + i * 7 + Math.floor(rand() * 5));
      const ambientTrack = `trk-${Math.floor(rand() * 9000) + 1000}`;
      await put(
        db,
        'events',
        { id, tenantId: v.tenantId },
        {
          id,
          tenantId: v.tenantId,
          type: 'perception.person.detected',
          envelopeVersion: '1.0.0',
          category: 'perception',
          schemaVersion: '1.0.0',
          cameraId: camera.id,
          zoneId: zone,
          occurredAt: iso(at),
          ingestedAt: iso(at + 300),
          producer: { capability: 'perception.person-detection', capabilityVersion: '1.0.0' },
          confidence: Number((0.7 + rand() * 0.28).toFixed(2)),
          subjects: [{ trackId: ambientTrack, class: 'person' }],
          correlationId: randomUUID(),
          dedupKey: demoDedupKey(
            v.tenantId,
            'perception.person.detected',
            camera.id,
            zone,
            ambientTrack,
            at,
          ),
          payload: { zone: camera.name },
          evidenceRefs: [],
          priority: 'info',
        },
      );
      events += 1;
    }

    // ── the incident, with a lifecycle history that matches its status ──────────
    const incidentId = randomUUID();
    const history: Record<string, unknown>[] = [
      { from: null, to: 'raised', at: iso(occurredMs + 1200), by: 'system' },
    ];
    const flow: Record<string, string[]> = {
      raised: [],
      acknowledged: ['acknowledged'],
      investigating: ['acknowledged', 'investigating'],
      escalated: ['acknowledged', 'investigating', 'escalated'],
      resolved: ['acknowledged', 'investigating', 'resolved'],
      closed: ['acknowledged', 'investigating', 'resolved', 'closed'],
    };
    const steps = flow[spec.status] ?? [];
    let prev = 'raised';
    let stamp = occurredMs + 1200;
    for (const to of steps) {
      stamp += 60_000 + Math.floor(rand() * 600_000);
      history.push({
        from: prev,
        to,
        at: iso(stamp),
        by: spec.assignee ?? v.operators[1]?.email ?? 'operator',
      });
      prev = to;
    }

    const notes = (spec.notes ?? []).map((body, i) => ({
      id: randomUUID(),
      body,
      by: spec.assignee ?? v.operators[1]?.email ?? 'operator',
      at: iso(occurredMs + 900_000 + i * 480_000),
      attachments: [],
    }));

    await put(
      db,
      'incidents',
      { id: incidentId, tenantId: v.tenantId },
      {
        id: incidentId,
        tenantId: v.tenantId,
        status: spec.status,
        severity: spec.severity,
        title: spec.title,
        category: spec.category,
        source: {
          ruleId: rule.id,
          ruleVersion: 1,
          ruleName: rule.name,
          candidateId: randomUUID(),
          dedupKey: `${v.tenantId}:${rule.id}:${eventId}`,
        },
        triggeredBy: {
          eventId,
          eventType: spec.eventType,
          cameraId: camera.id,
          zoneId: zone,
          occurredAt: iso(occurredMs),
        },
        matchedCount: 1 + Math.floor(rand() * 4),
        version: 1 + history.length + notes.length,
        correlationId,
        causationId: randomUUID(),
        history,
        ...(spec.assignee ? { assignee: spec.assignee } : {}),
        assignments: spec.assignee
          ? [
              {
                to: spec.assignee,
                by: v.operators[0]?.email ?? 'system',
                at: iso(occurredMs + 300_000),
              },
            ]
          : [],
        notes,
        ...(steps.includes('acknowledged')
          ? {
              acknowledgedBy: spec.assignee ?? 'operator',
              acknowledgedAt: iso(occurredMs + 300_000),
            }
          : {}),
        ...(steps.includes('resolved')
          ? {
              resolvedBy: spec.assignee ?? 'operator',
              resolvedAt: iso(stamp),
              ...(spec.resolution ? { resolution: spec.resolution } : {}),
            }
          : {}),
        ...(steps.includes('closed')
          ? { closedBy: v.operators[0]?.email ?? 'system', closedAt: iso(stamp) }
          : {}),
        raisedAt: iso(occurredMs + 1200),
        updatedAt: iso(stamp),
      },
    );
  }

  console.log(
    `    ${String(v.zones.length + 1).padStart(2)} locations · ${String(v.cameras.length).padStart(2)} cameras · ` +
      `${v.operators.length} operators · ${v.rules.length} rules · ${events} events · ${v.incidents.length} incidents`,
  );

  return {
    nodes: v.zones.length + 1,
    users: v.operators.length,
    cameras: v.cameras.length,
    rules: v.rules.length,
    events,
    incidents: v.incidents.length,
  };
}

/** Ancestor keys of a zone, root-first, so `path` matches the hierarchy the tenant service expects. */
function ancestry(v: Vertical, key: string): string[] {
  const out: string[] = [];
  let current: string | null = key;
  while (current !== null) {
    out.unshift(current);
    current = v.zones.find((z) => z.key === current)?.parent ?? null;
  }
  return out;
}

async function put(
  db: Db,
  collection: string,
  filter: Record<string, unknown>,
  doc: Record<string, unknown>,
): Promise<void> {
  await db.collection(collection).replaceOne(filter, doc, { upsert: true });
}

main().catch((error: unknown) => {
  console.error('\n✖ Demo seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

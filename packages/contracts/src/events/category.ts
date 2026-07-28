/**
 * Event category — a coarse, domain-neutral classification of every event type, for fast filtering
 * and routing (rules, analytics, dashboards) WITHOUT decoding the type-specific payload
 * (docs/architecture/09-EVENT-PLATFORM.md; recommended by the P1-5 Architect review). Categories are
 * additive and stable — extend the enum, never repurpose a value.
 *
 *   - `perception` — a capability observed something (person/vehicle/fire/plate/face/zone/…).
 *   - `security`   — access/identity/authorization signals (auth, tampering, intrusion).
 *   - `safety`     — life-safety / hazard signals (fire, smoke, PPE, fall).
 *   - `system`     — platform/device lifecycle + health (tenant/camera/media/stream, event.persisted).
 *   - `analytics`  — derived aggregates/insights (counts, occupancy, dwell, reports).
 */
import { z } from 'zod';

export const EventCategory = z.enum(['perception', 'security', 'safety', 'system', 'analytics']);
export type EventCategory = z.infer<typeof EventCategory>;

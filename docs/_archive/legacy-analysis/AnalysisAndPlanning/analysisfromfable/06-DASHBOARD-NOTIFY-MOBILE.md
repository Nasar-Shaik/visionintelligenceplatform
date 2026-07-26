# 06 — Dashboards, Notifications & Mobile Applications

---

## 1. Dashboards

Role-based, scope-aware (tenant→branch→location→camera-group), real-time via WebSocket, exportable.

### 1.1 Executive Dashboard
*Audience:* owners, C-level, multi-site operators.
*Shows:* org-wide KPIs — total cameras online, active alerts by severity, incidents by type/branch, footfall & occupancy trends, safety-compliance %, loss-prevention summary, camera health, cost/usage. Branch leaderboard & comparisons; forecast widgets. Drill-down to any branch/camera.

### 1.2 Store Dashboard
*Audience:* store/site managers.
*Shows:* footfall vs conversion, live occupancy, queue length/wait, heatmap of the floor, today's theft/suspicious leads, shelf/OOS alerts, staff presence, top events. Single-site operational cockpit.

### 1.3 Camera Dashboard
*Audience:* operators.
*Shows:* single-camera live (WebRTC), detection overlays (boxes/tracks/zones), event history timeline for that camera, assigned rules/models, health/bitrate/FPS, snapshot & PTZ controls, clip list.

### 1.4 Branch Dashboard
*Audience:* branch/regional managers.
*Shows:* all sites in a branch — aggregated events, occupancy, compliance, incident feed, per-site comparison, camera fleet health, staffing insights.

### 1.5 Security Dashboard (Live Monitoring Wall)
*Audience:* security operators / SOC.
*Shows:* multi-camera **video wall** (grid, spotlight-on-alarm), live alert queue with ack/assign/resolve, alarm view (auto-switch to camera on high-severity event), map/floorplan with camera + event pins, active cases, escalation status, two-way audio (where supported).

### 1.6 AI Analytics Dashboard
*Audience:* analysts.
*Shows:* footfall/counting analytics, heatmaps (spatial + temporal), dwell, queue analytics, occupancy trends, conversion, compliance trends, incident analytics, model performance (detection rates), cross-branch benchmarking, custom charts.

### 1.7 Shared Surfaces (in every dashboard)
- **Live Monitoring** — WebRTC multi-cam, overlays, quick-alarm.
- **Heatmaps** — movement density, hot zones, over time.
- **Event Timeline** — chronological event markers, filter by type/severity/camera, jump-to-clip.
- **Clip Viewer** — playback with event markers, scrubber, download/share (permission-gated), evidence export with chain-of-custody.
- **Search** — natural-language + structured filters ([Doc 05 §5](./05-PIPELINE-AND-ENGINES.md)).
- **Reports** — scheduled/on-demand, PDF/Excel/CSV export center.
- **Notification Center** — in-app alerts, ack, assignment.

### Dashboard tech
React 19 + Shadcn + TanStack Query + charting (Recharts/visx) + WebRTC/HLS players + map/floorplan canvas. Widgets are configurable; layouts saved per user/role. Server-side scoping enforces data visibility.

---

## 2. Notification System

Multi-channel, rule-driven, with escalation, dedupe and quiet hours.

### 2.1 Channels
| Channel | Use | Provider (pluggable) |
|---------|-----|----------------------|
| **Email** | summaries, reports, medium alerts | SMTP / SES / SendGrid |
| **SMS** | urgent alerts | Twilio / regional |
| **WhatsApp** | alerts + clips (rich) | WhatsApp Business API |
| **Push** | mobile app real-time | Expo → FCM/APNS |
| **Voice Call** | critical (weapon/fire) escalation | Twilio Voice / IVR |
| **Webhook** | integrations (SIEM, POS, custom) | HMAC-signed POST |
| **Slack** | team ops | Slack API |
| **Microsoft Teams** | enterprise ops | Teams webhook/bot |

Each alert can attach **thumbnail + clip link (signed URL)** so recipients see the event, not just text.

### 2.2 Escalation Rules
- **Tiered escalation:** notify Operator → if not acknowledged in *N* minutes → escalate to Manager → then Security Head → then external (guard/police workflow / voice call).
- **Severity-based routing:** critical (weapon/fire/intrusion) → voice+SMS+push immediately to on-call; low → in-app/email digest.
- **On-call schedules & rotations**, quiet hours (non-critical suppressed), dedupe/cooldown (no alert storms), acknowledgment tracking, and delivery retries with a delivery log.
- **Case management:** high-severity events open a case; escalation status, assignee, resolution notes, and evidence tracked.

### 2.3 Config
Per-tenant channel providers/credentials (encrypted), per-rule recipients (users/roles/groups), per-user preferences & quiet hours, template management, and metered credits (SMS/voice/WhatsApp) tied to billing.
**Collections:** `notifications`, `notificationChannels`, `escalationPolicies`, `onCallSchedules`, `notificationDeliveries`, `cases`.

---

## 3. Mobile Applications (React Native / Expo)

Five apps sharing `packages/mobile-core` (auth, api-client, realtime, push, offline). White-labelable.

### 3.1 Platform Admin App
*Purpose:* PaperlessTech operators manage the SaaS.
*Modules:* tenant management, platform health, billing/usage oversight, edge-fleet status, incident/support, feature-flag control, impersonation.
*Pages:* Tenant List/Detail, Platform Health, Fleet Status, Billing Overview, Support Console, Flags.
*Permissions:* `superadmin:*` — platform staff only.

### 3.2 Business Owner App
*Purpose:* owners monitor their business anywhere.
*Modules:* multi-site overview, live view, alerts, clips, analytics/KPIs, reports, billing/plan.
*Pages:* Home (KPIs), Sites, Live View, Alerts feed, Clip viewer, Analytics, Reports, Search, Account/Billing.
*Permissions:* `org:owner` — full tenant scope, read-heavy + approvals.

### 3.3 Manager App
*Purpose:* branch/store managers run day-to-day.
*Modules:* branch live view, alerts (ack/assign/resolve), queue/occupancy, staff presence, compliance, reports, rule tweaks.
*Pages:* Branch Home, Live, Alerts, Occupancy/Queue, Compliance, Reports, Cases, Search.
*Permissions:* `branch:manage` scoped to assigned branches/sites.

### 3.4 Security Guard App
*Purpose:* frontline response.
*Modules:* live monitoring wall (mobile), real-time critical alerts, acknowledge/respond, patrol/checkpoint, incident reporting, two-way audio, panic/SOS.
*Pages:* Live Wall, Alert Queue, Alert Detail (clip+map), Incident Report, Patrol Log, Panic.
*Permissions:* `security:operate` scoped to assigned camera groups; action-focused.

### 3.5 Field Engineer App
*Purpose:* installers/technicians deploy & maintain cameras/edge.
*Modules:* camera onboarding (ONVIF scan/QR), stream test, edge-box provisioning/health, diagnostics, firmware/model OTA, work orders, offline setup.
*Pages:* Site/Work Orders, Add Camera (scan), Stream Test, Edge Provision, Diagnostics, Health, OTA Update.
*Permissions:* `field:engineer` scoped to assigned sites; device/config focused.

### 3.6 Cross-app mobile capabilities
- **Push** (Expo→FCM/APNS) with deep links to alert/clip; **live view** via WebRTC/HLS; **offline** cache + action queue (esp. guard/field apps); **biometric unlock**, secure token storage, cert pinning; **white-label** per reseller (icon/name/theme/API base via EAS build profiles).

---

## 4. Realtime Delivery
Socket.IO namespaces (`/alerts`, `/live`, `/monitoring`, `/presence`) with Redis adapter, tenant/branch/camera-scoped rooms, JWT-authed connections, same RBAC as REST — powering live walls, instant alerts, and dashboard updates across web and mobile.

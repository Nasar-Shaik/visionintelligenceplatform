# 04 — Industry-Wise Solutions

Each vertical is a packaged bundle of atomic detections ([Doc 03](./03-AI-DETECTION-CATALOG.md)) + rules + dashboards + reports + alerts. Each entry: **Business Problems · AI Features · Dashboard · Reports · Alerts · Business Benefits**.

Sold as **industry solution packs** (feature-flagged) on top of the core platform.

---

## 1. Retail (general)
- **Business Problems:** shrinkage/theft, poor conversion, long queues, understaffing, no footfall insight, dispute resolution.
- **AI Features:** people counting, footfall/conversion, heatmaps, dwell, queue analysis, shoplifting/suspicious behaviour, shelf/OOS monitoring, POS-video correlation, staff presence.
- **Dashboard:** Store dashboard (footfall vs sales, conversion, heatmap, queue live, theft events), multi-store executive rollup.
- **Reports:** daily footfall/conversion, hourly traffic, loss-prevention weekly, queue/wait SLA, planogram compliance, staff coverage.
- **Alerts:** suspicious concealment, queue exceeds N, shelf empty, after-hours motion, cash-counter anomaly.
- **Benefits:** reduce shrinkage 20–40%, lift conversion via staffing/layout, cut wait times, evidence for disputes.

## 2. Supermarkets
- **Business Problems:** high SKU theft, self-checkout scan-avoidance, spillage/slip liability, checkout congestion, cold-aisle compliance.
- **AI Features:** shoplifting, self-checkout scan-avoidance (item pick vs POS scan), slip/fall, queue analysis, occupancy/capacity, shelf OOS, employee theft/void-fraud, entrance counting.
- **Dashboard:** store ops (occupancy, lanes open vs needed, theft leads, slip incidents), loss-prevention console.
- **Reports:** shrink by category/lane, self-checkout loss, slip-incident log, staffing vs footfall, planogram.
- **Alerts:** scan-avoidance at self-checkout, slip/fall, capacity exceeded, cold-storage door left open, cash void spike.
- **Benefits:** recover self-checkout losses, reduce liability claims, optimize lane staffing, safer aisles.

## 3. Small Shops
- **Business Problems:** owner can't watch cameras, occasional theft, staff accountability, after-hours security.
- **AI Features:** person/vehicle detection, intrusion/after-hours motion, loitering, basic theft/suspicious, cash-counter view, people counting.
- **Dashboard:** simple mobile-first single-store view (live, today's events, clips).
- **Reports:** daily events summary, footfall, opening/closing times.
- **Alerts:** after-hours motion, door open, suspicious behaviour, camera offline — all to owner's phone.
- **Benefits:** peace of mind, low-cost security, remote oversight, evidence clips; **self-serve entry tier**.

## 4. Warehouses
- **Business Problems:** inventory shrink, forklift-pedestrian safety, unauthorized access, loading-dock theft, PPE compliance, idle assets.
- **AI Features:** intrusion/restricted zones, PPE/helmet/vest, forklift-pedestrian proximity, abandoned/removed objects, loading-dock monitoring, LPR at gates, people/vehicle counting, loitering after-hours.
- **Dashboard:** warehouse safety & security (zone map, PPE compliance %, safety near-misses, dock activity, gate LPR log).
- **Reports:** safety incident/near-miss, PPE compliance, gate vehicle log, after-hours access, dock dwell.
- **Alerts:** person in forklift path, PPE violation in zone, restricted-area entry, unknown vehicle at gate, object removed after hours.
- **Benefits:** fewer accidents/liability, reduced shrink, faster incident investigation, compliance evidence.

## 5. Factories
- **Business Problems:** worker safety, PPE non-compliance, machine-area intrusion, productivity/downtime, unauthorized zones, fire risk.
- **AI Features:** PPE suite, danger-zone intrusion, machine-guard proximity, fall/slip, fire/smoke, mobile-phone usage, sleeping/idle detection, headcount per line.
- **Dashboard:** factory safety (compliance %, zone violations, incidents, line occupancy), OEE-adjacent presence metrics.
- **Reports:** safety compliance, incident log, zone-violation trends, shift attendance/presence, fire-risk audit.
- **Alerts:** PPE missing, danger-zone entry, fall, fire/smoke, machine-area breach.
- **Benefits:** reduce injuries + regulatory fines, prove compliance, improve productivity, insurance leverage.

## 6. Schools
- **Business Problems:** intruder/stranger danger, violence/bullying, weapon threats, unauthorized pickup, perimeter security, crowd safety.
- **AI Features:** intrusion/perimeter, unknown-person/visitor, weapon detection, violence/fight, crowd/stampede, tailgating at gates, vehicle/LPR at pickup, loitering.
- **Dashboard:** campus security (map, live wall, active alerts, visitor log, gate activity).
- **Reports:** incident log, visitor/vehicle log, perimeter breaches, drill/evacuation analytics.
- **Alerts:** weapon detected, unknown person in restricted area, fight, perimeter breach, unauthorized vehicle — with escalation to admin/security/police workflow.
- **Benefits:** safer campus, faster emergency response, parent trust, compliance with safety mandates.
- **Privacy:** face recognition off by default / consent-gated; child-safeguarding controls.

## 7. Hospitals
- **Business Problems:** patient falls, wandering/elopement, restricted-area access, hygiene compliance, violence against staff, infant security, asset theft.
- **AI Features:** fall detection, restricted-area/intrusion, hand-hygiene/PPE-mask compliance, loitering, violence, tailgating, unknown-person, abandoned objects, occupancy.
- **Dashboard:** hospital safety (fall alerts, restricted access, hygiene %, ward occupancy, incident feed).
- **Reports:** fall-incident log, hygiene compliance, restricted-access breaches, security incidents, occupancy trends.
- **Alerts:** patient fall, patient exiting ward (elopement), unauthorized ICU/pharmacy access, hygiene violation, aggression toward staff.
- **Business Benefits:** reduce fall liability, improve patient safety, protect staff, HIPAA-aware evidence, operational insight.
- **Compliance:** HIPAA-aware — PHI minimization, pose-only privacy mode, strict access policies, audit.

## 8. Hotels
- **Business Problems:** guest/property security, loitering in corridors, unauthorized area access, valet/parking, crowd at events, staff accountability, package handling.
- **AI Features:** intrusion/restricted areas, loitering, tailgating, LPR/valet parking, people counting/occupancy (lobby, pool), abandoned objects, uniform/dress compliance for staff.
- **Dashboard:** property security + guest-experience (occupancy, parking, incidents, VIP arrival via LPR).
- **Reports:** incident log, parking/valet, occupancy by area, staff presence, package-desk activity.
- **Alerts:** unauthorized floor access, loitering, pool over-capacity, unattended luggage, VIP vehicle arrival.
- **Benefits:** guest safety & experience, loss reduction, smoother parking, premium service signals.

## 9. Restaurants
- **Business Problems:** food-safety/hygiene compliance, employee theft/void fraud, slow service/queues, slip hazards, cash handling, dine-and-dash.
- **AI Features:** mask/glove/hygiene compliance, cash-counter/POS anomaly, queue & table dwell, slip/fall, smoking in prohibited areas, people counting, staff presence.
- **Dashboard:** restaurant ops (hygiene %, queue/wait, cash-anomaly leads, table turnover, incidents).
- **Reports:** hygiene compliance, wait-time SLA, cash-handling anomalies, footfall vs sales, incident log.
- **Alerts:** hygiene violation, cash void/refund anomaly, long queue, slip, kitchen fire/smoke.
- **Benefits:** pass health inspections, reduce theft, faster service, safer premises, dispute evidence.

## 10. Banks
- **Business Problems:** robbery/weapon threat, ATM skimming/fraud, tailgating into secure areas, masked-entry policy, loitering/casing, after-hours intrusion, dispute evidence.
- **AI Features:** weapon detection, mask-at-entry policy, tailgating, loitering/casing, unknown-person/watchlist, ATM-area monitoring, intrusion after-hours, LPR of getaway vehicles, crowd.
- **Dashboard:** high-security console (live wall, active threats, access log, ATM events) with SOC integration.
- **Reports:** security incident log, access/tailgating, ATM-area events, after-hours activity, watchlist hits.
- **Alerts:** weapon detected (immediate escalation + police workflow), tailgating into vault/secure area, ATM tampering, casing/loitering, after-hours breach.
- **Benefits:** deter/respond to threats, protect staff & assets, fraud reduction, regulatory evidence, insurance compliance.

## 11. Apartments / Residential
- **Business Problems:** unauthorized entry, package theft, visitor management, parking abuse, perimeter security, tailgating at lobby.
- **AI Features:** perimeter intrusion, face/known-resident vs visitor, LPR for resident/guest parking, tailgating at doors, package/abandoned-object, loitering, people/vehicle counting.
- **Dashboard:** community security (gate activity, visitor log, parking, incidents) + resident notifications.
- **Reports:** entry/exit log, visitor/vehicle log, parking violations, incidents, package events.
- **Alerts:** unknown person at door/perimeter, tailgating, package delivered/removed, unauthorized parking, gate breach.
- **Benefits:** resident safety & convenience, reduced package theft, automated visitor/parking mgmt, HOA evidence.

## 12. Corporate Offices
- **Business Problems:** tailgating/access control, desk/asset theft, occupancy/space utilization, after-hours access, visitor management, health/safety.
- **AI Features:** tailgating, unknown-person, occupancy/space utilization, asset/abandoned-object, after-hours intrusion, PPE (labs), meeting-room/desk usage analytics, LPR parking.
- **Dashboard:** facilities + security (occupancy heatmap, space utilization, access events, incidents).
- **Reports:** space utilization, occupancy trends, access/tailgating, after-hours, asset events.
- **Alerts:** tailgating into secure zone, after-hours presence, asset removed, unknown visitor unescorted, capacity exceeded.
- **Benefits:** optimize real-estate cost, tighten access security, better facilities planning, safety compliance.

## 13. Construction Sites
- **Business Problems:** fall-from-height, PPE non-compliance, equipment/material theft, unauthorized access, machine-pedestrian accidents, progress tracking.
- **AI Features:** PPE (helmet/vest/harness), danger-zone/height intrusion, fall detection, heavy-equipment proximity, perimeter/after-hours intrusion, LPR at gates, headcount, abandoned/removed material.
- **Dashboard:** site safety & security (PPE %, zone violations, incidents, gate log, headcount).
- **Reports:** safety compliance, incident/near-miss, theft/after-hours, gate vehicle log, daily headcount.
- **Alerts:** no-helmet/harness in zone, worker near heavy equipment, fall, perimeter breach after hours, material removed.
- **Benefits:** prevent injuries + OSHA-type fines, reduce theft, prove compliance, insurance & liability protection.

---

## Solution-Pack Model
Each industry pack = **{ curated detections + preconfigured rules + dashboard template + report set + alert/escalation defaults + onboarding wizard }**, deployable in minutes and customizable via the no-code rule engine. Packs are entitlements gated by plan/add-on, enabling vertical go-to-market and upsell.

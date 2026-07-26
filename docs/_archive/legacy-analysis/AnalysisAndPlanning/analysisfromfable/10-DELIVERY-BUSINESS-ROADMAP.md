# 10 — Testing Strategy, Business Roadmap & Delivery

---

## 1. Testing Strategy

### 1.1 Software testing
| Layer | Tooling | Focus |
|-------|---------|-------|
| **Unit** | Vitest/Jest (TS), pytest (Python) | services, rule evaluator, utils, pre/post-processing |
| **Integration** | Jest + Testcontainers (Mongo/Redis/MinIO), pytest | repositories, tenant isolation, pipeline stages, storage |
| **Contract** | Zod/OpenAPI + Pact | REST/WS API schemas, backward compat |
| **E2E (web)** | Playwright | onboard camera→detect→rule→alert→clip→search journeys, multi-role, multi-tenant isolation |
| **E2E (mobile)** | Detox/Maestro | login, live view, alerts, ack, offline |
| **Load** | k6/Locust | API + WS throughput, stream fan-out |
| **Stress** | custom camera simulators | N-camera GPU saturation, backpressure |
| **Security** | ZAP, Semgrep, Trivy, gitleaks | SAST/DAST/deps/secrets each pipeline |

### 1.2 Model validation (critical for a CV product)
- **Benchmark suites per detection** (curated, versioned datasets) run in model CI; gate promotion on precision/recall thresholds.
- **False-Positive testing:** hard-negative sets (steam vs smoke, phone vs gun, tools vs weapon, shadows vs person) — track FP rate per model; regression-block if FP rises.
- **False-Negative testing:** ensure safety-critical recall (fire/weapon/fall) never regresses; miss-rate budgets.
- **Scenario/edge-case testing:** low light/IR, occlusion, crowd density, camera angle, weather, resolution, ethnicity/age fairness audits for person/FR models.
- **Field testing:** shadow-deploy on real customer cameras (consented), compare against operator ground truth; per-site calibration; pilot sign-off before GA of a detection.
- **Confusion tracking in production:** customer FP/FN flags feed MLOps active-learning loop.

### 1.3 Reliability & chaos
- Camera-disconnect/reconnect, WAN outage (edge offline→sync), GPU OOM, worker crash, storage-full, clock-skew; verify graceful degradation and no data loss.

### 1.4 Special isolation tests
- Automated cross-tenant access attempts on every endpoint/stream → must fail. RBAC matrix (role×permission×scope). Signed-URL expiry & tamper tests.

---

## 2. Business Roadmap

### Year 1 — Land & Prove
- **Product:** GA of P1–P5 + first 10 detections; hybrid + cloud deploy; 2–3 industry packs (retail, warehouse, small shop); web + owner/manager/guard apps.
- **GTM:** self-serve SMB (freemium single-camera + Starter/Business), 3–5 lighthouse mid-market pilots, case studies.
- **Goal:** first revenue by month ~7; 50–150 paying tenants; validate per-camera pricing & retention; NPS + accuracy baselines.

### Year 2 — Scale & Expand
- **Product:** 40+ detections, NL search GA, analytics suite, enterprise features (SSO, on-prem/hybrid packaging, API platform), edge appliance (SentinelVision Edge Box), MLOps continuous-training.
- **GTM:** enterprise sales motion, **partner/SI program**, vertical packs (hospital/bank/school/factory/construction), **white-label/OEM** launch, marketplace beta.
- **Goal:** 3+ enterprise logos, channel-driven pipeline, expand to 1000+ camera deployments, multi-region.

### Year 3 — Platform & Ecosystem
- **Product:** model **marketplace** (partner-published detections, rev-share), advanced multi-cam reasoning, forecasting/prescriptive analytics, deeper integrations (access control, POS, SIEM, VMS interop), industry certifications.
- **GTM:** OEM licensing (camera/NVR vendors embed SentinelVision), international expansion, ecosystem/developer platform, enterprise ARR growth.
- **Goal:** market-recognized platform; ecosystem revenue; durable enterprise + channel base.

### Expansion levers
- **Enterprise features:** SSO/SCIM, on-prem, SLA, custom models, compliance suites.
- **Marketplace:** third-party & vertical models; rev-share.
- **Partner program:** SIs/MSPs resell & deploy; certified installers.
- **OEM licensing:** embed engine in cameras/NVRs/appliances.
- **White-label:** resellers sell under their brand.

---

## 3. Complete Development Roadmap

### 3.1 Sprint Planning (2-week sprints, mapped to phases — see [Doc 01](./01-PHASE-WISE-PLAN.md))
- **S1–S3 (P0/P1):** monorepo/CI/Docker; tenancy+auth+RBAC; org hierarchy; audit; storage; notifications; billing/quotas; admin shell.
- **S4–S8 (P2):** camera onboarding/ONVIF; media server (RTSP/HLS/WebRTC); frame service; recording+clip store+retention; edge agent; live view.
- **S9–S16 (P3):** inference runtime; detection; tracking; zones/lines; pose; face/LPR; model manager/packs; GA-10 detections.
- **S17–S21 (P4):** behaviour engine; event engine; **rule engine (drag-drop)**; smart clip extraction; notifications+escalation; event/clip UI. → **first paid customers.**
- **S22–S25 (P5):** dashboards (exec/store/camera/branch/security); live wall; timeline; maps.
- **S26–S30 (P6):** analytics/heatmaps/counting; embeddings+**NL search**; reports/exports.
- **S31–S37 (P7):** SSO/SCIM; on-prem/hybrid packaging; API platform/webhooks; integrations (POS/access/SIEM); compliance/privacy; white-label/domains.
- **S38–S43 (P8):** MLOps loop; 40+ detections; marketplace beta; OTA/quantization.
- **S44–S48 (P9):** scaling/sharding/autoscale; DR/backups; security hardening; load/stress to 1000+; deploy automation; **Enterprise GA**.

### 3.2 Development Order (dependency-correct)
Foundation → Video infra → Detection/Tracking → Rules/Alerts → Dashboards → Analytics/Search → Enterprise → Model expansion/MLOps → Scale/Prod.

### 3.3 Milestones (headline)
M3 SaaS core · M6 edge offline+sync · M9 GA-10 detections · **M12 rule→alert+clip on phone** · M14 exec dashboard · M16 NL search · M19 SSO+on-prem+compliance · M21 40+ detections · **M25 Enterprise GA + 1000-cam load passed.**

### 3.4 Priority Matrix (MoSCoW × value/effort)
| Priority | Items |
|----------|-------|
| **Must** | Tenancy/auth/RBAC, camera ingest, detection+tracking, rule engine, alerts, smart clips, core dashboards |
| **Should** | Face/LPR, analytics/heatmaps, NL search, mobile apps, escalation, on-prem/hybrid |
| **Could** | Full 40+ detection catalog, marketplace, advanced integrations, forecasting |
| **Won't-yet** | Exotic detections, multi-cam global re-ID at scale, prescriptive AI (post core) |

*Quick wins:* intrusion/after-hours alert, people counting, camera-offline alert, clip-on-alert.
*Big bets:* detection accuracy at scale, NL search, edge economics, MLOps loop.

### 3.5 Production Checklist
- [ ] Tenant isolation enforced + automated cross-tenant tests green
- [ ] TLS 1.3, AES-256 at rest, signed media URLs, per-tenant KMS
- [ ] RBAC/permission/scope on every REST/WS/stream endpoint
- [ ] Smart-clip retention + storage lifecycle + legal hold working
- [ ] Safety-critical models meet precision/recall gates in CI + field
- [ ] Escalation/notification delivery + retries + logging verified
- [ ] Backups + tested DR restore (RPO/RTO met); edge offline→sync verified
- [ ] Observability (metrics/traces/logs), SLOs, alerting, on-call, runbooks
- [ ] Load/stress passed at target camera count; autoscaling proven
- [ ] Security: pen-test remediated, SAST/DAST/deps/secrets clean
- [ ] GDPR/HIPAA tooling: consent, DSAR, privacy masking, access policies, audit
- [ ] Billing/metering/dunning + quotas correct; feature flags gate incomplete work
- [ ] Docs, onboarding automation, support playbooks, status page

### 3.6 Launch Checklist
- [ ] Freemium + paid tiers live; trial→paid flow; pricing/packaging finalized
- [ ] Self-serve onboarding (add camera <60s) + guided setup wizard per industry pack
- [ ] Marketing site, docs, demo tenant, sample footage, case studies
- [ ] Support (ticketing, SLA), success playbooks, in-app help
- [ ] Partner/reseller portal + white-label ready (for OEM launch)
- [ ] Monitoring dashboards + alerting live; incident process rehearsed
- [ ] Legal: ToS, DPA, privacy policy, jurisdictional FR/LPR gating
- [ ] Rollback + canary verified in production

### 3.7 Risk Analysis
| Risk | Impact | Mitigation |
|------|--------|------------|
| **False positives erode trust** | churn | 2-stage confirm, per-site calibration, sensitivity sliders, human-in-loop, FP CI gates |
| **Missed safety events (FN)** | liability | recall budgets, redundancy, field validation, alerting on drift |
| **GPU/infra cost** | margin | edge offload, motion-gating, batching, quantization, smart clips |
| **Bandwidth constraints (cloud)** | reliability | hybrid/edge default, events-only upstream, local relay |
| **Privacy/legal (FR/LPR)** | regulatory | consent, jurisdiction gating, masking, DPA, on-prem option |
| **Tenant data leakage** | breach | DB-enforced isolation + automated isolation tests + KMS |
| **Model drift across sites** | accuracy decay | drift monitoring, continuous training, per-site tuning |
| **Edge fleet management at scale** | ops load | fleet mgmt, OTA staged rollout, health monitoring, remote wipe |
| **Camera diversity/interop** | onboarding friction | ONVIF/RTSP broad support, test lab, camera compatibility DB |
| **Enterprise sales cycle** | revenue timing | SMB self-serve for early cash flow; partner channel |
| **Competition (Verkada etc.)** | positioning | BYO-camera, deploy-anywhere, NL search, edge economics, white-label |

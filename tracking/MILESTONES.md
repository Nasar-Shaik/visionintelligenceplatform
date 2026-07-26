# Milestones & Acceptance Gates

> Each milestone has an **objective acceptance gate** (a test run, demo, or metric). A phase is not "done" until its gate is evidenced. Tick and cite evidence when passed. See [ROADMAP](ROADMAP.md).

| ID | Milestone | Acceptance gate (evidence required) | Phase | Status |
|----|-----------|--------------------------------------|-------|--------|
| M0 | Architecture ratified | Full docs set + ADRs present; repo self-documenting | P0 | ✅ 2026-07-26 |
| M1 | Program setup complete | Monorepo builds; contracts generate types; CI green (build/test/scan/import-graph); dev stack up | P0 | ⚪ |
| M2 | Tenant provisioning | Provision tenant + invite users via API/console | P1 | ⚪ |
| M3 | Isolation proven | Cross-tenant access tests fail-closed on **every** endpoint/stream | P1 | ⚪ |
| M4 | Billing + quotas live | Subscription + metered usage + quota enforcement demonstrated | P1 | ⚪ |
| M5 | Camera live <60s | Add ONVIF/RTSP camera → live WebRTC view in under 60s | P2 | ⚪ |
| M6 | Edge offline→sync | Edge runs full pipeline during WAN outage; reconciles with **no data loss** (chaos test) | P2 | ⚪ |
| M7 | Capability DAG live | Orchestrated capability graph runs on a real camera; a capability swapped behind its contract with no consumer change | P3 | ⚪ |
| M8 | Model lifecycle | Model canary + instant rollback per tenant/camera; model CI FP/FN gates block a bad promotion | P3 | ⚪ |
| M9 | Rule→alert+clip | Author a rule in the builder → alert with evidence clip on phone; dry-run preview worked | P4 | ⚪ |
| M10 | Storage economics | ≥90% storage reduction vs continuous recording measured on a test site | P4 | ⚪ |
| M11 | Incident lifecycle | Incident→escalation→approval→resolution E2E with complete tamper-evident audit | P5 | ⚪ |
| M12 | NL search | Natural-language query returns correct ranked events/clips on seeded data | P6 | ⚪ |
| M13 | Pure-plugin vertical | An Industry Pack produces a full vertical solution with **zero core diff**; deleting all plugins still builds/tests/runs | P7 | ⚪ |
| M14 | Enterprise deploy | SSO/SCIM + on-prem install + one integration (POS/access/SIEM/VMS) working | P8 | ⚪ |
| M15 | Compliance pack | DSAR, privacy masking, legal hold, access policies, residency demonstrated | P8 | ⚪ |
| M16 | Continuous training | CT loop: field FP/FN → retrain → validate (gates) → shadow → canary → OTA to edge | P9 | ⚪ |
| M17 | Scale proven | 1,000-camera load test passed; 10,000-camera fleet simulation stable; SLOs met | P10 | ⚪ |
| M18 | DR proven | Backup + tested restore; DR failover drill meets RPO/RTO | P10 | ⚪ |
| M19 | **Enterprise GA** | Production checklist fully green (below); ≥1 regulated Industry Pack shipped as pure plugin | P10 | ⚪ |

## Production checklist (M19 gate)
- [ ] Tenant isolation enforced + automated cross-tenant tests green
- [ ] TLS 1.3, AES-256 at rest, signed media URLs, per-tenant KMS, key rotation
- [ ] RBAC/ABAC + scope on every REST/WS/stream endpoint
- [ ] Smart-clip retention + lifecycle + legal hold + verifiable purge working
- [ ] Safety-critical capabilities meet precision/recall gates in CI + field
- [ ] Escalation/notification delivery + retries + logging + ack tracking verified
- [ ] Backups + tested DR restore (RPO/RTO met); edge offline→sync verified
- [ ] Observability (metrics/traces/logs), SLOs, alerting, on-call, runbooks
- [ ] Load/stress passed at target camera counts; autoscaling proven
- [ ] Security: pen-test remediated; SAST/DAST/deps/secrets clean
- [ ] GDPR/HIPAA/SOC2/ISO tooling: consent, DSAR, masking, access policies, audit
- [ ] Billing/metering/dunning + quotas correct; feature flags gate incomplete work
- [ ] "Delete all plugins → core builds/tests/runs" gate green
- [ ] Docs + tracking current; onboarding automation; support playbooks; status page

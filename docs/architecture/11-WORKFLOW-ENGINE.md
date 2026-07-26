# 11 — Workflow Engine

## Purpose
Define the Workflow Engine: the declarative orchestration of **what happens after a rule fires** — incident/case management, escalation, notifications, approvals, operator/manager actions, and audit. Keeps human/automated response out of capability code (Law 1/3).

## Responsibilities
- Instantiate and drive **incidents/cases** through their lifecycle.
- Orchestrate **escalation**, **notifications**, **approvals**, and **operator/manager actions** declaratively.
- Guarantee a complete, tamper-evident **audit trail** of every action.

---

## 1. Workflow model

A **workflow** is a declarative state machine (data, versioned, scoped) triggered by rule outcomes. It has states, transitions, timers, actions, assignees, and SLAs. Like rules, workflows are **industry-neutral primitives**; verticals ship workflow templates via Industry Packs.

```yaml
workflow: "security-incident-v2"
trigger: incident.raised
states:
  open:        { on_enter: [assign_queue(security), notify(policy: security-escalation)],
                 transitions: [ack → acknowledged], sla: { ack_within: 3m, else: escalate(L2) } }
  acknowledged:{ transitions: [start_review → investigating] }
  investigating:{ actions: [attach_evidence, add_note, request_approval(manager) ],
                  transitions: [resolve → resolved, dismiss(reason) → closed] }
  resolved:    { on_enter: [finalize_evidence, close_after(24h)] }
  closed:      { terminal: true, on_enter: [seal_audit, retention_tag] }
```

## 2. Incident & case management

- **Incident**: the human-facing unit aggregating related events + evidence, with state `open → acknowledged → investigating → resolved → closed`, owner, severity, notes, and linked evidence/timeline.
- **Case**: a higher-order container grouping multiple incidents (e.g. an ongoing investigation, a repeat-offender file, a compliance audit), with its own state, participants, and evidence bundle. Cases support export with chain of custody. → [12](12-EVIDENCE-MANAGEMENT.md)
- Both are tenant/branch/site-scoped and RBAC-controlled.

## 3. Escalation

- **Escalation policies**: ordered tiers (L1 operator → L2 manager → L3 on-call/authority) with per-tier channels, timers, and quiet-hours awareness. On-call schedules and rotations supported.
- Escalation timers driven by workflow SLAs (`ack_within`, `resolve_within`); breach triggers the next tier and is recorded.

## 4. Notifications (delivery)

The Workflow/Rule action `notify` is executed by the **Notification capability**: channels email/SMS/WhatsApp/push/voice/webhook/Slack/Teams; dedupe, quiet hours, rate limits, retries, delivery logging, and **acknowledgment tracking** (ack from any channel resolves the escalation timer). Target **< 3 s** for critical. Channels are pluggable ([20](20-EXTENSIBILITY.md)).

## 5. Approvals

- Steps can **require approval** (e.g. exporting evidence, dismissing a safety incident, enrolling a face) from a role/user, with reason capture and audit. Approvals block transitions until granted/denied; timeouts escalate.

## 6. Operator & manager actions

- **Operator**: acknowledge, assign, add note/annotation, attach/extract evidence, mark false-positive (feeds MLOps active-learning → [08](08-AI-ML-PLATFORM.md)), trigger PTZ/relay, escalate.
- **Manager**: reassign, override severity, approve/deny, bulk-resolve, configure escalation policies and workflow templates, review audit.
- Available actions are permission-gated ([06](06-MULTI-TENANT-SAAS.md)); "false-positive" flags are first-class signals into continuous learning.

## 7. Evidence review

- Workflows surface the incident's **timeline + clips + snapshots + annotations** for review; reviewers add findings, redactions, and dispositions; evidence integrity (chain of custody) is preserved throughout. → [12](12-EVIDENCE-MANAGEMENT.md)

## 8. Audit trail

- Every workflow action (state change, assignment, notification, approval, evidence access/export, override) is written to an **append-only, tamper-evident** (hash-chained) audit log, tenant-scoped and exportable for compliance/SIEM. This is the backbone of defensibility for regulated verticals. → [15](15-SECURITY-ARCHITECTURE.md)

## Design decisions
- **Declarative state machines** (data, versioned) instead of coded workflows keep human process out of the core and let Industry Packs deliver process as templates.
- **False-positive as a signal** closes the loop from human review back into model improvement.
- **Approvals + tamper-evident audit** make the engine suitable for banks/hospitals/government out of the box.

## Advantages
- Customers/verticals define their own response processes without code.
- Uniform incident/case/audit model across every industry.
- Escalation/SLA/on-call are configuration, not bespoke integrations.

## Tradeoffs
- A general workflow state-machine engine is more complex than hardcoded alert routing; justified because response process varies enormously by customer and must not fork the core.

## Future expansion
- Visual workflow builder; BPMN import; integrations with ticketing/ITSM/PSIM; automated remediation actions; SLA analytics and workforce optimization.

## Cross-references
[10-RULE-ENGINE](10-RULE-ENGINE.md) · [12-EVIDENCE-MANAGEMENT](12-EVIDENCE-MANAGEMENT.md) · [13-INDUSTRY-PACKS](13-INDUSTRY-PACKS.md) · [15-SECURITY-ARCHITECTURE](15-SECURITY-ARCHITECTURE.md)

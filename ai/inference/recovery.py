"""Auto-Recovery (AI-5d) — recovery as a budgeted, policy-driven, auditable act.

AI-5b classified failures into five mutually exclusive categories and declared a recovery path for
each. Until now the runtime *reported* those paths; a `connection` failure that exhausted its
reconnect budget still ended the session permanently, and only an operator could bring it back. This
module executes the taxonomy instead of merely describing it.

**Recovery adds no judgement.** Every action is the one the frozen taxonomy already declares:

    connection    → reconnect, then restart the session      (AI-CONN)
    model         → rebind the model, then restart           (AI-MODEL)
    inference     → skip the frame                           (AI-INFER)
    pipeline      → skip the frame                           (AI-PIPE)
    configuration → operator intervention, NEVER retried     (AI-CONFIG)

The `configuration` rule is enforced in code and cannot be turned on by policy. A wrong RTSP URL does
not become right on the four-thousandth attempt; retrying it only buries the one log line that would
have told an operator what to fix.

**Budgets are external configuration** (Architect AI-5d rec 4), because "how hard should we try?" is
a deployment decision, not an engineering one:

    retail      maxRestarts=3                            — stop bothering anyone after three
    factory     maxRestarts=10                           — production line, keep trying
    bank        unlimitedRestarts + long cooldown        — never give up, never hammer
    healthcare  requireOperatorApproval                  — never auto-restart; a human decides

**Anti-oscillation** (rec 6): after any recovery a session must stay healthy for
`stabilization_seconds` before another transition is allowed. Without it a marginally-connected
camera flaps between recovered and failed forever, and every flap costs a reconnect and a log storm.

Deterministic + stdlib-only: the clock is injected, so budgets, windows and backoff are all asserted
in unit tests with no sleeping.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Deque, Dict, List, Optional, Union

from errors import failure_category, failure_code
from operational_log import OperationalLog, SessionIdentity

# Mirrors @vip/contracts `RecoveryTrigger` / `RecoverySubsystem` / `RecoveryAction`.
TRIGGERS = (
    "connection-lost",
    "reconnect-exhausted",
    "model-failure",
    "inference-failure",
    "pipeline-failure",
    "configuration-failure",
    "health-decline",
    "stall-detected",
    "operator-request",
)

# The frozen AI-5b taxonomy, expressed as recovery. Each row is one category's complete answer.
_CATEGORY_TRIGGER = {
    "connection": "connection-lost",
    "model": "model-failure",
    "inference": "inference-failure",
    "pipeline": "pipeline-failure",
    "configuration": "configuration-failure",
}
_CATEGORY_SUBSYSTEM = {
    "connection": "stream-source",
    "model": "model",
    "inference": "video-analyzer",
    "pipeline": "stream-pipeline",
    "configuration": "configuration",
}
_CATEGORY_ACTION = {
    "connection": "restart-session",
    "model": "rebind-model",
    "inference": "skip-frame",
    "pipeline": "skip-frame",
    "configuration": "operator-intervention",
}
_CATEGORY_SEVERITY = {
    "connection": "warning",
    "model": "error",
    "inference": "warning",
    "pipeline": "warning",
    "configuration": "critical",
}

# Categories the runtime may never auto-recover, whatever a policy says. This is a code-level
# invariant rather than a default, because a misconfigured profile must not be able to create a
# restart loop against an operator error.
NEVER_AUTO_RECOVER = frozenset({"configuration"})

# Actions handled inside the running pipeline — they do not consume the restart budget, because
# skipping one frame is not a recovery event in the operational sense.
_IN_BAND_ACTIONS = frozenset({"skip-frame", "none"})

_LEDGER_MAX = 100


@dataclass(frozen=True)
class RecoveryReason:
    """The structured "why" behind a recovery (Architect AI-5d rec 1).

    Frozen: a reason records what was true at one moment and must not be rewritten by a later attempt.
    Recording only that a recovery *happened* leaves an incident review guessing; the trigger, the
    originating tier, the severity, the attempt number and the correlation id turn a night of restarts
    into a single query.
    """

    trigger: str
    subsystem: str
    at: str
    severity: str = "error"
    retry_count: int = 0
    correlation_id: Optional[str] = None
    failure_category: Optional[str] = None
    failure_code: Optional[str] = None
    detail: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {
            "trigger": self.trigger,
            "subsystem": self.subsystem,
            "severity": self.severity,
            "retryCount": self.retry_count,
            "at": self.at,
        }
        for key, value in (
            ("correlationId", self.correlation_id),
            ("failureCategory", self.failure_category),
            ("failureCode", self.failure_code),
            ("detail", self.detail),
        ):
            if value is not None:
                out[key] = value
        return out


@dataclass
class RecoveryAttempt:
    """One recorded attempt — reason, action, outcome. The audit unit for recs 1 and 5."""

    identity: SessionIdentity
    reason: RecoveryReason
    action: str
    outcome: str
    attempt: int = 1
    cooldown_ms: Optional[float] = None
    detail: Optional[str] = None
    at: Optional[str] = None

    @property
    def recovered(self) -> bool:
        return self.outcome == "succeeded"

    def to_dict(self) -> dict:
        out: dict = {
            "identity": self.identity.to_dict(),
            "reason": self.reason.to_dict(),
            "action": self.action,
            "outcome": self.outcome,
            "attempt": self.attempt,
        }
        for key, value in (("cooldownMs", self.cooldown_ms), ("detail", self.detail), ("at", self.at)):
            if value is not None:
                out[key] = round(value, 3) if isinstance(value, float) else value
        return out


@dataclass
class RecoveryPolicy:
    """Recovery budgets as configuration. Mirrors the `RecoveryPolicy` contract."""

    max_restarts: int = 3
    restart_window_seconds: float = 3600.0
    unlimited_restarts: bool = False
    base_cooldown_ms: float = 5000.0
    max_cooldown_ms: float = 300000.0
    require_operator_approval: bool = False
    stabilization_seconds: float = 30.0
    auto_recover_categories: tuple = ("connection", "model")

    def __post_init__(self) -> None:
        from errors import ConfigurationFailure

        if self.max_restarts < 0:
            raise ConfigurationFailure(f"max_restarts must be >= 0, got {self.max_restarts}")
        if self.restart_window_seconds <= 0:
            raise ConfigurationFailure("restart_window_seconds must be > 0")
        if self.max_cooldown_ms < self.base_cooldown_ms:
            raise ConfigurationFailure(
                f"max_cooldown_ms ({self.max_cooldown_ms}) must be >= base_cooldown_ms "
                f"({self.base_cooldown_ms})"
            )
        unknown = [c for c in self.auto_recover_categories if c not in _CATEGORY_ACTION]
        if unknown:
            raise ConfigurationFailure(
                f"unknown failure categories in autoRecoverCategories: {unknown} "
                f"(expected a subset of {tuple(_CATEGORY_ACTION)})"
            )
        # A profile asking to auto-recover configuration errors is a misconfiguration in itself, and
        # silently ignoring it would leave an operator believing recovery is armed when it is not.
        forbidden = [c for c in self.auto_recover_categories if c in NEVER_AUTO_RECOVER]
        if forbidden:
            raise ConfigurationFailure(
                f"failure categories {forbidden} can never be auto-recovered — a configuration error "
                "does not become correct by retrying it; fix the configuration"
            )

    def cooldown_for(self, attempt: int) -> float:
        """Bounded exponential backoff — the same shape as the AI-5b reconnect policy, deliberately.
        Two different backoff curves in one runtime is two things to reason about at 3am."""
        if attempt <= 0:
            return 0.0
        raw = self.base_cooldown_ms * (2 ** (attempt - 1))
        return min(self.max_cooldown_ms, raw)


def retail_policy() -> RecoveryPolicy:
    """Three restarts, then stop bothering anyone (Architect AI-5d rec 4)."""
    return RecoveryPolicy(max_restarts=3, restart_window_seconds=3600.0)


def factory_policy() -> RecoveryPolicy:
    """A production line: keep trying, ten times an hour."""
    return RecoveryPolicy(max_restarts=10, restart_window_seconds=3600.0)


def bank_policy() -> RecoveryPolicy:
    """Never give up, never hammer — unlimited restarts behind a long cooldown."""
    return RecoveryPolicy(
        max_restarts=0,
        unlimited_restarts=True,
        base_cooldown_ms=30000.0,
        max_cooldown_ms=900000.0,
        stabilization_seconds=120.0,
    )


def healthcare_policy() -> RecoveryPolicy:
    """Never auto-restart. Surface the condition and wait for a human to decide."""
    return RecoveryPolicy(max_restarts=0, require_operator_approval=True)


@dataclass(frozen=True)
class RecoveryRecord:
    """One permanently-retained recovery outcome (Architect AI-5d follow-up rec 1).

    Deliberately separate from the `RecoveryLedger`, which is **budget accounting** and is cleared
    when a session tears down. This is the **operational record**, and it survives teardown — because
    the question it answers ("this camera has failed the same way for three weeks") is unanswerable
    from a store that forgets every time the session restarts.

    Frozen and self-contained: it copies the few fields it needs rather than referencing a live
    account, so a record written in March still means in June exactly what it meant when written.
    """

    tenant_id: str
    camera_id: str
    session_id: str
    failure_category: Optional[str]
    trigger: str
    subsystem: str
    action: str
    outcome: str
    attempt: int
    duration_ms: float
    restart_count: int
    stabilization_seconds: float
    final_state: str
    at: str
    correlation_id: Optional[str] = None

    @property
    def succeeded(self) -> bool:
        return self.outcome == "succeeded"

    def to_dict(self) -> dict:
        out: dict = {
            "identity": {
                "tenantId": self.tenant_id,
                "cameraId": self.camera_id,
                "sessionId": self.session_id,
            },
            "trigger": self.trigger,
            "subsystem": self.subsystem,
            "action": self.action,
            "outcome": self.outcome,
            "attempt": self.attempt,
            "durationMs": round(self.duration_ms, 3),
            "restartCount": self.restart_count,
            "stabilizationSeconds": round(self.stabilization_seconds, 3),
            "finalState": self.final_state,
            "at": self.at,
        }
        if self.failure_category is not None:
            out["failureCategory"] = self.failure_category
        if self.correlation_id is not None:
            out["identity"]["correlationId"] = self.correlation_id
        return out


class RecoveryHistory:
    """Permanent, tenant-scoped recovery history + long-term failure analytics (recs 1 and 5).

    Bounded per tenant rather than per session: a box cycling sessions for a month must not grow
    without limit, but it also must not lose the pattern the moment a session is replaced — which is
    exactly when the pattern becomes interesting.

    Analytics here are **operational reporting, never runtime decisions** (rec 5). Nothing in the
    scheduler, governor or recovery path reads them; feeding long-term averages back into a live
    control loop is how a system starts reacting to last week.
    """

    def __init__(self, *, maxlen: int = 1000) -> None:
        self._records: Dict[str, Deque[RecoveryRecord]] = {}
        self._maxlen = maxlen

    def record(self, entry: RecoveryRecord) -> RecoveryRecord:
        self._records.setdefault(entry.tenant_id, deque(maxlen=self._maxlen)).appendleft(entry)
        return entry

    def list(
        self,
        *,
        tenant_id: Optional[str] = None,
        session_id: Optional[str] = None,
        camera_id: Optional[str] = None,
        limit: int = 50,
    ) -> List[dict]:
        """Newest first. A tenant filter is the norm; omitting it is an operator-wide view."""
        if tenant_id is not None:
            entries = list(self._records.get(tenant_id, ()))
        else:
            entries = [e for bucket in self._records.values() for e in bucket]
            entries.sort(key=lambda e: e.at, reverse=True)
        if session_id is not None:
            entries = [e for e in entries if e.session_id == session_id]
        if camera_id is not None:
            entries = [e for e in entries if e.camera_id == camera_id]
        return [e.to_dict() for e in entries[: max(0, limit)]]

    def count(self, *, tenant_id: Optional[str] = None) -> int:
        if tenant_id is not None:
            return len(self._records.get(tenant_id, ()))
        return sum(len(bucket) for bucket in self._records.values())

    def analytics(self, *, tenant_id: Optional[str] = None, camera_id: Optional[str] = None) -> dict:
        """Long-term failure statistics (rec 5) — operational reporting only.

        Averages are taken over **executed** recoveries only. Including refusals would drag the mean
        recovery time toward zero and make a deployment that never recovers look fastest of all.
        """
        if tenant_id is not None:
            entries = list(self._records.get(tenant_id, ()))
        else:
            entries = [e for bucket in self._records.values() for e in bucket]
        if camera_id is not None:
            entries = [e for e in entries if e.camera_id == camera_id]
        if not entries:
            return {
                "recoveries": 0,
                "byCategory": {},
                "byOutcome": {},
                "successPercent": 0.0,
                "averageRecoveryMs": 0.0,
                "averageStabilizationSeconds": 0.0,
                "restartsTotal": 0,
                "mostCommonFailure": None,
                "camerasAffected": 0,
            }

        by_category: Dict[str, int] = {}
        by_outcome: Dict[str, int] = {}
        for entry in entries:
            key = entry.failure_category or entry.trigger
            by_category[key] = by_category.get(key, 0) + 1
            by_outcome[entry.outcome] = by_outcome.get(entry.outcome, 0) + 1

        executed = [e for e in entries if e.outcome in ("succeeded", "failed")]
        succeeded = [e for e in entries if e.succeeded]
        return {
            "recoveries": len(entries),
            "byCategory": dict(sorted(by_category.items())),
            "byOutcome": dict(sorted(by_outcome.items())),
            "successPercent": round(100.0 * len(succeeded) / len(executed), 3) if executed else 0.0,
            "averageRecoveryMs": round(sum(e.duration_ms for e in executed) / len(executed), 3)
            if executed
            else 0.0,
            "averageStabilizationSeconds": round(
                sum(e.stabilization_seconds for e in entries) / len(entries), 3
            ),
            "restartsTotal": sum(1 for e in succeeded if e.action == "restart-session"),
            # Ties break alphabetically so the answer is stable across runs.
            "mostCommonFailure": min(
                sorted(by_category), key=lambda k: -by_category[k]
            ),
            "camerasAffected": len({e.camera_id for e in entries}),
        }

    def forget_tenant(self, tenant_id: str) -> None:
        """Only ever called on tenant offboarding — never on session teardown, which is the whole
        point of this store."""
        self._records.pop(tenant_id, None)


class RecoveryLedger:
    """Bounded per-session recovery history + rolling-window budget accounting.

    Tenant-qualified keys (Law 5): one tenant can never see or spend another's recovery budget, even
    if both happen to use the same camera id.
    """

    def __init__(self, *, maxlen: int = _LEDGER_MAX) -> None:
        self._entries: Dict[str, Deque[RecoveryAttempt]] = {}
        self._timestamps: Dict[str, Deque[float]] = {}
        self._last_success: Dict[str, float] = {}
        self._maxlen = maxlen

    @staticmethod
    def _key(identity: SessionIdentity) -> str:
        return f"{identity.tenant_id}::{identity.session_id}"

    def record(self, attempt: RecoveryAttempt, *, at: float, counts_against_budget: bool) -> None:
        key = self._key(attempt.identity)
        self._entries.setdefault(key, deque(maxlen=self._maxlen)).appendleft(attempt)
        if counts_against_budget:
            self._timestamps.setdefault(key, deque(maxlen=self._maxlen)).append(at)
        if attempt.recovered:
            self._last_success[key] = at

    def attempts_in_window(self, identity: SessionIdentity, *, now: float, window: float) -> int:
        """How many budget-consuming attempts fall inside the rolling window."""
        stamps = self._timestamps.get(self._key(identity))
        if not stamps:
            return 0
        cutoff = now - window
        while stamps and stamps[0] < cutoff:
            stamps.popleft()
        return len(stamps)

    def history(self, identity: SessionIdentity, *, limit: int = 20) -> List[dict]:
        entries = self._entries.get(self._key(identity), deque())
        return [a.to_dict() for a in list(entries)[: max(0, limit)]]

    def last_success_at(self, identity: SessionIdentity) -> Optional[float]:
        return self._last_success.get(self._key(identity))

    def total(self, identity: SessionIdentity) -> int:
        return len(self._entries.get(self._key(identity), ()))

    def forget(self, identity: SessionIdentity) -> None:
        """Release a session's ledger — nothing of it survives teardown (AI-5b refinement 8)."""
        key = self._key(identity)
        self._entries.pop(key, None)
        self._timestamps.pop(key, None)
        self._last_success.pop(key, None)


class AutoRecovery:
    """Decides whether and how to recover a session, within budget, and records why.

    It **decides**; it does not act. The caller supplies the `restart` callable, exactly as the runner
    applies governor decisions rather than making them — keeping the "report up, apply down" seam the
    Architect established in AI-5c.
    """

    def __init__(
        self,
        *,
        policy: Optional[RecoveryPolicy] = None,
        clock: Callable[[], float] = time.monotonic,
        now_iso: Optional[Callable[[], str]] = None,
        log: Optional[OperationalLog] = None,
        ledger: Optional[RecoveryLedger] = None,
        history: Optional[RecoveryHistory] = None,
    ) -> None:
        self._policy = policy or RecoveryPolicy()
        self._clock = clock
        self._now_iso = now_iso or _now_iso
        self._log = log
        self.ledger = ledger or RecoveryLedger()
        # Permanent operational record (rec 1). Shared across sessions and NOT cleared on teardown —
        # the ledger forgets a stopped session's budget; `records` keeps what happened to it.
        # Named apart from `history()` (the per-session ledger view) because the two answer
        # different questions and confusing them loses the durable one.
        self.records = history or RecoveryHistory()

    @property
    def policy(self) -> RecoveryPolicy:
        return self._policy

    # --- classification -------------------------------------------------------------

    def reason_for(
        self,
        exc: BaseException,
        *,
        identity: SessionIdentity,
        retry_count: int = 0,
        trigger: Optional[str] = None,
    ) -> RecoveryReason:
        """Build the structured reason from a raised failure, using the frozen AI-5b taxonomy."""
        category = failure_category(exc)
        return RecoveryReason(
            trigger=trigger or _CATEGORY_TRIGGER.get(category, "stall-detected"),
            subsystem=_CATEGORY_SUBSYSTEM.get(category, "session-runner"),
            severity=_CATEGORY_SEVERITY.get(category, "error"),
            retry_count=retry_count,
            correlation_id=identity.correlation_id,
            failure_category=category,
            failure_code=failure_code(category),
            detail=str(exc)[:500],
            at=self._now_iso(),
        )

    def health_reason(
        self, identity: SessionIdentity, *, score: float, retry_count: int = 0
    ) -> RecoveryReason:
        """A recovery triggered by declining health rather than a raised failure (rec 1 + rec 5)."""
        return RecoveryReason(
            trigger="health-decline",
            subsystem="session-runner",
            severity="warning" if score >= 50 else "error",
            retry_count=retry_count,
            correlation_id=identity.correlation_id,
            detail=f"health score {score:.1f}",
            at=self._now_iso(),
        )

    def action_for(self, reason: RecoveryReason) -> str:
        """The recovery action the taxonomy declares for this reason."""
        if reason.trigger == "health-decline":
            return "degrade"  # health never restarts a session; it degrades it via the governor
        if reason.failure_category is None:
            return "restart-session"
        return _CATEGORY_ACTION.get(reason.failure_category, "restart-session")

    # --- the decision ---------------------------------------------------------------

    def attempt(
        self,
        identity: SessionIdentity,
        reason: RecoveryReason,
        *,
        restart: Optional[Callable[[], None]] = None,
        rebind: Optional[Callable[[], None]] = None,
        restart_count: int = 0,
        final_state: Union[str, Callable[[], str]] = "unknown",
    ) -> RecoveryAttempt:
        """Evaluate one recovery opportunity and, when permitted, execute it.

        Every path returns a recorded `RecoveryAttempt` — including every refusal, each with the
        outcome that explains it. A recovery that did not happen is exactly as interesting to an
        operator as one that did.
        """
        now = self._clock()
        category = reason.failure_category
        action = self.action_for(reason)
        attempt_no = (
            self.ledger.attempts_in_window(
                identity, now=now, window=self._policy.restart_window_seconds
            )
            + 1
        )

        def record(outcome: str, *, detail: str, cooldown: Optional[float] = None) -> RecoveryAttempt:
            record_attempt = RecoveryAttempt(
                identity=identity,
                reason=reason,
                action=action,
                outcome=outcome,
                attempt=attempt_no,
                cooldown_ms=cooldown,
                detail=detail,
                at=self._now_iso(),
            )
            self.ledger.record(
                record_attempt,
                at=now,
                counts_against_budget=action not in _IN_BAND_ACTIONS
                and outcome in ("succeeded", "failed"),
            )
            # Duration is measured around the whole decision, not only the executor: a recovery that
            # spent four seconds deciding it was not allowed still cost four seconds.
            self.records.record(
                RecoveryRecord(
                    tenant_id=identity.tenant_id,
                    camera_id=identity.camera_id,
                    session_id=identity.session_id,
                    correlation_id=identity.correlation_id,
                    failure_category=reason.failure_category,
                    trigger=reason.trigger,
                    subsystem=reason.subsystem,
                    action=action,
                    outcome=outcome,
                    attempt=attempt_no,
                    duration_ms=(self._clock() - now) * 1000.0,
                    restart_count=restart_count,
                    stabilization_seconds=self._policy.stabilization_seconds,
                    final_state=_resolve_state(final_state),
                    at=record_attempt.at or self._now_iso(),
                )
            )
            self._emit(record_attempt)
            return record_attempt

        # 1. Never-retried categories. Enforced here, above policy, so no profile can override it.
        if category in NEVER_AUTO_RECOVER:
            action = "operator-intervention"
            return record(
                "operator-required",
                detail=(
                    f"{failure_code(category)} is never retried automatically — a configuration error "
                    "does not become correct by retrying it"
                ),
            )

        # 2. In-band actions need no budget: skipping a frame is not a recovery event.
        if action in _IN_BAND_ACTIONS:
            return record("succeeded", detail=f"handled in-band ({action})")

        # 3. Policy may simply not arm recovery for this category.
        if category is not None and category not in self._policy.auto_recover_categories:
            return record(
                "blocked-by-policy",
                detail=f"category '{category}' is not in autoRecoverCategories for this deployment",
            )

        # 4. Healthcare-style deployments: a human decides.
        if self._policy.require_operator_approval:
            return record(
                "operator-required",
                detail="this deployment requires operator approval before any automatic restart",
            )

        # 5. Anti-oscillation (rec 6): a session that just recovered has not proven anything yet.
        last_success = self.ledger.last_success_at(identity)
        if last_success is not None:
            elapsed = now - last_success
            if elapsed < self._policy.stabilization_seconds:
                return record(
                    "cooldown",
                    detail=(
                        f"inside the {self._policy.stabilization_seconds:g}s stabilization window "
                        f"({elapsed:.1f}s since the last recovery)"
                    ),
                    cooldown=(self._policy.stabilization_seconds - elapsed) * 1000.0,
                )

        # 6. Budget.
        if not self._policy.unlimited_restarts and attempt_no > self._policy.max_restarts:
            return record(
                "budget-exhausted",
                detail=(
                    f"{self._policy.max_restarts} restart(s) already used in the last "
                    f"{self._policy.restart_window_seconds:g}s; operator intervention required"
                ),
            )

        # 7. Execute.
        cooldown = self._policy.cooldown_for(attempt_no)
        executor = rebind if action == "rebind-model" and rebind is not None else restart
        if executor is None:
            return record("deferred", detail=f"no executor supplied for '{action}'", cooldown=cooldown)
        try:
            executor()
        except Exception as exc:  # noqa: BLE001 - a failed recovery is an outcome, not a crash
            return record("failed", detail=f"{action} failed: {str(exc)[:300]}", cooldown=cooldown)
        return record("succeeded", detail=f"{action} completed", cooldown=cooldown)

    # --- observability ---------------------------------------------------------------

    def stabilized(self, identity: SessionIdentity) -> bool:
        """Whether a session is past its post-recovery stabilization window (rec 6)."""
        last = self.ledger.last_success_at(identity)
        if last is None:
            return True
        return (self._clock() - last) >= self._policy.stabilization_seconds

    def budget_remaining(self, identity: SessionIdentity) -> Optional[int]:
        """Restarts left in the window, or None when unlimited."""
        if self._policy.unlimited_restarts:
            return None
        used = self.ledger.attempts_in_window(
            identity, now=self._clock(), window=self._policy.restart_window_seconds
        )
        return max(0, self._policy.max_restarts - used)

    def history(self, identity: SessionIdentity, *, limit: int = 20) -> List[dict]:
        return self.ledger.history(identity, limit=limit)

    def forget(self, identity: SessionIdentity) -> None:
        """Release a session's BUDGET accounting. The permanent history is untouched by design —
        forgetting it on teardown would erase the pattern exactly when it becomes interesting."""
        self.ledger.forget(identity)

    def analytics(self, *, tenant_id: Optional[str] = None, camera_id: Optional[str] = None) -> dict:
        """Long-term failure statistics (rec 5). Operational reporting; no runtime path reads it."""
        return self.records.analytics(tenant_id=tenant_id, camera_id=camera_id)

    def _emit(self, attempt: RecoveryAttempt) -> None:
        if self._log is None:
            return
        self._log.emit(
            f"recovery.{attempt.outcome}",
            level="error" if attempt.outcome in ("failed", "budget-exhausted") else "warn",
            action=attempt.action,
            trigger=attempt.reason.trigger,
            subsystem=attempt.reason.subsystem,
            severity=attempt.reason.severity,
            attempt=attempt.attempt,
            category=attempt.reason.failure_category,
            code=attempt.reason.failure_code,
            detail=attempt.detail,
        )


def _resolve_state(final_state: Union[str, Callable[[], str]]) -> str:
    """Accept a literal state or a resolver evaluated at record time.

    A resolver is what the runner passes, because "final state" only means something once the
    executor has run — reading it beforehand would record the state the recovery was meant to fix.
    """
    if callable(final_state):
        try:
            return str(final_state())
        except Exception:  # noqa: BLE001 - a diagnostics read must never break a recovery
            return "unknown"
    return str(final_state)


def _now_iso() -> str:
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"

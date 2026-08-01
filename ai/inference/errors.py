"""Runtime error taxonomy (stdlib-only). Kept in one place so the transport can map each to a
stable HTTP code and the pipeline stages can raise precisely."""

from __future__ import annotations


class ContextRequired(ValueError):
    """A frame arrived without a tenant context — dropped fail-closed (Law 5). → 400."""


class InferenceError(RuntimeError):
    """A pipeline stage failed on a frame (counted; the service keeps running). → 500."""


class SelectorUnresolved(LookupError):
    """No registry model satisfies the capability's selector — capability FAILED/UNAVAILABLE."""


class CapabilityLoadError(RuntimeError):
    """A capability could not be initialized (manifest/model load) — capability FAILED."""


class NotFound(LookupError):
    """A requested registry/job entity does not exist within the tenant scope. → 404."""


class Conflict(ValueError):
    """A registry/job operation conflicts with current state (duplicate, illegal transition). → 409."""


class ValidationError(ValueError):
    """An input failed validation before it reached the domain. → 400."""


# --- operational failure categories (AI-5b, Architect refinement 4) ------------------------------
# Production diagnostics must distinguish "the camera went away" from "the model broke" — each has a
# different remediation, so the categories are NEVER collapsed into one error counter. They are
# MUTUALLY EXCLUSIVE, and each maps to exactly one diagnostic code and one recovery path. Mirrors
# @vip/contracts `RuntimeFailureCategory` / `RUNTIME_FAILURE_CODES` / `RUNTIME_FAILURE_RECOVERY`:
#
#   category      tier         code        recovery
#   ------------- ------------ ----------- ------------------------------------------------
#   connection    ingestion    AI-CONN     reconnect with backoff (automatic)
#   model         engine       AI-MODEL    rebind / roll back the model version
#   inference     per-frame    AI-INFER    skip the frame; the session continues
#   pipeline      post-infer   AI-PIPE     skip the frame; the session continues
#   configuration control      AI-CONFIG   operator fix — NEVER retried, fail fast
#
# `configuration` is deliberately non-recoverable: retrying a bad source config or an unsupported
# transport only burns the reconnect budget and hides the real problem from the operator.
# `InferenceError` (above) IS the `inference` category and keeps its existing meaning/HTTP mapping.

FAILURE_CATEGORIES = ("connection", "model", "inference", "pipeline", "configuration")

FAILURE_CODES = {
    "connection": "AI-CONN",
    "model": "AI-MODEL",
    "inference": "AI-INFER",
    "pipeline": "AI-PIPE",
    "configuration": "AI-CONFIG",
}

FAILURE_RECOVERY = {
    "connection": "reconnect",
    "model": "rebind",
    "inference": "skip-frame",
    "pipeline": "skip-frame",
    "configuration": "operator",
}


class ConnectionFailure(RuntimeError):
    """A live video source could not be reached, or an established source dropped. Recoverable by
    the connection supervisor's reconnect budget; terminal only once that budget is exhausted."""

    category = "connection"


class ModelFailure(RuntimeError):
    """A model/engine could not be loaded or bound for a session. Reconnecting does NOT help — this
    needs a different model version or a registry fix, so it is fatal to the session."""

    category = "model"


class PipelineFailure(RuntimeError):
    """A post-inference stage (track/behavior/composite/translate/publish) failed on a frame. The
    perception result may be sound; the session keeps running and the frame is counted."""

    category = "pipeline"


class ConfigurationFailure(ValueError):
    """A session/source was configured invalidly (unknown transport, missing uri, bad limits). Never
    retried — an operator must fix it, so it fails fast instead of consuming the reconnect budget."""

    category = "configuration"


def failure_category(exc: BaseException) -> str:
    """Classify any exception into exactly one of FAILURE_CATEGORIES (defaults to `pipeline` — an
    unexpected stage error is a pipeline concern, never silently an ingestion or model problem)."""
    category = getattr(exc, "category", None)
    if category in FAILURE_CATEGORIES:
        return category
    if isinstance(exc, InferenceError):
        return "inference"
    if isinstance(exc, (SelectorUnresolved, CapabilityLoadError)):
        return "model"
    if isinstance(exc, ValidationError):
        return "configuration"
    return "pipeline"


def failure_code(category: str) -> str:
    """The stable diagnostic code for a category (log/alert correlation key)."""
    return FAILURE_CODES.get(category, "AI-PIPE")


def recovery_path(category: str) -> str:
    """How the runtime recovers from a category — `reconnect` / `rebind` / `skip-frame` / `operator`."""
    return FAILURE_RECOVERY.get(category, "skip-frame")

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

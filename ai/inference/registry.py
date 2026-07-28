"""CapabilityRegistry (#1) — loads capabilities from manifests (zero-code registration) and holds
them by id for discovery + routing. A `resolver_factory`/`adapter_factory` supply the model
resolver + backend per capability (chosen by the composition root from config), so the registry
itself stays backend-agnostic. Disabled manifests are registered but not initialized (state
DISABLED). Future: per-tenant capability sets layer on top of the same manifest loading.
"""

from __future__ import annotations

from typing import Callable, Dict, List

from capability import Capability
from manifest import CapabilityManifest, load_manifests
from pipeline import EventSink, ModelAdapter, NullEventSink
from resolver import ModelResolver


class CapabilityRegistry:
    def __init__(self, runtime_version: str, event_sink: EventSink | None = None) -> None:
        self._runtime_version = runtime_version
        # Shared across capabilities: the result carries its own tenant/capability, so one sink
        # routes every capability's outputs to the right tenant-partitioned subject. Default = null.
        self._event_sink: EventSink = event_sink or NullEventSink()
        self._by_id: Dict[str, Capability] = {}
        self._default_id: str | None = None

    def register(
        self,
        manifest: CapabilityManifest,
        resolver: ModelResolver,
        adapter: ModelAdapter,
    ) -> Capability:
        capability = Capability(
            manifest, resolver, adapter, self._runtime_version, event_sink=self._event_sink
        )
        self._by_id[manifest.capability_id] = capability
        if self._default_id is None and manifest.enabled:
            self._default_id = manifest.capability_id
        return capability

    def load_from_dir(
        self,
        directory: str,
        resolver_factory: Callable[[CapabilityManifest], ModelResolver],
        adapter_factory: Callable[[CapabilityManifest], ModelAdapter],
    ) -> List[Capability]:
        """Discover + register every manifest in a directory, then initialize the enabled ones."""
        built: List[Capability] = []
        for manifest in load_manifests(directory):
            cap = self.register(manifest, resolver_factory(manifest), adapter_factory(manifest))
            if manifest.enabled:
                cap.init()
            built.append(cap)
        return built

    def get(self, capability_id: str | None) -> Capability:
        cid = capability_id or self._default_id
        if cid is None or cid not in self._by_id:
            raise KeyError(f"unknown capability: {capability_id}")
        return self._by_id[cid]

    @property
    def default_id(self) -> str | None:
        return self._default_id

    def descriptors(self) -> List[dict]:
        return [c.descriptor() for c in self._by_id.values()]

    def health(self) -> List[dict]:
        return [c.health() for c in self._by_id.values()]

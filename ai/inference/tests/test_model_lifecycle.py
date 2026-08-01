"""Model lifecycle (AI-5d) — staged transitions, zero downtime, rollback, and history.

The claim under test is "no running session is interrupted". That is asserted structurally: the
analyzer reads its adapter through a slot per frame, so a switch is observable in the very next
frame's output and in no other way — no restart, no lost frame, no queue drain.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from contracts import FrameContext, ModelBinding  # noqa: E402
from errors import ConfigurationFailure, Conflict, NotFound  # noqa: E402
from model_lifecycle import (  # noqa: E402
    ModelLifecycleManager,
    ModelLifecyclePolicy,
    ModelSlot,
    ModelValidator,
    ModelWarmFailed,
)
from model_registry import ModelRegistry  # noqa: E402


class _Adapter:
    """A deterministic stand-in: `detections` per frame, `latency` ms per infer, optional failures."""

    execution_provider = "stub"

    def __init__(self, *, detections: int = 2, latency: float = 0.0, fail_load=False, fail_infer=False):
        self.detections = detections
        self.latency = latency
        self.fail_load = fail_load
        self.fail_infer = fail_infer
        self.loaded = False
        self.unloaded = False
        self.infer_calls = 0

    def load(self, ref: dict) -> None:
        if self.fail_load:
            raise RuntimeError("artifact is corrupt")
        self.loaded = True

    def preprocess(self, ctx):  # noqa: ANN001
        return ctx

    def infer(self, prepared):  # noqa: ANN001
        self.infer_calls += 1
        if self.fail_infer:
            raise RuntimeError("inference exploded")
        return [{"label": "person", "confidence": 0.9}] * self.detections

    def unload(self) -> None:
        self.unloaded = True


def _frames(count: int = 5):
    return [
        FrameContext(tenant_id="tnt_a", camera_id="cam_1", image=b"x", frame_number=i)
        for i in range(count)
    ]


def _binding(version: str) -> ModelBinding:
    return ModelBinding(name="person-detector", version=version, task="detection")


def _manager(registry=None, policy=None, clock=None) -> ModelLifecycleManager:
    stamps = iter([f"2026-08-01T00:00:{n:02d}.000Z" for n in range(60)])
    return ModelLifecycleManager(
        registry,
        policy=policy or ModelLifecyclePolicy(validation_frames=5),
        now_iso=lambda: next(stamps),
    )


def _registry_with(versions=("1.0.0", "2.0.0"), active="1.0.0") -> ModelRegistry:
    registry = ModelRegistry(clock=lambda: 0.0)
    model = registry.register("tnt_a", name="Person", task="detection", engine="onnx")
    for version in versions:
        registry.add_version(
            "tnt_a", model.id, version=version, format="onnx", artifact_uri=f"s3://m/{version}"
        )
    if active:
        registry.activate("tnt_a", model.id, active)
    return registry, model.id


class ModelSlotTest(unittest.TestCase):
    """The indirection that makes a swap zero-downtime."""

    def test_a_swap_changes_what_the_next_frame_executes(self):
        old, new = _Adapter(detections=1), _Adapter(detections=9)
        slot = ModelSlot(old, _binding("1.0.0"))
        self.assertIs(slot.adapter, old)
        slot.swap(new, _binding("2.0.0"))
        self.assertIs(slot.adapter, new)
        self.assertEqual(slot.binding.version, "2.0.0")

    def test_the_outgoing_model_stays_warm_while_draining(self):
        # A frame that entered under v1 must finish under v1 — a swap under an in-flight frame
        # produces a result belonging to neither version, which looks like data rather than a bug.
        old, new = _Adapter(), _Adapter()
        slot = ModelSlot(old, _binding("1.0.0"))
        slot.swap(new, _binding("2.0.0"))
        self.assertIs(slot.draining, old)
        self.assertFalse(old.unloaded)
        slot.finish_drain()
        self.assertIsNone(slot.draining)
        self.assertTrue(old.unloaded)

    def test_a_failing_unload_never_fails_a_successful_switch(self):
        class Stubborn(_Adapter):
            def unload(self) -> None:
                raise RuntimeError("will not go quietly")

        slot = ModelSlot(Stubborn(), _binding("1.0.0"))
        slot.swap(_Adapter(), _binding("2.0.0"))
        slot.finish_drain()  # must not raise
        self.assertIsNone(slot.draining)


class ZeroDowntimeTest(unittest.TestCase):
    """The load-bearing claim: a running analyzer picks up a new model with no restart."""

    def test_a_running_analyzer_sees_the_new_model_on_the_next_frame(self):
        from video_analyzer import AnalyzeOptions, VideoAnalyzer

        old, new = _Adapter(detections=1), _Adapter(detections=1)
        slot = ModelSlot(old, _binding("1.0.0"))
        analyzer = VideoAnalyzer(
            old,
            AnalyzeOptions(tenant_id="tnt_a", camera_id="cam_1", enable_behaviors=False),
            slot=slot,
        )
        self.assertEqual(analyzer._model.version, "1.0.0")
        slot.swap(new, _binding("2.0.0"))
        # No restart, no re-construction, no lost state — the analyzer simply reads the new version.
        self.assertEqual(analyzer._model.version, "2.0.0")
        self.assertIs(analyzer._adapter, new)

    def test_an_analyzer_without_a_slot_behaves_exactly_as_before(self):
        from video_analyzer import AnalyzeOptions, VideoAnalyzer

        adapter = _Adapter()
        analyzer = VideoAnalyzer(
            adapter, AnalyzeOptions(tenant_id="tnt_a", model_version="3.1.4", enable_behaviors=False)
        )
        self.assertIs(analyzer._adapter, adapter)
        self.assertEqual(analyzer._model.version, "3.1.4")
        self.assertTrue(adapter.loaded)


class ValidationTest(unittest.TestCase):
    """Operational validation — deliberately NOT accuracy validation."""

    def test_a_corrupt_artifact_fails_at_the_first_check(self):
        result = ModelValidator().validate(_Adapter(fail_load=True), frames=_frames())
        self.assertFalse(result.passed)
        self.assertEqual(result.failures, ["artifact-loads"])
        self.assertEqual(result.frames_evaluated, 0)

    def test_a_model_that_cannot_infer_fails(self):
        result = ModelValidator().validate(_Adapter(fail_infer=True), frames=_frames())
        self.assertFalse(result.passed)
        self.assertIn("inference-runs", result.failures)

    def test_a_healthy_candidate_passes_every_check(self):
        result = ModelValidator(ModelLifecyclePolicy(validation_frames=5)).validate(
            _Adapter(detections=2), frames=_frames(), incumbent=_Adapter(detections=2)
        )
        self.assertTrue(result.passed, result.failures)
        self.assertEqual(result.frames_evaluated, 5)
        self.assertEqual(result.candidate_detections, 10)
        self.assertEqual(result.incumbent_detections, 10)

    def test_a_silently_empty_model_is_caught_by_comparability(self):
        # The failure an operational gate exists for: it loads, it runs, it detects nothing, and
        # nobody notices for a week.
        result = ModelValidator(ModelLifecyclePolicy(detection_delta_percent=25.0)).validate(
            _Adapter(detections=0), frames=_frames(), incumbent=_Adapter(detections=4)
        )
        self.assertFalse(result.passed)
        self.assertIn("detection-comparability", result.failures)

    def test_an_absolute_latency_ceiling_is_enforced(self):
        policy = ModelLifecyclePolicy(validation_frames=3, max_validation_latency_ms=0.0)
        result = ModelValidator(policy).validate(_Adapter(), frames=_frames(3))
        latency = next(c for c in result.checks if c.name == "latency-budget")
        self.assertEqual(latency.budget, 0.0)

    def test_the_incumbent_is_measured_over_the_same_frames(self):
        # Comparing against a number from another day, another box, other frames is not a comparison.
        candidate, incumbent = _Adapter(), _Adapter()
        ModelValidator(ModelLifecyclePolicy(validation_frames=4)).validate(
            candidate, frames=_frames(10), incumbent=incumbent
        )
        self.assertEqual(candidate.infer_calls, 4)
        self.assertEqual(incumbent.infer_calls, 4)

    def test_a_genuine_latency_regression_is_caught(self):
        # An injected clock makes this deterministic: the candidate takes 10 ms/frame against an
        # incumbent's 2 ms, which is a 400% regression against a 25% bound.
        ticks = iter([0.0, 0.010, 0.010, 0.020, 0.020, 0.030] + [0.030, 0.032, 0.032, 0.034, 0.034, 0.036])
        validator = ModelValidator(
            ModelLifecyclePolicy(validation_frames=3, latency_regression_percent=25.0),
            clock=lambda: next(ticks),
        )
        result = validator.validate(_Adapter(), frames=_frames(3), incumbent=_Adapter())
        latency = next(c for c in result.checks if c.name == "latency-budget")
        self.assertFalse(latency.passed)
        self.assertFalse(result.passed)
        self.assertIn("latency-budget", result.failures)

    def test_two_instant_models_are_not_gated_on_timer_noise(self):
        # Both stubs measure well under a millisecond; calling the difference a regression would block
        # deployments on jitter, which is the opposite of what an evidence gate is for.
        result = ModelValidator(ModelLifecyclePolicy(validation_frames=3)).validate(
            _Adapter(), frames=_frames(3), incumbent=_Adapter()
        )
        latency = next(c for c in result.checks if c.name == "latency-budget")
        self.assertTrue(latency.passed)
        self.assertIn("timer noise", latency.detail)

    def test_validation_never_claims_to_check_accuracy(self):
        result = ModelValidator().validate(
            _Adapter(), frames=_frames(), incumbent=_Adapter()
        )
        names = {c.name for c in result.checks}
        self.assertNotIn("accuracy", names)
        comparability = next(c for c in result.checks if c.name == "detection-comparability")
        self.assertIn("NOT accuracy", comparability.detail)


class StagedTransitionTest(unittest.TestCase):
    def test_the_full_chain_promotes_the_new_version(self):
        registry, model_id = _registry_with()
        manager = _manager(registry)
        slot = ModelSlot(_Adapter(), _binding("1.0.0"))
        transition = manager.transition(
            "tnt_a",
            model_id,
            "2.0.0",
            loader=lambda: _Adapter(),
            frames=_frames(),
            incumbent=_Adapter(),
            slots=[slot],
        )
        self.assertEqual(transition.state, "active")
        self.assertEqual(slot.binding.version, "2.0.0")
        self.assertEqual(registry.require("tnt_a", model_id).active_version, "2.0.0")
        self.assertEqual(transition.sessions_affected, 1)

    def test_every_stage_is_recorded_in_order(self):
        registry, model_id = _registry_with()
        manager = _manager(registry)
        transition = manager.transition(
            "tnt_a", model_id, "2.0.0", loader=lambda: _Adapter(), frames=_frames(),
            incumbent=_Adapter(), slots=[ModelSlot(_Adapter(), _binding("1.0.0"))],
        )
        self.assertEqual(
            [e.state for e in transition.history],
            ["pending", "warming", "validating", "switching", "draining", "active"],
        )

    def test_a_warm_failure_never_touches_live_traffic(self):
        registry, model_id = _registry_with()
        manager = _manager(registry)
        slot = ModelSlot(_Adapter(), _binding("1.0.0"))
        transition = manager.begin("tnt_a", model_id, "2.0.0")
        with self.assertRaises(ModelWarmFailed):
            manager.warm("tnt_a", transition.id, loader=lambda: _Adapter(fail_load=True))
        self.assertEqual(transition.state, "failed")
        self.assertEqual(slot.binding.version, "1.0.0")  # untouched
        self.assertEqual(registry.require("tnt_a", model_id).active_version, "1.0.0")

    def test_failed_validation_rolls_back_and_never_switches(self):
        registry, model_id = _registry_with()
        manager = _manager(registry, policy=ModelLifecyclePolicy(validation_frames=5))
        slot = ModelSlot(_Adapter(detections=4), _binding("1.0.0"))
        transition = manager.transition(
            "tnt_a", model_id, "2.0.0",
            loader=lambda: _Adapter(detections=0),  # detects nothing
            frames=_frames(), incumbent=_Adapter(detections=4), slots=[slot],
        )
        self.assertEqual(transition.state, "rolled-back")
        self.assertIn("detection-comparability", transition.rollback_reason)
        self.assertEqual(slot.binding.version, "1.0.0")
        self.assertEqual(registry.require("tnt_a", model_id).active_version, "1.0.0")

    def test_switching_without_validation_is_refused_by_policy(self):
        registry, model_id = _registry_with()
        manager = _manager(registry)
        transition = manager.begin("tnt_a", model_id, "2.0.0")
        manager.warm("tnt_a", transition.id, loader=lambda: _Adapter())
        with self.assertRaises(Conflict):
            manager.switch("tnt_a", transition.id)

    def test_an_explicit_rollback_restores_the_incumbent(self):
        registry, model_id = _registry_with()
        manager = _manager(registry)
        incumbent = _Adapter()
        slot = ModelSlot(incumbent, _binding("1.0.0"))
        transition = manager.begin("tnt_a", model_id, "2.0.0")
        manager.warm("tnt_a", transition.id, loader=lambda: _Adapter())
        manager.validate("tnt_a", transition.id, frames=_frames(), incumbent=_Adapter())
        manager.switch("tnt_a", transition.id, slots=[slot])
        self.assertEqual(slot.binding.version, "2.0.0")
        manager.rollback(
            "tnt_a", transition.id, reason="latency spiked in production",
            slots=[slot], adapter=incumbent,
        )
        self.assertEqual(transition.state, "rolled-back")
        self.assertEqual(slot.binding.version, "1.0.0")
        self.assertIn("latency spiked", transition.rollback_reason)

    def test_two_concurrent_rollouts_on_one_model_are_refused(self):
        registry, model_id = _registry_with()
        manager = _manager(registry)
        manager.begin("tnt_a", model_id, "2.0.0")
        with self.assertRaises(Conflict):
            manager.begin("tnt_a", model_id, "2.0.0")

    def test_activating_the_already_active_version_is_refused(self):
        registry, model_id = _registry_with()
        with self.assertRaises(Conflict):
            _manager(registry).begin("tnt_a", model_id, "1.0.0")

    def test_an_unknown_version_is_refused_before_anything_starts(self):
        registry, model_id = _registry_with()
        with self.assertRaises(NotFound):
            _manager(registry).begin("tnt_a", model_id, "9.9.9")

    def test_a_finished_transition_cannot_be_mutated(self):
        # History must stay append-only: returning to v1 after v2 went active is a NEW transition.
        registry, model_id = _registry_with()
        manager = _manager(registry)
        transition = manager.transition(
            "tnt_a", model_id, "2.0.0", loader=lambda: _Adapter(), frames=_frames(),
            incumbent=_Adapter(), slots=[ModelSlot(_Adapter(), _binding("1.0.0"))],
        )
        with self.assertRaises(Conflict):
            manager.rollback("tnt_a", transition.id, reason="too late")


class HistoryTest(unittest.TestCase):
    """Rec 3: every transition stays queryable, and the version path reads as a story."""

    def test_the_version_path_shows_a_rollback(self):
        # The Architect's example: v1 → v2 → rollback → v1 → v3 → v4.
        registry, model_id = _registry_with(versions=("v1", "v2", "v3", "v4"), active="v1")
        manager = _manager(registry, policy=ModelLifecyclePolicy(validation_frames=3))

        def run(to_version, candidate_detections=2):
            return manager.transition(
                "tnt_a", model_id, to_version,
                loader=lambda: _Adapter(detections=candidate_detections),
                frames=_frames(3), incumbent=_Adapter(detections=2),
                slots=[ModelSlot(_Adapter(), _binding("v1"))],
            )

        run("v2", candidate_detections=0)  # fails comparability → rolled back to v1
        run("v3")
        run("v4")
        history = manager.history("tnt_a", model_id)
        self.assertEqual(history["versionPath"], ["v1", "v1", "v3", "v4"])
        self.assertEqual(history["activeVersion"], "v4")
        self.assertEqual(len(history["transitions"]), 3)
        self.assertEqual(history["transitions"][0]["state"], "rolled-back")

    def test_history_is_oldest_first(self):
        registry, model_id = _registry_with(versions=("v1", "v2", "v3"), active="v1")
        manager = _manager(registry, policy=ModelLifecyclePolicy(validation_frames=2))
        for version in ("v2", "v3"):
            manager.transition(
                "tnt_a", model_id, version, loader=lambda: _Adapter(), frames=_frames(2),
                incumbent=_Adapter(), slots=[],
            )
        versions = [t.to_version for t in manager.list("tnt_a", model_id=model_id)]
        self.assertEqual(versions, ["v2", "v3"])

    def test_a_transition_serializes_to_the_contract_shape(self):
        registry, model_id = _registry_with()
        manager = _manager(registry)
        transition = manager.transition(
            "tnt_a", model_id, "2.0.0", loader=lambda: _Adapter(), frames=_frames(),
            incumbent=_Adapter(), slots=[],
        )
        out = transition.to_dict()
        for key in ("id", "tenantId", "modelId", "fromVersion", "toVersion", "state", "history"):
            self.assertIn(key, out)
        self.assertEqual(out["validation"]["passed"], True)


class TenantIsolationTest(unittest.TestCase):
    def test_one_tenant_cannot_see_anothers_rollout(self):
        registry, model_id = _registry_with()
        manager = _manager(registry)
        transition = manager.begin("tnt_a", model_id, "2.0.0")
        # Invisible, never "forbidden" — a 404, exactly as Law 5 requires everywhere else.
        self.assertIsNone(manager.get("tnt_b", transition.id))
        with self.assertRaises(NotFound):
            manager.require("tnt_b", transition.id)
        self.assertEqual(manager.list("tnt_b"), [])


class PolicyTest(unittest.TestCase):
    def test_impossible_policies_are_rejected_at_construction(self):
        for kwargs in (
            {"validation_frames": 0},
            {"detection_delta_percent": 200.0},
            {"drain_ms": -1.0},
        ):
            with self.assertRaises(ConfigurationFailure, msg=str(kwargs)):
                ModelLifecyclePolicy(**kwargs)

    def test_candidates_are_per_manager_never_shared(self):
        # Two managers must not be able to hand each other a warmed adapter.
        registry, model_id = _registry_with()
        a, b = _manager(registry), _manager()
        self.assertIsNot(a._candidates, b._candidates)



class HistoryPersistenceTest(unittest.TestCase):
    """AI-5d follow-up rec 3: in-memory history dies with the process, and "what changed?" is asked
    precisely when a process has just restarted."""

    def _run_transitions(self):
        registry, model_id = _registry_with(versions=("v1", "v2", "v3"), active="v1")
        manager = _manager(registry, policy=ModelLifecyclePolicy(validation_frames=2))
        for version, detections in (("v2", 2), ("v3", 2)):
            manager.transition(
                "tnt_a", model_id, version, loader=lambda d=detections: _Adapter(detections=d),
                frames=_frames(2), incumbent=_Adapter(detections=2), slots=[],
            )
        return manager, model_id

    def test_history_round_trips_through_an_export(self):
        manager, model_id = self._run_transitions()
        document = manager.export_history("tnt_a")
        restored = _manager()
        self.assertEqual(restored.import_history(document), 2)
        self.assertEqual(
            restored.history("tnt_a", model_id)["versionPath"],
            manager.history("tnt_a", model_id)["versionPath"],
        )

    def test_an_export_can_be_written_to_disk(self):
        import json
        import tempfile

        manager, _model_id = self._run_transitions()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "nested", "model-history.json")
            manager.export_history("tnt_a", path=path)
            with open(path, encoding="utf-8") as fh:
                document = json.load(fh)
        self.assertEqual(document["tenantId"], "tnt_a")
        self.assertEqual(len(document["models"]), 1)

    def test_importing_twice_changes_nothing(self):
        manager, model_id = self._run_transitions()
        document = manager.export_history("tnt_a")
        restored = _manager()
        restored.import_history(document)
        self.assertEqual(restored.import_history(document), 0)
        self.assertEqual(len(restored.list("tnt_a")), 2)

    def test_an_in_flight_rollout_is_not_restored(self):
        # Its warmed adapter no longer exists, so a resumed transition could never complete.
        registry, model_id = _registry_with()
        manager = _manager(registry)
        manager.begin("tnt_a", model_id, "2.0.0")
        restored = _manager()
        self.assertEqual(restored.import_history(manager.export_history("tnt_a")), 0)

    def test_restored_history_interleaves_by_time(self):
        manager, model_id = self._run_transitions()
        document = manager.export_history("tnt_a")
        restored = _manager()
        restored.import_history(document)
        starts = [t.started_at for t in restored.list("tnt_a")]
        self.assertEqual(starts, sorted(starts))

    def test_an_export_without_a_tenant_is_rejected(self):
        from errors import ValidationError

        with self.assertRaises(ValidationError):
            _manager().import_history({"models": []})

    def test_a_rollback_always_leaves_a_mark_on_the_version_path(self):
        # A rollback that records nothing reads as though nothing was attempted — the opposite of
        # what this history is for, even when the incumbent version is unknown.
        manager = _manager(policy=ModelLifecyclePolicy(validation_frames=2))
        manager.transition(
            "tnt_a", "mdl_1", "v2", loader=lambda: _Adapter(detections=2), frames=_frames(2),
            incumbent=_Adapter(detections=2), slots=[],
        )
        manager.transition(
            "tnt_a", "mdl_1", "v3", loader=lambda: _Adapter(detections=0), frames=_frames(2),
            incumbent=_Adapter(detections=4), slots=[],
        )
        self.assertEqual(manager.history("tnt_a", "mdl_1")["versionPath"], ["v2", "v2"])

if __name__ == "__main__":  # pragma: no cover
    unittest.main()

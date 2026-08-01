"""AI-5c — Compute resources: hardware independence, capacity, reservations, monitoring.

The load-bearing property here is that NOTHING in this module knows what CUDA is. A test that a CPU
and a GPU are treated identically by placement is the proof that adding TensorRT or Metal later is a
registry entry rather than a scheduler change.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from compute import (
    COMPUTE_KINDS,
    ComputeRegistry,
    ComputeResource,
    ResourceMonitor,
    ResourceSnapshot,
    detect_resources,
)
from errors import ConfigurationFailure


class ComputeResourceTest(unittest.TestCase):
    def test_covers_every_declared_accelerator_kind(self):
        self.assertEqual(
            COMPUTE_KINDS, ("cpu", "cuda", "tensorrt", "openvino", "metal", "tpu", "npu")
        )
        for kind in COMPUTE_KINDS:
            resource = ComputeResource(id=f"{kind}:0", kind=kind, capacity_units=2.0)
            self.assertEqual(resource.kind, kind)

    def test_rejects_unknown_kind_and_bad_capacity(self):
        with self.assertRaises(ConfigurationFailure):
            ComputeResource(id="x", kind="quantum", capacity_units=1.0)
        with self.assertRaises(ConfigurationFailure):
            ComputeResource(id="cpu:0", kind="cpu", capacity_units=0)

    def test_allocation_is_bounded_and_release_never_manufactures_capacity(self):
        resource = ComputeResource(id="cpu:0", kind="cpu", capacity_units=2.0)
        resource.allocate(1.5)
        self.assertAlmostEqual(resource.free_units, 0.5)
        with self.assertRaises(ConfigurationFailure):
            resource.allocate(1.0)
        resource.release(1.5)
        resource.release(5.0)  # double release
        self.assertAlmostEqual(resource.allocated_units, 0.0)
        self.assertAlmostEqual(resource.free_units, 2.0)


class PlacementTest(unittest.TestCase):
    def test_places_on_the_resource_with_most_free_capacity_regardless_of_kind(self):
        registry = ComputeRegistry(
            [
                ComputeResource(id="cpu:0", kind="cpu", capacity_units=4.0),
                ComputeResource(id="cuda:0", kind="cuda", capacity_units=8.0),
            ]
        )
        # The GPU wins on free capacity — not because the code knows it is a GPU.
        self.assertEqual(registry.place(1.0).id, "cuda:0")
        registry.get("cuda:0").allocate(7.5)
        self.assertEqual(registry.place(1.0).id, "cpu:0")

    def test_placement_is_deterministic_on_ties(self):
        registry = ComputeRegistry(
            [
                ComputeResource(id="cpu:1", kind="cpu", capacity_units=4.0),
                ComputeResource(id="cpu:0", kind="cpu", capacity_units=4.0),
            ]
        )
        self.assertEqual(registry.place(1.0).id, "cpu:0")  # id breaks the tie, every run

    def test_can_restrict_placement_to_specific_kinds(self):
        registry = ComputeRegistry([ComputeResource(id="cpu:0", kind="cpu", capacity_units=4.0)])
        self.assertIsNone(registry.place(1.0, kinds=["cuda"]))
        self.assertIsNotNone(registry.place(1.0, kinds=["cpu"]))

    def test_resource_ids_are_node_qualifiable_for_future_distribution(self):
        # Nothing assumes a resource is machine-local (rec 8).
        registry = ComputeRegistry(
            [ComputeResource(id="node-a/cuda:0", kind="cuda", capacity_units=8.0)]
        )
        self.assertEqual(registry.place(1.0).id, "node-a/cuda:0")

    def test_unit_cost_scales_with_frame_rate_and_favours_accelerators(self):
        registry = ComputeRegistry()
        cpu_5 = registry.unit_cost("cpu", target_fps=5)
        cpu_10 = registry.unit_cost("cpu", target_fps=10)
        self.assertAlmostEqual(cpu_10, cpu_5 * 2)  # linear in frame rate
        self.assertLess(registry.unit_cost("cuda", target_fps=5), cpu_5)


class ReservationTest(unittest.TestCase):
    """Refinement 1: a runtime at 100% committed cannot recover from its own success."""

    def test_ordinary_work_cannot_consume_the_reserve(self):
        registry = ComputeRegistry(
            [ComputeResource(id="cpu:0", kind="cpu", capacity_units=10.0)], reserved_percent=20.0
        )
        self.assertAlmostEqual(registry.reserved_units, 2.0)
        self.assertAlmostEqual(registry.unreserved_free_capacity, 8.0)
        registry.get("cpu:0").allocate(8.0)
        self.assertIsNone(registry.place(1.0))  # would eat the reserve

    def test_privileged_work_may_draw_on_the_reserve(self):
        registry = ComputeRegistry(
            [ComputeResource(id="cpu:0", kind="cpu", capacity_units=10.0)], reserved_percent=20.0
        )
        registry.get("cpu:0").allocate(8.0)
        self.assertIsNotNone(registry.place(1.0, privileged=True))

    def test_rejects_an_absurd_reservation(self):
        with self.assertRaises(ConfigurationFailure):
            ComputeRegistry([], reserved_percent=90.0)


class ResourceMonitorTest(unittest.TestCase):
    def test_cpu_percent_is_derived_deterministically_from_injected_clocks(self):
        wall = [0.0]
        cpu = [0.0]
        monitor = ResourceMonitor(
            clock=lambda: wall[0],
            cpu_time=lambda: cpu[0],
            rss_mb=lambda: 100.0,
            now_iso=lambda: "t",
        )
        wall[0] = 1.0
        cpu[0] = 0.5 * (os.cpu_count() or 1)  # half of every core busy for one second
        snapshot = monitor.sample()
        self.assertAlmostEqual(snapshot.cpu_percent, 50.0, places=3)
        self.assertEqual(snapshot.memory_mb, 100.0)

    def test_a_failing_gpu_probe_never_breaks_monitoring(self):
        def explode():
            raise RuntimeError("nvml not present")

        monitor = ResourceMonitor(gpu_probe=explode, rss_mb=lambda: 1.0, now_iso=lambda: "t")
        self.assertIsNone(monitor.sample().gpu_percent)  # degrades to "no reading", not a crash

    def test_absent_readings_stay_absent_rather_than_becoming_zero(self):
        snapshot = ResourceSnapshot(cpu_percent=None, memory_mb=None)
        self.assertNotIn("cpuPercent", snapshot.to_dict())  # zero and unknown mean opposite things


class DetectionTest(unittest.TestCase):
    def test_a_cpu_always_exists_and_accelerator_probing_is_optional(self):
        registry = detect_resources(probe_accelerators=False)
        self.assertTrue(any(r.kind == "cpu" for r in registry.list()))
        self.assertGreater(registry.total_capacity, 0)


if __name__ == "__main__":
    unittest.main()

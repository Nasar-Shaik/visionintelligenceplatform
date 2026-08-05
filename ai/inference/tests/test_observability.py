"""P-8 Phase 2 — the two things Phase 1 measured as missing: honest capacity, and a runtime that
speaks. Both were found by deploying, so both are pinned here where a refactor will trip over them.
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import obslog  # noqa: E402
from compute import _cgroup_quota_cores, available_cores  # noqa: E402


class CgroupAwareCapacityTests(unittest.TestCase):
    """TD-61. ⚠️ `os.cpu_count()` reports the HOST's cores inside a container; sizing admission from
    it admits sessions the kernel will not grant."""

    def _root(self, files: dict) -> str:
        root = tempfile.mkdtemp()
        for name, body in files.items():
            path = os.path.join(root, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(body)
        return root

    def test_v2_quota_is_read_as_cores(self):
        root = self._root({"cpu.max": "200000 100000\n"})
        self.assertEqual(_cgroup_quota_cores(root), 2.0)

    def test_v2_unlimited_reads_as_no_limit(self):
        root = self._root({"cpu.max": "max 100000\n"})
        self.assertIsNone(_cgroup_quota_cores(root))

    def test_v1_quota_is_read_as_cores(self):
        root = self._root(
            {"cpu/cpu.cfs_quota_us": "150000\n", "cpu/cpu.cfs_period_us": "100000\n"}
        )
        self.assertEqual(_cgroup_quota_cores(root), 1.5)

    def test_v1_unlimited_reads_as_no_limit(self):
        root = self._root({"cpu/cpu.cfs_quota_us": "-1\n", "cpu/cpu.cfs_period_us": "100000\n"})
        self.assertIsNone(_cgroup_quota_cores(root))

    def test_missing_cgroup_is_not_fatal(self):
        self.assertIsNone(_cgroup_quota_cores(os.path.join(tempfile.mkdtemp(), "absent")))

    def test_available_cores_never_exceeds_the_quota(self):
        root = self._root({"cpu.max": "100000 100000\n"})  # one core
        self.assertEqual(available_cores(root), 1.0)

    def test_available_cores_falls_back_to_the_host_when_unlimited(self):
        root = self._root({"cpu.max": "max 100000\n"})
        self.assertEqual(available_cores(root), float(os.cpu_count() or 1))

    def test_available_cores_is_never_zero(self):
        """A quota below one core still leaves a runtime that must admit at least one session, or a
        0.5-CPU container refuses everything and reports nothing about why."""
        root = self._root({"cpu.max": "50000 100000\n"})
        self.assertEqual(available_cores(root), 1.0)


class StructuredLoggingTests(unittest.TestCase):
    """TD-60. The runtime said one sentence at boot and nothing ever again."""

    def _emit(self, fn, *args, **kwargs) -> list:
        buf = io.StringIO()
        with redirect_stdout(buf):
            fn(*args, **kwargs)
        return [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]

    def setUp(self):
        obslog.configure("info", service="inference")

    def test_a_line_is_json_with_pino_field_names(self):
        (record,) = self._emit(obslog.info, "inference runtime listening", version="0.1.0")
        # ⚠️ pino's names, so one aggregator reads the whole platform without a second parser.
        self.assertEqual(record["level"], 30)
        self.assertEqual(record["msg"], "inference runtime listening")
        self.assertEqual(record["service"], "inference")
        self.assertEqual(record["version"], "0.1.0")
        self.assertIsInstance(record["time"], int)

    def test_levels_map_to_pino_numbers(self):
        self.assertEqual(self._emit(obslog.warn, "w")[0]["level"], 40)
        self.assertEqual(self._emit(obslog.error, "e")[0]["level"], 50)

    def test_below_threshold_is_silent(self):
        obslog.configure("warn")
        self.assertEqual(self._emit(obslog.info, "quiet"), [])
        self.assertEqual(len(self._emit(obslog.warn, "loud")), 1)

    def test_an_unknown_level_does_not_stop_the_container(self):
        obslog.configure("not-a-level")
        self.assertEqual(len(self._emit(obslog.info, "still logging")), 1)

    def test_a_field_that_cannot_be_serialised_still_produces_a_line(self):
        """⚠️ A logger that raises on the request path is worse than no logger."""

        class Unserialisable:
            def __repr__(self):
                raise RuntimeError("nope")

        records = self._emit(obslog.info, "odd field", weird=Unserialisable())
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["msg"], "odd field")

    def test_none_valued_fields_are_omitted_rather_than_logged_as_null(self):
        (record,) = self._emit(obslog.info, "m", present=1, absent=None)
        self.assertIn("present", record)
        self.assertNotIn("absent", record)


if __name__ == "__main__":
    unittest.main()

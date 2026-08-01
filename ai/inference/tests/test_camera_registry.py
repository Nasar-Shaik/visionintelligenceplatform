"""AI-5e camera compatibility registry tests.

The registry's job is to accumulate what the platform has learned about real devices without ever
overstating it. So the tests are about the two boundaries: a `certified` row must be able to name its
evidence and that evidence must be hardware, and discovery — which learns a great deal — must not
change a status at all.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from camera_registry import (  # noqa: E402
    REGISTRY_DIR,
    CameraRegistry,
    CameraRegistryEntry,
    RegistryError,
    entry_from_dict,
    render_matrix,
)
from onvif import DiscoveredDevice, StreamProfile  # noqa: E402


def _entry(**kw) -> CameraRegistryEntry:
    defaults = dict(id="acme-x1", manufacturer="Acme", model="X1")
    defaults.update(kw)
    return CameraRegistryEntry(**defaults)


def _summary(status="certified", evidence_class="hardware", **kw):
    out = {
        "id": "cert_acme-x1",
        "status": status,
        "evidenceClass": evidence_class,
        "compatibilityId": "compat_acme-x1",
        "benchmarkIds": ["bench_1"],
        "blockers": [],
    }
    out.update(kw)
    return out


class InvariantTest(unittest.TestCase):
    def test_a_new_entry_defaults_to_pending_validation(self):
        entry = _entry()
        self.assertEqual(entry.status, "pending-validation")
        self.assertEqual(entry.evidence, [])
        self.assertEqual(entry.evidence_class, "simulated")

    def test_a_certified_entry_with_no_evidence_is_refused(self):
        """Without this, "certified" degrades into "someone was fairly sure"."""
        with self.assertRaises(RegistryError):
            _entry(status="certified", evidence_class="hardware")

    def test_a_certified_entry_on_simulated_evidence_is_refused(self):
        with self.assertRaises(RegistryError) as ctx:
            _entry(status="certified", evidence=["cert_1"], evidence_class="simulated")
        self.assertIn("physical hardware", str(ctx.exception))

    def test_a_certified_entry_with_hardware_evidence_is_accepted(self):
        entry = _entry(status="certified", evidence=["cert_1"], evidence_class="hardware")
        self.assertEqual(entry.status, "certified")

    def test_an_unknown_status_is_refused(self):
        with self.assertRaises(RegistryError):
            _entry(status="probably-works")

    def test_an_unknown_kind_is_refused(self):
        with self.assertRaises(RegistryError):
            _entry(kind="drone")


class ObservationTest(unittest.TestCase):
    def _device(self) -> DiscoveredDevice:
        return DiscoveredDevice(
            address="http://10.0.0.5/onvif/device_service",
            manufacturer="Hikvision",
            model="DS-2CD2143G2",
            firmware="V5.7.3",
            onvif_version="2.60",
            profiles=[
                StreamProfile(name="main", width=2560, height=1440, codec="h264"),
                StreamProfile(
                    name="sub", width=640, height=360, codec="h264", path="/Streaming/Channels/102",
                    preferred_for_analysis=True,
                ),
            ],
        )

    def test_discovery_records_the_device_without_certifying_it(self):
        """The easiest possible way for this registry to start lying would be to let a successful
        `GetDeviceInformation` be mistaken for a passing certification run."""
        registry = CameraRegistry(tempfile.mkdtemp())
        entry = registry.observe(self._device())
        self.assertEqual(entry.status, "pending-validation")
        self.assertEqual(entry.evidence, [])
        self.assertEqual(entry.evidence_class, "simulated")

    def test_discovery_captures_the_recommended_sub_stream(self):
        registry = CameraRegistry(tempfile.mkdtemp())
        entry = registry.observe(self._device())
        self.assertEqual(entry.recommended_settings["streamProfile"], "sub")
        self.assertEqual(entry.recommended_settings["resolution"], "640x360")
        self.assertEqual(entry.id, "hikvision-ds-2cd2143g2")

    def test_observing_the_same_device_twice_accumulates_firmware(self):
        registry = CameraRegistry(tempfile.mkdtemp())
        registry.observe(self._device())
        device = self._device()
        device.firmware = "V5.8.0"
        entry = registry.observe(device)
        self.assertEqual(entry.firmware, ["V5.7.3", "V5.8.0"])
        self.assertEqual(len(registry), 1)


class CertifyTest(unittest.TestCase):
    def setUp(self):
        self.registry = CameraRegistry(tempfile.mkdtemp())
        self.registry.add(_entry())

    def test_a_certified_summary_promotes_the_entry_and_names_its_evidence(self):
        entry = self.registry.certify("acme-x1", _summary())
        self.assertEqual(entry.status, "certified")
        self.assertIn("cert_acme-x1", entry.evidence)
        self.assertIn("compat_acme-x1", entry.evidence)
        self.assertIn("bench_1", entry.evidence)
        self.assertIsNotNone(entry.certified_at)
        self.assertEqual(entry.certification_version, "1.0.0")

    def test_a_pending_summary_leaves_the_entry_pending_with_no_evidence(self):
        entry = self.registry.certify(
            "acme-x1", _summary(status="pending-validation", evidence_class="simulated")
        )
        self.assertEqual(entry.status, "pending-validation")
        self.assertEqual(entry.evidence, [])
        self.assertIsNone(entry.certified_at)

    def test_a_failed_summary_records_its_blockers_as_known_issues(self):
        """Blockers are the most useful thing a failed run produces. Keeping them on the entry means
        the next engineer reads 'needs firmware >= 5.7' instead of rediscovering it."""
        entry = self.registry.certify(
            "acme-x1",
            _summary(status="failed", blockers=["check 'stream-acquisition' failed: no frames"]),
        )
        self.assertEqual(entry.status, "failed")
        self.assertIn("check 'stream-acquisition' failed: no frames", entry.known_issues)

    def test_certifying_an_unknown_entry_raises(self):
        with self.assertRaises(RegistryError):
            self.registry.certify("nope", _summary())

    def test_recommended_settings_can_be_recorded_at_certification(self):
        entry = self.registry.certify(
            "acme-x1", _summary(), recommended_settings={"rtspTransport": "tcp"}
        )
        self.assertEqual(entry.recommended_settings["rtspTransport"], "tcp")


class PersistenceTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_entries_round_trip_through_json(self):
        registry = CameraRegistry(self.dir)
        registry.add(_entry(known_issues=["needs TCP"], transports=["rtsp"]))
        registry.save()
        again = CameraRegistry(self.dir).load()
        self.assertEqual(len(again), 1)
        self.assertEqual(again.get("acme-x1").known_issues, ["needs TCP"])

    def test_a_duplicate_id_on_disk_is_refused(self):
        for name in ("a.json", "b.json"):
            with open(os.path.join(self.dir, name), "w", encoding="utf-8") as fh:
                json.dump(_entry().to_dict(), fh)
        with self.assertRaises(RegistryError):
            CameraRegistry(self.dir).load()

    def test_an_empty_directory_loads_cleanly(self):
        self.assertEqual(len(CameraRegistry(self.dir).load()), 0)


class ShippedRegistryTest(unittest.TestCase):
    """The registry that actually ships in the repository."""

    def setUp(self):
        self.registry = CameraRegistry().load()

    def test_it_loads_and_covers_the_pilot_market(self):
        labels = " ".join(e.label.lower() for e in self.registry.entries())
        for vendor in ("hikvision", "dahua", "cp plus", "axis", "uniview"):
            self.assertIn(vendor, labels)

    def test_dvr_and_nvr_estates_are_first_class_rows(self):
        kinds = {e.kind for e in self.registry.entries()}
        self.assertIn("dvr", kinds)
        self.assertIn("nvr", kinds)

    def test_every_shipped_device_is_pending_validation(self):
        """The single claim this milestone must not make. These rows are a to-do list, not a support
        matrix, and nothing may move off `pending-validation` without a physical run."""
        for entry in self.registry.entries():
            self.assertEqual(entry.status, "pending-validation", entry.id)
            self.assertEqual(entry.evidence, [], entry.id)
            self.assertIsNone(entry.certified_at, entry.id)

    def test_the_registry_directory_is_where_the_module_says_it_is(self):
        self.assertTrue(os.path.isdir(REGISTRY_DIR))

    def test_the_matrix_spells_the_status_out_in_words(self):
        # A tick or a dash invites an optimistic reading; words do not.
        text = render_matrix(self.registry.matrix())
        self.assertIn("Pending Validation", text)
        self.assertNotIn("✓", text)


if __name__ == "__main__":
    unittest.main()

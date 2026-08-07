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


class PromotionRefusalTest(unittest.TestCase):
    """⭐ P-9 A6. Promotion happens from a bundle or it does not happen.

    These are the tests the milestone exists for. A device is promoted at most a handful of times in
    its life and the cost of one wrong promotion is a support matrix that lies to a customer — so the
    refusals matter more than the successes, and there are more of them here for that reason.
    """

    def setUp(self):
        self.registry = CameraRegistry(tempfile.mkdtemp())
        self.registry.add(_entry())

    @staticmethod
    def _checks(evidence="hardware", status="pass"):
        return [
            {"name": n, "status": status, "mandatory": True, "evidenceClass": evidence}
            for n in ("connect", "stream-acquisition", "credential-redaction",
                      "frame-accounting", "reconnect-recovery", "clean-shutdown")
        ]

    def _bundle(self, *, status="certified", checks=None, target="acme-x1"):
        return {
            "summary": {**_summary(status=status), "target": {"id": target}},
            "compatibility": {"checks": self._checks() if checks is None else checks},
        }

    # --- the one that must work ---------------------------------------------

    def test_a_hardware_bundle_promotes_the_entry(self):
        entry = self.registry.promote_from_bundle(self._bundle())
        self.assertEqual(entry.status, "certified")
        self.assertEqual(entry.evidence_class, "hardware")
        self.assertTrue(entry.evidence, "a certified row must point at its evidence")

    # --- the ones that must not ---------------------------------------------

    def test_a_simulated_bundle_cannot_promote_anything(self):
        """CONSTRAINTS §18 in code rather than in prose."""
        bundle = self._bundle(checks=self._checks(evidence="simulated"))
        with self.assertRaises(RegistryError) as caught:
            self.registry.promote_from_bundle(bundle)
        self.assertIn("pending-validation", str(caught.exception))
        self.assertEqual(self.registry.get("acme-x1").status, "pending-validation")

    def test_a_status_typed_into_a_json_file_is_refused(self):
        """⭐ The forgery this is really for. Every field says `certified`; the checks underneath it
        are simulated, so the verdict is recomputed as `pending-validation` and both values are
        named in the refusal."""
        bundle = self._bundle(checks=self._checks(evidence="simulated"))
        bundle["summary"]["status"] = "certified"
        bundle["summary"]["evidenceClass"] = "hardware"
        with self.assertRaises(RegistryError) as caught:
            self.registry.promote_from_bundle(bundle)
        self.assertIn("claims status 'certified'", str(caught.exception))

    def test_a_bundle_with_no_checks_cannot_promote(self):
        with self.assertRaises(RegistryError) as caught:
            self.registry.promote_from_bundle(self._bundle(checks=[]))
        self.assertIn("no checks", str(caught.exception))

    def test_a_bundle_missing_its_required_checks_cannot_promote(self):
        """`reconnect-recovery` and `clean-shutdown` are the two no software can produce."""
        partial = [c for c in self._checks() if c["name"] not in ("reconnect-recovery", "clean-shutdown")]
        partial += [
            {"name": n, "status": "not-executed", "mandatory": True, "evidenceClass": "simulated"}
            for n in ("reconnect-recovery", "clean-shutdown")
        ]
        with self.assertRaises(RegistryError):
            self.registry.promote_from_bundle(self._bundle(checks=partial))
        self.assertEqual(self.registry.get("acme-x1").status, "pending-validation")

    def test_a_bundle_for_another_camera_cannot_promote_this_one(self):
        with self.assertRaises(RegistryError) as caught:
            self.registry.promote_from_bundle(self._bundle(target="some-other-camera"))
        self.assertIn("not a registry entry", str(caught.exception))

    def test_a_bundle_without_a_summary_or_compatibility_is_refused(self):
        for bundle in ({}, {"summary": {}}, {"compatibility": {"checks": self._checks()}}):
            with self.assertRaises(RegistryError):
                self.registry.promote_from_bundle(bundle)

    # --- ⛔ and the refusal must not leave damage behind ---------------------

    def test_a_refused_promotion_leaves_the_entry_and_the_file_untouched(self):
        """⛔ P-9 A6, measured. `certify()` mutated the entry, THEN re-ran the invariants — so a
        summary claiming `certified` on `simulated` evidence raised correctly and left the entry
        holding exactly that. `save()` wrote `"status": "certified"` with
        `"evidenceClass": "simulated"` to disk, and the next `load()` refused the whole registry. A
        caught-and-ignored refusal became a corrupted profile that bricked the registry on the
        following start.

        ⚠️ A guard that reports the right answer and causes the damage it exists to prevent is worse
        than no guard, because the report is what stops anyone looking further.
        """
        with self.assertRaises(RegistryError):
            self.registry.certify("acme-x1", _summary(evidence_class="simulated"))

        entry = self.registry.get("acme-x1")
        self.assertEqual(entry.status, "pending-validation")
        self.assertEqual(entry.evidence_class, "simulated")
        self.assertEqual(entry.evidence, [])

        # And what reaches disk must be loadable — the real consequence of the original defect.
        self.registry.save()
        again = CameraRegistry(self.registry.directory).load()
        self.assertEqual(again.get("acme-x1").status, "pending-validation")


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

    def test_the_committed_certification_baseline_claims_nothing(self):
        """P-9 A4. The baseline is the diff target every hardware run is compared against, so a
        hardware verdict that leaked into it would make the comparison meaningless in the one
        direction that matters.

        ⚠️ Asserted HERE, in the unit suite, and not only in `docs/review/p9/certification.mjs` —
        that verification needs Docker, a built image and a running fixture, and a guard that only
        runs when someone remembers to run it is not a guard.
        """
        path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
            "docs", "review", "p9", "baseline", "generic-rtsp-simulated.json",
        )
        self.assertTrue(os.path.isfile(path), f"missing certification baseline: {path}")
        with open(path, encoding="utf-8") as fh:
            baseline = json.load(fh)
        self.assertEqual(baseline["status"], "pending-validation")
        self.assertEqual(baseline["evidenceClass"], "simulated")
        self.assertTrue(baseline["blockers"], "a baseline that certifies nothing must say why")
        # The two checks no software can produce must still be listed as un-executed, or the
        # baseline has quietly stopped being a record of what is outstanding.
        outstanding = {c["name"] for c in baseline["checks"] if c["status"] == "not-executed"}
        self.assertIn("reconnect-recovery", outstanding)
        self.assertIn("clean-shutdown", outstanding)

    def test_the_matrix_spells_the_status_out_in_words(self):
        # A tick or a dash invites an optimistic reading; words do not.
        text = render_matrix(self.registry.matrix())
        self.assertIn("Pending Validation", text)
        self.assertNotIn("✓", text)


if __name__ == "__main__":
    unittest.main()

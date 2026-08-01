"""Operational journal + timeline (AI-5d rec 5).

Two properties matter: everything operational lands in ONE place correlated by identity, and it stays
bounded. A diagnostic buffer that grows forever is an outage waiting for a long-lived deployment.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from journal import DiagnosticsJournal, classify  # noqa: E402
from operational_log import OperationalLog, SessionIdentity  # noqa: E402


def _identity(tenant: str = "tnt_a", session: str = "ses_1") -> SessionIdentity:
    return SessionIdentity(tenant, "cam_1", session, correlation_id="corr_1")


def _log(journal: DiagnosticsJournal, identity: SessionIdentity, stamps=None) -> OperationalLog:
    stamps = stamps or iter([f"2026-08-01T10:{n:02d}:00.000Z" for n in range(60)])
    return OperationalLog(identity, sink=journal.sink_for(identity), now_iso=lambda: next(stamps))


class ClassificationTest(unittest.TestCase):
    def test_events_map_to_their_operational_concern(self):
        cases = {
            "stream.connected": "connection",
            "stream.reconnecting": "connection",
            "scheduler.degraded": "degradation",
            "scheduler.suspended": "degradation",
            "scheduler.admitted": "scheduling",
            "scheduler.refused": "scheduling",
            "recovery.succeeded": "recovery",
            "model.transition_completed": "model",
            "session.started": "lifecycle",
            "session.degradation_applied": "degradation",
        }
        for event, kind in cases.items():
            self.assertEqual(classify(event), kind, f"for {event}")

    def test_an_unknown_event_is_kept_not_dropped(self):
        self.assertEqual(classify("something.new"), "lifecycle")


class JournalTest(unittest.TestCase):
    def test_the_journal_is_a_sink_on_the_log_a_session_already_writes(self):
        # Rec 5's whole point: no second emitter. Logging normally is what fills the journal.
        journal = DiagnosticsJournal()
        log = _log(journal, _identity())
        log.emit("session.started")
        log.connection("stream.connected")
        self.assertEqual(journal.count(_identity()), 2)

    def test_tee_journals_without_costing_the_caller_their_logs(self):
        journal = DiagnosticsJournal()
        captured = []
        identity = _identity()
        log = OperationalLog(identity, sink=journal.tee(identity, captured.append))
        log.emit("session.started")
        self.assertEqual(len(captured), 1)
        self.assertEqual(journal.count(identity), 1)

    def test_entries_are_newest_first(self):
        journal = DiagnosticsJournal()
        log = _log(journal, _identity())
        for event in ("session.started", "stream.connected", "scheduler.degraded"):
            log.emit(event)
        events = [e["event"] for e in journal.journal(_identity())]
        self.assertEqual(events, ["scheduler.degraded", "stream.connected", "session.started"])

    def test_entries_can_be_filtered_by_kind(self):
        journal = DiagnosticsJournal()
        log = _log(journal, _identity())
        log.emit("session.started")
        log.emit("stream.connected")
        log.emit("stream.lost")
        self.assertEqual(len(journal.journal(_identity(), kind="connection")), 2)
        self.assertEqual(len(journal.journal(_identity(), kind="lifecycle")), 1)

    def test_the_journal_is_bounded(self):
        journal = DiagnosticsJournal(maxlen=50)
        log = _log(journal, _identity(), stamps=iter(["2026-08-01T10:00:00.000Z"] * 500))
        for _ in range(500):
            log.emit("session.started")
        self.assertEqual(journal.count(_identity()), 50)

    def test_scheduler_decisions_and_recoveries_land_in_the_same_stream(self):
        journal = DiagnosticsJournal()
        identity = _identity()
        _log(journal, identity).emit("stream.connected")
        journal.record_decision(
            {
                "identity": identity.to_dict(),
                "action": "degraded",
                "reason": "queue-pressure",
                "detail": "none → reduced-fps",
                "measurement": {"queueUtilization": 91.0},
                "at": "2026-08-01T10:11:00.000Z",
            }
        )
        journal.record_recovery(
            {
                "identity": identity.to_dict(),
                "outcome": "succeeded",
                "attempt": 1,
                "detail": "restart-session completed",
                "at": "2026-08-01T10:12:00.000Z",
            }
        )
        kinds = {e["kind"] for e in journal.journal(identity)}
        self.assertEqual(kinds, {"connection", "degradation", "recovery"})

    def test_a_model_transition_shows_on_the_session_that_lived_through_it(self):
        journal = DiagnosticsJournal()
        identity = _identity()
        journal.record_transition(
            {
                "state": "active",
                "fromVersion": "1.2.0",
                "toVersion": "1.3.0",
                "sessionsAffected": 4,
                "updatedAt": "2026-08-01T10:24:00.000Z",
            },
            identity,
        )
        entry = journal.journal(identity)[0]
        self.assertEqual(entry["kind"], "model")
        self.assertEqual(entry["event"], "model.transition_completed")
        self.assertIn("1.2.0 → 1.3.0", entry["detail"])

    def test_forget_releases_a_session(self):
        journal = DiagnosticsJournal()
        _log(journal, _identity()).emit("session.started")
        journal.forget(_identity())
        self.assertEqual(journal.count(_identity()), 0)
        self.assertEqual(journal.sessions, 0)


class TimelineTest(unittest.TestCase):
    """Rec 5: an ordered, human-readable view — read forwards, unlike a log."""

    def test_the_timeline_reads_oldest_first(self):
        journal = DiagnosticsJournal()
        log = _log(journal, _identity())
        log.emit("stream.connected")
        log.emit("scheduler.degraded")
        log.emit("model.transition_completed")
        labels = [e["label"] for e in journal.timeline(_identity())]
        self.assertEqual(labels[0], "Connected")
        self.assertEqual(labels[-1].split(" (")[0], "Switch complete")

    def test_it_renders_the_architects_example_shape(self):
        journal = DiagnosticsJournal()
        stamps = iter(
            [
                "2026-08-01T10:02:14.000Z",
                "2026-08-01T10:11:02.000Z",
                "2026-08-01T10:23:11.000Z",
                "2026-08-01T10:24:00.000Z",
            ]
        )
        log = _log(journal, _identity(), stamps=stamps)
        log.emit("stream.connected")
        log.emit("scheduler.degraded", reason="queue-pressure")
        log.emit("model.transition_started", toVersion="1.3.0")
        log.emit("model.transition_completed", sessionsAffected=4)
        rendered = journal.render(_identity()).splitlines()
        self.assertTrue(rendered[0].startswith("10:02:14  Connected"))
        self.assertTrue(rendered[1].startswith("10:11:02  Governor degraded the session"))
        self.assertTrue(rendered[3].startswith("10:24:00  Switch complete"))

    def test_a_line_carries_at_most_one_headline_number(self):
        journal = DiagnosticsJournal()
        log = _log(journal, _identity())
        log.emit("scheduler.degraded", queueUtilization=91.2, effectiveFps=2.5, restoreDepth=1)
        label = journal.timeline(_identity())[0]["label"]
        self.assertEqual(label.count("("), 1)

    def test_an_unmapped_event_stays_visible(self):
        journal = DiagnosticsJournal()
        _log(journal, _identity()).emit("session.something_new")
        self.assertEqual(journal.timeline(_identity())[0]["label"], "session.something_new")

    def test_timeline_entries_carry_their_level(self):
        journal = DiagnosticsJournal()
        log = _log(journal, _identity())
        log.emit("stream.lost", level="warn")
        self.assertEqual(journal.timeline(_identity())[0]["level"], "warn")

    def test_a_malformed_timestamp_never_breaks_rendering(self):
        journal = DiagnosticsJournal()
        journal.record_log({"event": "session.started", "at": "", "level": "info"}, _identity())
        self.assertEqual(journal.timeline(_identity())[0]["time"], "--:--:--")


class TenantIsolationTest(unittest.TestCase):
    def test_one_tenant_never_reads_anothers_journal(self):
        # Same camera AND session id across two tenants — the collision a session-only key leaks.
        journal = DiagnosticsJournal()
        a, b = _identity("tnt_a"), _identity("tnt_b")
        _log(journal, a).emit("session.started")
        self.assertEqual(journal.count(a), 1)
        self.assertEqual(journal.count(b), 0)
        self.assertEqual(journal.journal(b), [])
        self.assertEqual(journal.timeline(b), [])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

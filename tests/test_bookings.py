"""Tests for the iCal parser + booking sync against the sample VRBO fixture."""
import os
import sys
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

_TMP_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP_DB.close()
os.environ["DB_PATH"] = _TMP_DB.name

from server import app as app_module  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "sample_bookings.ics"


class ParseIcal(unittest.TestCase):
    def setUp(self):
        self.text = FIXTURE.read_text(encoding="utf-8")
        self.events = app_module.parse_ical(self.text)

    def test_parses_all_three_events(self):
        self.assertEqual(len(self.events), 3)

    def test_uid_extracted(self):
        uids = {e["uid"] for e in self.events}
        self.assertIn("HMWERS-20260614-001@vrbo.com", uids)
        self.assertIn("HMWERS-20260801-002@vrbo.com", uids)
        self.assertIn("HMWERS-20260901-003@vrbo.com", uids)

    def test_summary_extracted(self):
        e1 = next(e for e in self.events if e["uid"].startswith("HMWERS-20260614"))
        self.assertEqual(e1["summary"], "Reserved - Smith family")

    def test_date_only_event_converted_to_nz_midnight_utc(self):
        # DTSTART;VALUE=DATE:20260614 = midnight 14 Jun NZ = 13 Jun 12:00 UTC (winter, UTC+12).
        e1 = next(e for e in self.events if e["uid"].startswith("HMWERS-20260614"))
        start = datetime.fromisoformat(e1["start_ts"])
        self.assertEqual(start.tzinfo.utcoffset(start), timedelta(0))
        self.assertEqual(start.month, 6)
        self.assertEqual(start.day, 13)  # NZ midnight 14 June = UTC noon 13 June
        self.assertEqual(start.hour, 12)

    def test_utc_datetime_event_preserved(self):
        e3 = next(e for e in self.events if e["uid"].startswith("HMWERS-20260901"))
        start = datetime.fromisoformat(e3["start_ts"])
        self.assertEqual(start.year, 2026)
        self.assertEqual(start.month, 9)
        self.assertEqual(start.day, 1)
        self.assertEqual(start.hour, 2)

    def test_vevent_missing_required_fields_is_skipped(self):
        bad = (
            "BEGIN:VCALENDAR\n"
            "BEGIN:VEVENT\n"
            "SUMMARY:no UID or dates\n"
            "END:VEVENT\n"
            "END:VCALENDAR\n"
        )
        self.assertEqual(app_module.parse_ical(bad), [])

    def test_handles_crlf_line_endings(self):
        crlf = self.text.replace("\n", "\r\n")
        events = app_module.parse_ical(crlf)
        self.assertEqual(len(events), 3)

    def test_folded_lines_are_unfolded(self):
        # RFC 5545 §3.1: a fold is CRLF + ONE leading whitespace; that whitespace
        # is the fold marker and gets stripped, NOT preserved as content. So to
        # represent "long name" across a fold, either trail the first line with
        # a space (the space is content), or lead the continuation with TWO
        # spaces (one is fold marker, one is content). Using the latter form here.
        text = (
            "BEGIN:VCALENDAR\n"
            "BEGIN:VEVENT\n"
            "UID:folded@vrbo.com\n"
            "SUMMARY:Reserved - very long\n"
            "  name that spans lines\n"
            "DTSTART;VALUE=DATE:20260614\n"
            "DTEND;VALUE=DATE:20260615\n"
            "END:VEVENT\n"
            "END:VCALENDAR\n"
        )
        events = app_module.parse_ical(text)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["summary"], "Reserved - very long name that spans lines")


class SyncBookingsEndToEnd(unittest.TestCase):
    """Drive sync_bookings_from_ical against a file:// URL pointing at the
    fixture, then re-query as the API endpoints would."""

    def setUp(self):
        self._db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self._db.close()
        os.environ["DB_PATH"] = self._db.name
        app_module.DB_PATH = self._db.name
        app_module.init_db()

    def tearDown(self):
        try:
            os.unlink(self._db.name)
        except OSError:
            pass

    def test_sync_inserts_all_events(self):
        url = FIXTURE.absolute().as_uri()
        count = app_module.sync_bookings_from_ical(url)
        self.assertEqual(count, 3)
        conn = app_module.get_db()
        rows = list(conn.execute("SELECT * FROM bookings ORDER BY start_ts"))
        conn.close()
        self.assertEqual(len(rows), 3)

    def test_sync_is_idempotent(self):
        url = FIXTURE.absolute().as_uri()
        app_module.sync_bookings_from_ical(url)
        app_module.sync_bookings_from_ical(url)
        conn = app_module.get_db()
        n = conn.execute("SELECT COUNT(*) FROM bookings").fetchone()[0]
        conn.close()
        self.assertEqual(n, 3)

    def test_sync_with_empty_url_is_noop(self):
        self.assertEqual(app_module.sync_bookings_from_ical(""), 0)

    def test_sync_with_invalid_url_returns_zero(self):
        # Non-existent file → urlopen raises → caught → 0 returned, no DB write.
        self.assertEqual(
            app_module.sync_bookings_from_ical("file:///definitely/does/not/exist.ics"), 0
        )
        conn = app_module.get_db()
        n = conn.execute("SELECT COUNT(*) FROM bookings").fetchone()[0]
        conn.close()
        self.assertEqual(n, 0)

    def test_cancelled_future_booking_is_pruned_on_next_sync(self):
        url = FIXTURE.absolute().as_uri()
        app_module.sync_bookings_from_ical(url)
        future = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
        future_end = (datetime.now(timezone.utc) + timedelta(days=35)).isoformat()
        conn = app_module.get_db()
        conn.execute(
            "INSERT INTO bookings (source_uid, summary, start_ts, end_ts, last_synced) "
            "VALUES ('phantom', 'cancelled', ?, ?, ?)",
            (future, future_end, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        conn.close()
        app_module.sync_bookings_from_ical(url)
        conn = app_module.get_db()
        rows = list(conn.execute("SELECT source_uid FROM bookings"))
        conn.close()
        uids = {r["source_uid"] for r in rows}
        self.assertNotIn("phantom", uids)
        self.assertEqual(len(uids), 3)


if __name__ == "__main__":
    unittest.main()

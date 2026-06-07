"""Unit tests for the pure functions in server/app.py.

Run from the repo root with:

    python -m unittest discover tests

These cover the math (level percent, feed-in rate), the human-facing formatters
(duration, NZ local time), and the occupancy state machine end-to-end against a
temp SQLite DB. No network, no SMTP, no live LXC.
"""
import os
import sys
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

# Let `import server.app` work no matter where the runner is invoked from.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

# Point the app at a throwaway DB so importing it doesn't touch the real one.
_TMP_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP_DB.close()
os.environ["DB_PATH"] = _TMP_DB.name

from server import app as app_module  # noqa: E402


def _utc(*args, **kwargs):
    return datetime(*args, **kwargs, tzinfo=timezone.utc)


class CalculateLevelPercent(unittest.TestCase):
    def test_distance_below_full_threshold_clamps_to_100(self):
        # SENSOR_TO_WATER_FULL_CM = 17. Anything under that = sensor reads "above full".
        self.assertEqual(app_module.calculate_level_percent(0.0), 100.0)
        self.assertEqual(app_module.calculate_level_percent(10.0), 100.0)
        self.assertEqual(app_module.calculate_level_percent(16.9), 100.0)

    def test_distance_at_full_threshold_is_100(self):
        self.assertEqual(app_module.calculate_level_percent(17.0), 100.0)

    def test_distance_at_bottom_threshold_is_0(self):
        # SENSOR_TO_BOTTOM_CM = 17 + 250 = 267.
        self.assertEqual(app_module.calculate_level_percent(267.0), 0.0)

    def test_distance_beyond_bottom_clamps_to_0(self):
        self.assertEqual(app_module.calculate_level_percent(500.0), 0.0)
        self.assertEqual(app_module.calculate_level_percent(819.0), 0.0)

    def test_midpoint_is_50_percent(self):
        # Halfway between 17cm (full) and 267cm (empty) = 142cm = 50%
        self.assertAlmostEqual(app_module.calculate_level_percent(142.0), 50.0)

    def test_quarter_full(self):
        # 75% empty (25% full): water_height = 250 * 0.25 = 62.5; distance = 267 - 62.5 = 204.5
        self.assertAlmostEqual(app_module.calculate_level_percent(204.5), 25.0)


class FeedinAvgRate(unittest.TestCase):
    def test_too_few_readings_returns_none(self):
        self.assertIsNone(app_module._feedin_avg_rate_from_readings([]))
        self.assertIsNone(
            app_module._feedin_avg_rate_from_readings([(_utc(2026, 6, 1, 2, 0), 50.0)])
        )

    def test_simple_two_reading_rise(self):
        # Tank goes 50% -> 70% in 1 hour = 20% of 30,000 L = 6,000 L/h
        readings = [
            (_utc(2026, 6, 1, 2, 0), 50.0),
            (_utc(2026, 6, 1, 3, 0), 70.0),
        ]
        result = app_module._feedin_avg_rate_from_readings(readings)
        self.assertIsNotNone(result)
        rate, first, last, reached_full = result
        self.assertAlmostEqual(rate, 6000.0, places=1)
        self.assertEqual(first, 50.0)
        self.assertEqual(last, 70.0)
        self.assertFalse(reached_full)

    def test_negative_rate_clamps_to_zero(self):
        # Level dropped — represents leak or usage, but feed-in algorithm clamps to 0.
        readings = [
            (_utc(2026, 6, 1, 2, 0), 80.0),
            (_utc(2026, 6, 1, 3, 0), 70.0),
        ]
        result = app_module._feedin_avg_rate_from_readings(readings)
        self.assertIsNotNone(result)
        rate, _, _, _ = result
        self.assertEqual(rate, 0.0)

    def test_truncates_when_tank_fills_to_100(self):
        # Tank fills to 100% mid-window; the algorithm should ignore subsequent
        # readings (they're not feed-in, the tank is just full and overflowing).
        readings = [
            (_utc(2026, 6, 1, 2, 0), 80.0),
            (_utc(2026, 6, 1, 3, 0), 100.0),  # full
            (_utc(2026, 6, 1, 4, 0), 100.0),  # still full
            (_utc(2026, 6, 1, 5, 0), 100.0),  # still full
        ]
        result = app_module._feedin_avg_rate_from_readings(readings)
        self.assertIsNotNone(result)
        rate, first, last, reached_full = result
        self.assertTrue(reached_full)
        self.assertEqual(first, 80.0)
        self.assertEqual(last, 100.0)
        # Only one pair contributes: 80 -> 100 in 1h = 6000 L/h.
        self.assertAlmostEqual(rate, 6000.0, places=1)

    def test_window_shorter_than_minimum_returns_none(self):
        # MIN_FEEDIN_WINDOW_HOURS = 0.25 (15 min). Two readings 5 min apart.
        readings = [
            (_utc(2026, 6, 1, 2, 0), 50.0),
            (_utc(2026, 6, 1, 2, 5), 50.1),
        ]
        self.assertIsNone(app_module._feedin_avg_rate_from_readings(readings))


class FormatDurationHuman(unittest.TestCase):
    def test_under_a_minute(self):
        self.assertEqual(app_module.format_duration_human(timedelta(seconds=30)), "less than a minute")
        self.assertEqual(app_module.format_duration_human(timedelta(seconds=0)), "less than a minute")

    def test_minutes(self):
        self.assertEqual(app_module.format_duration_human(timedelta(minutes=1)), "1 minute")
        self.assertEqual(app_module.format_duration_human(timedelta(minutes=2)), "2 minutes")
        self.assertEqual(app_module.format_duration_human(timedelta(minutes=59)), "59 minutes")

    def test_hours(self):
        self.assertEqual(app_module.format_duration_human(timedelta(hours=1)), "1 hour")
        self.assertEqual(app_module.format_duration_human(timedelta(hours=10)), "10 hours")
        self.assertEqual(app_module.format_duration_human(timedelta(hours=23, minutes=59)), "23 hours")

    def test_days(self):
        self.assertEqual(app_module.format_duration_human(timedelta(days=1)), "1 day")
        self.assertEqual(app_module.format_duration_human(timedelta(days=10)), "10 days")
        self.assertEqual(app_module.format_duration_human(timedelta(hours=49)), "2 days")


class FormatLocalTime(unittest.TestCase):
    def test_renders_in_nz(self):
        # 2026-06-07T00:00:00 UTC = 2026-06-07 12:00 PM NZ (winter, UTC+12, no DST).
        ts = _utc(2026, 6, 7, 0, 0, 0)
        formatted = app_module.format_local_time(ts)
        self.assertIn("Sunday", formatted)
        self.assertIn("07 June 2026", formatted)
        self.assertIn("12:00 PM NZT", formatted)


class OccupancyStateMachine(unittest.TestCase):
    """Drives the occupancy state machine against an in-memory DB. Verifies the
    three transitions plus the transitions log."""

    def setUp(self):
        # Fresh temp DB per test so they don't bleed into each other.
        self._db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self._db.close()
        os.environ["DB_PATH"] = self._db.name
        # Re-bind the module-level DB_PATH so get_db() picks it up.
        app_module.DB_PATH = self._db.name
        app_module.init_db()

    def tearDown(self):
        try:
            os.unlink(self._db.name)
        except OSError:
            pass

    def _conn(self):
        return app_module.get_db()

    def _ts(self, hours_ago: float = 0.0) -> datetime:
        return datetime(2026, 6, 7, 12, 0, 0, tzinfo=timezone.utc) - timedelta(hours=hours_ago)

    def test_first_reading_transitions_unknown_to_occupied_silently(self):
        conn = self._conn()
        ts = self._ts()
        app_module.handle_reading_arrival(conn, "tank-1", ts)
        state, last = app_module.get_occupancy_state(conn, "tank-1")
        self.assertEqual(state, "occupied")
        self.assertIsNotNone(last)
        # Transition logged.
        rows = list(conn.execute("SELECT from_state, to_state FROM occupancy_transitions"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["from_state"], "unknown")
        self.assertEqual(rows[0]["to_state"], "occupied")
        conn.close()

    def test_subsequent_readings_do_not_retransition(self):
        conn = self._conn()
        ts1 = self._ts(2.0)
        ts2 = self._ts(1.0)
        app_module.handle_reading_arrival(conn, "tank-1", ts1)
        app_module.handle_reading_arrival(conn, "tank-1", ts2)
        rows = list(conn.execute("SELECT COUNT(*) AS n FROM occupancy_transitions"))
        self.assertEqual(rows[0]["n"], 1)
        conn.close()

    def test_unoccupied_to_occupied_logs_transition(self):
        conn = self._conn()
        # Manually plant 'unoccupied' state.
        app_module.set_occupancy_state(conn, "tank-1", "unoccupied", self._ts(48.0))
        # New reading lands -> should transition to occupied AND log it.
        app_module.handle_reading_arrival(conn, "tank-1", self._ts())
        state, _ = app_module.get_occupancy_state(conn, "tank-1")
        self.assertEqual(state, "occupied")
        rows = list(conn.execute(
            "SELECT from_state, to_state FROM occupancy_transitions ORDER BY id"
        ))
        # Only one logged transition (the unoccupied -> occupied one); the manual
        # set_occupancy_state above doesn't log on its own (only transition path does).
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["from_state"], "unoccupied")
        self.assertEqual(rows[0]["to_state"], "occupied")
        conn.close()


if __name__ == "__main__":
    unittest.main()

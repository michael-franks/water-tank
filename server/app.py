import os
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

try:
    from zoneinfo import ZoneInfo
    NZ_TZ = ZoneInfo("Pacific/Auckland")
except ImportError:
    NZ_TZ = timezone(timedelta(hours=12))  # fallback, no DST

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    from twilio.rest import Client as TwilioClient
except Exception:  # pragma: no cover - optional dependency at runtime
    TwilioClient = None


BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR.parent / "web"
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

load_dotenv(BASE_DIR / ".env")

DB_PATH = os.getenv("DB_PATH", str(DATA_DIR / "readings.db"))
DEFAULT_DEVICE_ID = os.getenv("DEFAULT_DEVICE_ID", "tank-1")
ALERT_HYSTERESIS_PCT = float(os.getenv("ALERT_HYSTERESIS_PCT", "2.0"))
INGEST_API_KEY = os.getenv("INGEST_API_KEY", "").strip()
STALE_READING_HOURS = float(os.getenv("STALE_READING_HOURS", "6.0"))
STALE_CHECK_INTERVAL_MINUTES = int(os.getenv("STALE_CHECK_INTERVAL_MINUTES", "30"))

# iCal feed for VRBO/Bookabach bookings. Supports http(s):// and file:// URLs.
# Leave empty to disable booking sync; the bookings table stays empty and the
# dashboard treats the bach as 'no bookings known'.
BOOKINGS_ICAL_URL = os.getenv("BOOKINGS_ICAL_URL", "").strip()
BOOKINGS_SYNC_INTERVAL_MINUTES = int(os.getenv("BOOKINGS_SYNC_INTERVAL_MINUTES", "60"))

# Firmware OTA: where signed .bin images live on the server. Default is a dir at
# the repo root (sibling to server/ and web/), so the deploy hook — which only
# promotes server/ and web/ — never touches it and it survives deploys. Lives on
# the LXC only; gitignored.
FIRMWARE_DIR = Path(os.getenv("FIRMWARE_DIR", str(BASE_DIR.parent / "firmware-images")))
FIRMWARE_DIR.mkdir(parents=True, exist_ok=True)

# Tank calibration: 170mm from sensor to water when full, 2500mm tank depth
SENSOR_TO_WATER_FULL_CM = 17.0
TANK_DEPTH_CM = 250.0
SENSOR_TO_BOTTOM_CM = SENSOR_TO_WATER_FULL_CM + TANK_DEPTH_CM
TANK_CAPACITY_LITERS = float(os.getenv("TANK_CAPACITY_LITERS", "30000"))

# Feed-in flow rate: ignore windows shorter than this (noisy rate from 2 nearby readings)
MIN_FEEDIN_WINDOW_HOURS = 0.25
# Distance reading below this is treated as condensation/sensor error (cm)
CONDENSATION_ERROR_CM = 13.0


def _feedin_avg_rate_from_readings(readings: list) -> Optional[tuple]:
    """From 2am-7am readings (ts, level_percent), compute flow rate (L/h) for each consecutive
    pair, then return the average of those rates. If level reaches 100%, only use readings
    up to that point. Returns (avg_rate_lph, first_level, last_level, reached_100) or None.
    """
    if len(readings) < 2:
        return None
    readings = sorted(readings, key=lambda x: x[0])
    # If tank hits 100% during the window, ignore readings after that point
    reached_100 = False
    for i, (_, level) in enumerate(readings):
        if level >= 99.5:
            readings = readings[: i + 1]
            reached_100 = True
            break
    if len(readings) < 2:
        if reached_100:
            return (0.0, readings[0][1], readings[-1][1], True)
        return None
    rates = []
    for i in range(len(readings) - 1):
        ts_a, level_a = readings[i]
        ts_b, level_b = readings[i + 1]
        dt_hours = (ts_b - ts_a).total_seconds() / 3600.0
        if dt_hours <= 0:
            continue
        volume_change_l = ((level_b - level_a) / 100.0) * TANK_CAPACITY_LITERS
        rate_lph = volume_change_l / dt_hours
        rates.append(rate_lph)
    first_level = readings[0][1]
    last_level = readings[-1][1]
    if not rates:
        return (0.0, first_level, last_level, reached_100) if reached_100 else None
    total_span_hours = (readings[-1][0] - readings[0][0]).total_seconds() / 3600.0
    if total_span_hours < MIN_FEEDIN_WINDOW_HOURS and not reached_100:
        return None
    if total_span_hours < MIN_FEEDIN_WINDOW_HOURS and reached_100:
        return (0.0, first_level, last_level, True)
    avg_rate = sum(rates) / len(rates)
    if avg_rate < 0:
        avg_rate = 0.0
    return (avg_rate, first_level, last_level, reached_100)

ALERT_SMS_TO = os.getenv("ALERT_SMS_TO", "").strip()
# Comma-separated list of email addresses to receive alerts
ALERT_EMAIL_TO = [e.strip() for e in os.getenv("ALERT_EMAIL_TO", "").split(",") if e.strip()]

TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "").strip()
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
TWILIO_FROM_NUMBER = os.getenv("TWILIO_FROM_NUMBER", "").strip()

SMTP_HOST = os.getenv("SMTP_HOST", "").strip()
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "").strip()
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "").strip()
SMTP_FROM = os.getenv("SMTP_FROM", "").strip()


class ReadingIn(BaseModel):
    device_id: str = Field(default=DEFAULT_DEVICE_ID, min_length=1)
    api_key: Optional[str] = Field(default=None, description="Shared secret for device auth.")
    ts: Optional[str] = Field(
        default=None,
        description="ISO-8601 timestamp; if absent, server time is used.",
    )
    distance_cm: float = Field(..., gt=0)
    level_percent: Optional[float] = Field(default=None, ge=0, le=100)
    signal_rssi: Optional[int] = None
    signal_rsrp: Optional[int] = None
    temp_c: Optional[float] = None
    fw_version: Optional[str] = Field(default=None, description="Firmware version from device.")


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            ts TEXT NOT NULL,
            distance_cm REAL NOT NULL,
            level_percent REAL,
            signal_rssi INTEGER,
            signal_rsrp INTEGER,
            temp_c REAL,
            fw_version TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS alert_state (
            device_id TEXT NOT NULL,
            alert_type TEXT NOT NULL,
            armed INTEGER NOT NULL DEFAULT 1,
            last_triggered_ts TEXT,
            PRIMARY KEY (device_id, alert_type)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS occupancy_state (
            device_id TEXT PRIMARY KEY,
            state TEXT NOT NULL,
            last_change_ts TEXT NOT NULL
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS occupancy_transitions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            from_state TEXT NOT NULL,
            to_state TEXT NOT NULL,
            ts TEXT NOT NULL
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_uid TEXT NOT NULL UNIQUE,
            summary TEXT,
            start_ts TEXT NOT NULL,
            end_ts TEXT NOT NULL,
            last_synced TEXT NOT NULL
        )
        """
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_bookings_range ON bookings(start_ts, end_ts)"
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS firmware_releases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            version TEXT NOT NULL UNIQUE,
            filename TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            min_version TEXT,
            target_device TEXT,
            notes TEXT,
            published INTEGER NOT NULL DEFAULT 1,
            uploaded_at TEXT NOT NULL
        )
        """
    )
    # Hot-path index for the dominant query shape:
    # SELECT ... FROM readings WHERE device_id = ? AND ts ... ORDER BY ts DESC
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_readings_device_ts ON readings(device_id, ts DESC)"
    )
    # Seed default notification preferences (INSERT OR IGNORE preserves any
    # existing values across restarts).
    now_iso = datetime.now(timezone.utc).isoformat()
    for key, default in (("notify_water_alerts", "false"), ("notify_occupancy", "true")):
        cur.execute(
            "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
            (key, default, now_iso),
        )
    # Drop alert_state rows for alert types that no longer exist in the code
    # (cleanup after the notification refactor).
    cur.execute(
        "DELETE FROM alert_state WHERE alert_type IN ('stale_reading', 'rapid_change_5pct_24h')"
    )
    conn.commit()
    # Add fw_version column if missing (existing DBs)
    try:
        cur.execute("ALTER TABLE readings ADD COLUMN fw_version TEXT")
        conn.commit()
    except sqlite3.OperationalError:
        pass  # Column already exists
    conn.close()


def calculate_level_percent(distance_cm: float) -> float:
    """Calculate water level percentage from sensor distance.
    
    Args:
        distance_cm: Distance from sensor to water surface in cm
        
    Returns:
        Level percentage (0-100), clamped to valid range
    """
    if distance_cm < SENSOR_TO_WATER_FULL_CM:
        return 100.0
    if distance_cm > SENSOR_TO_BOTTOM_CM:
        return 0.0
    water_height = SENSOR_TO_BOTTOM_CM - distance_cm
    percent = (water_height / TANK_DEPTH_CM) * 100.0
    return max(0.0, min(100.0, percent))


def parse_ts(ts: Optional[str]) -> datetime:
    if ts is None:
        return datetime.now(timezone.utc)
    try:
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid timestamp format") from exc
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def send_sms(message: str) -> None:
    if not (ALERT_SMS_TO and TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER):
        return
    if TwilioClient is None:
        return
    client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    client.messages.create(to=ALERT_SMS_TO, from_=TWILIO_FROM_NUMBER, body=message)


def send_email(subject: str, body: str) -> None:
    if not (ALERT_EMAIL_TO and SMTP_HOST and SMTP_USERNAME and SMTP_PASSWORD and SMTP_FROM):
        return
    import smtplib
    from email.message import EmailMessage

    msg = EmailMessage()
    msg["From"] = SMTP_FROM
    msg["To"] = ", ".join(ALERT_EMAIL_TO)
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.starttls()
        server.login(SMTP_USERNAME, SMTP_PASSWORD)
        server.send_message(msg, to_addrs=ALERT_EMAIL_TO)


def ensure_alert_state(conn: sqlite3.Connection, device_id: str, alert_type: str) -> None:
    cur = conn.cursor()
    cur.execute(
        "INSERT OR IGNORE INTO alert_state (device_id, alert_type, armed) VALUES (?, ?, 1)",
        (device_id, alert_type),
    )
    conn.commit()


def set_alert_state(
    conn: sqlite3.Connection, device_id: str, alert_type: str, armed: int, ts: Optional[str]
) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE alert_state
        SET armed = ?, last_triggered_ts = ?
        WHERE device_id = ? AND alert_type = ?
        """,
        (armed, ts, device_id, alert_type),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Notification preferences + occupancy state machine
# ---------------------------------------------------------------------------

def get_setting(key: str, default: str = "") -> str:
    """Read a persisted setting value (returns default if missing)."""
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT value FROM settings WHERE key = ?", (key,))
    row = cur.fetchone()
    conn.close()
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    """Upsert a setting value."""
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        (key, value, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()


def _water_alerts_enabled() -> bool:
    """Threshold, rapid-change, and sensor-error alerts."""
    return get_setting("notify_water_alerts") == "true"


def _occupancy_alerts_enabled() -> bool:
    """Bach occupied / unoccupied alerts (replaces the old stale-readings email)."""
    return get_setting("notify_occupancy") == "true"


def _reject_ingest_host(request: Request) -> None:
    """Block admin endpoints when accessed via the public unauthenticated ingest hostname.

    The dashboard (bach.franks.nz) sits behind Cloudflare Access; the ingest hostname
    (ingest-bach.franks.nz) is unauthenticated so the sensor can POST. Both resolve to
    the same FastAPI app, so we keep admin endpoints (notification toggles, test email)
    off the ingest hostname.
    """
    host = (request.headers.get("host") or "").lower()
    if host.startswith("ingest-bach."):
        raise HTTPException(status_code=404, detail="Not found")


def get_occupancy_state(conn: sqlite3.Connection, device_id: str):
    """Return (state, last_change_ts) where state ∈ {'occupied','unoccupied','unknown'}."""
    cur = conn.cursor()
    cur.execute(
        "SELECT state, last_change_ts FROM occupancy_state WHERE device_id = ?",
        (device_id,),
    )
    row = cur.fetchone()
    if row is None:
        return ("unknown", None)
    last = datetime.fromisoformat(row["last_change_ts"].replace("Z", "+00:00"))
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (row["state"], last)


def set_occupancy_state(
    conn: sqlite3.Connection, device_id: str, state: str, ts: datetime
) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO occupancy_state (device_id, state, last_change_ts) VALUES (?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE
        SET state = excluded.state, last_change_ts = excluded.last_change_ts
        """,
        (device_id, state, ts.isoformat()),
    )
    conn.commit()


def format_duration_human(td: timedelta) -> str:
    """Match the JS formatTimeAgo phrasing (minus 'ago'): integer minute/hour/day units."""
    total_seconds = int(td.total_seconds())
    if total_seconds < 60:
        return "less than a minute"
    minutes = total_seconds // 60
    if minutes < 60:
        return f"{minutes} minute{'' if minutes == 1 else 's'}"
    hours = minutes // 60
    if hours < 24:
        return f"{hours} hour{'' if hours == 1 else 's'}"
    days = hours // 24
    return f"{days} day{'' if days == 1 else 's'}"


def format_local_time(ts: datetime) -> str:
    """Render a UTC datetime as a human-readable NZ local string for emails."""
    nz = ts.astimezone(NZ_TZ)
    # %I/%M/%p give zero-padded 12-hour time, fine cross-platform.
    return nz.strftime("%A %d %B %Y at %I:%M %p NZT")


def log_occupancy_transition(
    conn: sqlite3.Connection, device_id: str, from_state: str, to_state: str, ts: datetime
) -> None:
    """Append a row to occupancy_transitions so we can render a visit history later."""
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO occupancy_transitions (device_id, from_state, to_state, ts)
        VALUES (?, ?, ?, ?)
        """,
        (device_id, from_state, to_state, ts.isoformat()),
    )
    conn.commit()


def handle_reading_arrival(conn: sqlite3.Connection, device_id: str, ts: datetime) -> None:
    """A new reading just landed. Transition occupancy state if needed.

    - unknown → occupied (silent — first reading ever, no email).
    - unoccupied → occupied (sends 'Bach occupied' email if enabled).
    - occupied → occupied (no-op).
    """
    state, last_change = get_occupancy_state(conn, device_id)
    if state == "occupied":
        return
    set_occupancy_state(conn, device_id, "occupied", ts)
    log_occupancy_transition(conn, device_id, state, "occupied", ts)
    if state == "unknown":
        return  # First-ever reading; no alert.
    if _occupancy_alerts_enabled():
        duration_note = ""
        if last_change is not None:
            duration_note = f" after {format_duration_human(ts - last_change)} offline"
        send_email(
            "Bach occupied",
            f"Water tank circuit came back online on {format_local_time(ts)}"
            f"{duration_note}. Someone has likely arrived at the bach.",
        )


def check_occupancy_unoccupied() -> None:
    """Periodic check. If readings have gone stale AND we still think the bach is
    occupied, transition to 'unoccupied' and (if enabled) send an alert."""
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "SELECT ts FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT 1",
        (DEFAULT_DEVICE_ID,),
    )
    row = cur.fetchone()
    if row is None:
        conn.close()
        return  # No readings at all — nothing to compare against.
    last_ts = datetime.fromisoformat(row["ts"].replace("Z", "+00:00"))
    if last_ts.tzinfo is None:
        last_ts = last_ts.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    age_h = (now - last_ts).total_seconds() / 3600.0
    if age_h < STALE_READING_HOURS:
        conn.close()
        return
    state, _ = get_occupancy_state(conn, DEFAULT_DEVICE_ID)
    if state != "occupied":
        conn.close()
        return
    set_occupancy_state(conn, DEFAULT_DEVICE_ID, "unoccupied", now)
    log_occupancy_transition(conn, DEFAULT_DEVICE_ID, "occupied", "unoccupied", now)
    conn.close()
    if _occupancy_alerts_enabled():
        send_email(
            "Bach unoccupied",
            f"No reading received from the water tank in over {STALE_READING_HOURS:.0f} hours. "
            f"Last reading was {format_duration_human(now - last_ts)} ago "
            f"(at {format_local_time(last_ts)}). The bach is likely unoccupied "
            "(the circuit is typically turned off when the last visitors depart).",
        )


def _occupancy_check_loop() -> None:
    while True:
        time.sleep(STALE_CHECK_INTERVAL_MINUTES * 60)
        try:
            check_occupancy_unoccupied()
        except Exception:
            pass  # keep the thread alive


# ---------------------------------------------------------------------------
# Booking sync (VRBO / Bookabach iCal feed)
# ---------------------------------------------------------------------------

def _parse_ical_dt(line: str) -> Optional[str]:
    """Parse an iCal DTSTART/DTEND line value into an ISO-8601 UTC string.

    Handles three shapes that VRBO-family feeds emit:
      DTSTART;VALUE=DATE:20260614          (all-day, interpreted as midnight NZ)
      DTSTART:20260614T143000Z             (UTC datetime)
      DTSTART;TZID=Pacific/Auckland:20260614T150000  (local datetime, treated as NZ)
    Unknown shapes return None and the event is skipped.
    """
    head, _, value = line.partition(":")
    head_upper = head.upper()
    try:
        if value.endswith("Z"):
            dt = datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            return dt.isoformat()
        if "VALUE=DATE" in head_upper and len(value) == 8:
            dt = datetime.strptime(value, "%Y%m%d").replace(tzinfo=NZ_TZ)
            return dt.astimezone(timezone.utc).isoformat()
        if "T" in value:
            dt = datetime.strptime(value, "%Y%m%dT%H%M%S").replace(tzinfo=NZ_TZ)
            return dt.astimezone(timezone.utc).isoformat()
    except ValueError:
        return None
    return None


def parse_ical(text: str) -> list:
    """Minimal RFC 5545 parser for VRBO/Bookabach exports.

    Returns a list of dicts: {uid, summary, start_ts (UTC ISO), end_ts (UTC ISO)}.
    Folds RFC-5545 continuation lines (leading space/tab). Skips VEVENTs missing
    UID / DTSTART / DTEND.
    """
    # Unfold per RFC 5545 §3.1: lines starting with space or tab continue the
    # previous logical line.
    lines: list = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        if raw.startswith((" ", "\t")) and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)

    events = []
    current = None
    for line in lines:
        if line == "BEGIN:VEVENT":
            current = {}
        elif line == "END:VEVENT":
            if current and {"uid", "start_ts", "end_ts"} <= set(current):
                events.append(current)
            current = None
        elif current is not None:
            if ":" not in line:
                continue
            head, _, value = line.partition(":")
            key = head.split(";")[0].upper()
            if key == "UID":
                current["uid"] = value.strip()
            elif key == "SUMMARY":
                current["summary"] = value.strip()
            elif key in ("DTSTART", "DTEND"):
                parsed = _parse_ical_dt(line)
                if parsed is not None:
                    current["start_ts" if key == "DTSTART" else "end_ts"] = parsed
    return events


def sync_bookings_from_ical(url: Optional[str] = None) -> int:
    """Fetch the configured iCal feed and upsert into bookings.

    Returns the number of upserted events. Returns 0 (silently) if no URL is
    configured or the fetch/parse fails — this runs in a background loop and
    must not raise. Supports http(s):// and file:// URLs.
    """
    target = url if url is not None else BOOKINGS_ICAL_URL
    if not target:
        return 0
    try:
        from urllib.request import urlopen, Request
        req = Request(target, headers={"User-Agent": "watertank-monitor/1.0"})
        with urlopen(req, timeout=15) as r:
            text = r.read().decode("utf-8", errors="replace")
    except Exception:
        return 0
    events = parse_ical(text)
    if not events:
        return 0
    now_iso = datetime.now(timezone.utc).isoformat()
    conn = get_db()
    cur = conn.cursor()
    seen_uids = set()
    for ev in events:
        seen_uids.add(ev["uid"])
        cur.execute(
            """
            INSERT INTO bookings (source_uid, summary, start_ts, end_ts, last_synced)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source_uid) DO UPDATE SET
                summary = excluded.summary,
                start_ts = excluded.start_ts,
                end_ts = excluded.end_ts,
                last_synced = excluded.last_synced
            """,
            (ev["uid"], ev.get("summary"), ev["start_ts"], ev["end_ts"], now_iso),
        )
    # Remove future bookings that are no longer in the feed (cancellations).
    # Keep historical bookings for analytics.
    if seen_uids:
        placeholders = ",".join("?" for _ in seen_uids)
        cur.execute(
            f"DELETE FROM bookings WHERE end_ts >= ? AND source_uid NOT IN ({placeholders})",
            (now_iso, *seen_uids),
        )
    conn.commit()
    conn.close()
    return len(events)


def _bookings_sync_loop() -> None:
    if not BOOKINGS_ICAL_URL:
        return  # Nothing to sync; loop exits and the daemon thread cleans up.
    while True:
        try:
            sync_bookings_from_ical()
        except Exception:
            pass
        time.sleep(BOOKINGS_SYNC_INTERVAL_MINUTES * 60)


def maybe_trigger_threshold(
    conn: sqlite3.Connection, device_id: str, level_percent: float, threshold: float
) -> None:
    if not _water_alerts_enabled():
        return
    alert_type = f"threshold_{int(threshold)}"
    ensure_alert_state(conn, device_id, alert_type)
    cur = conn.cursor()
    cur.execute(
        "SELECT armed FROM alert_state WHERE device_id = ? AND alert_type = ?",
        (device_id, alert_type),
    )
    row = cur.fetchone()
    armed = row["armed"] if row else 1

    if level_percent <= threshold and armed == 1:
        message = f"Water level is below {threshold:.0f}%."
        send_sms(message)
        send_email("Water level alert", message)
        set_alert_state(conn, device_id, alert_type, 0, datetime.now(timezone.utc).isoformat())
    elif level_percent >= threshold + ALERT_HYSTERESIS_PCT and armed == 0:
        set_alert_state(conn, device_id, alert_type, 1, None)


def maybe_trigger_rapid_change(
    conn: sqlite3.Connection, device_id: str, ts: datetime, level_percent: float,
    threshold_pct: float, hours: int, alert_type: str, alert_name: str
) -> None:
    """Generic rapid change detection."""
    if not _water_alerts_enabled():
        return
    ensure_alert_state(conn, device_id, alert_type)
    window_start = (ts - timedelta(hours=hours)).isoformat()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT level_percent, ts FROM readings
        WHERE device_id = ? AND level_percent IS NOT NULL AND ts >= ?
        ORDER BY ts ASC
        LIMIT 1
        """,
        (device_id, window_start),
    )
    baseline = cur.fetchone()
    if baseline is None:
        return
    baseline_pct = float(baseline["level_percent"])
    # Only alert on decrease (possible leak), not on increase
    if level_percent >= baseline_pct:
        return
    delta = baseline_pct - level_percent
    if delta < threshold_pct:
        return
    cur.execute(
        "SELECT last_triggered_ts FROM alert_state WHERE device_id = ? AND alert_type = ?",
        (device_id, alert_type),
    )
    state = cur.fetchone()
    if state and state["last_triggered_ts"]:
        last_ts = datetime.fromisoformat(state["last_triggered_ts"])
        if ts - last_ts < timedelta(hours=hours):
            return
    message = f"Water level dropped by {threshold_pct:.0f}% or more within {hours} hours."
    send_sms(message)
    send_email(alert_name, message)
    set_alert_state(conn, device_id, alert_type, 1, ts.isoformat())


def maybe_trigger_sensor_error(
    conn: sqlite3.Connection, device_id: str, ts: datetime, distance_cm: float
) -> None:
    """Alert if sensor reading < 12cm (indicates condensation or sensor error)."""
    if not _water_alerts_enabled():
        return
    alert_type = "sensor_error_condensation"
    ensure_alert_state(conn, device_id, alert_type)
    cur = conn.cursor()
    cur.execute(
        "SELECT armed FROM alert_state WHERE device_id = ? AND alert_type = ?",
        (device_id, alert_type),
    )
    row = cur.fetchone()
    armed = row["armed"] if row else 1

    # Alert if distance < 12cm (sensor error/condensation)
    if distance_cm < 12.0 and armed == 1:
        message = (
            f"Sensor error detected: Reading {distance_cm:.1f}cm is below 12cm threshold. "
            "This may indicate condensation on the sensor or a sensor malfunction. "
            "Please check the sensor."
        )
        send_sms(message)
        send_email("Sensor Error Alert", message)
        set_alert_state(conn, device_id, alert_type, 0, ts.isoformat())
    # Re-arm if reading returns to normal (>= 12cm)
    elif distance_cm >= 12.0 and armed == 0:
        set_alert_state(conn, device_id, alert_type, 1, None)


app = FastAPI(title="Water Tank Monitor")

if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.middleware("http")
async def disable_static_cache(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.on_event("startup")
def startup() -> None:
    init_db()
    threading.Thread(target=_occupancy_check_loop, daemon=True).start()
    if BOOKINGS_ICAL_URL:
        # First sync runs synchronously at startup so the dashboard has data
        # immediately rather than waiting up to BOOKINGS_SYNC_INTERVAL_MINUTES.
        try:
            sync_bookings_from_ical()
        except Exception:
            pass
        threading.Thread(target=_bookings_sync_loop, daemon=True).start()


@app.get("/")
def index() -> FileResponse:
    index_path = WEB_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Web UI not found")
    return FileResponse(index_path)


@app.get("/health")
def health() -> dict:
    """Liveness probe used by the deploy hook to verify a successful push."""
    return {"status": "ok"}


@app.get("/sw.js")
def service_worker() -> FileResponse:
    """Serve the service worker from the root so its scope covers the whole
    origin (a SW served from /static/ could only control /static/)."""
    path = WEB_DIR / "sw.js"
    if not path.exists():
        raise HTTPException(status_code=404, detail="sw.js not found")
    return FileResponse(
        path,
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"},
    )


@app.get("/manifest.webmanifest")
def web_manifest() -> FileResponse:
    """Serve the PWA manifest with the correct content-type at the root."""
    path = WEB_DIR / "manifest.webmanifest"
    if not path.exists():
        raise HTTPException(status_code=404, detail="manifest not found")
    return FileResponse(path, media_type="application/manifest+json")


@app.post("/api/readings")
def create_reading(reading: ReadingIn) -> dict:
    if INGEST_API_KEY and reading.api_key != INGEST_API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")
    ts = parse_ts(reading.ts)
    
    # Calculate level_percent from distance if not provided
    level_percent = reading.level_percent
    if level_percent is None:
        level_percent = calculate_level_percent(reading.distance_cm)
    
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO readings
        (device_id, ts, distance_cm, level_percent, signal_rssi, signal_rsrp, temp_c, fw_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            reading.device_id,
            ts.isoformat(),
            reading.distance_cm,
            level_percent,
            reading.signal_rssi,
            reading.signal_rsrp,
            reading.temp_c,
            reading.fw_version,
        ),
    )
    conn.commit()

    # Check for sensor errors (condensation/malfunction)
    maybe_trigger_sensor_error(conn, reading.device_id, ts, reading.distance_cm)

    if level_percent is not None:
        maybe_trigger_threshold(conn, reading.device_id, level_percent, 50.0)
        maybe_trigger_threshold(conn, reading.device_id, level_percent, 25.0)
        maybe_trigger_threshold(conn, reading.device_id, level_percent, 10.0)
        # Rapid change alerts: 10% in 6 hours (fast leak) and 15% in 24 hours (slow leak)
        maybe_trigger_rapid_change(conn, reading.device_id, ts, level_percent, 10.0, 6, "rapid_change_10pct_6h", "Rapid change alert")
        maybe_trigger_rapid_change(conn, reading.device_id, ts, level_percent, 15.0, 24, "rapid_change_15pct_24h", "Slow leak alert")

    handle_reading_arrival(conn, reading.device_id, ts)
    conn.close()
    return {"status": "ok"}


@app.get("/api/latest")
def latest_reading(device_id: str = Query(default=DEFAULT_DEVICE_ID)) -> dict:
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT * FROM readings
        WHERE device_id = ?
        ORDER BY ts DESC
        LIMIT 1
        """,
        (device_id,),
    )
    row = cur.fetchone()
    if row is None:
        conn.close()
        return {"reading": None}
    out = {"reading": dict(row)}
    dist = row["distance_cm"]
    if dist is not None and dist < SENSOR_TO_WATER_FULL_CM:
        out["sensor_error"] = True
        cur.execute(
            """
            SELECT * FROM readings
            WHERE device_id = ? AND (distance_cm IS NULL OR distance_cm >= ?)
            ORDER BY ts DESC
            LIMIT 1
            """,
            (device_id, SENSOR_TO_WATER_FULL_CM),
        )
        good = cur.fetchone()
        if good is not None:
            out["last_good_reading"] = dict(good)
    # Expose occupancy state so the dashboard can render a status line.
    state, last_change = get_occupancy_state(conn, device_id)
    out["occupancy"] = {
        "state": state,
        "last_change_ts": last_change.isoformat() if last_change else None,
    }
    conn.close()
    return out


@app.get("/api/readings")
def list_readings(
    device_id: str = Query(default=DEFAULT_DEVICE_ID),
    limit: int = Query(default=10080, ge=1, le=20000),
    since: Optional[str] = Query(default=None, description="ISO timestamp; return readings at or after this time."),
    until: Optional[str] = Query(default=None, description="ISO timestamp; return readings at or before this time."),
) -> dict:
    """Returns readings ordered oldest→newest, filtered by optional time window."""
    where = ["device_id = ?"]
    params: list = [device_id]
    if since is not None:
        try:
            datetime.fromisoformat(since.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid 'since' timestamp") from exc
        where.append("ts >= ?")
        params.append(since)
    if until is not None:
        try:
            datetime.fromisoformat(until.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid 'until' timestamp") from exc
        where.append("ts <= ?")
        params.append(until)
    conn = get_db()
    cur = conn.cursor()
    sql = f"SELECT * FROM readings WHERE {' AND '.join(where)} ORDER BY ts DESC LIMIT ?"
    params.append(limit)
    cur.execute(sql, params)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    rows.reverse()
    return {"readings": rows}


@app.get("/api/bookings")
def list_bookings(
    from_: Optional[str] = Query(default=None, alias="from", description="ISO timestamp; only bookings overlapping at or after this time."),
    to: Optional[str] = Query(default=None, description="ISO timestamp; only bookings overlapping at or before this time."),
) -> dict:
    """All bookings, optionally filtered to those overlapping a [from, to] window.
    A booking 'overlaps' the window when its end_ts > from AND start_ts < to.
    """
    where: list = []
    params: list = []
    if from_ is not None:
        try:
            datetime.fromisoformat(from_.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid 'from' timestamp") from exc
        where.append("end_ts > ?")
        params.append(from_)
    if to is not None:
        try:
            datetime.fromisoformat(to.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid 'to' timestamp") from exc
        where.append("start_ts < ?")
        params.append(to)
    conn = get_db()
    cur = conn.cursor()
    sql = "SELECT * FROM bookings"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY start_ts ASC"
    cur.execute(sql, params)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"bookings": rows}


@app.get("/api/bookings/current")
def get_current_booking() -> dict:
    """Return the booking active right now, or null."""
    now_iso = datetime.now(timezone.utc).isoformat()
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT * FROM bookings
        WHERE start_ts <= ? AND end_ts > ?
        ORDER BY start_ts ASC
        LIMIT 1
        """,
        (now_iso, now_iso),
    )
    row = cur.fetchone()
    conn.close()
    return {"booking": dict(row) if row else None}


@app.get("/api/bookings/upcoming")
def get_upcoming_bookings(days: int = Query(default=90, ge=1, le=365)) -> dict:
    """Return current + future bookings within the next `days`, oldest first."""
    now = datetime.now(timezone.utc)
    horizon = (now + timedelta(days=days)).isoformat()
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT * FROM bookings
        WHERE end_ts > ? AND start_ts < ?
        ORDER BY start_ts ASC
        """,
        (now.isoformat(), horizon),
    )
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"bookings": rows}


@app.post("/api/bookings/sync")
def trigger_bookings_sync(request: Request) -> dict:
    """Manually trigger an iCal sync. Admin-only (rejects ingest hostname)."""
    _reject_ingest_host(request)
    if not BOOKINGS_ICAL_URL:
        return {"status": "noop", "reason": "BOOKINGS_ICAL_URL not configured"}
    count = sync_bookings_from_ical()
    return {"status": "ok", "events_processed": count}


# ---------------------------------------------------------------------------
# Firmware OTA (self-hosted application FOTA for the nRF9160)
# ---------------------------------------------------------------------------

def _parse_version(v: Optional[str]):
    """Parse a dotted version like '1.2.3' into a tuple of ints, or None if
    unparseable. Leading digits of each component are taken ('1.0.0-rc1' →
    (1,0,0)); a component with no leading digit makes the whole thing None."""
    if not v:
        return None
    parts = []
    for comp in str(v).strip().split("."):
        digits = ""
        for ch in comp:
            if ch.isdigit():
                digits += ch
            else:
                break
        if digits == "":
            return None
        parts.append(int(digits))
    return tuple(parts) if parts else None


def _version_newer(candidate: Optional[str], current: Optional[str]) -> bool:
    """True if candidate is strictly newer than current. If current is
    missing/garbage, any parseable candidate counts as newer."""
    c = _parse_version(candidate)
    if c is None:
        return False
    cur = _parse_version(current)
    if cur is None:
        return True
    n = max(len(c), len(cur))
    c = c + (0,) * (n - len(c))
    cur = cur + (0,) * (n - len(cur))
    return c > cur


def _select_latest_release(rows: list, current: Optional[str]):
    """Pick the highest-version release the device is eligible for. Eligible =
    newer than current (or current unknown) AND current satisfies the release's
    min_version gate if set. Returns the row dict or None."""
    best = None
    for r in rows:
        version = r["version"]
        if current is not None and not _version_newer(version, current):
            continue
        min_v = r.get("min_version")
        if min_v and current is not None and _version_newer(min_v, current):
            continue  # device older than the minimum required to take this jump
        if best is None or _version_newer(version, best["version"]):
            best = r
    return best


def _sha256_file(path) -> tuple:
    """Stream a file through SHA-256. Returns (hex_digest, size_bytes)."""
    import hashlib
    h = hashlib.sha256()
    size = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def _firmware_path(relname: str):
    """Resolve a release filename under FIRMWARE_DIR, rejecting path traversal.
    Returns the resolved Path, or None if it would escape FIRMWARE_DIR."""
    base = FIRMWARE_DIR.resolve()
    path = (FIRMWARE_DIR / relname).resolve()
    if base != path and base not in path.parents:
        return None
    return path


class FirmwareRegisterIn(BaseModel):
    version: str = Field(..., min_length=1)
    filename: Optional[str] = Field(
        default=None,
        description="Path relative to FIRMWARE_DIR. Defaults to <version>/app_update.bin",
    )
    min_version: Optional[str] = None
    target_device: Optional[str] = None
    notes: Optional[str] = None
    published: bool = True


@app.post("/api/firmware/register")
def firmware_register(body: FirmwareRegisterIn, request: Request) -> dict:
    """Register a firmware release. The .bin must already be on the LXC under
    FIRMWARE_DIR (scp it there first). The server computes sha256 + size itself —
    it never trusts a client-supplied hash. Admin-only (rejects ingest host)."""
    _reject_ingest_host(request)
    relname = body.filename or f"{body.version}/app_update.bin"
    path = _firmware_path(relname)
    if path is None:
        raise HTTPException(status_code=400, detail="Invalid filename path")
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"File not found under FIRMWARE_DIR: {relname}")
    digest, size = _sha256_file(path)
    now = datetime.now(timezone.utc).isoformat()
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO firmware_releases
            (version, filename, sha256, size_bytes, min_version, target_device, notes, published, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version) DO UPDATE SET
            filename = excluded.filename, sha256 = excluded.sha256,
            size_bytes = excluded.size_bytes, min_version = excluded.min_version,
            target_device = excluded.target_device, notes = excluded.notes,
            published = excluded.published, uploaded_at = excluded.uploaded_at
        """,
        (body.version, relname, digest, size, body.min_version,
         body.target_device, body.notes, 1 if body.published else 0, now),
    )
    conn.commit()
    conn.close()
    return {"status": "ok", "version": body.version, "sha256": digest, "size_bytes": size}


@app.get("/api/firmware/releases")
def firmware_list_releases() -> dict:
    """All registered releases, newest first."""
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT version, filename, sha256, size_bytes, min_version, target_device,
               notes, published, uploaded_at
        FROM firmware_releases ORDER BY uploaded_at DESC
        """
    )
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"releases": rows}


@app.get("/api/firmware/latest")
def firmware_latest(
    current: Optional[str] = Query(default=None, description="Device's current fw version."),
    device: str = Query(default=DEFAULT_DEVICE_ID),
):
    """Newest eligible release for a device, or 204 if already up to date.
    Reachable on the ingest hostname — the device polls this unauthenticated."""
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "SELECT * FROM firmware_releases WHERE published = 1 AND (target_device IS NULL OR target_device = ?)",
        (device,),
    )
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    best = _select_latest_release(rows, current)
    if best is None:
        return Response(status_code=204)
    return {
        "version": best["version"],
        "path": f"/api/firmware/download/{best['version']}",
        "sha256": best["sha256"],
        "size_bytes": best["size_bytes"],
        "notes": best["notes"],
    }


@app.get("/api/firmware/download/{version}")
def firmware_download(version: str):
    """Serve a firmware binary. Starlette's FileResponse honours HTTP Range, so
    a download resumes after a dropped LTE connection rather than restarting."""
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT filename FROM firmware_releases WHERE version = ?", (version,))
    row = cur.fetchone()
    conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="Unknown firmware version")
    path = _firmware_path(row["filename"])
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="Firmware file missing on server")
    return FileResponse(
        path, media_type="application/octet-stream", filename=f"app_update_{version}.bin"
    )


@app.get("/api/firmware/status")
def firmware_status(device: str = Query(default=DEFAULT_DEVICE_ID)) -> dict:
    """Current reported version (from the latest reading) vs latest available.
    Drives the dashboard line and enables closed-loop rollback detection."""
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "SELECT fw_version, ts FROM readings WHERE device_id = ? AND fw_version IS NOT NULL ORDER BY ts DESC LIMIT 1",
        (device,),
    )
    r = cur.fetchone()
    current = r["fw_version"] if r else None
    last_seen = r["ts"] if r else None
    cur.execute(
        "SELECT * FROM firmware_releases WHERE published = 1 AND (target_device IS NULL OR target_device = ?)",
        (device,),
    )
    rows = [dict(x) for x in cur.fetchall()]
    conn.close()
    latest = None
    for rel in rows:
        if latest is None or _version_newer(rel["version"], latest):
            latest = rel["version"]
    up_to_date = bool(latest and current and not _version_newer(latest, current))
    return {
        "device": device,
        "current": current,
        "latest": latest,
        "up_to_date": up_to_date,
        "last_seen": last_seen,
    }


@app.get("/api/config")
def get_public_config() -> dict:
    """Shared constants the dashboard needs; lets the client stay in sync with
    server-side calibration without duplicating literals."""
    return {
        "tank_capacity_liters": TANK_CAPACITY_LITERS,
        "tank_depth_cm": TANK_DEPTH_CM,
        "sensor_to_water_full_cm": SENSOR_TO_WATER_FULL_CM,
        "sensor_to_bottom_cm": SENSOR_TO_BOTTOM_CM,
        "condensation_error_cm": CONDENSATION_ERROR_CM,
        "stale_reading_hours": STALE_READING_HOURS,
        "default_device_id": DEFAULT_DEVICE_ID,
    }


def calculate_feedin_flowrate(conn: sqlite3.Connection, device_id: str, days: int = 7) -> Optional[float]:
    """Calculate average feed-in flow rate (L/hour) from level changes during 2am-7am NZ time.
    
    Args:
        conn: Database connection
        device_id: Device ID to query
        days: Number of recent days to analyze
        
    Returns:
        Average flow rate in L/hour, or None if insufficient data
    """
    nz_tz = NZ_TZ
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT ts, level_percent FROM readings
        WHERE device_id = ? AND ts >= ? AND level_percent IS NOT NULL
        ORDER BY ts ASC
        """,
        (device_id, cutoff),
    )
    rows = cur.fetchall()
    if len(rows) < 2:
        return None
    
    # Group readings by day and calculate flow rate for 2am-7am windows (NZ time)
    daily_flowrates = []
    day_readings = {}  # date -> list of (ts, level_percent) tuples
    
    for row in rows:
        ts_utc = datetime.fromisoformat(row["ts"])
        if ts_utc.tzinfo is None:
            ts_utc = ts_utc.replace(tzinfo=timezone.utc)
        # Convert to NZ time
        ts_nz = ts_utc.astimezone(nz_tz)
        hour = ts_nz.hour
        date_key = ts_nz.date()
        
        # Only consider readings between 2am and 7am NZ time
        if 2 <= hour < 7:
            if date_key not in day_readings:
                day_readings[date_key] = []
            day_readings[date_key].append((ts_utc, float(row["level_percent"])))
    
    # Flow rate each day: average of (rate between each consecutive 2am-7am pair)
    for date_key, readings in day_readings.items():
        result = _feedin_avg_rate_from_readings(readings)
        if result is None:
            daily_flowrates.append(0.0)
            continue
        avg_rate, _first, _last, _reached_100 = result
        daily_flowrates.append(avg_rate)
    
    if not daily_flowrates:
        return None
    
    # Return average flow rate across all days (L/h)
    return sum(daily_flowrates) / len(daily_flowrates)


def get_daily_feedin_rates(conn: sqlite3.Connection, device_id: str, days: int = 30) -> list:
    """Get daily feed-in flow rates (L/hour) for each day with 2am-7am data.
    
    Returns:
        List of dicts with keys: date (YYYY-MM-DD), flowrate_lph, level_start, level_end
    """
    nz_tz = NZ_TZ
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT ts, level_percent, distance_cm FROM readings
        WHERE device_id = ? AND ts >= ? AND level_percent IS NOT NULL
        ORDER BY ts ASC
        """,
        (device_id, cutoff),
    )
    rows = cur.fetchall()
    if len(rows) < 2:
        return []

    # Group readings by day and calculate flow rate for 2am-7am windows (NZ time)
    daily_data = {}  # date -> {readings: [(ts, level, distance_cm), ...]}

    for row in rows:
        ts_utc = datetime.fromisoformat(row["ts"])
        if ts_utc.tzinfo is None:
            ts_utc = ts_utc.replace(tzinfo=timezone.utc)
        ts_nz = ts_utc.astimezone(nz_tz)
        hour = ts_nz.hour
        date_key = ts_nz.date()
        if 2 <= hour < 7:
            if date_key not in daily_data:
                daily_data[date_key] = {"readings": []}
            dist = row["distance_cm"]
            daily_data[date_key]["readings"].append(
                (ts_utc, float(row["level_percent"]), float(dist) if dist is not None else None)
            )
    
    # Flow rate each day: average of rates between each consecutive pair in 2am-7am
    result = []
    for date_key in sorted(daily_data.keys()):
        readings = daily_data[date_key]["readings"]
        # Condensation error if any reading in this window had distance_cm < threshold
        condensation_error = any(
            r[2] is not None and r[2] < CONDENSATION_ERROR_CM for r in readings
        )
        readings_ts_level = [(r[0], r[1]) for r in readings]
        quad = _feedin_avg_rate_from_readings(readings_ts_level)
        if quad is None:
            sorted_r = sorted(readings, key=lambda x: x[0])
            first_l = sorted_r[0][1] if sorted_r else 0.0
            last_l = sorted_r[-1][1] if sorted_r else 0.0
            result.append({
                "date": date_key.isoformat(),
                "flowrate_lph": 0.0,
                "level_start": round(first_l, 2),
                "level_end": round(last_l, 2),
                "reached_full": False,
                "condensation_error": condensation_error,
            })
            continue
        avg_rate, first_l, last_l, reached_full = quad
        result.append({
            "date": date_key.isoformat(),
            "flowrate_lph": round(avg_rate, 2),
            "level_start": round(first_l, 2),
            "level_end": round(last_l, 2),
            "reached_full": reached_full,
            "condensation_error": condensation_error,
        })
    
    return result


@app.get("/api/feedin-rate")
def get_feedin_rate(
    device_id: str = Query(default=DEFAULT_DEVICE_ID),
    days: int = Query(default=7, ge=1, le=30),
) -> dict:
    """Get average feed-in flow rate calculated from 2am-7am level increases."""
    conn = get_db()
    flowrate = calculate_feedin_flowrate(conn, device_id, days)
    conn.close()
    if flowrate is None:
        return {"flowrate_lph": None, "message": "Insufficient data"}
    return {"flowrate_lph": round(flowrate, 2)}


@app.get("/api/feedin-rate/daily")
def get_daily_feedin_rates_endpoint(
    device_id: str = Query(default=DEFAULT_DEVICE_ID),
    days: int = Query(default=30, ge=1, le=90),
) -> dict:
    """Get daily feed-in flow rates for each night (2am-7am window)."""
    conn = get_db()
    daily_rates = get_daily_feedin_rates(conn, device_id, days)
    conn.close()
    return {"daily_rates": daily_rates}


def calculate_net_usage_analysis(conn: sqlite3.Connection, device_id: str, days: int = 3) -> Optional[dict]:
    """Calculate net usage (usage - feed-in) over the past N days.
    
    Returns:
        dict with keys: net_usage_lpd (liters per day), sustainable (bool), 
        days_until_empty (float or None), avg_daily_usage_lpd, avg_daily_feedin_lpd
    """
    # Get recent readings to calculate actual usage
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days + 1)).isoformat()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT ts, level_percent FROM readings
        WHERE device_id = ? AND ts >= ? AND level_percent IS NOT NULL
        ORDER BY ts ASC
        """,
        (device_id, cutoff),
    )
    rows = cur.fetchall()
    if len(rows) < 2:
        return None
    
    # Get daily feed-in rates
    daily_feedin = get_daily_feedin_rates(conn, device_id, days + 1)
    feedin_by_date = {r["date"]: r["flowrate_lph"] for r in daily_feedin}
    
    # Calculate daily feed-in volume: rate is measured during 2am-7am (low usage);
    # for a constant spring/seep source we assume the same rate applies 24h.
    daily_feedin_volumes = {}
    for date, rate_lph in feedin_by_date.items():
        daily_feedin_volumes[date] = rate_lph * 24.0
    
    # Calculate level changes per day to estimate usage. Group by NZ-time date.
    nz_tz = NZ_TZ
    daily_levels = {}  # date -> list of (ts, level_percent)
    for row in rows:
        ts_utc = datetime.fromisoformat(row["ts"])
        if ts_utc.tzinfo is None:
            ts_utc = ts_utc.replace(tzinfo=timezone.utc)
        ts_nz = ts_utc.astimezone(nz_tz)
        date_key = ts_nz.date()
        if date_key not in daily_levels:
            daily_levels[date_key] = []
        daily_levels[date_key].append((ts_utc, float(row["level_percent"])))
    
    # Calculate net usage per day
    # For each day, calculate: net_usage = usage - feed_in
    # Where usage = volume_decrease (if level went down)
    daily_net_usage = []  # liters per day (positive = using more than feed-in)
    sorted_dates = sorted(daily_levels.keys())
    
    for i in range(len(sorted_dates) - 1):
        date1 = sorted_dates[i]
        date2 = sorted_dates[i + 1]
        
        # Get first reading of day1 and last reading of day2
        readings1 = sorted(daily_levels[date1], key=lambda x: x[0])
        readings2 = sorted(daily_levels[date2], key=lambda x: x[0])
        
        if len(readings1) == 0 or len(readings2) == 0:
            continue
        
        level_start = readings1[0][1]
        level_end = readings2[-1][1]
        
        # Observed volume change = feed_in - usage (negative when level dropped)
        volume_change = ((level_end - level_start) / 100.0) * TANK_CAPACITY_LITERS
        # Net depletion = usage - feed_in = -volume_change (positive when tank is being drawn down)
        net_usage = -volume_change
        daily_net_usage.append(net_usage)
    
    if len(daily_net_usage) == 0:
        return None
    
    avg_net_usage = sum(daily_net_usage) / len(daily_net_usage)
    avg_feedin = sum(daily_feedin_volumes.values()) / len(daily_feedin_volumes) if daily_feedin_volumes else 0.0
    
    # Average daily consumption: usage = net_usage + feed_in (net_usage = usage - feed_in)
    avg_usage = avg_net_usage + avg_feedin
    
    # Determine sustainability
    sustainable = avg_net_usage <= 0  # If net usage is negative or zero, feed-in >= usage
    
    # Calculate days until empty (need current level)
    cur.execute(
        """
        SELECT level_percent FROM readings
        WHERE device_id = ? AND level_percent IS NOT NULL
        ORDER BY ts DESC
        LIMIT 1
        """,
        (device_id,),
    )
    latest_row = cur.fetchone()
    if latest_row and avg_net_usage > 0:
        current_level = float(latest_row["level_percent"])
        liters_remaining = (current_level / 100.0) * TANK_CAPACITY_LITERS
        days_until_empty = liters_remaining / avg_net_usage
    else:
        days_until_empty = None
    
    return {
        "net_usage_lpd": round(avg_net_usage, 2),
        "sustainable": sustainable,
        "days_until_empty": round(days_until_empty, 1) if days_until_empty else None,
        "avg_daily_usage_lpd": round(avg_usage, 2),
        "avg_daily_feedin_lpd": round(avg_feedin, 2),
    }


@app.get("/api/usage-analysis")
def get_usage_analysis(
    device_id: str = Query(default=DEFAULT_DEVICE_ID),
    days: int = Query(default=3, ge=1, le=7),
) -> dict:
    """Get net usage analysis (usage - feed-in) for sustainability calculation."""
    conn = get_db()
    analysis = calculate_net_usage_analysis(conn, device_id, days)
    conn.close()
    if analysis is None:
        return {"error": "Insufficient data"}
    return analysis


class SettingsIn(BaseModel):
    notify_water_alerts: Optional[bool] = None
    notify_occupancy: Optional[bool] = None


@app.get("/api/settings")
def read_settings() -> dict:
    """Current notification preferences."""
    return {
        "notify_water_alerts": _water_alerts_enabled(),
        "notify_occupancy": _occupancy_alerts_enabled(),
    }


@app.post("/api/settings")
def write_settings(s: SettingsIn, request: Request) -> dict:
    """Update one or both notification toggles."""
    _reject_ingest_host(request)
    if s.notify_water_alerts is not None:
        set_setting("notify_water_alerts", "true" if s.notify_water_alerts else "false")
    if s.notify_occupancy is not None:
        set_setting("notify_occupancy", "true" if s.notify_occupancy else "false")
    return read_settings()


@app.post("/api/test-email")
def test_email(request: Request) -> dict:
    """Send a test email to verify SMTP configuration."""
    _reject_ingest_host(request)
    try:
        send_email(
            "Water Tank Monitor - Test Email",
            "This is a test email from the Water Tank Monitor system.\n\n"
            "If you received this, email alerts are configured correctly!\n\n"
            f"Test sent at: {datetime.now(timezone.utc).isoformat()}"
        )
        return {"status": "ok", "message": "Test email sent successfully"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)

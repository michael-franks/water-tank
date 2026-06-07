#!/bin/bash
# Deployment script to update app.py via Proxmox console
# Copy and paste this entire script into the Proxmox LXC console

cat > /root/water-tank-monitor/server/app.py << 'ENDOFFILE'
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
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

# Tank calibration: 150mm from sensor to water when full, 2500mm tank depth
SENSOR_TO_WATER_FULL_CM = 15.0
TANK_DEPTH_CM = 250.0
SENSOR_TO_BOTTOM_CM = SENSOR_TO_WATER_FULL_CM + TANK_DEPTH_CM

ALERT_SMS_TO = os.getenv("ALERT_SMS_TO", "").strip()
ALERT_EMAIL_TO = os.getenv("ALERT_EMAIL_TO", "").strip()

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
            temp_c REAL
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
    conn.commit()
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
    msg["To"] = ALERT_EMAIL_TO
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.starttls()
        server.login(SMTP_USERNAME, SMTP_PASSWORD)
        server.send_message(msg)


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


def maybe_trigger_threshold(
    conn: sqlite3.Connection, device_id: str, level_percent: float, threshold: float
) -> None:
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
    conn: sqlite3.Connection, device_id: str, ts: datetime, level_percent: float
) -> None:
    alert_type = "rapid_change_10pct_6h"
    ensure_alert_state(conn, device_id, alert_type)
    window_start = (ts - timedelta(hours=6)).isoformat()
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
    delta = abs(level_percent - float(baseline["level_percent"]))
    if delta < 10.0:
        return
    cur.execute(
        "SELECT last_triggered_ts FROM alert_state WHERE device_id = ? AND alert_type = ?",
        (device_id, alert_type),
    )
    state = cur.fetchone()
    if state and state["last_triggered_ts"]:
        last_ts = datetime.fromisoformat(state["last_triggered_ts"])
        if ts - last_ts < timedelta(hours=6):
            return
    message = "Water level changed by 10% or more within 6 hours."
    send_sms(message)
    send_email("Rapid change alert", message)
    set_alert_state(conn, device_id, alert_type, 1, ts.isoformat())


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


@app.get("/")
def index() -> FileResponse:
    index_path = WEB_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Web UI not found")
    return FileResponse(index_path)


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
        (device_id, ts, distance_cm, level_percent, signal_rssi, signal_rsrp, temp_c)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            reading.device_id,
            ts.isoformat(),
            reading.distance_cm,
            level_percent,
            reading.signal_rssi,
            reading.signal_rsrp,
            reading.temp_c,
        ),
    )
    conn.commit()

    if level_percent is not None:
        maybe_trigger_threshold(conn, reading.device_id, level_percent, 50.0)
        maybe_trigger_threshold(conn, reading.device_id, level_percent, 25.0)
        maybe_trigger_threshold(conn, reading.device_id, level_percent, 10.0)
        maybe_trigger_rapid_change(conn, reading.device_id, ts, level_percent)

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
    conn.close()
    if row is None:
        return {"reading": None}
    return {"reading": dict(row)}


@app.get("/api/readings")
def list_readings(
    device_id: str = Query(default=DEFAULT_DEVICE_ID),
    limit: int = Query(default=336, ge=1, le=5000),
) -> dict:
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT * FROM readings
        WHERE device_id = ?
        ORDER BY ts DESC
        LIMIT ?
        """,
        (device_id, limit),
    )
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    rows.reverse()
    return {"readings": rows}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
ENDOFFILE

systemctl restart water-tank.service
echo "Deployment complete! Service restarted."

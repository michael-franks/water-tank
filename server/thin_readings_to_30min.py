#!/usr/bin/env python3
"""
One-off script: thin readings to one per 30-minute bucket (match new hardware sample rate).
Keeps the reading in each bucket whose ts is closest to the bucket center.
Run from server/ or with DB_PATH set. Back up the DB first.

  cd water-tank-monitor/server
  python thin_readings_to_30min.py
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = os.getenv("DB_PATH", str(DATA_DIR / "readings.db"))

BUCKET_SECONDS = 30 * 60  # 30 minutes


def bucket_start(ts_iso: str) -> int:
    """Return Unix timestamp of the 30-min bucket start for ts."""
    dt = datetime.fromisoformat(ts_iso.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    t = int(dt.timestamp())
    return (t // BUCKET_SECONDS) * BUCKET_SECONDS


def main() -> None:
    if not Path(DB_PATH).exists():
        print(f"DB not found: {DB_PATH}")
        return
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cur.execute("SELECT id, device_id, ts FROM readings ORDER BY device_id, ts")
    rows = list(cur.fetchall())

    # Group by (device_id, bucket_start). Keep id of reading closest to bucket center.
    buckets = {}
    for r in rows:
        key = (r["device_id"], bucket_start(r["ts"]))
        if key not in buckets:
            buckets[key] = []
        buckets[key].append((r["id"], r["ts"]))

    keep_ids = set()
    for (device_id, bucket_ts), items in buckets.items():
        center_ts = bucket_ts + BUCKET_SECONDS // 2
        # Pick reading whose ts is closest to bucket center
        best_id, best_ts = min(
            items,
            key=lambda x: abs(
                datetime.fromisoformat(x[1].replace("Z", "+00:00")).replace(tzinfo=timezone.utc).timestamp()
                - center_ts
            ),
        )
        keep_ids.add(best_id)

    to_delete = [r["id"] for r in rows if r["id"] not in keep_ids]
    before = len(rows)
    after = len(keep_ids)

    print(f"Readings: {before} -> {after} (keeping one per 30-min bucket)")
    print(f"Will delete {len(to_delete)} rows.")

    if to_delete:
        placeholders = ",".join("?" * len(to_delete))
        cur.execute(f"DELETE FROM readings WHERE id IN ({placeholders})", to_delete)
        conn.commit()
        cur.execute("VACUUM")
        conn.commit()
        print("Done. VACUUM run to reclaim space.")
    else:
        print("Nothing to delete.")
    conn.close()


if __name__ == "__main__":
    main()

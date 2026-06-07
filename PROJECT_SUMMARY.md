# Water Tank Monitor – Project Summary

Summary of the project for handover or migration (e.g. to Claude). Covers what’s built, how it works, and what’s left to do.

---

## 1. Goal and scope

- **Purpose:** Remote monitoring of a water tank (Bach) fed by a **constant spring/seep** (not rain).
- **Stack:** nRF9160 + ultrasonic sensor → LTE-M → FastAPI + SQLite → single-page web dashboard.
- **Hosting:** Proxmox LXC container (104) on NUC; site at **bach.franks.nz**. Device posts to ingest endpoint (API key); UI can sit behind Cloudflare Access.

---

## 2. Architecture

| Layer        | Tech / location |
|-------------|------------------|
| **Firmware** | Zephyr on nRF9160; ultrasonic sensor, median filter, HTTP POST every 30 min; NVS cache when offline. |
| **Server**   | FastAPI (`server/app.py`), SQLite in `server/data/readings.db`, static files from `web/`. |
| **Web**      | Vanilla JS + Chart.js 4; `index.html`, `app.js`, `style.css`. |
| **Deploy**   | SCP to Proxmox host, then `pct push` into container 104; `systemctl restart water-tank.service`. |

---

## 3. Features implemented (to date)

### 3.1 Tank level and calibration

- **Level %:** Computed from `distance_cm` using `SENSOR_TO_WATER_FULL_CM` (17 cm), `TANK_DEPTH_CM` (250 cm), `SENSOR_TO_BOTTOM_CM`. Linear: 0% = empty, 100% = full.
- **Capacity:** `TANK_CAPACITY_LITERS` (default 30,000); overridable via env `TANK_CAPACITY_LITERS`. Used for liters remaining, feed-in L/h, and days-remaining.

### 3.2 Sensor error (condensation)

- **Hero / latest reading:** If latest reading has **distance_cm < 17 cm** (SENSOR_TO_WATER_FULL_CM), it’s treated as **sensor error** (condensation). API returns `sensor_error: true` and, when available, `last_good_reading` (most recent reading with `distance_cm >= 17`).
- **Hero display when error:**
  - Level and liters come from **last good reading** (or “Level unknown” if none).
  - A dedicated line under the level shows: **“❌ error since X ago”** or **“❌ sensor error”** (red, bold). Element: `#hero-sensor` in the hero block.
- **Charts:** Readings with **distance_cm < 13** (CONDENSATION_ERROR_CM) are **condensation error** in charts: red dots, red segment fill (History), red points + “error” label (Feed-in). Legend “🔴= sensor error (condensation)” only when the current data contains an error.

So: **17 cm** = threshold for “don’t trust latest, show last good in hero”. **13 cm** = threshold for “mark as error on charts and feed-in”.

### 3.3 Feed-in rate (spring)

- **Source:** Tank is fed by a **constant spring**; feed-in is assumed roughly steady 24/7.
- **Measurement:** Flow rate is estimated from **2am–7am NZ** (low usage). For each night:
  - Use only readings in that window (Pacific/Auckland).
  - Compute **L/h for each consecutive pair** of readings; **average** those rates; if average < 0, treat as 0.
  - If level reaches **≥ 99.5%** during the window, **truncate** to that point (ignore later readings).
  - Minimum window length 15 minutes (MIN_FEEDIN_WINDOW_HOURS = 0.25).
- **Daily feed-in volume:** `rate_lph * 24` (assume same rate all day).
- **Net usage / days remaining:** Net depletion = **observed level change** (`-volume_change`), not derived from feed-in. `days_until_empty = liters_remaining / avg_net_usage` when net usage > 0.

### 3.4 API (relevant for UI)

- **GET /api/latest**  
  Returns `reading` (latest row). If latest has `distance_cm < 17`: also `sensor_error: true` and, if exists, `last_good_reading`.
- **GET /api/readings?limit=...**  
  Time-ordered readings (includes `distance_cm`, `level_percent`).
- **GET /api/feedin-rate?days=7**  
  Average feed-in rate (L/h) over last 7 days from 2–7am windows.
- **GET /api/feedin-rate/daily?days=30**  
  Per-day feed-in rate plus `reached_full`, `condensation_error`, `level_start`, `level_end`.
- **GET /api/usage-analysis?days=3**  
  Net usage, sustainable flag, days until empty, avg daily usage and feed-in.

### 3.5 Web UI

- **Hero:** Level %, liters remaining, sustainability badge, **sensor line** (`#hero-sensor`: “Sensor updated: X ago” or “❌ error since X ago” / “❌ sensor error” with `.is-error` styling).
- **History chart:** Level (%) and Distance (cm); time range presets + custom. **Red dots** and **red fill under the line** for segments where any point has `distance_cm < 13`. Legend “🔴= sensor error (condensation)” only if current data has an error.
- **Feed-in chart:** Daily L/h from 2–7am; 7-day average line. **Colours:** normal = **blue**, full (tank reached 100% in window) = **green**, condensation error = **red**. Vertical “full” / “error” labels above points (rotated -90°, offset above dots). Segment line colour matches (blue/green/red). Legend for red = sensor error, shown only when present.

### 3.6 Alerts and checks

- Low-level thresholds (50 / 25 / 10%) with hysteresis; rapid change (10% in 6 h, 15% in 24 h); sensor error (distance < 12 cm); stale reading check. Optional SMS (Twilio) and email (SMTP).

---

## 4. Key constants (server)

| Constant                   | Default   | Meaning |
|---------------------------|-----------|--------|
| SENSOR_TO_WATER_FULL_CM   | 17        | Sensor-to-water at full; below this → hero uses “last good” and sets sensor_error. |
| TANK_DEPTH_CM             | 250       | Used for level % from distance. |
| TANK_CAPACITY_LITERS      | 30000     | Env override: TANK_CAPACITY_LITERS. |
| CONDENSATION_ERROR_CM     | 13        | Below this → mark as condensation error on charts and feed-in. |
| MIN_FEEDIN_WINDOW_HOURS   | 0.25      | Ignore 2–7am windows shorter than 15 min. |

---

## 5. Deployment

- **Remote deploy:** From repo root (PowerShell):  
  `.\deploy-scp.cmd`  
  (or run `.\deploy-scp.ps1`). Copies `web/app.js`, `web/index.html`, `web/style.css`, `server/app.py` to Proxmox, pushes into LXC 104, restarts `water-tank.service`. See **DEPLOY-SCP.md** for manual steps.
- **Autostart container 104:** On Proxmox host: `pct set 104 --onboot 1`.

---

## 6. File map (application code)

- **Backend:** `server/app.py` (FastAPI, DB, feed-in logic, alerts, `/api/latest` with sensor_error/last_good_reading).
- **Web:** `web/index.html`, `web/app.js`, `web/style.css`. Chart.js 4 + date-fns adapter from CDN.
- **Config:** `server/env.example` → copy to `server/.env` (DB_PATH, INGEST_API_KEY, TANK_CAPACITY_LITERS, alerts, etc.).
- **Firmware:** `firmware/src/main.c` (sensor, HTTP post, cache); build output under `firmware/build/`.

---

## 7. Next steps and to-dos

### High priority

- [ ] **Verify hero error line in production**  
  Ensure `#hero-sensor` is present in the deployed `index.html` and that when latest is &lt; 17 cm the line shows “❌ error since …” or “❌ sensor error” and level/liters use last good reading.
- [ ] **Confirm feed-in colours**  
  Ensure deployed `app.js` uses blue (normal), green (full), red (error) and vertical “full”/“error” labels above points.

### Medium priority

- [ ] **Optional: red fill under History line**  
  Current behaviour: segment fill is red when either endpoint has condensation_error. If Chart.js or data order causes issues, consider simplifying (e.g. red dots only) or re-testing the fill plugin.
- [ ] **Document 17 vs 13 cm**  
  In README or config: 17 cm = “sensor error for hero / use last good”; 13 cm = “condensation on charts and feed-in”. Consider making one or both configurable via env if needed.
- [ ] **Test with power-off behaviour**  
  When device is off (e.g. no guests), feed-in and days-remaining are based only on days with data; document or add a short UI note.

### Lower priority

- [ ] **Alerts:** Ensure Twilio/SMTP are configured if low-level or rapid-change alerts are required.
- [ ] **Firmware:** If sampling interval or cache behaviour changes, align any server-side thinning (e.g. `thin_readings_to_30min.py`) and docs.
- [ ] **Mobile:** Confirm hero and charts are readable on small screens; vertical feed-in labels were added to reduce overlap.

---

## 8. Quick reference

- **Deploy:** `.\deploy-scp.cmd` from repo root.
- **Env:** `server/.env` from `server/env.example`; key vars: `INGEST_API_KEY`, `TANK_CAPACITY_LITERS`, alert to/from.
- **Hero error:** Shown in `#hero-sensor` when latest `distance_cm < 17`; level/liters from `last_good_reading` when provided.
- **Charts error:** Points with `distance_cm < 13` are red; History has red segment fill; Feed-in has red points + “error” label.
- **Feed-in:** 2–7am NZ, average of consecutive-pair rates, rate × 24 for daily volume; net usage from observed level change.

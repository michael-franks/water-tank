# Water Tank Monitor

Personal monitor for the bach's rainwater tank. A cellular IoT sensor in the
tank reports level + RSRP every 30 min over LTE-M; the server stores readings
in SQLite, drives the dashboard, and (when enabled) sends email alerts.

Live at **https://bach.franks.nz** (behind Cloudflare Access) and
**https://ingest-bach.franks.nz** (unauthenticated — sensor POSTs here),
hosted on **LXC 104** of the home Proxmox NUC. Sensor is an nRF9160 DK
with the custom Meter Carrier hat (OSHO Ltd PN 01014-A3).

## Repo layout

| Path | What it is |
|------|------------|
| `server/app.py` | FastAPI server: ingestion, dashboard, alerts, settings, occupancy state machine. |
| `server/requirements.txt` | Python deps. |
| `server/env.example` | Template for `server/.env` (never committed). |
| `server/thin_readings_to_30min.py` | One-shot script to thin a noisy reading history down to 30-minute samples. |
| `server/THIN-COMMANDS.md` | How to use the thinning script. |
| `web/index.html` + `web/app.js` + `web/style.css` | Single-page dashboard. Charts via Chart.js. |
| `firmware/` | nRF9160 DK Zephyr app. Flashed separately (not part of the deploy pipeline). |
| `PROJECT_SUMMARY.md`, `REPLICATION_GUIDE.md`, `EMAIL_SETUP.md`, `DEMO_PRESENTATION.md` | Project context + setup notes. |

Secrets and data are never committed (`.gitignore`): `server/.env`,
`server/data/*.db*`.

## How it works

- **Sensor** (nRF9160 DK + carrier hat) POSTs JSON readings every 30 min to
  `https://ingest-bach.franks.nz/api/readings`. RAM-cached if LTE fails.
- **Server** (`server/app.py`) writes each reading to SQLite, calculates level
  percent from `distance_cm` using `SENSOR_TO_WATER_FULL_CM` / `TANK_DEPTH_CM`,
  and runs the alert/occupancy logic.
- **Dashboard** (`web/`) shows the latest level, history chart, feed-in rate,
  and a Notifications card with two toggles.

### Notification model

Two persistent settings in the `settings` table, defaults at first startup:

| Setting | Default | What it gates |
|---------|---------|---------------|
| `notify_water_alerts` | `false` | Threshold alerts (50%, 25%, 10%), rapid-change/leak alerts, sensor-error condensation alerts. Off by default while the ultrasonic sensor is noisy. |
| `notify_occupancy` | `true` | Bach occupied / unoccupied emails (replaces the old stale-readings alert). |

Occupancy is a state machine (`occupancy_state` table): `unknown` → `occupied`
on the first reading after a gap (silent on first-ever); `occupied` →
`unoccupied` when no reading arrives for `STALE_READING_HOURS` (default 6h),
sending a "Bach unoccupied" email. The reverse fires "Bach occupied".

## Develop, test, deploy

```bash
# Develop locally
py -m venv .venv && .venv\Scripts\Activate.ps1
pip install -r server/requirements.txt
cp server/env.example server/.env       # fill in SMTP if you want email
python server/app.py                    # serves on :8000

# Deploy: push to both remotes.
# A post-receive hook on the Proxmox host parse-checks server/app.py, backs up
# the live copy, promotes server/ + web/ into LXC 104, restarts the service
# only if server/ changed, /health-checks, and auto-rolls-back if it comes up
# unhealthy. The hook preserves server/data/ (SQLite DB) and server/.env across
# deploys.
git push origin main     # history + offsite backup (GitHub)
git push deploy main     # deploy to bach.franks.nz (LXC 104)
# one-time: git remote add deploy proxmox-claude:/root/water-tank-monitor.git
```

### Conventions
- **Commit and push every change** — small, focused commits on `main`.
- The deploy hook parse-checks `server/app.py` (`python -m py_compile`) and
  refuses to promote a syntax error.
- The hook takes a `.deploybak/code.tar.gz` of the live server+web tree and
  **auto-rolls-back** if `/health` doesn't return 200 after a restart.
- Never commit secrets or the SQLite DB.

### Firmware

`firmware/` is an nRF9160 DK Zephyr app. It's **not** part of the deploy hook —
flash it separately:

```bash
west build -b nrf9160dk_nrf9160_ns firmware
west flash
```

## Backups & recovery

The data (`server/data/readings.db`) lives only on the LXC — deliberately
never in git. Two layers protect it:

1. **`server/data/readings.db.bak`** — sibling backup file on the LXC, taken
   when the thinning script was last run.
2. **Weekly Proxmox vzdump** of LXC 100 (HAOS) only — LXC 104 is **not**
   currently in the backup set. Worth adding `vmid 104` to the vzdump job
   (`backup-75d85498-ebc0`) if continuity matters.

The post-receive deploy hook keeps `server/data/` and `server/.env` untouched
across deploys (they get stashed/restored), and a `.deploybak/code.tar.gz`
snapshot of the previous server+web code is taken before every promote.

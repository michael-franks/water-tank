# Water Tank Monitor — Replication Guide

This guide walks through building a copy of the remote water tank monitoring system from scratch.

---

## 1. Overview

The system has three parts:

| Part | Role |
|------|------|
| **Firmware** (nRF9160) | Reads ultrasonic sensor, filters data, posts to your server via LTE |
| **Server** (Python/FastAPI) | Stores readings in SQLite, runs alert logic, serves the website |
| **Website** | Dashboard: level %, liters remaining, sustainability, history graph, feed-in rate |

**Tank assumptions (edit for your tank):**
- 30,000 L capacity
- Sensor 15 cm from water surface when full
- 250 cm from sensor to tank bottom (measure and update in server + firmware if different)

---

## 2. Hardware You’ll Need

- **Nordic nRF9160 DK** (or SiP + MCU)
- **Ultrasonic distance sensor** (e.g. Adafruit 4007 or HC-SR04–compatible), 3.3 V or 5 V with level shifting
- **SIM** with data (LTE-M or NB-IoT; check carrier)
- **Power** (USB for dev, mains for deployment)
- **Cellular antenna** (on-board or external, depending on enclosure)

**Wiring (example for Adafruit 4007):**
- VCC → 3.3 V (or 5 V if sensor is 5 V)
- GND → GND
- TRIG → GPIO (e.g. P0.18, set in firmware)
- ECHO → GPIO (e.g. P0.14, set in firmware)

---

## 3. Server Setup

### 3.1 Python environment

```bash
# Windows
py -m venv .venv
.venv\Scripts\Activate.ps1

# Linux / macOS
python3 -m venv .venv
source .venv/bin/activate

pip install -r server/requirements.txt
```

### 3.2 Configuration

1. Copy the example env file:
   ```bash
   cp server/env.example server/.env
   ```
2. Edit `server/.env`:
   - **INGEST_API_KEY** — Strong random string. The device will send this in each request.
   - **ALERT_EMAIL_TO** — Email for alerts.
   - **SMTP_*** — SMTP settings if you want email alerts (see `EMAIL_SETUP.md` for Gmail).
   - Leave Twilio blank if you’re not using SMS.

### 3.3 Tank dimensions (in code)

Edit `server/app.py` if your tank differs:

- `SENSOR_TO_WATER_FULL_CM` — Distance from sensor to water surface when tank is full (e.g. 15).
- `TANK_DEPTH_CM` — Depth from “full” water surface to bottom (e.g. 250).
- `TANK_CAPACITY_LITERS` — Total capacity (e.g. 30000).

### 3.4 Run locally

```bash
python server/app.py
```

Open `http://localhost:8000`. The UI and API are available; no firmware needed to test the dashboard (you can POST sample readings with `curl` or a script).

### 3.5 Production (e.g. Linux server)

- Run under **systemd** (or similar) so it restarts on crash/reboot.
- Use **gunicorn** or **uvicorn** behind a reverse proxy if you prefer.
- Keep `server/data/` for SQLite (create it if missing). Do not commit `server/.env` or `server/data/readings.db`.

---

## 4. Firmware Setup

### 4.1 nRF Connect SDK

1. Install **nRF Connect for VS Code** or the **nRF Connect SDK** (Zephyr) via the Nordic installer.
2. Use the **nRF Connect** or **west** terminal so the toolchain is on `PATH`.

### 4.2 Project files

Use the `firmware/` folder from this project:

- `CMakeLists.txt`
- `prj.conf`
- `pm_static.yml`
- `src/main.c`

Do **not** bundle the full SDK or `build/` in your zip; your friend’s SDK install provides those.

### 4.3 Configure for your setup

In `firmware/src/main.c` set:

- **SERVER_HOST** — Your server hostname (e.g. `ingest.yourdomain.com`).
- **SERVER_PORT** — Usually 443 for HTTPS.
- **SERVER_PATH** — e.g. `/api/readings`.
- **API_KEY** — Same value as `INGEST_API_KEY` in `server/.env`.
- **TRIG_PIN / ECHO_PIN** — GPIOs connected to the sensor (e.g. 18, 14 for P0.18, P0.14).
- **SAMPLE_INTERVAL_MINUTES** — e.g. 10 or 30.

Tank math in firmware (if you send `level_percent` from the device) must match the server (same depth and “full” offset). The server can also derive `level_percent` from `distance_cm` if you prefer.

### 4.4 Build and flash

From the project root (or from `firmware/` if your `west` app is configured that way):

```bash
cd firmware
west build -b nrf9160dk/nrf9160/ns .
west flash
```

Board identifier may differ (e.g. `nrf9160dk_nrf9160_ns`). Use the target name that matches your DK/SiP in the nRF Connect SDK version you use.

---

## 5. Exposing the Server (ingest + website)

You need:

1. **HTTPS** for the firmware (and optionally for the website).
2. A **hostname** the nRF9160 can resolve (e.g. via DNS or Cloudflare Tunnel).

Options:

- **Cloudflare Tunnel** — Run `cloudflared` on the same machine as the server (or a gateway that forwards to it). Create a public hostname that points to `http://localhost:8000` (or your internal IP:port). Use a separate subdomain for “ingest” (e.g. `ingest.yourdomain.com`) if you want to lock it down by path or rules.
- **Reverse proxy** — Nginx/Caddy on a VPS or home server, with TLS (e.g. Let’s Encrypt), forwarding to the Python app.
- **Port forward + TLS** — Less ideal from a security standpoint, but possible if you understand the risks.

Use the **ingest** URL (and path) in the firmware’s `SERVER_HOST` and `SERVER_PATH`. The site can be the same origin or a different subdomain, depending on how you’ve set up DNS and the tunnel/proxy.

---

## 6. Security Checklist

- [ ] `INGEST_API_KEY` is long, random, and only in `server/.env` (not in repo).
- [ ] In production, the server is only reachable via HTTPS (tunnel or reverse proxy).
- [ ] Ingress to the ingest host (or path) is restricted (e.g. by API key + optional IP/geo).
- [ ] If you use Cloudflare Access, either:
  - Use a **Bypass** policy for the ingest hostname and rely on the API key, or
  - Use a dedicated ingest hostname that is not behind Access, and protect it with a firewall/API key only.

---

## 7. Alert Types (Configured in Code)

The server triggers alerts when:

- Level goes **below 50%, 25%, or 10%** (with hysteresis so it doesn’t spam).
- **Rapid change:** level changes by **≥10% within 6 hours** (e.g. big leak).
- **Slow leak:** level changes by **≥5% within 24 hours**.
- **Sensor error:** distance **&lt; 12 cm** (e.g. condensation or fault).

Alerts are sent via the configured SMTP (email). Twilio (SMS) is optional; leave env vars empty to skip SMS.

---

## 8. Optional: Data Retention and Intervals

- **API**  
  - `GET /api/readings?limit=...` — Increase `limit` if you want more history (e.g. 52,560 for ~1 year at 10‑minute intervals).  
- **Firmware**  
  - `SAMPLE_INTERVAL_MINUTES` — 10 gives ~52,560 points/year; 30 gives ~17,520.  
- **SQLite**  
  - Ensure the server disk has enough free space (e.g. tens of MB per year at 10‑minute intervals).

---

## 9. Zip Package

A ready-made **water-tank-monitor-replication.zip** is in the same folder as this guide. Unzip it to get the project layout below. It includes:

- This guide, README, and EMAIL_SETUP
- Server app, requirements, and `env.example` (no `.env` or database)
- Web UI (HTML, JS, CSS, favicons)
- Firmware source only (no SDK or build output)

**Do not include** in any zip you share: `server/.env`, `server/data/readings.db`, `firmware/build/`, or SDK trees.

---

## 10. File Layout (after unzip)

A minimal set of files to give someone reproducing the project:

```
water-tank-monitor/
├── REPLICATION_GUIDE.md   (this file)
├── README.md
├── EMAIL_SETUP.md
├── server/
│   ├── app.py
│   ├── requirements.txt
│   └── env.example        (copy to .env and fill in)
├── web/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── favicon.svg
│   └── favicon.png        (optional; replace with your own)
└── firmware/
    ├── CMakeLists.txt
    ├── prj.conf
    ├── pm_static.yml
    ├── README.md
    └── src/
        └── main.c
```

Do **not** include:
- `server/.env`
- `server/data/readings.db`
- `firmware/build/`
- SDK or other third‑party trees

---

## 11. Quick Test Without Hardware

1. Start the server: `python server/app.py`
2. Open `http://localhost:8000`
3. POST a fake reading (PowerShell):

   ```powershell
   $body = '{"device_id":"tank-1","api_key":"YOUR_INGEST_API_KEY","distance_cm":120,"level_percent":52}'
   Invoke-RestMethod -Method Post -Uri "http://localhost:8000/api/readings" -ContentType "application/json" -Body $body
   ```

   Use the same `api_key` as in `server/.env`. After a few such requests, the dashboard and history graph will show data.

---

## 12. Troubleshooting

| Symptom | Check |
|--------|--------|
| “Unauthorized” from device | `api_key` in firmware matches `INGEST_API_KEY` in `.env` |
| No data on website | Device can reach server host/port; path is `/api/readings`; CORS not blocking (FastAPI allows localhost by default) |
| Level always 0 or 100 | Tank constants (depth, “full” offset) in server (and firmware if used) match your tank and wiring |
| No email alerts | SMTP_* and ALERT_EMAIL_TO in `.env`; run `POST /api/test-email` against the server (e.g. from inside the host) to test |
| Sensor reads &lt; 12 cm | Wiring, mounting, and condensation; alert is there to highlight this |

---

Good luck replicating the project. Adjust tank dimensions, intervals, and alert thresholds to match your site and preferences.

# Bach Water Tank Monitor – Demo Presentation

---
# 1) Why we built this
- Remote bach, no easy way to know tank level
- Need simple, reliable visibility and alerts
- Goal: end‑to‑end prototype using AI‑assisted development

---
# 2) What we built (in one slide)
- Sensor + nRF9160 LTE‑M
- Cloudflare‑secured API + web dashboard
- Current status, history, and alerts

---
# 3) System architecture
- **Sensor** → ultrasonic distance (Adafruit 4007)
- **MCU** → nRF9160 dev kit
- **Connectivity** → LTE‑M (Vodafone/One NZ)
- **Backend** → FastAPI + SQLite on NUC
- **Frontend** → responsive dashboard

---
# 4) Device side (nRF9160)
- Read distance
- Filter (median of 5 pings)
- Send to `/api/readings`
- Cache to flash if offline
- LED heartbeat + manual button sample

---
# 5) Cloud + UI
- Secure UI with Google SSO
- Separate ingest endpoint (bypass + API key)
- Live dashboard updates
- Mobile‑first refinements

---
# 6) Demo: Live data
- Show LTE connected
- Send sample
- UI updates in ~1 minute
- History graph with time‑based axis

---
# 7) What AI helped with
- Rapid firmware iteration
- Backend API + schema
- UI/UX redesign and mobile layout
- Debugging: LTE, HTTP errors, caching issues

---
# 8) Key issues we solved
- LTE connection failures
- HTTPS domain mismatch
- Cloudflare Access blocking device
- Broken HTTP client requests
- Missing data in UI

---
# 9) Results
- End‑to‑end working prototype
- Real sensor → cloud → web
- Reliable updates + offline cache
- Clean, simple UI

---
# 10) What’s next
- Calibrate tank depth → % full and liters
- Alert thresholds (50/25/10%)
- Reduce sample to 30‑minute cadence
- Long‑term trend and leak detection

---
# 11) Takeaway
AI‑assisted prototyping let us go from zero to a working, deployed system
in a single sprint with real hardware and real data.


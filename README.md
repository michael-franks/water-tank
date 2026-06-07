# Water Tank Monitor

This project includes:
- **Firmware** for the nRF9160 to read the ultrasonic sensor and upload data.
- **Server + API** to store readings, trigger alerts, and serve the website.
- **Website** showing latest level and history graph.

## Quick start (server + web)

1. Create a virtual environment and install deps:
   - Windows PowerShell:
     - `py -m venv .venv`
     - `.venv\Scripts\Activate.ps1`
   - Install:
     - `pip install -r server/requirements.txt`

2. Configure environment:
   - Copy `server/env.example` to `server/.env`
   - Fill in values (SMS/email optional)

3. Run server:
   - `python server/app.py`
   - Open `http://localhost:8000`

## Firmware notes

The firmware skeleton is in `firmware/`. It reads the ultrasonic sensor, applies
median filtering, and posts data every 30 minutes. It includes a RAM cache
placeholder; flash-backed storage can be added once the sensor is mounted and
network settings are finalized.

## Next steps

- Add tank dimensions (height + diameter) and calculate % full on the device or server.
- Configure SMS and email providers.
- Decide if you want managed hosting later (Supabase/Firebase) or keep self-hosted.

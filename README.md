# ISS Tracker

Dual-mode receive-only ISS + amateur satellite tracker for Raspberry Pi.
The same codebase also runs on macOS for windowed local testing.

Detailed install/build/run instructions:
- [INSTALL_AND_RUN.md](/Users/prajwal/Documents/GitHub/ISS Tracker/docs/INSTALL_AND_RUN.md)

## Features
- Full-screen kiosk UI and lightweight mobile web UI
- ISS display mode toggle:
  - `SunlitOnlyVideo`
  - `SunlitAndVisibleVideo`
  - `TelemetryOnly`
- Location sources: manual profiles, browser geolocation, optional GPS override
- Offline-first dataset snapshots and configurable cache policy
- Network mode state API (station/AP) for provisioning integrations
- Remote refresh from CelesTrak + SatNOGS with cached fallback catalog
- AMSAT operational-status comparison data cached from `amsat.org/status` with a 12-hour minimum refresh interval
- On kiosk/lite page load, satellite catalog refresh is attempted so Tx/Rx metadata is updated on browser refresh

## Run
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Or use the cross-platform launcher:
```bash
# macOS windowed
python3 scripts/run_tracker.py --mode windowed --ui kiosk --host 127.0.0.1 --port 8000

# Raspberry Pi kiosk
python3 scripts/run_tracker.py --mode kiosk --ui kiosk --host 0.0.0.0 --port 8000
```

Open:
- Kiosk UI: `http://<pi-ip>:8000/`
- Lite UI: `http://<pi-ip>:8000/lite`
- API docs: `http://<pi-ip>:8000/docs`

## Test
```bash
pytest -q
```

## Notes
- This package is receive-only. No rotor/PTT/CAT/transmit automation is included.
- Data refresh endpoint: `POST /api/v1/datasets/refresh`
- Satellite endpoint supports forced source refresh: `GET /api/v1/satellites?refresh_from_sources=true`
- Pi unit files and fallback helper script are in `scripts/`:
  - `iss_tracker_api.service`
  - `pi_kiosk.service`
  - `network_fallback.sh`

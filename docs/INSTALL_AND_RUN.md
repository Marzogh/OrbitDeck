# OrbitDeck Install / Build / Run Guide

OrbitDeck uses one Python codebase across macOS and Raspberry Pi.

- macOS: supported for local development and windowed use, and tested in that mode
- Raspberry Pi: intended kiosk deployment target
- Pi Zero-class hardware: automatically serves lite mode instead of the full kiosk and rotator surfaces
- Pi Zero-class lite mode uses a first-run tracked-satellite setup and limits tracking work to a bounded set of up to 8 satellites
- Standard UI surfaces in non-lite-only deployments: rotator landing (`/`), kiosk (`/kiosk`), lite (`/lite`), rotator (`/kiosk-rotator`), and settings (`/settings`)
- Lite also has a dedicated settings route at `/lite/settings`

For the short version, start with the [docs home](index.md). This guide goes deeper on installation and deployment.

OrbitDeck also includes a MkDocs-based documentation site. For local docs preview and build commands, see [local-build.md](local-build.md).

## 1) Prerequisites

### macOS
- Python 3.11+
- Any modern browser
- Network access if you want fresh catalog/AMSAT refreshes

### Raspberry Pi
- Raspberry Pi OS Bookworm or similar Linux desktop environment
- Python 3.11+
- Chromium browser for kiosk mode
- Network access if you want fresh catalog/AMSAT refreshes
- Optional: GPS receiver and NetworkManager (`nmcli`) for AP fallback scripts

## 2) Clone and install

```bash
git clone <your-repo-url> orbitdeck
cd orbitdeck
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
```

## 3) Run on macOS

Recommended windowed launcher flow:

```bash
source .venv/bin/activate
python3 scripts/run_tracker.py --mode windowed --ui kiosk --host 127.0.0.1 --port 8000
```

Useful local URLs:
- Rotator landing UI: [http://127.0.0.1:8000/](http://127.0.0.1:8000/)
- Kiosk UI: [http://127.0.0.1:8000/kiosk](http://127.0.0.1:8000/kiosk)
- Lite UI: [http://127.0.0.1:8000/lite](http://127.0.0.1:8000/lite)
- Lite settings UI: [http://127.0.0.1:8000/lite/settings](http://127.0.0.1:8000/lite/settings)
- Rotator UI: [http://127.0.0.1:8000/kiosk-rotator](http://127.0.0.1:8000/kiosk-rotator)
- Settings UI: [http://127.0.0.1:8000/settings](http://127.0.0.1:8000/settings)
- API docs: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)

Alternative lite startup:

```bash
python3 scripts/run_tracker.py --mode windowed --ui lite --host 127.0.0.1 --port 8000
```

Direct server-only alternative:

```bash
source .venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

What has been tested on macOS:
- FastAPI server startup
- launcher-driven browser open in windowed mode
- local use of the kiosk, lite, and rotator routes
- local use of the settings route
- API docs and local test workflow

What macOS is not positioned as:
- the primary kiosk deployment target
- a full replacement for Raspberry Pi kiosk/browser automation

## 4) Run on Raspberry Pi

Local kiosk run:

```bash
source .venv/bin/activate
python3 scripts/run_tracker.py --mode kiosk --ui kiosk --host 0.0.0.0 --port 8000
```

Open from another device on the network:
- Rotator landing UI: `http://<pi-ip>:8000/`
- Kiosk UI: `http://<pi-ip>:8000/kiosk`
- Lite UI: `http://<pi-ip>:8000/lite`
- Rotator UI: `http://<pi-ip>:8000/kiosk-rotator`
- Settings UI: `http://<pi-ip>:8000/settings`
- API docs: `http://<pi-ip>:8000/docs`

Direct server-only alternative:

```bash
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### Pi Zero behavior

On Pi Zero-class hardware, OrbitDeck routes `/`, `/settings`, and `/kiosk-rotator` to the lite UI automatically. `/lite` remains available directly on all hardware.

Lite behavior on low-power hardware:
- first run opens a setup gate before the dashboard
- the user chooses up to 8 tracked satellites
- lite requests only compute passes and live tracking for that bounded set
- lite settings are managed at `/lite/settings`
- tapping an upcoming pass loads an AOS cue into the lite focus compass

## 5) Raspberry Pi production install with systemd

These steps set up the API and kiosk browser for boot-time startup.

### 5.1 Install the app under `/opt/orbitdeck`

```bash
sudo mkdir -p /opt/orbitdeck
sudo chown -R $USER:$USER /opt/orbitdeck
rsync -av --delete ./ /opt/orbitdeck/
cd /opt/orbitdeck
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
```

### 5.2 Install systemd units

```bash
sudo cp scripts/orbitdeck_api.service /etc/systemd/system/
sudo cp scripts/pi_kiosk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable orbitdeck_api.service
sudo systemctl enable pi_kiosk.service
sudo systemctl start orbitdeck_api.service
sudo systemctl start pi_kiosk.service
```

### 5.3 Check service health

```bash
sudo systemctl status orbitdeck_api.service --no-pager
sudo systemctl status pi_kiosk.service --no-pager
curl http://localhost:8000/health
```

## 6) Optional AP fallback networking

A helper script is included: `scripts/network_fallback.sh`

- It tries known Wi-Fi profiles first
- If none connect, it activates AP profile `OrbitDeck-AP`

Run manually:

```bash
bash scripts/network_fallback.sh
```

You can call this from a boot-time service or NetworkManager dispatcher script.

## 7) Data refresh and runtime files

OrbitDeck uses both bundled assets and runtime-generated local state:

- `data/ephemeris/de421.bsp`
  - bundled intentionally
  - used for sky/body calculations on first run
- `data/state.json`
  - created locally at runtime
  - stores persisted settings/state
- `data/snapshots/*.json`
  - created locally at runtime
  - stores cached catalog/refresh metadata

Refresh behavior:
- `GET /api/v1/satellites?refresh_from_sources=true`
  - attempts to pull fresh CelesTrak + SatNOGS data
  - also tries ephemeris and AMSAT status refresh where allowed
- `GET /api/v1/lite/snapshot`
  - returns the bounded lite dashboard snapshot
  - computes only the configured tracked satellites plus ISS state when needed
- `GET /api/v1/frequency-guides/recommendation`
  - returns Doppler-aware operator guidance for a single satellite
  - can also return a linear-pass phase matrix when the selected satellite supports it
- `POST /api/v1/datasets/refresh`
  - triggers the manual refresh flow
- AMSAT refresh is throttled to a minimum 12-hour interval
- lite mode maintains local shell/API caching for mobile/offline resilience

If remote refresh fails, cached catalog data remains active.

## 8) API and route quick reference

UI routes:
- `/`
- `/kiosk`
- `/lite`
- `/lite/settings`
- `/settings`
- `/kiosk-rotator`

Settings UI:
- exposes ISS display mode, tracked satellite selection, pass filters, location-source inputs, timezone, video source overrides, and kiosk developer override controls
- includes direct navigation back to the kiosk and rotator screens
- on Pi Zero-class hardware, `/settings` resolves to the lite surface instead of the kiosk settings page

Lite settings UI:
- exposes tracked satellites, default focus, timezone, location source, and Pi GPS connection details
- is the main low-power-device configuration surface for lite mode

Core APIs:
- `GET /health`
- `GET /api/v1/system/state`
- `GET /api/v1/satellites`
- `GET /api/v1/live`
- `GET /api/v1/lite/snapshot`
- `GET /api/v1/passes`
- `GET /api/v1/track/path`
- `GET /api/v1/iss/state`
- `GET /api/v1/frequency-guides/recommendation`

Settings/config APIs:
- `GET/POST /api/v1/settings/iss-display-mode`
- `GET/POST /api/v1/settings/lite`
- `GET/POST /api/v1/settings/timezone`
- `GET/POST /api/v1/settings/developer-overrides`
- `GET/POST /api/v1/settings/pass-filter`
- `GET/POST /api/v1/settings/gps`
- `GET/POST /api/v1/location`
- `GET/POST /api/v1/network`
- `GET/POST /api/v1/cache-policy`

Other useful APIs:
- `POST /api/v1/datasets/refresh`
- `POST /api/v1/snapshots/record`

Full schema details are available at `/docs`.

## 9) Test

Backend tests:

```bash
source .venv/bin/activate
pytest -q
```

Optional frontend JS syntax checks:

```bash
node --check app/static/lite/lite.js
node --check app/static/lite/sw.js
node --check app/static/kiosk/kiosk.js
node --check app/static/kiosk/rotator.js
```

## 10) Notes

- OrbitDeck is receive-only: no rotor/PTT/CAT/transmit control is included
- The rotator globe/hemisphere view depends on `app/static/common/hemisphere.js` and `app/static/common/hemisphere-land.js`
- Kiosk, rotator, and lite all use the same shared Doppler/frequency-guidance backend model
- Kiosk developer overrides are intended for debugging and demo control of rotator scenes
- The `references/` tree is design and research material, not a runtime dependency
- When README changes alter run/support guidance, this guide should be updated in the same change
- If lite frontend changes add new API routes, restart the FastAPI process so the browser and backend stay on the same revision

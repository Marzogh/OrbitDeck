# OrbitDeck

OrbitDeck is a cross-platform, receive-only amateur-satellite operations dashboard. It combines live tracking, pass prediction, RF metadata, ISS visibility/video state, and AMSAT operational-status comparison behind a FastAPI backend with multiple web UIs.

OrbitDeck currently supports:
- kiosk UI at `/`
- lite/mobile UI at `/lite`
- rotator/operator UI at `/kiosk-rotator`
- settings UI at `/settings`

macOS is supported for local development and windowed use, and this project has been exercised on macOS in that mode. Raspberry Pi is the intended kiosk deployment target. On Pi Zero-class hardware, OrbitDeck automatically serves the lite UI instead of the full kiosk and rotator surfaces.

Detailed install/build/run instructions:
- [docs/INSTALL_AND_RUN.md](docs/INSTALL_AND_RUN.md)

## Where This Runs

### macOS
- Supported for local development and windowed use
- Tested on macOS for app-server, browser-launched windowed UI, API docs, and local test workflow
- Recommended launcher:

```bash
python3 scripts/run_tracker.py --mode windowed --ui kiosk --host 127.0.0.1 --port 8000
```

### Raspberry Pi
- Supported for kiosk deployment and always-on local hosting
- Intended target for full-screen Chromium/browser launch
- Service units and kiosk helpers live in `scripts/`

### Pi Zero
- Supported as a low-power lite deployment target
- Lite-only routing is enforced automatically by device detection

## Capabilities

### Tracking and pass operations
- Live satellite tracks from the current observer location
- Pass prediction for amateur satellites, with ISS-only or favorites-based filtering
- Track-path sampling for sky/compass views and pass previews
- Amateur-satellite catalog filtering with cached fallback data

### Radio and operational data
- RF metadata merged from cached catalog data and source refreshes
- AMSAT operational-status comparison cached from `amsat.org/status`
- ISS visibility and stream-eligibility state, including telemetry-only mode

### Location and settings
- Manual location profiles
- Browser geolocation
- GPS configuration for USB or Bluetooth receivers
- Persisted settings for ISS display mode, tracked satellite selection, timezone, pass filter/favorites, cache policy, and developer overrides
- The kiosk settings screen exposes display mode, tracked satellite selection, pass filters, location-source inputs, timezone, video source overrides, and direct navigation back to the kiosk or rotator view

### UI surfaces
- Main kiosk screen for large displays
- Rotator/operator screen for tracking-focused presentation, including the pass globe/hemisphere view and radio-ops telemetry layout
- Lite/mobile screen optimized for remote use on phones and low-powered devices
- Lite offline shell/API caching with stale snapshot fallback behavior

### Developer mode
- Kiosk developer overrides are available for debugging and demo control of the rotator
- Current override support includes enabling debug mode and forcing a specific rotator scene

## Quick Start

### macOS quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 scripts/run_tracker.py --mode windowed --ui kiosk --host 127.0.0.1 --port 8000
```

Open:
- Kiosk UI: [http://127.0.0.1:8000/](http://127.0.0.1:8000/)
- Lite UI: [http://127.0.0.1:8000/lite](http://127.0.0.1:8000/lite)
- Rotator UI: [http://127.0.0.1:8000/kiosk-rotator](http://127.0.0.1:8000/kiosk-rotator)
- Settings UI: [http://127.0.0.1:8000/settings](http://127.0.0.1:8000/settings)
- API docs: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)

What to expect on macOS:
- the FastAPI app server runs normally
- the launcher opens a windowed browser session
- the web UIs and API docs are usable for local development
- this is the tested desktop workflow for the project

### Raspberry Pi quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 scripts/run_tracker.py --mode kiosk --ui kiosk --host 0.0.0.0 --port 8000
```

Open from another device on your network:
- Kiosk UI: `http://<pi-ip>:8000/`
- Lite UI: `http://<pi-ip>:8000/lite`
- Rotator UI: `http://<pi-ip>:8000/kiosk-rotator`
- API docs: `http://<pi-ip>:8000/docs`

### Direct `uvicorn` alternative

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Use the launcher when you want browser-open behavior. Use direct `uvicorn` when you only want the server.

## API Map

OrbitDeck exposes a broader API than the UI uses directly. Full schema details are available at `/docs`.

### UI routes
- `/` main kiosk UI
- `/lite` lite/mobile UI
- `/settings` kiosk settings UI, or lite on Pi Zero-class devices
- `/kiosk-rotator` rotator/operator UI, or lite on Pi Zero-class devices

### Health and system state
- `GET /health`
- `GET /api/v1/system/state`

### Tracking and catalog data
- `GET /api/v1/satellites`
- `GET /api/v1/live`
- `GET /api/v1/passes`
- `GET /api/v1/track/path`
- `GET /api/v1/iss/state`

### Settings and configuration
- `GET/POST /api/v1/settings/iss-display-mode`
- `GET/POST /api/v1/settings/timezone`
- `GET/POST /api/v1/settings/developer-overrides`
- `GET/POST /api/v1/settings/pass-filter`
- `GET/POST /api/v1/settings/gps`
- `GET/POST /api/v1/location`
- `GET/POST /api/v1/network`
- `GET/POST /api/v1/cache-policy`

### Refresh and history
- `POST /api/v1/datasets/refresh`
- `POST /api/v1/snapshots/record`

## Runtime Data and Caching

- `data/ephemeris/de421.bsp` is intentionally bundled so planetary/sky calculations work on first run
- `data/state.json` is created locally at runtime to persist settings and state
- `data/snapshots/*.json` are local cache artifacts created as the app refreshes or records data
- Satellite catalog refresh can use remote sources with cached fallback data
- AMSAT operational-status refresh is throttled to a minimum 12-hour interval
- Lite mode keeps a cached shell/API snapshot strategy for remote/mobile use when connectivity is unreliable

## Testing and Validation

Backend tests:

```bash
pytest -q
```

Optional frontend JS syntax checks:

```bash
node --check app/static/lite/lite.js
node --check app/static/lite/sw.js
node --check app/static/kiosk/kiosk.js
node --check app/static/kiosk/rotator.js
```

Validation status:
- OrbitDeck has been exercised on macOS in development mode
- macOS support is framed as desktop/windowed operation, not full kiosk deployment parity with Raspberry Pi
- Raspberry Pi remains the primary kiosk deployment target

## Notes

- OrbitDeck is receive-only: no CAT, PTT, rotor control, or transmit automation is included
- Pi service units and kiosk/network helpers are in `scripts/`:
  - `orbitdeck_api.service`
  - `pi_kiosk.service`
  - `network_fallback.sh`
- The rotator globe/hemisphere view depends on `app/static/common/hemisphere.js` and `app/static/common/hemisphere-land.js`
- The `references/` tree is design and research material, not a runtime dependency

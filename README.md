# OrbitDeck

OrbitDeck is a cross-platform amateur-satellite operations dashboard. It combines live tracking, pass prediction, RF metadata, APRS operation, ISS visibility/video state, and AMSAT operational-status comparison behind a FastAPI backend with multiple web UIs.

OrbitDeck currently supports:
- rotator/operator landing UI at `/`
- lite/mobile UI at `/lite`
- lite settings UI at `/lite/settings`
- APRS console at `/aprs`
- radio control UI at `/radio`
- rotator/operator UI at `/kiosk-rotator`
- settings-v2 UI at `/settings`

macOS is supported for local development and windowed use, and this project has been exercised on macOS in that mode. Raspberry Pi is the intended kiosk deployment target. On Pi Zero-class hardware, OrbitDeck automatically serves the lite UI instead of the full kiosk and rotator surfaces.

Detailed install/build/run instructions:
- [docs/INSTALL_AND_RUN.md](docs/INSTALL_AND_RUN.md)

Documentation site tooling:
- `mkdocs.yml` config at the repo root
- local docs build guide in [docs/local-build.md](docs/local-build.md)
- user and operator guides in `docs/guide/`

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
- Lite now uses a first-run tracked-satellite setup and a bounded tracked list of up to 8 satellites

## Capabilities

### Tracking and pass operations
- Live satellite tracks from the current observer location
- Pass prediction for amateur satellites, with ISS-only or favorites-based filtering in kiosk mode
- Lite mode uses a bounded tracked-satellite list of up to 8 satellites to limit CPU work on low-power hardware
- Track-path sampling for sky/compass views and pass previews
- Amateur-satellite catalog filtering with cached fallback data

### Radio and operational data
- RF metadata merged from cached catalog data and source refreshes
- Shared Doppler-aware frequency guidance across kiosk, rotator, and lite
- Frequency recommendations support FM and linear satellites, including phase-aware guide matrices for linear transponders
- APRS target resolution for terrestrial and satellite packet operation
- APRS local logging, packet history export, live heard-station summaries, and packet notifications
- APRS digipeater and RX-only iGate configuration backed by Dire Wolf
- IC-705 Wi-Fi APRS transport using native LAN CAT/PTT/audio control and local decode-only Dire Wolf receive
- Native Icom CI-V rig control for direct validation and pass-driven control workflows
- Dedicated `/radio` page for serial-port setup, connect/poll checks, manual VFO writes, and manual uplink/downlink pair testing
- Rotator-embedded radio-control sessions for selecting a pass, testing the default pair, arming before AOS, and tracking until LOS
- Current rig models in the persisted settings model: `id5100` and `ic705`
- Current live-validation milestone: IC-705 connect, poll, direct frequency write, and manual pair application
- AMSAT operational-status comparison cached from `amsat.org/status`
- ISS visibility and stream-eligibility state, including telemetry-only mode

### Location and settings
- Manual location profiles
- Browser geolocation
- GPS configuration for USB or Bluetooth receivers
- Persisted settings for ISS display mode, tracked satellite selection, timezone, pass filter/favorites, cache policy, APRS, radio, and developer overrides
- The standard settings route now serves the `settings-v2` console on non-lite hardware
- `settings-v2` groups overview, radio, location, tracking, display, APRS, and developer controls into one operator surface

### UI surfaces
- Rotator/operator screen for tracking-focused presentation, including the pass globe/hemisphere view and radio-ops telemetry layout
- Dedicated APRS console for target selection, send actions, log export, and Dire Wolf install/status checks
- Dedicated radio-control screen for rig validation and CI-V state inspection
- Lite/mobile screen optimized for remote use on phones and low-powered devices
- Separate lite settings screen for tracked satellites, focus, timezone, and location/GPS configuration
- Lite includes a first-run setup gate, a single focus-card sky compass, and selected-pass AOS cues for upcoming passes
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
- Rotator landing UI: [http://127.0.0.1:8000/](http://127.0.0.1:8000/)
- Lite UI: [http://127.0.0.1:8000/lite](http://127.0.0.1:8000/lite)
- Lite settings UI: [http://127.0.0.1:8000/lite/settings](http://127.0.0.1:8000/lite/settings)
- APRS console: [http://127.0.0.1:8000/aprs](http://127.0.0.1:8000/aprs)
- Radio control UI: [http://127.0.0.1:8000/radio](http://127.0.0.1:8000/radio)
- Rotator UI: [http://127.0.0.1:8000/kiosk-rotator](http://127.0.0.1:8000/kiosk-rotator)
- Settings-v2 UI: [http://127.0.0.1:8000/settings](http://127.0.0.1:8000/settings)
- API docs: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)

macOS validation:
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
- Rotator landing UI: `http://<pi-ip>:8000/`
- Lite UI: `http://<pi-ip>:8000/lite`
- APRS console: `http://<pi-ip>:8000/aprs`
- Radio control UI: `http://<pi-ip>:8000/radio`
- Rotator UI: `http://<pi-ip>:8000/kiosk-rotator`
- Settings-v2 UI: `http://<pi-ip>:8000/settings`
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
- `/` rotator/operator landing UI
- `/lite` lite/mobile UI
- `/lite/settings` lite settings UI
- `/aprs` APRS console
- `/radio` radio control UI
- `/settings` settings-v2 UI, or lite on Pi Zero-class devices
- `/settings-v2` redirect to `/settings`
- `/kiosk-rotator` rotator/operator UI, or lite on Pi Zero-class devices

### Health and system state
- `GET /health`
- `GET /api/v1/system/state`

### Tracking and catalog data
- `GET /api/v1/satellites`
- `GET /api/v1/live`
- `GET /api/v1/lite/snapshot`
- `GET /api/v1/passes`
- `GET /api/v1/track/path`
- `GET /api/v1/iss/state`
- `GET /api/v1/frequency-guides/recommendation`

### Settings and configuration
- `GET/POST /api/v1/settings/iss-display-mode`
- `GET/POST /api/v1/settings/lite`
- `GET/POST /api/v1/settings/timezone`
- `GET/POST /api/v1/settings/developer-overrides`
- `GET/POST /api/v1/settings/pass-filter`
- `GET/POST /api/v1/settings/gps`
- `GET/POST /api/v1/settings/radio`
- `GET/POST /api/v1/settings/aprs`
- `GET/POST /api/v1/location`
- `GET/POST /api/v1/network`
- `GET/POST /api/v1/cache-policy`

### APRS
- `GET /api/v1/aprs/state`
- `GET /api/v1/aprs/log/settings`
- `POST /api/v1/aprs/log/settings`
- `GET /api/v1/aprs/log`
- `POST /api/v1/aprs/log/clear`
- `GET /api/v1/aprs/log/export.csv`
- `GET /api/v1/aprs/log/export.json`
- `GET /api/v1/aprs/ports`
- `GET /api/v1/aprs/audio-devices`
- `GET /api/v1/aprs/direwolf/status`
- `POST /api/v1/aprs/direwolf/install`
- `POST /api/v1/aprs/direwolf/install-terminal`
- `GET /api/v1/aprs/targets`
- `POST /api/v1/aprs/select-target`
- `POST /api/v1/aprs/session/select`
- `POST /api/v1/aprs/connect`
- `POST /api/v1/aprs/disconnect`
- `POST /api/v1/aprs/panic-unkey`
- `POST /api/v1/aprs/send/message`
- `POST /api/v1/aprs/send/status`
- `POST /api/v1/aprs/send/position`

### Radio control
- `GET /api/v1/radio/state`
- `GET /api/v1/radio/ports`
- `GET /api/v1/radio/session`
- `POST /api/v1/radio/session/select`
- `POST /api/v1/radio/session/clear`
- `POST /api/v1/radio/connect`
- `POST /api/v1/radio/disconnect`
- `POST /api/v1/radio/poll`
- `POST /api/v1/radio/frequency`
- `POST /api/v1/radio/pair`
- `POST /api/v1/radio/session/test`
- `POST /api/v1/radio/session/test/confirm`
- `POST /api/v1/radio/session/start`
- `POST /api/v1/radio/session/stop`
- `POST /api/v1/radio/apply`
- `POST /api/v1/radio/auto-track/start`
- `POST /api/v1/radio/auto-track/stop`

### Refresh and history
- `POST /api/v1/passes/cache/refresh`
- `POST /api/v1/datasets/refresh`
- `POST /api/v1/snapshots/record`

## Runtime Data and Caching

- `data/ephemeris/de421.bsp` is intentionally bundled so planetary/sky calculations work on first run
- `data/state.json` is created locally at runtime to persist settings and state
- `data/snapshots/*.json` are local cache artifacts created as the app refreshes or records data
- `data/aprs/received_log.jsonl` is the local APRS receive log when APRS local logging is enabled
- Satellite catalog refresh can use remote sources with cached fallback data
- AMSAT operational-status refresh is throttled to a minimum 12-hour interval
- Lite mode keeps a cached shell/API snapshot strategy for remote/mobile use when connectivity is unreliable
- Lite snapshot requests are bounded to the configured tracked satellites instead of the full amateur catalog
- Pass predictions also maintain a persisted cache and can be invalidated with `POST /api/v1/passes/cache/refresh`

## Lite Mode Notes

- On first run, lite mode asks the user to select up to 8 tracked satellites before showing the dashboard
- `ISS (ZARYA)` is preselected by default, but the tracked list can be changed later from lite detailed settings
- Lite settings live at `/lite/settings` and expose tracked satellites, default focus, timezone, and location/GPS controls
- Tapping a pass or radio card loads that satellite into the lite focus card
- For upcoming selected passes, the lite compass shows an AOS cue until the pass begins, then switches to live az/el tracking

## Frequency Guidance

- OrbitDeck computes operator Doppler guidance across kiosk, rotator, and lite
- Kiosk, rotator, and lite all use the same backend frequency model
- FM-style satellites expose a single recommendation, while linear satellites can also expose a phase matrix across the pass
- The dedicated API entrypoint for this model is `GET /api/v1/frequency-guides/recommendation`
- The same recommendation model is reused by `/api/v1/radio/apply`, `/api/v1/radio/pair`, and the rotator radio-control session workflow

## Radio Control

- `/radio` is the direct rig-validation surface
- `/kiosk-rotator` is the pass-driven control surface
- `GET /api/v1/system/state` now includes `radioSettings`, `radioRuntime`, and `radioControlSession`
- Rotator radio control accepts recommendations that land inside VHF `144-148 MHz` or UHF `420-450 MHz`
- Receive-only downlink recommendations remain eligible when the downlink is inside the supported VHF/UHF range
- The IC-705 controller keeps `VFO A` and `VFO B` as absolute identities, rather than exposing selected/unselected reads as fixed labels

## APRS

- `/aprs` is the dedicated APRS console for connect, send, log, and export actions
- `/settings` now includes a full APRS section inside the `settings-v2` console
- APRS supports `terrestrial` and `satellite` operating modes
- Satellite APRS targets can expose Doppler-corrected UHF frequencies, active-pass state, and transmit gating
- Dire Wolf is used as the local decode/TNC sidecar in USB mode and as the decode-only receive sidecar in Wi-Fi APRS mode
- Wi-Fi APRS currently targets the IC-705 and uses LAN CAT/PTT/audio control with native Bell 202 AFSK TX generated inside OrbitDeck
- APRS local logging supports listing, clearing by age bucket, and CSV/JSON export
- Digipeater and RX-only iGate settings are part of the APRS settings model

## Testing and Validation

Backend tests:

```bash
pytest -q
```

Optional frontend JS syntax checks:

```bash
node --check app/static/lite/lite.js
node --check app/static/lite/sw.js
node --check app/static/kiosk/rotator.js
node --check app/static/kiosk/radio.js
node --check app/static/kiosk/aprs.js
node --check app/static/kiosk/settings-v2.js
```

Validation status:
- OrbitDeck has been exercised on macOS in development mode
- macOS support is framed as desktop/windowed operation, not full kiosk deployment parity with Raspberry Pi
- Raspberry Pi remains the primary kiosk deployment target

## Documentation Site

OrbitDeck also ships a MkDocs Material documentation site similar to the SPIMemory docs layout.

Local preview:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r docs/requirements.txt
mkdocs serve
```

Production build:

```bash
mkdocs build --strict
```

GitHub Pages publishing:

- source lives on `main`
- built output is published by GitHub Actions to the repository Pages site
- the generated `site/` directory is intentionally not committed

## Notes

- Pi service units and kiosk/network helpers are in `scripts/`:
  - `orbitdeck_api.service`
  - `pi_kiosk.service`
  - `network_fallback.sh`
- The rotator globe/hemisphere view depends on `app/static/common/hemisphere.js` and `app/static/common/hemisphere-land.js`
- The `references/` tree is design and research material, not a runtime dependency

# OrbitDeck Install / Build / Run Guide

OrbitDeck runs from one Python codebase across macOS and Raspberry Pi.

- macOS: supported for local development and windowed use, and tested in that mode
- Raspberry Pi: intended kiosk deployment target
- Pi Zero-class hardware: automatically serves lite mode instead of the full kiosk and rotator surfaces
- Standard UI surfaces on non-lite-only hardware: rotator landing (`/`), kiosk (`/kiosk`), lite (`/lite`), lite settings (`/lite/settings`), APRS (`/aprs`), radio control (`/radio`), rotator (`/kiosk-rotator`), and settings-v2 (`/settings`)

For the short version, start with the [docs home](index.md). This guide goes deeper on installation, operator setup, and deployment.

OrbitDeck also includes a MkDocs-based documentation site. For local docs preview and build commands, see [local-build.md](local-build.md).

## 1) Prerequisites

### macOS

- Python 3.11+
- any modern browser
- network access for fresh catalog and AMSAT refreshes
- a compatible serial device path if you are testing USB radio control
- a reachable IC-705 on the LAN if you are testing Wi-Fi radio or Wi‑Fi APRS transport

### Raspberry Pi

- Raspberry Pi OS Bookworm or similar Linux desktop environment
- Python 3.11+
- Chromium browser for kiosk mode
- network access for fresh catalog and AMSAT refreshes
- a compatible serial device path if you are testing USB radio control or USB APRS
- optional: GPS receiver and NetworkManager (`nmcli`) for AP fallback scripts

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
- APRS console: [http://127.0.0.1:8000/aprs](http://127.0.0.1:8000/aprs)
- Radio control UI: [http://127.0.0.1:8000/radio](http://127.0.0.1:8000/radio)
- Rotator UI: [http://127.0.0.1:8000/kiosk-rotator](http://127.0.0.1:8000/kiosk-rotator)
- Settings-v2 UI: [http://127.0.0.1:8000/settings](http://127.0.0.1:8000/settings)
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
- local use of the kiosk, lite, rotator, APRS, radio, and settings-v2 routes
- API docs and local test workflow

macOS is not the primary kiosk deployment target and does not replace Raspberry Pi kiosk/browser automation.

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
- APRS console: `http://<pi-ip>:8000/aprs`
- Radio control UI: `http://<pi-ip>:8000/radio`
- Rotator UI: `http://<pi-ip>:8000/kiosk-rotator`
- Settings-v2 UI: `http://<pi-ip>:8000/settings`
- API docs: `http://<pi-ip>:8000/docs`

Direct server-only alternative:

```bash
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### Pi Zero behavior

On Pi Zero-class hardware, OrbitDeck routes `/`, `/settings`, and `/kiosk-rotator` to the lite UI automatically. `/lite` and `/lite/settings` remain available directly on all hardware.

Lite behavior on low-power hardware:

- first run opens a setup gate before the dashboard
- the user chooses up to 8 tracked satellites
- lite requests only compute passes and live tracking for that bounded set
- tapping an upcoming pass loads an AOS cue into the lite focus compass

## 5) Radio control setup and validation

OrbitDeck includes a native Icom control path and a dedicated validation route at `/radio`.

### Supported rig models

- `ic705`
- `id5100`

Current validation status:

- IC-705 USB connect, poll, direct frequency write, and manual pair application have been live-validated
- IC-705 Wi-Fi CAT control is implemented through the network transport path
- ID-5100 support exists in the controller layer and settings model, but does not have the same live-validation depth as the IC-705 path

### Radio settings

Persisted radio settings live at `GET/POST /api/v1/settings/radio`.

Key fields:

- `rig_model`
- `transport_mode`
- `serial_device`
- `baud_rate`
- `civ_address`
- `wifi_host`
- `wifi_username`
- `wifi_password`
- `wifi_control_port`
- `poll_interval_ms`
- `auto_track_interval_ms`

### Direct validation workflow on `/radio`

Use `/radio` when you want to validate the rig link directly before relying on the rotator workflow.

Recommended sequence:

1. Open `/radio`.
2. Select the rig model and transport mode.
3. Enter the serial path or Wi-Fi host credentials.
4. Save settings.
5. Connect the rig.
6. Poll the rig and confirm that the runtime payload reports `connected: true`.
7. If you are using an IC-705, test a direct frequency write with `POST /api/v1/radio/frequency`.
8. Test a manual pair with `POST /api/v1/radio/pair`.

### Rotator-driven workflow

Use the rotator radio-control flow when you want OrbitDeck to manage a selected pass rather than a one-off manual test.

The workflow is:

1. Open `/kiosk-rotator`.
2. Select a pass with `Go to Radio Control`.
3. Connect the rig if needed.
4. Run the default-pair test for that pass.
5. Confirm the test if the rig state is correct.
6. Start or arm control for the pass.
7. Stop control manually, or let the session end automatically after LOS.

### Eligibility rule

The pass-driven rotator radio-control flow currently accepts recommendations that land inside:

- VHF: `144.000 MHz` to `148.000 MHz`
- UHF: `420.000 MHz` to `450.000 MHz`

Receive-only downlink recommendations remain eligible when the downlink is inside the supported range.

## 6) APRS setup and validation

OrbitDeck includes a dedicated APRS console at `/aprs` plus an APRS section inside the standard `settings-v2` surface at `/settings`.

### APRS operating modes

- `terrestrial`
- `satellite`

Terrestrial mode uses a local or region-derived APRS frequency and standard terrestrial path defaults.

Satellite mode uses a selected APRS-capable satellite/channel target and can expose:

- pass timing
- active transmit gating
- Doppler-corrected UHF tuning
- target-specific path defaults such as `ARISS`

### APRS settings

Persisted APRS settings live at `GET/POST /api/v1/settings/aprs`.

Key areas:

- station callsign and SSID
- operating mode
- terrestrial and satellite beacon comments
- path defaults
- audio input and output devices
- KISS host and port
- Dire Wolf binary path
- position fudge offsets
- local logging settings
- digipeater settings
- iGate settings
- selected APRS target

### APRS console workflow on `/aprs`

Use `/aprs` when you want the direct APRS test surface.

Recommended sequence:

1. Set station callsign and SSID.
2. Choose `terrestrial` or `satellite` mode.
3. Select a target or save a terrestrial frequency.
4. Save settings.
5. Connect APRS.
6. Verify runtime state, target summary, and heard-packet feed.
7. Send a test message, status, or position packet.
8. Disconnect cleanly, or use `Panic Unkey` if the sidecar or PTT path does not release as expected.

### Dire Wolf integration

OrbitDeck exposes:

- `GET /api/v1/aprs/direwolf/status`
- `POST /api/v1/aprs/direwolf/install`
- `POST /api/v1/aprs/direwolf/install-terminal`

Behaviour:

- USB APRS uses Dire Wolf as the local TNC/decoder path
- Wi-Fi APRS uses Dire Wolf in decode-only network-audio mode for receive, while OrbitDeck generates Bell 202 AFSK transmit audio itself
- OrbitDeck can launch a Homebrew-backed install flow for Dire Wolf on macOS when the binary is missing

### APRS logging, digipeater, and iGate

APRS local logging and gateway settings are first-class persisted features.

Available behaviors:

- local JSONL packet logging under `data/aprs/received_log.jsonl`
- CSV and JSON export
- clear-by-age-bucket cleanup
- heard-station summaries and recent packet feed
- digipeater policy controls
- RX-only iGate settings with optional auto-enable when internet is available

Policy notes:

- digipeater mode is disabled by policy for satellite APRS targets
- iGate can remain enabled for receive when policy allows it

### IC-705 Wi‑Fi APRS notes

Current live-validated Wi-Fi APRS path targets the IC-705.

Notes:

- OrbitDeck uses Wi-Fi CAT/PTT/audio transport rather than local OS audio devices in Wi-Fi mode
- APRS Wi-Fi runtime reports:
  - `transport_mode = wifi`
  - `control_endpoint`
  - `modem_state = direwolf-rx + native-afsk-tx`
- OrbitDeck snapshots and restores the previous radio state on APRS disconnect and on Wi-Fi APRS setup failure
- APRS Wi-Fi uses native Bell 202 AFSK TX generated inside OrbitDeck
- Wi-Fi APRS expects the radio to be in a compatible saved data profile before connect

## 7) Raspberry Pi production install with systemd

These steps set up the API and kiosk browser for boot-time startup.

### 7.1 Install the app under `/opt/orbitdeck`

```bash
sudo mkdir -p /opt/orbitdeck
sudo chown -R $USER:$USER /opt/orbitdeck
rsync -av --delete ./ /opt/orbitdeck/
cd /opt/orbitdeck
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
```

### 7.2 Install systemd units

```bash
sudo cp scripts/orbitdeck_api.service /etc/systemd/system/
sudo cp scripts/pi_kiosk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable orbitdeck_api.service
sudo systemctl enable pi_kiosk.service
sudo systemctl start orbitdeck_api.service
sudo systemctl start pi_kiosk.service
```

### 7.3 Check service health

```bash
sudo systemctl status orbitdeck_api.service --no-pager
sudo systemctl status pi_kiosk.service --no-pager
curl http://localhost:8000/health
```

## 8) Optional AP fallback networking

A helper script is included: `scripts/network_fallback.sh`

- It tries known Wi-Fi profiles first
- If none connect, it activates AP profile `OrbitDeck-AP`

Run manually:

```bash
bash scripts/network_fallback.sh
```

## 9) Data refresh and runtime files

OrbitDeck uses both bundled assets and runtime-generated local state:

- `data/ephemeris/de421.bsp`
  - bundled intentionally
  - used for sky/body calculations on first run
- `data/state.json`
  - created locally at runtime
  - stores persisted settings/state
- `data/snapshots/*.json`
  - created locally at runtime
  - stores cached catalog and refresh metadata
- `data/aprs/received_log.jsonl`
  - created locally when APRS local logging is enabled
  - stores received APRS packet history for list/export/clear operations

Refresh behavior:

- `GET /api/v1/satellites?refresh_from_sources=true`
  - attempts to pull fresh CelesTrak and SatNOGS data
  - also tries ephemeris and AMSAT status refresh where allowed
- `GET /api/v1/lite/snapshot`
  - returns the bounded lite dashboard snapshot
  - computes only the configured tracked satellites plus ISS state when needed
- `GET /api/v1/frequency-guides/recommendation`
  - returns Doppler-aware operator guidance for a single satellite
- `POST /api/v1/passes/cache/refresh`
  - clears the persisted pass-prediction cache
- `POST /api/v1/datasets/refresh`
  - triggers the manual refresh flow

AMSAT refresh is throttled to a minimum 12-hour interval.

## 10) API and route quick reference

UI routes:

- `/`
- `/kiosk`
- `/lite`
- `/lite/settings`
- `/aprs`
- `/radio`
- `/settings`
- `/settings-v2`
- `/internal/settings-legacy`
- `/kiosk-rotator`

Standard settings surface:

- `/settings` now serves the `settings-v2` console on standard hardware
- `settings-v2` groups overview, radio, location, tracking, display, APRS, and developer sections in one page
- `/settings-v2` redirects to `/settings`

APRS UI:

- `/aprs` is the direct APRS console
- `/settings` also includes a denser APRS section with send tools, live heard packets, local log controls, digipeater and iGate settings, and stored-log export actions

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
- `GET/POST /api/v1/settings/radio`
- `GET/POST /api/v1/settings/aprs`
- `GET/POST /api/v1/location`
- `GET/POST /api/v1/network`
- `GET/POST /api/v1/cache-policy`

APRS APIs:

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

Radio APIs:

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

## 11) Test

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
node --check app/static/kiosk/radio.js
node --check app/static/kiosk/aprs.js
node --check app/static/kiosk/settings-v2.js
```

## 12) Notes

- The rotator globe/hemisphere view depends on `app/static/common/hemisphere.js` and `app/static/common/hemisphere-land.js`
- Kiosk, rotator, lite, radio control, and APRS satellite targets all use the shared Doppler/frequency-guidance backend model where applicable
- `settings-v2` is the standard non-lite settings surface; the older settings page remains under `/internal/settings-legacy`
- The `references/` tree is design and research material, not a runtime dependency
- When README changes alter run/support guidance, this guide should be updated in the same change

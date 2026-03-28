# OrbitDeck Install / Build / Run Guide

OrbitDeck runs from one Python codebase on both macOS and Raspberry Pi. macOS is the supported desktop development and windowed-use environment. Raspberry Pi is the intended kiosk deployment target. Pi Zero-class hardware automatically falls back to the lite-oriented routes instead of trying to run the full rotator experience.

If you only need the short version, start from the docs home. This page is the longer operator and maintainer guide.

## 1) Prerequisites

On macOS, you need Python 3.11 or newer, a modern browser, network access if you want live catalog or AMSAT refreshes, and the right device path or LAN reachability if you plan to test radio features. For USB radio work that means a valid serial device path. For IC-705 Wi-Fi radio or Wi-Fi APRS work that means the radio must be reachable on the LAN.

On Raspberry Pi, use a current Raspberry Pi OS desktop environment such as Bookworm, Python 3.11 or newer, and Chromium for kiosk mode. Network access is still needed for fresh remote data. USB radio or USB APRS testing needs the matching serial device path. GPS hardware and `nmcli` are optional unless you want Pi GPS or the fallback networking scripts.

## 2) Release artifacts

OrbitDeck now has two release artifact targets:

- macOS: unsigned `OrbitDeck-<version>-macos-arm64.dmg`
- Raspberry Pi: `orbitdeck_<version>_arm64.deb`

The GitHub release workflow builds these artifacts from version tags such as `v0.1.0`.

## 3) Clone and install from source

```bash
git clone <your-repo-url> orbitdeck
cd orbitdeck
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
```

## 4) Install the macOS app from the DMG

1. Download the matching `OrbitDeck-<version>-macos-arm64.dmg` asset from GitHub Releases.
2. Open the DMG and drag `OrbitDeck.app` into `Applications`.
3. Launch `OrbitDeck.app`.

OrbitDeck for macOS is intentionally unsigned for now. If macOS blocks the first launch:

1. try to open the app once
2. open `System Settings > Privacy & Security`
3. click `Open Anyway`

The packaged macOS app runs OrbitDeck in its own native window rather than opening the default browser.

### macOS packaged-app dependency notes

- APRS support still depends on a separate `direwolf` install
- the packaged app detects whether `direwolf` is available and surfaces that state in `/aprs`
- the packaged app does not attempt an in-app Homebrew installation flow
- non-APRS surfaces remain usable when `direwolf` is absent

## 5) Run on macOS from source

The normal desktop launcher flow is:

```bash
source .venv/bin/activate
python3 scripts/run_tracker.py --mode windowed --ui kiosk --host 127.0.0.1 --port 8000
```

That starts the FastAPI service and opens the browser window for you. From there, `/` is the main rotator landing view, `/lite` is the mobile-first lite surface, `/lite/settings` is the lite setup page, `/aprs` is the APRS console, `/radio` is the direct rig-validation screen, `/kiosk-rotator` is the pass-driven rotator surface, `/settings` is the combined settings console, and `/docs` is the live Swagger schema.

If you want to start directly into lite for a quick check, use:

```bash
python3 scripts/run_tracker.py --mode windowed --ui lite --host 127.0.0.1 --port 8000
```

If you only want the API server and do not want the launcher behavior, use:

```bash
source .venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The tested macOS flow covers FastAPI startup, launcher-driven browser opening, the main UI routes, the API docs, and the local test workflow. macOS is not meant to replace Raspberry Pi kiosk deployment.

## 6) Install the Raspberry Pi package

Install the Debian package from GitHub Releases on a Raspberry Pi OS `arm64` system:

```bash
sudo dpkg -i orbitdeck_<version>_arm64.deb
sudo apt-get install -f
sudo systemctl status orbitdeck.service
```

What the package does:

- installs OrbitDeck under `/opt/orbitdeck`
- creates `/opt/orbitdeck/.venv`
- installs vendored Python wheels into that venv without hitting PyPI
- installs and enables `orbitdeck.service`
- installs a Chromium kiosk autostart entry

Pi package runtime dependencies:

- `python3`
- `python3-venv`
- `direwolf`
- `chromium-browser` or `chromium`

Current package target:

- Raspberry Pi OS `arm64`
- Python `3.11.x`

Package behavior notes:

- the main API runs as `orbitdeck.service`
- Chromium kiosk mode opens `http://127.0.0.1:8000/` on login
- APRS remains explicitly dependent on `direwolf`
- radio and tracking surfaces continue to work even if APRS-specific tooling is unavailable or misconfigured

Upgrade and removal:

```bash
sudo dpkg -i orbitdeck_<new-version>_arm64.deb
sudo dpkg -r orbitdeck
```

## 7) Run on Raspberry Pi from source

For a local kiosk-style run:

```bash
source .venv/bin/activate
python3 scripts/run_tracker.py --mode kiosk --ui kiosk --host 0.0.0.0 --port 8000
```

From another device on the same network, open `http://<pi-ip>:8000/` for the main landing view. The same host also serves `/lite`, `/aprs`, `/radio`, `/kiosk-rotator`, `/settings`, and `/docs`.

If you only want the server process and not the launcher behavior, use:

```bash
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### Pi Zero behavior

On Pi Zero-class hardware, OrbitDeck routes `/`, `/settings`, and `/kiosk-rotator` to the lite UI automatically. `/lite` and `/lite/settings` still exist directly on all hardware classes.

The reason is compute budget. Lite opens with a setup gate, asks the operator to choose a tracked set of up to 5 satellites, and keeps pass prediction and live tracking bounded to that saved set. When the user taps an upcoming pass, lite loads an AOS cue into the focus compass rather than trying to act like the full kiosk.

## 8) Radio control setup and validation

OrbitDeck includes a native Icom control path and a dedicated validation page at `/radio`. The persisted settings model currently includes `ic705` and `id5100`. The IC-705 path has live validation for connect, poll, direct frequency write, and manual pair application. The ID-5100 path exists in the controller layer and settings model but does not yet have the same depth of live confirmation.

Radio settings are stored at `GET/POST /api/v1/settings/radio`. In practice, the important fields are the rig model, transport mode, serial device, baud rate, CI-V address, and the IC-705 Wi-Fi host and credentials when LAN control is in use.

### Direct validation on `/radio`

Use `/radio` when you want to prove the rig link first and only worry about pass workflows later. Save the settings, connect the rig, poll it, and confirm the runtime reports a real connected state with usable VFO readback. If you are validating an IC-705, follow that with a direct frequency write through `POST /api/v1/radio/frequency` and then a manual pair apply through `POST /api/v1/radio/pair`.

If the selected transport is IC-705 Wi-Fi, OrbitDeck now performs a short reachability preflight against the configured `wifi_host` before attempting the handshake. That gives you an immediate network error when the radio IP is unreachable instead of a slower, less obvious control failure.

### Pass-driven control on `/kiosk-rotator`

Use `/kiosk-rotator` when you want OrbitDeck to stay attached to one selected pass rather than doing one-off manual testing. Select a pass with `Go to Radio Control`, connect if needed, run the default-pair test, confirm the test if the rig state is correct, and then arm or start control for the pass. OrbitDeck can wait through AOS and release at LOS.

The current pass-driven workflow accepts recommendations inside VHF `144.000 MHz` to `148.000 MHz` and UHF `420.000 MHz` to `450.000 MHz`. Receive-only downlink recommendations are still allowed when the downlink itself is inside the supported range.

The radio APIs you will touch most often in that workflow are `POST /api/v1/radio/frequency`, `POST /api/v1/radio/pair`, `POST /api/v1/radio/session/select`, `POST /api/v1/radio/session/test-pair`, `POST /api/v1/radio/session/test`, `POST /api/v1/radio/session/start`, and `POST /api/v1/radio/session/stop`.

## 9) APRS setup and validation

OrbitDeck has a dedicated APRS console at `/aprs` and a full APRS section inside `/settings`. APRS supports `terrestrial` and `satellite` operating modes. Terrestrial mode uses a local or region-derived APRS frequency with the usual terrestrial path defaults. Satellite mode uses the selected APRS-capable satellite and channel and can expose pass state, transmit gating, and Doppler-corrected UHF tuning.

APRS settings live at `GET/POST /api/v1/settings/aprs`. The practical operator fields are the station callsign and SSID, the operating mode, path defaults, terrestrial or satellite comments, audio devices for USB mode, KISS settings, Dire Wolf path, position fudge settings, logging settings, gateway policy, and the selected APRS target.

### APRS console workflow

For normal APRS validation, save the station identity, choose `terrestrial` or `satellite`, save the target or terrestrial frequency, connect APRS, and then confirm the runtime, target summary, and heard-packet feed look correct before sending any traffic. Disconnect cleanly when you are done, or use `Stop TX` if the transport or sidecar does not release as expected.

### Dire Wolf and Wi-Fi APRS

OrbitDeck exposes Dire Wolf status and install routes through `GET /api/v1/aprs/direwolf/status`, `POST /api/v1/aprs/direwolf/install`, and `POST /api/v1/aprs/direwolf/install-terminal`. In USB APRS mode, Dire Wolf acts as the local TNC and decoder. In Wi-Fi APRS mode, OrbitDeck currently targets the IC-705, uses LAN CAT/PTT/audio transport, keeps Dire Wolf in decode-only network-audio receive mode, and generates Bell 202 AFSK transmit audio inside OrbitDeck itself.

Wi-Fi APRS expects the radio to already be in a compatible saved packet or data profile before you connect.

For packaged macOS builds, treat Dire Wolf as an external dependency. The packaged app reports whether it is present, but does not run the Homebrew installer flow itself.

### Logging, digipeater, and iGate

APRS logging is a first-class local feature. OrbitDeck can store received packets in `data/aprs/received_log.jsonl`, list them in the UI, export them as CSV or JSON, and clear them by age bucket. Digipeater and RX-only iGate policy are part of the persisted APRS settings model. Digipeater mode is intentionally disabled for satellite APRS targets, while iGate can remain enabled for receive when policy allows it.

## 10) Raspberry Pi production install with systemd

For a boot-time deployment, install the app into `/opt/orbitdeck`, create the virtual environment there, and install the Python requirements:

```bash
sudo mkdir -p /opt/orbitdeck
sudo chown -R $USER:$USER /opt/orbitdeck
rsync -av --delete ./ /opt/orbitdeck/
cd /opt/orbitdeck
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
```

Then install and enable the bundled systemd units:

```bash
sudo cp scripts/orbitdeck_api.service /etc/systemd/system/
sudo cp scripts/pi_kiosk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable orbitdeck_api.service
sudo systemctl enable pi_kiosk.service
sudo systemctl start orbitdeck_api.service
sudo systemctl start pi_kiosk.service
```

Check the result with:

```bash
sudo systemctl status orbitdeck_api.service --no-pager
sudo systemctl status pi_kiosk.service --no-pager
curl http://localhost:8000/health
```

## 8) Optional AP fallback networking

If you want the Pi to fall back to an access-point profile when no known Wi-Fi networks are available, use `scripts/network_fallback.sh`. It tries known Wi-Fi profiles first and then activates the `OrbitDeck-AP` profile if nothing else connects.

Run it manually with:

```bash
bash scripts/network_fallback.sh
```

## 9) Data refresh and runtime files

OrbitDeck ships `data/ephemeris/de421.bsp` intentionally so sky and body calculations work on first run. During normal operation it writes persisted app state to `data/state.json`, refresh metadata and cached external data to `data/snapshots/*.json`, and APRS receive history to `data/aprs/received_log.jsonl` when APRS logging is enabled.

Remote refresh behavior is split by source. `GET /api/v1/satellites?refresh_from_sources=true` can pull fresh catalog data and may also refresh ephemeris and AMSAT state when allowed. `POST /api/v1/datasets/refresh` triggers the manual refresh flow. `POST /api/v1/passes/cache/refresh` clears the persisted pass cache so the next pass request rebuilds it. AMSAT refresh remains guarded to a minimum 12-hour interval.

Lite uses `GET /api/v1/lite/snapshot` as its bounded dashboard payload. That route computes only the configured tracked satellites, plus ISS-related state when needed.

## 10) Route and API quick reference

The main UI routes are `/`, `/lite`, `/lite/settings`, `/aprs`, `/radio`, `/settings`, `/settings-v2`, and `/kiosk-rotator`. On standard hardware, `/settings` serves the combined settings console and `/settings-v2` is just the compatibility redirect. On Pi Zero-class hardware, `/settings` resolves to the lite settings screen instead.

The main system routes are `GET /health`, `GET /api/v1/system/state`, `GET /api/v1/satellites`, `GET /api/v1/live`, `GET /api/v1/lite/snapshot`, `GET /api/v1/passes`, `GET /api/v1/track/path`, `GET /api/v1/iss/state`, and `GET /api/v1/frequency-guides/recommendation`.

Settings and configuration live under `GET/POST /api/v1/settings/...` for ISS display mode, lite settings, timezone, developer overrides, pass filter, GPS, radio, APRS, and cache policy, plus `GET/POST /api/v1/location` and `GET/POST /api/v1/network`.

The APRS routes cover runtime state, local log settings and export, port and audio enumeration, Dire Wolf install/status, target selection, connect and disconnect, emergency stop, and the message, status, and position send actions.

The radio routes cover runtime state, port enumeration, connect and disconnect, polling, manual frequency writes, manual pair application, session selection, session test-pair updates, test and confirm flow, session start and stop, direct recommendation apply, and auto-track start and stop.

OrbitDeck also exposes `POST /api/v1/snapshots/record` for recording dataset snapshots used by the app’s own history and debugging workflows.

## 11) Testing

Backend tests:

```bash
source .venv/bin/activate
pytest -q
```

Optional frontend syntax checks:

```bash
node --check app/static/lite/lite.js
node --check app/static/lite/sw.js
node --check app/static/kiosk/rotator.js
node --check app/static/kiosk/radio.js
node --check app/static/kiosk/aprs.js
node --check app/static/kiosk/settings.js
```

## 12) Notes

The rotator globe and hemisphere view depend on `app/static/common/hemisphere.js` and `app/static/common/hemisphere-land.js`. The `references/` tree is for design and research context only; it is not a runtime dependency. When you change run or support guidance in the README, update this guide in the same change.

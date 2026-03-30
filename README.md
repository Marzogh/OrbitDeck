# OrbitDeck

[![CI](https://github.com/Marzogh/OrbitDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/Marzogh/OrbitDeck/actions/workflows/ci.yml)
[![Release](https://github.com/Marzogh/OrbitDeck/actions/workflows/release.yml/badge.svg)](https://github.com/Marzogh/OrbitDeck/actions/workflows/release.yml)
[![Docs](https://github.com/Marzogh/OrbitDeck/actions/workflows/docs.yml/badge.svg)](https://github.com/Marzogh/OrbitDeck/actions/workflows/docs.yml)
[![Latest Release](https://img.shields.io/github/v/release/Marzogh/OrbitDeck?display_name=tag)](https://github.com/Marzogh/OrbitDeck/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/Marzogh/OrbitDeck/blob/main/LICENSE)

OrbitDeck is a pass-operations dashboard for amateur satellite operators. It combines live tracking, Doppler-aware tuning guidance, APRS workflows, and direct rig control in one FastAPI service with desktop, kiosk, and lite mobile surfaces.

It is built for the moment when a pass is happening or about to happen: what is overhead, what should the rig be tuned to right now, is APRS ready, and which surface should the operator use on the hardware they actually have in front of them.

If you want the full install and run flow, use [docs/INSTALL_AND_RUN.md](docs/INSTALL_AND_RUN.md). The published documentation is at [chipsncode.com/OrbitDeck](https://chipsncode.com/OrbitDeck/), and local docs build notes are in [docs/local-build.md](docs/local-build.md). The project is licensed under [MIT](LICENSE).

## Screenshots

![OrbitDeck overview](docs/assets/orbitdeck-readme-hero.png)

## Features

- Live pass tracking with sky and hemisphere views for current and upcoming amateur-satellite passes
- Doppler-aware frequency guidance shared across the main rotator, lite mode, and direct API
- Mobile-first lite workflow for Pi Zero-class hardware and phone-sized operators
- Dedicated radio validation surface for CI-V serial and Wi-Fi rig workflows
- Dedicated APRS console for terrestrial and satellite APRS operation
- IC-705-focused LAN control path for radio and APRS workflows, with broader Icom CI-V support in progress
- Bounded lite tracking model that keeps low-power hardware usable by focusing on up to 5 tracked satellites
- Packaged operator-facing releases for macOS and Raspberry Pi alongside normal source-tree runs

## Choose Your Surface

| Route | Use it for | Best fit |
| --- | --- | --- |
| `/` | Main pass-operations view with live/next-pass context, tuning guidance, and rotator-centric workflow | Desktop, kiosk, standard hardware |
| `/kiosk-rotator` | Direct pass-driven radio-control session workflow | Kiosk and operator station use |
| `/lite` | Compact touch-friendly pass operations with bounded tracked satellites | Pi Zero, phone-sized screens, remote ops |
| `/radio` | Direct rig validation without needing a live pass | Radio setup and troubleshooting |
| `/aprs` | Dedicated APRS command and monitoring console | APRS validation and pass ops |
| `/settings` | Combined settings console for location, pass, radio, APRS, GPS, cache, and debug overrides | Initial setup and tuning |

On Pi Zero-class hardware, OrbitDeck automatically falls back to lite-oriented routes for `/`, `/settings`, and `/kiosk-rotator`.

## Quick Start

For a source-tree run on macOS:

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 scripts/run_tracker.py --mode windowed --ui kiosk --host 127.0.0.1 --port 8000
```

Then open:

- [http://127.0.0.1:8000/](http://127.0.0.1:8000/) for the main operations view
- [http://127.0.0.1:8000/lite](http://127.0.0.1:8000/lite) for lite mode
- [http://127.0.0.1:8000/radio](http://127.0.0.1:8000/radio) for rig validation
- [http://127.0.0.1:8000/aprs](http://127.0.0.1:8000/aprs) for APRS
- [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs) for the live API schema

For Raspberry Pi kiosk-style runs:

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 scripts/run_tracker.py --mode kiosk --ui kiosk --host 0.0.0.0 --port 8000
```

Then open the same routes through `http://<pi-ip>:8000/...` from another device on the network.

If you only want the API server and not the launcher behavior, run:

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## Platform Notes

OrbitDeck is exercised on macOS for local development and windowed use, and Raspberry Pi remains the intended kiosk target. Pi Zero-class systems are treated as low-power lite deployments rather than full kiosk hosts. Lite uses a first-run tracked-satellite setup and keeps its compute budget bounded to a saved list of up to 5 satellites.

## Core Workflows

### Track a pass

OrbitDeck tracks current and upcoming passes from the configured observer location, samples track paths for sky and hemisphere views, and can enrich the catalog with cached RF and AMSAT operational-status data. The main rotator surfaces are designed around "what matters during this pass" instead of raw catalog browsing.

### Tune a radio

OrbitDeck shares one Doppler-aware frequency model across lite, rotator, and the direct API. FM-style satellites resolve to a single working recommendation, while linear satellites can expose a phase-aware matrix. The current workflow accepts recommendations inside VHF `144-148 MHz` and UHF `420-450 MHz`, with receive-only downlink cases still allowed when the downlink is in range.

### Run APRS

OrbitDeck supports `terrestrial` and `satellite` APRS modes, pass-aware satellite APRS gating, local JSONL logging with CSV and JSON export, and gateway policy controls. In Wi-Fi APRS mode, OrbitDeck currently targets the IC-705 and uses LAN CAT/PTT/audio control with `direwolf-rx + native-afsk-tx`.

### Operate on constrained hardware

Lite is the mobile-first and Pi Zero-safe operating surface. On first run it asks the operator to choose a tracked set of up to 5 satellites, with `ISS (ZARYA)` preselected when available. The lite dashboard keeps a single focused pass/ops card, uses cached shell and snapshot fallback behavior when connectivity is poor, and can surface both radio-control readiness and APRS target state for the currently focused pass.

## Radio Control

`/radio` is the direct rig-validation surface. It exists for checking serial or Wi-Fi connectivity, polling CI-V state, writing manual frequencies, and applying manual pairs without needing a live pass.

`/kiosk-rotator` is the pass-driven control surface, where OrbitDeck can pin a selected pass into a radio-control session, test the default pair, arm before AOS, and track through LOS. For IC-705 Wi-Fi control, OrbitDeck performs a short reachability preflight against the configured `wifi_host` before trying the control handshake.

## APRS

`/aprs` is the dedicated APRS console, while `/settings` includes the same APRS configuration inside the combined settings surface. OrbitDeck supports terrestrial and satellite APRS operation, local packet logging, export, digipeater and RX-only iGate policy, and pass-aware target selection for satellite work.

## Settings and Runtime Model

The main settings model covers ISS display behavior, pass preferences, timezone, location, GPS configuration, radio configuration, APRS configuration, cache policy, and developer overrides. On standard hardware, `/settings` serves the consolidated settings console rather than a separate legacy settings page.

Developer overrides remain part of the operator model for rotator debugging and demo control. That currently includes enabling debug mode and forcing specific rotator scenes or related preview behavior.

OrbitDeck ships `data/ephemeris/de421.bsp` so sky and body calculations work on first run. In source-tree runs it writes local state to `data/state.json`, cached refresh artifacts under `data/snapshots/`, and APRS receive history to `data/aprs/received_log.jsonl` when APRS logging is enabled. In packaged runs, writable state moves to the platform app-data location, such as `~/Library/Application Support/OrbitDeck/data/` on macOS. Lite also keeps client-side cache state in the browser so the mobile surface can reopen cleanly when the Pi or network is briefly unavailable.

## Installation Options

If you would rather install a packaged build than run from source, OrbitDeck currently comes in two forms:

- macOS: unsigned `OrbitDeck-<version>-macos-arm64.dmg`
- Raspberry Pi: `orbitdeck_<version>_arm64.deb`

The macOS app is intentionally unsigned for now. On first launch, macOS may block it. The supported bypass is:

1. attempt to open the installed app
2. open `System Settings > Privacy & Security`
3. click `Open Anyway`

The packaged macOS app runs OrbitDeck inside its own native window. It does not rely on the default browser. If `direwolf` is missing, APRS surfaces stay available, report that Dire Wolf must be installed separately, and can launch an explicit guided Terminal install flow for Homebrew plus Dire Wolf when the operator chooses it.

The Raspberry Pi `.deb` installs OrbitDeck under `/opt/orbitdeck`, enables the API service, and installs a Chromium kiosk autostart entry. Right now that package is published as a GitHub Releases artifact, not through a Raspberry Pi `apt` repository. The package expects these runtime dependencies on the target system:

- `python3`
- `python3-venv`
- `direwolf`
- `chromium-browser` or `chromium`

The current `.deb` build targets `arm64` Raspberry Pi OS systems with Python `3.11.x`.

## Packaging Builds

Local packaging commands:

```bash
python3 -m pip install -r requirements-packaging.txt
./scripts/build_dmg.sh 0.1.0
./scripts/build_deb.sh 0.1.0
```

GitHub release automation:

- pushing a tag like `v0.1.0` triggers the release workflow
- GitHub Actions builds the macOS `.dmg` and Raspberry Pi `.deb`
- the workflow attaches both artifacts to the GitHub release for that tag

## API Summary

OrbitDeck exposes a wider API than the web UI uses directly. The live contract is always at `/docs`, but the main groups are:

- system and health: `GET /health`, `GET /api/v1/system/state`
- tracking and prediction: `GET /api/v1/satellites`, `GET /api/v1/live`, `GET /api/v1/passes`, `GET /api/v1/track/path`, `GET /api/v1/lite/snapshot`, `GET /api/v1/frequency-guides/recommendation`
- settings: `GET/POST /api/v1/settings/lite`, `.../timezone`, `.../gps`, `.../radio`, `.../aprs`, `.../pass-filter`, `.../developer-overrides`
- APRS control: `POST /api/v1/aprs/connect`, `.../disconnect`, `.../emergency-stop`, `.../select-target`, `.../session/select`, plus send and log routes
- radio control: `POST /api/v1/radio/connect`, `.../disconnect`, `.../poll`, `.../frequency`, `.../pair`, `.../session/select`, `.../session/test-pair`, `.../session/test`, `.../session/start`, `.../session/stop`

## Validation

Backend tests run with:

```bash
pytest -q
```

Useful frontend syntax checks are:

```bash
node --check app/static/lite/lite.js
node --check app/static/lite/sw.js
node --check app/static/kiosk/rotator.js
node --check app/static/kiosk/radio.js
node --check app/static/kiosk/aprs.js
node --check app/static/kiosk/settings.js
```

## Documentation

OrbitDeck also ships a MkDocs documentation site. The published docs are at [chipsncode.com/OrbitDeck](https://chipsncode.com/OrbitDeck/). The source lives under `docs/`, the config is `mkdocs.yml`, and the local build notes are in [docs/local-build.md](docs/local-build.md). The generated `site/` output is intentionally not committed.

Pi service units and kiosk or networking helpers live in `scripts/`, including `orbitdeck_api.service`, `pi_kiosk.service`, and `network_fallback.sh`. The hemisphere and globe view depends on `app/static/common/hemisphere.js` and `app/static/common/hemisphere-land.js`. Most of the `references/` tree remains design and research material, but packaged radio-control builds now also depend on `references/icom-lan/src` at runtime for the current IC-705 LAN control path.

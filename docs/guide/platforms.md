# Platforms

## macOS

macOS is a supported OrbitDeck runtime for:

- local development
- browser-launched windowed use
- API inspection through FastAPI docs
- local test execution

What has been exercised on macOS:

- FastAPI startup
- launcher-driven browser opening
- the kiosk, rotator, lite, and settings routes
- the local pytest workflow

What macOS is not positioned as:

- the primary kiosk deployment target
- a replacement for Raspberry Pi boot-time kiosk/browser automation

## Raspberry Pi

Raspberry Pi is the intended kiosk target. The repo includes:

- `scripts/run_tracker.py` for launcher behavior
- `scripts/orbitdeck_api.service` for the API service
- `scripts/pi_kiosk.service` for kiosk browser startup
- `scripts/network_fallback.sh` for AP fallback behavior

## Pi Zero

Pi Zero-class hardware uses automatic lite-only routing.

In practice that means:

- `/` resolves to lite instead of the full rotator landing experience
- `/settings` resolves to lite settings instead of kiosk settings
- `/kiosk-rotator` resolves to lite
- the bounded lite tracked-satellite workflow is used to keep compute load down

The detection can be overridden for testing with `ISS_TRACKER_DEVICE_CLASS=pi-zero` or `ISS_TRACKER_DEVICE_CLASS=standard`.

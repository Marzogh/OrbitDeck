# Common Tasks

This page is for everyday tasks once OrbitDeck is already running.

## Check whether a satellite is worth watching

Use one of these:

- `/lite` if you are on a phone or Pi Zero
- `/` if you want the focused tracking view
- `/api/v1/satellites` if you want the raw metadata

What to look for:

- amateur-radio capability
- repeater/transponder metadata
- AMSAT operational status summary

AMSAT summaries are grouped as:

- `active`
- `telemetry_only`
- `inactive`
- `conflicting`
- `unknown`

## Follow an upcoming pass

### Lite

1. Open `/lite`.
2. Tap the pass card.
3. The focus card becomes the working view.
4. Watch the AOS cue and then the live skyplot as the pass starts.

### Rotator

1. Open `/`.
2. Use the focused layout to follow the active or upcoming pass.
3. Read the hemisphere view and frequency guidance together.

## Change the observer location

### Fastest options

- use browser geolocation from lite settings
- enter manual coordinates
- set GPS mode for a Pi-connected USB or Bluetooth receiver

### Relevant APIs

- `POST /api/v1/location`
- `POST /api/v1/settings/gps`

## Refresh remote source data

If you want a manual data refresh instead of waiting for the normal background cycle:

- use `POST /api/v1/datasets/refresh`
- or call `GET /api/v1/satellites?refresh_from_sources=true`

What this can refresh:

- catalog metadata
- ephemeris, when refresh succeeds
- AMSAT status, when outside the 12-hour guard window

## Change which satellites lite tracks

Open `/lite/settings` and change the tracked set.

Important behavior:

- lite computes only the tracked satellites
- the API enforces a maximum of 8 tracked satellites
- if you remove the saved focus satellite from the list, lite clears that saved focus and falls back to automatic focus selection

## Change kiosk pass filtering

Open `/settings` and use the pass filter controls.

Profiles:

- `IssOnly`
- `Favorites`

This behavior is different from lite. Lite uses a small saved tracking list. Kiosk uses a pass filter.

## Inspect a Doppler recommendation directly

Use:

```bash
curl "http://127.0.0.1:8000/api/v1/frequency-guides/recommendation?sat_id=iss-zarya"
```

Use this when you want the raw recommendation without reading it through the UI.

## Record a dataset snapshot

If you want a snapshot entry stored in app state:

```bash
curl -X POST "http://127.0.0.1:8000/api/v1/snapshots/record?source=merged&satellite_count=42"
```

This is mostly useful for testing state persistence and cache history behavior.

# HTTP API

## UI routes

- `GET /`
- `GET /kiosk`
- `GET /lite`
- `GET /lite/settings`
- `GET /settings`
- `GET /kiosk-rotator`

## Health and state

- `GET /health`
- `GET /api/v1/system/state`

## Tracking and catalog routes

- `GET /api/v1/satellites`
- `GET /api/v1/live`
- `GET /api/v1/lite/snapshot`
- `GET /api/v1/passes`
- `GET /api/v1/track/path`
- `GET /api/v1/iss/state`

## Frequency guidance

- `GET /api/v1/frequency-guides/recommendation`

This route returns shared Doppler-aware operator guidance used by kiosk, rotator, and lite.

## Settings and configuration

- `GET/POST /api/v1/settings/iss-display-mode`
- `GET /api/v1/settings/timezones`
- `GET/POST /api/v1/settings/timezone`
- `GET/POST /api/v1/settings/developer-overrides`
- `GET/POST /api/v1/settings/pass-filter`
- `GET/POST /api/v1/settings/lite`
- `GET/POST /api/v1/settings/gps`
- `GET/POST /api/v1/location`
- `GET/POST /api/v1/network`
- `GET/POST /api/v1/cache-policy`

## Refresh and snapshots

- `POST /api/v1/datasets/refresh`
- `POST /api/v1/snapshots/record`

## Source-backed behavior

Remote data enrichment currently includes:

- catalog/radio metadata refreshes
- AMSAT operational-status comparison

AMSAT refreshes are intentionally throttled so the app does not poll the status source too aggressively.

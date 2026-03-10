# Runtime Data and Caching

OrbitDeck uses a mix of bundled assets and runtime-generated local data.

## Bundled

- `data/ephemeris/de421.bsp`

This file is intentionally shipped so planetary and sky calculations work on first run without waiting for a separate ephemeris download.

## Runtime-generated

- `data/state.json`
- `data/snapshots/*.json`

These files are created locally as OrbitDeck runs. They are cache and state artifacts, not source-controlled content for normal repo work.

## Refresh behavior

- catalog data can be refreshed from remote sources with cached fallback
- AMSAT operational-status data is cached under `data/snapshots/`
- AMSAT refreshes are guarded to a minimum 12-hour interval
- lite mode uses a bounded snapshot flow instead of full-catalog work

## Background timing

The backend refresh loop runs periodically in the background. Manual refreshes can happen sooner, but not every source is treated the same:

- catalog refreshes can happen on demand
- ephemeris refreshes are attempted opportunistically
- AMSAT status refreshes obey the 12-hour guard even when the user asks for more data immediately

## Browser-side lite caching

Lite also keeps client-side resilience for remote/mobile use:

- cached shell assets through the service worker
- a last-good snapshot in browser storage

That lets the phone reopen the dashboard even when the Pi or network is briefly unavailable.

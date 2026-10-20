# Runtime Data and Caching

OrbitDeck uses a mix of bundled assets and runtime-generated local data.

## Bundled

- `data/ephemeris/de421.bsp`

This file is intentionally shipped so planetary and sky calculations work on first run without waiting for a separate ephemeris download.

## Runtime-generated

- `data/state.json`
- `data/snapshots/*.json`
- `data/tx_auth.json`
- `data/tx_auth_secret`

These files are created locally as OrbitDeck runs. They are cache and state artifacts, not source-controlled content for normal repo work.

`tx_auth.json` contains the salted TX-PIN hash and revocation generation; it does not contain the original PIN. `tx_auth_secret` signs browser authorization cookies. OrbitDeck writes both files with owner-only permissions. In a packaged macOS install they live under `~/Library/Application Support/OrbitDeck/data/`.

If the TX PIN is lost, stop OrbitDeck, remove `tx_auth.json`, and start OrbitDeck again. The next TX unlock will return to first-time PIN setup. Removing `tx_auth_secret` also invalidates every existing browser authorization.

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

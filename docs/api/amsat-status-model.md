# AMSAT Status Model

This page documents the AMSAT status enrichment pipeline used by OrbitDeck.

## Source endpoints

OrbitDeck uses:

- `https://www.amsat.org/status/index.php`
- `https://www.amsat.org/status/api/v1/sat_info.php`

The index page is used to discover valid AMSAT status names. The API endpoint is then queried for report data by matched name.

## Cache files

AMSAT enrichment state is stored under `data/snapshots/`:

- `amsat_status.json`
- `amsat_status_refresh_meta.json`

## Refresh guard

AMSAT refreshes are guarded by `_amsat_refresh_guard()`.

Default minimum interval:

- 12 hours

If a refresh is attempted inside that window:

- cached AMSAT statuses are returned if available
- otherwise the refresh call raises a cooldown error

## Name discovery

The index HTML is scanned for option values matching the AMSAT naming pattern:

```text
NAME_[MODE]
```

The parser keeps unique values in discovery order.

## Satellite-to-AMSAT name matching

OrbitDeck does not assume that the local catalog name matches the AMSAT name directly.

The matching process:

1. normalize the OrbitDeck satellite name
2. normalize the AMSAT base name
3. compare compacted forms with punctuation and brackets removed
4. collect all candidate AMSAT names that appear to match
5. apply mode hints derived from local transponder/repeater text

Mode hints currently look for:

- `FM`
- `APRS`
- `DIGI`
- `SSTV`
- `DATV`
- `LINEAR`

If multiple AMSAT names match, the preferred mode hint is used to break the tie. If no better match exists, the first candidate is used.

ISS has a special fallback to an AMSAT `ISS_[FM]` entry if no normal match is found.

## Report summarization

Each AMSAT report is normalized into:

- report time
- callsign
- report text
- grid square

The summary logic then counts:

- `heard_count`
- `telemetry_only_count`
- `not_heard_count`

Summary derivation:

- both heard and not-heard reports present: `conflicting`
- heard reports present: `active`
- telemetry or beacon-only reports present: `telemetry_only`
- not-heard or no-signal reports present: `inactive`
- otherwise: `unknown`

The resulting `OperationalStatus` also stores:

- `matched_name`
- `latest_report`
- `reports_last_96h`
- `checked_at`
- `source_url`

## Where AMSAT status appears

AMSAT status is merged into the satellite catalog and then exposed through:

- `GET /api/v1/satellites`
- `GET /api/v1/lite/snapshot`
- kiosk and lite UI surfaces that display `operational_status`

## Refresh entry points

AMSAT enrichment can be updated through:

- background periodic refresh
- `GET /api/v1/satellites?refresh_from_sources=true`
- `POST /api/v1/datasets/refresh`

All of those still obey the 12-hour AMSAT refresh guard.

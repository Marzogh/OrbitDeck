# HTTP API

This page covers the main OrbitDeck routes with example requests, representative response payloads, and short field notes.

Use `/docs` on a running instance for the live OpenAPI schema.

## Base URL

Examples below assume a local server:

- <http://127.0.0.1:8000>

Replace that host and port as needed.

## UI routes

- [`GET /`](http://127.0.0.1:8000/)
- [`GET /kiosk`](http://127.0.0.1:8000/kiosk)
- [`GET /lite`](http://127.0.0.1:8000/lite)
- [`GET /lite/settings`](http://127.0.0.1:8000/lite/settings)
- [`GET /settings`](http://127.0.0.1:8000/settings)
- [`GET /kiosk-rotator`](http://127.0.0.1:8000/kiosk-rotator)

## Health

### `GET /health`

Example:

- [Open `/health`](http://127.0.0.1:8000/health)

Representative response:

```json
{
  "ok": true,
  "timestamp": "2026-03-11T10:15:00Z"
}
```

Interpretation:

- `ok` is the basic process liveness flag
- `timestamp` is the server-side UTC time of the response

## System state

### `GET /api/v1/system/state`

Example:

- [Open `/api/v1/system/state`](http://127.0.0.1:8000/api/v1/system/state)
- [Open `/api/v1/system/state?sat_id=fo29`](http://127.0.0.1:8000/api/v1/system/state?sat_id=fo29)

Representative response:

```json
{
  "timestamp": "2026-03-11T10:15:00Z",
  "location": {
    "source": "manual",
    "lat": -27.4698,
    "lon": 153.0251,
    "alt_m": 25.0
  },
  "settings": {
    "iss_display_mode": "SunlitAndVisibleVideo",
    "display_timezone": "Australia/Brisbane",
    "pass_profile": "IssOnly"
  },
  "iss": {
    "sunlit": true,
    "aboveHorizon": true,
    "mode": "SunlitAndVisibleVideo",
    "videoEligible": true,
    "streamHealthy": true,
    "activeStreamUrl": "https://www.youtube.com/embed/..."
  },
  "activeTrack": {
    "sat_id": "fo29",
    "name": "FO-29",
    "az_deg": 90.0,
    "el_deg": 25.0,
    "range_km": 900.0,
    "range_rate_km_s": -2.0,
    "sunlit": true
  },
  "activePass": {
    "sat_id": "fo29",
    "aos": "2026-03-11T10:12:00Z",
    "tca": "2026-03-11T10:15:00Z",
    "los": "2026-03-11T10:19:00Z",
    "max_el_deg": 62.0
  },
  "frequencyRecommendation": {
    "sat_id": "fo29",
    "mode": "linear",
    "phase": "mid",
    "label": "Tune now",
    "selected_column_index": 5
  },
  "frequencyMatrix": {
    "sat_id": "fo29",
    "mode": "linear",
    "selected_column_index": 5,
    "active_phase": "mid"
  }
}
```

Interpretation:

- `activeTrack` is the main live track chosen for the current screen state
- `activePass` is the matching current or next pass for that track
- `frequencyRecommendation` and `frequencyMatrix` are described in [Frequency Guidance](frequency-guidance-model.md)
- `bodies` may also be present when ephemeris and Skyfield body-position support are available

## Satellites

### `GET /api/v1/satellites`

Example:

- [Open `/api/v1/satellites`](http://127.0.0.1:8000/api/v1/satellites)
- [Open `/api/v1/satellites?refresh_from_sources=true`](http://127.0.0.1:8000/api/v1/satellites?refresh_from_sources=true)

Representative response:

```json
{
  "count": 2,
  "refreshed": false,
  "ephemerisRefreshed": false,
  "refreshError": null,
  "items": [
    {
      "sat_id": "iss-zarya",
      "norad_id": 25544,
      "name": "ISS (ZARYA)",
      "is_iss": true,
      "has_amateur_radio": true,
      "transponders": ["145.990 MHz downlink"],
      "repeaters": ["437.800 MHz APRS"],
      "operational_status": {
        "source": "amsat",
        "summary": "active",
        "matched_name": "ISS_[FM]"
      }
    }
  ]
}
```

Interpretation:

- `refreshed` reports whether the request performed a source refresh during this call
- `ephemerisRefreshed` reports whether ephemeris refresh succeeded during the same call
- `operational_status` is the AMSAT enrichment block described in [AMSAT Status](amsat-status-model.md)

## Live tracks

### `GET /api/v1/live`

Example:

- [Open `/api/v1/live`](http://127.0.0.1:8000/api/v1/live)

Representative response:

```json
{
  "timestamp": "2026-03-11T10:15:00Z",
  "location": {
    "source": "manual",
    "lat": -27.4698,
    "lon": 153.0251,
    "alt_m": 25.0
  },
  "count": 2,
  "items": [
    {
      "sat_id": "iss-zarya",
      "name": "ISS (ZARYA)",
      "timestamp": "2026-03-11T10:15:00Z",
      "az_deg": 45.0,
      "el_deg": 12.0,
      "range_km": 1200.0,
      "range_rate_km_s": -7.0,
      "sunlit": true
    }
  ]
}
```

Interpretation:

- each item is a single live track sample
- `range_rate_km_s` is reused by the frequency guidance model for Doppler correction

## Track path

### `GET /api/v1/track/path`

Example:

- [Open `/api/v1/track/path?sat_id=iss-zarya&minutes=5&step_seconds=60`](http://127.0.0.1:8000/api/v1/track/path?sat_id=iss-zarya&minutes=5&step_seconds=60)

Representative response:

```json
{
  "sat_id": "iss-zarya",
  "minutes": 5,
  "step_seconds": 60,
  "count": 6,
  "items": [
    {
      "sat_id": "iss-zarya",
      "timestamp": "2026-03-11T10:15:00Z",
      "az_deg": 45.0,
      "el_deg": 2.0,
      "range_km": 1200.0,
      "sunlit": true
    }
  ]
}
```

Interpretation:

- this route returns sampled path points, not a single live point
- the same kind of path data is reused by the lite focus card and by the frequency matrix phase sampling

## Pass predictions

### `GET /api/v1/passes`

Example:

- [Open `/api/v1/passes`](http://127.0.0.1:8000/api/v1/passes)
- [Open `/api/v1/passes?include_all_sats=true&include_ongoing=true`](http://127.0.0.1:8000/api/v1/passes?include_all_sats=true&include_ongoing=true)

Representative response:

```json
{
  "timestamp": "2026-03-11T10:15:00Z",
  "hours": 24,
  "min_max_el": 0.0,
  "count": 1,
  "items": [
    {
      "sat_id": "iss-zarya",
      "name": "ISS (ZARYA)",
      "aos": "2026-03-11T10:23:00Z",
      "tca": "2026-03-11T10:27:00Z",
      "los": "2026-03-11T10:32:00Z",
      "max_el_deg": 48.0,
      "frequencyRecommendation": {
        "sat_id": "iss-zarya",
        "mode": "fm",
        "phase": "aos",
        "downlink_mhz": 437.79
      },
      "frequencyMatrix": null
    }
  ]
}
```

Interpretation:

- `include_all_sats=true` bypasses kiosk pass-filter selection and evaluates the full catalog
- `include_ongoing=true` allows current passes into the result set
- every pass item may carry embedded frequency guidance when a profile exists for that satellite

## ISS state

### `GET /api/v1/iss/state`

Example:

- [Open `/api/v1/iss/state`](http://127.0.0.1:8000/api/v1/iss/state)

Representative response:

```json
{
  "timestamp": "2026-03-11T10:15:00Z",
  "issTrack": {
    "sat_id": "iss-zarya",
    "name": "ISS (ZARYA)",
    "az_deg": 45.0,
    "el_deg": 12.0,
    "sunlit": true
  },
  "state": {
    "sunlit": true,
    "aboveHorizon": true,
    "mode": "SunlitAndVisibleVideo",
    "videoEligible": true,
    "streamHealthy": true,
    "activeStreamUrl": "https://www.youtube.com/embed/..."
  }
}
```

Interpretation:

- `issTrack` is the live ISS sample
- `state` is the ISS-specific display and stream state derived from the configured ISS display mode plus track conditions

## Lite snapshot

### `GET /api/v1/lite/snapshot`

Example:

- [Open `/api/v1/lite/snapshot`](http://127.0.0.1:8000/api/v1/lite/snapshot)
- [Open `/api/v1/lite/snapshot?sat_id=iss-zarya`](http://127.0.0.1:8000/api/v1/lite/snapshot?sat_id=iss-zarya)

Representative response:

```json
{
  "timestamp": "2026-03-11T10:15:00Z",
  "trackedSatIds": ["iss-zarya", "fo29"],
  "tracks": [
    {
      "sat_id": "fo29",
      "az_deg": 180.0,
      "el_deg": 20.0,
      "range_rate_km_s": 0.0
    }
  ],
  "passes": [
    {
      "sat_id": "fo29",
      "aos": "2026-03-11T10:13:00Z",
      "los": "2026-03-11T10:17:00Z"
    }
  ],
  "focusSatId": "fo29",
  "focusPass": {
    "sat_id": "fo29",
    "max_el_deg": 65.0
  },
  "focusCue": {
    "type": "aos",
    "sat_id": "iss-zarya",
    "az_deg": 123.0,
    "el_deg": 5.0
  },
  "frequencyRecommendation": {
    "sat_id": "fo29",
    "mode": "linear",
    "selected_column_index": 5
  },
  "frequencyMatrix": {
    "sat_id": "fo29",
    "mode": "linear",
    "active_phase": "mid"
  }
}
```

Interpretation:

- `trackedSatIds` is the bounded lite set after backend validation
- `focusCue` is present for a future selected pass before AOS
- `frequencyRecommendation` and `frequencyMatrix` are embedded directly so the lite UI does not need extra frequency round-trips
- the backend cache key and invalidation rules are documented in [Lite Snapshot](lite-snapshot-model.md)

## Frequency guidance

### `GET /api/v1/frequency-guides/recommendation`

Example:

- [Open `/api/v1/frequency-guides/recommendation?sat_id=iss-zarya`](http://127.0.0.1:8000/api/v1/frequency-guides/recommendation?sat_id=iss-zarya)
- [Open `/api/v1/frequency-guides/recommendation?sat_id=fo29`](http://127.0.0.1:8000/api/v1/frequency-guides/recommendation?sat_id=fo29)

Representative response:

```json
{
  "timestamp": "2026-03-11T10:15:00Z",
  "sat_id": "iss-zarya",
  "pass": null,
  "track": {
    "sat_id": "iss-zarya",
    "range_rate_km_s": -7.0
  },
  "recommendation": {
    "sat_id": "iss-zarya",
    "mode": "fm",
    "phase": "aos",
    "label": "Reference",
    "correction_side": "uhf_only",
    "uplink_mhz": 145.99,
    "downlink_mhz": 437.79,
    "selected_column_index": null
  },
  "matrix": null
}
```

Interpretation:

- `range_rate_km_s` from the selected track drives Doppler correction
- `correction_side` tells which side of the link receives correction
- `matrix` is only present for linear profiles
- the derivation rules are documented in [Frequency Guidance](frequency-guidance-model.md)

## Location

### `GET /api/v1/location`

Example:

- [Open `/api/v1/location`](http://127.0.0.1:8000/api/v1/location)

Representative response:

```json
{
  "state": {
    "source_mode": "manual",
    "selected_profile_id": "home",
    "profiles": [
      {
        "id": "home",
        "name": "Home",
        "point": {
          "lat": -27.4698,
          "lon": 153.0251,
          "alt_m": 25.0
        }
      }
    ]
  },
  "resolved": {
    "source": "manual",
    "lat": -27.4698,
    "lon": 153.0251,
    "alt_m": 25.0
  }
}
```

### `POST /api/v1/location`

Example request:

```json
{
  "source_mode": "manual",
  "add_profile": {
    "id": "home",
    "name": "Home",
    "point": {
      "lat": -27.4698,
      "lon": 153.0251,
      "alt_m": 25
    }
  },
  "selected_profile_id": "home"
}
```

Interpretation:

- `state` is the stored location state
- `resolved` is the effective location currently used by the tracking layer

## Lite settings

### `GET /api/v1/settings/lite`

Example:

- [Open `/api/v1/settings/lite`](http://127.0.0.1:8000/api/v1/settings/lite)

Representative response:

```json
{
  "state": {
    "tracked_sat_ids": ["iss-zarya"],
    "setup_complete": false
  },
  "availableSatellites": [
    {
      "sat_id": "iss-zarya",
      "name": "ISS (ZARYA)"
    }
  ]
}
```

### `POST /api/v1/settings/lite`

Example request:

```json
{
  "tracked_sat_ids": ["fo29", "iss-zarya"],
  "setup_complete": true
}
```

Interpretation:

- duplicate IDs are removed during validation
- the request fails with HTTP 400 if more than 8 tracked IDs are supplied
- the saved list drives lite snapshot computation

## Developer overrides

### `GET /api/v1/settings/developer-overrides`

Example:

- [Open `/api/v1/settings/developer-overrides`](http://127.0.0.1:8000/api/v1/settings/developer-overrides)

Representative response:

```json
{
  "state": {
    "enabled": true,
    "force_scene": "ongoing",
    "force_sat_id": "iss-zarya",
    "simulate_pass_phase": "mid-pass",
    "force_iss_video_eligible": true,
    "force_iss_stream_healthy": true,
    "show_debug_badge": true
  }
}
```

Interpretation:

- these settings are primarily consumed by the kiosk rotator frontend
- scene meanings and phase handling are documented in [Device Routing and Debug Overrides](device-and-debug.md)

## GPS settings

### `GET /api/v1/settings/gps`

Example:

- [Open `/api/v1/settings/gps`](http://127.0.0.1:8000/api/v1/settings/gps)

Representative response:

```json
{
  "state": {
    "connection_mode": "bluetooth",
    "serial_device": "/dev/ttyUSB9",
    "baud_rate": 4800,
    "bluetooth_address": "AA:BB:CC:DD:EE:FF",
    "bluetooth_channel": 2
  }
}
```

Interpretation:

- these fields define GPS connection parameters only
- live GPS location still has to be written into location state by a separate process

## Refresh and snapshots

### `POST /api/v1/datasets/refresh`

Representative response:

```json
{
  "ok": true,
  "meta": {
    "count": 42,
    "sources": ["celestrak", "satnogs"]
  },
  "ephemeris": {
    "ok": true
  },
  "snapshot": {
    "source": "merged",
    "satellite_count": 42
  }
}
```

### `POST /api/v1/snapshots/record`

Example:

- [Open `/api/v1/snapshots/record?source=merged&satellite_count=42`](http://127.0.0.1:8000/api/v1/snapshots/record?source=merged&satellite_count=42)

Representative response:

```json
{
  "snapshot": {
    "id": "snap-1741700000",
    "source": "merged",
    "created_at": "2026-03-11T10:15:00Z",
    "satellite_count": 42
  },
  "total": 3
}
```

## Source-backed behavior

Remote data enrichment currently includes:

- catalog and radio metadata refreshes
- AMSAT operational-status comparison

AMSAT refreshes are subject to the 12-hour guard documented in [AMSAT Status](amsat-status-model.md).

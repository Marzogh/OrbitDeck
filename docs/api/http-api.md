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
- [`GET /aprs`](http://127.0.0.1:8000/aprs)
- [`GET /radio`](http://127.0.0.1:8000/radio)
- [`GET /settings`](http://127.0.0.1:8000/settings)
- [`GET /settings-v2`](http://127.0.0.1:8000/settings-v2)
- [`GET /internal/settings-legacy`](http://127.0.0.1:8000/internal/settings-legacy)
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
  },
  "radioSettings": {
    "rig_model": "ic705",
    "serial_device": "/dev/cu.usbmodem113201",
    "civ_address": "0xA4"
  },
  "radioRuntime": {
    "connected": true,
    "control_mode": "manual_applied",
    "active_sat_id": "fo29"
  },
  "radioControlSession": {
    "active": true,
    "screen_state": "active",
    "control_state": "tracking_active",
    "is_eligible": true
  },
  "aprsSettings": {
    "callsign": "VK4ABC",
    "operating_mode": "satellite",
    "selected_satellite_id": "iss-zarya"
  },
  "aprsRuntime": {
    "connected": true,
    "transport_mode": "wifi",
    "modem_state": "direwolf-rx + native-afsk-tx",
    "packets_rx": 12,
    "packets_tx": 2
  },
  "aprsPreviewTarget": {
    "operating_mode": "satellite",
    "sat_id": "iss-zarya",
    "label": "ISS APRS",
    "can_transmit": false,
    "tx_block_reason": "pass not active"
  },
  "stationIdentity": {
    "valid": true,
    "callsign": "VK4ABC-7"
  }
}
```

Interpretation:

- `activeTrack` is the main live track chosen for the current screen state
- `activePass` is the matching current or next pass for that track
- `frequencyRecommendation` and `frequencyMatrix` are described in [Frequency Guidance](frequency-guidance-model.md)
- `radioSettings`, `radioRuntime`, and `radioControlSession` are the live radio-control summary blocks reused by the rotator UI
- `aprsSettings`, `aprsRuntime`, and `aprsPreviewTarget` are the APRS summary blocks reused by `/aprs` and the APRS section inside `settings-v2`
- `stationIdentity` reports whether the saved APRS callsign/SSID pair is currently valid enough for APRS send actions
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

## Radio settings

### `GET /api/v1/settings/radio`

Example:

- [Open `/api/v1/settings/radio`](http://127.0.0.1:8000/api/v1/settings/radio)

Representative response:

```json
{
  "state": {
    "enabled": true,
    "rig_model": "ic705",
    "serial_device": "/dev/cu.usbmodem113201",
    "baud_rate": 19200,
    "civ_address": "0xA4",
    "poll_interval_ms": 1000,
    "auto_connect": false,
    "auto_track_interval_ms": 1500,
    "default_apply_mode_and_tone": true,
    "safe_tx_guard_enabled": true
  }
}
```

### `POST /api/v1/settings/radio`

Example request:

```json
{
  "enabled": true,
  "rig_model": "ic705",
  "serial_device": "/dev/cu.usbmodem113201",
  "baud_rate": 19200,
  "civ_address": "0xA4"
}
```

Interpretation:

- `rig_model`, `serial_device`, `baud_rate`, and `civ_address` are the minimum fields needed for a basic CI-V test session
- `poll_interval_ms` and `auto_track_interval_ms` tune controller timing rather than frontend refresh cadence

## APRS settings

### `GET /api/v1/settings/aprs`

Example:

- [Open `/api/v1/settings/aprs`](http://127.0.0.1:8000/api/v1/settings/aprs)

Representative response:

```json
{
  "state": {
    "callsign": "VK4ABC",
    "ssid": 7,
    "operating_mode": "satellite",
    "selected_satellite_id": "iss-zarya",
    "selected_channel_id": "fm-aprs",
    "listen_only": false,
    "log_enabled": true,
    "digipeater": {
      "enabled": false
    },
    "igate": {
      "enabled": true,
      "server_host": "rotate.aprs2.net"
    }
  }
}
```

### `POST /api/v1/settings/aprs`

Example request:

```json
{
  "callsign": "VK4ABC",
  "ssid": 7,
  "operating_mode": "satellite",
  "selected_satellite_id": "iss-zarya",
  "selected_channel_id": "fm-aprs",
  "listen_only": false,
  "log_enabled": true
}
```

Interpretation:

- APRS settings persist station identity, target selection, logging policy, gateway policy, and transport-specific parameters in one block
- `selected_satellite_id` and `selected_channel_id` are only meaningful in satellite APRS mode

## Pass cache refresh

### `POST /api/v1/passes/cache/refresh`

Representative response:

```json
{
  "ok": true,
  "cleared": true
}
```

Interpretation:

- this clears the persisted pass cache used by repeated pass prediction lookups
- use it when location changes or APRS target timing appears stale

## APRS state

### `GET /api/v1/aprs/state`

Example:

- [Open `/api/v1/aprs/state`](http://127.0.0.1:8000/api/v1/aprs/state)

Representative response:

```json
{
  "settings": {
    "callsign": "VK4ABC",
    "operating_mode": "satellite"
  },
  "runtime": {
    "connected": true,
    "transport_mode": "wifi",
    "control_endpoint": "192.168.1.84:50001",
    "modem_state": "direwolf-rx + native-afsk-tx",
    "audio_rx_active": true,
    "audio_tx_active": false,
    "packets_rx": 12,
    "packets_tx": 2,
    "kiss_connected": true
  },
  "previewTarget": {
    "sat_id": "iss-zarya",
    "label": "ISS APRS",
    "can_transmit": false,
    "tx_block_reason": "pass not active"
  }
}
```

Interpretation:

- `settings` is the stored APRS configuration
- `runtime` is the live APRS transport and packet state
- `previewTarget` is the resolved terrestrial or satellite APRS target before or during connect

### `GET /api/v1/aprs/targets`

Example:

- [Open `/api/v1/aprs/targets`](http://127.0.0.1:8000/api/v1/aprs/targets)

Representative response:

```json
{
  "items": [
    {
      "operating_mode": "satellite",
      "sat_id": "iss-zarya",
      "channel_id": "fm-aprs",
      "label": "ISS APRS",
      "requires_pass": true,
      "pass_active": false,
      "corrected_downlink_hz": 437795000
    }
  ]
}
```

Interpretation:

- targets are already resolved against the current location and pass window
- corrected APRS target frequencies reuse the shared Doppler model where the target needs it

### `POST /api/v1/aprs/select-target`

Example request:

```json
{
  "sat_id": "iss-zarya",
  "channel_id": "fm-aprs"
}
```

Interpretation:

- this saves the APRS satellite target in APRS settings
- it does not start the APRS transport on its own

### `POST /api/v1/aprs/session/select`

Representative response:

```json
{
  "state": {
    "selected_satellite_id": "iss-zarya",
    "selected_channel_id": "fm-aprs"
  },
  "previewTarget": {
    "sat_id": "iss-zarya",
    "can_transmit": false
  }
}
```

Interpretation:

- this is the APRS-side session target select path used by the rotator and APRS surfaces
- `previewTarget` returns the current transmit gate and corrected target frequencies immediately

### `POST /api/v1/aprs/connect`

Representative response:

```json
{
  "settings": {
    "operating_mode": "satellite"
  },
  "runtime": {
    "connected": true,
    "transport_mode": "wifi",
    "modem_state": "direwolf-rx + native-afsk-tx"
  },
  "target": {
    "sat_id": "iss-zarya",
    "can_transmit": false
  }
}
```

Interpretation:

- `connected` means the APRS transport path started
- the active `target` still decides whether satellite transmit is currently allowed

### `POST /api/v1/aprs/disconnect`

Representative response:

```json
{
  "runtime": {
    "connected": false,
    "session_active": false,
    "last_error": null
  }
}
```

### `POST /api/v1/aprs/panic-unkey`

Representative response:

```json
{
  "ok": true
}
```

Interpretation:

- use this when the APRS transport or attached rig appears to remain keyed after a failed send or disconnect

### `GET /api/v1/aprs/log`

Representative response:

```json
{
  "items": [
    {
      "id": "pkt_001",
      "received_at": "2026-03-21T02:15:00Z",
      "source": "VK4XYZ-9",
      "destination": "APRS",
      "text": "CQ SAT APRS",
      "message": true
    }
  ]
}
```

Interpretation:

- this is the stored local receive log, not the in-memory recent packet tail
- export endpoints use the same underlying log store

### `POST /api/v1/aprs/log/clear`

Example request:

```json
{
  "age_bucket": "24h"
}
```

Interpretation:

- clear requests prune the local JSONL log by age bucket

### `GET /api/v1/aprs/direwolf/status`

Representative response:

```json
{
  "installed": true,
  "configuredBinary": "/opt/homebrew/bin/direwolf",
  "resolvedBinary": "/opt/homebrew/bin/direwolf"
}
```

Interpretation:

- this route reports both the saved Dire Wolf binary and the currently resolved executable path

### `POST /api/v1/aprs/send/message`

Example request:

```json
{
  "to": "VK4XYZ-9",
  "text": "Testing OrbitDeck APRS"
}
```

### `POST /api/v1/aprs/send/status`

Example request:

```json
{
  "text": "OrbitDeck APRS status test"
}
```

### `POST /api/v1/aprs/send/position`

Example request:

```json
{
  "comment": "Portable satellite station"
}
```

Interpretation:

- all APRS send routes return the updated runtime state
- position sends resolve location, apply any configured fudge offsets, and then encode the packet

## Radio state

### `GET /api/v1/radio/state`

Example:

- [Open `/api/v1/radio/state`](http://127.0.0.1:8000/api/v1/radio/state)

Representative response:

```json
{
  "settings": {
    "rig_model": "ic705",
    "serial_device": "/dev/cu.usbmodem113201",
    "civ_address": "0xA4"
  },
  "runtime": {
    "connected": true,
    "control_mode": "manual_applied",
    "last_poll_at": "2026-03-13T02:16:00Z",
    "last_error": null,
    "targets": {
      "vfo_a_freq_hz": 145990000,
      "vfo_b_freq_hz": 437795000,
      "vfo_a_mode": "FM",
      "vfo_b_mode": "FM"
    },
    "raw_state": {
      "selected_vfo": "A",
      "split_enabled": true,
      "scope_enabled": true
    }
  },
  "session": {
    "active": false,
    "screen_state": "idle",
    "control_state": "connected_idle"
  }
}
```

Interpretation:

- `runtime.targets` is the normalized rig-facing state OrbitDeck wants the UI to display
- `runtime.raw_state` is lower-level controller readback such as split state, selected VFO identity, and scope status
- `session` is always present, even when no pass is selected

### `GET /api/v1/radio/ports`

Example:

- [Open `/api/v1/radio/ports`](http://127.0.0.1:8000/api/v1/radio/ports)

Representative response:

```json
{
  "items": [
    {
      "device": "/dev/cu.usbmodem113201",
      "description": "IC-705 USB CI-V",
      "hwid": "USB VID:PID=0000:0000"
    }
  ]
}
```

Interpretation:

- this route is best-effort serial-port discovery
- an empty list does not prove CI-V cannot work; it only means pyserial did not enumerate a matching port

### `POST /api/v1/radio/connect`

Representative response:

```json
{
  "settings": {
    "rig_model": "ic705"
  },
  "runtime": {
    "connected": true,
    "control_mode": "idle"
  },
  "session": {
    "active": false
  }
}
```

Interpretation:

- `connected: true` means the serial/controller path was opened successfully
- use `POST /api/v1/radio/poll` to confirm readback from the rig

### `POST /api/v1/radio/disconnect`

Representative response:

```json
{
  "runtime": {
    "connected": false,
    "control_mode": "idle",
    "last_error": null
  }
}
```

### `POST /api/v1/radio/poll`

Representative response:

```json
{
  "settings": {
    "rig_model": "ic705"
  },
  "runtime": {
    "connected": true,
    "targets": {
      "vfo_a_freq_hz": 438050000,
      "vfo_b_freq_hz": 121000000
    },
    "raw_state": {
      "split_enabled": false,
      "selected_vfo": "A"
    }
  }
}
```

Interpretation:

- a successful poll proves OrbitDeck received usable CI-V state back from the rig
- on IC-705, the controller maps selected and unselected CI-V reads back into absolute `VFO A` and `VFO B`

### `POST /api/v1/radio/frequency`

Example request:

```json
{
  "vfo": "A",
  "freq_hz": 145990000
}
```

Representative response:

```json
{
  "runtime": {
    "connected": true
  },
  "result": {
    "vfo": "A",
    "freq_hz": 145990000
  }
}
```

Interpretation:

- this is a direct VFO write, not a pass-aware action
- it is the simplest endpoint for validating live writeback on a connected rig

### `POST /api/v1/radio/pair`

Example request:

```json
{
  "uplink_hz": 145990000,
  "downlink_hz": 437795000,
  "uplink_mode": "FM",
  "downlink_mode": "FM"
}
```

Representative response:

```json
{
  "runtime": {
    "connected": true,
    "control_mode": "manual_applied"
  },
  "recommendation": {
    "sat_id": "manual-pair",
    "mode": "fm",
    "uplink_mhz": 145.99,
    "downlink_mhz": 437.795,
    "uplink_mode": "FM",
    "downlink_mode": "FM"
  },
  "targetMapping": {
    "tx": "MAIN",
    "rx": "SUB"
  }
}
```

Interpretation:

- this route builds a complete recommendation object around the manual pair so the controller path can reuse the same target-application logic as the shared frequency-guidance flow
- omitted pair modes default to `FM`
- out-of-range pairs fail with HTTP 400 and an eligibility message

## Radio session control

### `GET /api/v1/radio/session`

Representative response:

```json
{
  "session": {
    "active": true,
    "selected_sat_id": "iss-zarya",
    "screen_state": "idle",
    "control_state": "connected_idle",
    "is_eligible": true,
    "has_test_pair": true
  },
  "runtime": {
    "connected": true
  }
}
```

### `POST /api/v1/radio/session/select`

Example request:

```json
{
  "sat_id": "iss-zarya",
  "sat_name": "ISS (ZARYA)",
  "pass_aos": "2026-03-13T02:20:00Z",
  "pass_los": "2026-03-13T02:30:00Z",
  "max_el_deg": 52.0
}
```

Representative response:

```json
{
  "session": {
    "active": true,
    "selected_sat_id": "iss-zarya",
    "screen_state": "idle",
    "control_state": "connected_idle",
    "is_eligible": true,
    "has_test_pair": true
  }
}
```

Interpretation:

- selecting a session resolves the default test pair from the existing frequency-guide data
- `is_eligible` and `eligibility_reason` are computed immediately from the supported VHF/UHF rule

### `POST /api/v1/radio/session/test`

Representative response:

```json
{
  "session": {
    "screen_state": "test",
    "control_state": "test_applied"
  },
  "runtime": {
    "control_mode": "manual_applied"
  },
  "recommendation": {
    "sat_id": "iss-zarya"
  }
}
```

Interpretation:

- this applies the default pair for the selected pass
- OrbitDeck captures a restore snapshot before the test if the controller supports it

### `POST /api/v1/radio/session/test/confirm`

Representative response:

```json
{
  "session": {
    "screen_state": "released",
    "control_state": "released"
  },
  "runtime": {
    "control_mode": "idle"
  }
}
```

Interpretation:

- this releases OrbitDeck control while keeping the session pinned in the rotator UI
- the previous rig snapshot is restored when possible

### `POST /api/v1/radio/session/start`

Representative response before AOS:

```json
{
  "session": {
    "screen_state": "armed",
    "control_state": "armed_waiting_aos"
  }
}
```

Representative response during an ongoing pass:

```json
{
  "session": {
    "screen_state": "active",
    "control_state": "tracking_active"
  },
  "runtime": {
    "control_mode": "auto_tracking"
  }
}
```

Interpretation:

- if the pass has not started yet, OrbitDeck arms the session and waits for AOS
- if the pass is already underway, OrbitDeck starts applying recommendation-driven tracking immediately

### `POST /api/v1/radio/session/stop`

Representative response:

```json
{
  "session": {
    "screen_state": "released",
    "control_state": "released"
  },
  "runtime": {
    "control_mode": "idle"
  }
}
```

### `POST /api/v1/radio/apply`

Example request:

```json
{
  "sat_id": "iss-zarya"
}
```

Interpretation:

- this resolves the current shared frequency recommendation for the selected satellite and applies it immediately
- it is recommendation-driven, unlike `POST /api/v1/radio/pair`, which is entirely manual

### `POST /api/v1/radio/auto-track/start`

Example request:

```json
{
  "sat_id": "iss-zarya",
  "interval_ms": 1500
}
```

### `POST /api/v1/radio/auto-track/stop`

Interpretation:

- these endpoints control the background recommendation-reapply loop outside the rotator session model
- use them when you want recommendation-driven retuning without pinning a selected pass in the rotator UI

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

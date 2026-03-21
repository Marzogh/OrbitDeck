# Common Tasks

This page covers routine operating tasks once OrbitDeck is already running.

## Check whether a satellite is worth watching

Relevant surfaces:

- `/lite` if you are on a phone or Pi Zero
- `/` for the tracking view
- `/api/v1/satellites` for raw metadata

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

## Configure APRS station identity and target selection

1. Open `/aprs` or the APRS section inside `/settings`.
2. Set the station callsign and SSID.
3. Choose `terrestrial` or `satellite` mode.
4. In terrestrial mode, save the local APRS frequency and path.
5. In satellite mode, select the target satellite and channel.
6. Save settings before connecting.

Notes:

- satellite APRS transmit remains gated by pass state and target eligibility
- terrestrial APRS does not use the satellite pass gate

## Connect APRS and confirm runtime

1. Open `/aprs`.
2. Save the APRS settings and target selection.
3. Use `Connect APRS`.
4. Confirm the runtime panel shows `connected: true`.
5. Check the target summary, heard list, and packet counters.

Notes:

- a connected APRS session can still report transport or sidecar problems through `last_error`, `modem_state`, `kiss_connected`, and `output_tail`
- Wi-Fi APRS and USB APRS use different runtime transport fields

## Send an APRS message, status, or position packet

1. Connect APRS.
2. Use the send tabs on `/aprs`.
3. Enter the destination callsign and text for a message, or enter status/position content.
4. Send the packet.
5. Check the runtime counters and the recent packet list.

Relevant APIs:

- `POST /api/v1/aprs/send/message`
- `POST /api/v1/aprs/send/status`
- `POST /api/v1/aprs/send/position`

## Export or clear the APRS receive log

1. Open `/aprs`.
2. Use the stored-log actions to export CSV or JSON.
3. Use the clear action when you want to prune the local receive history.

Relevant APIs:

- `GET /api/v1/aprs/log/export.csv`
- `GET /api/v1/aprs/log/export.json`
- `POST /api/v1/aprs/log/clear`

## Check Dire Wolf install state

1. Open `/aprs`.
2. Read the Dire Wolf status card.
3. If the binary is missing on macOS, use the install action or terminal launcher.
4. Recheck the status after install.

Relevant APIs:

- `GET /api/v1/aprs/direwolf/status`
- `POST /api/v1/aprs/direwolf/install`
- `POST /api/v1/aprs/direwolf/install-terminal`

## Connect a rig and confirm CI-V readback

1. Open `/radio`.
2. Save the rig model, serial device, baud rate, and CI-V address.
3. Connect the rig.
4. Poll the rig.
5. Confirm that the runtime payload shows `connected: true` and current VFO state.

Notes:

- a successful connect means OrbitDeck opened the device
- a successful poll means OrbitDeck exchanged usable CI-V state with the rig

## Write a direct VFO frequency

Use `/radio` when you want to test a direct frequency write without selecting a pass.

1. Connect the rig.
2. Choose the target VFO.
3. Enter the frequency in Hz.
4. Use `Set Manual Frequency`.
5. Poll again if you want a fresh confirmed readback.

Relevant API:

- `POST /api/v1/radio/frequency`

## Apply a manual uplink/downlink pair

Use this when you want to validate split control without relying on a live pass.

1. Open `/radio`.
2. Enter `Pair Uplink (Hz)` and `Pair Downlink (Hz)`.
3. Optionally change the default `FM` modes.
4. Use `Apply Manual Pair`.
5. Confirm the returned `targetMapping`, recommendation payload, and runtime targets.

Relevant API:

- `POST /api/v1/radio/pair`

IC-705 mapping:

- OrbitDeck writes the uplink to `VFO A`
- OrbitDeck writes the downlink to `VFO B`
- omitted pair modes default to `FM`

## Use the rotator radio-control workflow

1. Open `/kiosk-rotator`.
2. Select a pass with `Go to Radio Control`.
3. Connect the rig if needed.
4. Run the default-pair test for that selected pass.
5. If the rig state is correct, confirm the test.
6. Start or arm control for the pass.
7. Stop control manually or let the session end after LOS.

Session APIs:

- `POST /api/v1/radio/session/select`
- `POST /api/v1/radio/session/test`
- `POST /api/v1/radio/session/test/confirm`
- `POST /api/v1/radio/session/start`
- `POST /api/v1/radio/session/stop`

## Change the observer location

### Common options

- use browser geolocation from lite settings
- enter manual coordinates
- set GPS mode for a Pi-connected USB or Bluetooth receiver

### Relevant APIs

- `POST /api/v1/location`
- `POST /api/v1/settings/gps`

## Refresh remote source data

For a manual data refresh instead of waiting for the normal background cycle:

- use `POST /api/v1/datasets/refresh`
- or call `GET /api/v1/satellites?refresh_from_sources=true`

What this can refresh:

- catalog metadata
- ephemeris, when refresh succeeds
- AMSAT status, when outside the 12-hour guard window

## Clear and rebuild the pass cache

Use this when pass predictions look stale after a location change, target change, or APRS target-selection session.

```bash
curl -X POST "http://127.0.0.1:8000/api/v1/passes/cache/refresh"
```

Notes:

- this clears the persisted pass cache and forces the next pass query to rebuild it
- it does not replace the normal catalog refresh endpoints

## Change which satellites lite tracks

Open `/lite/settings` and change the tracked set.

Notes:

- lite computes only the tracked satellites
- the API enforces a maximum of 8 tracked satellites
- if you remove the saved focus satellite from the list, lite clears that saved focus and falls back to automatic focus selection

## Change kiosk pass filtering

Open `/settings` and use the pass filter controls.

Profiles:

- `IssOnly`
- `Favorites`

This behavior differs from lite. Lite uses a saved tracked-satellite list. Kiosk uses a pass filter.

## Inspect a Doppler recommendation directly

Use:

```bash
curl "http://127.0.0.1:8000/api/v1/frequency-guides/recommendation?sat_id=iss-zarya"
```

Use this endpoint when you want the raw recommendation payload instead of the UI presentation.

## Check whether a pass is radio-control eligible

The rotator radio workflow currently accepts recommendations inside:

- VHF `144.000 MHz` to `148.000 MHz`
- UHF `420.000 MHz` to `450.000 MHz`

Receive-only downlink recommendations remain eligible when the downlink is inside the supported range.

The quickest way to inspect that state is:

- `POST /api/v1/radio/session/select`
- then read `is_eligible` and `eligibility_reason`

## Record a dataset snapshot

To store a snapshot entry in app state:

```bash
curl -X POST "http://127.0.0.1:8000/api/v1/snapshots/record?source=merged&satellite_count=42"
```

This endpoint is mainly used for testing state persistence and cache history behavior.

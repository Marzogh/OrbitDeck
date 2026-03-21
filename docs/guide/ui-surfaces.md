# UI Surfaces

OrbitDeck has multiple web screens because the job is different on a wall display, a phone, and a low-power Pi.

## `/`

The default route serves the tracking screen on standard hardware.

Primary content:

- active and upcoming pass telemetry
- sky/hemisphere visualization
- pass-focused RF guidance
- a denser layout than the original kiosk dashboard
- pinned radio-control workflow when a pass is selected for rig control

## `/kiosk-rotator`

This route serves the same tracking screen as `/` on standard hardware.

Additional behavior:

- first-load startup overlay while the main system state, pass list, timezone data, and pass-path warmup complete
- a generic radio scene when no pass is pinned for control
- a pinned radio-control card when a pass is selected
- direct actions for connect, test, confirm, arm, start, stop, and return-to-rotator flow

The rotator is the operational screen for pass-driven radio control.

## `/lite`

The lite UI is optimized for:

- mobile devices
- remote use while the Pi is elsewhere
- low-power hardware such as Pi Zero-class systems
- intermittent connectivity

Lite uses a service-worker shell cache and a last-good local snapshot fallback.

## `/lite/settings`

This route serves the lite-specific configuration surface. It exposes:

- tracked satellite selection
- setup completion state
- default focus behavior
- timezone
- location source selection
- Pi GPS connection details

## `/settings`

On standard hardware this route serves the `settings-v2` surface. That UI exposes:

- overview and runtime status
- radio configuration
- ISS display mode
- tracked satellite and pass filter controls
- location source inputs
- timezone controls
- APRS setup, send tools, local logging controls, digipeater, and iGate controls
- video source overrides
- developer override controls for rotator debugging and scene forcing

On Pi Zero-class hardware, `/settings` serves the lite settings surface instead.

## `/settings-v2`

This route redirects to `/settings`. Use it when you are following older notes or bookmarks.

## `/radio`

This route is the direct rig-validation surface.

Primary content:

- rig model and CI-V connection settings
- manual VFO write controls
- manual uplink/downlink pair controls
- raw runtime and response payloads for connect, poll, write, and pair actions

Use `/radio` when you want to validate the hardware link and CI-V behavior directly. Use `/kiosk-rotator` when you want OrbitDeck to manage a selected pass.

## `/aprs`

This route is the dedicated APRS console.

Primary content:

- station identity and operating-mode controls
- terrestrial or satellite APRS target selection
- Dire Wolf install and status checks
- connect, disconnect, and panic-unkey controls
- message, status, and position send tools
- heard-packet summaries and stored-log export/clear actions
- digipeater and iGate settings

Use `/aprs` when you want the full APRS operating surface. Use the APRS section in `/settings` when you want the same configuration and runtime information inside the combined settings-v2 console.

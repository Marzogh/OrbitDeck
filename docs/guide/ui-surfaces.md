# UI Surfaces

OrbitDeck has multiple web screens because the job is different on a wall display, a phone, and a low-power Pi.

## `/`

The default route serves the tracking screen on standard hardware.

Primary content:

- active and upcoming pass telemetry
- sky/hemisphere visualization
- pass-focused RF guidance
- a denser layout than the original kiosk dashboard

## `/kiosk`

The kiosk UI is the large-display dashboard surface.

Primary content:

- a station display on a larger screen
- ISS state visibility
- broad pass/radio visibility without centering the entire layout on one active pass

## `/kiosk-rotator`

This route serves the same tracking screen as `/` on standard hardware.

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

On standard hardware this route serves the kiosk settings surface. That UI exposes:

- ISS display mode
- tracked satellite and pass filter controls
- location source inputs
- timezone controls
- video source overrides
- developer override controls for rotator debugging and scene forcing

On Pi Zero-class hardware, `/settings` serves the lite settings surface instead.

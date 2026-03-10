# UI Surfaces

OrbitDeck has multiple web surfaces because the operator workflows are different on a wall display, a phone, and a low-power Pi.

## `/`

The default route serves the rotator/operator landing UI on standard hardware.

This is the tracking-focused screen. It emphasizes:

- active and upcoming pass telemetry
- sky/hemisphere visualization
- pass-focused RF guidance
- a denser operator-oriented layout than the original kiosk dashboard

## `/kiosk`

The kiosk UI is the large-display dashboard surface. It is better suited to passive monitoring and broad at-a-glance visibility than to pass-specific operator work.

## `/kiosk-rotator`

This is the explicit rotator/operator route. It uses the same operator-oriented presentation style as the default landing route on standard hardware, and is the safest direct link when you specifically want the tracking view.

## `/lite`

The lite UI is optimized for:

- mobile devices
- remote use while the Pi is elsewhere
- low-power hardware such as Pi Zero-class systems
- intermittent connectivity

Lite keeps a service-worker shell cache and a last-good local snapshot fallback.

## `/lite/settings`

This is the lite-specific configuration surface. It exposes:

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

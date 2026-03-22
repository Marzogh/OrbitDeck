# Device Routing and Debug Overrides

This page documents Pi Zero routing behavior and the kiosk developer override model.

## Device classification

OrbitDeck uses `app/device.py` to classify the host as either:

- `standard`
- `pi-zero`

Detection order:

1. read `ISS_TRACKER_DEVICE_CLASS`
2. if it is `pi-zero` or `standard`, use that value
3. otherwise, if the host is not Linux, return `standard`
4. otherwise inspect Linux device model text for Pi Zero markers

Current Pi Zero markers include:

- `raspberry pi zero`
- `pi zero w`
- `pi zero 2`

## `lite_only_ui()`

`lite_only_ui()` returns `true` when `device_class()` is `pi-zero`.

That flag is used by the route layer in `app/main.py`.

## Route gating on Pi Zero

On standard hardware:

- `/` serves `app/static/kiosk/rotator.html`
- `/lite` serves `app/static/lite/index.html`
- `/lite/settings` serves `app/static/lite/settings.html`
- `/settings` serves `app/static/kiosk/settings.html`
- `/kiosk-rotator` serves `app/static/kiosk/rotator.html`

On Pi Zero-class hardware:

- `/` serves lite
- `/lite` still serves lite
- `/lite/settings` still serves lite settings
- `/settings` serves lite settings
- `/kiosk-rotator` serves lite

This behavior is enforced at the route layer, not only by the launcher.

## Developer override storage

Developer overrides are stored in:

- `settings.developer_overrides`

Relevant fields:

- `enabled`
- `force_scene`
- `force_sat_id`
- `simulate_pass_phase`
- `force_iss_video_eligible`
- `force_iss_stream_healthy`
- `show_debug_badge`

## What the override scenes do

The rotator frontend recognizes these forced scenes:

### `auto`

No forced scene. Normal rotation and scene selection apply.

### `ongoing`

Force the telemetry scene around a synthesized ongoing pass. The frontend uses a synthetic `mid-pass` phase for the scene payload.

### `upcoming`

Force the telemetry scene around the next qualifying pass.

### `iss-upcoming`

Force the telemetry scene around the next qualifying ISS pass.

### `passes`

Force the passes screen.

### `radio`

Force the radio screen.

### `video`

Force the video screen.

## What `simulate_pass_phase` means

The persisted model supports these values:

- `real-time`
- `before-aos`
- `at-aos`
- `mid-pass`
- `near-los`

The rotator frontend uses synthesized pass and track helpers to move the displayed geometry and elevation toward those phase positions when the scene is being overridden.

The current forced-scene implementation uses `mid-pass` for `ongoing` and `real-time` for other override scenes when constructing the synthetic view state.

## Other override effects

### `force_iss_video_eligible`

If enabled, the rotator frontend treats ISS video as eligible even if the live ISS state would normally say no.

### `force_iss_stream_healthy`

If enabled, the rotator frontend treats the ISS stream as healthy.

### `show_debug_badge`

If enabled along with developer mode, the rotator UI appends visible debug markers such as `[DEV]` and scene badges.

## Pass filtering vs lite tracked-satellite rules

These two systems are separate:

### Kiosk and rotator pass filtering

Rotator scene selection uses pass qualification rules in the frontend:

- pass duration must be `<= 10` minutes
- ISS passes are accepted from `20°` max elevation
- non-ISS passes require `40°` max elevation

### Lite tracked-satellite enforcement

Lite does not use the same rule as a general pass filter. It is limited by the saved tracked-satellite list that the backend enforces to a maximum of 8 valid satellites.

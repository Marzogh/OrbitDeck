# Radio Control

OrbitDeck now includes a native Icom CI-V control path for direct rig validation and pass-driven control from the rotator screen.

This page documents the current controller scope, the session model, and the operating assumptions behind the radio API.

## Current controller scope

Supported rig models in the persisted settings model:

- `ic705`
- `id5100`

Current implementation status:

- `ic705` has live-validated connect, poll, direct frequency write, and manual pair application
- `id5100` has controller and settings scaffolding, but not the same level of live validation

The radio stack lives under:

- `app/radio/civ.py`
- `app/radio/transport.py`
- `app/radio/service.py`
- `app/radio/controllers/ic705.py`
- `app/radio/controllers/id5100.py`

## Transport and connection model

OrbitDeck uses a native serial CI-V transport. Connection state is configured through `RadioSettings` and opened through the radio service.

The basic operator flow is:

1. Save radio settings.
2. Connect the rig.
3. Poll the rig to confirm CI-V exchange.
4. Apply a direct frequency, manual pair, or recommendation-driven target.

Important distinction:

- a serial port opening successfully only proves that OrbitDeck could open the device
- a successful poll proves that OrbitDeck exchanged CI-V commands and received usable state back from the rig

## IC-705 VFO identity

OrbitDeck treats `VFO A` and `VFO B` on the IC-705 as absolute identities.

That matters because the radio's raw CI-V reads expose selected and unselected VFO state. OrbitDeck maps those reads back into absolute `A/B` slots instead of presenting selected and unselected values as if they were stable labels.

Behaviour:

- on connect, OrbitDeck explicitly selects `VFO A`
- poll logic maps selected and unselected readback into absolute `VFO A` and `VFO B`
- after a manual `VFO B` write, OrbitDeck restores `VFO A` as the selected working VFO

## Direct actions

### `POST /api/v1/radio/frequency`

This writes one frequency to one VFO.

Use it for:

- confirming a live write path
- checking that poll/readback matches a manual frequency change
- validating VFO identity behavior on a rig

### `POST /api/v1/radio/pair`

This applies a manual uplink/downlink pair without relying on a live pass selection.

Current IC-705 pair behavior:

1. disable split
2. set `VFO A` frequency
3. set `VFO A` mode
4. set `VFO B` frequency
5. set `VFO B` mode
6. re-enable split

Default mode behavior:

- `uplink_mode` defaults to `FM` if omitted
- `downlink_mode` defaults to `FM` if omitted

The response includes:

- updated runtime
- the derived manual recommendation object
- `targetMapping`

`targetMapping` describes which logical transmit and receive paths OrbitDeck used for the write.

## Recommendation-driven actions

### `POST /api/v1/radio/apply`

This applies the current recommendation for one satellite.

The request can include:

- `sat_id`
- `pass_aos`
- `pass_los`
- `selected_column_index`
- `location_source`
- `apply_mode_and_tone`

OrbitDeck resolves the same backend recommendation model used by kiosk, rotator, lite, and `GET /api/v1/frequency-guides/recommendation`, then maps that recommendation into rig targets.

### `POST /api/v1/radio/auto-track/start`

This starts periodic reapplication of the selected recommendation at the configured interval.

Use it when you want recommendation-driven retuning without using the rotator session model.

### `POST /api/v1/radio/auto-track/stop`

This stops the background recommendation reapply loop and returns the runtime to `idle`.

## Rotator radio-control session

The rotator uses a session model so that radio control can stay pinned to one selected pass.

Session state lives in:

- `GET /api/v1/radio/session`
- `GET /api/v1/radio/state`
- `GET /api/v1/system/state`

Selection starts with:

- `POST /api/v1/radio/session/select`

The session stores:

- selected satellite identity
- selected pass AOS and LOS
- max elevation
- eligibility state
- default test-pair state

### Screen states

- `idle`
- `test`
- `armed`
- `active`
- `released`
- `completed`

### Control states

- `not_connected`
- `connected_idle`
- `test_applied`
- `armed_waiting_aos`
- `tracking_active`
- `released`
- `ended`

### Session workflow

1. Select a pass from the rotator view.
2. OrbitDeck resolves the default test pair from the existing frequency-guide data.
3. `POST /api/v1/radio/session/test` applies that pair and marks the session `test`.
4. `POST /api/v1/radio/session/test/confirm` releases OrbitDeck control while keeping the session card active.
5. `POST /api/v1/radio/session/start` either:
   - arms the session if AOS is in the future
   - or starts active tracking immediately if the pass is already above the horizon
6. `POST /api/v1/radio/session/stop` stops control and releases the session.
7. After LOS, OrbitDeck ends the session automatically and restores the previous rig snapshot when possible.

## Eligibility rules

The rotator radio-control workflow currently enforces a VHF/UHF eligibility rule.

Supported ranges:

- VHF: `144.000 MHz` to `148.000 MHz`
- UHF: `420.000 MHz` to `450.000 MHz`

Behaviour:

- a recommendation is eligible if either side lands in the supported VHF/UHF range
- receive-only downlink recommendations remain eligible when the downlink is in range
- out-of-range pairs are marked ineligible and expose `eligibility_reason`

This rule is used for:

- rotator session selection
- default test-pair availability
- pass-driven start/arm actions

## IC-705 operating defaults used by OrbitDeck

When OrbitDeck applies a satellite target on the IC-705, it also configures a few operating defaults used by the current controller:

- squelch is opened to `0`
- scope display is enabled
- scope mode is set to center
- scope span is set to `1,000,000 Hz`

Those values are part of the current controller behavior and are covered by API tests.

## Restore behavior

Before a rotator test or session-controlled apply, OrbitDeck can capture a rig snapshot.

When the session is released, stopped, or ends after LOS, OrbitDeck attempts to restore:

- prior VFO frequencies
- prior VFO modes
- split state
- squelch level
- scope state

If the restore fails, OrbitDeck records the failure in `runtime.last_error` and leaves the session in a released state instead of failing the request outright.

## Known operational notes

- Manual writes can be followed by an intermittent `timeout waiting for CI-V response to 0x25`
- When that happens, the rig may still have applied the write successfully
- OrbitDeck keeps the last known good target values in runtime when a later readback is incomplete
- Poll again after the write if you need a fresh confirmed readback

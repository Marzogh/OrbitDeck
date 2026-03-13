# Settings

OrbitDeck persists most operator-facing configuration in app state.

## Main settings groups

### ISS display mode

Controls how ISS-related presentation behaves in the kiosk-oriented UIs.

### Pass filter settings

Controls which satellites are eligible for kiosk pass selection, including favorite-based behavior in the full kiosk workflow.

### Lite settings

Lite settings are separate because lite has its own bounded-compute model. They include:

- tracked satellite IDs
- setup completion
- preferred default focus

The lite settings endpoint enforces:

- at least one valid tracked satellite
- at most 8 tracked satellites

The available satellite list is returned with the settings response so the frontend can build a valid picker without a second catalog-specific UI contract.

### GPS settings

GPS settings define how Pi GPS hardware should be configured. Supported connection shapes in the current model are:

- USB serial
- Bluetooth

These settings define the connection parameters only. Live GPS coordinates still have to be written into location state by a separate process.

### Radio settings

Radio settings define how OrbitDeck connects to and manages a supported rig.

Persisted fields:

- `enabled`
- `rig_model`
- `serial_device`
- `baud_rate`
- `civ_address`
- `poll_interval_ms`
- `auto_connect`
- `auto_track_interval_ms`
- `default_apply_mode_and_tone`
- `safe_tx_guard_enabled`

Interpretation:

- `rig_model` selects the controller implementation
- `serial_device` is the OS-visible serial path used by the CI-V transport
- `baud_rate` and `civ_address` have to match the rig configuration
- `poll_interval_ms` controls the readback cadence used by the radio service
- `auto_track_interval_ms` controls the background interval for recommendation-driven retuning
- `default_apply_mode_and_tone` allows the controller to apply mode and tone defaults where the rig supports them
- `safe_tx_guard_enabled` is reserved for transmit-safety behavior in the control path

### Radio runtime

The runtime state returned by the radio APIs and `system/state` is not a saved settings block. It is the live controller state.

Main fields:

- `connected`
- `control_mode`
- `rig_model`
- `serial_device`
- `last_error`
- `last_poll_at`
- `active_sat_id`
- `active_pass_aos`
- `active_pass_los`
- `selected_column_index`
- `last_applied_recommendation`
- `targets`
- `raw_state`

Interpretation:

- `control_mode` is `idle`, `manual_applied`, or `auto_tracking`
- `targets` stores normalized rig-side targets such as `vfo_a_freq_hz`, `vfo_b_freq_hz`, `main_freq_hz`, `sub_freq_hz`, and mode labels
- `raw_state` stores lower-level controller readback such as split state, selected VFO identity, squelch level, and scope status
- `last_applied_recommendation` is the exact recommendation object used for the most recent apply

### Radio control session

The rotator radio-control workflow uses a separate session model.

Main fields:

- `active`
- `selected_sat_id`
- `selected_sat_name`
- `selected_pass_aos`
- `selected_pass_los`
- `selected_max_el_deg`
- `screen_state`
- `control_state`
- `return_to_rotator_on_end`
- `is_eligible`
- `eligibility_reason`
- `has_test_pair`
- `test_pair_reason`
- `test_pair`

Interpretation:

- `screen_state` tracks the UI-facing phase of the selected radio-control session
- `control_state` tracks the controller-facing state such as `armed_waiting_aos` or `tracking_active`
- `is_eligible` and `eligibility_reason` reflect the current VHF/UHF support rule used by the rotator workflow
- `test_pair` is the default pair resolved from the shared frequency-guide data for the selected pass

### Developer overrides

Developer overrides are intended for kiosk and rotator debugging, demo control, and scene forcing. They are not a normal end-user requirement.

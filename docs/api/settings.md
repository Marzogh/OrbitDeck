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
- `transport_mode`
- `serial_device`
- `baud_rate`
- `civ_address`
- `wifi_host`
- `wifi_username`
- `wifi_password`
- `wifi_control_port`
- `poll_interval_ms`
- `auto_connect`
- `auto_track_interval_ms`
- `default_apply_mode_and_tone`
- `safe_tx_guard_enabled`

Interpretation:

- `rig_model` selects the controller implementation
- `transport_mode` selects USB serial CI-V or Wi-Fi LAN control for rigs that support both paths
- `serial_device` is the OS-visible serial path used by the CI-V transport
- `baud_rate` and `civ_address` have to match the rig configuration
- `wifi_host`, `wifi_username`, `wifi_password`, and `wifi_control_port` define the LAN control path used by the IC-705 Wi‑Fi transport
- `poll_interval_ms` controls the readback cadence used by the radio service
- `auto_track_interval_ms` controls the background interval for recommendation-driven retuning
- `default_apply_mode_and_tone` allows the controller to apply mode and tone defaults where the rig supports them
- `safe_tx_guard_enabled` is reserved for transmit-safety behavior in the control path

### APRS settings

APRS settings define the station identity, transport parameters, target selection, logging behavior, and gateway policy used by the APRS console and the APRS section in `settings-v2`.

Persisted fields:

- `callsign`
- `ssid`
- `listen_only`
- `operating_mode`
- `rig_model`
- `hamlib_model_id`
- `serial_device`
- `baud_rate`
- `civ_address`
- `audio_input_device`
- `audio_output_device`
- `kiss_host`
- `kiss_port`
- `direwolf_binary`
- `terrestrial_path`
- `satellite_path`
- `terrestrial_beacon_comment`
- `satellite_beacon_comment`
- `position_fudge_lat_deg`
- `position_fudge_lon_deg`
- `selected_satellite_id`
- `selected_channel_id`
- `terrestrial_manual_frequency_hz`
- `terrestrial_region_label`
- `terrestrial_last_suggested_frequency_hz`
- `log_enabled`
- `log_max_records`
- `notify_incoming_messages`
- `notify_all_packets`
- `digipeater`
- `igate`
- `future_digipeater_enabled`
- `future_igate_enabled`
- `igate_auto_enable_with_internet`

Interpretation:

- `operating_mode` switches between local/region APRS and satellite-target APRS
- `hamlib_model_id` is the explicit rig model selector used when generating Dire Wolf rig-control configuration
- `audio_input_device` and `audio_output_device` matter in USB APRS mode and are not the active transport path in IC-705 Wi‑Fi APRS mode
- `position_fudge_*` applies a transmit-side coordinate offset for position packets
- `selected_satellite_id` and `selected_channel_id` store the saved APRS satellite target
- `digipeater` and `igate` hold the gateway policy blocks used by APRS runtime

### APRS runtime

The APRS runtime block is live state returned by `GET /api/v1/aprs/state` and embedded in `system/state`.

Main fields:

- `connected`
- `session_active`
- `sidecar_running`
- `kiss_connected`
- `transport_mode`
- `control_endpoint`
- `modem_state`
- `audio_rx_active`
- `audio_tx_active`
- `last_error`
- `last_started_at`
- `last_packet_at`
- `last_tx_at`
- `last_tx_packet_type`
- `last_tx_text`
- `last_tx_raw_tnc2`
- `packets_rx`
- `packets_tx`
- `packets_digipeated`
- `packets_igated`
- `packets_dropped_policy`
- `packets_dropped_duplicate`
- `heard_count`
- `digipeater_requested`
- `digipeater_active`
- `digipeater_reason`
- `igate_requested`
- `igate_active`
- `igate_auto_enabled`
- `igate_status`
- `igate_connected`
- `igate_reason`
- `igate_server`
- `igate_last_connect_at`
- `igate_last_error`
- `target`
- `recent_packets`
- `heard_stations`
- `output_tail`

Interpretation:

- `transport_mode` is `usb` or `wifi`
- `control_endpoint` is the active serial device or Wi-Fi control socket
- `modem_state` summarizes the APRS modem pipeline such as `direwolf-local-audio` or `direwolf-rx + native-afsk-tx`
- `audio_rx_active` and `audio_tx_active` report the APRS audio path state for Wi‑Fi transport
- `output_tail` is recent sidecar output used for troubleshooting

### APRS gateway policy

The APRS settings model includes dedicated gateway policy blocks.

Digipeater fields:

- `enabled`
- `aliases`
- `max_hops`
- `dedupe_window_s`
- `callsign_allowlist`
- `path_blocklist`

iGate fields:

- `enabled`
- `server_host`
- `server_port`
- `login_callsign`
- `passcode`
- `filter`
- `connect_timeout_s`
- `gate_terrestrial_rx`
- `gate_satellite_rx`

Interpretation:

- digipeater policy is persisted even when satellite APRS policy prevents digipeating on the current target
- iGate policy can remain enabled for receive when the current target and internet state allow it

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

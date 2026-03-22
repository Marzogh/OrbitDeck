# APRS

OrbitDeck includes two APRS operator surfaces:

- `/aprs` for direct APRS testing and operations
- the APRS section inside `settings` at `/settings`

This page documents the APRS settings model, runtime model, target model, and transport behavior.

## Operating modes

APRS currently supports:

- `terrestrial`
- `satellite`

`terrestrial` uses a local or region-derived APRS frequency and terrestrial path defaults.

`satellite` uses a selected APRS-capable satellite/channel target and can expose:

- pass timing
- active transmit gating
- Doppler-corrected UHF tuning
- target-specific path defaults such as `ARISS`

## APRS settings

Persisted APRS settings are stored in `settings.aprs_settings`.

Main fields:

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
- `log_enabled`
- `log_max_records`
- `notify_incoming_messages`
- `notify_all_packets`
- `digipeater`
- `igate`
- `selected_satellite_id`
- `selected_channel_id`
- `terrestrial_manual_frequency_hz`

Interpretation:

- `operating_mode` chooses whether APRS target resolution is terrestrial or satellite-driven
- `hamlib_model_id` is used by the USB/serial Dire Wolf path for explicit rig model selection
- `audio_input_device` and `audio_output_device` matter in USB APRS mode, but not in IC-705 Wi‑Fi APRS mode
- `position_fudge_*` offsets are applied to position packets before transmit
- `selected_satellite_id` and `selected_channel_id` define the saved APRS satellite target

## APRS runtime

The APRS runtime is returned by `GET /api/v1/aprs/state` and embedded in `GET /api/v1/system/state`.

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
- `capabilities`
- `owned_resource`
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
- `sidecar_command`
- `output_tail`

Interpretation:

- `transport_mode` is `usb` or `wifi`
- `modem_state` describes the active APRS modem stack, such as `direwolf-rx + native-afsk-tx`
- `capabilities` reports which APRS transport features are currently available
- `output_tail` is the recent Dire Wolf sidecar output used by the APRS console and troubleshooting workflow
- `target` is the currently active APRS target after target resolution and pass gating

## APRS target model

Target resolution feeds:

- `/api/v1/aprs/targets`
- `/api/v1/aprs/select-target`
- `/api/v1/aprs/session/select`
- `/api/v1/aprs/state`
- `system/state.aprsPreviewTarget`

The target state can include:

- `operating_mode`
- `label`
- `sat_id`
- `sat_name`
- `channel_id`
- `channel_label`
- `frequency_hz`
- `uplink_hz`
- `downlink_hz`
- `path_default`
- `region_label`
- `guidance`
- `requires_pass`
- `pass_active`
- `pass_aos`
- `pass_los`
- `corrected_frequency_hz`
- `corrected_uplink_hz`
- `corrected_downlink_hz`
- `correction_side`
- `active_phase`
- `retune_active`
- `can_transmit`
- `tx_block_reason`
- `reason`

Interpretation:

- `corrected_*` values come from the shared Doppler model
- `can_transmit` and `tx_block_reason` are the current APRS gate used to prevent off-pass satellite APRS transmit
- `reason` can carry developer-override or target-resolution context

## APRS logging

OrbitDeck stores APRS receive history in a local JSONL file when APRS logging is enabled:

- `data/aprs/received_log.jsonl`

Supported operations:

- list recent log entries
- clear by age bucket
- export CSV
- export JSON

Log-related settings:

- `log_enabled`
- `log_max_records`
- `notify_incoming_messages`
- `notify_all_packets`

## Digipeater and iGate

Digipeater settings:

- `enabled`
- `aliases`
- `max_hops`
- `dedupe_window_s`
- `callsign_allowlist`
- `path_blocklist`

iGate settings:

- `enabled`
- `server_host`
- `server_port`
- `login_callsign`
- `passcode`
- `filter`
- `connect_timeout_s`
- `gate_terrestrial_rx`
- `gate_satellite_rx`

Policy:

- digipeater mode is disabled by policy for satellite APRS targets
- iGate can remain active for receive when the current target and network conditions allow it
- APRS can auto-enable iGate when internet is available if `igate_auto_enable_with_internet` is enabled

## Dire Wolf integration

OrbitDeck exposes:

- `GET /api/v1/aprs/direwolf/status`
- `POST /api/v1/aprs/direwolf/install`
- `POST /api/v1/aprs/direwolf/install-terminal`

USB APRS behavior:

- Dire Wolf acts as the local TNC/decoder path
- Hamlib PTT configuration is generated explicitly from the selected rig model rather than using `PTT RIG AUTO`

Wi‑Fi APRS behavior:

- Dire Wolf is used in decode-only UDP-audio mode for receive
- OrbitDeck generates Bell 202 AFSK transmit audio itself
- Wi-Fi PTT and TX audio are driven through the IC-705 LAN session

## IC-705 Wi‑Fi APRS transport

The Wi‑Fi APRS path currently targets the IC-705.

Behaviour:

- OrbitDeck opens an IC-705 LAN session for CAT/PTT/audio control
- APRS runtime reports `transport_mode = wifi`
- `control_endpoint` reports the radio LAN control socket
- `audio_rx_active` and `audio_tx_active` expose the current audio path state
- OrbitDeck snapshots the previous radio state before APRS setup
- OrbitDeck restores that state on disconnect and on setup failure

Transport design:

- local OS audio devices are not used in Wi‑Fi APRS mode
- RX audio is forwarded to local UDP for decode-only Dire Wolf receive
- TX uses OrbitDeck-native Bell 202 AFSK modulation plus Wi‑Fi PTT/audio

Operational note:

- Wi‑Fi APRS expects the IC-705 to be in a compatible saved packet/data profile before connect

## Rotator APRS workflow

The rotator APRS scene uses:

- `POST /api/v1/aprs/session/select`
- `system/state.aprsPreviewTarget`

Rotator behaviour:

- APRS-capable pass cards expose `Go to APRS`
- the rotator can pin an APRS scene for the selected target
- APRS satellite targets expose corrected UHF tuning and pass-state gating
- a connected APRS session can keep reapplying UHF Doppler retuning while the pass remains active

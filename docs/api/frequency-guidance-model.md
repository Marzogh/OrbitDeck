# Frequency Guidance

This page documents the backend model behind `GET /api/v1/frequency-guides/recommendation` and the frequency bundles included in other API responses.

## Source data

Frequency guidance profiles are loaded from:

- `data/frequency_guides.json`

At startup, `FrequencyGuideService` reads `profiles[]` from that file and validates each entry into a `FrequencyGuideProfile`.

## Which APIs use this model

The same backend model is used in all of these places:

- `GET /api/v1/frequency-guides/recommendation`
- `GET /api/v1/lite/snapshot`
- `GET /api/v1/system/state`
- `GET /api/v1/passes`

The direct endpoint returns the frequency model on its own. The other three responses embed the same recommendation and matrix data into larger UI-oriented payloads.

## How a recommendation is derived

`FrequencyGuideService.recommendation()` performs these steps:

1. Load the frequency profile for the requested `sat_id`.
2. Resolve the pass phase from the current time and the pass window.
3. Pick the nominal uplink/downlink pair for the selected profile column.
4. Select the nearest `LiveTrack` sample for the current phase.
5. Read `range_rate_km_s` from that track.
6. Apply the correction rules for the profile’s `correction_side`.
7. Quantize the resulting frequencies to the profile step sizes.
8. Return a `FrequencyRecommendation` with the corrected frequencies and the selected column index.

If no profile exists for the requested satellite, the recommendation is `null`.

## How `range_rate_km_s` affects the output

The Doppler shift is calculated from:

- carrier frequency
- line-of-sight range rate in km/s
- the speed of light constant

The implementation is:

```text
shift_hz = (range_rate_m_s / c) * carrier_hz
```

Then:

- downlink correction adds the shift to the nominal downlink
- uplink correction subtracts the shift from the nominal uplink

That sign difference is why the uplink and downlink move in opposite directions when full correction is applied.

## Quantization and step size

After the raw corrected value is computed, OrbitDeck snaps it to the nearest configured step size.

Relevant fields:

- `uplink_step_hz`
- `downlink_step_hz`

The implementation rounds to the nearest step:

```text
snapped = round(hz / step_hz) * step_hz
```

The result is returned in MHz, rounded to three decimal places.

If a step size is zero or invalid, the service falls back to a simple rounded MHz value instead of snapping.

## `correction_side` in practice

The model supports three correction modes:

### `full_duplex`

- Doppler-correct the uplink
- Doppler-correct the downlink

### `downlink_only`

- keep the uplink on the nominal quantized channel
- Doppler-correct only the downlink

### `uhf_only`

Apply Doppler correction only to frequencies at or above 400 MHz.

In practice:

- a VHF uplink with a UHF downlink corrects the downlink only
- a UHF uplink with a VHF downlink corrects the uplink only
- a UHF/UHF pairing would correct both sides
- a VHF/VHF pairing would quantize both sides without Doppler movement

## Which correction modes are currently shipped

The current `data/frequency_guides.json` profiles use:

- `uhf_only`

The current shipped profile set does not include:

- `downlink_only`
- `full_duplex`

So those two modes are supported by the code path but are not currently used by the bundled profile data.

## FM guidance vs linear guidance

### FM

FM profiles use a single nominal uplink/downlink pair.

The recommendation returns:

- one corrected uplink
- one corrected downlink
- no matrix

Typical examples in the shipped profile set:

- `iss-zarya`
- `so50`
- `radfxsat-fox-1b`

### Linear

Linear profiles use a set of selectable columns. Each column represents a nominal uplink choice paired with a corresponding transponder downlink center.

The recommendation returns:

- one selected column
- one corrected uplink/downlink pair for the current phase

The matrix returns:

- one row per pass phase
- one column list describing the available preset choices

Typical examples in the shipped profile set:

- `fo29`
- `rs-44-&-breeze-km-r/b`
- `funcube-1-ao-73`

## `selected_column_index`

For linear satellites, `selected_column_index` identifies which entry in `profile.columns[]` is active.

Selection rules:

1. use the explicitly requested column if it is valid
2. otherwise use `default_column_index` if present
3. otherwise use the middle column

For non-linear profiles, this field may be `null`.

## `phase` and the linear matrix

`resolve_phase()` maps the current point in the pass to one of:

- `aos`
- `early`
- `mid`
- `late`
- `los`

Thresholds:

- `< 20%` of pass progress: `aos`
- `< 40%`: `early`
- `< 60%`: `mid`
- `< 80%`: `late`
- otherwise: `los`

For linear guidance:

- the recommendation uses the current resolved phase
- the matrix computes one row for every phase
- `active_phase` identifies which row corresponds to the current or selected phase

## Track sampling for phase-based guidance

When a pass event and track path are available, the service chooses a `LiveTrack` sample nearest to the target time for each phase.

That means:

- the recommendation uses the current phase sample
- the matrix samples the pass repeatedly, one phase at a time

If no pass event or track path exists, the service falls back to the current live track or to zero range-rate correction.

## Labels in the recommendation

The response label is derived from timing:

- upcoming pass: `AOS cue`
- ongoing pass: `Tune now`
- otherwise: `Reference`

This label is UI-facing metadata, not a separate tuning mode.

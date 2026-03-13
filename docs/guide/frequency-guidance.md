# Frequency Guidance

OrbitDeck computes tuning guidance for satellite passes.

## Shared model

Kiosk, rotator, and lite all use the same backend frequency-guidance model. Shared outputs include:

- downlink recommendations
- uplink guidance
- band labeling
- linear-pass phase data

consistent across all UI surfaces.

## What OrbitDeck returns

Depending on the satellite and pass context, OrbitDeck can return:

- a single recommendation for simpler FM-style operation
- a phase-aware guide matrix for linear transponders
- context-sensitive selected columns for active pass state

Examples:

- ISS APRS-style operation usually resolves to a single FM recommendation
- FO-29 style linear operation can expose a phase matrix that stays stable across the pass while the selected phase changes

The main API route is:

- `GET /api/v1/frequency-guides/recommendation`

The same recommendation structure is also reused by:

- `GET /api/v1/system/state`
- `GET /api/v1/lite/snapshot`
- `GET /api/v1/passes`
- `POST /api/v1/radio/apply`
- rotator radio-control sessions when OrbitDeck resolves a default test pair

For the backend derivation rules, correction modes, phase handling, and matrix behavior, see [Frequency Guidance](../api/frequency-guidance-model.md).

OrbitDeck provides recommendation data for the current pass state. That recommendation can be read directly, shown in the UI, or applied through the radio-control API.

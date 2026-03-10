# Frequency Guidance

OrbitDeck computes operator-facing Doppler guidance, but it does not control radios.

## Shared model

Kiosk, rotator, and lite all use the same backend frequency-guidance model. That keeps:

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

The main API route is:

- `GET /api/v1/frequency-guides/recommendation`

## What OrbitDeck does not do

OrbitDeck is intentionally receive-only. It does not perform:

- CAT control
- rotor control
- PTT automation
- transmit frequency programming

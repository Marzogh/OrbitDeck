# Frequency Guidance

OrbitDeck computes tuning advice for satellite passes, but it does not control radios.

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

Examples:

- ISS APRS-style operation usually resolves to a single FM recommendation
- FO-29 style linear operation can expose a phase matrix that stays stable across the pass while the selected phase changes

The main API route is:

- `GET /api/v1/frequency-guides/recommendation`

## What OrbitDeck does not do

OrbitDeck is intentionally receive-only. It does not perform:

- CAT control
- rotor control
- PTT automation
- transmit frequency programming

That distinction matters for beginners: OrbitDeck tells you what is likely useful to tune, but you still have to do the tuning yourself or use separate radio software.

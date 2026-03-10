# Core Concepts

OrbitDeck is easier to use once a few design choices are clear.

## Receive-only by design

OrbitDeck is not a rig controller.

It does:

- track satellites
- predict passes
- calculate operator-friendly frequency guidance
- surface AMSAT status comparisons
- provide mobile and kiosk dashboards

It does not do:

- CAT control
- rotor control
- PTT
- transmit automation

## Rotator vs kiosk vs lite

These are not duplicate skins.

- `rotator` is the focused tracking view
- `kiosk` is the broader dashboard
- `lite` is the small, fast, mobile-oriented view

If you document or debug OrbitDeck, keep those roles separate.

## Why lite tracks only a few satellites

Lite is intentionally lighter than the full dashboard.

It works from:

- a saved tracked-satellite list
- a cached lite snapshot endpoint
- aggressive UI-side caching and stale-state messaging

That is why lite can stay useful on Pi Zero-class hardware and from a phone over a weak network link.

## Pass filtering vs tracked satellites

OrbitDeck has two separate selection models:

### Kiosk pass filtering

This controls which satellites appear in the kiosk pass workflow.

### Lite tracked satellites

This controls which satellites lite is even allowed to compute and display.

Do not treat these as the same feature.

## Why ISS gets special treatment

OrbitDeck always treats ISS as a special case because it drives:

- ISS display mode
- stream/video eligibility logic
- fallback logic when selecting a default active track

Even when lite is tracking other satellites, ISS-related state can still appear where needed.

## AMSAT status is a clue, not a guarantee

OrbitDeck enriches satellites with AMSAT status comparisons. That is useful, but it is still a summary based on reports:

- helpful for deciding what may be active
- not a guarantee that a pass will be usable
- intentionally cached and refresh-limited

## Frequency guidance is advice, not control

The frequency recommendation system computes what a person probably wants to tune. It does not drive a radio.

Important distinctions:

- FM passes often resolve to a single recommendation
- linear satellites can expose a matrix across pass phases
- correction side may be `uhf_only`, `downlink_only`, or `full_duplex`

# Lite Mode

Lite mode is the low-power and mobile-friendly OrbitDeck workflow.

## Deployment context

Lite is the UI surface intended for:

- Pi Zero-class hardware
- mobile clients
- remote use over weaker network links

## First-run flow

On a clean state, lite requires initial configuration before normal dashboard use.

Required steps:

1. select tracked satellites
2. save the tracked list
3. choose or confirm the location source
4. continue to the dashboard

## Bounded tracking model

Lite does not compute against the full amateur-satellite catalog.

Current rules:

- first run asks the user to choose up to 8 tracked satellites
- `ISS (ZARYA)` is the default preselected choice when available
- the tracked list is persisted through `LiteSettings`
- the lite snapshot endpoint computes for the configured tracked set plus ISS-related state when needed

## Focus behavior

Lite uses a single focus card as the primary presentation element.

- tapping a pass or radio item loads that satellite into focus
- upcoming selected passes show an AOS cue on the compass
- active passes replace the simpler focus presentation with live pass and RF information

Focus sources:

- a saved default focus from lite settings
- a temporary focus from the last tapped pass or radio item

Active passes override both when applicable.

## Offline behavior

Lite uses two client-side caching layers:

- a service worker caches the shell assets and recent GET responses
- `localStorage` keeps the last successful snapshot as an explicit fallback

The UI marks stale snapshot age so cached pass timing is distinguishable from live data.

For the backend lite snapshot contract, in-memory cache key, and invalidation rules, see [Lite Snapshot](../api/lite-snapshot-model.md).

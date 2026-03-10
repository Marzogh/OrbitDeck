# Lite Mode

Lite mode is the low-power and mobile-friendly OrbitDeck workflow.

## Why it exists

The full kiosk and rotator screens are designed for larger displays and more capable hardware. Lite exists so the same backend can still be useful:

- on Pi Zero-class hardware
- from a phone used to remotely check the station
- when connectivity is weak and the UI needs a resilient cached fallback

## What the first run looks like

On a clean state, lite does not dump the full dashboard on a beginner immediately.

The intended flow is:

1. choose tracked satellites
2. save the tracked list
3. choose or confirm the location source
4. open the dashboard

That keeps the Pi Zero and phone workflow understandable instead of presenting a huge list of mostly irrelevant satellites.

## Bounded tracking model

Lite does not ask the backend to compute against the full amateur-satellite catalog.

Instead:

- first run asks the user to choose up to 8 tracked satellites
- `ISS (ZARYA)` is the default preselected choice when available
- the tracked list is persisted through `LiteSettings`
- the lite snapshot endpoint only computes for the configured tracked set plus ISS-related state when needed

## Focus behavior

Lite is built around a single focus card.

- tapping a pass or radio item loads that satellite into focus
- upcoming selected passes show an AOS cue on the compass
- active passes replace the simpler focus presentation with live pass and RF information

There are two focus modes behind the scenes:

- a saved default focus from lite settings
- a temporary focus from the last tapped pass or radio item

Active passes still override both when appropriate.

## Offline behavior

Lite uses two layers of client-side resilience:

- a service worker caches the shell assets and recent GET responses
- `localStorage` keeps the last successful snapshot as an explicit fallback

The UI warns when the cached snapshot is stale so old pass timing is not silently presented as fresh live data.

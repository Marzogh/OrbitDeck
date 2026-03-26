# Lite Pass Ops Log

Last updated: 2026-03-24

This file tracks the `/lite` pass-operations work on branch `othrys/lite-pass-ops`.

## Objective

Rework `/lite` into the primary low-power OrbitDeck surface for a Raspberry Pi Zero 2 W, intended to be used mostly from a mobile browser at the antenna.

Primary goals:
- keep lite bounded and resource-light
- preserve core satellite tracking and pass awareness
- make the focused pass the center of the UI
- support rig control for the focused pass, including Doppler retune
- support operational satellite APRS without pulling terrestrial APRS complexity into lite

## Product Decisions Locked

- Lite tracks up to 5 satellites.
- `ISS (ZARYA)` remains the default initial selection, but is removable.
- Lite is mobile-first and touch-first.
- Lite keeps a 3-section home structure:
  - top summary
  - dominant focus / operations area
  - upcoming passes
- The focused satellite and focused pass are the single source of truth for:
  - focus display
  - RF guidance
  - rig control
  - satellite APRS actions
- User-facing copy avoids the term `unkey`; use `Stop TX` or `Emergency Stop`.

## Implementation Checkpoint

### Lite dashboard

The old lite layout was replaced with a mobile-oriented pass operations surface.

Current structure:
- top summary card
- single focus card with:
  - skyplot
  - live az/el/range or AOS cue
  - compact RF guidance
  - rig control block
  - satellite APRS block
- upcoming passes card

The old separate “radio console” section was removed from lite.

### Lite settings

Lite settings now include:
- tracked satellites
- default focus
- timezone
- location
- GPS
- minimal radio connection settings for lite pass control
- minimal satellite APRS defaults

Terrestrial APRS setup is intentionally not exposed in lite settings.

### Backend

Backend changes completed:
- lite tracked-satellite max reduced from 8 to 5
- lite snapshot enriched with focused radio and APRS state
- lite APRS preview now degrades cleanly instead of failing the whole snapshot
- lite can seed tracked satellites from existing main OrbitDeck pass preferences when the main app has non-default saved favorites
- default main-app ISS-only state does not auto-complete lite setup

### Frontend fallback

Lite now falls back to `/api/v1/satellites` if `/api/v1/settings/lite` does not provide `availableSatellites`, so the tracked-satellite selector still populates.

## Validation Completed

Automated validation run:

- `PYTHONPATH=. pytest tests/test_api.py -q`
- `PYTHONPATH=. pytest tests/test_device_ui.py -q`
- `node --check app/static/lite/lite.js`
- `node --check app/static/lite/settings.js`

Status at this checkpoint:
- backend/API tests passed
- device-ui tests passed
- lite JS syntax checks passed

## Current Branch State

- Branch: `othrys/lite-pass-ops`
- Checkpoint commit:
  - `11bed52a Implement mobile-first lite pass operations surface`

## What Still Needs Manual QA

Manual browser validation is still required for:
- `/lite/settings` tracked satellite population and save flow
- inherited main OrbitDeck preferences showing up in lite where expected
- pass tap -> focus update behavior
- rig flow:
  - connect
  - prepare pass
  - test control
  - confirm
  - arm/start
  - stop
- APRS flow:
  - connect
  - send message/status/position
  - Stop TX
- mobile-width layout and touch-target usability

## Expected Next Step

Run manual QA against `/lite` and `/lite/settings`, then log the concrete bugs and polish issues found during real browser use.

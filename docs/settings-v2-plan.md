# Settings Console Rebuild Plan

## Summary

Build a new `settings-v2` page first, validate it fully, then replace `/settings` only when it is proven. The new page should become the single coherent settings console for OrbitDeck, with one shared radio connection section, APRS settings separated from transport details, a left section nav for tablet/desktop use, and a sticky runtime/debug pane for live troubleshooting.

Design choice:
- Left section nav
- Main content column
- Sticky runtime pane
- Collapsible, hotlinkable sections
- Per-section save

## Key Changes

### 1. Create a new page first
- Add `/settings-v2` with its own HTML/JS wiring.
- Keep the current `/settings` unchanged during the rebuild.
- After validation, promote `settings-v2` to `/settings`.
- Optionally keep the current page on `/settings-legacy` for a transition period.

### 2. Use a tablet-friendly three-region layout
- Left nav:
  - section links only
  - highlights current section
  - supports anchor links like `#radio-connection`, `#location`, `#tracking`, `#display-video`, `#aprs`, `#developer`
- Main content:
  - grouped settings cards
  - each section collapsible
  - targeted hash auto-expands the matching section
- Right runtime pane:
  - sticky on desktop/tablet landscape
  - stacked below content on smaller screens
  - shows live action/result/debug state

Tablet behavior:
- landscape: left nav visible, runtime pane visible
- portrait: section nav collapses into a compact section picker
- small screens: single column, runtime collapsible below content

### 3. Reorganize settings into one coherent hierarchy
Section order:

1. `Radio Connection`
- rig model
- `Connection Type` selector: `USB / Wi‑Fi`
- show only the fields for the selected connection type
- shared radio details:
  - USB mode: serial device, baud, CI-V
  - Wi‑Fi mode: host, username, password, control port, CI-V if still shared
- polling, auto-connect, safe TX guard
- connect/disconnect controls
- shared radio status

2. `Location`
- location source
- browser/manual/GPS/auto inputs
- effective location summary

3. `Tracking`
- tracked satellite
- pass profile
- favorites editor
- any tracking timing controls that still belong in settings

4. `Display / Video`
- display mode
- timezone
- video sources

5. `APRS`
- APRS feature settings only:
  - callsign
  - SSID
  - operating mode
  - terrestrial/satellite options
  - PATH
  - comments
  - listen-only
- show shared radio transport context read-only
- do not expose duplicate USB/Wi‑Fi connection fields here
- include a short `IC-705 Wi‑Fi operator note` block as placeholder text for later expansion

6. `Developer`
- developer overrides
- cache refresh
- advanced/debug tools

### 4. Save model and runtime behavior
- Per-section save buttons only
- No page-wide global save
- Runtime pane shows:
  - latest action
  - latest response/error
  - radio runtime summary
  - APRS runtime summary
- Runtime pane is for debugging visibility only, not configuration

### 5. APRS and radio ownership rules
- Shared radio connection settings live in exactly one place: `Radio Connection`
- APRS consumes those shared settings and displays them read-only
- APRS test page can remain as a test/debug surface, but not the primary place to define connection settings
- No APRS backend changes in this redesign pass

## Test Plan

- `settings-v2` loads current stored settings correctly
- Radio connection can be fully configured from `settings-v2` without using `/radio`
- Switching `Connection Type` between `USB` and `Wi‑Fi` persists correctly
- Only the selected transport’s fields are shown at a time
- APRS no longer shows duplicated connection settings on the main settings page
- Deep links like `/settings-v2#aprs` open the correct section
- Left nav works well on desktop and tablet
- Runtime pane remains visible and readable during saves/connects on desktop and tablet
- Existing `/settings`, `/radio`, and `/aprs` remain functional during the migration

## Assumptions

- `Connection Type` is the clearer label than `Transport`
- Transport-specific fields are conditional, not parallel
- The IC-705 Wi‑Fi note in the APRS section should start as placeholder guidance only
- `settings-v2` should be built and validated before replacing `/settings`
- This pass is strictly a frontend/settings redesign, not a backend rewrite

# Kiosk Rotator Proposal (Review Before Build)

## Goal
Create a fullscreen kiosk mode that auto-cycles through multiple operator-focused pages, with **no settings UI** in the rotation.

## Global Rules (All Screens)
- Fullscreen only (no config controls).
- Shared top status strip: `UTC time`, `local time`, `tracked satellite`, `location source + coordinates`.
- Amateur-radio-only satellite scope (already enforced in backend).
- Auto-rotate timer with per-screen dwell time.
- Smooth transition (fade/slide) between screens.
- If telemetry/video unavailable, show explicit fallback text, never blank.

## Proposed Screen Set

### Screen 1: Live Video Focus
- Only happens when ISS is in sunlight (And other software toggles permit the video) - i.e. not part of rotation unless ISS is in sunlight and kiosk settings actually require video.
- Overrides every other panel - unless a ham satellite is passing >40º over user location. In the latter case, live pass panel overrides everything.
- Primary element: fullscreen livestream panel.
- Overlay (small): sunlit state, above-horizon state, stream source (primary/secondary).
- Footer (small): timestamp + attribution.
- Purpose: passive visual monitoring and public display impact.

### Screen 2: Telemetry Cockpit for ongoing pass
- Overrides all other screens when active pass is ongoing
- Not part of rotation at other times.
- Primary element: large skyplot/compass with tracked satellite vector showing latest upcoming pass with El > 40º + Satellite name. (unless ISS - El min for ISS is 20º)
- Secondary elements: Az/Alt/range, sunlit/visibility badges, body legend, pass time (start, peak, end) in local time.
- Small panel: concise diagnostics (sat ID, beginner-friendly mode/uplink/downlink/bands table for tracked satellite).
- If current pass is ISS and video feed is viewable, then half the screen is the video feed.
- If current pass is the ISS and no video feed or not ISS, then half the screen is a globe with satellite trac like the sen animation
- Purpose: active pointing and pass awareness.

### Screen 3: Telemetry Cockpit for the ISS - upcoming visible pass
- Primary element: large skyplot/compass with tracked satellite vector showing latest upcoming pass with El > 20º.
- Secondary elements: Az/Alt/range, sunlit/visibility badges, body legend, pass time (start, peak, end) in local time.
- Small panel: concise diagnostics (sat ID, beginner-friendly mode/uplink/downlink/bands table for tracked satellite).
- Purpose: active pointing and pass awareness.

### Screen 4: Passes Console
- Primary element: upcoming passes table (24h) with strong row hierarchy.
- Header metrics: `Next AOS in ...`, timezone basis, min elevation threshold.
- Emphasis: current/next pass row highlight.
- Purpose: operational scheduling.

### Screen 5: Telemetry Cockpit for next (first) upcoming pass
- Primary element: large skyplot/compass with tracked satellite vector showing latest upcoming pass with El > 40º + Satellite name.
- Secondary elements: Az/Alt/range, sunlit/visibility badges, body legend, pass time (start, peak, end) in local time.
- Small panel: concise diagnostics (sat ID, beginner-friendly mode/uplink/downlink/bands table for tracked satellite).
- Purpose: active pointing and pass awareness.

### Screen 6: Telemetry Cockpit for next (second) upcoming pass
- Primary element: large skyplot/compass with tracked satellite vector showing latest upcoming pass with El > 40º + Satellite name.
- Secondary elements: Az/Alt/range, sunlit/visibility badges, body legend, pass time (start, peak, end) in local time.
- Small panel: concise diagnostics (sat ID, beginner-friendly mode/uplink/downlink/bands table for tracked satellite).
- Purpose: active pointing and pass awareness.

### Screen 7: Telemetry Cockpit for next (third) upcoming pass
- Primary element: large skyplot/compass with tracked satellite vector showing latest upcoming pass with El > 40º + Satellite name.
- Secondary elements: Az/Alt/range, sunlit/visibility badges, body legend, pass time (start, peak, end) in local time.
- Small panel: concise diagnostics (sat ID, beginner-friendly mode/uplink/downlink/bands table for tracked satellite).
- Purpose: active pointing and pass awareness.

### Screen 8: Telemetry Cockpit for next (fourth) upcoming pass
- Primary element: large skyplot/compass with tracked satellite vector showing latest upcoming pass with El > 40º + Satellite name.
- Secondary elements: Az/Alt/range, sunlit/visibility badges, body legend, pass time (start, peak, end) in local time.
- Small panel: concise diagnostics (sat ID, beginner-friendly mode/uplink/downlink/bands table for tracked satellite).
- Purpose: active pointing and pass awareness.

### Screen 9: Radio Ops (Frequencies)
- Primary element: beginner-friendly mode/uplink/downlink/bands table for all 5 upcoming satellite passes that meet rotator thresholds (`ISS >= 20º`, all other satellites `>= 40º`).
- Secondary element: compact “Primary working channel” line showing info for closest upcoming pass (with satellite name).
- Optional expandable block disabled in kiosk mode (show compact only).
- Purpose: immediate frequency reference for operators.

## Rotation Plan (Initial)
- Screen 1 (Video): Overrides everything else but current pass. Runs as long as ISS is in sunlight and kiosk settings require viewing video.
- Screen 2: Current pass. Lasts the duration of the current pass and shows a live skyplot tracking the passage of the satellite.
- Screen 3 (ISS Telemetry): 15s
- Screen 4 (Passes): 15s
- Screen 5 (Telemetry 2): 15s
- Screen 6 (Telemetry 3): 15s
- Screen 7 (Telemetry 4): 15s
- Screen 8 (Telemetry 5): 15s
- Screen 9 (Radio Ops 6): 15s
- Total loop: 105s (excluding video and current pass screens)

## Behavior Details
- There is only one primary tracked satellite and that is the ISS, the others can be changed in the settings. Leave a placeholder to enable Artemis as a second tracked mission when it launches.
- If video is not eligible (per display mode/sunlit rule), Screen 1 does not appear.
- Screen transitions are simple fades and must preserve readable text (no motion-heavy effects).

## Technical Plan (Implementation)
1. Add new route: `/kiosk-rotator`.
2. Add rotator page + JS scene controller.
3. Reuse existing API polling loop and render into scene-specific components.
4. Add lightweight config constants (durations, enabled screens) in JS.
5. Keep `/` existing kiosk view unchanged until rotator approved.

## Choices made for Codex
1. Keep all screens above
2. Double check video rules
3. Take a note of where map / globe view is being used
4. Preferred dwell times have been noted
5. Ask any question before you do anything.

## Approval
- [ ] Approved as-is
- [x] Approved with edits made in system

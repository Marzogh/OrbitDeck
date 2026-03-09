# Kiosk Rotator Proposal (Review Before Build)

## Goal
Create a fullscreen kiosk mode that auto-cycles through multiple operator-focused pages, with **no settings UI** in the rotation.

## Global Rules (All Screens)
- Fullscreen only (no config controls).
- Shared top status strip: `UTC/local time`, `tracked satellite`, `location source + coordinates`.
- Amateur-radio-only satellite scope (already enforced in backend).
- Auto-rotate timer with per-screen dwell time.
- Smooth transition (fade/slide) between screens.
- If telemetry/video unavailable, show explicit fallback text, never blank.

## Proposed Screen Set

### Screen 1: Live Video Focus
- Primary element: fullscreen livestream panel.
- Overlay (small): sunlit state, above-horizon state, stream source (primary/secondary).
- Footer (small): timestamp + attribution.
- Purpose: passive visual monitoring and public display impact.

### Screen 2: Telemetry Cockpit
- Primary element: large skyplot/compass with tracked satellite vector.
- Secondary elements: Az/Alt/range, sunlit/visibility badges, body legend.
- Optional small panel: concise diagnostics (sat ID, observer lat/lon, UTC used).
- Purpose: active pointing and pass awareness.

### Screen 3: Passes Console
- Primary element: upcoming passes table (24h) with strong row hierarchy.
- Header metrics: `Next AOS in ...`, timezone basis, min elevation threshold.
- Emphasis: current/next pass row highlight.
- Purpose: operational scheduling.

### Screen 4: Radio Ops (Frequencies)
- Primary element: beginner-friendly mode/uplink/downlink/bands table for tracked satellite.
- Secondary element: compact “Primary working channel” line.
- Optional expandable block disabled in kiosk mode (show compact only).
- Purpose: immediate frequency reference for operators.

## Rotation Plan (Initial)
- Screen 1 (Video): 20s
- Screen 2 (Telemetry): 15s
- Screen 3 (Passes): 15s
- Screen 4 (Radio Ops): 12s
- Total loop: 62s

## Behavior Details
- Rotation pauses for 10s after a tracked satellite changes, then resumes.
- If video is not eligible (per display mode/sunlit rule), Screen 1 still appears with telemetry-status fallback text (no dead screen).
- Screen transitions must preserve readable text (no motion-heavy effects).

## Technical Plan (Implementation)
1. Add new route: `/kiosk-rotator`.
2. Add rotator page + JS scene controller.
3. Reuse existing API polling loop and render into scene-specific components.
4. Add lightweight config constants (durations, enabled screens) in JS.
5. Keep `/` existing kiosk view unchanged until rotator approved.

## Open Decisions For You
1. Keep all 4 screens, or remove one?
2. Should video be first every loop, or interleaved?
3. Do you want map view included in V1 (replacing or adding a screen)?
4. Any preferred dwell times?

## Approval
- [ ] Approved as-is
- [ ] Approved with edits noted below

## Edits / Notes
- 

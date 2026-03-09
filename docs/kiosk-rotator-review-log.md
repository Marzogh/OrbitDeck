# Kiosk Rotator Review Log

This file is a running design and UX review log for the kiosk rotator screens.
It is intended to capture observations, improvement ideas, and follow-up notes
before implementation work starts.

## 2026-03-09

### Upcoming Pass Screen Review

#### What was observed
- The screen is functional, but the information hierarchy is weak for kiosk viewing.
- The eye is pulled into three competing elements at once: the background image, the skyplot, and the dense telemetry text block.
- The purpose of the scene, "upcoming pass", does not dominate the screen.
- The telemetry block reads like debug output rather than an operator-focused display.
- The satellite is below the horizon, but that state is not called out explicitly.
- The skyplot feels visually secondary despite being the most informative visual element.
- The frequency table is hard to scan from a distance because the mode descriptions are too verbose.
- The background image is too strong behind the telemetry area and hurts readability.
- The top bar is useful but crowded.
- The body legend is underused and feels detached from the main content.

#### Suggested improvements
- Add a strong status chip near the title, for example: `Below Horizon`, `AOS in ...`, `Max Elevation ...`.
- Replace the raw telemetry paragraph with structured cards:
  - `Now`
  - `Pass Timing`
  - `Satellite`
  - `Radio`
- Make the skyplot larger and visually central.
- Add clearer below-horizon or approaching-pass visual treatment.
- Remove or demote raw debug-style details such as the long UTC diagnostic line and catalog id from the primary presentation.
- Simplify the radio table for kiosk viewing by prioritizing tuning-relevant information over long prose descriptions.
- Add a stronger translucent or blurred panel behind telemetry content.
- Split the top bar into clearer left and right groups and reduce location precision for readability.
- Use color semantically:
  - amber for upcoming/waiting
  - green for live/above horizon
  - muted tones for secondary detail
  - red only for actual problems

#### Implementation direction when work begins
- Refactor the telemetry scene rendering in `app/static/kiosk/rotator.js` so it outputs structured blocks instead of concatenated text lines.
- Add helper formatters for countdowns, status labels, and shortened radio labels.
- Update `app/static/common/styles.css` to support stronger hierarchy, larger plot area, and better content separation from the background.
- Consider scene-specific background treatment for telemetry pages to improve contrast.

#### Final implemented design notes
- The upcoming-pass screen now works as a structured operator view rather than a telemetry dump.
- Final hierarchy:
  - scene title in the upper left
  - large skyplot on the left
  - hero card on the upper right
  - four compact metric cards below the hero
  - one highlighted `Tune Next` card
  - compact `Radio Channels` table at the bottom of the right column
- The hero card now separates two concepts clearly:
  - hero kicker communicates schedule context such as `Approaching Pass`, `Next Pass`, or `Next Pass Later`
  - status pill communicates physical state such as `Below Horizon`
- Countdown is always shown in the hero at high contrast, for example `AOS in 17h 26m`.
- Hero subtitle should stay compact and operational. The final version uses:
  - lighting state
  - maximum elevation
  - best available band/channel summary
- Raw catalog ids and debug-style timestamps should not appear in the main upcoming-pass presentation.
- Metric cards should stay limited to the minimum useful operator set:
  - `Pointing`
  - `Altitude`
  - `Range`
  - `Pass Window`
- `Tune Next` should summarize the primary working channel and promote:
  - uplink
  - downlink
  - band summary
- When uplink or downlink is missing, labels should read naturally:
  - `Downlink only -> UHF 70cm`
  - avoid `Unknown -> ...`
- The channel table should be trimmed to a short list so the right column does not overpower the screen.
- The final upcoming layout uses slightly tighter padding and spacing than the generic telemetry layout to keep the right column visually compact.

#### Reusable pattern for other screens
- Use a strong hero card for the main state of the screen.
- Keep the hero responsible for status, countdown, and identity.
- Use small metric cards for second-order facts.
- Use one highlighted action card for the operator’s next action.
- Put detailed tables last, and shorten them where possible.
- Remove raw diagnostic strings from primary kiosk presentations unless the screen is explicitly a debug or maintenance screen.
- Separate schedule meaning from live physical state:
  - schedule meaning in title or kicker
  - physical state in a pill or badge
- Prefer domain-specific wording over generic telemetry labels when data is incomplete or one-sided.

### Notes
- Future screen reviews should be appended here with date-stamped sections.
- This document is for review history and planning, not implementation tracking.

### Ongoing Pass Screen Review

#### What was observed
- The title is clearer and does indicate that the pass is live.
- The screen still reads more like a technical prototype than an operator-ready kiosk display.
- The live state is not visually dominant enough even though the pass is in progress.
- The skyplot remains useful but too small relative to the available space.
- The live map proxy reads like a placeholder rather than an intentional production panel.
- The telemetry line above the map is still dense and unstructured.
- The diagnostic line under the map still looks like debug output.
- The radio table is hard to scan quickly because the mode descriptions are too long.
- The composition feels split into three unrelated blocks: skyplot, map proxy, and table.
- The background image still competes with the information layer.

#### Suggested improvements
- Add a prominent live badge and countdown, for example:
  - `LIVE PASS`
  - `LOS in ...`
  - `Altitude ...`
- Rework the right side so the map panel feels intentional and labeled.
- Turn the telemetry text into compact cards:
  - `Pointing`
  - `Pass`
  - `Satellite`
- Promote a single highlighted `Tune now` or primary working channel section above secondary radio rows.
- Remove raw ISO timestamps from the main scene.
- If the live map remains minimal, enlarge the skyplot and demote the map rather than keeping both at similar importance.
- Add stronger contrast panels behind the map and radio sections.
- Use stronger live-state color cues so the ongoing screen feels more urgent than the upcoming-pass screen.

#### Implementation direction when work begins
- Give the ongoing-pass view its own stronger render template instead of sharing most of the same telemetry presentation used for upcoming scenes.
- In `app/static/kiosk/rotator.js`, separate live status, structured telemetry cards, current working channel, and map/visualization blocks.
- In `app/static/common/styles.css`, define a dedicated ongoing-pass layout with stronger hierarchy and better panel treatment.

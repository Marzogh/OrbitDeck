# Skycompass Redesign Discussion Log

## Scope

Track appearance-only decisions for the kiosk skycompass so implementation can be done in one batch after approval.

## Decisions And Notes

### 2026-03-09

- Reviewed current skycompass implementation.
- Confirmed the skycompass is an SVG-based azimuth/elevation plot rendered in the kiosk frontend.
- Current live geometry and behavior to preserve unless explicitly changed:
  - azimuth/elevation mapping
  - live target vector behavior
  - movement trail
  - cue text generation
  - fallback celestial body rendering

## Open Design Issues

### Cue line visual hierarchy

- Observation: the cue line currently reads too close to the static plot axes when line weights are similar.
- Risk: users can confuse the live target vector with structural grid lines, especially at a glance.
- Direction under consideration:
  - make the cue line visually distinct from axes using weight, color, opacity, or line treatment
  - reduce ambiguity by making static axes quieter and/or the live vector more intentional
- Initial recommendation:
  - keep the cue line visually stronger than the axes, but not by using the same treatment
  - prefer differentiation by a combination of color and contrast, not thickness alone
  - consider making axes thinner and lower-contrast while keeping the live vector sharper and brighter

## Pending User Input

- User concern logged: "the cue line is too thick; when it is the same thickness as the other lines, it can be confusing"
- Need to decide the target visual hierarchy for:
  - axes
  - live vector
  - trail
  - satellite dot

## Inspiration Shortlist

### 2026-03-09

- Collected external references for skycompass inspiration.
- Shortlist favors a mix of:
  - operator-grade az/el tracker interfaces
  - polished consumer astronomy compass UIs
  - directional guidance interfaces with strong visual hierarchy

- Candidate references to review:
  - Gpredict screenshots and polar-view conventions
  - PstRotator az/el compass-rose UI
  - Night Sky Celestial Compass
  - Sky Guide
  - Moon Seeker flat compass
  - AstroHopper directional guidance UI

- Initial takeaway:
  - operator tools are better references for information hierarchy and control semantics
  - consumer astronomy apps are better references for polish, contrast, and legibility
  - the best redesign direction is likely a hybrid: operational clarity with more intentional visual design

## User-Supplied Reference Review

### 2026-03-09

Reviewed two user-supplied references:

- an alt-az / elevation polar-plot style scientific figure
- a sky map with constellation field and satellite path overlay

### Adaptable ideas from the alt-az / elevation plot

- Strong polar framing:
  - reinforces directional reading immediately
  - useful for making the compass feel more instrument-like
- Radial layering:
  - concentric rings can communicate elevation bands more clearly than the current minimal inner-ring treatment
- Directional emphasis:
  - directional annotations and spoke structure can help distinguish orientation from target path
- Controlled color coding:
  - different line colors can separate static frame, live vector, and historical/path information

### Risks from the alt-az / elevation plot

- Too much analytic linework will make the kiosk harder to read quickly.
- Dense spokes and labels could compete with the live target indicator.
- Scientific chart conventions are useful structurally, but not as a direct visual template.

### Adaptable ideas from the sky map with satellite path overlay

- Predicted path arc:
  - a curved or segmented forecast path is useful if we want more context than the current short trail
- Event labeling:
  - AOS / peak / LOS markers could be useful in a simplified form
- Background depth:
  - subtle astronomical context can make the compass feel more spatial and less abstract
- Target route hierarchy:
  - the reference clearly separates background stars from the active path line

### Risks from the sky map with satellite path overlay

- Full star field and constellation overlays are likely too noisy for kiosk use.
- The current skycompass is an az/el instrument, not a full sky chart; mixing the two too literally will blur its purpose.
- Large amounts of text along the path will hurt glanceability.

### Current recommendation

- Borrow structure from the alt-az plot:
  - clearer elevation bands
  - more intentional radial hierarchy
  - stronger distinction between frame and live target graphics
- Borrow only selected context from the sky map:
  - optional predicted path or simplified pass arc
  - optional event markers for AOS / TCA / LOS
  - avoid star field and constellation clutter in the main kiosk view

### Likely design direction

- Keep the skycompass as an instrument panel, not a planetarium.
- Introduce one additional context layer at most:
  - either elevation bands
  - or simplified predicted arc
  - or pass event markers
- Prefer sparse, high-confidence annotations over decorative astronomical detail.

## Reference Screen Redesign Concepts

### 2026-03-09

Reference screen selected:

- Use the upcoming-passes full-size skycompass as the primary redesign target.
- Mini-compass variants should derive from that design later.

### Option 1: Instrument Panel

Summary:

- Clean operational look with stronger hierarchy and minimal extra decoration.

Core features:

- 3 to 4 concentric elevation bands instead of one inner ring
- softened crosshair axes
- brighter live vector
- smaller, more deliberate target dot
- short recent trail with reduced opacity toward the tail
- slightly larger N/E/S/W labels with cleaner spacing

Benefits:

- fastest to read
- lowest implementation risk
- best fit for kiosk use

Risks:

- may feel conservative if the goal is a more dramatic visual redesign

### Option 2: Tactical Radar

Summary:

- More assertive instrument styling with subtle radar-like energy, while staying readable.

Core features:

- segmented elevation rings
- faint azimuth ticks every 30 degrees
- live vector in a warm accent color
- target dot with halo
- trail rendered as a tapering stroke or dotted wake
- restrained outer glow inside the dial

Benefits:

- stronger character than the current design
- still clearly an operational instrument
- good match for the rest of the kiosk styling

Risks:

- easy to overdo
- too much glow or ticking could make the view noisy

### Option 3: Pass Navigator

Summary:

- Designed around upcoming-pass understanding rather than only current pointing.

Core features:

- standard instrument base plus a simplified forward path arc
- 3 small event markers for AOS, TCA, LOS
- current target remains the highest-contrast element
- optional labels only for the event markers, not along the whole path

Benefits:

- best communicates "where it is going next"
- strongest link to the upcoming-passes context
- could make the screen more useful operationally

Risks:

- adds more information density
- needs careful restraint to avoid chart clutter

### Preferred direction

- Best base option: Instrument Panel
- Best enhancement to layer onto it: a very restrained version of Pass Navigator

Recommended combination:

- start with Option 1 as the foundation
- add one future-path arc only if it remains clearly secondary to the live vector
- do not add star fields or constellation graphics
- keep axes quieter than the live vector
- make the trail more obviously historical than directional

### Proposed visual hierarchy

1. current target dot
2. live vector
3. near-future pass arc or event markers
4. recent trail
5. elevation bands
6. axes and azimuth scaffolding
7. celestial-body markers and legend

### Specific appearance ideas to test later

- axes at lower opacity than every other plotted element
- vector line thinner than today, but higher contrast
- trail in the accent color with fade or dash treatment
- target dot smaller core plus subtle halo
- elevation rings at 30, 60, and horizon
- slightly heavier outer dial boundary than internal rings

## Combined Direction

### 2026-03-09

Decision under discussion:

- Combine the best parts of all three options, but with strict role separation.

### Combined concept

Base layer from Instrument Panel:

- clean concentric elevation bands
- quiet axes and directional scaffolding
- clear target/vector/trail hierarchy

Character layer from Tactical Radar:

- restrained segmented ring treatment or subtle azimuth ticks
- slightly more assertive accent color
- small amount of glow or halo only on the active target

Context layer from Pass Navigator:

- one simplified future pass arc
- optional minimal event markers for AOS, TCA, LOS
- no dense labels riding along the path

### Non-negotiable constraint

- The compass must still read in under one second.

That means:

- current position must remain the most obvious thing
- future path must read as secondary context
- structural grid must stay in the background
- decorative atmosphere must remain subordinate to utility

### Recommended merged hierarchy

1. active satellite dot
2. live vector
3. immediate future path arc
4. recent trail
5. AOS / TCA / LOS markers
6. elevation bands
7. azimuth ticks and axes
8. celestial-body layer

### Best-of-all-worlds version

- instrument-grade readability
- tactical visual identity
- pass-aware context

### Guardrails

- no star-field background in the main compass
- no constellation overlays
- no long text labels inside the dial
- no glow on static grid lines
- no more than one secondary context system inside the plot unless it remains visually quiet

### Practical implementation target later

- Start from Option 1.
- Add Tactical Radar styling only to the active target and ring treatment.
- Add Pass Navigator only as a faint future arc plus tiny event markers.
- If any of those additions interfere with glanceability, remove the added layer rather than compromise the base readability.

## Implementation Notes

### 2026-03-09

Implemented merged redesign on the full-size skyplot:

- added elevation bands for clearer altitude reading
- added azimuth tick scaffolding with lower contrast than the live vector
- reduced structural axis emphasis
- refined target styling with a smaller core and restrained halo
- reduced live vector thickness while increasing contrast
- softened the historical trail so it reads as secondary
- added a short-term forecast arc driven by sampled live track data
- added minimal AOS / TCA / LOS markers only when the sampled future window covers those events

Implementation safety decision:

- future geometry is sampled from the tracking engine rather than faked from pass table data
- if no short-term sampled geometry is available, the forecast layer stays empty

Verification completed:

- Python API tests passed with local package path configured
- Python compile check passed
- JavaScript syntax checks passed for the edited kiosk files

### 2026-03-09 path-led revision

Implemented against the approved spec:

- removed the center-to-satellite line as the primary cue on the reference skycompass
- converted the dial to a path-led model
- added elevation rings at 15°, 30°, 45°, 60°, 75°
- added sparse azimuth degree labels and denser edge ticks with restrained contrast
- split the route into future / past / faded states
- kept the live satellite dot prominent only during an ongoing pass
- hid the live dot for upcoming and post-pass states so the route remains the main cue
- preserved the completed path after LOS and fades it heavily before allowing a later pass to take over
- kept the upcoming-pass table future-only while allowing the dial to reason about ongoing passes internally

## Approved Implementation Spec

### 2026-03-09

Scope:

- This spec applies first to the full-size reference skycompass on the upcoming-passes screen.
- Smaller compass variants should follow later as simplified derivatives.

### Concept

- The compass becomes path-led instead of vector-led.
- The main spatial cue is the projected pass path across the dial.
- The live satellite is shown as a dot travelling along that path during an ongoing pass.
- The center-to-satellite line should be removed in the path-led version.

### Pass lifecycle behavior

Upcoming pass:

- show the projected pass path
- show AOS / TCA / LOS markers
- emphasize the upcoming portion of the route
- do not introduce unrelated next-pass data on the dial

Ongoing pass:

- show the full projected pass path
- place the live satellite dot on the path at the current live position
- split path styling into:
  - completed segment: dimmer
  - remaining segment: brighter or dashed
- optional: keep a very short dim tail behind the dot only if it improves motion readability

After pass:

- do not switch to the next pass on the dial
- fade the path heavily
- allow the completed pass to decay visually rather than abruptly changing context

### On-dial content

Keep on the dial:

- outer horizon ring
- multiple elevation rings
- azimuth edge ticks
- sparse degree markers
- N / E / S / W labels
- one projected pass path
- AOS / TCA / LOS markers
- live satellite dot
- optional very short dim tail behind the dot
- optional celestial body markers only if they remain visually quiet

Keep off the dial:

- diagnostic text
- frequency data
- countdown text
- status chips
- long route labels
- next-pass content
- dense celestial labels

### Dial geometry and reference structure

Elevation:

- add rings at 15°, 30°, 45°, 60°, 75°
- keep the horizon ring as the strongest boundary
- make 30° and 60° slightly stronger than the other internal rings
- keep 15°, 45°, and 75° faint

Azimuth:

- major ticks every 30°
- minor ticks every 10° or 15°
- numeric degree labels only every 30° or 45°
- do not label every tick

Directional labels:

- keep N / E / S / W clearly legible
- directional labels should outrank numeric degree labels

### Visual hierarchy

1. live satellite dot
2. active portion of the projected path
3. AOS / TCA / LOS markers
4. faded or completed portion of the path
5. elevation rings
6. azimuth ticks and degree labels
7. celestial-body layer

### Styling rules

Satellite dot:

- strongest visual element on the dial
- small core with restrained halo
- higher contrast than all static graphics

Projected path:

- primary contextual graphic
- clear enough to follow without overpowering the dot
- active/future portion should be more prominent than completed/past portion

Markers:

- AOS / TCA / LOS should be small and readable
- keep labels compact and close to the markers
- no large marker badges

Grid:

- informative, not decorative
- no heavy glow on static rings or ticks
- avoid equal visual weight across all grid layers

### Constraints and guardrails

- the dial must still be understandable in under one second
- do not turn the compass into a star chart or planetarium
- no constellation overlays
- no full star-field background in the main compass
- no dense interior labeling
- every added ring, tick, or label must justify its presence against clutter

### Functional intent

The finished dial should answer these questions immediately:

- where does this pass begin?
- where does it peak?
- where does it end?
- where is the satellite right now?
- which part of the route is still ahead?

### Label and legend refinements implemented

- Added an explanatory helper line under the dial:
  - `AOS = rise`
  - `TCA = peak`
  - `LOS = set`
- Kept the on-path event labels short so the route itself stays readable.
- Updated the celestial-body legend tokens to match the plotted body markers:
  - colored circular marker
  - symbol overlaid inside the marker
  - body name after the token

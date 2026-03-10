# Core Concepts

OrbitDeck is easier to use once a few design choices are clear.

## OrbitDeck scope

OrbitDeck provides:

- satellite tracking
- pass prediction
- frequency guidance
- AMSAT status comparison
- kiosk, rotator, and lite dashboards

## Rotator vs kiosk vs lite

- `rotator` presents the active or upcoming pass as the primary object on screen
- `kiosk` presents broader station state and pass summary information
- `lite` presents a bounded subset of state for phones and low-power hardware

## Lite tracked-satellite model

Lite operates on a bounded tracked-satellite set.

Relevant behavior:

- the tracked list is stored in `LiteSettings`
- the backend accepts at most 8 valid tracked satellite IDs
- `GET /api/v1/lite/snapshot` computes tracks and passes for that bounded set
- the lite frontend layers browser caching on top of the bounded snapshot payload

This model is the basis for lite operation on Pi Zero-class hardware and mobile clients.

## Pass filtering vs tracked satellites

OrbitDeck has two separate selection models:

### Kiosk pass filtering

This controls which satellites appear in the kiosk pass workflow.

### Lite tracked satellites

This controls which satellites lite is even allowed to compute and display.

They are independent settings with different effects.

## ISS state handling

OrbitDeck always treats ISS as a special case because it drives:

- ISS display mode
- stream/video eligibility logic
- fallback logic when selecting a default active track

Even when lite is tracking other satellites, ISS-related state can still appear where needed.

## AMSAT status model

OrbitDeck enriches satellites with AMSAT status summaries derived from recent reports. Those summaries are cached and refresh-limited.

## Frequency guidance model

The frequency recommendation system computes the frequencies associated with the current pass state and selected profile.

Important distinctions:

- FM passes often resolve to a single recommendation
- linear satellites can expose a matrix across pass phases
- correction side may be `uhf_only`, `downlink_only`, or `full_duplex`

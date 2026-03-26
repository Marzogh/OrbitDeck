# Core Concepts

OrbitDeck gets easier to use once a few product boundaries are clear.

OrbitDeck is not one single screen with cosmetic variants. It has different operating surfaces because the job changes with the hardware. The standard rotator surface is about following one active or upcoming pass as the main thing on screen. Lite is about staying mobile, bounded, and touch-friendly on phones and Pi Zero-class systems.

That difference matters most in satellite selection. Lite does not try to compute against the full amateur-satellite catalog. Instead, it works from a saved tracked set stored in `LiteSettings`, and the backend accepts at most 5 valid tracked satellite IDs for that mode. `GET /api/v1/lite/snapshot` computes tracks and passes only for that bounded set, and the frontend layers browser caching on top of that smaller payload.

This is separate from the main pass-filter system. The full settings surface can filter passes for the standard workflow, but that is not the same thing as lite’s tracked list. The pass filter decides what the main workflow should emphasize. The lite tracked set decides what lite is even allowed to compute.

ISS is also treated as a special case throughout the app. It influences ISS display mode, stream and video eligibility, and some fallback decisions when OrbitDeck chooses what to show first. Even when lite is focused on another satellite, ISS-related state can still appear where the product needs it.

The frequency guidance model is shared across lite, rotator, and the API. FM-style satellites usually resolve to one working recommendation. Linear satellites can expose a phase matrix across the pass. The correction policy can be `uhf_only`, `downlink_only`, or `full_duplex`, depending on the profile.

OrbitDeck also enriches the catalog with AMSAT status summaries built from recent reports. Those enrichments are cached and refresh-limited, so they are intended as useful operating context rather than a guaranteed real-time truth source.

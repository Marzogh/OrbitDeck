# Lite Mode

Lite is the low-power, mobile-first OrbitDeck workflow. It is the intended surface for Pi Zero-class hardware, phone-sized clients, and situations where the network link back to the Pi is weak or intermittent.

On a clean state, lite starts with setup instead of dropping straight into the dashboard. The operator chooses a tracked set of satellites, saves that list, confirms the location source, and then continues into the main view. The tracked set is intentionally bounded to 5 satellites so the backend does not have to compute against the full amateur-satellite catalog on low-power hardware. `ISS (ZARYA)` is preselected when available, but it is not locked in.

Once configured, lite revolves around a single focus card rather than several competing live panels. Tapping a pass or radio item moves that satellite into focus. If the selected pass has not started yet, lite shows an AOS cue on the compass. Once the pass is live, the focus card switches into the fuller pass and RF presentation.

Lite also treats the focused pass as the operator surface. That means the focused view can expose radio-control readiness, a default pair when one exists, or a receive-only downlink target when the satellite does not have a full controllable pair. For APRS-capable satellites, the same focused area can expose APRS target state, transmit gating, and connect or send readiness.

To stay resilient over weaker links, lite keeps two client-side cache layers: a service worker for shell assets and recent GET responses, and a `localStorage` fallback for the last successful snapshot. The UI makes stale age visible so the operator can tell the difference between live data and cached reference data.

For the backend contract and cache behavior behind the lite UI, see [Lite Snapshot](../api/lite-snapshot-model.md).

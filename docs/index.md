# OrbitDeck

OrbitDeck is a cross-platform, receive-only amateur satellite operations dashboard. It combines live tracking, pass prediction, shared Doppler guidance, AMSAT operational-status comparison, and multiple operator-facing web surfaces behind a FastAPI backend.

This documentation set is organized for:

- operators running OrbitDeck on macOS or Raspberry Pi
- contributors extending routes, settings, and UI behavior

## Start Here

- Use [Quick Start](guide/quickstart.md) to get a local instance running quickly.
- Use [Platforms](guide/platforms.md) if you want the macOS vs Raspberry Pi behavior spelled out.
- Use [UI Surfaces](guide/ui-surfaces.md) to understand what `/`, `/kiosk`, `/lite`, `/lite/settings`, and `/settings` are each for.
- Use [HTTP API](api/http-api.md) for the current public route map.

## Product Summary

- `/` serves the rotator/operator landing surface on standard hardware.
- `/kiosk` serves the original main kiosk dashboard.
- `/lite` serves the low-power and mobile-oriented dashboard.
- `/lite/settings` serves the lite-specific configuration surface.
- `/settings` serves kiosk settings on standard hardware and lite settings on Pi Zero-class hardware.
- Pi Zero-class hardware is forced into lite-oriented routing automatically.

## Project Links

- Repository: <https://github.com/Marzogh/OrbitDeck>
- Main install guide: [Install / Build / Run](INSTALL_AND_RUN.md)

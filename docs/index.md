# OrbitDeck

OrbitDeck is a cross-platform dashboard for amateur radio satellites. It provides pass timing, tracking, frequency guidance, APRS operation, AMSAT status comparison, and radio-control surfaces backed by one FastAPI service.

This documentation set covers:

- installation and operation on macOS and Raspberry Pi
- implementation details relevant to contributors

## Start Here

- Use [Quick Start](guide/quickstart.md) to get a local instance running quickly.
- Use [First Hour](guide/first-hour.md) for a first-run workflow from startup to pass tracking.
- Use [Common Tasks](guide/common-tasks.md) for the everyday operator actions.
- Use [Core Concepts](guide/concepts.md) when you want the app explained in plain terms.
- Use [Glossary](guide/glossary.md) if a radio or satellite term is unfamiliar.
- Use [Platforms](guide/platforms.md) for the macOS and Raspberry Pi deployment model.
- Use [UI Surfaces](guide/ui-surfaces.md) to understand what `/`, `/lite`, `/lite/settings`, `/aprs`, and `/settings` are each for.
- Use [HTTP API](api/http-api.md) for the current public route map.

## Product Summary

- `/` opens the focused tracking screen on standard hardware.
- `/lite` opens the phone-friendly and low-power screen.
- `/lite/settings` opens the lite setup and configuration screen.
- `/aprs` opens the APRS console and test surface.
- `/settings` opens the combined settings console on standard hardware and lite settings on Pi Zero-class hardware.
- Pi Zero-class hardware is switched into lite-oriented routing automatically.

## Project Links

- Repository: <https://github.com/Marzogh/OrbitDeck>
- Main install guide: [Install / Build / Run](INSTALL_AND_RUN.md)

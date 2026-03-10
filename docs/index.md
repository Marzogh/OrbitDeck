# OrbitDeck

OrbitDeck is a cross-platform dashboard for following amateur radio satellites. It shows where satellites are, when they will pass overhead, what frequencies are useful, and how the different web screens fit together.

This documentation set is meant for:

- people trying to install and use OrbitDeck on macOS or Raspberry Pi
- contributors who want to understand how the app is put together

## Start Here

- Use [Quick Start](guide/quickstart.md) to get a local instance running quickly.
- Use [First Hour](guide/first-hour.md) if you want a beginner walkthrough from first boot to first real pass workflow.
- Use [Common Tasks](guide/common-tasks.md) for the everyday operator actions.
- Use [Core Concepts](guide/concepts.md) when you want the app explained in plain terms.
- Use [Glossary](guide/glossary.md) if a radio or satellite term is unfamiliar.
- Use [Platforms](guide/platforms.md) if you want the macOS vs Raspberry Pi behavior spelled out.
- Use [UI Surfaces](guide/ui-surfaces.md) to understand what `/`, `/kiosk`, `/lite`, `/lite/settings`, and `/settings` are each for.
- Use [HTTP API](api/http-api.md) for the current public route map.

## Product Summary

- `/` opens the focused tracking screen on standard hardware.
- `/kiosk` opens the wider dashboard screen.
- `/lite` opens the phone-friendly and low-power screen.
- `/lite/settings` opens the lite setup and configuration screen.
- `/settings` opens kiosk settings on standard hardware and lite settings on Pi Zero-class hardware.
- Pi Zero-class hardware is switched into lite-oriented routing automatically.

## Project Links

- Repository: <https://github.com/Marzogh/OrbitDeck>
- Main install guide: [Install / Build / Run](INSTALL_AND_RUN.md)

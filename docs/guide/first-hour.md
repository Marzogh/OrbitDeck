# First Hour

This walkthrough is the shortest sensible path from first launch to a real pass workflow.

## 0-10 minutes: start the server

On macOS or Linux, create the virtual environment, install the requirements, and launch OrbitDeck:

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 scripts/run_tracker.py --mode windowed --ui kiosk --host 127.0.0.1 --port 8000
```

The launcher should open the browser. If it does not, open `/`, `/lite`, and `/docs` manually on `127.0.0.1:8000`.

## 10-20 minutes: understand the two main operating surfaces

Start with `/`. On standard hardware that is the main rotator landing surface, and it is the best place to see one active or upcoming pass with its geometry, timing, and RF guidance together.

Then open `/lite`. Lite is the mobile-first and Pi Zero-safe surface. It is the better place to understand the bounded, focused workflow the project now uses for low-power hardware and phone access.

## 20-35 minutes: set the observer location

OrbitDeck is only as useful as its observer location. On standard hardware, open `/settings` and choose browser location, manual coordinates, or GPS-backed location. On lite, open `/lite/settings` and choose the current Pi setting, phone location, manual coordinates, or Pi GPS. If you choose GPS, the extra USB or Bluetooth GPS fields appear there.

## 35-45 minutes: configure lite tracking

Open `/lite/settings` and save a tracked-satellite list. Lite requires at least one valid satellite and allows at most 5. `ISS (ZARYA)` is the default starting point when the catalog has it available. This limit is deliberate: lite stays usable on low-power hardware by only computing against that small saved set.

## 45-60 minutes: run a real pass workflow

Open `/lite`, tap a pass or radio card, and confirm that the focus card becomes the working view. The compass should update for the selected satellite. If the pass is still upcoming, you should see the AOS cue. If the pass is active, the focus card should switch into the live pass and RF presentation.

To check the shared frequency model directly, open `/api/v1/frequency-guides/recommendation?sat_id=iss-zarya` and confirm you get a live Doppler-aware payload back.

## What success looks like

By the end of the first hour, you should know which screen is meant for which job, where OrbitDeck is getting its observer location from, how lite differs from the full rotator workflow, and where to inspect the live API contract.

# First Hour

This walkthrough is for someone who has just cloned OrbitDeck and wants to get from "the server starts" to "I know which screen to use and what I am looking at."

## 0-10 minutes: Start the server

On macOS or Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 scripts/run_tracker.py --mode windowed --ui kiosk --host 127.0.0.1 --port 8000
```

If that command works, OrbitDeck is running. The launcher should open a browser window. If it does not, open these manually:

- <http://127.0.0.1:8000/>
- <http://127.0.0.1:8000/kiosk>
- <http://127.0.0.1:8000/lite>
- <http://127.0.0.1:8000/docs>

## 10-20 minutes: Understand the main screens

Open each of these once:

### Rotator landing: `/`

Use this when you want the focused tracking view. This is the best screen for:

- tracking one current or upcoming pass
- seeing where the pass moves through the sky
- reading the Doppler guidance and RF details for a pass

### Kiosk dashboard: `/kiosk`

Use this when you want a broader status dashboard on a larger display.

### Lite: `/lite`

Use this when you want:

- a phone-friendly remote screen
- a Pi Zero-friendly screen
- cached behavior if the network drops briefly

## 20-35 minutes: Set the location correctly

OrbitDeck is only useful if your location is correct.

### On the full settings screen

Open `/settings` on standard hardware and choose one of:

- browser location
- manual coordinates
- GPS

### On lite settings

Open `/lite/settings` and choose:

- `Current Pi setting`
- `Use this phone's location`
- `Enter coordinates manually`
- `Use Pi GPS receiver`

If you choose GPS, extra setup fields appear for USB or Bluetooth GPS.

## 35-45 minutes: Pick what lite should track

On `/lite/settings`, save a tracked list of satellites.

Rules:

- at least one satellite must be selected
- at most 8 satellites can be selected
- `ISS (ZARYA)` is the default first choice when available

This matters because lite intentionally limits itself to a small tracked set to stay usable on low-power hardware.

## 45-60 minutes: Try a real pass workflow

Use this checklist:

1. Open `/lite`.
2. Tap a pass card or radio card.
3. Confirm the screen snaps back to the focus card.
4. Confirm the compass/skyplot updates for that selected satellite.
5. If a pass is active, confirm the focus card switches into live pass and RF detail mode.
6. Open `/api/v1/frequency-guides/recommendation?sat_id=iss-zarya` and confirm you get a live Doppler-aware recommendation payload.

If those steps work, the main user journey is healthy.

## What success looks like

By the end of the first hour, you should be able to answer these questions:

- which OrbitDeck screen is for which job
- where OrbitDeck is getting its observer location from
- how lite differs from kiosk and rotator
- how to inspect passes and frequency guidance
- where the built-in API docs live

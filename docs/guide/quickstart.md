# Quick Start

This page provides the shortest path from clone to a running OrbitDeck instance. For a full first-run workflow, continue with [First Hour](first-hour.md).

## macOS

OrbitDeck has been tested on macOS for local development and windowed browser use.

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 scripts/run_tracker.py --mode windowed --ui kiosk --host 127.0.0.1 --port 8000
```

Open:

- Rotator landing UI: <http://127.0.0.1:8000/>
- Kiosk UI: <http://127.0.0.1:8000/kiosk>
- Lite UI: <http://127.0.0.1:8000/lite>
- Lite settings UI: <http://127.0.0.1:8000/lite/settings>
- Radio control UI: <http://127.0.0.1:8000/radio>
- Rotator UI: <http://127.0.0.1:8000/kiosk-rotator>
- Settings UI: <http://127.0.0.1:8000/settings>
- API docs: <http://127.0.0.1:8000/docs>

Initial routes to check:

1. `/` for the rotator landing view
2. `/settings` to confirm the standard settings-v2 console loads
3. `/lite/settings` to set location and tracked satellites
4. `/aprs` to confirm the APRS console loads
5. `/lite` to confirm the mobile view behaves as expected

## Raspberry Pi

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 scripts/run_tracker.py --mode kiosk --ui kiosk --host 0.0.0.0 --port 8000
```

Open from another device:

- Rotator landing UI: `http://<pi-ip>:8000/`
- Kiosk UI: `http://<pi-ip>:8000/kiosk`
- Lite UI: `http://<pi-ip>:8000/lite`
- Lite settings UI: `http://<pi-ip>:8000/lite/settings`
- Radio control UI: `http://<pi-ip>:8000/radio`
- Rotator UI: `http://<pi-ip>:8000/kiosk-rotator`
- Settings UI: `http://<pi-ip>:8000/settings`
- API docs: `http://<pi-ip>:8000/docs`

## Direct server-only alternative

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Use the launcher for browser-opening behavior. Use direct `uvicorn` for the API server only.

## Verification

Expected results:

- `/health` returns `{"ok": true, ...}`
- `/docs` opens FastAPI Swagger UI
- `/api/v1/system/state` returns JSON
- `/lite/settings` loads and shows a tracked-satellite selector
- `/lite` loads without JavaScript errors

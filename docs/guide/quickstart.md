# Quick Start

## Who this is for

Use this page if you want the shortest path from clone to a running OrbitDeck instance. If you want more explanation while doing it, continue with [First Hour](first-hour.md).

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
- Rotator UI: <http://127.0.0.1:8000/kiosk-rotator>
- Settings UI: <http://127.0.0.1:8000/settings>
- API docs: <http://127.0.0.1:8000/docs>

After the server opens, these are the most useful first clicks:

1. `/` for the rotator landing view
2. `/lite/settings` to set location and tracked satellites
3. `/lite` to confirm the mobile view behaves as expected

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

Use the launcher when you want OrbitDeck to open a browser window for you. Use direct `uvicorn` when you only want the API server.

## Quick sanity checklist

If OrbitDeck is working, all of these should be true:

- `/health` returns `{"ok": true, ...}`
- `/docs` opens FastAPI Swagger UI
- `/api/v1/system/state` returns JSON
- `/lite/settings` loads and shows a tracked-satellite selector
- `/lite` loads without JavaScript errors

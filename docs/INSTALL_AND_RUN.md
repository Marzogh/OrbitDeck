# OrbitDeck Install / Build / Run Guide

This app uses one Python 3 codebase across Raspberry Pi and desktop platforms.

- Raspberry Pi: run kiosk full-screen mode
- Desktop: run windowed mode for testing

## 1) Prerequisites

### Raspberry Pi (recommended)
- Raspberry Pi OS Bookworm (Desktop)
- Python 3.11+
- Chromium browser
- Internet access for CelesTrak/SatNOGS refresh
- Optional: GPS dongle and NetworkManager (`nmcli`) for AP fallback scripts

### Desktop
- Python 3.11+
- Any browser (Chrome/Safari/Firefox)

## 2) Clone and install

```bash
git clone <your-repo-url> orbitdeck
cd orbitdeck
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
```

## 3) Run in development

### On desktop (windowed)
```bash
source .venv/bin/activate
python3 scripts/run_tracker.py --mode windowed --ui kiosk --host 127.0.0.1 --port 8000
```

Alternative lite UI:
```bash
python3 scripts/run_tracker.py --mode windowed --ui lite --host 127.0.0.1 --port 8000
```

### On Raspberry Pi (local test)
```bash
source .venv/bin/activate
python3 scripts/run_tracker.py --mode kiosk --ui kiosk --host 0.0.0.0 --port 8000
```

## 4) Raspberry Pi production install (systemd)

These steps set up API + kiosk auto-start at boot.

### 4.1 Install app under `/opt/orbitdeck`
```bash
sudo mkdir -p /opt/orbitdeck
sudo chown -R $USER:$USER /opt/orbitdeck
rsync -av --delete ./ /opt/orbitdeck/
cd /opt/orbitdeck
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
```

### 4.2 Install systemd units
```bash
sudo cp scripts/orbitdeck_api.service /etc/systemd/system/
sudo cp scripts/pi_kiosk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable orbitdeck_api.service
sudo systemctl enable pi_kiosk.service
sudo systemctl start orbitdeck_api.service
sudo systemctl start pi_kiosk.service
```

### 4.3 Check service health
```bash
sudo systemctl status orbitdeck_api.service --no-pager
sudo systemctl status pi_kiosk.service --no-pager
curl http://localhost:8000/health
```

## 5) Optional AP fallback networking

A helper script is included: `scripts/network_fallback.sh`

- It tries known Wi-Fi profiles first
- If none connect, it activates AP profile `OrbitDeck-AP`

Run manually:
```bash
bash scripts/network_fallback.sh
```

You can call this from a boot-time service or NetworkManager dispatcher script.

## 6) Data refresh behavior (Tx/Rx frequencies)

- On each web page load (`/` and `/lite`), the UI requests:
  - `GET /api/v1/satellites?refresh_from_sources=true`
- This attempts to pull fresh CelesTrak + SatNOGS data
- If refresh fails (offline/no internet), cached catalog remains active

Manual refresh endpoint:
```bash
curl -X POST http://localhost:8000/api/v1/datasets/refresh
```

## 7) Test

```bash
source .venv/bin/activate
python3 -m pytest -q
```

## 8) Useful URLs

- Kiosk UI: `http://<host>:8000/`
- Lite UI: `http://<host>:8000/lite`
- OpenAPI docs: `http://<host>:8000/docs`

## 9) Notes

- Receive-only application: no rotor/PTT/CAT/transmit control
- ISS display modes remain available in kiosk and lite UI where rendered
- State is persisted to `data/state.json`

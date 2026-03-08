# ISS Tracker Install / Build / Run Guide (Raspberry Pi + macOS)

This app uses one Python 3 codebase for both Raspberry Pi and macOS.

- Raspberry Pi: run kiosk full-screen mode
- macOS: run windowed mode for testing

## 1) Prerequisites

### Raspberry Pi (recommended)
- Raspberry Pi OS Bookworm (Desktop)
- Python 3.11+
- Chromium browser
- Internet access for CelesTrak/SatNOGS refresh
- Optional: GPS dongle and NetworkManager (`nmcli`) for AP fallback scripts

### macOS
- Python 3.11+
- Any browser (Chrome/Safari/Firefox)

## 2) Clone and install

```bash
git clone <your-repo-url> iss-tracker
cd iss-tracker
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
```

## 3) Run in development

### On macOS (windowed)
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

### 4.1 Install app under `/opt/iss-tracker`
```bash
sudo mkdir -p /opt/iss-tracker
sudo chown -R $USER:$USER /opt/iss-tracker
rsync -av --delete ./ /opt/iss-tracker/
cd /opt/iss-tracker
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
```

### 4.2 Install systemd units
```bash
sudo cp scripts/iss_tracker_api.service /etc/systemd/system/
sudo cp scripts/pi_kiosk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable iss_tracker_api.service
sudo systemctl enable pi_kiosk.service
sudo systemctl start iss_tracker_api.service
sudo systemctl start pi_kiosk.service
```

### 4.3 Check service health
```bash
sudo systemctl status iss_tracker_api.service --no-pager
sudo systemctl status pi_kiosk.service --no-pager
curl http://localhost:8000/health
```

## 5) Optional AP fallback networking

A helper script is included: `scripts/network_fallback.sh`

- It tries known Wi-Fi profiles first
- If none connect, it activates AP profile `ISS-Tracker-AP`

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
- ISS display modes available in both kiosk and lite UI
- State is persisted to `data/state.json`

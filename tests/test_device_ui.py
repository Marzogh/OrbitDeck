from fastapi.testclient import TestClient

import app.main as main
from app.device import device_class, lite_only_ui
from app.services import DataIngestionService, TrackingService
from app.store import StateStore


def make_client(tmp_path):
    main.store = StateStore(str(tmp_path / "state.json"))
    main.tracking_service = TrackingService(str(tmp_path / "latest_catalog.json"))
    main.ingestion_service = DataIngestionService()
    return TestClient(main.app)


def test_device_class_env_override(monkeypatch):
    monkeypatch.setenv("ISS_TRACKER_DEVICE_CLASS", "pi-zero")
    assert device_class() == "pi-zero"
    assert lite_only_ui() is True


def test_root_serves_lite_ui_when_pi_zero_forced(tmp_path, monkeypatch):
    monkeypatch.setenv("ISS_TRACKER_DEVICE_CLASS", "pi-zero")
    client = make_client(tmp_path)

    resp = client.get("/")
    assert resp.status_code == 200
    assert "Remote Ops Lite" in resp.text


def test_rotator_serves_lite_ui_when_pi_zero_forced(tmp_path, monkeypatch):
    monkeypatch.setenv("ISS_TRACKER_DEVICE_CLASS", "pi-zero")
    client = make_client(tmp_path)

    resp = client.get("/kiosk-rotator")
    assert resp.status_code == 200
    assert "Remote Ops Lite" in resp.text

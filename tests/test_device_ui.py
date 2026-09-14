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


def test_settings_serves_lite_ui_when_pi_zero_forced(tmp_path, monkeypatch):
    monkeypatch.setenv("ISS_TRACKER_DEVICE_CLASS", "pi-zero")
    client = make_client(tmp_path)

    resp = client.get("/settings")
    assert resp.status_code == 200
    assert "Lite Settings" in resp.text


def test_lite_settings_route_serves_lite_settings_ui(tmp_path, monkeypatch):
    monkeypatch.setenv("ISS_TRACKER_DEVICE_CLASS", "pi-zero")
    client = make_client(tmp_path)

    resp = client.get("/lite/settings")
    assert resp.status_code == 200
    assert "Lite Settings" in resp.text


def test_next_route_serves_operator_workspace(tmp_path):
    client = make_client(tmp_path)

    resp = client.get("/next")

    assert resp.status_code == 200
    assert "OrbitDeck Operator Workspace" in resp.text
    assert "/static/next/next.js" in resp.text
    assert 'id="worldMap"' in resp.text
    assert "World map" in resp.text
    assert 'data-basemap="terrain"' in resp.text
    assert 'data-basemap="satellite"' in resp.text
    assert 'data-basemap="outline"' in resp.text
    assert 'id="channelPairSelect"' in resp.text
    assert 'id="releaseSession"' in resp.text
    assert 'id="radioSetupDialog"' in resp.text
    assert "Save and connect" in resp.text
    assert "Open satellite APRS" in resp.text

    script = client.get("/static/next/next.js")
    assert script.status_code == 200
    assert 'api("/api/v1/aprs/targets")' in script.text
    assert 'txAuthorization.authorize({ capability: `aprs-${kind}` })' in script.text
    assert 'data-aprs-send="message"' in script.text

from fastapi.testclient import TestClient

import app.main as main
from app.models import IssDisplayMode, Satellite
from app.services import DataIngestionService, TrackingService
from app.store import StateStore


def make_client(tmp_path):
    main.store = StateStore(str(tmp_path / "state.json"))
    main.tracking_service = TrackingService(str(tmp_path / "latest_catalog.json"))
    main.ingestion_service = DataIngestionService()
    return TestClient(main.app)


def test_set_and_get_iss_mode(tmp_path):
    client = make_client(tmp_path)

    r0 = client.get("/api/v1/settings/iss-display-mode")
    assert r0.status_code == 200
    assert r0.json()["mode"] == IssDisplayMode.sunlit_and_visible_video.value

    r1 = client.post("/api/v1/settings/iss-display-mode", json={"mode": "TelemetryOnly"})
    assert r1.status_code == 200
    assert r1.json()["mode"] == "TelemetryOnly"

    r2 = client.get("/api/v1/settings/iss-display-mode")
    assert r2.status_code == 200
    assert r2.json()["mode"] == "TelemetryOnly"


def test_iss_state_shape(tmp_path):
    client = make_client(tmp_path)

    resp = client.get("/api/v1/iss/state")
    assert resp.status_code == 200
    payload = resp.json()

    assert "issTrack" in payload
    assert "state" in payload
    assert set(payload["state"].keys()) == {
        "sunlit",
        "aboveHorizon",
        "mode",
        "videoEligible",
        "streamHealthy",
        "activeStreamUrl",
    }


def test_location_manual_profile(tmp_path):
    client = make_client(tmp_path)

    resp = client.post(
        "/api/v1/location",
        json={
            "source_mode": "manual",
            "add_profile": {
                "id": "home",
                "name": "Home",
                "point": {"lat": -27.4698, "lon": 153.0251, "alt_m": 25},
            },
            "selected_profile_id": "home",
        },
    )
    assert resp.status_code == 200

    get_resp = client.get("/api/v1/location")
    assert get_resp.status_code == 200
    loc = get_resp.json()["resolved"]
    assert loc["source"] == "manual"
    assert round(loc["lat"], 4) == -27.4698
    assert round(loc["lon"], 4) == 153.0251


def test_set_and_get_gps_settings(tmp_path):
    client = make_client(tmp_path)

    resp = client.post(
        "/api/v1/settings/gps",
        json={
            "connection_mode": "bluetooth",
            "bluetooth_address": "AA:BB:CC:DD:EE:FF",
            "bluetooth_channel": 2,
            "serial_device": "/dev/ttyUSB9",
            "baud_rate": 4800,
        },
    )
    assert resp.status_code == 200

    get_resp = client.get("/api/v1/settings/gps")
    assert get_resp.status_code == 200
    state = get_resp.json()["state"]
    assert state["connection_mode"] == "bluetooth"
    assert state["bluetooth_address"] == "AA:BB:CC:DD:EE:FF"
    assert state["bluetooth_channel"] == 2
    assert state["serial_device"] == "/dev/ttyUSB9"
    assert state["baud_rate"] == 4800


def test_satellites_refresh_flag_uses_ingestion(tmp_path):
    client = make_client(tmp_path)

    class FakeIngestion:
        def refresh_catalog(self):
            return (
                [
                    Satellite(
                        sat_id="fake-1",
                        norad_id=99999,
                        name="FAKE-SAT",
                        has_amateur_radio=True,
                        transponders=["U/V FM repeater"],
                        repeaters=["Uplink 145.000 MHz / Downlink 435.000 MHz"],
                    )
                ],
                {"count": 1},
            )

    old = main.ingestion_service
    try:
        main.ingestion_service = FakeIngestion()
        resp = client.get("/api/v1/satellites?refresh_from_sources=true")
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["refreshed"] is True
        assert payload["count"] >= 1
        fake = next(item for item in payload["items"] if item["sat_id"] == "fake-1")
        assert fake["transponders"][0] == "U/V FM repeater"
    finally:
        main.ingestion_service = old


def test_iss_state_works_with_noncanonical_iss_id(tmp_path):
    client = make_client(tmp_path)

    class FakeIngestion:
        def refresh_catalog(self):
            return (
                [
                    Satellite(
                        sat_id="iss-zarya",
                        norad_id=25544,
                        name="ISS (ZARYA)",
                        is_iss=True,
                        has_amateur_radio=True,
                        transponders=["145.990 MHz downlink"],
                        repeaters=["437.800 MHz APRS"],
                    )
                ],
                {"count": 1},
            )

    old = main.ingestion_service
    try:
        main.ingestion_service = FakeIngestion()
        r1 = client.get("/api/v1/satellites?refresh_from_sources=true")
        assert r1.status_code == 200
        r2 = client.get("/api/v1/system/state")
        assert r2.status_code == 200
        assert "issTrack" in r2.json()
    finally:
        main.ingestion_service = old

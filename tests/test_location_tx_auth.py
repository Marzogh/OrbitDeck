"""Joint authorization and station-location checks. All RF sends are replaced."""
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.aprs.service import AprsService
from app.models import AprsRuntimeState, GeoPoint
from app.radio.service import RigControlService
from app.store import StateStore
from app.tx_auth import TxAuthManager


@pytest.fixture
def station(tmp_path, monkeypatch):
    main.radio_control_service.reset_runtime()
    monkeypatch.setattr(main, "store", StateStore(tmp_path / "state.json"))
    monkeypatch.setattr(main, "radio_control_service", RigControlService())
    monkeypatch.setattr(main, "aprs_service", AprsService())
    monkeypatch.setattr(main, "tx_auth", TxAuthManager(tmp_path / "auth.json", tmp_path / "secret", pin_iterations=1000))
    clients = [TestClient(main.app, headers={"X-OrbitDeck-Session": name}) for name in ("first", "second")]
    captured = []
    for kind in ("message", "status", "position"):
        def send(settings, payload, *location, kind=kind):
            captured.append((kind, payload, location[0] if location else None))
            return AprsRuntimeState()
        monkeypatch.setattr(main.aprs_service, f"send_{kind}", send)
    clients[0].post("/api/v1/settings/aprs", json={"callsign": "VK4ABC"})
    yield clients[0], clients[1], captured
    main.radio_control_service.reset_runtime()


def publish(client, lat, age=0):
    response = client.post("/api/v1/location", json={"browser_location": {
        "lat": lat, "lon": 2, "accuracy_m": 5,
        "timestamp": (datetime.now(UTC) - timedelta(seconds=age)).isoformat(),
    }})
    assert response.status_code == 200


def setup(client):
    assert client.post("/api/v1/tx-auth/setup", json={"pin": "1234"}).status_code == 200


@pytest.mark.parametrize("kind,payload", [("message", {"to": "VK4XYZ", "text": "test"}),
    ("status", {"text": "test"}), ("position", {"comment": "test"})])
def test_location_owner_still_needs_tx_pin_and_locked_send_does_not_claim(station, kind, payload):
    first, second, sent = station
    publish(first, 10)
    response = first.post(f"/api/v1/aprs/send/{kind}", json=payload)
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "tx_auth_setup_required"
    assert main.radio_control_service.locations.owner is None
    assert first.post("/api/v1/location/control/claim").status_code == 200
    assert first.post(f"/api/v1/aprs/send/{kind}", json=payload).status_code == 401
    setup(first)
    assert first.post(f"/api/v1/aprs/send/{kind}", json=payload).status_code == 200
    assert len(sent) == 1
    assert first.post("/api/v1/tx-auth/lock").status_code == 200
    assert first.get("/api/v1/location").json()["controlOwner"]
    assert first.post(f"/api/v1/aprs/send/{kind}", json=payload).status_code == 401
    assert len(sent) == 1


def test_distinct_tx_and_location_owners_cannot_transmit_until_explicit_handoff(station):
    first, second, sent = station
    setup(first)
    publish(first, 10)
    publish(second, 50)
    assert second.post("/api/v1/location/control/claim").status_code == 200
    assert first.post("/api/v1/aprs/send/position", json={}).status_code == 409
    assert second.post("/api/v1/aprs/send/position", json={}).status_code == 401
    assert second.post("/api/v1/tx-auth/unlock", json={"pin": "1234"}).status_code == 409
    assert not sent
    assert first.get("/api/v1/location").json()["stationResolved"]["lat"] == 50
    assert second.post("/api/v1/location/control/release").status_code == 200
    assert first.post("/api/v1/location/control/claim").status_code == 200
    response = first.post("/api/v1/aprs/send/position", json={"latitude": 88, "longitude": 99})
    assert response.status_code == 200
    assert sent[0][1].latitude == sent[0][2].lat == 10
    assert second.get("/api/v1/location").json()["resolved"]["lat"] == 50


def test_location_expiry_does_not_expire_or_transfer_tx_cookie(station, monkeypatch):
    first, second, sent = station
    setup(first)
    publish(first, 10)
    publish(second, 50)
    first.post("/api/v1/location/control/claim")
    sessions = main.radio_control_service.locations
    sessions._seen -= sessions.OWNER_LEASE_S + 1
    assert sessions.owner is None
    manager = main.tx_auth
    monkeypatch.setattr(main, "tx_auth", TxAuthManager(manager.config_path, manager.secret_path, pin_iterations=1000))
    assert first.get("/api/v1/tx-auth/status").json()["authorized"]
    assert second.post("/api/v1/location/control/claim").status_code == 200
    assert second.post("/api/v1/tx-auth/unlock", json={"pin": "1234"}).status_code == 409
    assert second.post("/api/v1/aprs/send/position", json={}).status_code == 401
    assert first.post("/api/v1/aprs/send/position", json={}).status_code == 409
    assert not sent
    assert first.post("/api/v1/tx-auth/lock").status_code == 200
    assert second.get("/api/v1/location").json()["controlOwner"]
    assert second.post("/api/v1/tx-auth/unlock", json={"pin": "1234"}).status_code == 200
    assert second.post("/api/v1/aprs/send/position", json={}).status_code == 200
    assert sent[0][2].lat == 50


def test_location_release_and_runtime_restart_preserve_pin_lease(station, monkeypatch):
    first, second, sent = station
    setup(first)
    publish(first, 10)
    first.post("/api/v1/location/control/claim")
    first.post("/api/v1/location/control/release")
    assert first.get("/api/v1/tx-auth/status").json()["authorized"]
    assert second.post("/api/v1/tx-auth/unlock", json={"pin": "1234"}).status_code == 409
    monkeypatch.setattr(main, "radio_control_service", RigControlService())
    manager = main.tx_auth
    monkeypatch.setattr(main, "tx_auth", TxAuthManager(manager.config_path, manager.secret_path, pin_iterations=1000))
    assert first.get("/api/v1/tx-auth/status").json()["authorized"]
    assert first.post("/api/v1/aprs/send/position", json={}).status_code == 409
    assert not sent
    publish(first, 20)
    assert first.post("/api/v1/aprs/send/position", json={}).status_code == 200
    assert sent[0][2].lat == 20


def test_pin_cannot_bypass_stale_denied_or_disconnected_location(station):
    first, second, sent = station
    setup(first)
    first.post("/api/v1/location/control/claim")
    publish(first, 10, age=121)
    assert first.post("/api/v1/aprs/send/position", json={"latitude": 1, "longitude": 2}).status_code == 409
    radio = main.radio_control_service
    radio._runtime.connected = True
    radio._gps_fix = GeoPoint(lat=30, lon=40, timestamp=datetime.now(UTC))
    assert first.post("/api/v1/aprs/send/position", json={}).status_code == 200
    assert sent[-1][2].source == "radio_gps"
    publish(first, 20)
    radio.disconnect()
    assert first.post("/api/v1/aprs/send/position", json={}).status_code == 200
    assert sent[-1][2].source == "browser" and sent[-1][2].lat == 20
    first.post("/api/v1/location/device-unavailable")
    assert first.post("/api/v1/aprs/send/position", json={}).status_code == 409
    assert len(sent) == 2
    assert first.get("/api/v1/tx-auth/status").json()["authorized"]


def test_pin_and_owner_guards_both_apply_under_asgi_mount(station):
    first, second, sent = station
    setup(first)
    publish(first, 10)
    first.post("/api/v1/location/control/claim")
    mounted = TestClient(main.app, root_path="/joint-test", headers={"X-OrbitDeck-Session": "second"})
    response = mounted.post("/joint-test/api/v1/aprs/send/position", json={})
    assert response.status_code == 401
    mounted.cookies.update(first.cookies)
    response = mounted.post("/joint-test/api/v1/aprs/send/position", json={})
    assert response.status_code == 409
    assert not sent


def test_locked_receive_tuning_and_emergency_stop_do_not_require_pin(station, monkeypatch):
    first, second, sent = station
    first.post("/api/v1/location/control/claim")
    monkeypatch.setattr(main.radio_control_service, "set_frequency", lambda *a: (main.radio_control_service.runtime(), {}))
    assert first.post("/api/v1/radio/frequency", json={"vfo": "A", "freq_hz": 145800000}).status_code == 200
    assert second.post("/api/v1/radio/frequency", json={"vfo": "A", "freq_hz": 145800000}).status_code == 409
    assert second.post("/api/v1/aprs/emergency-stop").status_code == 200
    assert not sent
    assert not first.get("/api/v1/tx-auth/status").json()["authorized"]


def test_tx_state_responses_are_not_cacheable(station):
    first, second, sent = station
    assert first.get("/api/v1/tx-auth/status").headers["cache-control"] == "no-store"
    response = first.post("/api/v1/tx-auth/setup", json={"pin": "1234"})
    assert response.headers["cache-control"] == "no-store"
    assert first.post("/api/v1/tx-auth/lock").headers["cache-control"] == "no-store"
    assert first.post("/api/v1/tx-auth/unlock", json={"pin": "1234"}).headers["cache-control"] == "no-store"
    assert not sent

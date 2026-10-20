from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.main as main
from app.location import LocationSessions, browser_session
from app.models import GeoPoint, LocationState, LocationSourceMode, LocationProfile, RadioSettings, RadioRigModel
from app.radio.controllers.ic705 import Ic705Controller
from app.radio.controllers.id5100 import Id5100Controller
from app.radio.civ import build_frame, NAK
from app.radio.service import RigControlService
from app.services import LocationService, TrackingService, PassPredictionCacheService
from app.store import StateStore

NOW = datetime(2026, 10, 20, 12, tzinfo=UTC)


def point(age=0, **kwargs):
    return GeoPoint(lat=-27.47, lon=153.03, timestamp=NOW - timedelta(seconds=age), **kwargs)


def test_priority_and_metadata():
    service = LocationService()
    state = LocationState(gps_location=point(5), browser_location=point(1, accuracy_m=12))
    fix = service.resolve(state, NOW)
    assert (fix.source, fix.age_seconds, fix.available) == ("radio_gps", 5, True)
    state.gps_location = point(31)
    fix = service.resolve(state, NOW)
    assert (fix.source, fix.age_seconds, fix.accuracy_m) == ("browser", 1, 12)
    state.browser_location = point(121)
    assert not service.resolve(state, NOW).available


@pytest.mark.parametrize("timestamp", [None, NOW.replace(tzinfo=None), NOW + timedelta(seconds=6)])
def test_missing_naive_future_fix_unavailable(timestamp):
    fix = GeoPoint(lat=0, lon=0, timestamp=timestamp)
    result = LocationService().resolve(LocationState(gps_location=fix, browser_location=fix, last_known_location=point()), NOW)
    assert result.source == "unavailable"
    assert result.lat is None and result.lon is None


def test_real_zero_coordinates_are_valid_and_not_a_default():
    state = LocationState(browser_location=GeoPoint(lat=0, lon=0, timestamp=NOW))
    assert LocationService().resolve(state, NOW).available
    assert not LocationService().resolve(LocationState(), NOW).available


@pytest.mark.parametrize("value", [{"lat": float("nan"), "lon": 0}, {"lat": 91, "lon": 0},
                                  {"lat": 0, "lon": 181}, {"lat": 0, "lon": 0, "accuracy_m": -1},
                                  {"lat": 0, "lon": 0, "alt_m": float("inf")}])
def test_invalid_coordinates_rejected(value):
    with pytest.raises(ValidationError):
        GeoPoint(**value)


def test_manual_is_explicit_fallback_and_never_last_known():
    profile = LocationProfile(id="home", name="Home", point=point())
    state = LocationState(profiles=[profile], selected_profile_id="home", last_known_location=point())
    assert not LocationService().resolve(state, NOW).available
    state.source_mode = LocationSourceMode.manual
    assert LocationService().resolve(state, NOW).source == "manual"
    state.gps_location = point()
    assert LocationService().resolve(state, NOW).source == "radio_gps"


@pytest.fixture
def client(tmp_path, monkeypatch):
    main.radio_control_service.reset_runtime()
    monkeypatch.setattr(main, "radio_control_service", RigControlService())
    monkeypatch.setattr(main, "store", StateStore(str(tmp_path / "state.json")))
    monkeypatch.setattr(main, "tracking_service", TrackingService(tmp_path / "catalog.json"))
    monkeypatch.setattr(main, "pass_cache_service", PassPredictionCacheService(tmp_path / "passes.json"))
    main._invalidate_lite_snapshot_cache()
    yield TestClient(main.app, headers={"X-OrbitDeck-Session": "owner"})
    main.radio_control_service.reset_runtime()


def publish(client, lat=-27.47, session="owner", age=0, provider="browser"):
    return client.post("/api/v1/location", headers={"X-OrbitDeck-Session": session}, json={
        "browser_location": {"lat": lat, "lon": 153.03, "accuracy_m": 8, "provider": provider,
            "timestamp": (datetime.now(UTC) - timedelta(seconds=age)).isoformat()}})


def test_competing_browsers_have_independent_observers_and_one_station(client):
    assert client.post("/api/v1/location/control/claim").status_code == 200
    publish(client, lat=-27)
    publish(client, lat=51, session="spectator")
    other = client.get("/api/v1/location", headers={"X-OrbitDeck-Session": "spectator"}).json()
    assert other["resolved"]["lat"] == 51
    assert other["stationResolved"]["lat"] == -27
    assert not other["controlOwner"]
    assert client.post("/api/v1/location/control/claim", headers={"X-OrbitDeck-Session": "spectator"}).status_code == 409
    # No adapter is called for competing operations.
    assert client.post("/api/v1/radio/connect", headers={"X-OrbitDeck-Session": "spectator"}).status_code == 409
    assert client.post("/api/v1/aprs/send/position", headers={"X-OrbitDeck-Session": "spectator"}, json={}).status_code == 409
    assert client.get("/api/v1/live", headers={"X-OrbitDeck-Session": "spectator"}).json()["location"]["lat"] == 51
    assert main.store.get().location.browser_location is None


def test_radio_acquisition_staleness_and_disconnect(client):
    client.post("/api/v1/location/control/claim")
    publish(client)
    radio = main.radio_control_service
    radio._runtime.connected = True
    radio._gps_fix = GeoPoint(lat=10, lon=20, timestamp=datetime.now(UTC))
    assert client.get("/api/v1/location").json()["resolved"]["source"] == "radio_gps"
    radio._gps_fix.timestamp -= timedelta(seconds=31)
    assert client.get("/api/v1/location").json()["resolved"]["source"] == "browser"
    radio._gps_fix.timestamp = datetime.now(UTC)
    radio.disconnect()
    assert client.get("/api/v1/location").json()["resolved"]["source"] == "browser"
    assert radio.location_fix() is None


def test_denied_permission_clears_old_fix_and_tracking_does_not_use_zero(client):
    client.post("/api/v1/location/control/claim")
    publish(client)
    client.post("/api/v1/location/device-unavailable")
    location = client.get("/api/v1/location").json()
    assert not location["resolved"]["available"]
    assert not location["stationResolved"]["available"]
    for path in ("/api/v1/live", "/api/v1/passes", "/api/v1/system/state", "/api/v1/lite/snapshot"):
        response = client.get(path)
        assert response.status_code == 200, response.text
        assert response.json()["location"]["lat"] is None
    assert client.get("/api/v1/passes").json()["items"] == []


def test_hosted_packaged_mode_never_calls_native_provider(client, monkeypatch):
    monkeypatch.setenv("ORBITDECK_PACKAGED_APP", "1")
    monkeypatch.delenv("ORBITDECK_DESKTOP_LOCATION", raising=False)
    monkeypatch.setattr("app.desktop_main.DesktopApi.native_location", lambda _: pytest.fail("Hosted server location must not be read"))
    assert client.post("/api/v1/desktop/native-location").status_code == 404
    assert publish(client).status_code == 200
    assert client.get("/api/v1/location").json()["resolved"]["source"] == "browser"


def test_native_provider_failure_returns_fallback_eligible_error(client, monkeypatch):
    monkeypatch.setattr(main, "desktop_location_capable", lambda: True)
    def unavailable(_):
        raise RuntimeError("Permission denied")
    monkeypatch.setattr("app.desktop_main.DesktopApi.native_location", unavailable)
    assert client.post("/api/v1/desktop/native-location").status_code == 503
    publish(client, provider="desktop")
    assert client.get("/api/v1/location").json()["resolved"]["source"] == "desktop"


def test_owner_expiry_and_release_do_not_adopt_another_observer(client):
    client.post("/api/v1/location/control/claim")
    publish(client)
    publish(client, lat=51, session="spectator")
    sessions = main.radio_control_service.locations
    sessions._seen -= sessions.OWNER_LEASE_S + 1
    other = client.get("/api/v1/location", headers={"X-OrbitDeck-Session": "spectator"}).json()
    assert other["stationResolved"]["lat"] is None
    client.post("/api/v1/location/control/claim", headers={"X-OrbitDeck-Session": "spectator"})
    assert client.get("/api/v1/location").json()["stationResolved"]["lat"] == 51
    client.post("/api/v1/location/control/release", headers={"X-OrbitDeck-Session": "spectator"})
    assert client.get("/api/v1/location").json()["stationResolved"]["lat"] is None


def test_client_cannot_spoof_radio_gps(client):
    assert client.post("/api/v1/location", json={"gps_location": {"lat": 1, "lon": 2}}).status_code == 422


def gps_payload(timestamp=NOW):
    # S 27 28.200, E 153 01.800, +12.3m; course/speed zero.
    return b"\x00" + bytes.fromhex("2728200000" "015301800001" "00012300" "0000" "000000" + timestamp.strftime("%Y%m%d%H%M%S"))


def test_ic705_position_protocol_and_timestamp():
    fix = Ic705Controller.decode_gps(gps_payload())
    assert fix.lat == pytest.approx(-27.47)
    assert fix.lon == pytest.approx(153.03)
    assert fix.alt_m == pytest.approx(12.3)
    assert fix.timestamp == NOW
    assert fix.accuracy_m is None


@pytest.mark.parametrize("payload", [b"\x00", b"\x00" + b"\xff" * 27,
    gps_payload()[:-1] + b"\xfa", b"\x01" + gps_payload()[1:]])
def test_ic705_rejects_missing_invalid_gps(payload):
    with pytest.raises(ValueError):
        Ic705Controller.decode_gps(payload)


def test_supported_transport_gps_queries_are_read_only():
    calls = []
    class Transport:
        def transact(self, address, command, payload, **kwargs):
            calls.append((command, payload))
            return build_frame(0xE0, 0x23, b"\x01\x01" if payload == b"\x01" else gps_payload(), from_addr=address)
    controller = Ic705Controller(Transport(), 0xA4)
    assert controller.read_gps().timestamp == NOW
    assert calls == [(0x23, b"\x01"), (0x23, b"\x00")]
    assert not Id5100Controller(Transport(), 0x8C).supports_gps


def test_manual_or_disabled_radio_gps_not_accepted():
    for selected in (b"\x01\x00", b"\x01\x03"):
        transport = SimpleNamespace(transact=lambda *a, **k: build_frame(0xE0, 0x23, selected, from_addr=0xA4))
        assert Ic705Controller(transport, 0xA4).read_gps() is None


def test_aprs_owned_transport_gps_is_used_for_observer_and_station(client, monkeypatch):
    client.post("/api/v1/location/control/claim")
    publish(client)
    fix = GeoPoint(lat=11, lon=22, timestamp=datetime.now(UTC))
    monkeypatch.setattr(main, "aprs_service", SimpleNamespace(location_fix=lambda: fix))
    resolved = client.get("/api/v1/location").json()
    assert resolved["resolved"]["source"] == "radio_gps"
    assert resolved["stationResolved"]["lat"] == 11
    fix.timestamp -= timedelta(seconds=31)
    assert client.get("/api/v1/location").json()["stationResolved"]["source"] == "browser"


def test_unavailable_location_keeps_aprs_settings_and_targets_accessible(client):
    for path in ("/api/v1/aprs/state", "/api/v1/aprs/targets"):
        response = client.get(path)
        assert response.status_code == 200, response.text


def test_position_generation_uses_station_fix_and_blocks_when_unavailable(client, monkeypatch):
    client.post("/api/v1/location/control/claim")
    publish(client, lat=10)
    client.post("/api/v1/settings/aprs", json={"callsign": "VK4ABC"})
    captured = []
    def generate(settings, payload, location):
        captured.append((payload.latitude, payload.longitude, location.lat))
        return main.AprsRuntimeState()
    monkeypatch.setattr(main.aprs_service, "send_position", generate)
    response = client.post("/api/v1/aprs/send/position", json={"latitude": 88, "longitude": 99})
    assert response.status_code == 200, response.text
    assert captured == [(10, 153.03, 10)]
    client.post("/api/v1/location/device-unavailable")
    response = client.post("/api/v1/aprs/send/position", json={"latitude": 88, "longitude": 99})
    assert response.status_code == 409
    assert len(captured) == 1


def test_radio_background_resolver_uses_station_not_request_observer(client, monkeypatch):
    client.post("/api/v1/location/control/claim")
    publish(client, lat=10)
    publish(client, lat=50, session="other")
    seen = []
    def tracks(now, location, sat_ids=None):
        seen.append(location.lat)
        return []
    monkeypatch.setattr(main.tracking_service, "live_tracks", tracks)
    token = browser_session.set("other")
    try:
        main._resolve_recommendation_for_radio("iss-zarya")
    finally:
        browser_session.reset(token)
    assert seen == [10]


def test_aprs_wifi_gps_facade_shares_existing_session():
    import asyncio
    from app.radio.icom_lan_session import IcomLanRadioSession
    calls = []
    class Radio:
        async def send_civ(self, command, sub):
            calls.append((command, sub))
            payload = b"\x01\x01" if sub == 1 else gps_payload()
            return SimpleNamespace(command=command, sub=None, data=payload)
    session = IcomLanRadioSession(host="invalid", control_port=50001, username="test", password="", civ_address=0xA4)
    session._radio = Radio()
    session._loop = object()
    session._run = asyncio.run
    assert session.read_gps().timestamp == NOW
    assert calls == [(0x23, 1), (0x23, 0)]


def test_aprs_usb_gps_piggybacks_existing_control_transport(monkeypatch):
    from app.aprs.service import AprsService
    from app.models import AprsSettings
    calls = []
    class Controller:
        def __init__(self, transport, address):
            calls.append("controller")
        def connect(self):
            calls.append("connect")
        def set_frequency(self, vfo, hz):
            calls.append("tune")
        def read_gps(self):
            calls.append("gps")
            return point()
        def disconnect(self):
            calls.append("disconnect")
    monkeypatch.setattr("app.aprs.service.Ic705Controller", Controller)
    service = AprsService()
    service._tune_radio(AprsSettings(rig_model=RadioRigModel.ic705), 145825000)
    assert calls == ["controller", "connect", "tune", "gps", "disconnect"]
    service._runtime.connected = True
    assert service.location_fix().timestamp == NOW
    service.disconnect()
    assert service.location_fix() is None


def test_desktop_capability_is_independent_of_packaged_storage(monkeypatch):
    from app.runtime_paths import desktop_location_capable
    monkeypatch.setenv("ORBITDECK_PACKAGED_APP", "1")
    monkeypatch.delenv("ORBITDECK_DESKTOP_LOCATION", raising=False)
    assert not desktop_location_capable()
    monkeypatch.setenv("ORBITDECK_DESKTOP_LOCATION", "1")
    monkeypatch.setattr("app.runtime_paths.sys.platform", "linux")
    assert not desktop_location_capable()
    monkeypatch.setattr("app.runtime_paths.sys.platform", "darwin")
    assert desktop_location_capable()


def test_owner_modes_are_persisted_without_device_fixes(client):
    client.post("/api/v1/location/control/claim")
    publish(client)
    for mode in ("manual", "auto"):
        client.post("/api/v1/location", json={"source_mode": mode})
        assert main.store.get().location.source_mode.value == mode
        assert main.store.get().location.browser_location is None


def test_competing_control_rejected_under_generic_asgi_mount(client):
    client.post("/api/v1/location/control/claim")
    mounted = TestClient(main.app, root_path="/test-mount", headers={"X-OrbitDeck-Session": "spectator"})
    response = mounted.post("/test-mount/api/v1/radio/connect")
    assert response.status_code == 409, response.text
    assert "Another browser" in response.json()["detail"]


def test_simultaneous_control_claims_have_exactly_one_winner():
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    sessions = LocationSessions()
    barrier = Barrier(2)
    def claim(session):
        barrier.wait()
        try:
            sessions.claim(session)
            return session
        except ValueError:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        winners = [result for result in pool.map(claim, ["first", "second"]) if result]
    assert len(winners) == 1
    assert sessions.owner == winners[0]

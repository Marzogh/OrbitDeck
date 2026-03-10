from fastapi.testclient import TestClient

import app.main as main
from app.models import IssDisplayMode, LiveTrack, PassEvent, Satellite
from app.services import DataIngestionService, FrequencyGuideService, TrackingService
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


def test_track_path_endpoint_returns_samples(tmp_path):
    client = make_client(tmp_path)

    resp = client.get("/api/v1/track/path?sat_id=iss-zarya&minutes=5&step_seconds=60")
    assert resp.status_code == 200
    payload = resp.json()

    assert payload["sat_id"] == "iss-zarya"
    assert payload["minutes"] == 5
    assert payload["step_seconds"] == 60
    assert payload["count"] >= 2
    assert len(payload["items"]) == payload["count"]
    assert {"sat_id", "timestamp", "az_deg", "el_deg", "range_km", "sunlit"} <= set(payload["items"][0].keys())


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


def test_get_lite_settings_defaults(tmp_path):
    client = make_client(tmp_path)

    resp = client.get("/api/v1/settings/lite")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["state"]["tracked_sat_ids"] == ["iss-zarya"]
    assert payload["state"]["setup_complete"] is False
    assert payload["availableSatellites"]


def test_set_lite_settings_rejects_more_than_eight(tmp_path):
    client = make_client(tmp_path)

    resp = client.post(
        "/api/v1/settings/lite",
        json={"tracked_sat_ids": [f"sat-{idx}" for idx in range(9)], "setup_complete": True},
    )
    assert resp.status_code == 400


def test_set_and_get_lite_settings_preserves_explicit_non_iss_selection(tmp_path):
    client = make_client(tmp_path)
    satellites = client.get("/api/v1/satellites").json()["items"]
    chosen = [sat["sat_id"] for sat in satellites if sat["sat_id"] != "iss-zarya"][:2]

    resp = client.post(
        "/api/v1/settings/lite",
        json={"tracked_sat_ids": chosen + [chosen[0]], "setup_complete": True},
    )
    assert resp.status_code == 200
    assert resp.json()["state"]["tracked_sat_ids"] == chosen

    get_resp = client.get("/api/v1/settings/lite")
    assert get_resp.status_code == 200
    assert get_resp.json()["state"]["tracked_sat_ids"] == chosen


def test_get_timezones_returns_full_server_timezone_catalog(tmp_path):
    client = make_client(tmp_path)

    resp = client.get("/api/v1/settings/timezones")
    assert resp.status_code == 200
    payload = resp.json()
    assert "timezones" in payload
    assert "UTC" in payload["timezones"]
    assert "Australia/Brisbane" in payload["timezones"]
    assert "America/New_York" in payload["timezones"]


def test_lite_snapshot_is_bounded_to_tracked_satellites(tmp_path):
    client = make_client(tmp_path)
    satellites = client.get("/api/v1/satellites").json()["items"]
    chosen = [sat["sat_id"] for sat in satellites[:2]]

    save = client.post("/api/v1/settings/lite", json={"tracked_sat_ids": chosen, "setup_complete": True})
    assert save.status_code == 200

    resp = client.get(f"/api/v1/lite/snapshot?sat_id={chosen[0]}")
    assert resp.status_code == 200
    payload = resp.json()

    assert payload["trackedSatIds"] == sorted(chosen)
    assert {item["sat_id"] for item in payload["tracks"]} <= set(chosen)
    assert {item["sat_id"] for item in payload["passes"]} <= set(chosen)
    assert "focusCue" in payload
    assert "bodies" not in payload


def test_lite_snapshot_returns_aos_cue_for_upcoming_selected_pass(tmp_path):
    client = make_client(tmp_path)

    class FakeTracking(TrackingService):
        def live_tracks(self, now, location, sat_ids=None):
            from app.models import LiveTrack

            return [
                LiveTrack(
                    sat_id="iss-zarya",
                    name="ISS (ZARYA)",
                    timestamp=now,
                    az_deg=220.0,
                    el_deg=-12.0,
                    range_km=1400.0,
                    range_rate_km_s=0.0,
                    sunlit=True,
                )
            ]

        def pass_predictions(self, now, hours, location=None, sat_ids=None, include_ongoing=False):
            from datetime import timedelta
            from app.models import PassEvent

            return [
                PassEvent(
                    sat_id="iss-zarya",
                    name="ISS (ZARYA)",
                    aos=now + timedelta(minutes=10),
                    tca=now + timedelta(minutes=14),
                    los=now + timedelta(minutes=19),
                    max_el_deg=45.0,
                )
            ]

        def track_path(self, now, minutes, location, sat_id, step_seconds=45, start_time=None):
            from app.models import LiveTrack

            return [
                LiveTrack(
                    sat_id=sat_id,
                    name="ISS (ZARYA)",
                    timestamp=start_time,
                    az_deg=123.0,
                    el_deg=5.0,
                    range_km=1200.0,
                    range_rate_km_s=0.0,
                    sunlit=True,
                )
            ]

    old_tracking = main.tracking_service
    try:
        main.tracking_service = FakeTracking(str(tmp_path / "latest_catalog.json"))
        resp = client.get("/api/v1/lite/snapshot?sat_id=iss-zarya")
        assert resp.status_code == 200
        cue = resp.json()["focusCue"]
        assert cue["type"] == "aos"
        assert cue["sat_id"] == "iss-zarya"
        assert cue["az_deg"] == 123.0
    finally:
        main.tracking_service = old_tracking


def test_frequency_guide_service_returns_iss_fm_recommendation():
    svc = FrequencyGuideService()
    rec = svc.recommendation(
        "iss-zarya",
        None,
        current_track=LiveTrack(
            sat_id="iss-zarya",
            name="ISS (ZARYA)",
            timestamp=main.datetime.now(main.UTC),
            az_deg=0.0,
            el_deg=10.0,
            range_km=1000.0,
            range_rate_km_s=-7.0,
            sunlit=True,
        ),
    )

    assert rec is not None
    assert rec.mode.value == "fm"
    assert rec.downlink_mhz == 437.79
    assert rec.uplink_mhz == 145.99
    assert rec.correction_side.value == "uhf_only"


def test_frequency_guide_service_returns_linear_matrix():
    svc = FrequencyGuideService()
    current_track = LiveTrack(
        sat_id="fo29",
        name="FO-29",
        timestamp=main.datetime.now(main.UTC),
        az_deg=0.0,
        el_deg=10.0,
        range_km=1000.0,
        range_rate_km_s=0.0,
        sunlit=True,
    )
    matrix = svc.matrix("fo29", current_track=current_track, selected_column_index=0)

    assert matrix is not None
    assert matrix.mode.value == "linear"
    assert matrix.rows[0].downlink_mhz == 435.8
    assert matrix.rows[2].downlink_mhz == 435.8
    assert matrix.rows[-1].downlink_mhz == 435.8


def test_frequency_guide_service_doppler_math_and_quantization():
    svc = FrequencyGuideService()
    shift_hz = svc.doppler_shift_hz(437.8, -7.0)

    assert shift_hz < 0
    corrected = svc.corrected_downlink_mhz(437.8, -7.0, 5000)
    assert corrected == 437.79


def test_frequency_guide_service_corrects_uhf_uplink_only_when_uplink_is_uhf():
    svc = FrequencyGuideService()
    rec = svc.recommendation(
        "radfxsat-fox-1b",
        None,
        current_track=LiveTrack(
            sat_id="radfxsat-fox-1b",
            name="RADFXSAT (FOX-1B)",
            timestamp=main.datetime.now(main.UTC),
            az_deg=0.0,
            el_deg=20.0,
            range_km=1000.0,
            range_rate_km_s=-7.0,
            sunlit=True,
        ),
    )

    assert rec is not None
    assert rec.uplink_mhz == 435.26
    assert rec.downlink_mhz == 145.96


def test_lite_snapshot_includes_frequency_recommendation_and_matrix(tmp_path):
    client = make_client(tmp_path)

    class FakeTracking(TrackingService):
        def satellites(self):
            return [
                Satellite(
                    sat_id="fo29",
                    norad_id=24278,
                    name="FO-29",
                    has_amateur_radio=True,
                    transponders=["Linear"],
                    repeaters=["Uplink 146.000 MHz / Downlink 435.800 MHz"],
                ),
                Satellite(
                    sat_id="iss-zarya",
                    norad_id=25544,
                    name="ISS (ZARYA)",
                    is_iss=True,
                    has_amateur_radio=True,
                    transponders=["145.990 MHz downlink"],
                    repeaters=["437.800 MHz APRS"],
                ),
            ]

        def live_tracks(self, now, location, sat_ids=None):
            return [
                LiveTrack(
                    sat_id="fo29",
                    name="FO-29",
                    timestamp=now,
                    az_deg=180.0,
                    el_deg=20.0,
                    range_km=1000.0,
                    range_rate_km_s=0.0,
                    sunlit=True,
                ),
                LiveTrack(
                    sat_id="iss-zarya",
                    name="ISS (ZARYA)",
                    timestamp=now,
                    az_deg=10.0,
                    el_deg=-5.0,
                    range_km=2000.0,
                    range_rate_km_s=0.0,
                    sunlit=True,
                ),
            ]

        def pass_predictions(self, now, hours, location=None, sat_ids=None, include_ongoing=False):
            from datetime import timedelta

            return [
                PassEvent(
                    sat_id="fo29",
                    name="FO-29",
                    aos=now - timedelta(minutes=2),
                    tca=now,
                    los=now + timedelta(minutes=2),
                    max_el_deg=65.0,
                )
            ]

    old_tracking = main.tracking_service
    try:
        main.tracking_service = FakeTracking(str(tmp_path / "latest_catalog.json"))
        save = client.post("/api/v1/settings/lite", json={"tracked_sat_ids": ["fo29"], "setup_complete": True})
        assert save.status_code == 200
        resp = client.get("/api/v1/lite/snapshot?sat_id=fo29")
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["frequencyRecommendation"]["sat_id"] == "fo29"
        assert payload["frequencyRecommendation"]["mode"] == "linear"
        assert payload["frequencyMatrix"]["sat_id"] == "fo29"
        assert payload["frequencyMatrix"]["active_phase"] == "mid"
    finally:
        main.tracking_service = old_tracking


def test_frequency_recommendation_endpoint_returns_reactive_output(tmp_path):
    client = make_client(tmp_path)

    class FakeTracking(TrackingService):
        def satellites(self):
            return [
                Satellite(
                    sat_id="iss-zarya",
                    norad_id=25544,
                    name="ISS (ZARYA)",
                    is_iss=True,
                    has_amateur_radio=True,
                    transponders=["145.990 MHz downlink"],
                    repeaters=["437.800 MHz APRS"],
                )
            ]

        def live_tracks(self, now, location, sat_ids=None):
            return [
                LiveTrack(
                    sat_id="iss-zarya",
                    name="ISS (ZARYA)",
                    timestamp=now,
                    az_deg=0.0,
                    el_deg=30.0,
                    range_km=1000.0,
                    range_rate_km_s=-7.0,
                    sunlit=True,
                )
            ]

        def pass_predictions(self, now, hours, location=None, sat_ids=None, include_ongoing=False):
            return []

    old_tracking = main.tracking_service
    try:
        main.tracking_service = FakeTracking(str(tmp_path / "latest_catalog.json"))
        resp = client.get("/api/v1/frequency-guides/recommendation?sat_id=iss-zarya")
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["recommendation"]["sat_id"] == "iss-zarya"
        assert payload["recommendation"]["downlink_mhz"] == 437.79
        assert payload["matrix"] is None
    finally:
        main.tracking_service = old_tracking


def test_system_state_includes_frequency_bundle_for_active_satellite(tmp_path):
    client = make_client(tmp_path)

    class FakeTracking(TrackingService):
        def live_tracks(self, now, location, sat_ids=None):
            return [
                LiveTrack(
                    sat_id="fo29",
                    name="FO-29",
                    timestamp=now,
                    az_deg=90.0,
                    el_deg=25.0,
                    range_km=900.0,
                    range_rate_km_s=-2.0,
                    sunlit=True,
                ),
                LiveTrack(
                    sat_id="iss-zarya",
                    name="ISS (ZARYA)",
                    timestamp=now,
                    az_deg=120.0,
                    el_deg=15.0,
                    range_km=1100.0,
                    range_rate_km_s=0.0,
                    sunlit=True,
                ),
            ]

        def pass_predictions(self, now, hours, location=None, sat_ids=None, include_ongoing=False):
            from datetime import timedelta

            return [
                PassEvent(
                    sat_id="fo29",
                    name="FO-29",
                    aos=now - timedelta(minutes=3),
                    tca=now,
                    los=now + timedelta(minutes=4),
                    max_el_deg=62.0,
                )
            ]

    old_tracking = main.tracking_service
    try:
        main.tracking_service = FakeTracking(str(tmp_path / "latest_catalog.json"))
        resp = client.get("/api/v1/system/state?sat_id=fo29")
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["activeTrack"]["sat_id"] == "fo29"
        assert payload["activePass"]["sat_id"] == "fo29"
        assert payload["frequencyRecommendation"]["sat_id"] == "fo29"
        assert payload["frequencyMatrix"]["sat_id"] == "fo29"
        assert isinstance(payload["activeTrackPath"], list)
    finally:
        main.tracking_service = old_tracking


def test_passes_endpoint_enriches_items_with_frequency_guides(tmp_path):
    client = make_client(tmp_path)

    class FakeTracking(TrackingService):
        def live_tracks(self, now, location, sat_ids=None):
            return [
                LiveTrack(
                    sat_id="iss-zarya",
                    name="ISS (ZARYA)",
                    timestamp=now,
                    az_deg=45.0,
                    el_deg=12.0,
                    range_km=1200.0,
                    range_rate_km_s=-7.0,
                    sunlit=True,
                )
            ]

        def pass_predictions(self, now, hours, location=None, sat_ids=None, include_ongoing=False):
            from datetime import timedelta

            return [
                PassEvent(
                    sat_id="iss-zarya",
                    name="ISS (ZARYA)",
                    aos=now + timedelta(minutes=8),
                    tca=now + timedelta(minutes=12),
                    los=now + timedelta(minutes=17),
                    max_el_deg=48.0,
                )
            ]

        def track_path(self, now, minutes, location, sat_id, step_seconds=45, start_time=None):
            return [
                LiveTrack(
                    sat_id=sat_id,
                    name="ISS (ZARYA)",
                    timestamp=start_time or now,
                    az_deg=45.0,
                    el_deg=2.0,
                    range_km=1200.0,
                    range_rate_km_s=-7.0,
                    sunlit=True,
                )
            ]

    old_tracking = main.tracking_service
    try:
        main.tracking_service = FakeTracking(str(tmp_path / "latest_catalog.json"))
        resp = client.get("/api/v1/passes?include_all_sats=true&include_ongoing=true")
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["count"] == 1
        item = payload["items"][0]
        assert item["sat_id"] == "iss-zarya"
        assert item["frequencyRecommendation"]["sat_id"] == "iss-zarya"
        assert item["frequencyRecommendation"]["downlink_mhz"] == 437.79
        assert item["frequencyMatrix"] is None
    finally:
        main.tracking_service = old_tracking


def test_set_and_get_developer_overrides(tmp_path):
    client = make_client(tmp_path)

    resp = client.post(
        "/api/v1/settings/developer-overrides",
        json={
            "enabled": True,
            "force_scene": "ongoing",
            "force_sat_id": "iss-zarya",
            "simulate_pass_phase": "mid-pass",
            "force_iss_video_eligible": True,
            "force_iss_stream_healthy": True,
            "show_debug_badge": True,
        },
    )
    assert resp.status_code == 200
    payload = resp.json()["state"]
    assert payload["enabled"] is True
    assert payload["force_scene"] == "ongoing"
    assert payload["simulate_pass_phase"] == "mid-pass"

    get_resp = client.get("/api/v1/settings/developer-overrides")
    assert get_resp.status_code == 200
    state = get_resp.json()["state"]
    assert state["force_sat_id"] == "iss-zarya"
    assert state["force_iss_video_eligible"] is True

    system_resp = client.get("/api/v1/system/state")
    assert system_resp.status_code == 200
    system_settings = system_resp.json()["settings"]
    assert "developer_overrides" in system_settings
    assert system_settings["developer_overrides"]["force_scene"] == "ongoing"


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

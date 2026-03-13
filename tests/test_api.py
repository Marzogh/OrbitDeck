from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

import app.main as main
from app.models import (
    CorrectionSide,
    DopplerDirection,
    FrequencyGuideMode,
    FrequencyRecommendation,
    GuidePassPhase,
    IssDisplayMode,
    LiveTrack,
    PassEvent,
    RadioRigModel,
    Satellite,
)
from app.radio.civ import ACK, build_frame, freq_to_bcd
from app.radio.controllers.base import BaseIcomController
from app.radio.controllers.ic705 import Ic705Controller
from app.radio.service import RigControlService
from app.services import DataIngestionService, FrequencyGuideService, TrackingService
from app.store import StateStore


def make_client(tmp_path):
    main.store = StateStore(str(tmp_path / "state.json"))
    main.tracking_service = TrackingService(str(tmp_path / "latest_catalog.json"))
    main.ingestion_service = DataIngestionService()
    main.radio_control_service = RigControlService()
    return TestClient(main.app)


class FakeRigController(BaseIcomController):
    def __init__(self, transport, civ_address):
        super().__init__(transport, civ_address)
        self._snapshot = None

    def connect(self):
        self.state.connected = True
        self.state.last_error = None
        self.stamp_poll()
        return self.state

    def disconnect(self):
        self.state.connected = False
        return self.state

    def poll_state(self):
        self.state.connected = True
        self.state.targets.setdefault("main_label", "Main (TX)")
        self.state.targets.setdefault("sub_label", "Sub (RX)")
        self.stamp_poll()
        return self.state

    def apply_target(self, recommendation, apply_mode_and_tone):
        self.state.targets["main_freq_hz"] = int(round((recommendation.uplink_mhz or 0) * 1_000_000))
        self.state.targets["sub_freq_hz"] = int(round((recommendation.downlink_mhz or 0) * 1_000_000))
        self.state.raw_state["applied"] = True
        self.stamp_poll()
        return self.state, {"tx": "MAIN", "rx": "SUB"}

    def set_frequency(self, vfo, freq_hz):
        self.state.targets[f"{str(vfo).lower()}_freq_hz"] = int(freq_hz)
        self.state.raw_state["last_set_vfo"] = str(vfo)
        self.stamp_poll()
        return self.state, {"vfo": str(vfo), "freq_hz": int(freq_hz)}

    def snapshot_state(self):
        self._snapshot = {
            "targets": dict(self.state.targets),
            "raw_state": dict(self.state.raw_state),
        }
        return self._snapshot

    def restore_snapshot(self, snapshot):
        self.state.targets = dict(snapshot.get("targets", {}))
        self.state.raw_state = dict(snapshot.get("raw_state", {}))
        self.stamp_poll()
        return self.state


class FailingRestoreRigController(FakeRigController):
    def restore_snapshot(self, snapshot):
        raise RuntimeError("simulated restore failure")


class FailingDisconnectRigController(FakeRigController):
    def disconnect(self):
        raise RuntimeError("simulated disconnect failure")


class ScriptedIc705Transport:
    def __init__(self, freq_a: int, freq_b: int) -> None:
        self.freq_a = int(freq_a)
        self.freq_b = int(freq_b)
        self.mode_a = "FM"
        self.mode_b = "FM"
        self.selected_vfo = "A"
        self.split_enabled = False
        self.squelch_level = 1.0
        self.scope_enabled = False
        self.scope_mode = None
        self.scope_span_hz = None
        self.is_open = False
        self.force_bad_readback = False

    def open(self) -> None:
        self.is_open = True

    def close(self) -> None:
        self.is_open = False

    def transact(self, to_addr: int, command: int, payload: bytes = b"", expect_commands=None, timeout=None) -> bytes:
        if command == Ic705Controller.C_SET_VFO:
            self.selected_vfo = "A" if payload[:1] == bytes([Ic705Controller.S_VFOA]) else "B"
            return build_frame(0xE0, ACK, b"", from_addr=to_addr)
        if command == Ic705Controller.C_SET_FREQ:
            freq_hz = 0
            digits = 1
            for byte in payload:
                freq_hz += (byte & 0x0F) * digits
                digits *= 10
                freq_hz += ((byte >> 4) & 0x0F) * digits
                digits *= 10
            if self.selected_vfo == "A":
                self.freq_a = freq_hz
            else:
                self.freq_b = freq_hz
            return build_frame(0xE0, ACK, b"", from_addr=to_addr)
        if command == Ic705Controller.C_SET_MODE:
            mode_name = next((name for name, code in Ic705Controller.MODE_MAP.items() if code == payload[0]), None)
            if self.selected_vfo == "A":
                self.mode_a = mode_name or "UNKNOWN"
            else:
                self.mode_b = mode_name or "UNKNOWN"
            return build_frame(0xE0, ACK, b"", from_addr=to_addr)
        if command == Ic705Controller.C_RD_MODE:
            mode_name = self.mode_a if self.selected_vfo == "A" else self.mode_b
            mode_code = Ic705Controller.MODE_MAP[mode_name]
            return build_frame(to_addr=0xE0, command=Ic705Controller.C_RD_MODE, payload=bytes([mode_code, 0x01]), from_addr=to_addr)
        if command == Ic705Controller.C_SEL_MODE:
            selected = payload[:1] == b"\x00"
            if self.force_bad_readback:
                selector = b"\x00" if selected else b"\x01"
                return build_frame(to_addr=0xE0, command=Ic705Controller.C_SEL_MODE, payload=selector + bytes([0x00, 0x00, 0x00, 0x00]), from_addr=to_addr)
            mode_name = self.mode_a if (self.selected_vfo == "A") == selected else self.mode_b
            mode_code = Ic705Controller.MODE_MAP[mode_name]
            selector = b"\x00" if selected else b"\x01"
            return build_frame(to_addr=0xE0, command=Ic705Controller.C_SEL_MODE, payload=selector + bytes([mode_code, 0x00, 0x00, 0x01]), from_addr=to_addr)
        if command == Ic705Controller.C_SEL_FREQ:
            if self.force_bad_readback:
                selector = b"\x00" if payload[:1] == b"\x00" else b"\x01"
                return build_frame(to_addr=0xE0, command=Ic705Controller.C_SEL_FREQ, payload=selector + freq_to_bcd(7060000, 5), from_addr=to_addr)
            selected = payload[:1] == b"\x00"
            freq_hz = self.freq_a if (self.selected_vfo == "A") == selected else self.freq_b
            selector = b"\x00" if selected else b"\x01"
            return build_frame(to_addr=0xE0, command=Ic705Controller.C_SEL_FREQ, payload=selector + freq_to_bcd(freq_hz, 5), from_addr=to_addr)
        if command == Ic705Controller.C_RD_SPLIT and not payload:
            payload = b"\x01" if self.split_enabled else b"\x00"
            return build_frame(to_addr=0xE0, command=Ic705Controller.C_RD_SPLIT, payload=payload, from_addr=to_addr)
        if command == Ic705Controller.C_CTL_SPLT:
            self.split_enabled = payload[:1] == bytes([Ic705Controller.S_SPLT_ON])
            return build_frame(0xE0, ACK, b"", from_addr=to_addr)
        if command == Ic705Controller.C_CTL_LVL:
            if payload[:1] == bytes([Ic705Controller.S_LVL_SQL]):
                if len(payload) == 1:
                    raw = int(round(self.squelch_level * 255))
                    text = f"{raw:04d}"
                    bcd = bytes(int(text[idx: idx + 2], 16) for idx in range(0, len(text), 2))
                    return build_frame(to_addr=0xE0, command=Ic705Controller.C_CTL_LVL, payload=bytes([Ic705Controller.S_LVL_SQL]) + bcd, from_addr=to_addr)
                raw = int("".join(f"{(byte >> 4) & 0x0F}{byte & 0x0F}" for byte in payload[1:3]))
                self.squelch_level = raw / 255.0
                return build_frame(0xE0, ACK, b"", from_addr=to_addr)
        if command == Ic705Controller.C_CTL_SCP:
            subcmd = payload[:1]
            if subcmd == bytes([Ic705Controller.S_SCP_STS]):
                if len(payload) == 1:
                    return build_frame(to_addr=0xE0, command=Ic705Controller.C_CTL_SCP, payload=bytes([Ic705Controller.S_SCP_STS, 0x01 if self.scope_enabled else 0x00]), from_addr=to_addr)
                self.scope_enabled = payload[1:2] == b"\x01"
                return build_frame(0xE0, ACK, b"", from_addr=to_addr)
            if subcmd == bytes([Ic705Controller.S_SCP_MOD]):
                if len(payload) == 2:
                    return build_frame(to_addr=0xE0, command=Ic705Controller.C_CTL_SCP, payload=bytes([Ic705Controller.S_SCP_MOD, Ic705Controller.SCOPE_MAIN, self.scope_mode or Ic705Controller.SCOPE_MODE_CENTER]), from_addr=to_addr)
                self.scope_mode = payload[2] if len(payload) > 2 else None
                return build_frame(0xE0, ACK, b"", from_addr=to_addr)
            if subcmd == bytes([Ic705Controller.S_SCP_SPN]):
                if len(payload) == 2:
                    return build_frame(
                        to_addr=0xE0,
                        command=Ic705Controller.C_CTL_SCP,
                        payload=bytes([Ic705Controller.S_SCP_SPN, Ic705Controller.SCOPE_MAIN]) + freq_to_bcd((self.scope_span_hz or 0) // 2, 5),
                        from_addr=to_addr,
                    )
                half_span = 0
                digits = 1
                for byte in payload[2:7]:
                    half_span += (byte & 0x0F) * digits
                    digits *= 10
                    half_span += ((byte >> 4) & 0x0F) * digits
                    digits *= 10
                self.scope_span_hz = half_span * 2
                return build_frame(0xE0, ACK, b"", from_addr=to_addr)
        raise AssertionError(f"Unexpected CI-V command: 0x{command:02X}")


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


def test_set_and_get_radio_settings(tmp_path):
    client = make_client(tmp_path)

    resp = client.post(
        "/api/v1/settings/radio",
        json={
            "enabled": True,
            "rig_model": "ic705",
            "serial_device": "/dev/ttyUSB7",
            "baud_rate": 19200,
            "civ_address": "0xA4",
            "poll_interval_ms": 750,
            "auto_connect": True,
            "auto_track_interval_ms": 1200,
            "default_apply_mode_and_tone": False,
            "safe_tx_guard_enabled": True,
        },
    )
    assert resp.status_code == 200
    payload = resp.json()["state"]
    assert payload["rig_model"] == "ic705"
    assert payload["serial_device"] == "/dev/ttyUSB7"
    assert payload["civ_address"] == "0xA4"

    get_resp = client.get("/api/v1/settings/radio")
    assert get_resp.status_code == 200
    state = get_resp.json()["state"]
    assert state["enabled"] is True
    assert state["auto_connect"] is True


def test_radio_connect_apply_and_stop(tmp_path):
    client = make_client(tmp_path)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FakeRigController(None, 0x8C)  # type: ignore[arg-type]
    )

    settings_resp = client.post("/api/v1/settings/radio", json={"enabled": True, "rig_model": "id5100"})
    assert settings_resp.status_code == 200

    connect_resp = client.post("/api/v1/radio/connect")
    assert connect_resp.status_code == 200
    assert connect_resp.json()["runtime"]["connected"] is True

    apply_resp = client.post("/api/v1/radio/apply", json={"sat_id": "iss-zarya"})
    assert apply_resp.status_code == 200
    payload = apply_resp.json()
    assert payload["runtime"]["control_mode"] == "manual_applied"
    assert payload["recommendation"]["sat_id"] == "iss-zarya"
    assert payload["targetMapping"]["tx"] == "MAIN"

    start_resp = client.post("/api/v1/radio/auto-track/start", json={"sat_id": "iss-zarya"})
    assert start_resp.status_code == 200
    assert start_resp.json()["runtime"]["control_mode"] in {"manual_applied", "auto_tracking"}

    stop_resp = client.post("/api/v1/radio/auto-track/stop")
    assert stop_resp.status_code == 200
    assert stop_resp.json()["runtime"]["control_mode"] == "idle"


def test_radio_state_is_exposed_via_system_state(tmp_path):
    client = make_client(tmp_path)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FakeRigController(None, 0x8C)  # type: ignore[arg-type]
    )

    client.post("/api/v1/radio/connect")
    resp = client.get("/api/v1/system/state")
    assert resp.status_code == 200
    payload = resp.json()
    assert "radioSettings" in payload
    assert "radioRuntime" in payload
    assert "radioControlSession" in payload


def test_radio_poll_endpoint_returns_runtime(tmp_path):
    client = make_client(tmp_path)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FakeRigController(None, 0xA4)  # type: ignore[arg-type]
    )

    client.post("/api/v1/settings/radio", json={"rig_model": "ic705", "civ_address": "0xA4"})
    resp = client.post("/api/v1/radio/poll")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["runtime"]["connected"] is True
    assert payload["settings"]["rig_model"] == "ic705"


def test_radio_frequency_endpoint_updates_runtime(tmp_path):
    client = make_client(tmp_path)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FakeRigController(None, 0xA4)  # type: ignore[arg-type]
    )
    client.post("/api/v1/settings/radio", json={"rig_model": "ic705", "civ_address": "0xA4"})
    client.post("/api/v1/radio/connect")
    resp = client.post("/api/v1/radio/frequency", json={"vfo": "A", "freq_hz": 145990000})
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["result"]["vfo"] == "A"
    assert payload["result"]["freq_hz"] == 145990000


def test_radio_pair_endpoint_returns_mapping(tmp_path):
    client = make_client(tmp_path)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FakeRigController(None, 0xA4)  # type: ignore[arg-type]
    )
    client.post("/api/v1/settings/radio", json={"rig_model": "ic705", "civ_address": "0xA4"})
    client.post("/api/v1/radio/connect")
    resp = client.post("/api/v1/radio/pair", json={"uplink_hz": 145990000, "downlink_hz": 437795000})
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["recommendation"]["sat_id"] == "manual-pair"
    assert payload["targetMapping"]["tx"] == "MAIN"
    assert payload["recommendation"]["uplink_mode"] == "FM"
    assert payload["recommendation"]["downlink_mode"] == "FM"


def test_radio_pair_endpoint_rejects_non_vhf_uhf_pair(tmp_path):
    client = make_client(tmp_path)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FakeRigController(None, 0xA4)  # type: ignore[arg-type]
    )
    client.post("/api/v1/settings/radio", json={"rig_model": "ic705", "civ_address": "0xA4"})
    client.post("/api/v1/radio/connect")
    resp = client.post("/api/v1/radio/pair", json={"uplink_hz": 29000000, "downlink_hz": 145990000})
    assert resp.status_code == 400
    assert "outside supported VHF/UHF range" in resp.json()["detail"]


def test_radio_session_select_and_clear(tmp_path):
    client = make_client(tmp_path)
    aos = datetime.now(UTC) + timedelta(minutes=5)
    los = aos + timedelta(minutes=10)
    resp = client.post(
        "/api/v1/radio/session/select",
        json={
            "sat_id": "iss-zarya",
            "sat_name": "ISS (ZARYA)",
            "pass_aos": aos.isoformat(),
            "pass_los": los.isoformat(),
            "max_el_deg": 42.5,
        },
    )
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["session"]["active"] is True
    assert payload["session"]["selected_sat_id"] == "iss-zarya"
    assert payload["session"]["has_test_pair"] is True

    clear_resp = client.post("/api/v1/radio/session/clear")
    assert clear_resp.status_code == 200
    assert clear_resp.json()["session"]["active"] is False


def test_radio_session_select_marks_non_vhf_uhf_satellite_ineligible(tmp_path):
    client = make_client(tmp_path)
    aos = datetime.now(UTC) + timedelta(minutes=5)
    los = aos + timedelta(minutes=10)
    original_service = main.frequency_guide_service

    class FakeFrequencyGuideService:
        def recommendation(self, sat_id, *args, **kwargs):
            return FrequencyRecommendation(
                sat_id=sat_id,
                mode=FrequencyGuideMode.fm,
                phase=GuidePassPhase.mid,
                label="Test",
                is_upcoming=False,
                is_ongoing=True,
                correction_side=CorrectionSide.full_duplex,
                doppler_direction=DopplerDirection.high_to_low,
                uplink_mhz=29.6,
                downlink_mhz=145.99,
            )

    main.frequency_guide_service = FakeFrequencyGuideService()
    try:
        resp = client.post(
            "/api/v1/radio/session/select",
            json={
                "sat_id": "custom-non-vhf-uhf",
                "sat_name": "Custom Out Of Band",
                "pass_aos": aos.isoformat(),
                "pass_los": los.isoformat(),
                "max_el_deg": 42.5,
            },
        )
    finally:
        main.frequency_guide_service = original_service
    assert resp.status_code == 200
    payload = resp.json()["session"]
    assert payload["active"] is True
    assert payload["is_eligible"] is False
    assert "outside supported VHF/UHF range" in payload["eligibility_reason"]


def test_radio_session_test_and_confirm_release(tmp_path):
    client = make_client(tmp_path)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FakeRigController(None, 0xA4)  # type: ignore[arg-type]
    )
    now = datetime.now(UTC)
    client.post("/api/v1/settings/radio", json={"rig_model": "ic705", "civ_address": "0xA4"})
    client.post("/api/v1/radio/connect")
    client.post(
        "/api/v1/radio/session/select",
        json={
            "sat_id": "iss-zarya",
            "sat_name": "ISS (ZARYA)",
            "pass_aos": (now + timedelta(minutes=5)).isoformat(),
            "pass_los": (now + timedelta(minutes=15)).isoformat(),
            "max_el_deg": 52.0,
        },
    )
    resp = client.post("/api/v1/radio/session/test")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["session"]["screen_state"] == "test"
    assert payload["runtime"]["control_mode"] == "manual_applied"

    confirm_resp = client.post("/api/v1/radio/session/test/confirm")
    assert confirm_resp.status_code == 200
    confirm_payload = confirm_resp.json()
    assert confirm_payload["session"]["screen_state"] == "released"
    assert confirm_payload["runtime"]["control_mode"] == "idle"


def test_radio_session_confirm_restores_prior_rig_state(tmp_path):
    client = make_client(tmp_path)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FakeRigController(None, 0xA4)  # type: ignore[arg-type]
    )
    now = datetime.now(UTC)
    client.post("/api/v1/settings/radio", json={"rig_model": "ic705", "civ_address": "0xA4"})
    client.post("/api/v1/radio/connect")
    main.radio_control_service._controller.state.targets = {"vfo_a_freq_hz": 145500000, "vfo_b_freq_hz": 435000000}
    main.radio_control_service._controller.state.raw_state = {"split_enabled": False}
    client.post(
        "/api/v1/radio/session/select",
        json={
            "sat_id": "iss-zarya",
            "sat_name": "ISS (ZARYA)",
            "pass_aos": (now + timedelta(minutes=5)).isoformat(),
            "pass_los": (now + timedelta(minutes=15)).isoformat(),
            "max_el_deg": 52.0,
        },
    )
    client.post("/api/v1/radio/session/test")
    confirm_resp = client.post("/api/v1/radio/session/test/confirm")
    assert confirm_resp.status_code == 200
    runtime = confirm_resp.json()["runtime"]
    assert runtime["targets"]["vfo_a_freq_hz"] == 145500000
    assert runtime["targets"]["vfo_b_freq_hz"] == 435000000


def test_radio_disconnect_restores_prior_rig_state(tmp_path):
    client = make_client(tmp_path)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FakeRigController(None, 0xA4)  # type: ignore[arg-type]
    )
    now = datetime.now(UTC)
    client.post("/api/v1/settings/radio", json={"rig_model": "ic705", "civ_address": "0xA4"})
    client.post("/api/v1/radio/connect")
    main.radio_control_service._controller.state.targets = {"vfo_a_freq_hz": 145500000, "vfo_b_freq_hz": 435000000, "scope_span_hz": 200000}
    main.radio_control_service._controller.state.raw_state = {"split_enabled": False, "scope_enabled": False}
    client.post(
        "/api/v1/radio/session/select",
        json={
            "sat_id": "iss-zarya",
            "sat_name": "ISS (ZARYA)",
            "pass_aos": (now + timedelta(minutes=5)).isoformat(),
            "pass_los": (now + timedelta(minutes=15)).isoformat(),
            "max_el_deg": 52.0,
        },
    )
    client.post("/api/v1/radio/session/test")
    disconnect_resp = client.post("/api/v1/radio/disconnect")
    assert disconnect_resp.status_code == 200
    runtime = disconnect_resp.json()["runtime"]
    assert runtime["connected"] is False
    controller = main.radio_control_service._controller
    assert controller is None


def test_radio_session_stop_does_not_500_when_restore_fails(tmp_path):
    client = make_client(tmp_path)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FailingRestoreRigController(None, 0xA4)  # type: ignore[arg-type]
    )
    now = datetime.now(UTC)
    client.post("/api/v1/settings/radio", json={"rig_model": "ic705", "civ_address": "0xA4"})
    client.post("/api/v1/radio/connect")
    client.post(
        "/api/v1/radio/session/select",
        json={
            "sat_id": "iss-zarya",
            "sat_name": "ISS (ZARYA)",
            "pass_aos": (now + timedelta(minutes=5)).isoformat(),
            "pass_los": (now + timedelta(minutes=15)).isoformat(),
            "max_el_deg": 52.0,
        },
    )
    client.post("/api/v1/radio/session/test")
    resp = client.post("/api/v1/radio/session/stop")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["session"]["screen_state"] == "released"
    assert "restore failed" in (payload["runtime"]["last_error"] or "").lower()


def test_radio_disconnect_endpoint_does_not_500_when_controller_disconnect_fails(tmp_path):
    client = make_client(tmp_path)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FailingDisconnectRigController(None, 0xA4)  # type: ignore[arg-type]
    )
    client.post("/api/v1/settings/radio", json={"rig_model": "ic705", "civ_address": "0xA4"})
    client.post("/api/v1/radio/connect")
    resp = client.post("/api/v1/radio/disconnect")
    assert resp.status_code == 200
    payload = resp.json()
    assert "runtime" in payload


def test_radio_ports_endpoint_returns_items_list(tmp_path):
    client = make_client(tmp_path)
    resp = client.get("/api/v1/radio/ports")
    assert resp.status_code == 200
    payload = resp.json()
    assert "items" in payload
    assert isinstance(payload["items"], list)


def test_radio_session_start_arms_before_aos(tmp_path):
    client = make_client(tmp_path)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FakeRigController(None, 0xA4)  # type: ignore[arg-type]
    )
    now = datetime.now(UTC)
    client.post("/api/v1/settings/radio", json={"rig_model": "ic705", "civ_address": "0xA4"})
    client.post("/api/v1/radio/connect")
    client.post(
        "/api/v1/radio/session/select",
        json={
            "sat_id": "iss-zarya",
            "sat_name": "ISS (ZARYA)",
            "pass_aos": (now + timedelta(minutes=5)).isoformat(),
            "pass_los": (now + timedelta(minutes=15)).isoformat(),
            "max_el_deg": 52.0,
        },
    )
    resp = client.post("/api/v1/radio/session/start")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["session"]["screen_state"] == "armed"
    assert payload["session"]["control_state"] == "armed_waiting_aos"
    client.post("/api/v1/radio/session/stop")


def test_radio_session_start_applies_when_ongoing(tmp_path):
    client = make_client(tmp_path)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FakeRigController(None, 0xA4)  # type: ignore[arg-type]
    )
    now = datetime.now(UTC)
    client.post("/api/v1/settings/radio", json={"rig_model": "ic705", "civ_address": "0xA4"})
    client.post("/api/v1/radio/connect")
    client.post(
        "/api/v1/radio/session/select",
        json={
            "sat_id": "iss-zarya",
            "sat_name": "ISS (ZARYA)",
            "pass_aos": (now - timedelta(minutes=2)).isoformat(),
            "pass_los": (now + timedelta(minutes=8)).isoformat(),
            "max_el_deg": 61.0,
        },
    )
    resp = client.post("/api/v1/radio/session/start")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["session"]["screen_state"] == "active"
    assert payload["session"]["control_state"] == "tracking_active"
    assert payload["runtime"]["control_mode"] in {"manual_applied", "auto_tracking"}
    client.post("/api/v1/radio/session/stop")


def test_ic705_keeps_absolute_ab_identity_after_vfo_b_write():
    transport = ScriptedIc705Transport(freq_a=145000000, freq_b=14100000)
    controller = Ic705Controller(transport, 0xA4)

    state = controller.connect()
    assert state.targets["vfo_a_freq_hz"] == 145000000
    assert state.targets["vfo_b_freq_hz"] == 14100000
    assert state.raw_state["selected_vfo"] == "A"

    state, result = controller.set_frequency("B", 14105000)
    assert result == {"vfo": "B", "freq_hz": 14105000}
    assert state.targets["vfo_a_freq_hz"] == 145000000
    assert state.targets["vfo_b_freq_hz"] == 14105000
    assert state.raw_state["selected_vfo"] == "A"


def test_ic705_apply_target_opens_squelch_and_sets_wide_scope():
    transport = ScriptedIc705Transport(freq_a=145000000, freq_b=437800000)
    controller = Ic705Controller(transport, 0xA4)
    recommendation = FrequencyRecommendation(
        sat_id="iss-zarya",
        mode=FrequencyGuideMode.fm,
        phase=GuidePassPhase.mid,
        label="ISS pass",
        is_upcoming=False,
        is_ongoing=True,
        correction_side=CorrectionSide.full_duplex,
        doppler_direction=DopplerDirection.high_to_low,
        uplink_mhz=145.99,
        downlink_mhz=437.795,
        uplink_mode="FM",
        downlink_mode="FM",
    )

    controller.connect()
    state, mapping = controller.apply_target(recommendation, apply_mode_and_tone=True)

    assert mapping["tx"] == "A"
    assert mapping["rx"] == "B"
    assert transport.squelch_level == 0.0
    assert transport.scope_enabled is True
    assert transport.scope_mode == Ic705Controller.SCOPE_MODE_CENTER
    assert transport.scope_span_hz == Ic705Controller.MAX_SCOPE_SPAN_HZ
    assert state.raw_state["split_enabled"] is True
    assert state.raw_state["squelch_level"] == 0.0
    assert state.raw_state["scope_enabled"] is True
    assert state.raw_state["scope_span_hz"] == Ic705Controller.MAX_SCOPE_SPAN_HZ


def test_ic705_snapshot_and_restore_restores_prior_state():
    transport = ScriptedIc705Transport(freq_a=145500000, freq_b=435000000)
    transport.mode_a = "USB"
    transport.mode_b = "AM"
    transport.selected_vfo = "B"
    transport.split_enabled = False
    transport.squelch_level = 0.5
    transport.scope_enabled = False
    transport.scope_mode = Ic705Controller.SCOPE_MODE_CENTER
    transport.scope_span_hz = 200000
    controller = Ic705Controller(transport, 0xA4)
    recommendation = FrequencyRecommendation(
        sat_id="iss-zarya",
        mode=FrequencyGuideMode.fm,
        phase=GuidePassPhase.mid,
        label="ISS pass",
        is_upcoming=False,
        is_ongoing=True,
        correction_side=CorrectionSide.full_duplex,
        doppler_direction=DopplerDirection.high_to_low,
        uplink_mhz=145.99,
        downlink_mhz=437.795,
        uplink_mode="FM",
        downlink_mode="FM",
    )

    controller.connect()
    snapshot = controller.snapshot_state()
    controller.apply_target(recommendation, apply_mode_and_tone=True)
    restored = controller.restore_snapshot(snapshot)

    assert restored.targets["vfo_a_freq_hz"] == 145500000
    assert restored.targets["vfo_b_freq_hz"] == 435000000
    assert restored.targets["vfo_a_mode"] == "USB"
    assert restored.targets["vfo_b_mode"] == "AM"
    assert restored.raw_state["split_enabled"] is False
    assert abs(restored.raw_state["squelch_level"] - 0.5) < 0.01
    assert restored.raw_state["scope_enabled"] is False
    assert restored.raw_state["scope_span_hz"] == 200000


def test_ic705_poll_preserves_known_pair_when_readback_is_garbage():
    transport = ScriptedIc705Transport(freq_a=145000000, freq_b=437800000)
    controller = Ic705Controller(transport, 0xA4)
    recommendation = FrequencyRecommendation(
        sat_id="iss-zarya",
        mode=FrequencyGuideMode.fm,
        phase=GuidePassPhase.mid,
        label="ISS pass",
        is_upcoming=False,
        is_ongoing=True,
        correction_side=CorrectionSide.full_duplex,
        doppler_direction=DopplerDirection.high_to_low,
        uplink_mhz=145.99,
        downlink_mhz=437.795,
        uplink_mode="FM",
        downlink_mode="FM",
    )

    controller.connect()
    state, _ = controller.apply_target(recommendation, apply_mode_and_tone=True)
    assert state.targets["vfo_a_freq_hz"] == 145990000
    assert state.targets["vfo_b_freq_hz"] == 437795000
    assert state.targets["vfo_a_mode"] == "FM"
    assert state.targets["vfo_b_mode"] == "FM"

    transport.force_bad_readback = True
    polled = controller.poll_state()

    assert polled.targets["vfo_a_freq_hz"] == 145990000
    assert polled.targets["vfo_b_freq_hz"] == 437795000
    assert polled.targets["vfo_a_mode"] == "FM"
    assert polled.targets["vfo_b_mode"] == "FM"


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

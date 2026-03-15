import json
from datetime import UTC, datetime, timedelta
import shutil
import subprocess
from time import sleep
from types import MethodType

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.aprs.codec import decode_ui_frame, encode_ui_frame
from app.aprs.direwolf import DireWolfProcess
from app.aprs.service import AprsService
from app.models import (
    AprsOperatingMode,
    AprsSendStatusRequest,
    AprsSettings,
    AprsTargetState,
    CorrectionSide,
    DopplerDirection,
    FrequencyGuideMode,
    FrequencyRecommendation,
    GuidePassPhase,
    IssDisplayMode,
    LiveTrack,
    PassEvent,
    RadioRigModel,
    RadioTransportMode,
    Satellite,
)
from app.radio.civ import ACK, build_frame, freq_to_bcd
from app.radio.controllers.base import BaseIcomController
from app.radio.controllers.ic705 import Ic705Controller
from app.radio.service import RigControlService
from app.services import DataIngestionService, FrequencyGuideService, TrackingService
from app.services import PassPredictionCacheService
from app.store import StateStore


def make_client(tmp_path):
    main.store = StateStore(str(tmp_path / "state.json"))
    main.tracking_service = TrackingService(str(tmp_path / "latest_catalog.json"))
    main.ingestion_service = DataIngestionService()
    main.radio_control_service = RigControlService()
    main.aprs_service = AprsService()
    main.pass_cache_service = PassPredictionCacheService(str(tmp_path / "pass_predictions_cache.json"))
    return TestClient(main.app)


def configure_station_identity(client: TestClient, callsign: str = "VK4ABC") -> None:
    resp = client.post("/api/v1/settings/aprs", json={"callsign": callsign})
    assert resp.status_code == 200


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


class FakeDireWolfSidecar:
    def __init__(self) -> None:
        self.command = []
        self.output_tail = []
        self.running = False

    def start(self, settings, target):
        self.running = True
        self.command = [settings.direwolf_binary, "-c", "fake-direwolf.conf"]
        self.output_tail = [f"started {target.frequency_hz}"]
        return self.command, self.output_tail

    def start_network_decoder(self, settings, target, *, udp_port, sample_rate=48000):
        self.running = True
        self.command = [settings.direwolf_binary, "-c", "fake-direwolf.conf", f"UDP:{udp_port}"]
        self.output_tail = [f"started network decoder {target.frequency_hz} @ {sample_rate}"]
        return self.command, self.output_tail

    def stop(self):
        self.running = False

    def is_running(self):
        return self.running


class FakeKissClient:
    def __init__(self, host, port, callback):
        self.host = host
        self.port = port
        self.callback = callback
        self.connected = False
        self.sent = []

    def connect(self, timeout=3.0):
        self.connected = True

    def close(self):
        self.connected = False

    def send_data(self, payload, channel=0):
        self.sent.append((payload, channel))

    def inject(self, payload):
        self.callback(payload)


class FakeAprsService(AprsService):
    def __init__(self) -> None:
        self.last_tuned_frequency = None
        self.kiss_clients = []
        super().__init__(
            sidecar_factory=lambda: FakeDireWolfSidecar(),
            kiss_factory=self._make_kiss_client,
            wait_for_socket_fn=lambda host, port, timeout: None,
        )

    def _make_kiss_client(self, host, port, callback):
        client = FakeKissClient(host, port, callback)
        self.kiss_clients.append(client)
        return client

    def _tune_radio(self, settings, frequency_hz: int) -> None:
        self.last_tuned_frequency = int(frequency_hz)


class FakeWifiSession:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs
        self.calls: list[tuple[str, object]] = []
        self.audio_rx_callback = None
        self.snapshot = {"frequency": 145175000, "vfo": "A", "split": False}
        self.vox_enabled = True
        self.selected_vfo = "A"
        self.vfo_a_freq = 145175000
        self.vfo_b_freq = 145175000
        self.mode = "FM"

    def connect(self):
        self.calls.append(("connect", None))

    def disconnect(self):
        self.calls.append(("disconnect", None))

    def snapshot_state(self):
        self.calls.append(("snapshot_state", None))
        snapshot = dict(self.snapshot)
        snapshot["vfo"] = self.selected_vfo
        snapshot["split"] = self.snapshot.get("split", False)
        snapshot["frequency"] = self.vfo_a_freq if self.selected_vfo == "A" else self.vfo_b_freq
        return snapshot

    def restore_state(self, snapshot):
        self.calls.append(("restore_state", dict(snapshot)))

    def get_vox(self):
        self.calls.append(("get_vox", None))
        return self.vox_enabled

    def set_vox(self, on):
        self.calls.append(("set_vox", bool(on)))
        self.vox_enabled = bool(on)

    def get_mode(self, receiver=0):
        self.calls.append(("get_mode", int(receiver)))
        return (self.mode, None)

    def get_frequency(self):
        self.calls.append(("get_frequency", None))
        return self.vfo_a_freq if self.selected_vfo == "A" else self.vfo_b_freq

    def get_data_mode(self):
        self.calls.append(("get_data_mode", None))
        return True

    def get_data_off_mod_input(self):
        self.calls.append(("get_data_off_mod_input", None))
        return 5

    def get_data1_mod_input(self):
        self.calls.append(("get_data1_mod_input", None))
        return 3

    def select_vfo(self, vfo):
        self.calls.append(("select_vfo", vfo))
        self.selected_vfo = str(vfo)

    def set_split_mode(self, on):
        self.calls.append(("set_split_mode", bool(on)))
        self.snapshot["split"] = bool(on)

    def set_mode(self, mode):
        self.calls.append(("set_mode", mode))
        self.mode = str(mode)

    def set_data_mode(self, on):
        self.calls.append(("set_data_mode", bool(on)))

    def set_data_off_mod_input(self, source):
        self.calls.append(("set_data_off_mod_input", int(source)))

    def set_data1_mod_input(self, source):
        self.calls.append(("set_data1_mod_input", int(source)))

    def set_frequency(self, freq_hz):
        self.calls.append(("set_frequency", int(freq_hz)))
        if self.selected_vfo == "B":
            self.vfo_b_freq = int(freq_hz)
        else:
            self.vfo_a_freq = int(freq_hz)

    def vfo_equalize(self):
        self.calls.append(("vfo_equalize", None))
        self.vfo_b_freq = self.vfo_a_freq

    def start_audio_rx(self, callback):
        self.audio_rx_callback = callback
        self.calls.append(("start_audio_rx", None))

    def stop_audio_rx(self):
        self.calls.append(("stop_audio_rx", None))

    def start_audio_tx(self):
        self.calls.append(("start_audio_tx", None))

    def push_audio_tx(self, pcm_bytes):
        self.calls.append(("push_audio_tx", len(pcm_bytes)))

    def stop_audio_tx(self):
        self.calls.append(("stop_audio_tx", None))

    def set_ptt(self, on):
        self.calls.append(("set_ptt", bool(on)))

    def set_squelch(self, level, receiver=0):
        self.calls.append(("set_squelch", (int(level), int(receiver))))

    def enable_scope(self, *, output=False, policy="fast"):
        self.calls.append(("enable_scope", (bool(output), policy)))

    def set_scope_mode(self, mode):
        self.calls.append(("set_scope_mode", int(mode)))

    def set_scope_span(self, span):
        self.calls.append(("set_scope_span", int(span)))


class FailingVerifyWifiSession(FakeWifiSession):
    def get_data_mode(self):
        self.calls.append(("get_data_mode", None))
        return False


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
            mode_code = Ic705Controller.MODE_MAP[str(mode_name).replace("-D", "")]
            return build_frame(to_addr=0xE0, command=Ic705Controller.C_RD_MODE, payload=bytes([mode_code, 0x01]), from_addr=to_addr)
        if command == Ic705Controller.C_SEL_MODE:
            if len(payload) >= 4:
                selected = payload[:1] == b"\x00"
                mode_name = next((name for name, code in Ic705Controller.MODE_MAP.items() if code == payload[1]), None) or "UNKNOWN"
                if payload[2] == 0x01 and mode_name not in {"DSTAR", "D-STAR"}:
                    mode_name = f"{mode_name}-D"
                target_a = (self.selected_vfo == "A") == selected
                if target_a:
                    self.mode_a = mode_name
                else:
                    self.mode_b = mode_name
                return build_frame(0xE0, ACK, b"", from_addr=to_addr)
            selected = payload[:1] == b"\x00"
            if self.force_bad_readback:
                selector = b"\x00" if selected else b"\x01"
                return build_frame(to_addr=0xE0, command=Ic705Controller.C_SEL_MODE, payload=selector + bytes([0x00, 0x00, 0x00, 0x00]), from_addr=to_addr)
            mode_name = self.mode_a if (self.selected_vfo == "A") == selected else self.mode_b
            mode_code = Ic705Controller.MODE_MAP[str(mode_name).replace("-D", "")]
            selector = b"\x00" if selected else b"\x01"
            data_on = 0x01 if str(mode_name).endswith("-D") else 0x00
            return build_frame(to_addr=0xE0, command=Ic705Controller.C_SEL_MODE, payload=selector + bytes([mode_code, data_on, 0x01]), from_addr=to_addr)
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


def test_set_and_get_radio_wifi_settings(tmp_path):
    client = make_client(tmp_path)

    resp = client.post(
        "/api/v1/settings/radio",
        json={
            "enabled": True,
            "rig_model": "ic705",
            "transport_mode": "wifi",
            "wifi_host": "192.168.2.70",
            "wifi_username": "demo-user",
            "wifi_password": "secret-pass",
            "wifi_control_port": 50001,
            "civ_address": "0xA4",
        },
    )
    assert resp.status_code == 200
    payload = resp.json()["state"]
    assert payload["transport_mode"] == "wifi"
    assert payload["wifi_host"] == "192.168.2.70"
    assert payload["wifi_username"] == "demo-user"
    assert payload["wifi_control_port"] == 50001

    get_resp = client.get("/api/v1/settings/radio")
    assert get_resp.status_code == 200
    state = get_resp.json()["state"]
    assert state["transport_mode"] == "wifi"
    assert state["wifi_host"] == "192.168.2.70"


def test_radio_wifi_settings_require_ic705_and_host(tmp_path):
    client = make_client(tmp_path)

    missing_host = client.post(
        "/api/v1/settings/radio",
        json={"rig_model": "ic705", "transport_mode": "wifi", "wifi_username": "demo-user"},
    )
    assert missing_host.status_code == 400
    assert "host is required" in missing_host.json()["detail"].lower()

    wrong_model = client.post(
        "/api/v1/settings/radio",
        json={
            "rig_model": "id5100",
            "transport_mode": "wifi",
            "wifi_host": "192.168.2.70",
            "wifi_username": "demo-user",
        },
    )
    assert wrong_model.status_code == 400
    assert "supported only for the ic-705" in wrong_model.json()["detail"].lower()


def test_radio_connect_apply_and_stop(tmp_path):
    client = make_client(tmp_path)
    configure_station_identity(client)
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
    configure_station_identity(client)
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
    configure_station_identity(client)
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
    configure_station_identity(client)
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
    configure_station_identity(client)
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
    configure_station_identity(client)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FakeRigController(None, 0xA4)  # type: ignore[arg-type]
    )
    client.post("/api/v1/settings/radio", json={"rig_model": "ic705", "civ_address": "0xA4"})
    client.post("/api/v1/radio/connect")
    resp = client.post("/api/v1/radio/pair", json={"uplink_hz": 29000000, "downlink_hz": 1268000000})
    assert resp.status_code == 400
    assert "outside supported VHF/UHF range" in resp.json()["detail"]


def test_radio_session_select_and_clear(tmp_path):
    client = make_client(tmp_path)
    configure_station_identity(client)
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
    configure_station_identity(client)
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
                downlink_mhz=1268.0,
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


def test_radio_session_select_marks_downlink_only_satellite_eligible(tmp_path):
    client = make_client(tmp_path)
    configure_station_identity(client)
    aos = datetime.now(UTC) + timedelta(minutes=5)
    los = aos + timedelta(minutes=10)
    original_service = main.frequency_guide_service

    class FakeFrequencyGuideService:
        def recommendation(self, sat_id, *args, **kwargs):
            return FrequencyRecommendation(
                sat_id=sat_id,
                mode=FrequencyGuideMode.fm,
                phase=GuidePassPhase.mid,
                label="Receive only",
                is_upcoming=False,
                is_ongoing=True,
                correction_side=CorrectionSide.downlink_only,
                doppler_direction=DopplerDirection.high_to_low,
                uplink_mhz=None,
                downlink_mhz=437.175,
                downlink_mode="FM",
            )

    main.frequency_guide_service = FakeFrequencyGuideService()
    try:
        resp = client.post(
            "/api/v1/radio/session/select",
            json={
                "sat_id": "receieve-only",
                "sat_name": "Receive Only Sat",
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
    assert payload["is_eligible"] is True
    assert payload["has_test_pair"] is True


def test_radio_session_test_and_confirm_release(tmp_path):
    client = make_client(tmp_path)
    configure_station_identity(client)
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
    configure_station_identity(client)
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
    configure_station_identity(client)
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
    configure_station_identity(client)
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
    configure_station_identity(client)
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
    configure_station_identity(client)
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
    configure_station_identity(client)
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


def test_ic705_apply_target_supports_receive_only_downlink():
    transport = ScriptedIc705Transport(freq_a=145500000, freq_b=430000000)
    controller = Ic705Controller(transport, 0xA4)
    recommendation = FrequencyRecommendation(
        sat_id="silversat",
        mode=FrequencyGuideMode.fm,
        phase=GuidePassPhase.mid,
        label="Receive only",
        is_upcoming=False,
        is_ongoing=True,
        correction_side=CorrectionSide.downlink_only,
        doppler_direction=DopplerDirection.high_to_low,
        uplink_mhz=None,
        downlink_mhz=437.175,
        downlink_mode="FM",
    )

    controller.connect()
    state, mapping = controller.apply_target(recommendation, apply_mode_and_tone=True)

    assert mapping["tx"] is None
    assert mapping["rx"] == "B"
    assert mapping["receive_only"] is True
    assert state.targets["vfo_a_freq_hz"] == 145500000
    assert state.targets["vfo_b_freq_hz"] == 437175000
    assert state.raw_state["split_enabled"] is False
    assert state.raw_state["receive_only"] is True
    assert state.raw_state["selected_vfo"] == "B"


def test_aprs_panic_unkey_disconnects_runtime(tmp_path):
    client = make_client(tmp_path)
    main.aprs_service = FakeAprsService()

    client.post(
        "/api/v1/location",
        json={
            "source_mode": "manual",
            "add_profile": {
                "id": "brisbane",
                "name": "Brisbane",
                "point": {"lat": -27.4698, "lon": 153.0251, "alt_m": 25},
            },
            "selected_profile_id": "brisbane",
        },
    )
    client.post(
        "/api/v1/settings/aprs",
        json={
            "enabled": True,
            "callsign": "VK4ABC",
            "ssid": 10,
            "operating_mode": "terrestrial",
            "serial_device": "/dev/ttyUSB0",
        },
    )
    client.post("/api/v1/aprs/connect")

    resp = client.post("/api/v1/aprs/panic-unkey")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["ok"] is True
    assert payload["runtime"]["connected"] is False
    assert payload["runtime"]["session_active"] is False


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


def test_passes_endpoint_uses_cache_and_refresh_invalidates(tmp_path):
    client = make_client(tmp_path)
    calls = {"pass_predictions": 0}

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
            calls["pass_predictions"] += 1
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
        first = client.get("/api/v1/passes?include_all_sats=true&include_ongoing=true")
        assert first.status_code == 200
        assert first.json()["cache"]["source"] == "generated"
        assert calls["pass_predictions"] == 1

        second = client.get("/api/v1/passes?include_all_sats=true&include_ongoing=true")
        assert second.status_code == 200
        assert second.json()["cache"]["source"] == "cache"
        assert calls["pass_predictions"] == 1

        refresh = client.post("/api/v1/passes/cache/refresh")
        assert refresh.status_code == 200

        third = client.get("/api/v1/passes?include_all_sats=true&include_ongoing=true")
        assert third.status_code == 200
        assert third.json()["cache"]["source"] == "generated"
        assert calls["pass_predictions"] == 2
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


def test_aprs_targets_include_explicit_satellite_and_terrestrial_region(tmp_path):
    client = make_client(tmp_path)

    client.post(
        "/api/v1/location",
        json={
            "source_mode": "manual",
            "add_profile": {
                "id": "brisbane",
                "name": "Brisbane",
                "point": {"lat": -27.4698, "lon": 153.0251, "alt_m": 25},
            },
            "selected_profile_id": "brisbane",
        },
    )

    resp = client.get("/api/v1/aprs/targets")
    assert resp.status_code == 200
    payload = resp.json()
    satellites = payload["targets"]["satellites"]
    assert any(item["sat_id"] == "iss-zarya" for item in satellites)
    assert payload["targets"]["terrestrial"]["region_label"] == "Australia and Oceania"
    assert payload["targets"]["terrestrial"]["suggested_frequency_hz"] == 145175000


def test_aprs_select_target_rejects_non_aprs_satellite(tmp_path):
    client = make_client(tmp_path)

    resp = client.post("/api/v1/aprs/select-target", json={"operating_mode": "satellite", "sat_id": "so50"})
    assert resp.status_code == 400
    assert "does not support APRS" in resp.json()["detail"]


def test_aprs_connect_blocks_radio_control_and_tracks_received_packets(tmp_path):
    client = make_client(tmp_path)
    main.aprs_service = FakeAprsService()

    client.post(
        "/api/v1/location",
        json={
            "source_mode": "manual",
            "add_profile": {
                "id": "brisbane",
                "name": "Brisbane",
                "point": {"lat": -27.4698, "lon": 153.0251, "alt_m": 25},
            },
            "selected_profile_id": "brisbane",
        },
    )
    save = client.post(
        "/api/v1/settings/aprs",
        json={
            "enabled": True,
            "callsign": "VK4ABC",
            "ssid": 10,
            "operating_mode": "terrestrial",
            "serial_device": "/dev/ttyUSB0",
            "audio_input_device": "default",
            "audio_output_device": "default",
        },
    )
    assert save.status_code == 200

    connect = client.post("/api/v1/aprs/connect")
    assert connect.status_code == 200
    assert connect.json()["runtime"]["connected"] is True
    assert main.aprs_service.last_tuned_frequency == 145175000

    blocked = client.post("/api/v1/radio/connect")
    assert blocked.status_code == 409
    assert "APRS owns radio session" in blocked.json()["detail"]

    fake_kiss = main.aprs_service.kiss_clients[-1]
    fake_kiss.inject(encode_ui_frame("VK4XYZ-7", "APRS", ["WIDE1-1"], ">OrbitDeck test"))
    aprs_state = client.get("/api/v1/aprs/state").json()
    assert aprs_state["runtime"]["packets_rx"] == 1
    assert aprs_state["runtime"]["heard_count"] == 1
    assert aprs_state["runtime"]["heard_stations"][0]["callsign"] == "VK4XYZ-7"


def test_aprs_send_endpoints_increment_tx_counters(tmp_path):
    client = make_client(tmp_path)
    main.aprs_service = FakeAprsService()

    client.post(
        "/api/v1/location",
        json={
            "source_mode": "manual",
            "add_profile": {
                "id": "brisbane",
                "name": "Brisbane",
                "point": {"lat": -27.4698, "lon": 153.0251, "alt_m": 25},
            },
            "selected_profile_id": "brisbane",
        },
    )
    client.post(
        "/api/v1/settings/aprs",
        json={
            "enabled": True,
            "callsign": "VK4ABC",
            "ssid": 10,
            "operating_mode": "terrestrial",
            "serial_device": "/dev/ttyUSB0",
            "audio_input_device": "default",
            "audio_output_device": "default",
        },
    )
    client.post("/api/v1/aprs/connect")

    m = client.post("/api/v1/aprs/send/message", json={"to": "VK4XYZ", "text": "hello"})
    s = client.post("/api/v1/aprs/send/status", json={"text": "status"})
    p = client.post("/api/v1/aprs/send/position", json={"comment": "portable"})

    assert m.status_code == 200
    assert s.status_code == 200
    assert p.status_code == 200
    aprs_state = client.get("/api/v1/aprs/state").json()
    assert aprs_state["runtime"]["packets_tx"] == 3


def test_aprs_settings_store_separate_space_and_terrestrial_comments(tmp_path):
    client = make_client(tmp_path)

    resp = client.post(
        "/api/v1/settings/aprs",
        json={
            "terrestrial_beacon_comment": "OrbitDeck terrestrial",
            "satellite_beacon_comment": "OrbitDeck space",
            "operating_mode": "satellite",
        },
    )
    assert resp.status_code == 200
    state = resp.json()["state"]
    assert state["terrestrial_beacon_comment"] == "OrbitDeck terrestrial"
    assert state["satellite_beacon_comment"] == "OrbitDeck space"


def test_aprs_position_send_uses_mode_specific_default_comment(tmp_path):
    client = make_client(tmp_path)
    main.aprs_service = FakeAprsService()

    client.post(
        "/api/v1/location",
        json={
            "source_mode": "manual",
            "add_profile": {
                "id": "brisbane",
                "name": "Brisbane",
                "point": {"lat": -27.4698, "lon": 153.0251, "alt_m": 25},
            },
            "selected_profile_id": "brisbane",
        },
    )
    client.post(
        "/api/v1/settings/aprs",
        json={
            "enabled": True,
            "callsign": "VK4ABC",
            "operating_mode": "terrestrial",
            "serial_device": "/dev/ttyUSB0",
            "audio_input_device": "default",
            "audio_output_device": "default",
            "terrestrial_beacon_comment": "LAND",
            "satellite_beacon_comment": "SPACE",
        },
    )
    client.post("/api/v1/aprs/connect")
    terrestrial_send = client.post("/api/v1/aprs/send/position", json={})
    assert terrestrial_send.status_code == 200
    terrestrial_frame = main.aprs_service.kiss_clients[-1].sent[-1][0]
    assert decode_ui_frame(terrestrial_frame).text.endswith("LAND")

    targets = client.get("/api/v1/aprs/targets").json()["targets"]["satellites"]
    iss = next(item for item in targets if item["sat_id"] == "iss-zarya")
    channel_id = iss["channels"][0]["channel_id"]
    original_pass_predictions = main.tracking_service.pass_predictions

    def active_pass_predictions(self, start_time, hours, location, sat_ids=None, include_ongoing=False):
        return [
            PassEvent(
                sat_id="iss-zarya",
                name="ISS (ZARYA)",
                aos=start_time - timedelta(minutes=1),
                tca=start_time,
                los=start_time + timedelta(minutes=8),
                max_el_deg=48.0,
            )
        ]

    main.tracking_service.pass_predictions = MethodType(active_pass_predictions, main.tracking_service)
    client.post(
        "/api/v1/aprs/select-target",
        json={"operating_mode": "satellite", "sat_id": "iss-zarya", "channel_id": channel_id},
    )
    try:
        satellite_connect = client.post("/api/v1/aprs/connect")
        assert satellite_connect.status_code == 200
        satellite_send = client.post("/api/v1/aprs/send/position", json={})
        assert satellite_send.status_code == 200
        satellite_frame = main.aprs_service.kiss_clients[-1].sent[-1][0]
        assert decode_ui_frame(satellite_frame).text.endswith("SPACE")
    finally:
        main.tracking_service.pass_predictions = original_pass_predictions


def test_radio_control_requires_station_callsign(tmp_path):
    client = make_client(tmp_path)

    resp = client.post("/api/v1/radio/connect")
    assert resp.status_code == 403
    assert "callsign" in resp.json()["detail"].lower()


def test_aprs_connect_requires_station_callsign(tmp_path):
    client = make_client(tmp_path)
    main.aprs_service = FakeAprsService()

    client.post(
        "/api/v1/location",
        json={
            "source_mode": "manual",
            "add_profile": {
                "id": "brisbane",
                "name": "Brisbane",
                "point": {"lat": -27.4698, "lon": 153.0251, "alt_m": 25},
            },
            "selected_profile_id": "brisbane",
        },
    )
    client.post(
        "/api/v1/settings/aprs",
        json={
            "enabled": True,
            "operating_mode": "terrestrial",
            "serial_device": "/dev/ttyUSB0",
            "audio_input_device": "default",
            "audio_output_device": "default",
        },
    )

    resp = client.post("/api/v1/aprs/connect")
    assert resp.status_code == 403
    assert "callsign" in resp.json()["detail"].lower()


def test_aprs_connect_surfaces_serial_error_as_bad_request(tmp_path):
    client = make_client(tmp_path)

    class FailingAprsService(FakeAprsService):
        def connect(self, settings, target, *, radio_settings=None, retune_resolver=None, interval_s=1.0):
            raise OSError("[Errno 2] could not open port /dev/cu.fake: No such file or directory")

    main.aprs_service = FailingAprsService()

    client.post("/api/v1/settings/aprs", json={"callsign": "VK4ABC"})
    client.post(
        "/api/v1/location",
        json={
            "source_mode": "manual",
            "add_profile": {
                "id": "brisbane",
                "name": "Brisbane",
                "point": {"lat": -27.4698, "lon": 153.0251, "alt_m": 25},
            },
            "selected_profile_id": "brisbane",
        },
    )
    client.post(
        "/api/v1/aprs/session/select",
        json={"operating_mode": "terrestrial"},
    )

    resp = client.post("/api/v1/aprs/connect")
    assert resp.status_code == 400
    assert "could not open port" in resp.json()["detail"].lower()


def test_aprs_service_wifi_backend_uses_native_audio_and_ptt(tmp_path):
    fake_wifi = FakeWifiSession()
    service = AprsService(
        sidecar_factory=lambda: FakeDireWolfSidecar(),
        kiss_factory=lambda host, port, cb: FakeKissClient(host, port, cb),
        wait_for_socket_fn=lambda host, port, timeout: None,
        wifi_session_factory=lambda **kwargs: fake_wifi,
    )
    settings = AprsSettings(
        callsign="VK4ABC",
        ssid=7,
        rig_model=RadioRigModel.ic705,
        civ_address="0xA4",
        direwolf_binary="/opt/homebrew/bin/direwolf",
    )
    radio_settings = main.store.get().radio_settings.model_copy(
        update={
            "rig_model": RadioRigModel.ic705,
            "transport_mode": RadioTransportMode.wifi,
            "wifi_host": "192.168.2.70",
            "wifi_username": "demo-user",
            "wifi_password": "secret-pass",
            "wifi_control_port": 50001,
        }
    )
    target = AprsTargetState(
        operating_mode=AprsOperatingMode.terrestrial,
        label="Terrestrial APRS",
        frequency_hz=145175000,
        path_default="WIDE1-1,WIDE2-1",
    )

    runtime = service.connect(settings, target, radio_settings=radio_settings)
    assert runtime.transport_mode == "wifi"
    assert runtime.capabilities == {
        "cat_control": True,
        "rx_audio": True,
        "tx_audio": True,
        "ptt": True,
    }
    assert ("snapshot_state", None) in fake_wifi.calls
    assert ("get_vox", None) in fake_wifi.calls
    assert ("set_vox", False) in fake_wifi.calls
    assert ("set_split_mode", False) in fake_wifi.calls
    assert ("set_frequency", 145175000) in fake_wifi.calls
    assert ("set_mode", "FM") in fake_wifi.calls
    assert ("vfo_equalize", None) in fake_wifi.calls
    assert ("set_squelch", (0, 0)) in fake_wifi.calls
    assert ("enable_scope", (False, "fast")) in fake_wifi.calls
    assert ("set_scope_mode", 0) in fake_wifi.calls
    assert ("set_scope_span", 7) in fake_wifi.calls
    assert ("get_mode", 0) in fake_wifi.calls
    assert ("get_data_mode", None) in fake_wifi.calls
    assert ("get_data_off_mod_input", None) in fake_wifi.calls
    assert ("get_data1_mod_input", None) in fake_wifi.calls
    assert ("set_data_off_mod_input", 5) in fake_wifi.calls
    assert ("set_data1_mod_input", 3) in fake_wifi.calls
    assert ("start_audio_rx", None) in fake_wifi.calls

    service.send_status(settings, AprsSendStatusRequest(text="wifi status"))
    assert ("start_audio_tx", None) in fake_wifi.calls
    assert ("set_ptt", True) in fake_wifi.calls
    assert any(name == "push_audio_tx" and size > 0 for name, size in fake_wifi.calls if isinstance(size, int))
    assert ("set_ptt", False) in fake_wifi.calls

    service.disconnect()
    assert ("restore_state", fake_wifi.snapshot) in fake_wifi.calls


def test_aprs_service_wifi_backend_restores_snapshot_on_setup_failure(tmp_path):
    fake_wifi = FailingVerifyWifiSession()
    service = AprsService(
        sidecar_factory=lambda: FakeDireWolfSidecar(),
        kiss_factory=lambda host, port, cb: FakeKissClient(host, port, cb),
        wait_for_socket_fn=lambda host, port, timeout: None,
        wifi_session_factory=lambda **kwargs: fake_wifi,
    )
    settings = AprsSettings(
        callsign="VK4ABC",
        ssid=7,
        rig_model=RadioRigModel.ic705,
        civ_address="0xA4",
        direwolf_binary="/opt/homebrew/bin/direwolf",
    )
    radio_settings = main.store.get().radio_settings.model_copy(
        update={
            "rig_model": RadioRigModel.ic705,
            "transport_mode": RadioTransportMode.wifi,
            "wifi_host": "192.168.2.70",
            "wifi_username": "demo-user",
            "wifi_password": "secret-pass",
            "wifi_control_port": 50001,
        }
    )
    target = AprsTargetState(
        operating_mode=AprsOperatingMode.terrestrial,
        label="Terrestrial APRS",
        frequency_hz=145175000,
        path_default="WIDE1-1,WIDE2-1",
    )

    with pytest.raises(RuntimeError, match="DATA mode is not enabled"):
        service.connect(settings, target, radio_settings=radio_settings)

    assert ("restore_state", fake_wifi.snapshot) in fake_wifi.calls


def test_direwolf_network_decoder_command_uses_udp_source(tmp_path):
    process = DireWolfProcess(workdir=str(tmp_path / "aprs-sidecar"))
    process._terminate_conflicting_direwolf = lambda port: None
    process._wait_for_port_state = lambda port, in_use, timeout=3.0: None
    settings = AprsSettings(callsign="VK4ABC", direwolf_binary="/opt/homebrew/bin/direwolf")
    target = AprsTargetState(
        operating_mode=AprsOperatingMode.terrestrial,
        label="Terrestrial APRS",
        frequency_hz=145175000,
        path_default="WIDE1-1,WIDE2-1",
    )

    captured = {}

    def fake_popen(cmd, cwd=None, stdout=None, stderr=None, text=None, **kwargs):
        captured["cmd"] = cmd
        captured["cwd"] = cwd
        class Proc:
            def __init__(self):
                self.stdout = None
                self.stderr = None
            def poll(self):
                return None
        return Proc()

    original = subprocess.Popen
    subprocess.Popen = fake_popen
    try:
        process.start_network_decoder(settings, target, udp_port=9134)
    finally:
        subprocess.Popen = original
    assert captured["cmd"][-1] == "UDP:9134"
    assert "-r" in captured["cmd"]
    assert captured["cwd"] == str(tmp_path / "aprs-sidecar")


def test_aprs_connect_passes_wifi_radio_settings_to_service(tmp_path):
    client = make_client(tmp_path)
    configure_station_identity(client)

    captured = {}

    class CapturingAprsService(FakeAprsService):
        def connect(self, settings, target, *, radio_settings=None, retune_resolver=None, interval_s=1.0):
            captured["radio_settings"] = radio_settings
            return super().connect(settings, target, radio_settings=None, retune_resolver=retune_resolver, interval_s=interval_s)

    main.aprs_service = CapturingAprsService()
    client.post(
        "/api/v1/settings/radio",
        json={
            "enabled": True,
            "rig_model": "ic705",
            "transport_mode": "wifi",
            "wifi_host": "192.168.2.70",
            "wifi_username": "demo-user",
            "wifi_password": "secret-pass",
            "wifi_control_port": 50001,
            "civ_address": "0xA4",
        },
    )
    client.post("/api/v1/aprs/session/select", json={"operating_mode": "terrestrial"})
    resp = client.post("/api/v1/aprs/connect")
    assert resp.status_code == 200
    assert captured["radio_settings"].transport_mode == RadioTransportMode.wifi


def test_radio_wifi_connect_runtime_exposes_endpoint(tmp_path):
    client = make_client(tmp_path)
    configure_station_identity(client)
    main.radio_control_service = RigControlService(
        controller_factory=lambda settings: FakeRigController(None, 0xA4)  # type: ignore[arg-type]
    )

    settings_resp = client.post(
        "/api/v1/settings/radio",
        json={
            "enabled": True,
            "rig_model": "ic705",
            "transport_mode": "wifi",
            "wifi_host": "192.168.2.70",
            "wifi_username": "demo-user",
            "wifi_password": "secret-pass",
            "wifi_control_port": 50001,
            "civ_address": "0xA4",
        },
    )
    assert settings_resp.status_code == 200

    connect_resp = client.post("/api/v1/radio/connect")
    assert connect_resp.status_code == 200
    runtime = connect_resp.json()["runtime"]
    assert runtime["connected"] is True
    assert runtime["transport_mode"] == "wifi"
    assert runtime["endpoint"] == "192.168.2.70:50001"


def test_aprs_connect_reuses_connected_radio_settings(tmp_path):
    client = make_client(tmp_path)
    main.aprs_service = FakeAprsService()
    client.post("/api/v1/settings/aprs", json={"callsign": "VK4ABC", "serial_device": "/dev/ttyUSB0"})
    client.post(
        "/api/v1/settings/radio",
        json={
            "enabled": True,
            "rig_model": "ic705",
            "serial_device": "/dev/cu.usbmodem114201",
            "baud_rate": 19200,
            "civ_address": "0xA4",
        },
    )
    main.radio_control_service._runtime.connected = True
    client.post(
        "/api/v1/location",
        json={
            "source_mode": "manual",
            "add_profile": {
                "id": "brisbane",
                "name": "Brisbane",
                "point": {"lat": -27.4698, "lon": 153.0251, "alt_m": 25},
            },
            "selected_profile_id": "brisbane",
        },
    )
    client.post("/api/v1/aprs/session/select", json={"operating_mode": "terrestrial"})

    resp = client.post("/api/v1/aprs/connect")
    assert resp.status_code == 200
    assert resp.json()["settings"]["serial_device"] == "/dev/cu.usbmodem114201"


def test_aprs_direwolf_status_reports_missing_binary(tmp_path, monkeypatch):
    client = make_client(tmp_path)
    monkeypatch.setattr(main.shutil, "which", lambda name: "/opt/homebrew/bin/brew" if name == "brew" else None)

    resp = client.get("/api/v1/aprs/direwolf/status")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["installed"] is False
    assert payload["canInstall"] is True
    assert payload["installer"] == "brew"


def test_aprs_direwolf_install_updates_configured_binary(tmp_path, monkeypatch):
    client = make_client(tmp_path)

    def fake_which(name):
      if name == "brew":
        return "/opt/homebrew/bin/brew"
      if name in {"direwolf", "/opt/homebrew/bin/direwolf"}:
        return "/opt/homebrew/bin/direwolf"
      return None

    monkeypatch.setattr(main.shutil, "which", fake_which)
    monkeypatch.setattr(
        main.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, stdout="installed", stderr=""),
    )

    resp = client.post("/api/v1/aprs/direwolf/install")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["ok"] is True
    assert payload["status"]["installed"] is True
    assert payload["status"]["resolvedBinary"] == "/opt/homebrew/bin/direwolf"

    settings = client.get("/api/v1/settings/aprs").json()["state"]
    assert settings["direwolf_binary"] == "/opt/homebrew/bin/direwolf"


def test_aprs_direwolf_install_terminal_launches_osascript(tmp_path, monkeypatch):
    client = make_client(tmp_path)
    calls = {"cmd": None}

    def fake_which(name):
        if name == "brew":
            return "/opt/homebrew/bin/brew"
        if name == "osascript":
            return "/usr/bin/osascript"
        return None

    def fake_run(cmd, **kwargs):
        calls["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(main.shutil, "which", fake_which)
    monkeypatch.setattr(main.subprocess, "run", fake_run)

    resp = client.post("/api/v1/aprs/direwolf/install-terminal")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["ok"] is True
    assert payload["launched"] is True
    assert calls["cmd"][0] == "/usr/bin/osascript"


def test_aprs_audio_devices_endpoint_parses_macos_devices(tmp_path, monkeypatch):
    client = make_client(tmp_path)
    monkeypatch.setattr(main.platform, "system", lambda: "Darwin")
    sample = {
        "SPAudioDataType": [
            {
                "_items": [
                    {"_name": "USB Audio CODEC", "coreaudio_device_input": 2},
                    {"_name": "USB Audio CODEC", "coreaudio_device_output": 2},
                    {"_name": "MacBook Pro Microphone", "coreaudio_device_input": 1},
                    {"_name": "MacBook Pro Speakers", "coreaudio_device_output": 2},
                ]
            }
        ]
    }
    monkeypatch.setattr(
        main.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, stdout=json.dumps(sample), stderr=""),
    )

    resp = client.get("/api/v1/aprs/audio-devices")
    assert resp.status_code == 200
    payload = resp.json()
    assert any(item["name"] == "USB Audio CODEC" for item in payload["inputs"])
    assert any(item["name"] == "USB Audio CODEC" for item in payload["outputs"])


def test_aprs_audio_devices_endpoint_prefers_direwolf_portaudio_ids(tmp_path, monkeypatch):
    client = make_client(tmp_path)
    client.post("/api/v1/settings/aprs", json={"direwolf_binary": "/opt/homebrew/bin/direwolf"})
    monkeypatch.setattr(main, "_resolve_direwolf_binary_path", lambda binary: "/opt/homebrew/bin/direwolf")
    monkeypatch.setattr(
        main.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args[0],
            1,
            stdout=(
                "Number of devices = 2\n"
                "--------------------------------------- device #0\n"
                'Name        = "USB Audio CODEC"\n'
                "Max inputs  = 0\n"
                "Max outputs = 2\n"
                "--------------------------------------- device #1\n"
                'Name        = "USB Audio CODEC"\n'
                "Max inputs  = 2\n"
                "Max outputs = 0\n"
            ),
            stderr="",
        ),
    )

    resp = client.get("/api/v1/aprs/audio-devices")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["inputs"][0]["value"] == "USB Audio CODEC:1"
    assert payload["outputs"][0]["value"] == "USB Audio CODEC:0"


def test_direwolf_config_omits_default_adevice():
    process = DireWolfProcess(workdir="data/aprs-test")
    settings = AprsSettings(
        callsign="VK4ABC",
        audio_input_device="default",
        audio_output_device="default",
    )
    target = AprsTargetState(
        operating_mode=AprsOperatingMode.terrestrial,
        label="Terrestrial APRS",
        frequency_hz=144390000,
    )

    config = process.build_config(settings, target)
    assert "ADEVICE default default" not in config
    assert "CHANNEL 0" in config


def test_direwolf_config_quotes_audio_device_names_with_spaces():
    process = DireWolfProcess(workdir="data/aprs-test")
    settings = AprsSettings(
        callsign="VK4ABC",
        audio_input_device="USB Audio CODEC",
        audio_output_device="USB Audio CODEC",
    )
    target = AprsTargetState(
        operating_mode=AprsOperatingMode.terrestrial,
        label="Terrestrial APRS",
        frequency_hz=144390000,
    )

    config = process.build_config(settings, target)
    assert 'ADEVICE "USB Audio CODEC" "USB Audio CODEC"' in config


def test_direwolf_config_uses_selected_hamlib_model():
    process = DireWolfProcess(workdir="data/aprs-test")
    settings = AprsSettings(
        callsign="VK4ABC",
        hamlib_model_id=3071,
        serial_device="/dev/cu.usbmodem114201",
        baud_rate=19200,
    )
    target = AprsTargetState(
        operating_mode=AprsOperatingMode.terrestrial,
        label="Terrestrial APRS",
        frequency_hz=144390000,
    )

    config = process.build_config(settings, target)
    assert "PTT RIG 3071 /dev/cu.usbmodem114201 19200" in config
    assert "PTT RIG AUTO" not in config


def test_direwolf_start_uses_absolute_config_path(monkeypatch, tmp_path):
    captured = {}

    class FakeStream:
        def readline(self):
            return ""

    class FakePopen:
        def __init__(self, command, cwd=None, stdout=None, stderr=None, text=None):
            captured["command"] = command
            captured["cwd"] = cwd
            self.stdout = FakeStream()
            self.stderr = FakeStream()

        def poll(self):
            return None

        def terminate(self):
            return None

        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(subprocess, "Popen", FakePopen)
    process = DireWolfProcess(workdir=str(tmp_path / "aprs-sidecar"))
    settings = AprsSettings(callsign="VK4ABC", direwolf_binary="/opt/homebrew/bin/direwolf")
    target = AprsTargetState(
        operating_mode=AprsOperatingMode.terrestrial,
        label="Terrestrial APRS",
        frequency_hz=144390000,
    )

    command, _ = process.start(settings, target)

    assert command[0] == "/opt/homebrew/bin/direwolf"
    assert command[1] == "-c"
    assert command[2] == str((tmp_path / "aprs-sidecar" / "direwolf.conf").resolve())
    assert captured["cwd"] == str(tmp_path / "aprs-sidecar")


def test_aprs_settings_model_change_updates_hamlib_model(tmp_path):
    client = make_client(tmp_path)

    resp = client.post("/api/v1/settings/aprs", json={"rig_model": "id5100"})
    assert resp.status_code == 200
    assert resp.json()["state"]["hamlib_model_id"] == 3071

    resp = client.post("/api/v1/settings/aprs", json={"rig_model": "ic705"})
    assert resp.status_code == 200
    assert resp.json()["state"]["hamlib_model_id"] == 3085


def test_system_state_reports_station_identity(tmp_path):
    client = make_client(tmp_path)

    initial = client.get("/api/v1/system/state")
    assert initial.status_code == 200
    assert initial.json()["stationIdentity"]["configured"] is False

    client.post("/api/v1/settings/aprs", json={"callsign": "VK4ABC"})

    updated = client.get("/api/v1/system/state")
    assert updated.status_code == 200
    identity = updated.json()["stationIdentity"]
    assert identity["configured"] is True
    assert identity["callsign"] == "VK4ABC"


def test_direwolf_start_terminates_conflicting_listener(monkeypatch, tmp_path):
    captured = {"kill": []}

    class FakeCompleted:
        def __init__(self, stdout=""):
            self.stdout = stdout
            self.stderr = ""

    def fake_run(command, capture_output=True, text=True, check=False):
        if command[:2] == ["lsof", "-nP"] and "-Fpct" in command:
            return FakeCompleted("p4242\ncdirewolf\ntIPv4\n")
        if command[:2] == ["lsof", "-nP"] and "-t" in command:
            return FakeCompleted("")
        if command[:1] == ["kill"]:
            captured["kill"].append(command[1])
            return FakeCompleted("")
        return FakeCompleted("")

    class FakeStream:
        def readline(self):
            return ""

    class FakePopen:
        def __init__(self, command, cwd=None, stdout=None, stderr=None, text=None):
            self.stdout = FakeStream()
            self.stderr = FakeStream()

        def poll(self):
            return None

        def terminate(self):
            return None

        def wait(self, timeout=None):
            return 0

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(subprocess, "Popen", FakePopen)
    process = DireWolfProcess(workdir=str(tmp_path / "aprs-sidecar"))
    settings = AprsSettings(callsign="VK4ABC", direwolf_binary="/opt/homebrew/bin/direwolf")
    target = AprsTargetState(
        operating_mode=AprsOperatingMode.terrestrial,
        label="Terrestrial APRS",
        frequency_hz=144390000,
    )

    process.start(settings, target)

    assert captured["kill"] == ["4242"]


def test_aprs_session_select_route_returns_preview_target(tmp_path):
    client = make_client(tmp_path)

    resp = client.post("/api/v1/aprs/session/select", json={"operating_mode": "satellite", "sat_id": "iss-zarya", "channel_id": "iss-zarya:seed:1"})
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["state"]["selected_satellite_id"] == "iss-zarya"
    assert payload["state"]["selected_channel_id"] == "iss-zarya:seed:1"
    assert payload["previewTarget"]["sat_id"] == "iss-zarya"


def test_system_state_exposes_aprs_preview_target(tmp_path):
    client = make_client(tmp_path)
    client.post("/api/v1/settings/aprs", json={"operating_mode": "satellite", "selected_satellite_id": "iss-zarya", "selected_channel_id": "iss-zarya:seed:1"})

    resp = client.get("/api/v1/system/state")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["aprsPreviewTarget"]["sat_id"] == "iss-zarya"
    assert payload["aprsPreviewTarget"]["frequency_hz"] == 437800000


def test_aprs_uhf_target_reports_corrected_frequency(tmp_path):
    client = make_client(tmp_path)
    original_live_tracks = main.tracking_service.live_tracks
    original_pass_predictions = main.tracking_service.pass_predictions

    def fake_live_tracks(self, now, location):
        return [
            LiveTrack(
                sat_id="iss-zarya",
                name="ISS (ZARYA)",
                timestamp=now,
                az_deg=122.0,
                el_deg=41.0,
                range_km=822.0,
                range_rate_km_s=6.7,
                sunlit=True,
            )
        ]

    def active_pass_predictions(self, start_time, hours, location, sat_ids=None, include_ongoing=False):
        return [
            PassEvent(
                sat_id="iss-zarya",
                name="ISS (ZARYA)",
                aos=start_time - timedelta(minutes=1),
                tca=start_time,
                los=start_time + timedelta(minutes=8),
                max_el_deg=52.0,
            )
        ]

    main.tracking_service.live_tracks = MethodType(fake_live_tracks, main.tracking_service)
    main.tracking_service.pass_predictions = MethodType(active_pass_predictions, main.tracking_service)
    try:
        resp = client.post("/api/v1/aprs/session/select", json={"operating_mode": "satellite", "sat_id": "iss-zarya", "channel_id": "iss-zarya:seed:1"})
        assert resp.status_code == 200
        target = resp.json()["previewTarget"]
        assert target["correction_side"] == "uhf_only"
        assert target["corrected_frequency_hz"] is not None
    finally:
        main.tracking_service.live_tracks = original_live_tracks
        main.tracking_service.pass_predictions = original_pass_predictions


def test_aprs_developer_override_allows_satellite_tx_outside_pass(tmp_path):
    client = make_client(tmp_path)
    main.aprs_service = FakeAprsService()
    original_pass_predictions = main.tracking_service.pass_predictions

    client.post("/api/v1/settings/aprs", json={"callsign": "VK4ABC"})
    client.post(
        "/api/v1/settings/developer-overrides",
        json={
            "enabled": True,
            "force_scene": "auto",
            "simulate_pass_phase": "real-time",
            "show_debug_badge": True,
        },
    )

    def future_pass_predictions(self, start_time, hours, location, sat_ids=None, include_ongoing=False):
        return [
            PassEvent(
                sat_id="iss-zarya",
                name="ISS (ZARYA)",
                aos=start_time + timedelta(minutes=20),
                tca=start_time + timedelta(minutes=24),
                los=start_time + timedelta(minutes=29),
                max_el_deg=41.0,
            )
        ]

    main.tracking_service.pass_predictions = MethodType(future_pass_predictions, main.tracking_service)
    try:
        select = client.post(
            "/api/v1/aprs/session/select",
            json={"operating_mode": "satellite", "sat_id": "iss-zarya", "channel_id": "iss-zarya:seed:1"},
        )
        assert select.status_code == 200
        target = select.json()["previewTarget"]
        assert target["can_transmit"] is True
        assert "Developer override" in target["reason"]

        connect = client.post("/api/v1/aprs/connect")
        assert connect.status_code == 200
        send = client.post("/api/v1/aprs/send/status", json={"text": "DEV OVERRIDE"})
        assert send.status_code == 200
    finally:
        main.tracking_service.pass_predictions = original_pass_predictions


def test_aprs_connect_reapplies_uhf_doppler_tuning(tmp_path):
    client = make_client(tmp_path)
    main.aprs_service = FakeAprsService()
    original_live_tracks = main.tracking_service.live_tracks
    original_pass_predictions = main.tracking_service.pass_predictions
    calls = {"count": 0}

    client.post("/api/v1/settings/aprs", json={"callsign": "VK4ABC"})

    def fake_live_tracks(self, now, location):
        calls["count"] += 1
        range_rate = {1: 0.0, 2: -7.2}.get(calls["count"], 7.2)
        return [
            LiveTrack(
                sat_id="iss-zarya",
                name="ISS (ZARYA)",
                timestamp=now,
                az_deg=122.0,
                el_deg=41.0,
                range_km=822.0,
                range_rate_km_s=range_rate,
                sunlit=True,
            )
        ]

    def active_pass_predictions(self, start_time, hours, location, sat_ids=None, include_ongoing=False):
        return [
            PassEvent(
                sat_id="iss-zarya",
                name="ISS (ZARYA)",
                aos=start_time - timedelta(minutes=1),
                tca=start_time,
                los=start_time + timedelta(minutes=8),
                max_el_deg=52.0,
            )
        ]

    main.tracking_service.live_tracks = MethodType(fake_live_tracks, main.tracking_service)
    main.tracking_service.pass_predictions = MethodType(active_pass_predictions, main.tracking_service)
    try:
        client.post("/api/v1/aprs/session/select", json={"operating_mode": "satellite", "sat_id": "iss-zarya", "channel_id": "iss-zarya:seed:1"})
        connect = client.post("/api/v1/aprs/connect")
        assert connect.status_code == 200
        first_tune = main.aprs_service.last_tuned_frequency
        assert first_tune is not None
        sleep(1.2)
        assert main.aprs_service.last_tuned_frequency != first_tune
        client.post("/api/v1/aprs/disconnect")
        last_tune = main.aprs_service.last_tuned_frequency
        sleep(1.2)
        assert main.aprs_service.last_tuned_frequency == last_tune
    finally:
        main.tracking_service.live_tracks = original_live_tracks
        main.tracking_service.pass_predictions = original_pass_predictions

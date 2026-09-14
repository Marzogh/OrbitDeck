from __future__ import annotations

import json

from fastapi.testclient import TestClient

import app.main as main
import app.tx_auth as tx_auth_module
from app.aprs.log_store import AprsLogStore
from app.aprs.service import AprsService
from app.radio.service import RigControlService
from app.services import DataIngestionService, PassPredictionCacheService, TrackingService
from app.store import StateStore
from app.tx_auth import TxAuthManager


def make_locked_client(tmp_path) -> TestClient:
    main.store = StateStore(tmp_path / "state.json")
    main.tracking_service = TrackingService(str(tmp_path / "latest_catalog.json"))
    main.ingestion_service = DataIngestionService()
    main.radio_control_service = RigControlService()
    main.aprs_log_store = AprsLogStore(str(tmp_path / "received_log.jsonl"))
    main.aprs_service = AprsService(packet_received_callback=main._handle_aprs_received_packet)
    main.pass_cache_service = PassPredictionCacheService(str(tmp_path / "pass_predictions_cache.json"))
    main.tx_auth = TxAuthManager(
        tmp_path / "tx_auth.json",
        tmp_path / "tx_auth_secret",
        pin_iterations=1_000,
    )
    return TestClient(main.app)


def test_token_survives_service_restart_but_not_system_reboot(tmp_path, monkeypatch):
    monkeypatch.setattr(tx_auth_module, "current_boot_id", lambda: "boot-one")
    manager = TxAuthManager(
        tmp_path / "auth.json",
        tmp_path / "secret",
        pin_iterations=1_000,
    )
    manager.configure("1234")
    saved = json.loads((tmp_path / "auth.json").read_text(encoding="utf-8"))
    assert saved["pin_hash"] != "1234"
    assert "1234" not in (tmp_path / "auth.json").read_text(encoding="utf-8")
    assert (tmp_path / "auth.json").stat().st_mode & 0o077 == 0
    assert (tmp_path / "secret").stat().st_mode & 0o077 == 0
    token = manager.issue_token()
    assert manager.authorized(token) is True
    assert manager.authorized(token + "tampered") is False

    restarted_service = TxAuthManager(
        tmp_path / "auth.json",
        tmp_path / "secret",
        pin_iterations=1_000,
    )
    assert restarted_service.authorized(token) is True

    monkeypatch.setattr(tx_auth_module, "current_boot_id", lambda: "boot-two")
    rebooted_system = TxAuthManager(
        tmp_path / "auth.json",
        tmp_path / "secret",
        pin_iterations=1_000,
    )
    assert rebooted_system.authorized(token) is False
    replacement_token = rebooted_system.issue_token()
    assert rebooted_system.authorized(replacement_token) is True


def test_pin_accepts_four_characters_without_composition_rules(tmp_path):
    manager = TxAuthManager(
        tmp_path / "auth.json",
        tmp_path / "secret",
        pin_iterations=1_000,
    )
    manager.configure("a ☃!")
    assert manager.verify_pin("a ☃!") is True
    assert manager.verify_pin("a ☃?") is False

    too_short = TxAuthManager(
        tmp_path / "short-auth.json",
        tmp_path / "short-secret",
        pin_iterations=1_000,
    )
    try:
        too_short.configure("123")
    except ValueError as exc:
        assert "at least 4" in str(exc)
    else:
        raise AssertionError("three-character PIN should be rejected")


def test_tx_routes_require_setup_and_unlock_while_receive_controls_remain_open(tmp_path):
    client = make_locked_client(tmp_path)

    blocked = client.post("/api/v1/aprs/send/status", json={"text": "test"})
    assert blocked.status_code == 401
    assert blocked.json()["detail"]["code"] == "tx_auth_setup_required"

    receive_control = client.post(
        "/api/v1/radio/frequency",
        json={"vfo": "A", "freq_hz": 145_800_000},
    )
    assert receive_control.status_code != 401

    setup = client.post("/api/v1/tx-auth/setup", json={"pin": "1234"})
    assert setup.status_code == 200
    assert setup.json()["authorized"] is True
    assert client.get("/api/v1/tx-auth/status").json()["authorized"] is True
    assert client.post("/api/v1/tx-auth/setup", json={"pin": "5678"}).status_code == 409

    passed_guard = client.post("/api/v1/aprs/send/status", json={"text": "test"})
    assert passed_guard.status_code != 401


def test_lock_revokes_all_tokens_for_current_boot(tmp_path):
    client = make_locked_client(tmp_path)
    assert client.post("/api/v1/tx-auth/setup", json={"pin": "1234"}).status_code == 200
    token = client.cookies.get("orbitdeck_tx_auth")
    assert token
    main.aprs_service._runtime.digipeater_active = True

    locked = client.post("/api/v1/tx-auth/lock")
    assert locked.status_code == 200
    assert locked.json()["authorized"] is False
    assert main.tx_auth.authorized(token) is False
    assert main.aprs_service.runtime().connected is False
    assert main.aprs_service.runtime().digipeater_active is False


def test_digipeater_enable_requires_tx_authorization(tmp_path):
    client = make_locked_client(tmp_path)
    payload = {
        "log_enabled": False,
        "log_max_records": 500,
        "notify_incoming_messages": True,
        "notify_all_packets": False,
        "future_digipeater_enabled": True,
        "future_igate_enabled": False,
    }
    blocked = client.post("/api/v1/aprs/log/settings", json=payload)
    assert blocked.status_code == 401

    assert client.post("/api/v1/tx-auth/setup", json={"pin": "1234"}).status_code == 200
    allowed = client.post("/api/v1/aprs/log/settings", json=payload)
    assert allowed.status_code == 200
    assert allowed.json()["digipeater"]["enabled"] is True

    assert client.post("/api/v1/settings/aprs", json={"callsign": "VK4ABC"}).status_code == 200
    assert client.post("/api/v1/tx-auth/lock").status_code == 200
    blocked_connect = client.post("/api/v1/aprs/connect")
    assert blocked_connect.status_code == 401
    assert blocked_connect.json()["detail"]["code"] == "tx_auth_required"

    wrong_pin = client.post("/api/v1/tx-auth/unlock", json={"pin": "9999"})
    assert wrong_pin.status_code == 401


def test_pin_is_reusable_but_only_one_session_can_hold_tx(tmp_path):
    first = make_locked_client(tmp_path)
    second = TestClient(main.app)

    assert first.post("/api/v1/tx-auth/setup", json={"pin": "1234"}).status_code == 200
    second_status = second.get("/api/v1/tx-auth/status").json()
    assert second_status["authorized"] is False
    assert second_status["inUse"] is True

    blocked = second.post("/api/v1/tx-auth/unlock", json={"pin": "1234"})
    assert blocked.status_code == 409
    assert "another session" in blocked.json()["detail"]

    assert first.post("/api/v1/tx-auth/lock").status_code == 200
    unlocked = second.post("/api/v1/tx-auth/unlock", json={"pin": "1234"})
    assert unlocked.status_code == 200
    assert second.get("/api/v1/tx-auth/status").json()["authorized"] is True

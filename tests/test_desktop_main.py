from __future__ import annotations

import json
from pathlib import Path

from app import desktop_main


def test_initial_url_routes_first_run_to_settings() -> None:
    server = desktop_main.DesktopServer(port=8000)
    assert desktop_main._initial_url(server, first_run=True) == "http://127.0.0.1:8000/settings"


def test_initial_url_routes_returning_user_to_root() -> None:
    server = desktop_main.DesktopServer(port=8000)
    assert desktop_main._initial_url(server, first_run=False) == "http://127.0.0.1:8000/"


def test_setup_ready_requires_callsign_and_location(tmp_path: Path) -> None:
    state_path = tmp_path / "state.json"
    state_path.write_text(
        json.dumps(
            {
                "aprs_settings": {"callsign": "N0CALL"},
                "location": {"selected_profile_id": None, "browser_location": None, "gps_location": None, "last_known_location": None},
            }
        ),
        encoding="utf-8",
    )
    assert desktop_main._setup_ready(state_path) is False

    state_path.write_text(
        json.dumps(
            {
                "aprs_settings": {"callsign": "VK4ABC"},
                "location": {"selected_profile_id": None, "browser_location": {"lat": -27.47, "lon": 153.03}, "gps_location": None, "last_known_location": None},
            }
        ),
        encoding="utf-8",
    )
    assert desktop_main._setup_ready(state_path) is True


def test_first_run_uses_desktop_launch_marker(tmp_path: Path, monkeypatch) -> None:
    marker = tmp_path / ".desktop-first-run-complete-0.0.0-test"
    state_path = tmp_path / "state.json"
    monkeypatch.setattr(desktop_main, "_desktop_launch_marker", lambda: marker)
    monkeypatch.setattr(desktop_main, "_app_version", lambda: "0.0.0-test")
    monkeypatch.setattr(desktop_main, "data_path", lambda *parts: state_path)
    assert desktop_main._first_run() is True
    marker.write_text("1\n", encoding="utf-8")
    state_path.write_text(
        json.dumps(
            {
                "aprs_settings": {"callsign": "VK4ABC"},
                "location": {
                    "selected_profile_id": None,
                    "browser_location": {"lat": -27.47, "lon": 153.03},
                    "gps_location": None,
                    "last_known_location": None,
                },
            }
        ),
        encoding="utf-8",
    )
    assert desktop_main._first_run() is False

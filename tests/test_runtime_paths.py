from __future__ import annotations

from pathlib import Path

from app import runtime_paths
from app import services


def test_packaged_mac_runtime_uses_application_support_for_writable_data(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ORBITDECK_PACKAGED_APP", "1")
    monkeypatch.setattr(runtime_paths.sys, "frozen", True, raising=False)

    state_path = runtime_paths.data_path("state.json")

    expected = tmp_path / "Library" / "Application Support" / "OrbitDeck" / "data" / "state.json"
    assert state_path == expected
    assert state_path.parent.exists()


def test_static_root_prefers_frozen_bundle_assets(tmp_path, monkeypatch):
    bundle_root = tmp_path / "bundle"
    static_dir = bundle_root / "app" / "static"
    static_dir.mkdir(parents=True)
    monkeypatch.setattr(runtime_paths.sys, "_MEIPASS", str(bundle_root), raising=False)

    assert runtime_paths.static_root() == static_dir


def test_frequency_guide_service_seeds_packaged_data_from_bundle(tmp_path, monkeypatch):
    bundle_root = tmp_path / "bundle"
    bundled_data = bundle_root / "data"
    bundled_data.mkdir(parents=True)
    seeded = bundled_data / "frequency_guides.json"
    source_seed = Path(__file__).resolve().parents[1] / "data" / "frequency_guides.json"
    seeded.write_text(source_seed.read_text(encoding="utf-8"), encoding="utf-8")

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ORBITDECK_PACKAGED_APP", "1")
    monkeypatch.setattr(runtime_paths.sys, "frozen", True, raising=False)
    monkeypatch.setattr(runtime_paths.sys, "_MEIPASS", str(bundle_root), raising=False)
    monkeypatch.setattr(services, "packaged_app_runtime", lambda: True)
    monkeypatch.setattr(services, "resource_root", lambda: bundle_root)

    svc = services.FrequencyGuideService()

    expected = tmp_path / "Library" / "Application Support" / "OrbitDeck" / "data" / "frequency_guides.json"
    assert expected.exists()
    assert expected.read_text(encoding="utf-8") == seeded.read_text(encoding="utf-8")
    assert svc.profile_for_satellite("iss-zarya") is not None

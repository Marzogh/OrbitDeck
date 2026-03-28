from __future__ import annotations

import importlib.util
from pathlib import Path
import pathlib
import sys

import pytest
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


def test_icom_lan_adapter_soft_fails_when_vendor_tree_is_missing(monkeypatch):
    adapter_path = Path(__file__).resolve().parents[1] / "app" / "radio" / "icom_lan_adapter.py"
    original_is_dir = pathlib.Path.is_dir
    original_import = __import__

    def fake_is_dir(self):
        path_text = str(self).replace("\\", "/")
        if path_text.endswith("references/icom-lan/src"):
            return False
        return original_is_dir(self)

    def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "icom_lan":
            raise ModuleNotFoundError("icom_lan unavailable in test")
        return original_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(pathlib.Path, "is_dir", fake_is_dir)
    monkeypatch.setattr("builtins.__import__", fake_import)
    monkeypatch.setattr(sys, "_MEIPASS", None, raising=False)

    spec = importlib.util.spec_from_file_location("test_missing_icom_lan_adapter", adapter_path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)

    with pytest.raises(RuntimeError, match="icom-lan support is not available"):
        _ = module.AudioCodec.PCM_1CH_16BIT

    with pytest.raises(RuntimeError, match="icom-lan support is not available"):
        module.IcomRadio("host", 50001, "user", "password")

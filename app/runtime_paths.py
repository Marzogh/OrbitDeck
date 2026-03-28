from __future__ import annotations

import os
import sys
from pathlib import Path


APP_NAME = "OrbitDeck"


def packaged_app_runtime() -> bool:
    override = os.getenv("ORBITDECK_PACKAGED_APP", "").strip().lower()
    if override in {"1", "true", "yes", "on"}:
        return True
    return bool(getattr(sys, "frozen", False))


def resource_root() -> Path:
    frozen_root = getattr(sys, "_MEIPASS", None)
    if frozen_root:
        return Path(frozen_root)
    return Path(__file__).resolve().parents[1]


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def app_support_root() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    if sys.platform.startswith("linux"):
        xdg_data_home = os.getenv("XDG_DATA_HOME", "").strip()
        if xdg_data_home:
            return Path(xdg_data_home) / APP_NAME
        return Path.home() / ".local" / "share" / APP_NAME
    return repo_root()


def writable_root() -> Path:
    root = app_support_root() if packaged_app_runtime() else repo_root()
    root.mkdir(parents=True, exist_ok=True)
    return root


def data_root() -> Path:
    root = writable_root() / "data"
    root.mkdir(parents=True, exist_ok=True)
    return root


def data_path(*parts: str) -> Path:
    path = data_root().joinpath(*parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def static_root() -> Path:
    path = resource_root() / "app" / "static"
    if not path.exists():
        path = repo_root() / "app" / "static"
    return path


def static_path(*parts: str) -> Path:
    return static_root().joinpath(*parts)

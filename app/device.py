from __future__ import annotations

import os
import platform
from pathlib import Path


def _device_model_text() -> str:
    for path in (
        Path("/proc/device-tree/model"),
        Path("/sys/firmware/devicetree/base/model"),
        Path("/proc/cpuinfo"),
    ):
        if not path.exists():
            continue
        try:
            return path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
    return ""


def device_class() -> str:
    forced = os.getenv("ISS_TRACKER_DEVICE_CLASS", "").strip().lower()
    if forced in {"pi-zero", "standard"}:
        return forced

    if platform.system() != "Linux":
        return "standard"

    model_text = _device_model_text().lower()
    if "raspberry pi zero" in model_text or "pi zero w" in model_text or "pi zero 2" in model_text:
        return "pi-zero"
    return "standard"


def lite_only_ui() -> bool:
    return device_class() == "pi-zero"

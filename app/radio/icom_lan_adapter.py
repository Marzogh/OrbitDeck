from __future__ import annotations

"""
Bundled icom-lan loader.

OrbitDeck keeps the upstream icom-lan reference tree in ``references/icom-lan``.
This adapter exposes the package to app code without requiring a separate pip
install from GitHub, while keeping attribution explicit in the codebase.
"""

from pathlib import Path
import sys


_ROOT = Path(__file__).resolve().parents[2]
_ICOM_LAN_SRC = _ROOT / "references" / "icom-lan" / "src"

if _ICOM_LAN_SRC.is_dir():
    path = str(_ICOM_LAN_SRC)
    if path not in sys.path:
        sys.path.insert(0, path)
else:  # pragma: no cover - only hit if bundled reference tree is missing
    raise RuntimeError("Bundled icom-lan sources are unavailable under references/icom-lan/src")

from icom_lan import AudioCodec, IcomRadio  # noqa: E402

__all__ = ["AudioCodec", "IcomRadio"]

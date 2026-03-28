from __future__ import annotations

"""
Bundled icom-lan loader.

OrbitDeck keeps the upstream icom-lan reference tree in ``references/icom-lan``.
This adapter exposes the package to app code without requiring a separate pip
install from GitHub, while keeping attribution explicit in the codebase.
"""

from pathlib import Path
import sys

_ICOM_LAN_IMPORT_ERROR: Exception | None = None


def _candidate_roots() -> list[Path]:
    roots: list[Path] = []
    frozen_root = getattr(sys, "_MEIPASS", None)
    if frozen_root:
        roots.append(Path(frozen_root))
    roots.append(Path(__file__).resolve().parents[2])
    return roots


def _icom_lan_src() -> Path | None:
    for root in _candidate_roots():
        candidate = root / "references" / "icom-lan" / "src"
        if candidate.is_dir():
            return candidate
    return None


_ICOM_LAN_SRC = _icom_lan_src()

class _MissingIcomLan:
    def __getattr__(self, _name: str):
        raise RuntimeError(
            "icom-lan support is not available in this environment. "
            f"Root cause: {_ICOM_LAN_IMPORT_ERROR}"
        ) from _ICOM_LAN_IMPORT_ERROR

    def __call__(self, *args, **kwargs):
        raise RuntimeError(
            "icom-lan support is not available in this environment. "
            f"Root cause: {_ICOM_LAN_IMPORT_ERROR}"
        ) from _ICOM_LAN_IMPORT_ERROR


try:
    if _ICOM_LAN_SRC and _ICOM_LAN_SRC.is_dir():
        path = str(_ICOM_LAN_SRC)
        if path not in sys.path:
            sys.path.insert(0, path)
    else:  # pragma: no cover - exercised only when the vendor tree is absent
        raise ModuleNotFoundError("Bundled icom-lan sources are unavailable under references/icom-lan/src")

    from icom_lan import AudioCodec, IcomRadio  # noqa: E402
except Exception as exc:  # pragma: no cover - exercised in CI environments without the vendor tree
    _ICOM_LAN_IMPORT_ERROR = exc
    AudioCodec = _MissingIcomLan()  # type: ignore[assignment]
    IcomRadio = _MissingIcomLan()  # type: ignore[assignment]

__all__ = ["AudioCodec", "IcomRadio"]

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
import time
from pathlib import Path
from threading import Lock


COOKIE_NAME = "orbitdeck_tx_auth"
PIN_ITERATIONS = 600_000


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + ("=" * (-len(value) % 4)))


def current_boot_id() -> str:
    """Return an identifier that remains stable until the host OS reboots."""
    linux_boot_id = Path("/proc/sys/kernel/random/boot_id")
    try:
        value = linux_boot_id.read_text(encoding="utf-8").strip()
        if value:
            return value
    except OSError:
        pass

    if sys.platform == "darwin":
        try:
            result = subprocess.run(
                ["/usr/sbin/sysctl", "-n", "kern.boottime"],
                check=True,
                capture_output=True,
                text=True,
                timeout=2,
            )
            match = re.search(r"sec\s*=\s*(\d+)", result.stdout)
            if match:
                return f"darwin-{match.group(1)}"
        except (OSError, subprocess.SubprocessError):
            pass

    # time.monotonic() is measured from host boot on supported OrbitDeck
    # platforms. Rounding absorbs tiny differences across process restarts.
    boot_epoch_minute = int((time.time() - time.monotonic()) // 60)
    return f"boot-{boot_epoch_minute}"


class TxAuthManager:
    """PIN-backed, per-host-boot authorization for RF transmission."""

    def __init__(
        self,
        config_path: str | Path,
        secret_path: str | Path,
        *,
        pin_iterations: int = PIN_ITERATIONS,
    ) -> None:
        self.config_path = Path(config_path)
        self.secret_path = Path(secret_path)
        self._lock = Lock()
        self._boot_id = current_boot_id()
        self._pin_iterations = max(1, int(pin_iterations))
        self._secret = self._load_or_create_secret()

    def _load_or_create_secret(self) -> bytes:
        self.secret_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            secret = self.secret_path.read_bytes()
            if len(secret) >= 32:
                return secret
        except OSError:
            pass
        secret = secrets.token_bytes(32)
        self._atomic_write(self.secret_path, secret)
        return secret

    @staticmethod
    def _atomic_write(path: Path, payload: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            os.chmod(path, 0o600)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass

    def _load_config(self) -> dict[str, object]:
        try:
            payload = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _save_config(self, config: dict[str, object]) -> None:
        payload = json.dumps(config, indent=2, sort_keys=True).encode("utf-8") + b"\n"
        self._atomic_write(self.config_path, payload)

    def configured(self) -> bool:
        config = self._load_config()
        return bool(config.get("pin_hash") and config.get("pin_salt"))

    def configure(self, pin: str) -> None:
        if len(pin) < 4:
            raise ValueError("TX PIN must contain at least 4 characters")
        if len(pin) > 256:
            raise ValueError("TX PIN must contain no more than 256 characters")
        salt = secrets.token_bytes(16)
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            pin.encode("utf-8"),
            salt,
            self._pin_iterations,
        )
        with self._lock:
            current = self._load_config()
            generation = int(current.get("generation") or 0) + 1
            self._save_config(
                {
                    "version": 1,
                    "pin_salt": _b64encode(salt),
                    "pin_hash": _b64encode(digest),
                    "generation": generation,
                    "pin_iterations": self._pin_iterations,
                }
            )

    def verify_pin(self, pin: str) -> bool:
        config = self._load_config()
        try:
            salt = _b64decode(str(config["pin_salt"]))
            expected = _b64decode(str(config["pin_hash"]))
        except (KeyError, TypeError, ValueError):
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            pin.encode("utf-8"),
            salt,
            int(config.get("pin_iterations") or PIN_ITERATIONS),
        )
        return hmac.compare_digest(actual, expected)

    def issue_token(self) -> str:
        with self._lock:
            config = self._load_config()
            if not (config.get("pin_hash") and config.get("pin_salt")):
                raise RuntimeError("TX authorization has not been configured")
            if config.get("active_boot") == self._boot_id and config.get("active_session"):
                raise RuntimeError("TX authorization is already active in another session")
            session_id = secrets.token_urlsafe(18)
            config["active_boot"] = self._boot_id
            config["active_session"] = session_id
            self._save_config(config)
            payload = {
                "v": 1,
                "boot": self._boot_id,
                "generation": int(config.get("generation") or 0),
                "session": session_id,
            }
        encoded = _b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
        signature = _b64encode(hmac.new(self._secret, encoded.encode("ascii"), hashlib.sha256).digest())
        return f"{encoded}.{signature}"

    def authorized(self, token: str | None) -> bool:
        if not token or "." not in token:
            return False
        encoded, supplied_signature = token.rsplit(".", 1)
        expected_signature = _b64encode(
            hmac.new(self._secret, encoded.encode("ascii"), hashlib.sha256).digest()
        )
        if not hmac.compare_digest(supplied_signature, expected_signature):
            return False
        try:
            payload = json.loads(_b64decode(encoded))
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
            return False
        config = self._load_config()
        return bool(
            self.configured()
            and payload.get("v") == 1
            and payload.get("boot") == self._boot_id
            and int(payload.get("generation", -1)) == int(config.get("generation") or 0)
            and config.get("active_boot") == self._boot_id
            and payload.get("session") == config.get("active_session")
        )

    def revoke_all(self) -> None:
        with self._lock:
            config = self._load_config()
            if not config:
                return
            config["generation"] = int(config.get("generation") or 0) + 1
            config["active_boot"] = None
            config["active_session"] = None
            self._save_config(config)

    def status(self, token: str | None) -> dict[str, object]:
        configured = self.configured()
        config = self._load_config()
        return {
            "configured": configured,
            "authorized": configured and self.authorized(token),
            "inUse": bool(
                configured
                and config.get("active_boot") == self._boot_id
                and config.get("active_session")
            ),
            "scope": "system-boot",
            "expiresOn": "explicit-lock-or-system-restart",
        }

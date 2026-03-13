from __future__ import annotations

from time import monotonic
from threading import Lock
from typing import Protocol

from app.radio.civ import CONTROLLER_ADDRESS, build_frame, extract_frames, parse_frame

try:
    import serial  # type: ignore
except Exception:  # pragma: no cover
    serial = None


class SerialLike(Protocol):
    is_open: bool

    def write(self, data: bytes) -> int: ...
    def read(self, size: int = 1) -> bytes: ...
    def close(self) -> None: ...


class SerialTransport:
    def __init__(self, device: str, baud_rate: int, timeout: float = 1.0, port_factory=None) -> None:
        self.device = device
        self.baud_rate = baud_rate
        self.timeout = timeout
        self._port_factory = port_factory
        self._port: SerialLike | None = None
        self._lock = Lock()
        self._buffer = b""

    @property
    def connected(self) -> bool:
        return bool(self._port and getattr(self._port, "is_open", True))

    def open(self) -> None:
        if self.connected:
            return
        if self._port_factory is not None:
            self._port = self._port_factory(self.device, self.baud_rate, self.timeout)
            return
        if serial is None:
            raise RuntimeError("pyserial is not available")
        self._port = serial.Serial(
            self.device,
            baudrate=self.baud_rate,
            bytesize=8,
            parity="N",
            stopbits=1,
            timeout=self.timeout,
        )

    def close(self) -> None:
        if self._port is not None:
            self._port.close()
        self._port = None
        self._buffer = b""

    def write_frame(self, to_addr: int, command: int, payload: bytes = b"") -> None:
        if not self._port:
            raise RuntimeError("transport is not connected")
        frame = build_frame(to_addr, command, payload)
        with self._lock:
            self._port.write(frame)

    def read_frames(self, chunk_size: int = 256) -> list[bytes]:
        if not self._port:
            return []
        with self._lock:
            chunk = self._port.read(chunk_size)
        if not chunk:
            return []
        frames, self._buffer = extract_frames(self._buffer + chunk)
        return frames

    def transact(
        self,
        to_addr: int,
        command: int,
        payload: bytes = b"",
        expect_commands: set[int] | None = None,
        timeout: float | None = None,
    ) -> bytes:
        if not self._port:
            raise RuntimeError("transport is not connected")
        self.write_frame(to_addr, command, payload)
        deadline = monotonic() + (self.timeout if timeout is None else timeout)
        expected = expect_commands or {command}
        while monotonic() < deadline:
            for frame in self.read_frames():
                try:
                    parsed = parse_frame(frame)
                except Exception:
                    continue
                if parsed.to_addr != CONTROLLER_ADDRESS:
                    continue
                if parsed.command in expected:
                    return frame
        raise TimeoutError(f"timeout waiting for CI-V response to 0x{command:02X}")

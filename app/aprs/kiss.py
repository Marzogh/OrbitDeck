from __future__ import annotations

import socket
from threading import Event, Thread
from time import sleep
from typing import Callable


FEND = 0xC0
FESC = 0xDB
TFEND = 0xDC
TFESC = 0xDD


class KissTcpClient:
    def __init__(self, host: str, port: int, frame_callback: Callable[[bytes], None]) -> None:
        self.host = host
        self.port = port
        self._frame_callback = frame_callback
        self._socket: socket.socket | None = None
        self._stop = Event()
        self._thread: Thread | None = None
        self.connected = False

    def connect(self, timeout: float = 3.0) -> None:
        self._socket = socket.create_connection((self.host, self.port), timeout=timeout)
        self._socket.settimeout(0.5)
        self.connected = True
        self._stop.clear()
        self._thread = Thread(target=self._reader, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self.connected = False
        sock = self._socket
        self._socket = None
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
        worker = self._thread
        if worker and worker.is_alive():
            worker.join(timeout=0.5)
        self._thread = None

    def _reader(self) -> None:
        if self._socket is None:
            return
        buffer = bytearray()
        while not self._stop.is_set():
            try:
                chunk = self._socket.recv(4096)
            except TimeoutError:
                continue
            except OSError:
                self.connected = False
                return
            if not chunk:
                self.connected = False
                return
            buffer.extend(chunk)
            while True:
                try:
                    start = buffer.index(FEND)
                    end = buffer.index(FEND, start + 1)
                except ValueError:
                    if len(buffer) > 8192:
                        buffer.clear()
                    break
                frame = bytes(buffer[start + 1:end])
                del buffer[:end + 1]
                payload = self._unescape(frame)
                if not payload:
                    continue
                command = payload[0] & 0x0F
                if command == 0x00:
                    self._frame_callback(payload[1:])

    def send_data(self, payload: bytes, channel: int = 0) -> None:
        if self._socket is None:
            raise RuntimeError("KISS client is not connected")
        frame = bytes([(channel & 0x0F) << 4]) + payload
        escaped = self._escape(frame)
        self._socket.sendall(bytes([FEND]) + escaped + bytes([FEND]))

    @staticmethod
    def _escape(payload: bytes) -> bytes:
        out = bytearray()
        for byte in payload:
            if byte == FEND:
                out.extend((FESC, TFEND))
            elif byte == FESC:
                out.extend((FESC, TFESC))
            else:
                out.append(byte)
        return bytes(out)

    @staticmethod
    def _unescape(payload: bytes) -> bytes:
        out = bytearray()
        idx = 0
        while idx < len(payload):
            byte = payload[idx]
            if byte == FESC and idx + 1 < len(payload):
                nxt = payload[idx + 1]
                if nxt == TFEND:
                    out.append(FEND)
                elif nxt == TFESC:
                    out.append(FESC)
                idx += 2
                continue
            out.append(byte)
            idx += 1
        return bytes(out)


def wait_for_socket(host: str, port: int, timeout_seconds: float = 5.0) -> None:
    deadline = timeout_seconds
    while deadline > 0:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return
        except OSError:
            sleep(0.2)
            deadline -= 0.2
    raise TimeoutError(f"Timed out waiting for KISS TCP socket {host}:{port}")

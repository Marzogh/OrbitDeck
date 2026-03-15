from __future__ import annotations

"""
IC-705 Wi-Fi transport.

This module is an original Python implementation for OrbitDeck, but it was
developed using public reverse-engineering work as protocol references:

- kappanhang by Norbert Varga HA2NON and Akos Marton ES1AKOS (MIT)
- networkICOM by Mark Erbaugh (reference/analysis only; no direct code copied)
- icom-lan by morozsm (MIT)

The active session flow implemented here follows the control/login/token/
ConnInfo + serial-on-50002 pattern proven against a live IC-705, and it also
adopts the useful reliability lessons from icom-lan:

- reserve and advertise local CI-V/audio ports in ConnInfo
- accept radio-reported CI-V/audio ports from status traffic when present
- retry early handshakes and keep shutdown/reconnect state tidy

See THIRD_PARTY_NOTICES.md for attribution details.
"""

import random
import socket
import struct
from dataclasses import dataclass
from queue import Empty, Queue
from threading import Event, Lock, Thread
from time import monotonic, sleep

from app.radio.civ import CONTROLLER_ADDRESS, build_frame, extract_frames, parse_frame


CONTROL_PORT = 50001
SERIAL_PORT = 50002
AUDIO_PORT = 50003
DEFAULT_TIMEOUT = 5.0
PING_INTERVAL = 3.0
IDLE_INTERVAL = 1.0
TOKEN_RENEW_INTERVAL = 60.0
RESEND_INTERVAL = 5.0
CONNECT_ATTEMPTS = 3
RECONNECT_DELAY = 0.5
RX_SAMPLE_RATE = 48000
TX_SAMPLE_RATE = 0
RX_CODEC = 0x04
TX_CODEC = 0x00
COMMON_CAP = 0x8001
TX_BUFFER_BYTES = 1024 * 1024


def _encode_icom_credential(text: str) -> bytes:
    table = [
        0x47, 0x5D, 0x4C, 0x42, 0x66, 0x20, 0x23, 0x46, 0x4E, 0x57, 0x45, 0x3D, 0x67, 0x76, 0x60, 0x41,
        0x62, 0x39, 0x59, 0x2D, 0x68, 0x7E, 0x7C, 0x65, 0x7D, 0x49, 0x29, 0x72, 0x73, 0x78, 0x21, 0x6E,
        0x5A, 0x5E, 0x4A, 0x3E, 0x71, 0x2C, 0x2A, 0x54, 0x3C, 0x3A, 0x63, 0x4F, 0x43, 0x75, 0x27, 0x79,
        0x5B, 0x35, 0x70, 0x48, 0x6B, 0x56, 0x6F, 0x34, 0x32, 0x6C, 0x30, 0x61, 0x6D, 0x7B, 0x2F, 0x4B,
        0x64, 0x38, 0x2B, 0x2E, 0x50, 0x40, 0x3F, 0x55, 0x33, 0x37, 0x25, 0x77, 0x24, 0x26, 0x74, 0x6A,
        0x28, 0x53, 0x4D, 0x69, 0x22, 0x5C, 0x44, 0x31, 0x36, 0x58, 0x3B, 0x7A, 0x51, 0x5F, 0x52,
    ]
    out = bytearray()
    for index, char in enumerate((text or "").encode("latin1", "ignore")[:16]):
        position = index + char
        if position > 126:
            position = 32 + position % 127
        out.append(table[position - 32])
    out.extend(b"\x00" * (16 - len(out)))
    return bytes(out)


@dataclass
class _TrackedPacket:
    sent_at: float
    data: bytes


class _UdpChannel:
    def __init__(self, host: str, port: int, timeout: float, *, local_port: int = 0) -> None:
        self.host = host
        self.port = int(port)
        self.local_port = int(local_port)
        self.timeout = timeout
        self.sock: socket.socket | None = None
        self.remote_id = 0
        self.my_id = 0
        self.sequence = 0
        self.ping_sequence = 0
        self.stream_sequence = 0
        self.inner_sequence = 0
        self.tracked: dict[int, _TrackedPacket] = {}
        self.last_idle = 0.0
        self.last_ping = 0.0
        self.pending_retry: bytes | None = None
        self.pending_retry_started_at = 0.0

    def open(self) -> None:
        self.close()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(0.25)
        sock.bind(("", self.local_port))
        sock.connect((self.host, self.port))
        self.sock = sock
        self.my_id = random.randint(0, 0xFFFFFFFF)
        self.remote_id = 0
        self.sequence = 0
        self.ping_sequence = 0
        self.stream_sequence = 0
        self.inner_sequence = 0
        self.tracked.clear()
        self.pending_retry = None
        self.pending_retry_started_at = 0.0
        self.last_idle = 0.0
        self.last_ping = 0.0

    def close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None

    def next_sequence(self) -> int:
        self.sequence = (self.sequence + 1) & 0xFFFF
        return self.sequence

    def next_ping_sequence(self) -> int:
        self.ping_sequence = (self.ping_sequence + 1) & 0xFFFF
        return self.ping_sequence

    def next_stream_sequence(self) -> int:
        self.stream_sequence = (self.stream_sequence + 1) & 0xFFFF
        return self.stream_sequence

    def next_inner_sequence(self) -> int:
        self.inner_sequence = (self.inner_sequence + 1) & 0xFF
        return self.inner_sequence

    def send(self, packet: bytes) -> None:
        if self.sock is None:
            raise RuntimeError(f"UDP channel {self.port} is not connected")
        self.sock.send(packet)

    def recv(self) -> bytes:
        if self.sock is None:
            raise RuntimeError(f"UDP channel {self.port} is not connected")
        return self.sock.recv(4096)

    def track(self, packet: bytes) -> None:
        sequence = struct.unpack_from("<H", packet, 0x06)[0]
        self.tracked[sequence] = _TrackedPacket(sent_at=monotonic(), data=packet)
        if len(self.tracked) > 32:
            for stale in sorted(self.tracked)[: len(self.tracked) - 32]:
                self.tracked.pop(stale, None)


class IcomUdpTransport:
    def __init__(
        self,
        host: str,
        control_port: int,
        username: str,
        password: str,
        timeout: float = DEFAULT_TIMEOUT,
        client_name: str = "ORBITDECK",
    ) -> None:
        self.host = host
        self.control_port = int(control_port or CONTROL_PORT)
        self.username = username
        self.password = password
        self.timeout = max(timeout, DEFAULT_TIMEOUT)
        self.client_name = (client_name or "ORBITDECK")[:16]

        self._control = _UdpChannel(self.host, self.control_port, self.timeout, local_port=self.control_port)
        self._serial = _UdpChannel(self.host, SERIAL_PORT, self.timeout, local_port=0)
        self._token_request = random.randint(0, 0xFFFF)
        self._token: int | None = None
        self._radio_name = "IC-705"
        self._conn_guid = b"\x00" * 16
        self._status_error = 0
        self._radio_civ_port = SERIAL_PORT
        self._radio_audio_port = AUDIO_PORT
        self._civ_local_port = SERIAL_PORT
        self._audio_local_port = AUDIO_PORT
        self._connected = False

        self._frame_queue: Queue[bytes] = Queue()
        self._serial_lock = Lock()
        self._write_lock = Lock()
        self._stop = Event()
        self._control_thread: Thread | None = None
        self._serial_thread: Thread | None = None
        self._buffer = b""

    @property
    def connected(self) -> bool:
        return self._connected and not self._stop.is_set()

    def open(self) -> None:
        if self.connected:
            return
        self.close()
        self._stop.clear()
        self._token_request = random.randint(0, 0xFFFF)
        self._token = None
        self._status_error = 0
        self._radio_civ_port = self.control_port + 1
        self._radio_audio_port = self.control_port + 2
        self._civ_local_port = SERIAL_PORT
        self._audio_local_port = AUDIO_PORT
        self._serial.local_port = self._civ_local_port
        last_error: Exception | None = None
        for attempt in range(CONNECT_ATTEMPTS):
            self._control.open()
            try:
                self._connect_control()
                self._serial.port = self._radio_civ_port
                self._serial.open()
                self._connect_serial()
                last_error = None
                break
            except Exception as exc:
                last_error = exc
                self._serial.close()
                self._control.close()
                if attempt < CONNECT_ATTEMPTS - 1:
                    sleep(RECONNECT_DELAY)
        if last_error is not None:
            self.close()
            raise last_error
        self._connected = True
        self._control_thread = Thread(target=self._control_loop, daemon=True)
        self._control_thread.start()
        self._serial_thread = Thread(target=self._serial_loop, daemon=True)
        self._serial_thread.start()

    def close(self) -> None:
        self._stop.set()
        for thread in (self._control_thread, self._serial_thread):
            if thread and thread.is_alive():
                thread.join(timeout=0.5)
        self._control_thread = None
        self._serial_thread = None
        if self._serial.sock is not None:
            try:
                self._serial.send(self._build_disconnect_packet(self._serial))
                self._serial.send(self._build_openclose_packet(open_request=False))
            except Exception:
                pass
        if self._control.sock is not None and self._token is not None:
            try:
                self._control.send(self._build_conninfo_host_packet(enable_rx=False, enable_tx=False))
                self._control.send(self._build_disconnect_packet(self._control))
                self._control.send(self._build_token_packet(0x01))
            except Exception:
                pass
        sleep(0.1)
        self._serial.close()
        self._control.close()
        self._connected = False
        self._token = None
        self._radio_name = "IC-705"
        self._conn_guid = b"\x00" * 16
        self._status_error = 0
        self._radio_civ_port = SERIAL_PORT
        self._radio_audio_port = AUDIO_PORT
        self._civ_local_port = SERIAL_PORT
        self._audio_local_port = AUDIO_PORT
        self._buffer = b""
        while True:
            try:
                self._frame_queue.get_nowait()
            except Empty:
                break

    def write_frame(self, to_addr: int, command: int, payload: bytes = b"") -> None:
        if not self.connected:
            raise RuntimeError("transport is not connected")
        frame = build_frame(to_addr, command, payload)
        packet = self._build_civ_packet(frame)
        with self._write_lock:
            self._serial.track(packet)
            self._serial.send(packet)

    def read_frames(self, chunk_size: int = 256) -> list[bytes]:
        del chunk_size
        frames: list[bytes] = []
        while True:
            try:
                payload = self._frame_queue.get_nowait()
            except Empty:
                break
            extracted, self._buffer = extract_frames(self._buffer + payload)
            frames.extend(extracted)
        return frames

    def transact(
        self,
        to_addr: int,
        command: int,
        payload: bytes = b"",
        expect_commands: set[int] | None = None,
        timeout: float | None = None,
    ) -> bytes:
        deadline = monotonic() + (timeout or self.timeout)
        expected = expect_commands or {command}
        with self._serial_lock:
            self.write_frame(to_addr, command, payload)
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
                sleep(0.02)
        raise TimeoutError(f"timeout waiting for CI-V response to 0x{command:02X}")

    def _connect_control(self) -> None:
        self._control.send(self._build_disconnect_packet(self._control))
        are_you_there = self._build_are_you_there_packet(self._control)
        self._control.send(are_you_there)
        self._control.pending_retry = are_you_there
        self._control.pending_retry_started_at = monotonic()
        deadline = monotonic() + self.timeout
        login_sent = False
        while monotonic() < deadline:
            packet = self._recv(self._control)
            if packet is None:
                continue
            length = len(packet)
            packet_type = struct.unpack_from("<H", packet, 0x04)[0] if length >= 6 else None
            if length == 16 and packet_type == 4:
                self._control.remote_id = struct.unpack_from("<I", packet, 0x08)[0]
                are_you_ready = self._build_are_you_ready_packet(self._control)
                self._control.send(are_you_ready)
                self._control.pending_retry = are_you_ready
                self._control.pending_retry_started_at = monotonic()
            elif length == 16 and packet_type == 6 and not login_sent:
                login_packet = self._build_login_packet()
                self._control.send(login_packet)
                self._control.pending_retry = login_packet
                self._control.pending_retry_started_at = monotonic()
                login_sent = True
            elif length == 96:
                self._token = struct.unpack_from("<I", packet, 0x1C)[0]
                token_packet = self._build_token_packet(0x02)
                self._control.send(token_packet)
                self._control.pending_retry = token_packet
                self._control.pending_retry_started_at = monotonic()
            elif length == 80:
                if packet[0x29] == 0:
                    self._capture_status(packet)
                    self._control.send(self._build_status_reply(packet))
            elif length == 168:
                self._radio_name = packet[0x52:0x62].split(b"\x00", 1)[0].decode("latin1", "ignore") or self._radio_name
                conninfo_packet = self._build_conninfo_host_packet()
                self._control.send(conninfo_packet)
                self._control.pending_retry = conninfo_packet
                self._control.pending_retry_started_at = monotonic()
            elif length == 144 and packet[0x29] == 0:
                self._conn_guid = packet[0x20:0x30]
                self._control.send(self._build_conninfo_reply(packet))
                self._control.pending_retry = None
                return
            elif length == 21 and packet_type == 7:
                self._reply_or_reject_ping(self._control, packet)
            self._maybe_resend(self._control)
        raise TimeoutError(f"timed out starting IC-705 control connection at {self.host}:{self.control_port}")

    def _connect_serial(self) -> None:
        self._serial.send(self._build_disconnect_packet(self._serial))
        are_you_there = self._build_are_you_there_packet(self._serial)
        self._serial.send(are_you_there)
        self._serial.pending_retry = are_you_there
        self._serial.pending_retry_started_at = monotonic()
        deadline = monotonic() + self.timeout
        opened = False
        while monotonic() < deadline:
            packet = self._recv(self._serial)
            if packet is None:
                continue
            length = len(packet)
            packet_type = struct.unpack_from("<H", packet, 0x04)[0] if length >= 6 else None
            if length == 16 and packet_type == 4:
                self._serial.remote_id = struct.unpack_from("<I", packet, 0x08)[0]
                are_you_ready = self._build_are_you_ready_packet(self._serial)
                self._serial.send(are_you_ready)
                self._serial.pending_retry = are_you_ready
                self._serial.pending_retry_started_at = monotonic()
            elif length == 16 and packet_type == 6 and not opened:
                open_packet = self._build_openclose_packet(open_request=True)
                self._serial.send(open_packet)
                self._serial.pending_retry = open_packet
                self._serial.pending_retry_started_at = monotonic()
                opened = True
            elif length == 21 and packet_type == 7:
                self._reply_or_reject_ping(self._serial, packet)
                if opened:
                    self._serial.pending_retry = None
                    return
            elif length == 16 and packet_type == 0 and opened:
                self._serial.pending_retry = None
                return
            self._maybe_resend(self._serial)
        raise TimeoutError(f"timed out starting IC-705 serial connection at {self.host}:{SERIAL_PORT}")

    def _control_loop(self) -> None:
        last_token_renew = monotonic()
        while not self._stop.is_set():
            packet = self._recv(self._control)
            if packet is not None:
                self._handle_control_packet(packet)
            now = monotonic()
            if now - self._control.last_ping >= PING_INTERVAL:
                self._control.send(self._build_ping_packet(self._control))
                self._control.last_ping = now
            if now - self._control.last_idle >= IDLE_INTERVAL:
                self._control.send(self._build_idle_packet(self._control))
                self._control.last_idle = now
            if self._token is not None and now - last_token_renew >= TOKEN_RENEW_INTERVAL:
                packet = self._build_token_packet(0x05)
                self._control.pending_retry = packet
                self._control.pending_retry_started_at = now
                self._control.send(packet)
                last_token_renew = now
            self._maybe_resend(self._control)

    def _serial_loop(self) -> None:
        while not self._stop.is_set():
            packet = self._recv(self._serial)
            if packet is not None:
                self._handle_serial_packet(packet)
            now = monotonic()
            if now - self._serial.last_ping >= PING_INTERVAL:
                self._serial.send(self._build_ping_packet(self._serial))
                self._serial.last_ping = now
            if now - self._serial.last_idle >= IDLE_INTERVAL:
                self._serial.send(self._build_idle_packet(self._serial))
                self._serial.last_idle = now
            self._maybe_resend(self._serial)

    def _handle_control_packet(self, packet: bytes) -> None:
        if len(packet) < 6:
            return
        packet_type = struct.unpack_from("<H", packet, 0x04)[0]
        if len(packet) == 21 and packet_type == 7:
            self._reply_or_reject_ping(self._control, packet)
            return
        if len(packet) == 80 and packet[0x29] == 0:
            self._capture_status(packet)
            self._control.send(self._build_status_reply(packet))
            return
        if len(packet) == 144 and packet[0x29] == 0:
            self._conn_guid = packet[0x20:0x30]
            self._control.send(self._build_conninfo_reply(packet))
            return
        if packet_type == 1:
            self._handle_retransmit_request(self._control, packet)
            return
        if len(packet) == 64:
            code = struct.unpack_from("<H", packet, 0x13)[0]
            res = struct.unpack_from("<H", packet, 0x15)[0]
            if code == 0x230 and res in {0x01, 0x05}:
                self._control.pending_retry = None

    def _handle_serial_packet(self, packet: bytes) -> None:
        if len(packet) < 6:
            return
        packet_type = struct.unpack_from("<H", packet, 0x04)[0]
        if len(packet) == 21 and packet_type == 7:
            self._reply_or_reject_ping(self._serial, packet)
            return
        if packet_type == 1:
            self._handle_retransmit_request(self._serial, packet)
            return
        if len(packet) > 0x15 and packet[0x10] == 0xC1:
            payload = packet[0x15:]
            self._frame_queue.put(payload)

    def _handle_retransmit_request(self, channel: _UdpChannel, packet: bytes) -> None:
        if len(packet) == 16:
            sequences = [struct.unpack_from("<H", packet, 0x06)[0]]
        else:
            sequences = [struct.unpack_from("<H", packet, offset)[0] for offset in range(0x10, len(packet), 4)]
        for sequence in sequences:
            tracked = channel.tracked.get(sequence)
            channel.send(tracked.data if tracked else self._build_idle_packet(channel, sequence_override=sequence))

    def _maybe_resend(self, channel: _UdpChannel) -> None:
        if channel.pending_retry and monotonic() - channel.pending_retry_started_at >= RESEND_INTERVAL:
            channel.send(channel.pending_retry)
            channel.pending_retry_started_at = monotonic()

    def _recv(self, channel: _UdpChannel) -> bytes | None:
        try:
            return channel.recv()
        except TimeoutError:
            return None
        except OSError:
            return None

    def _capture_status(self, packet: bytes) -> None:
        self._status_error = struct.unpack_from("<I", packet, 0x30)[0]
        maybe_civ = struct.unpack_from(">H", packet, 0x42)[0]
        maybe_audio = struct.unpack_from(">H", packet, 0x46)[0]
        if maybe_civ > 0:
            self._radio_civ_port = maybe_civ
        if maybe_audio > 0:
            self._radio_audio_port = maybe_audio

    def _reply_or_reject_ping(self, channel: _UdpChannel, packet: bytes) -> None:
        recv_id = struct.unpack_from("<I", packet, 0x0C)[0]
        if recv_id != channel.my_id:
            channel.send(self._build_disconnect_reply_packet(packet))
            return
        channel.send(self._build_ping_reply(packet))

    @staticmethod
    def _build_disconnect_packet(channel: _UdpChannel) -> bytes:
        packet = bytearray(16)
        struct.pack_into("<I", packet, 0x00, 16)
        struct.pack_into("<H", packet, 0x04, 5)
        struct.pack_into("<H", packet, 0x06, 1)
        struct.pack_into("<I", packet, 0x08, channel.my_id)
        struct.pack_into("<I", packet, 0x0C, channel.remote_id)
        return bytes(packet)

    @staticmethod
    def _build_are_you_there_packet(channel: _UdpChannel) -> bytes:
        packet = bytearray(16)
        struct.pack_into("<I", packet, 0x00, 16)
        struct.pack_into("<H", packet, 0x04, 3)
        struct.pack_into("<I", packet, 0x08, channel.my_id)
        return bytes(packet)

    @staticmethod
    def _build_are_you_ready_packet(channel: _UdpChannel) -> bytes:
        packet = bytearray(16)
        struct.pack_into("<I", packet, 0x00, 16)
        struct.pack_into("<H", packet, 0x04, 6)
        struct.pack_into("<H", packet, 0x06, 1)
        struct.pack_into("<I", packet, 0x08, channel.my_id)
        struct.pack_into("<I", packet, 0x0C, channel.remote_id)
        return bytes(packet)

    def _build_login_packet(self) -> bytes:
        packet = bytearray(0x80)
        struct.pack_into("<I", packet, 0x00, 0x80)
        struct.pack_into("<H", packet, 0x06, self._control.next_sequence())
        struct.pack_into("<I", packet, 0x08, self._control.my_id)
        struct.pack_into("<I", packet, 0x0C, self._control.remote_id)
        struct.pack_into("<H", packet, 0x13, 0x170)
        packet[0x17] = self._control.next_inner_sequence()
        struct.pack_into("<H", packet, 0x1A, self._token_request)
        packet[0x40:0x50] = _encode_icom_credential(self.username)
        packet[0x50:0x60] = _encode_icom_credential(self.password)
        packet[0x60:0x70] = self.client_name.encode("latin1", "ignore")[:16].ljust(16, b"\x00")
        return bytes(packet)

    def _build_token_packet(self, token_type: int) -> bytes:
        packet = bytearray(0x40)
        struct.pack_into("<I", packet, 0x00, 0x40)
        struct.pack_into("<H", packet, 0x06, self._control.next_sequence())
        struct.pack_into("<I", packet, 0x08, self._control.my_id)
        struct.pack_into("<I", packet, 0x0C, self._control.remote_id)
        struct.pack_into("<H", packet, 0x13, 0x130)
        struct.pack_into("<H", packet, 0x15, token_type)
        packet[0x17] = self._control.next_inner_sequence()
        struct.pack_into("<H", packet, 0x1A, self._token_request)
        struct.pack_into("<I", packet, 0x1C, self._token or 0)
        return bytes(packet)

    def _build_conninfo_host_packet(self, *, enable_rx: bool = True, enable_tx: bool = False) -> bytes:
        packet = bytearray(0x90)
        struct.pack_into("<I", packet, 0x00, 0x90)
        struct.pack_into("<H", packet, 0x06, self._control.next_sequence())
        struct.pack_into("<I", packet, 0x08, self._control.my_id)
        struct.pack_into("<I", packet, 0x0C, self._control.remote_id)
        struct.pack_into("<H", packet, 0x13, 0x180)
        struct.pack_into("<H", packet, 0x15, 0x03)
        packet[0x17] = self._control.next_inner_sequence()
        struct.pack_into("<H", packet, 0x1A, self._token_request)
        struct.pack_into("<I", packet, 0x1C, self._token or 0)
        struct.pack_into("<I", packet, 0x27, COMMON_CAP)
        packet[0x20:0x30] = self._conn_guid[:16].ljust(16, b"\x00")
        packet[0x40:0x50] = self._radio_name.encode("latin1", "ignore")[:16].ljust(16, b"\x00")
        packet[0x60:0x70] = _encode_icom_credential(self.username)
        packet[0x70] = 1 if enable_rx else 0
        packet[0x71] = 1 if enable_tx else 0
        packet[0x72] = RX_CODEC
        packet[0x73] = TX_CODEC
        struct.pack_into(">I", packet, 0x74, RX_SAMPLE_RATE)
        struct.pack_into(">I", packet, 0x78, TX_SAMPLE_RATE)
        struct.pack_into(">I", packet, 0x7C, self._civ_local_port)
        struct.pack_into(">I", packet, 0x80, self._audio_local_port)
        struct.pack_into(">I", packet, 0x84, TX_BUFFER_BYTES)
        packet[0x88] = 1
        return bytes(packet)

    @staticmethod
    def _build_status_reply(reply_to: bytes) -> bytes:
        packet = bytearray(reply_to)
        packet[0x08:0x0C] = reply_to[0x0C:0x10]
        packet[0x0C:0x10] = reply_to[0x08:0x0C]
        packet[0x29] = 1
        return bytes(packet)

    @staticmethod
    def _build_conninfo_reply(reply_to: bytes) -> bytes:
        packet = bytearray(reply_to)
        packet[0x08:0x0C] = reply_to[0x0C:0x10]
        packet[0x0C:0x10] = reply_to[0x08:0x0C]
        packet[0x29] = 1
        return bytes(packet)

    @staticmethod
    def _build_idle_packet(channel: _UdpChannel, sequence_override: int | None = None) -> bytes:
        packet = bytearray(16)
        struct.pack_into("<I", packet, 0x00, 16)
        struct.pack_into("<H", packet, 0x04, 0)
        struct.pack_into("<H", packet, 0x06, channel.next_sequence() if sequence_override is None else sequence_override)
        struct.pack_into("<I", packet, 0x08, channel.my_id)
        struct.pack_into("<I", packet, 0x0C, channel.remote_id)
        return bytes(packet)

    @staticmethod
    def _build_ping_reply(reply_to: bytes) -> bytes:
        packet = bytearray(reply_to)
        packet[0x08:0x0C] = reply_to[0x0C:0x10]
        packet[0x0C:0x10] = reply_to[0x08:0x0C]
        packet[0x10] = 1
        return bytes(packet)

    @staticmethod
    def _build_disconnect_reply_packet(reply_to: bytes) -> bytes:
        packet = bytearray(16)
        struct.pack_into("<I", packet, 0x00, 16)
        struct.pack_into("<H", packet, 0x04, 5)
        struct.pack_into("<H", packet, 0x06, 1)
        packet[0x08:0x0C] = reply_to[0x0C:0x10]
        packet[0x0C:0x10] = reply_to[0x08:0x0C]
        return bytes(packet)

    def _build_ping_packet(self, channel: _UdpChannel) -> bytes:
        packet = bytearray(21)
        struct.pack_into("<I", packet, 0x00, 21)
        struct.pack_into("<H", packet, 0x04, 7)
        struct.pack_into("<H", packet, 0x06, channel.next_ping_sequence())
        struct.pack_into("<I", packet, 0x08, channel.my_id)
        struct.pack_into("<I", packet, 0x0C, channel.remote_id)
        packet[0x10] = 0
        random_tail = random.randint(0, 0xFFFFFFFF)
        struct.pack_into("<I", packet, 0x11, random_tail)
        return bytes(packet)

    def _build_openclose_packet(self, *, open_request: bool) -> bytes:
        packet = bytearray(0x16)
        struct.pack_into("<I", packet, 0x00, 0x16)
        struct.pack_into("<H", packet, 0x06, self._serial.next_sequence())
        struct.pack_into("<I", packet, 0x08, self._serial.my_id)
        struct.pack_into("<I", packet, 0x0C, self._serial.remote_id)
        packet[0x10] = 0xC0
        struct.pack_into("<H", packet, 0x11, 1)
        struct.pack_into(">H", packet, 0x13, self._serial.next_stream_sequence())
        packet[0x15] = 4 if open_request else 0
        return bytes(packet)

    def _build_civ_packet(self, civ_data: bytes) -> bytes:
        packet = bytearray(0x15 + len(civ_data))
        struct.pack_into("<I", packet, 0x00, len(packet))
        struct.pack_into("<H", packet, 0x06, self._serial.next_sequence())
        struct.pack_into("<I", packet, 0x08, self._serial.my_id)
        struct.pack_into("<I", packet, 0x0C, self._serial.remote_id)
        packet[0x10] = 0xC1
        struct.pack_into("<H", packet, 0x11, len(civ_data))
        struct.pack_into(">H", packet, 0x13, self._serial.next_stream_sequence())
        packet[0x15:] = civ_data
        return bytes(packet)

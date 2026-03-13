from __future__ import annotations

from dataclasses import dataclass


CONTROLLER_ADDRESS = 0xE0
FRAME_PREAMBLE = bytes([0xFE, 0xFE])
FRAME_SUFFIX = 0xFD
ACK = 0xFB
NAK = 0xFA


@dataclass
class CivFrame:
    to_addr: int
    from_addr: int
    command: int
    payload: bytes = b""


def normalize_civ_address(value: str) -> str:
    text = str(value or "").strip().lower()
    if not text.startswith("0x"):
        raise ValueError("civ_address must use 0xNN format")
    number = int(text, 16)
    if number < 0 or number > 0xFF:
        raise ValueError("civ_address out of range")
    return f"0x{number:02X}"


def parse_civ_address(value: str) -> int:
    return int(normalize_civ_address(value), 16)


def build_frame(to_addr: int, command: int, payload: bytes = b"", from_addr: int = CONTROLLER_ADDRESS) -> bytes:
    return FRAME_PREAMBLE + bytes([to_addr, from_addr, command]) + payload + bytes([FRAME_SUFFIX])


def extract_frames(buffer: bytes) -> tuple[list[bytes], bytes]:
    frames: list[bytes] = []
    data = buffer
    while True:
        start = data.find(FRAME_PREAMBLE)
        if start < 0:
            return frames, b""
        if start > 0:
            data = data[start:]
        end = data.find(bytes([FRAME_SUFFIX]), 2)
        if end < 0:
            return frames, data
        frames.append(data[: end + 1])
        data = data[end + 1 :]


def parse_frame(frame: bytes) -> CivFrame:
    if len(frame) < 6 or not frame.startswith(FRAME_PREAMBLE) or frame[-1] != FRAME_SUFFIX:
        raise ValueError("invalid CI-V frame")
    return CivFrame(
        to_addr=frame[2],
        from_addr=frame[3],
        command=frame[4],
        payload=frame[5:-1],
    )


def is_ack(frame: bytes) -> bool:
    parsed = parse_frame(frame)
    return parsed.command == ACK


def is_nak(frame: bytes) -> bool:
    parsed = parse_frame(frame)
    return parsed.command == NAK


def freq_to_bcd(freq_hz: int, byte_count: int = 5) -> bytes:
    value = max(0, int(round(freq_hz)))
    out = bytearray()
    for _ in range(byte_count):
        lo = value % 10
        value //= 10
        hi = value % 10
        value //= 10
        out.append((hi << 4) | lo)
    return bytes(out)


def bcd_to_freq(data: bytes) -> int:
    value = 0
    mult = 1
    for byte in data:
        lo = byte & 0x0F
        hi = (byte >> 4) & 0x0F
        value += lo * mult
        mult *= 10
        value += hi * mult
        mult *= 10
    return value

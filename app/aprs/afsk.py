from __future__ import annotations

import math
import struct


SAMPLE_RATE = 48_000
BIT_RATE = 1_200
SAMPLES_PER_BIT = SAMPLE_RATE // BIT_RATE
MARK_HZ = 1_200.0
SPACE_HZ = 2_200.0
DEFAULT_AMPLITUDE = 12_000


def _crc_x25(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 0x01:
                crc = (crc >> 1) ^ 0x8408
            else:
                crc >>= 1
    return (~crc) & 0xFFFF


def _bytes_to_bits_lsb(data: bytes):
    for byte in data:
        for index in range(8):
            yield (byte >> index) & 0x01


def _bit_stuff(bits):
    ones = 0
    for bit in bits:
        yield bit
        if bit:
            ones += 1
            if ones == 5:
                yield 0
                ones = 0
        else:
            ones = 0


def _nrzi_tones(bits):
    mark = True
    for bit in bits:
        if bit == 0:
            mark = not mark
        yield MARK_HZ if mark else SPACE_HZ


def ax25_to_afsk(frame: bytes, *, amplitude: int = DEFAULT_AMPLITUDE) -> bytes:
    """Convert an AX.25 frame payload into 1200 baud Bell 202 PCM audio."""
    payload = frame + struct.pack("<H", _crc_x25(frame))
    flag = bytes([0x7E])
    preamble = flag * 40
    trailer = flag * 6
    stuffed = list(_bit_stuff(_bytes_to_bits_lsb(payload)))
    all_bits = list(_bytes_to_bits_lsb(preamble)) + stuffed + list(_bytes_to_bits_lsb(trailer))
    pcm = bytearray()
    phase = 0.0
    two_pi = 2.0 * math.pi
    for freq in _nrzi_tones(all_bits):
        step = two_pi * freq / SAMPLE_RATE
        for _ in range(SAMPLES_PER_BIT):
            sample = int(amplitude * math.sin(phase))
            pcm += struct.pack("<h", sample)
            phase += step
            if phase >= two_pi:
                phase -= two_pi
    return bytes(pcm)

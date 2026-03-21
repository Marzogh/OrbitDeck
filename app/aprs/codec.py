from __future__ import annotations

from datetime import UTC, datetime

from app.models import AprsPacketEvent


def _parse_callsign(value: str) -> tuple[str, int]:
    text = str(value or "").strip().upper()
    if "-" not in text:
        return text, 0
    base, ssid = text.split("-", 1)
    try:
        parsed = int(ssid)
    except ValueError:
        parsed = 0
    return base[:6], max(0, min(15, parsed))


def _format_callsign(base: str, ssid: int) -> str:
    clean = base.strip().upper()
    return clean if ssid <= 0 else f"{clean}-{ssid}"


def _encode_address(value: str, *, last: bool, repeated: bool = False) -> bytes:
    base, ssid = _parse_callsign(value)
    callsign = base.ljust(6)
    encoded = bytearray((ord(char) << 1) for char in callsign)
    flag = 0x60 | ((ssid & 0x0F) << 1)
    if repeated:
        flag |= 0x80
    if last:
        flag |= 0x01
    encoded.append(flag)
    return bytes(encoded)


def _decode_address(chunk: bytes) -> tuple[str, bool]:
    callsign = "".join(chr((byte >> 1) & 0x7F) for byte in chunk[:6]).strip()
    ssid = (chunk[6] >> 1) & 0x0F
    repeated = bool(chunk[6] & 0x80)
    return _format_callsign(callsign, ssid) + ("*" if repeated else ""), bool(chunk[6] & 0x01)


def encode_ui_frame(source: str, destination: str, path: list[str], text: str) -> bytes:
    addresses = [_encode_address(destination, last=False), _encode_address(source, last=not path)]
    for idx, hop in enumerate(path):
        addresses.append(_encode_address(hop, last=idx == len(path) - 1))
    return b"".join(addresses) + bytes([0x03, 0xF0]) + text.encode("ascii", errors="replace")


def _parse_position(text: str) -> tuple[float | None, float | None]:
    if len(text) < 20:
        return None, None
    try:
        lat_deg = int(text[1:3])
        lat_min = float(text[3:8])
        lat_hemi = text[8]
        lon_deg = int(text[10:13])
        lon_min = float(text[13:18])
        lon_hemi = text[18]
    except Exception:
        return None, None
    lat = lat_deg + (lat_min / 60.0)
    lon = lon_deg + (lon_min / 60.0)
    if lat_hemi == "S":
        lat *= -1
    if lon_hemi == "W":
        lon *= -1
    return lat, lon


def _decode_info_fields(info: str) -> tuple[str, str | None, str | None, float | None, float | None]:
    packet_type = "raw"
    addressee = None
    message_id = None
    latitude = None
    longitude = None
    text = info
    if info.startswith(":") and len(info) >= 11:
        packet_type = "message"
        addressee = info[1:10].strip()
        body = info[10:]
        if ":" in body:
            text = body.split(":", 1)[1]
        if "{" in text:
            text, message_id = text.split("{", 1)
    elif info.startswith(("!", "=")):
        packet_type = "position"
        latitude, longitude = _parse_position(info)
    elif info.startswith(">"):
        packet_type = "status"
        text = info[1:].strip()
    return packet_type, addressee, message_id, latitude, longitude, text.strip()


def decode_ui_frame(frame: bytes) -> AprsPacketEvent:
    if len(frame) < 16:
        raise ValueError("AX.25 frame too short")
    addresses: list[str] = []
    idx = 0
    last = False
    while not last:
        if idx + 7 > len(frame):
            raise ValueError("AX.25 address field truncated")
        address, last = _decode_address(frame[idx:idx + 7])
        addresses.append(address)
        idx += 7
    if idx + 2 > len(frame):
        raise ValueError("AX.25 control field missing")
    info = frame[idx + 2:].decode("ascii", errors="replace")
    source = addresses[1].rstrip("*") if len(addresses) > 1 else "UNKNOWN"
    destination = addresses[0].rstrip("*") if addresses else "APRS"
    path = addresses[2:]
    packet_type, addressee, message_id, latitude, longitude, text = _decode_info_fields(info)
    raw_tnc2 = f"{source}>{destination}"
    if path:
        raw_tnc2 += "," + ",".join(path)
    raw_tnc2 += f":{info}"
    return AprsPacketEvent(
        received_at=datetime.now(UTC),
        source=source,
        destination=destination,
        path=path,
        packet_type=packet_type,
        text=text.strip(),
        latitude=latitude,
        longitude=longitude,
        addressee=addressee,
        message_id=message_id,
        raw_tnc2=raw_tnc2,
    )


def decode_tnc2(raw_tnc2: str, *, received_at: datetime | None = None) -> AprsPacketEvent:
    text = str(raw_tnc2 or "").strip()
    if not text or ">" not in text or ":" not in text:
        raise ValueError("TNC2 packet text is malformed")
    head, info = text.split(":", 1)
    source, route = head.split(">", 1)
    parts = [part.strip() for part in route.split(",") if part.strip()]
    if not parts:
        raise ValueError("TNC2 packet destination is missing")
    destination = parts[0].rstrip("*")
    path = [part.rstrip("*") for part in parts[1:]]
    packet_type, addressee, message_id, latitude, longitude, decoded_text = _decode_info_fields(info)
    return AprsPacketEvent(
        received_at=received_at or datetime.now(UTC),
        source=source.strip().upper(),
        destination=destination.strip().upper(),
        path=path,
        packet_type=packet_type,
        text=decoded_text,
        latitude=latitude,
        longitude=longitude,
        addressee=addressee,
        message_id=message_id,
        raw_tnc2=text,
    )


def format_position_payload(latitude: float, longitude: float, symbol_table: str, symbol_code: str, comment: str) -> str:
    lat_hemi = "N" if latitude >= 0 else "S"
    lon_hemi = "E" if longitude >= 0 else "W"
    lat_abs = abs(latitude)
    lon_abs = abs(longitude)
    lat_deg = int(lat_abs)
    lon_deg = int(lon_abs)
    lat_min = (lat_abs - lat_deg) * 60.0
    lon_min = (lon_abs - lon_deg) * 60.0
    return (
        f"!{lat_deg:02d}{lat_min:05.2f}{lat_hemi}{symbol_table}"
        f"{lon_deg:03d}{lon_min:05.2f}{lon_hemi}{symbol_code}{comment[:67]}"
    )


def format_status_payload(text: str) -> str:
    return ">" + text[:67]


def format_message_payload(addressee: str, text: str) -> str:
    return f":{addressee.strip().upper():<9}:{text[:67]}"

from __future__ import annotations

from time import sleep

from app.models import FrequencyRecommendation, RadioRigModel
from app.radio.civ import ACK, NAK, bcd_to_freq, freq_to_bcd, parse_frame
from app.radio.controllers.base import BaseIcomController


class Ic705Controller(BaseIcomController):
    model = RadioRigModel.ic705

    C_RD_SPLIT = 0x0F
    C_RD_MODE = 0x04
    C_SEL_MODE = 0x26
    C_CTL_SPLT = 0x0F
    C_CTL_LVL = 0x14
    C_CTL_SCP = 0x27
    C_SEL_FREQ = 0x25
    C_SET_VFO = 0x07
    C_SET_FREQ = 0x05
    C_SET_MODE = 0x06
    S_LVL_SQL = 0x03
    S_SCP_STS = 0x10
    S_SCP_MOD = 0x14
    S_SCP_SPN = 0x15
    S_VFOA = 0x00
    S_VFOB = 0x01
    S_SPLT_OFF = 0x00
    S_SPLT_ON = 0x01
    SCOPE_MAIN = 0x00
    SCOPE_MODE_CENTER = 0x00
    SQL_OPEN = 0.0
    MAX_SCOPE_SPAN_HZ = 1_000_000
    MODE_MAP = {
        "USB": 0x01,
        "AM": 0x02,
        "CW": 0x03,
        "RTTY": 0x04,
        "FM": 0x05,
        "WFM": 0x06,
        "CWR": 0x07,
        "RTTYR": 0x08,
        "DSTAR": 0x17,
        "D-STAR": 0x17,
    }
    MODE_FROM_CODE = {
        0x01: "USB",
        0x02: "AM",
        0x03: "CW",
        0x04: "RTTY",
        0x05: "FM",
        0x06: "WFM",
        0x07: "CWR",
        0x08: "RTTYR",
        0x17: "DSTAR",
    }
    WRITE_SETTLE_SECONDS = 0.2

    def __init__(self, transport, civ_address: int) -> None:
        super().__init__(transport, civ_address)
        self._selected_vfo = "A"

    def connect(self):
        self.transport.open()
        self.state.connected = True
        self.state.last_error = None
        self._set_active_vfo("A")
        self._selected_vfo = "A"
        self.poll_state()
        return self.state

    def _set_active_vfo(self, vfo: str) -> None:
        vfo_name = str(vfo or "").strip().upper()
        subcmd = self.S_VFOA if vfo_name == "A" else self.S_VFOB
        frame = self.transport.transact(
            self.civ_address,
            self.C_SET_VFO,
            bytes([subcmd]),
            expect_commands={ACK, NAK},
        )
        if parse_frame(frame).command == NAK:
            raise RuntimeError(f"IC-705 rejected VFO {vfo_name} selection")
        self._selected_vfo = vfo_name

    def _set_selected_freq(self, freq_hz: int) -> None:
        frame = self.transport.transact(
            self.civ_address,
            self.C_SET_FREQ,
            freq_to_bcd(freq_hz, 5),
            expect_commands={ACK, NAK},
        )
        if parse_frame(frame).command == NAK:
            raise RuntimeError(f"IC-705 rejected frequency set to {freq_hz}")
        sleep(self.WRITE_SETTLE_SECONDS)

    def _set_split_enabled(self, enabled: bool, *, rx_vfo: str | None = None) -> None:
        if rx_vfo is not None:
            self._set_active_vfo(rx_vfo)
        frame = self.transport.transact(
            self.civ_address,
            self.C_CTL_SPLT,
            bytes([self.S_SPLT_ON if enabled else self.S_SPLT_OFF]),
            expect_commands={ACK, NAK},
        )
        if parse_frame(frame).command == NAK:
            raise RuntimeError(f"IC-705 rejected split {'enable' if enabled else 'disable'}")
        sleep(self.WRITE_SETTLE_SECONDS)

    def _set_selected_mode(self, mode: str) -> None:
        mode_name = str(mode or "").strip().upper()
        if not mode_name:
            return
        mode_code = self.MODE_MAP.get(mode_name)
        if mode_code is None:
            raise ValueError(f"Unsupported IC-705 mode: {mode}")
        frame = self.transport.transact(
            self.civ_address,
            self.C_SET_MODE,
            bytes([mode_code]),
            expect_commands={ACK, NAK},
        )
        if parse_frame(frame).command == NAK:
            raise RuntimeError(f"IC-705 rejected mode {mode_name}")
        sleep(self.WRITE_SETTLE_SECONDS)

    @staticmethod
    def _bcd_be_bytes(value: int, byte_count: int) -> bytes:
        text = f"{max(0, int(value)):0{byte_count * 2}d}"[-(byte_count * 2):]
        return bytes(int(text[idx: idx + 2], 16) for idx in range(0, len(text), 2))

    @staticmethod
    def _from_bcd_be_bytes(data: bytes) -> int:
        digits = "".join(f"{(byte >> 4) & 0x0F}{byte & 0x0F}" for byte in data)
        return int(digits or "0")

    def _set_squelch_level(self, value: float) -> None:
        bounded = max(0.0, min(1.0, float(value)))
        raw = max(0, min(255, int(round(bounded * 255))))
        payload = bytes([self.S_LVL_SQL]) + self._bcd_be_bytes(raw, 2)
        frame = self.transport.transact(
            self.civ_address,
            self.C_CTL_LVL,
            payload,
            expect_commands={ACK, NAK},
        )
        if parse_frame(frame).command == NAK:
            raise RuntimeError("IC-705 rejected squelch level change")
        sleep(self.WRITE_SETTLE_SECONDS)

    def _set_scope_enabled(self, enabled: bool) -> None:
        frame = self.transport.transact(
            self.civ_address,
            self.C_CTL_SCP,
            bytes([self.S_SCP_STS, 0x01 if enabled else 0x00]),
            expect_commands={ACK, NAK},
        )
        if parse_frame(frame).command == NAK:
            raise RuntimeError(f"IC-705 rejected scope {'enable' if enabled else 'disable'}")
        sleep(self.WRITE_SETTLE_SECONDS)

    def _set_scope_mode(self, mode: int = SCOPE_MODE_CENTER) -> None:
        frame = self.transport.transact(
            self.civ_address,
            self.C_CTL_SCP,
            bytes([self.S_SCP_MOD, self.SCOPE_MAIN, mode]),
            expect_commands={ACK, NAK},
        )
        if parse_frame(frame).command == NAK:
            raise RuntimeError("IC-705 rejected scope mode change")
        sleep(self.WRITE_SETTLE_SECONDS)

    def _set_scope_span(self, span_hz: int = MAX_SCOPE_SPAN_HZ) -> None:
        half_span_hz = max(0, int(round(span_hz / 2)))
        frame = self.transport.transact(
            self.civ_address,
            self.C_CTL_SCP,
            bytes([self.S_SCP_SPN, self.SCOPE_MAIN]) + freq_to_bcd(half_span_hz, 5),
            expect_commands={ACK, NAK},
        )
        if parse_frame(frame).command == NAK:
            raise RuntimeError("IC-705 rejected scope span change")
        sleep(self.WRITE_SETTLE_SECONDS)

    def _read_selected_mode(self) -> str:
        frame = self.transport.transact(
            self.civ_address,
            self.C_RD_MODE,
            b"",
            expect_commands={self.C_RD_MODE, ACK, NAK},
        )
        parsed = parse_frame(frame)
        if parsed.command == NAK:
            raise RuntimeError("IC-705 rejected mode read")
        if not parsed.payload:
            raise RuntimeError("IC-705 returned a truncated mode response")
        return self.MODE_FROM_CODE.get(parsed.payload[0], f"0x{parsed.payload[0]:02X}")

    def _read_vfo_mode(self, selected: bool) -> str:
        frame = self.transport.transact(
            self.civ_address,
            self.C_SEL_MODE,
            bytes([0x00 if selected else 0x01]),
            expect_commands={self.C_SEL_MODE, ACK, NAK},
        )
        parsed = parse_frame(frame)
        if parsed.command == NAK:
            raise RuntimeError("IC-705 rejected VFO mode read")
        if len(parsed.payload) < 2:
            raise RuntimeError("IC-705 returned a truncated VFO mode response")
        return self.MODE_FROM_CODE.get(parsed.payload[1], f"0x{parsed.payload[1]:02X}")

    def _read_squelch_level(self) -> float:
        frame = self.transport.transact(
            self.civ_address,
            self.C_CTL_LVL,
            bytes([self.S_LVL_SQL]),
            expect_commands={self.C_CTL_LVL, ACK, NAK},
        )
        parsed = parse_frame(frame)
        if parsed.command == NAK:
            raise RuntimeError("IC-705 rejected squelch read")
        if len(parsed.payload) < 3:
            raise RuntimeError("IC-705 returned a truncated squelch response")
        raw = self._from_bcd_be_bytes(parsed.payload[1:3])
        return max(0.0, min(1.0, raw / 255.0))

    def _read_scope_enabled(self) -> bool:
        frame = self.transport.transact(
            self.civ_address,
            self.C_CTL_SCP,
            bytes([self.S_SCP_STS]),
            expect_commands={self.C_CTL_SCP, ACK, NAK},
        )
        parsed = parse_frame(frame)
        if parsed.command == NAK:
            raise RuntimeError("IC-705 rejected scope status read")
        if len(parsed.payload) < 2:
            raise RuntimeError("IC-705 returned a truncated scope status response")
        return parsed.payload[1] == 0x01

    def _read_scope_mode(self) -> int:
        frame = self.transport.transact(
            self.civ_address,
            self.C_CTL_SCP,
            bytes([self.S_SCP_MOD, self.SCOPE_MAIN]),
            expect_commands={self.C_CTL_SCP, ACK, NAK},
        )
        parsed = parse_frame(frame)
        if parsed.command == NAK:
            raise RuntimeError("IC-705 rejected scope mode read")
        if len(parsed.payload) < 3:
            raise RuntimeError("IC-705 returned a truncated scope mode response")
        return parsed.payload[2]

    def _read_scope_span(self) -> int:
        frame = self.transport.transact(
            self.civ_address,
            self.C_CTL_SCP,
            bytes([self.S_SCP_SPN, self.SCOPE_MAIN]),
            expect_commands={self.C_CTL_SCP, ACK, NAK},
        )
        parsed = parse_frame(frame)
        if parsed.command == NAK:
            raise RuntimeError("IC-705 rejected scope span read")
        if len(parsed.payload) < 7:
            raise RuntimeError("IC-705 returned a truncated scope span response")
        return bcd_to_freq(parsed.payload[2:7]) * 2

    def _read_vfo_freq(self, selected: bool) -> int:
        frame = self.transport.transact(
            self.civ_address,
            self.C_SEL_FREQ,
            bytes([0x00 if selected else 0x01]),
            expect_commands={self.C_SEL_FREQ, ACK, NAK},
        )
        parsed = parse_frame(frame)
        if parsed.command == NAK:
            raise RuntimeError("IC-705 rejected VFO frequency read")
        if len(parsed.payload) < 6:
            raise RuntimeError("IC-705 returned a truncated VFO frequency response")
        return bcd_to_freq(parsed.payload[1:6])

    def _merge_known_targets(
        self,
        vfo_a_hz: int,
        vfo_b_hz: int,
        vfo_a_mode: str,
        vfo_b_mode: str,
    ) -> tuple[int, int, str, str]:
        prev_a_hz = int(self.state.targets.get("vfo_a_freq_hz") or 0)
        prev_b_hz = int(self.state.targets.get("vfo_b_freq_hz") or 0)
        prev_a_mode = str(self.state.targets.get("vfo_a_mode") or "")
        prev_b_mode = str(self.state.targets.get("vfo_b_mode") or "")
        prev_split = bool(self.state.raw_state.get("split_enabled", False))

        # Preserve prior A/B assignment if the radio returns a collapsed pair
        # after we previously had split frequencies in place.
        collapsed_pair = vfo_a_hz > 0 and vfo_a_hz == vfo_b_hz
        if collapsed_pair and prev_a_hz > 0 and prev_b_hz > 0 and (prev_a_hz != prev_b_hz or prev_split):
            vfo_a_hz = prev_a_hz
            vfo_b_hz = prev_b_hz
        else:
            if vfo_a_hz <= 0 and prev_a_hz > 0:
                vfo_a_hz = prev_a_hz
            if vfo_b_hz <= 0 and prev_b_hz > 0:
                vfo_b_hz = prev_b_hz

        if str(vfo_a_mode).startswith("0x") and prev_a_mode:
            vfo_a_mode = prev_a_mode
        if str(vfo_b_mode).startswith("0x") and prev_b_mode:
            vfo_b_mode = prev_b_mode
        return vfo_a_hz, vfo_b_hz, vfo_a_mode, vfo_b_mode

    def _read_split_enabled(self) -> bool:
        frame = self.transport.transact(
            self.civ_address,
            self.C_RD_SPLIT,
            b"",
            expect_commands={self.C_RD_SPLIT, ACK, NAK},
        )
        parsed = parse_frame(frame)
        if parsed.command == NAK:
            raise RuntimeError("IC-705 rejected split-status read")
        if not parsed.payload:
            return False
        return parsed.payload[0] == 0x01

    def poll_state(self):
        selected_hz = self._read_vfo_freq(selected=True)
        other_hz = self._read_vfo_freq(selected=False)
        selected_mode = self._read_vfo_mode(selected=True)
        other_mode = self._read_vfo_mode(selected=False)
        if self._selected_vfo == "A":
            vfo_a_hz, vfo_b_hz = selected_hz, other_hz
            vfo_a_mode, vfo_b_mode = selected_mode, other_mode
        else:
            vfo_a_hz, vfo_b_hz = other_hz, selected_hz
            vfo_a_mode, vfo_b_mode = other_mode, selected_mode
        vfo_a_hz, vfo_b_hz, vfo_a_mode, vfo_b_mode = self._merge_known_targets(
            vfo_a_hz,
            vfo_b_hz,
            vfo_a_mode,
            vfo_b_mode,
        )
        split_enabled = self._read_split_enabled()
        squelch_level = self._read_squelch_level()
        scope_enabled = self._read_scope_enabled()
        scope_mode = self._read_scope_mode()
        scope_span_hz = self._read_scope_span()
        self.state.raw_state["split_enabled"] = split_enabled
        self.state.raw_state["tx_vfo"] = "A"
        self.state.raw_state["selected_vfo"] = self._selected_vfo
        self.state.raw_state["squelch_level"] = squelch_level
        self.state.raw_state["scope_enabled"] = scope_enabled
        self.state.raw_state["scope_mode"] = "center" if scope_mode == self.SCOPE_MODE_CENTER else str(scope_mode)
        self.state.raw_state["scope_span_hz"] = scope_span_hz
        self.state.targets["vfo_a_label"] = "VFO A (TX)"
        self.state.targets["vfo_b_label"] = "VFO B (RX)"
        self.state.targets["vfo_a_freq_hz"] = vfo_a_hz
        self.state.targets["vfo_b_freq_hz"] = vfo_b_hz
        self.state.targets["vfo_a_mode"] = vfo_a_mode
        self.state.targets["vfo_b_mode"] = vfo_b_mode
        self.state.targets["squelch_level"] = squelch_level
        self.state.targets["scope_enabled"] = scope_enabled
        self.state.targets["scope_mode"] = "CENTER" if scope_mode == self.SCOPE_MODE_CENTER else str(scope_mode)
        self.state.targets["scope_span_hz"] = scope_span_hz
        self.stamp_poll()
        return self.state

    def apply_target(self, recommendation: FrequencyRecommendation, apply_mode_and_tone: bool):
        if recommendation.uplink_mhz is None and recommendation.downlink_mhz is None:
            raise ValueError("recommendation must include at least one radio frequency")
        current_a_hz = int(self.state.targets.get("vfo_a_freq_hz") or 0)
        current_b_hz = int(self.state.targets.get("vfo_b_freq_hz") or 0)
        current_a_mode = str(self.state.targets.get("vfo_a_mode") or "FM")
        current_b_mode = str(self.state.targets.get("vfo_b_mode") or "FM")
        vfo_a_hz = int(round(recommendation.uplink_mhz * 1_000_000)) if recommendation.uplink_mhz is not None else current_a_hz
        vfo_b_hz = int(round(recommendation.downlink_mhz * 1_000_000)) if recommendation.downlink_mhz is not None else current_b_hz
        uplink_mode = (recommendation.uplink_mode or current_a_mode or "FM")
        downlink_mode = (recommendation.downlink_mode or current_b_mode or "FM")
        receive_only = recommendation.uplink_mhz is None and recommendation.downlink_mhz is not None
        transmit_only = recommendation.downlink_mhz is None and recommendation.uplink_mhz is not None
        self._set_active_vfo("A")
        self._set_split_enabled(False)
        if recommendation.uplink_mhz is not None:
            self._set_selected_freq(vfo_a_hz)
            if apply_mode_and_tone:
                self._set_selected_mode(uplink_mode)
        self._set_active_vfo("B")
        if recommendation.downlink_mhz is not None:
            self._set_selected_freq(vfo_b_hz)
            if apply_mode_and_tone:
                self._set_selected_mode(downlink_mode)
        self._set_squelch_level(self.SQL_OPEN)
        self._set_scope_enabled(True)
        self._set_scope_mode(self.SCOPE_MODE_CENTER)
        self._set_scope_span(self.MAX_SCOPE_SPAN_HZ)
        if recommendation.uplink_mhz is not None and recommendation.downlink_mhz is not None:
            self._set_split_enabled(True, rx_vfo="B")
        elif receive_only:
            self._set_active_vfo("B")
        else:
            self._set_active_vfo("A")
        self.state.targets.update(
            {
                "vfo_a_label": "VFO A (TX)",
                "vfo_b_label": "VFO B (RX)",
                "vfo_a_freq_hz": vfo_a_hz,
                "vfo_b_freq_hz": vfo_b_hz,
                "vfo_a_mode": uplink_mode,
                "vfo_b_mode": downlink_mode,
                "squelch_level": self.SQL_OPEN,
                "scope_enabled": True,
                "scope_mode": "CENTER",
                "scope_span_hz": self.MAX_SCOPE_SPAN_HZ,
            }
        )
        self.state.raw_state.update(
            {
                "split_enabled": bool(recommendation.uplink_mhz is not None and recommendation.downlink_mhz is not None),
                "tx_vfo": "A" if recommendation.uplink_mhz is not None else None,
                "selected_vfo": "B" if receive_only or recommendation.downlink_mhz is not None else "A",
                "rx_vfo": "B" if recommendation.downlink_mhz is not None else None,
                "receive_only": receive_only,
                "transmit_only": transmit_only,
                "squelch_level": self.SQL_OPEN,
                "scope_enabled": True,
                "scope_mode": "center",
                "scope_span_hz": self.MAX_SCOPE_SPAN_HZ,
                "tone_reenabled": bool(apply_mode_and_tone and recommendation.tone),
            }
        )
        self.poll_state()
        return self.state, {
            "tx": "A" if recommendation.uplink_mhz is not None else None,
            "rx": "B" if recommendation.downlink_mhz is not None else None,
            "vfo_a_freq_hz": vfo_a_hz,
            "vfo_b_freq_hz": vfo_b_hz,
            "receive_only": receive_only,
        }

    def set_frequency(self, vfo: str, freq_hz: int):
        vfo_name = str(vfo or "").strip().upper()
        if vfo_name not in {"A", "B"}:
            raise ValueError("IC-705 frequency writes require vfo A or B")
        prior_vfo = self._selected_vfo
        self._set_active_vfo(vfo_name)
        self._set_selected_freq(int(freq_hz))
        if prior_vfo != vfo_name:
            self._set_active_vfo(prior_vfo)
        key = "vfo_a_freq_hz" if vfo_name == "A" else "vfo_b_freq_hz"
        self.state.targets[key] = int(freq_hz)
        self.poll_state()
        self.state.targets[key] = int(freq_hz)
        self.state.raw_state["last_set_vfo"] = vfo_name
        self.stamp_poll()
        return self.state, {"vfo": vfo_name, "freq_hz": int(freq_hz)}

    def snapshot_state(self) -> dict[str, object]:
        self.poll_state()
        return {
            "selected_vfo": self._selected_vfo,
            "split_enabled": bool(self.state.raw_state.get("split_enabled", False)),
            "vfo_a_freq_hz": int(self.state.targets.get("vfo_a_freq_hz") or 0),
            "vfo_b_freq_hz": int(self.state.targets.get("vfo_b_freq_hz") or 0),
            "vfo_a_mode": str(self.state.targets.get("vfo_a_mode") or "FM"),
            "vfo_b_mode": str(self.state.targets.get("vfo_b_mode") or "FM"),
            "squelch_level": float(self.state.raw_state.get("squelch_level", 0.0) or 0.0),
            "scope_enabled": bool(self.state.raw_state.get("scope_enabled", False)),
            "scope_mode": self.SCOPE_MODE_CENTER if self.state.raw_state.get("scope_mode") == "center" else self.SCOPE_MODE_CENTER,
            "scope_span_hz": int(self.state.raw_state.get("scope_span_hz") or self.MAX_SCOPE_SPAN_HZ),
        }

    def restore_snapshot(self, snapshot: dict[str, object]):
        selected_vfo = str(snapshot.get("selected_vfo") or "A").upper()
        split_enabled = bool(snapshot.get("split_enabled", False))
        vfo_a_hz = int(snapshot.get("vfo_a_freq_hz") or 0)
        vfo_b_hz = int(snapshot.get("vfo_b_freq_hz") or 0)
        vfo_a_mode = str(snapshot.get("vfo_a_mode") or "FM")
        vfo_b_mode = str(snapshot.get("vfo_b_mode") or "FM")
        squelch_level = float(snapshot.get("squelch_level", 0.0) or 0.0)
        scope_enabled = bool(snapshot.get("scope_enabled", False))
        scope_mode = int(snapshot.get("scope_mode") or self.SCOPE_MODE_CENTER)
        scope_span_hz = int(snapshot.get("scope_span_hz") or self.MAX_SCOPE_SPAN_HZ)

        self._set_active_vfo("A")
        self._set_split_enabled(False)
        if vfo_a_hz > 0:
            self._set_selected_freq(vfo_a_hz)
        self._set_selected_mode(vfo_a_mode)
        self._set_active_vfo("B")
        if vfo_b_hz > 0:
            self._set_selected_freq(vfo_b_hz)
        self._set_selected_mode(vfo_b_mode)
        self._set_squelch_level(squelch_level)
        self._set_scope_enabled(scope_enabled)
        self._set_scope_mode(scope_mode)
        self._set_scope_span(scope_span_hz)
        if split_enabled:
            self._set_split_enabled(True, rx_vfo="B")
        self._set_active_vfo(selected_vfo if selected_vfo in {"A", "B"} else "A")
        return self.poll_state()

from __future__ import annotations

from time import sleep

from app.models import FrequencyRecommendation, RadioRigModel
from app.radio.civ import ACK, NAK, bcd_to_freq, freq_to_bcd, parse_frame
from app.radio.controllers.base import BaseIcomController


class Ic705Controller(BaseIcomController):
    model = RadioRigModel.ic705

    C_RD_SPLIT = 0x0F
    C_CTL_SPLT = 0x0F
    C_SEL_FREQ = 0x25
    C_SET_VFO = 0x07
    C_SET_FREQ = 0x05
    C_SET_MODE = 0x06
    S_VFOA = 0x00
    S_VFOB = 0x01
    S_SPLT_OFF = 0x00
    S_SPLT_ON = 0x01
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
        if self._selected_vfo == "A":
            vfo_a_hz, vfo_b_hz = selected_hz, other_hz
        else:
            vfo_a_hz, vfo_b_hz = other_hz, selected_hz
        split_enabled = self._read_split_enabled()
        self.state.raw_state["split_enabled"] = split_enabled
        self.state.raw_state["tx_vfo"] = "A"
        self.state.raw_state["selected_vfo"] = self._selected_vfo
        self.state.targets["vfo_a_label"] = "VFO A (TX)"
        self.state.targets["vfo_b_label"] = "VFO B (RX)"
        self.state.targets["vfo_a_freq_hz"] = vfo_a_hz
        self.state.targets["vfo_b_freq_hz"] = vfo_b_hz
        self.stamp_poll()
        return self.state

    def apply_target(self, recommendation: FrequencyRecommendation, apply_mode_and_tone: bool):
        if recommendation.uplink_mhz is None or recommendation.downlink_mhz is None:
            raise ValueError("recommendation must include uplink and downlink")
        vfo_a_hz = int(round(recommendation.uplink_mhz * 1_000_000))
        vfo_b_hz = int(round(recommendation.downlink_mhz * 1_000_000))
        uplink_mode = recommendation.uplink_mode or "FM"
        downlink_mode = recommendation.downlink_mode or "FM"
        self._set_active_vfo("A")
        self._set_split_enabled(False)
        self._set_selected_freq(vfo_a_hz)
        if apply_mode_and_tone:
            self._set_selected_mode(uplink_mode)
        self._set_active_vfo("B")
        self._set_selected_freq(vfo_b_hz)
        if apply_mode_and_tone:
            self._set_selected_mode(downlink_mode)
        self._set_split_enabled(True, rx_vfo="B")
        self.poll_state()
        self.state.targets.update(
            {
                "vfo_a_mode": uplink_mode,
                "vfo_b_mode": downlink_mode,
            }
        )
        self.state.raw_state.update(
            {
                "split_enabled": True,
                "tx_vfo": "A",
                "rx_vfo": "B",
                "tone_reenabled": bool(apply_mode_and_tone and recommendation.tone),
            }
        )
        return self.state, {"tx": "A", "rx": "B", "vfo_a_freq_hz": vfo_a_hz, "vfo_b_freq_hz": vfo_b_hz}

    def set_frequency(self, vfo: str, freq_hz: int):
        vfo_name = str(vfo or "").strip().upper()
        if vfo_name not in {"A", "B"}:
            raise ValueError("IC-705 frequency writes require vfo A or B")
        prior_vfo = self._selected_vfo
        self._set_active_vfo(vfo_name)
        self._set_selected_freq(int(freq_hz))
        if prior_vfo != vfo_name:
            self._set_active_vfo(prior_vfo)
        self.poll_state()
        key = "vfo_a_freq_hz" if vfo_name == "A" else "vfo_b_freq_hz"
        self.state.targets[key] = int(freq_hz)
        self.state.raw_state["last_set_vfo"] = vfo_name
        self.stamp_poll()
        return self.state, {"vfo": vfo_name, "freq_hz": int(freq_hz)}

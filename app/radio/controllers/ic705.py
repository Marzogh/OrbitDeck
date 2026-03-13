from __future__ import annotations

from app.models import FrequencyRecommendation, RadioRigModel
from app.radio.civ import ACK, NAK, bcd_to_freq, parse_frame
from app.radio.controllers.base import BaseIcomController


class Ic705Controller(BaseIcomController):
    model = RadioRigModel.ic705

    C_RD_SPLIT = 0x0F
    C_SEL_FREQ = 0x25
    C_SET_VFO = 0x07
    S_VFOA = 0x00
    S_VFOB = 0x01

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
        vfo_a_hz = self._read_vfo_freq(selected=True)
        vfo_b_hz = self._read_vfo_freq(selected=False)
        split_enabled = self._read_split_enabled()
        self.state.raw_state["split_enabled"] = split_enabled
        self.state.raw_state["tx_vfo"] = "A" if split_enabled else "A"
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
        self.state.targets.update(
            {
                "vfo_a_freq_hz": vfo_a_hz,
                "vfo_b_freq_hz": vfo_b_hz,
                "vfo_a_mode": recommendation.uplink_mode or "",
                "vfo_b_mode": recommendation.downlink_mode or "",
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
        self.stamp_poll()
        return self.state, {"tx": "A", "rx": "B", "vfo_a_freq_hz": vfo_a_hz, "vfo_b_freq_hz": vfo_b_hz}

from __future__ import annotations

from app.models import FrequencyRecommendation, RadioRigModel
from app.radio.controllers.base import BaseIcomController


class Id5100Controller(BaseIcomController):
    model = RadioRigModel.id5100

    def poll_state(self):
        self.state.raw_state.setdefault("dual_watch", False)
        self.state.raw_state.setdefault("split_enabled", False)
        self.state.targets.setdefault("main_label", "Main (TX)")
        self.state.targets.setdefault("sub_label", "Sub (RX)")
        self.stamp_poll()
        return self.state

    def apply_target(self, recommendation: FrequencyRecommendation, apply_mode_and_tone: bool):
        if recommendation.uplink_mhz is None or recommendation.downlink_mhz is None:
            raise ValueError("recommendation must include uplink and downlink")
        main_hz = int(round(recommendation.uplink_mhz * 1_000_000))
        sub_hz = int(round(recommendation.downlink_mhz * 1_000_000))
        self.state.targets.update(
            {
                "main_freq_hz": main_hz,
                "sub_freq_hz": sub_hz,
                "main_mode": recommendation.uplink_mode or "",
                "sub_mode": recommendation.downlink_mode or "",
            }
        )
        self.state.raw_state.update({"dual_watch": True, "split_enabled": True})
        self.stamp_poll()
        return self.state, {"tx": "MAIN", "rx": "SUB", "main_freq_hz": main_hz, "sub_freq_hz": sub_hz}

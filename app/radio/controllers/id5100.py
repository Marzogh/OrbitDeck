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
        if recommendation.uplink_mhz is None and recommendation.downlink_mhz is None:
            raise ValueError("recommendation must include at least one radio frequency")
        current_main_hz = int(self.state.targets.get("main_freq_hz") or 0)
        current_sub_hz = int(self.state.targets.get("sub_freq_hz") or 0)
        current_main_mode = str(self.state.targets.get("main_mode") or "")
        current_sub_mode = str(self.state.targets.get("sub_mode") or "")
        main_hz = int(round(recommendation.uplink_mhz * 1_000_000)) if recommendation.uplink_mhz is not None else current_main_hz
        sub_hz = int(round(recommendation.downlink_mhz * 1_000_000)) if recommendation.downlink_mhz is not None else current_sub_hz
        receive_only = recommendation.uplink_mhz is None and recommendation.downlink_mhz is not None
        self.state.targets.update(
            {
                "main_freq_hz": main_hz,
                "sub_freq_hz": sub_hz,
                "main_mode": recommendation.uplink_mode or current_main_mode,
                "sub_mode": recommendation.downlink_mode or current_sub_mode,
            }
        )
        self.state.raw_state.update(
            {
                "dual_watch": bool(recommendation.uplink_mhz is not None and recommendation.downlink_mhz is not None),
                "split_enabled": bool(recommendation.uplink_mhz is not None and recommendation.downlink_mhz is not None),
                "receive_only": receive_only,
            }
        )
        self.stamp_poll()
        return self.state, {
            "tx": "MAIN" if recommendation.uplink_mhz is not None else None,
            "rx": "SUB" if recommendation.downlink_mhz is not None else None,
            "main_freq_hz": main_hz,
            "sub_freq_hz": sub_hz,
            "receive_only": receive_only,
        }

    def set_frequency(self, vfo: str, freq_hz: int):
        vfo_name = str(vfo or "").strip().upper()
        if vfo_name not in {"MAIN", "SUB"}:
            raise ValueError("ID-5100 frequency writes require vfo MAIN or SUB")
        key = "main_freq_hz" if vfo_name == "MAIN" else "sub_freq_hz"
        self.state.targets[key] = int(freq_hz)
        self.stamp_poll()
        return self.state, {"vfo": vfo_name, "freq_hz": int(freq_hz)}

    def snapshot_state(self) -> dict[str, object]:
        self.poll_state()
        return {
            "main_freq_hz": self.state.targets.get("main_freq_hz"),
            "sub_freq_hz": self.state.targets.get("sub_freq_hz"),
            "main_mode": self.state.targets.get("main_mode", ""),
            "sub_mode": self.state.targets.get("sub_mode", ""),
            "dual_watch": self.state.raw_state.get("dual_watch", False),
            "split_enabled": self.state.raw_state.get("split_enabled", False),
        }

    def restore_snapshot(self, snapshot: dict[str, object]):
        self.state.targets.update(
            {
                "main_freq_hz": snapshot.get("main_freq_hz"),
                "sub_freq_hz": snapshot.get("sub_freq_hz"),
                "main_mode": snapshot.get("main_mode", ""),
                "sub_mode": snapshot.get("sub_mode", ""),
            }
        )
        self.state.raw_state.update(
            {
                "dual_watch": bool(snapshot.get("dual_watch", False)),
                "split_enabled": bool(snapshot.get("split_enabled", False)),
            }
        )
        self.stamp_poll()
        return self.state

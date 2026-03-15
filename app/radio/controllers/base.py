from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import UTC, datetime

from app.models import FrequencyRecommendation, RadioRigModel
from app.radio.models import ControllerState
from app.radio.transport import CivTransport


class BaseIcomController(ABC):
    model: RadioRigModel

    def __init__(self, transport: CivTransport, civ_address: int) -> None:
        self.transport = transport
        self.civ_address = civ_address
        self.state = ControllerState()

    def connect(self) -> ControllerState:
        self.transport.open()
        self.state.connected = True
        self.state.last_error = None
        self.poll_state()
        return self.state

    def disconnect(self) -> ControllerState:
        self.transport.close()
        self.state.connected = False
        return self.state

    @abstractmethod
    def poll_state(self) -> ControllerState: ...

    @abstractmethod
    def apply_target(self, recommendation: FrequencyRecommendation, apply_mode_and_tone: bool) -> tuple[ControllerState, dict[str, object]]: ...

    @abstractmethod
    def set_frequency(self, vfo: str, freq_hz: int) -> tuple[ControllerState, dict[str, object]]: ...

    def snapshot_state(self) -> dict[str, object]:
        return {
            "targets": dict(self.state.targets),
            "raw_state": dict(self.state.raw_state),
        }

    def restore_snapshot(self, snapshot: dict[str, object]) -> ControllerState:
        self.state.targets = dict(snapshot.get("targets", {}))
        self.state.raw_state = dict(snapshot.get("raw_state", {}))
        self.stamp_poll()
        return self.state

    def supports_auto_track(self) -> bool:
        return True

    def stamp_poll(self) -> None:
        self.state.last_poll_at = datetime.now(UTC)

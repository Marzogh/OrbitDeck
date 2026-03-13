from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from threading import RLock
from typing import Any

from app.models import RadioControlMode, RadioRigModel


@dataclass
class ControllerState:
    connected: bool = False
    targets: dict[str, float | str | bool | None] = field(default_factory=dict)
    raw_state: dict[str, Any] = field(default_factory=dict)
    last_error: str | None = None
    last_poll_at: datetime | None = None


class RadioSession:
    def __init__(self, rig_model: RadioRigModel, serial_device: str) -> None:
        self.rig_model = rig_model
        self.serial_device = serial_device
        self.control_mode = RadioControlMode.idle
        self.lock = RLock()

from __future__ import annotations

import json
from pathlib import Path
from threading import Lock

from app.models import PersistedState
from app.runtime_paths import data_path


class StateStore:
    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path is not None else data_path("state.json")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self._state = self._load()

    def _load(self) -> PersistedState:
        if not self.path.exists():
            state = PersistedState()
            self._write(state)
            return state
        with self.path.open("r", encoding="utf-8") as f:
            raw = json.load(f)
        return PersistedState.model_validate(raw)

    def _write(self, state: PersistedState) -> None:
        with self.path.open("w", encoding="utf-8") as f:
            json.dump(state.model_dump(mode="json"), f, indent=2)

    def get(self) -> PersistedState:
        with self._lock:
            return PersistedState.model_validate(self._state.model_dump(mode="python"))

    def save(self, state: PersistedState) -> PersistedState:
        with self._lock:
            self._state = state
            self._write(state)
            return PersistedState.model_validate(state.model_dump(mode="python"))

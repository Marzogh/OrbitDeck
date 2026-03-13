from __future__ import annotations

from datetime import UTC, datetime
from threading import Event, Thread
from typing import Callable

from app.models import (
    FrequencyRecommendation,
    LocationSourceMode,
    PassEvent,
    RadioApplyRequest,
    RadioControlMode,
    RadioRigModel,
    RadioRuntimeState,
    RadioSettings,
)
from app.radio.civ import parse_civ_address
from app.radio.controllers.base import BaseIcomController
from app.radio.controllers.ic705 import Ic705Controller
from app.radio.controllers.id5100 import Id5100Controller
from app.radio.transport import SerialTransport


ControllerFactory = Callable[[RadioSettings], BaseIcomController]
RecommendationResolver = Callable[[str, LocationSourceMode | None, int | None], tuple[FrequencyRecommendation | None, PassEvent | None]]


class RigControlService:
    def __init__(self, controller_factory: ControllerFactory | None = None) -> None:
        self._controller_factory = controller_factory or self._default_controller_factory
        self._controller: BaseIcomController | None = None
        self._runtime = RadioRuntimeState()
        self._worker: Thread | None = None
        self._stop_event = Event()
        self._current_settings: RadioSettings | None = None
        self._auto_track_payload: RadioApplyRequest | None = None
        self._resolver: RecommendationResolver | None = None

    def _default_controller_factory(self, settings: RadioSettings) -> BaseIcomController:
        transport = SerialTransport(settings.serial_device, settings.baud_rate, timeout=max(0.2, settings.poll_interval_ms / 1000))
        civ_address = parse_civ_address(settings.civ_address)
        if settings.rig_model == RadioRigModel.ic705:
            return Ic705Controller(transport, civ_address)
        return Id5100Controller(transport, civ_address)

    def runtime(self) -> RadioRuntimeState:
        return RadioRuntimeState.model_validate(self._runtime.model_dump(mode="python"))

    def reset_runtime(self) -> None:
        self.stop_auto_track()
        self._controller = None
        self._runtime = RadioRuntimeState()
        self._current_settings = None
        self._resolver = None
        self._auto_track_payload = None

    def connect(self, settings: RadioSettings) -> RadioRuntimeState:
        self.stop_auto_track()
        self._current_settings = settings.model_copy(deep=True)
        self._controller = self._controller_factory(settings)
        try:
            state = self._controller.connect()
        except Exception as exc:
            self._runtime = RadioRuntimeState(
                connected=False,
                control_mode=RadioControlMode.idle,
                rig_model=settings.rig_model,
                serial_device=settings.serial_device,
                last_error=str(exc),
            )
            return self.runtime()
        self._runtime = RadioRuntimeState(
            connected=state.connected,
            control_mode=RadioControlMode.idle,
            rig_model=settings.rig_model,
            serial_device=settings.serial_device,
            last_error=state.last_error,
            last_poll_at=state.last_poll_at,
            targets=dict(state.targets),
            raw_state=dict(state.raw_state),
        )
        return self.runtime()

    def disconnect(self) -> RadioRuntimeState:
        self.stop_auto_track()
        if self._controller is not None:
            with_exception = None
            try:
                self._controller.disconnect()
            except Exception as exc:
                with_exception = str(exc)
            self._controller = None
            self._runtime.connected = False
            self._runtime.control_mode = RadioControlMode.idle
            self._runtime.last_error = with_exception
        self._resolver = None
        self._auto_track_payload = None
        return self.runtime()

    def poll(self, settings: RadioSettings | None = None) -> RadioRuntimeState:
        if self._controller is None:
            if settings is None:
                return self.runtime()
            return self.connect(settings)
        try:
            state = self._controller.poll_state()
            self._runtime.connected = state.connected
            self._runtime.last_error = state.last_error
            self._runtime.last_poll_at = state.last_poll_at
            self._runtime.targets = dict(state.targets)
            self._runtime.raw_state = dict(state.raw_state)
        except Exception as exc:
            self._runtime.last_error = str(exc)
            self._runtime.connected = False
            self._runtime.control_mode = RadioControlMode.idle
        return self.runtime()

    def apply(self, payload: RadioApplyRequest, settings: RadioSettings, resolver: RecommendationResolver) -> tuple[RadioRuntimeState, FrequencyRecommendation, dict[str, object]]:
        if not self._runtime.connected or self._controller is None:
            raise RuntimeError("radio is not connected")
        recommendation, pass_event = resolver(payload.sat_id, payload.location_source, payload.selected_column_index)
        if recommendation is None or recommendation.uplink_mhz is None or recommendation.downlink_mhz is None:
            raise ValueError("recommendation is unavailable for the selected target")
        state, mapping = self._controller.apply_target(
            recommendation,
            settings.default_apply_mode_and_tone if payload.apply_mode_and_tone is None else payload.apply_mode_and_tone,
        )
        self._runtime.connected = state.connected
        self._runtime.control_mode = RadioControlMode.manual_applied
        self._runtime.rig_model = settings.rig_model
        self._runtime.serial_device = settings.serial_device
        self._runtime.last_error = state.last_error
        self._runtime.last_poll_at = state.last_poll_at
        self._runtime.active_sat_id = payload.sat_id
        self._runtime.active_pass_aos = payload.pass_aos or (pass_event.aos if pass_event else None)
        self._runtime.active_pass_los = payload.pass_los or (pass_event.los if pass_event else None)
        self._runtime.selected_column_index = recommendation.selected_column_index
        self._runtime.last_applied_recommendation = recommendation
        self._runtime.targets = dict(state.targets)
        self._runtime.raw_state = dict(state.raw_state)
        return self.runtime(), recommendation, mapping

    def start_auto_track(self, payload: RadioApplyRequest, settings: RadioSettings, resolver: RecommendationResolver, interval_ms: int | None = None) -> RadioRuntimeState:
        runtime, _, _ = self.apply(payload, settings, resolver)
        self.stop_auto_track()
        self._resolver = resolver
        self._auto_track_payload = payload
        self._stop_event.clear()
        interval = max(0.2, (interval_ms or settings.auto_track_interval_ms) / 1000)
        self._runtime.control_mode = RadioControlMode.auto_tracking

        def runner() -> None:
            while not self._stop_event.wait(interval):
                if self._runtime.active_pass_los and datetime.now(UTC) > self._runtime.active_pass_los:
                    self._runtime.control_mode = RadioControlMode.idle
                    break
                try:
                    if self._auto_track_payload is None or self._resolver is None or self._current_settings is None:
                        break
                    self.apply(self._auto_track_payload, self._current_settings, self._resolver)
                    self._runtime.control_mode = RadioControlMode.auto_tracking
                except Exception as exc:
                    self._runtime.last_error = str(exc)
                    self._runtime.control_mode = RadioControlMode.idle
                    break

        self._worker = Thread(target=runner, daemon=True)
        self._worker.start()
        return runtime

    def stop_auto_track(self) -> RadioRuntimeState:
        self._stop_event.set()
        worker = self._worker
        if worker and worker.is_alive():
            worker.join(timeout=0.2)
        self._worker = None
        if self._runtime.control_mode == RadioControlMode.auto_tracking:
            self._runtime.control_mode = RadioControlMode.idle
        return self.runtime()

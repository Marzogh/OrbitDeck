from __future__ import annotations

from datetime import UTC, datetime
from threading import Event, Thread
from typing import Callable

from app.models import (
    CorrectionSide,
    FrequencyRecommendation,
    FrequencyGuideMode,
    GuidePassPhase,
    LocationSourceMode,
    PassEvent,
    RadioApplyRequest,
    RadioControlMode,
    RadioControlScreenState,
    RadioControlSessionSelectRequest,
    RadioControlSessionState,
    RadioControlSessionTestPairUpdateRequest,
    RadioFrequencySetRequest,
    RadioPairSetRequest,
    RadioRigModel,
    RadioRuntimeState,
    RadioSessionControlState,
    RadioSettings,
    RadioTransportMode,
    DopplerDirection,
)
from app.radio.civ import parse_civ_address
from app.radio.controllers.base import BaseIcomController
from app.radio.controllers.ic705 import Ic705Controller
from app.radio.controllers.id5100 import Id5100Controller
from app.radio.icom_udp import IcomUdpTransport
from app.radio.transport import SerialTransport


ControllerFactory = Callable[[RadioSettings], BaseIcomController]
RecommendationResolver = Callable[[str, LocationSourceMode | None, int | None], tuple[FrequencyRecommendation | None, PassEvent | None]]
DefaultPairResolver = Callable[[RadioControlSessionSelectRequest], FrequencyRecommendation | None]


class RigControlService:
    TX_RANGES_MHZ = (
        (144.0, 148.0),
        (420.0, 450.0),
    )
    RX_RANGES_MHZ: dict[RadioRigModel, tuple[tuple[float, float], ...]] = {
        RadioRigModel.ic705: (
            (0.030, 199.999),
            (400.0, 470.0),
        ),
        RadioRigModel.id5100: (
            (118.0, 174.0),
            (375.0, 550.0),
        ),
    }

    def __init__(self, controller_factory: ControllerFactory | None = None) -> None:
        self._controller_factory = controller_factory or self._default_controller_factory
        self._controller: BaseIcomController | None = None
        self._runtime = RadioRuntimeState()
        self._worker: Thread | None = None
        self._stop_event = Event()
        self._current_settings: RadioSettings | None = None
        self._auto_track_payload: RadioApplyRequest | None = None
        self._resolver: RecommendationResolver | None = None
        self._session = RadioControlSessionState()
        self._restore_snapshot: dict[str, object] | None = None

    def _default_controller_factory(self, settings: RadioSettings) -> BaseIcomController:
        timeout = max(0.2, settings.poll_interval_ms / 1000)
        if settings.transport_mode == RadioTransportMode.wifi:
            if settings.rig_model != RadioRigModel.ic705:
                raise ValueError("Wi-Fi transport is currently supported only for the IC-705")
            if not settings.wifi_host.strip():
                raise ValueError("Wi-Fi host is required for IC-705 Wi-Fi transport")
            if not settings.wifi_username.strip():
                raise ValueError("Wi-Fi username is required for IC-705 Wi-Fi transport")
            transport = IcomUdpTransport(
                host=settings.wifi_host.strip(),
                control_port=settings.wifi_control_port,
                username=settings.wifi_username.strip(),
                password=settings.wifi_password,
                timeout=timeout,
            )
        else:
            transport = SerialTransport(settings.serial_device, settings.baud_rate, timeout=timeout)
        civ_address = parse_civ_address(settings.civ_address)
        if settings.rig_model == RadioRigModel.ic705:
            return Ic705Controller(transport, civ_address)
        return Id5100Controller(transport, civ_address)

    @classmethod
    def _freq_supported_for_transmit(cls, freq_mhz: float | None) -> bool:
        if freq_mhz is None:
            return False
        return any(lo <= freq_mhz <= hi for lo, hi in cls.TX_RANGES_MHZ)

    @classmethod
    def _freq_supported_for_receive(cls, freq_mhz: float | None, rig_model: RadioRigModel) -> bool:
        if freq_mhz is None:
            return False
        return any(lo <= freq_mhz <= hi for lo, hi in cls.RX_RANGES_MHZ.get(rig_model, ()))

    def _effective_rig_model(self, settings: RadioSettings | None = None) -> RadioRigModel:
        return self._runtime.rig_model or (settings.rig_model if settings is not None else None) or RadioRigModel.id5100

    @staticmethod
    def _same_recommendation(a: FrequencyRecommendation | None, b: FrequencyRecommendation | None) -> bool:
        if a is None or b is None:
            return False
        return (
            a.sat_id == b.sat_id
            and a.selected_column_index == b.selected_column_index
            and a.uplink_mhz == b.uplink_mhz
            and a.downlink_mhz == b.downlink_mhz
            and a.uplink_mode == b.uplink_mode
            and a.downlink_mode == b.downlink_mode
        )

    def _recommendation_supported(
        self,
        recommendation: FrequencyRecommendation | None,
        settings: RadioSettings | None = None,
    ) -> tuple[bool, str | None]:
        if recommendation is None:
            return False, "No usable radio frequency is defined for this satellite"
        rig_model = self._effective_rig_model(settings)
        has_uplink = recommendation.uplink_mhz is not None
        has_downlink = recommendation.downlink_mhz is not None
        uplink_ok = self._freq_supported_for_transmit(recommendation.uplink_mhz)
        downlink_ok = self._freq_supported_for_receive(recommendation.downlink_mhz, rig_model)
        if has_uplink and has_downlink and uplink_ok and downlink_ok:
            return True, None
        if has_downlink and not has_uplink and downlink_ok:
            return True, None
        if has_uplink and not has_downlink and uplink_ok:
            return True, None
        if not has_uplink and not has_downlink:
            return False, "No usable radio frequency is defined for this satellite"
        if has_uplink and not uplink_ok and not has_downlink:
            return False, f"Uplink {recommendation.uplink_mhz:.3f} MHz is outside the allowed amateur transmit ranges"
        if has_downlink and not downlink_ok and not has_uplink:
            return False, f"Downlink {recommendation.downlink_mhz:.3f} MHz is outside {rig_model.value.upper()} receive coverage"
        if has_uplink and has_downlink and not uplink_ok and downlink_ok:
            return False, f"Uplink {recommendation.uplink_mhz:.3f} MHz is outside the allowed amateur transmit ranges"
        if has_uplink and has_downlink and uplink_ok and not downlink_ok:
            return False, f"Downlink {recommendation.downlink_mhz:.3f} MHz is outside {rig_model.value.upper()} receive coverage"
        return (
            False,
            f"Uplink {recommendation.uplink_mhz:.3f} MHz is outside the allowed amateur transmit ranges and downlink {recommendation.downlink_mhz:.3f} MHz is outside {rig_model.value.upper()} receive coverage",
        )

    def runtime(self) -> RadioRuntimeState:
        return RadioRuntimeState.model_validate(self._runtime.model_dump(mode="python"))

    def session_state(self) -> RadioControlSessionState:
        self._refresh_session_status()
        return RadioControlSessionState.model_validate(self._session.model_dump(mode="python"))

    def _refresh_session_status(self) -> None:
        if not self._session.active and self._session.screen_state != RadioControlScreenState.completed:
            return
        now = datetime.now(UTC)
        if self._session.selected_pass_los and now > self._session.selected_pass_los:
            if self._session.active:
                self.stop_auto_track()
            self._restore_previous_radio_state()
            self._runtime.control_mode = RadioControlMode.idle
            self._session.active = False
            self._session.screen_state = RadioControlScreenState.completed
            self._session.control_state = RadioSessionControlState.ended
            self._runtime.active_sat_id = None
            self._runtime.active_pass_aos = None
            self._runtime.active_pass_los = None
            self._runtime.selected_column_index = None
            return
        if not self._runtime.connected:
            self._session.control_state = RadioSessionControlState.not_connected
            return
        if self._session.screen_state == RadioControlScreenState.test:
            self._session.control_state = RadioSessionControlState.test_applied
        elif self._session.screen_state == RadioControlScreenState.armed:
            self._session.control_state = RadioSessionControlState.armed_waiting_aos
        elif self._session.screen_state == RadioControlScreenState.active:
            self._session.control_state = RadioSessionControlState.tracking_active
        elif self._session.screen_state == RadioControlScreenState.released:
            self._session.control_state = RadioSessionControlState.released
        else:
            self._session.control_state = RadioSessionControlState.connected_idle

    def _reset_session(self) -> None:
        self._session = RadioControlSessionState()
        self._restore_snapshot = None

    def _capture_restore_snapshot(self) -> None:
        if self._restore_snapshot is not None or self._controller is None or not self._runtime.connected:
            return
        self._restore_snapshot = self._controller.snapshot_state()

    def _restore_previous_radio_state(self) -> None:
        if self._restore_snapshot is None or self._controller is None or not self._runtime.connected:
            return
        try:
            state = self._controller.restore_snapshot(self._restore_snapshot)
        except Exception as exc:
            self._runtime.last_error = f"Radio control released, but restore failed: {exc}"
            self._restore_snapshot = None
            return
        self._runtime.connected = state.connected
        self._runtime.last_error = state.last_error
        self._runtime.last_poll_at = state.last_poll_at
        self._runtime.targets = dict(state.targets)
        self._runtime.raw_state = dict(state.raw_state)
        self._restore_snapshot = None

    def reset_runtime(self) -> None:
        self.stop_auto_track()
        self._controller = None
        self._runtime = RadioRuntimeState()
        self._current_settings = None
        self._resolver = None
        self._auto_track_payload = None
        self._restore_snapshot = None
        self._reset_session()

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
                transport_mode=settings.transport_mode,
                serial_device=settings.serial_device,
                endpoint=self._runtime_endpoint(settings),
                last_error=str(exc),
            )
            return self.runtime()
        self._runtime = RadioRuntimeState(
            connected=state.connected,
            control_mode=RadioControlMode.idle,
            rig_model=settings.rig_model,
            transport_mode=settings.transport_mode,
            serial_device=settings.serial_device,
            endpoint=self._runtime_endpoint(settings),
            last_error=state.last_error,
            last_poll_at=state.last_poll_at,
            targets=dict(state.targets),
            raw_state=dict(state.raw_state),
        )
        if self._session.active:
            self._session.control_state = RadioSessionControlState.connected_idle
        return self.runtime()

    def disconnect(self) -> RadioRuntimeState:
        self.stop_auto_track()
        self._restore_previous_radio_state()
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
        self._restore_snapshot = None
        if self._session.active:
            self._session.control_state = RadioSessionControlState.not_connected
        return self.runtime()

    @staticmethod
    def _runtime_endpoint(settings: RadioSettings) -> str | None:
        if settings.transport_mode == RadioTransportMode.wifi:
            host = settings.wifi_host.strip()
            return f"{host}:{settings.wifi_control_port}" if host else None
        device = settings.serial_device.strip()
        return device or None

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
            if self._session.active:
                self._session.control_state = RadioSessionControlState.not_connected
        self._refresh_session_status()
        return self.runtime()

    def select_session(
        self,
        payload: RadioControlSessionSelectRequest,
        default_pair_resolver: DefaultPairResolver,
        settings: RadioSettings | None = None,
    ) -> RadioControlSessionState:
        recommendation = default_pair_resolver(payload)
        is_eligible, eligibility_reason = self._recommendation_supported(recommendation, settings)
        self._session = RadioControlSessionState(
            active=True,
            selected_sat_id=payload.sat_id,
            selected_sat_name=payload.sat_name or payload.sat_id,
            selected_pass_aos=payload.pass_aos,
            selected_pass_los=payload.pass_los,
            selected_max_el_deg=payload.max_el_deg,
            screen_state=RadioControlScreenState.idle,
            control_state=RadioSessionControlState.connected_idle if self._runtime.connected else RadioSessionControlState.not_connected,
            return_to_rotator_on_end=True,
            is_eligible=is_eligible,
            eligibility_reason=eligibility_reason,
            has_test_pair=is_eligible,
            test_pair_reason=eligibility_reason,
            test_pair=recommendation if is_eligible else None,
        )
        self._refresh_session_status()
        return self.session_state()

    def clear_session(self) -> RadioControlSessionState:
        self.stop_auto_track()
        self._restore_previous_radio_state()
        self._reset_session()
        return self.session_state()

    def set_session_test_pair(
        self,
        payload: RadioControlSessionTestPairUpdateRequest,
        settings: RadioSettings | None = None,
    ) -> RadioControlSessionState:
        self._refresh_session_status()
        if not self._session.active or not self._session.selected_sat_id:
            raise RuntimeError("radio control session is not selected")
        recommendation = FrequencyRecommendation(
            sat_id=self._session.selected_sat_id,
            mode=FrequencyGuideMode.fm,
            phase=GuidePassPhase.aos,
            label=payload.label or "Operator-selected channel",
            is_upcoming=True,
            is_ongoing=False,
            correction_side=(
                CorrectionSide.full_duplex
                if payload.uplink_hz and payload.downlink_hz
                else CorrectionSide.downlink_only
            ),
            doppler_direction=DopplerDirection.high_to_low,
            uplink_mhz=(payload.uplink_hz / 1_000_000) if payload.uplink_hz else None,
            downlink_mhz=(payload.downlink_hz / 1_000_000) if payload.downlink_hz else None,
            uplink_mode=(payload.uplink_mode or "FM").upper() if payload.uplink_hz else None,
            downlink_mode=(payload.downlink_mode or "FM").upper() if payload.downlink_hz else None,
        )
        is_eligible, reason = self._recommendation_supported(recommendation, settings)
        self._session.is_eligible = is_eligible
        self._session.eligibility_reason = reason
        self._session.has_test_pair = is_eligible
        self._session.test_pair = recommendation if is_eligible else None
        self._session.test_pair_reason = (
            f"Operator-selected channel ready: {recommendation.label}"
            if is_eligible
            else reason
        )
        self._refresh_session_status()
        return self.session_state()

    def run_test_control(self, settings: RadioSettings) -> tuple[RadioControlSessionState, RadioRuntimeState, FrequencyRecommendation, dict[str, object]]:
        self._refresh_session_status()
        if not self._session.active or not self._session.selected_sat_id:
            raise RuntimeError("radio control session is not selected")
        if not self._runtime.connected:
            raise RuntimeError("radio is not connected")
        if not self._session.is_eligible:
            raise ValueError(self._session.eligibility_reason or "Selected satellite is not eligible for VHF/UHF radio control")
        recommendation = self._session.test_pair
        if recommendation is None or (recommendation.uplink_mhz is None and recommendation.downlink_mhz is None):
            raise ValueError(self._session.test_pair_reason or "No usable supported radio frequency for this satellite")
        self._capture_restore_snapshot()
        state, mapping = self._controller.apply_target(recommendation, settings.default_apply_mode_and_tone)  # type: ignore[union-attr]
        self._runtime.connected = state.connected
        self._runtime.control_mode = RadioControlMode.manual_applied
        self._runtime.rig_model = settings.rig_model
        self._runtime.serial_device = settings.serial_device
        self._runtime.last_error = state.last_error
        self._runtime.last_poll_at = state.last_poll_at
        self._runtime.active_sat_id = self._session.selected_sat_id
        self._runtime.active_pass_aos = self._session.selected_pass_aos
        self._runtime.active_pass_los = self._session.selected_pass_los
        self._runtime.last_applied_recommendation = recommendation
        self._runtime.targets = dict(state.targets)
        self._runtime.raw_state = dict(state.raw_state)
        self._session.screen_state = RadioControlScreenState.test
        self._session.control_state = RadioSessionControlState.test_applied
        return self.session_state(), self.runtime(), recommendation, mapping

    def confirm_test_success(self) -> tuple[RadioControlSessionState, RadioRuntimeState]:
        self.stop_auto_track()
        self._restore_previous_radio_state()
        self._runtime.control_mode = RadioControlMode.idle
        self._runtime.active_sat_id = None
        self._runtime.active_pass_aos = None
        self._runtime.active_pass_los = None
        self._runtime.selected_column_index = None
        if self._session.active:
            self._session.screen_state = RadioControlScreenState.released
            self._session.control_state = (
                RadioSessionControlState.released if self._runtime.connected else RadioSessionControlState.not_connected
            )
        return self.session_state(), self.runtime()

    def stop_session_control(self) -> tuple[RadioControlSessionState, RadioRuntimeState]:
        self.stop_auto_track()
        self._restore_previous_radio_state()
        self._runtime.control_mode = RadioControlMode.idle
        self._runtime.active_sat_id = None
        self._runtime.active_pass_aos = None
        self._runtime.active_pass_los = None
        self._runtime.selected_column_index = None
        if self._session.active:
            self._session.screen_state = RadioControlScreenState.released
            self._session.control_state = (
                RadioSessionControlState.released if self._runtime.connected else RadioSessionControlState.not_connected
            )
        return self.session_state(), self.runtime()

    def _session_payload(self) -> RadioApplyRequest:
        if not self._session.selected_sat_id:
            raise RuntimeError("radio control session is not selected")
        return RadioApplyRequest(
            sat_id=self._session.selected_sat_id,
            pass_aos=self._session.selected_pass_aos,
            pass_los=self._session.selected_pass_los,
        )

    def _apply_session_tracking_once(self, settings: RadioSettings, resolver: RecommendationResolver) -> None:
        payload = self._session_payload()
        runtime, recommendation, _ = self.apply(payload, settings, resolver)
        is_supported, reason = self._recommendation_supported(recommendation, settings)
        if not is_supported:
            raise ValueError(reason or "Selected recommendation is outside supported VHF/UHF range")
        self._runtime = runtime
        self._runtime.control_mode = RadioControlMode.auto_tracking
        self._session.screen_state = RadioControlScreenState.active
        self._session.control_state = RadioSessionControlState.tracking_active
        self._session.test_pair = self._session.test_pair or recommendation

    def start_session_control(self, settings: RadioSettings, resolver: RecommendationResolver) -> tuple[RadioControlSessionState, RadioRuntimeState]:
        self._refresh_session_status()
        if not self._session.active or not self._session.selected_sat_id:
            raise RuntimeError("radio control session is not selected")
        if not self._runtime.connected or self._controller is None:
            raise RuntimeError("radio is not connected")
        if not self._session.is_eligible:
            raise ValueError(self._session.eligibility_reason or "Selected satellite is not eligible for VHF/UHF radio control")
        if self._session.selected_pass_los and datetime.now(UTC) > self._session.selected_pass_los:
            self._refresh_session_status()
            return self.session_state(), self.runtime()
        self.stop_auto_track()
        self._current_settings = settings.model_copy(deep=True)
        self._resolver = resolver
        self._auto_track_payload = self._session_payload()
        now = datetime.now(UTC)
        if self._session.selected_pass_aos and now < self._session.selected_pass_aos:
            self._session.screen_state = RadioControlScreenState.armed
            self._session.control_state = RadioSessionControlState.armed_waiting_aos
        else:
            self._capture_restore_snapshot()
            self._apply_session_tracking_once(settings, resolver)
        self._stop_event.clear()
        interval = max(0.2, settings.auto_track_interval_ms / 1000)

        def runner() -> None:
            while not self._stop_event.wait(interval):
                if not self._session.active or self._current_settings is None or self._resolver is None:
                    break
                now = datetime.now(UTC)
                if self._session.selected_pass_los and now > self._session.selected_pass_los:
                    self._restore_previous_radio_state()
                    self._runtime.control_mode = RadioControlMode.idle
                    self._refresh_session_status()
                    break
                if self._session.selected_pass_aos and now < self._session.selected_pass_aos:
                    self._session.screen_state = RadioControlScreenState.armed
                    self._session.control_state = RadioSessionControlState.armed_waiting_aos
                    continue
                try:
                    self._capture_restore_snapshot()
                    self._apply_session_tracking_once(self._current_settings, self._resolver)
                except Exception as exc:
                    self._runtime.last_error = str(exc)
                    self._runtime.control_mode = RadioControlMode.idle
                    self._restore_previous_radio_state()
                    self._session.screen_state = RadioControlScreenState.released
                    self._session.control_state = RadioSessionControlState.released
                    break

        self._worker = Thread(target=runner, daemon=True)
        self._worker.start()
        return self.session_state(), self.runtime()

    def apply(self, payload: RadioApplyRequest, settings: RadioSettings, resolver: RecommendationResolver) -> tuple[RadioRuntimeState, FrequencyRecommendation, dict[str, object]]:
        if not self._runtime.connected or self._controller is None:
            raise RuntimeError("radio is not connected")
        recommendation, pass_event = resolver(payload.sat_id, payload.location_source, payload.selected_column_index)
        if recommendation is None or (recommendation.uplink_mhz is None and recommendation.downlink_mhz is None):
            raise ValueError("recommendation is unavailable for the selected target")
        if self._same_recommendation(self._runtime.last_applied_recommendation, recommendation):
            self._runtime.active_sat_id = payload.sat_id
            self._runtime.active_pass_aos = payload.pass_aos or (pass_event.aos if pass_event else None)
            self._runtime.active_pass_los = payload.pass_los or (pass_event.los if pass_event else None)
            self._runtime.selected_column_index = recommendation.selected_column_index
            self._runtime.last_applied_recommendation = recommendation
            return self.runtime(), recommendation, {}
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

    def set_frequency(self, payload: RadioFrequencySetRequest, settings: RadioSettings) -> tuple[RadioRuntimeState, dict[str, object]]:
        if not self._runtime.connected or self._controller is None:
            raise RuntimeError("radio is not connected")
        state, result = self._controller.set_frequency(payload.vfo, payload.freq_hz)
        self._runtime.connected = state.connected
        self._runtime.rig_model = settings.rig_model
        self._runtime.serial_device = settings.serial_device
        self._runtime.last_error = state.last_error
        self._runtime.last_poll_at = state.last_poll_at
        self._runtime.targets = dict(state.targets)
        self._runtime.raw_state = dict(state.raw_state)
        return self.runtime(), result

    def apply_manual_pair(self, payload: RadioPairSetRequest, settings: RadioSettings) -> tuple[RadioRuntimeState, FrequencyRecommendation, dict[str, object]]:
        if not self._runtime.connected or self._controller is None:
            raise RuntimeError("radio is not connected")
        if payload.uplink_hz is None and payload.downlink_hz is None:
            raise ValueError("Manual pair must include at least one radio frequency")
        recommendation = FrequencyRecommendation(
            sat_id="manual-pair",
            mode=FrequencyGuideMode.fm,
            phase=GuidePassPhase.mid,
            label="Manual pair",
            is_upcoming=False,
            is_ongoing=True,
            correction_side=(
                CorrectionSide.full_duplex
                if payload.uplink_hz is not None and payload.downlink_hz is not None
                else CorrectionSide.downlink_only
            ),
            doppler_direction=DopplerDirection.high_to_low,
            uplink_mhz=(payload.uplink_hz / 1_000_000) if payload.uplink_hz is not None else None,
            downlink_mhz=(payload.downlink_hz / 1_000_000) if payload.downlink_hz is not None else None,
            uplink_label="Uplink",
            downlink_label="Downlink",
            uplink_mode=(payload.uplink_mode or "FM").upper() if payload.uplink_hz is not None else None,
            downlink_mode=(payload.downlink_mode or "FM").upper() if payload.downlink_hz is not None else None,
        )
        is_supported, reason = self._recommendation_supported(recommendation, settings)
        if not is_supported:
            raise ValueError(reason or "Manual pair is outside supported VHF/UHF range")
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
        self._runtime.active_sat_id = recommendation.sat_id
        self._runtime.last_applied_recommendation = recommendation
        self._runtime.targets = dict(state.targets)
        self._runtime.raw_state = dict(state.raw_state)
        return self.runtime(), recommendation, mapping

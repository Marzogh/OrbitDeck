from __future__ import annotations

from collections import OrderedDict
from datetime import UTC, datetime
from socket import AF_INET, SOCK_DGRAM, socket
from threading import Event, Thread
from time import sleep
from typing import Callable

from app.aprs.afsk import SAMPLE_RATE, ax25_to_afsk
from app.aprs.codec import (
    decode_ui_frame,
    encode_ui_frame,
    format_message_payload,
    format_position_payload,
    format_status_payload,
)
from app.aprs.direwolf import DireWolfProcess
from app.aprs.kiss import KissTcpClient, wait_for_socket
from app.aprs.regions import frequency_for_location
from app.models import (
    AprsHeardStation,
    AprsOperatingMode,
    AprsRuntimeState,
    AprsSendMessageRequest,
    AprsSendPositionRequest,
    AprsSendStatusRequest,
    AprsSettings,
    AprsTargetState,
    RadioSettings,
    RadioRigModel,
    RadioTransportMode,
    Satellite,
    SatelliteRadioChannel,
)
from app.radio.controllers.ic705 import Ic705Controller
from app.radio.icom_lan_session import IcomLanRadioSession
from app.radio.transport import SerialTransport
from app.radio.civ import parse_civ_address


SidecarFactory = Callable[[], DireWolfProcess]
KissFactory = Callable[[str, int, Callable[[bytes], None]], KissTcpClient]
WaitForSocket = Callable[[str, int, float], None]
WifiSessionFactory = Callable[..., IcomLanRadioSession]


class AprsService:
    DATA_OFF_MOD_INPUT_WLAN = 5
    DATA1_MOD_INPUT_WLAN = 3
    WIFI_PROFILE_VERIFY_ATTEMPTS = 5
    WIFI_PROFILE_VERIFY_DELAY_S = 0.2
    WIFI_STATE_KEY = "_orbitdeck_wifi_aprs"

    def __init__(
        self,
        sidecar_factory: SidecarFactory | None = None,
        kiss_factory: KissFactory | None = None,
        wait_for_socket_fn: WaitForSocket | None = None,
        wifi_session_factory: WifiSessionFactory | None = None,
    ) -> None:
        self._sidecar_factory = sidecar_factory or (lambda: DireWolfProcess())
        self._kiss_factory = kiss_factory or (lambda host, port, cb: KissTcpClient(host, port, cb))
        self._wait_for_socket = wait_for_socket_fn or wait_for_socket
        self._wifi_session_factory = wifi_session_factory or (lambda **kwargs: IcomLanRadioSession(**kwargs))
        self._sidecar: DireWolfProcess | None = None
        self._kiss: KissTcpClient | None = None
        self._wifi_radio: IcomLanRadioSession | None = None
        self._wifi_udp_sender: socket | None = None
        self._wifi_udp_port: int | None = None
        self._wifi_snapshot: dict[str, object] | None = None
        self._retune_stop = Event()
        self._retune_worker: Thread | None = None
        self._runtime = AprsRuntimeState()
        self._heard_index: OrderedDict[str, AprsHeardStation] = OrderedDict()

    def runtime(self) -> AprsRuntimeState:
        if self._sidecar is not None:
            self._runtime.sidecar_running = self._sidecar.is_running()
            self._runtime.output_tail = list(self._sidecar.output_tail)
            self._runtime.sidecar_command = list(self._sidecar.command)
        self._runtime.kiss_connected = bool(self._kiss and self._kiss.connected)
        return AprsRuntimeState.model_validate(self._runtime.model_dump(mode="python"))

    def _aprs_channels(self, sat: Satellite) -> list[SatelliteRadioChannel]:
        return [channel for channel in (sat.radio_channels or []) if channel.kind == "aprs" and (channel.downlink_hz or channel.uplink_hz)]

    def resolve_target(
        self,
        settings: AprsSettings,
        satellites: list[Satellite],
        location,
        pass_event=None,
        developer_force_enable: bool = False,
    ) -> AprsTargetState:
        if settings.operating_mode == AprsOperatingMode.satellite:
            sat = next((item for item in satellites if item.sat_id == settings.selected_satellite_id), None)
            if sat is None:
                raise ValueError("Selected satellite does not support APRS")
            channels = self._aprs_channels(sat)
            channel = next((item for item in channels if item.channel_id == settings.selected_channel_id), None)
            if channel is None and channels:
                channel = channels[0]
            if channel is None:
                raise ValueError("Selected satellite does not support APRS")
            frequency_hz = int(channel.downlink_hz or channel.uplink_hz or 0)
            now = datetime.now(UTC)
            pass_active = bool(pass_event and pass_event.aos <= now <= pass_event.los)
            can_transmit = developer_force_enable or not channel.requires_pass or pass_active
            force_reason = (
                "Developer override active: satellite APRS TX/RX forced enabled outside pass"
                if developer_force_enable and channel.requires_pass and not pass_active
                else None
            )
            return AprsTargetState(
                operating_mode=AprsOperatingMode.satellite,
                label=f"{sat.name} | {channel.label}",
                sat_id=sat.sat_id,
                sat_name=sat.name,
                channel_id=channel.channel_id,
                channel_label=channel.label,
                mode=channel.mode,
                frequency_hz=frequency_hz,
                uplink_hz=channel.uplink_hz,
                downlink_hz=channel.downlink_hz,
                path_default=(channel.path_default or settings.satellite_path or "ARISS").strip(),
                guidance=channel.guidance,
                requires_pass=channel.requires_pass,
                pass_active=pass_active,
                pass_aos=pass_event.aos if pass_event else None,
                pass_los=pass_event.los if pass_event else None,
                can_transmit=can_transmit,
                tx_block_reason=None if can_transmit else "Satellite APRS transmit is only enabled during an active pass",
                reason=force_reason or channel.status,
            )
        if settings.terrestrial_manual_frequency_hz:
            label = settings.terrestrial_region_label or "Manual terrestrial APRS"
            return AprsTargetState(
                operating_mode=AprsOperatingMode.terrestrial,
                label="Terrestrial APRS",
                frequency_hz=int(settings.terrestrial_manual_frequency_hz),
                path_default=settings.terrestrial_path.strip(),
                region_label=label,
                reason="Manual terrestrial override",
            )
        if location is None:
            raise ValueError("Terrestrial APRS requires location to derive a regional frequency or a manual override")
        region_label, frequency_hz = frequency_for_location(location.lat, location.lon)
        return AprsTargetState(
            operating_mode=AprsOperatingMode.terrestrial,
            label="Terrestrial APRS",
            frequency_hz=frequency_hz,
            path_default=settings.terrestrial_path.strip(),
            region_label=region_label,
            reason="Derived from current location",
        )

    def available_targets(self, settings: AprsSettings, satellites: list[Satellite], location, pass_by_sat_id: dict[str, object] | None = None) -> dict[str, object]:
        satellite_targets = [
            {
                "sat_id": sat.sat_id,
                "name": sat.name,
                "channels": [
                    {
                        "channel_id": channel.channel_id,
                        "label": channel.label,
                        "mode": channel.mode or "AFSK",
                        "frequency_hz": int(channel.downlink_hz or channel.uplink_hz or 0),
                        "uplink_hz": channel.uplink_hz,
                        "downlink_hz": channel.downlink_hz,
                        "path_default": channel.path_default or settings.satellite_path,
                        "requires_pass": channel.requires_pass,
                        "guidance": channel.guidance,
                        "pass": (
                            {
                                "aos": pass_by_sat_id[sat.sat_id].aos,
                                "los": pass_by_sat_id[sat.sat_id].los,
                                "active": pass_by_sat_id[sat.sat_id].aos <= datetime.now(UTC) <= pass_by_sat_id[sat.sat_id].los,
                            }
                            if pass_by_sat_id and sat.sat_id in pass_by_sat_id
                            else None
                        ),
                    }
                    for channel in self._aprs_channels(sat)
                ],
            }
            for sat in satellites
            if self._aprs_channels(sat)
        ]
        terrestrial = None
        if location is not None:
            region_label, frequency_hz = frequency_for_location(location.lat, location.lon)
            terrestrial = {
                "region_label": region_label,
                "suggested_frequency_hz": frequency_hz,
                "manual_frequency_hz": settings.terrestrial_manual_frequency_hz,
                "path_default": settings.terrestrial_path.strip(),
            }
        return {"satellites": satellite_targets, "terrestrial": terrestrial}

    def connect(
        self,
        settings: AprsSettings,
        target: AprsTargetState,
        *,
        radio_settings: RadioSettings | None = None,
        retune_resolver: Callable[[], AprsTargetState] | None = None,
        interval_s: float = 1.0,
    ) -> AprsRuntimeState:
        self.disconnect()
        transport_mode = radio_settings.transport_mode if radio_settings is not None else RadioTransportMode.usb
        if transport_mode == RadioTransportMode.wifi:
            runtime = self._connect_wifi(settings, target, radio_settings)
            self._start_retune_worker(settings, radio_settings, retune_resolver, interval_s)
            return runtime
        tune_hz = int(target.corrected_frequency_hz or target.frequency_hz)
        self._tune_radio(settings, tune_hz)
        self._sidecar = self._sidecar_factory()
        self._sidecar.start(settings, target)
        self._wait_for_socket(settings.kiss_host, settings.kiss_port, 5.0)
        self._kiss = self._kiss_factory(settings.kiss_host, settings.kiss_port, self._handle_frame)
        self._kiss.connect()
        self._runtime.connected = True
        self._runtime.session_active = True
        self._runtime.sidecar_running = True
        self._runtime.kiss_connected = True
        self._runtime.transport_mode = RadioTransportMode.usb
        self._runtime.control_endpoint = settings.serial_device
        self._runtime.modem_state = "direwolf-local-audio"
        self._runtime.capabilities = {"cat_control": True, "rx_audio": True, "tx_audio": True, "ptt": True}
        self._runtime.audio_rx_active = False
        self._runtime.audio_tx_active = False
        self._runtime.owned_resource = "radio"
        self._runtime.last_error = None
        self._runtime.last_started_at = datetime.now(UTC)
        self._runtime.target = target
        self._start_retune_worker(settings, radio_settings, retune_resolver, interval_s)
        return self.runtime()

    def disconnect(self) -> AprsRuntimeState:
        self._stop_retune_worker()
        if self._wifi_radio is not None:
            try:
                self._wifi_radio.stop_audio_rx()
            except Exception:
                pass
            try:
                self._wifi_radio.stop_audio_tx()
            except Exception:
                pass
            try:
                self._wifi_radio.set_ptt(False)
            except Exception:
                pass
            try:
                if self._wifi_snapshot is not None:
                    self._restore_wifi_radio(self._wifi_snapshot)
            except Exception:
                pass
            try:
                self._wifi_radio.disconnect()
            except Exception:
                pass
            self._wifi_radio = None
        self._wifi_snapshot = None
        if self._wifi_udp_sender is not None:
            try:
                self._wifi_udp_sender.close()
            except OSError:
                pass
            self._wifi_udp_sender = None
        self._wifi_udp_port = None
        if self._kiss is not None:
            self._kiss.close()
            self._kiss = None
        if self._sidecar is not None:
            self._sidecar.stop()
            self._sidecar = None
        self._runtime.connected = False
        self._runtime.session_active = False
        self._runtime.sidecar_running = False
        self._runtime.kiss_connected = False
        self._runtime.audio_rx_active = False
        self._runtime.audio_tx_active = False
        self._runtime.owned_resource = None
        return self.runtime()

    def send_status(self, settings: AprsSettings, payload: AprsSendStatusRequest) -> AprsRuntimeState:
        self._send_frame(settings, format_status_payload(payload.text))
        return self.runtime()

    def send_message(self, settings: AprsSettings, payload: AprsSendMessageRequest) -> AprsRuntimeState:
        self._send_frame(settings, format_message_payload(payload.to, payload.text))
        return self.runtime()

    def send_position(self, settings: AprsSettings, payload: AprsSendPositionRequest, location) -> AprsRuntimeState:
        lat = payload.latitude if payload.latitude is not None else getattr(location, "lat", None)
        lon = payload.longitude if payload.longitude is not None else getattr(location, "lon", None)
        if lat is None or lon is None:
            raise ValueError("Position send requires coordinates or a resolved location")
        default_comment = (
            settings.satellite_beacon_comment
            if settings.operating_mode == AprsOperatingMode.satellite
            else settings.terrestrial_beacon_comment
        )
        self._send_frame(
            settings,
            format_position_payload(lat, lon, settings.symbol_table, settings.symbol_code, payload.comment or default_comment or ""),
        )
        return self.runtime()

    def _send_frame(self, settings: AprsSettings, text: str) -> None:
        if self._runtime.target and not self._runtime.target.can_transmit:
            raise RuntimeError(self._runtime.target.tx_block_reason or "APRS transmit is not currently allowed")
        source = self._source_call(settings)
        if settings.listen_only:
            path = []
        else:
            path_text = (
                self._runtime.target.path_default
                if self._runtime.target and self._runtime.target.path_default
                else settings.terrestrial_path
            )
            path = [item.strip().upper() for item in str(path_text).split(",") if item.strip()]
        frame = encode_ui_frame(source, "APOD01", path, text)
        if self._runtime.transport_mode == RadioTransportMode.wifi:
            self._send_wifi_frame(frame)
        else:
            if self._kiss is None or not self._kiss.connected:
                raise RuntimeError("APRS is not connected")
            self._kiss.send_data(frame)
        self._runtime.packets_tx += 1

    def _handle_frame(self, frame: bytes) -> None:
        try:
            event = decode_ui_frame(frame)
        except Exception as exc:
            self._runtime.last_error = str(exc)
            return
        self._runtime.packets_rx += 1
        self._runtime.last_packet_at = event.received_at
        packets = [event] + self._runtime.recent_packets[:49]
        self._runtime.recent_packets = packets
        heard = self._heard_index.get(event.source)
        if heard is None:
            heard = AprsHeardStation(callsign=event.source, last_heard_at=event.received_at, packet_count=0)
        heard.last_heard_at = event.received_at
        heard.packet_count += 1
        heard.latitude = event.latitude if event.latitude is not None else heard.latitude
        heard.longitude = event.longitude if event.longitude is not None else heard.longitude
        heard.last_text = event.text or heard.last_text
        self._heard_index[event.source] = heard
        self._heard_index.move_to_end(event.source, last=False)
        while len(self._heard_index) > 50:
            self._heard_index.popitem(last=True)
        self._runtime.heard_stations = list(self._heard_index.values())
        self._runtime.heard_count = len(self._runtime.heard_stations)

    def _source_call(self, settings: AprsSettings) -> str:
        call = settings.callsign.strip().upper() or "N0CALL"
        return call if settings.ssid <= 0 else f"{call}-{settings.ssid}"

    def _tune_radio(self, settings: AprsSettings, frequency_hz: int) -> None:
        if settings.rig_model != RadioRigModel.ic705:
            return
        transport = SerialTransport(settings.serial_device, settings.baud_rate, timeout=0.5)
        controller = Ic705Controller(transport, parse_civ_address(settings.civ_address))
        try:
            controller.connect()
            controller.set_frequency("A", int(frequency_hz))
        finally:
            controller.disconnect()

    def _reserve_udp_port(self) -> int:
        sock = socket(AF_INET, SOCK_DGRAM)
        sock.bind(("127.0.0.1", 0))
        port = int(sock.getsockname()[1])
        sock.close()
        return port

    def _prepare_wifi_radio_for_aprs(self, tune_hz: int) -> dict[str, object]:
        if self._wifi_radio is None:
            raise RuntimeError("APRS Wi-Fi session is not connected")
        snapshot = self._wifi_radio.snapshot_state()
        snapshot[self.WIFI_STATE_KEY] = {
            "vox": bool(self._wifi_radio.get_vox()),
            "data_mode": bool(self._wifi_radio.get_data_mode()),
            "data_off_mod_input": int(self._wifi_radio.get_data_off_mod_input()),
            "data1_mod_input": int(self._wifi_radio.get_data1_mod_input()),
        }
        self._wifi_snapshot = dict(snapshot)
        if snapshot[self.WIFI_STATE_KEY]["vox"]:
            self._wifi_radio.set_vox(False)
        self._wifi_radio.select_vfo("A")
        self._wifi_radio.set_split_mode(False)
        self._wifi_radio.set_frequency(int(tune_hz))
        self._wifi_radio.set_mode("FM")
        self._wifi_radio.set_data_mode(True)
        self._wifi_radio.set_data_off_mod_input(self.DATA_OFF_MOD_INPUT_WLAN)
        self._wifi_radio.set_data1_mod_input(self.DATA1_MOD_INPUT_WLAN)
        self._wifi_radio.vfo_equalize()
        self._wifi_radio.set_squelch(0)
        self._wifi_radio.enable_scope(output=False, policy="fast")
        self._wifi_radio.set_scope_mode(0)
        self._wifi_radio.set_scope_span(7)
        self._wifi_radio.select_vfo("A")
        self._verify_wifi_aprs_profile(int(tune_hz))
        return snapshot

    def _verify_wifi_aprs_profile(self, tune_hz: int) -> None:
        if self._wifi_radio is None:
            raise RuntimeError("APRS Wi-Fi session is not connected")
        target_hz = int(tune_hz)
        mismatches: list[str] = []
        for attempt in range(self.WIFI_PROFILE_VERIFY_ATTEMPTS):
            mismatches = []
            state = self._wifi_radio.snapshot_state()
            vox_enabled = self._wifi_radio.get_vox()
            selected_vfo = str(state.get("vfo") or "").upper()
            split_enabled = state.get("split")
            self._wifi_radio.select_vfo("A")
            vfo_a_hz = int(self._wifi_radio.get_frequency())
            self._wifi_radio.select_vfo("B")
            vfo_b_hz = int(self._wifi_radio.get_frequency())
            self._wifi_radio.select_vfo("A")
            mode_name, _ = self._wifi_radio.get_mode()
            data_mode = self._wifi_radio.get_data_mode()
            data_off_input = self._wifi_radio.get_data_off_mod_input()
            data1_input = self._wifi_radio.get_data1_mod_input()

            if vox_enabled:
                mismatches.append("VOX is still enabled")
            if selected_vfo and selected_vfo != "A":
                mismatches.append(f"expected VFO A selected, got {selected_vfo}")
            if split_enabled is True:
                mismatches.append("split mode is still enabled")
            if vfo_a_hz != target_hz:
                mismatches.append(f"VFO A frequency mismatch: expected {target_hz}, got {vfo_a_hz}")
            if vfo_b_hz != target_hz:
                mismatches.append(f"VFO B frequency mismatch: expected {target_hz}, got {vfo_b_hz}")
            if str(mode_name).upper() != "FM":
                mismatches.append(f"mode mismatch: expected FM, got {mode_name}")
            if not data_mode:
                mismatches.append("DATA mode is not enabled")
            if not mismatches:
                return
            if attempt < self.WIFI_PROFILE_VERIFY_ATTEMPTS - 1:
                sleep(self.WIFI_PROFILE_VERIFY_DELAY_S)
        raise RuntimeError("APRS Wi-Fi profile verification failed: " + "; ".join(mismatches))

    def _restore_wifi_radio(self, snapshot: dict[str, object]) -> None:
        if self._wifi_radio is None:
            return
        self._wifi_radio.restore_state(snapshot)
        extra = snapshot.get(self.WIFI_STATE_KEY)
        if isinstance(extra, dict):
            if "vox" in extra:
                self._wifi_radio.set_vox(bool(extra["vox"]))
            if "data_mode" in extra:
                self._wifi_radio.set_data_mode(bool(extra["data_mode"]))
            if "data_off_mod_input" in extra:
                self._wifi_radio.set_data_off_mod_input(int(extra["data_off_mod_input"]))
            if "data1_mod_input" in extra:
                self._wifi_radio.set_data1_mod_input(int(extra["data1_mod_input"]))

    def _set_wifi_radio_frequency(self, tune_hz: int) -> None:
        if self._wifi_radio is None:
            raise RuntimeError("APRS Wi-Fi session is not connected")
        self._wifi_radio.select_vfo("A")
        self._wifi_radio.set_frequency(int(tune_hz))
        self._wifi_radio.vfo_equalize()
        self._wifi_radio.select_vfo("A")

    def _wifi_audio_callback(self, pcm_bytes: bytes) -> None:
        if self._wifi_udp_sender is None or self._wifi_udp_port is None:
            return
        self._runtime.audio_rx_active = True
        try:
            self._wifi_udp_sender.sendto(pcm_bytes, ("127.0.0.1", self._wifi_udp_port))
        except OSError as exc:
            self._runtime.last_error = str(exc)

    def _connect_wifi(self, settings: AprsSettings, target: AprsTargetState, radio_settings: RadioSettings | None) -> AprsRuntimeState:
        if radio_settings is None:
            raise RuntimeError("APRS Wi-Fi connect requires IC-705 Wi-Fi radio settings")
        if radio_settings.rig_model != RadioRigModel.ic705:
            raise RuntimeError("APRS Wi-Fi is currently supported only for the IC-705")
        self._wifi_radio = self._wifi_session_factory(
            host=radio_settings.wifi_host.strip(),
            control_port=radio_settings.wifi_control_port,
            username=radio_settings.wifi_username.strip(),
            password=radio_settings.wifi_password,
            civ_address=parse_civ_address(settings.civ_address),
            timeout=max(8.0, radio_settings.poll_interval_ms / 1000),
        )
        tune_hz = int(target.corrected_frequency_hz or target.frequency_hz)
        try:
            self._wifi_radio.connect()
            self._wifi_snapshot = self._prepare_wifi_radio_for_aprs(tune_hz)
            self._wifi_udp_port = self._reserve_udp_port()
            self._wifi_udp_sender = socket(AF_INET, SOCK_DGRAM)
            self._sidecar = self._sidecar_factory()
            self._sidecar.start_network_decoder(settings, target, udp_port=self._wifi_udp_port, sample_rate=SAMPLE_RATE)
            self._wait_for_socket(settings.kiss_host, settings.kiss_port, 5.0)
            self._kiss = self._kiss_factory(settings.kiss_host, settings.kiss_port, self._handle_frame)
            self._kiss.connect()
            self._wifi_radio.start_audio_rx(self._wifi_audio_callback)
        except Exception:
            self.disconnect()
            raise
        self._runtime.connected = True
        self._runtime.session_active = True
        self._runtime.sidecar_running = True
        self._runtime.kiss_connected = True
        self._runtime.transport_mode = RadioTransportMode.wifi
        self._runtime.control_endpoint = f"{radio_settings.wifi_host.strip()}:{radio_settings.wifi_control_port}"
        self._runtime.modem_state = "direwolf-rx + native-afsk-tx"
        self._runtime.capabilities = {"cat_control": True, "rx_audio": True, "tx_audio": True, "ptt": True}
        self._runtime.audio_rx_active = True
        self._runtime.audio_tx_active = False
        self._runtime.owned_resource = "radio"
        self._runtime.last_error = None
        self._runtime.last_started_at = datetime.now(UTC)
        self._runtime.target = target
        return self.runtime()

    def _send_wifi_frame(self, frame: bytes) -> None:
        if self._wifi_radio is None:
            raise RuntimeError("APRS Wi-Fi session is not connected")
        pcm = ax25_to_afsk(frame)
        chunk_bytes = 1920
        self._runtime.audio_tx_active = True
        try:
            self._wifi_radio.start_audio_tx()
            self._wifi_radio.set_ptt(True)
            for offset in range(0, len(pcm), chunk_bytes):
                self._wifi_radio.push_audio_tx(pcm[offset: offset + chunk_bytes])
                sleep(0.02)
            sleep(0.25)
        finally:
            try:
                self._wifi_radio.set_ptt(False)
            finally:
                try:
                    self._wifi_radio.stop_audio_tx()
                finally:
                    self._runtime.audio_tx_active = False

    def _stop_retune_worker(self) -> None:
        self._retune_stop.set()
        if self._retune_worker is not None and self._retune_worker.is_alive():
            self._retune_worker.join(timeout=0.5)
        self._retune_worker = None
        self._retune_stop.clear()

    def _start_retune_worker(
        self,
        settings: AprsSettings,
        radio_settings: RadioSettings | None,
        retune_resolver: Callable[[], AprsTargetState] | None,
        interval_s: float,
    ) -> None:
        self._stop_retune_worker()
        if retune_resolver is None:
            return
        self._retune_stop.clear()

        def worker() -> None:
            while not self._retune_stop.wait(max(0.2, float(interval_s))):
                try:
                    target = retune_resolver()
                except Exception as exc:
                    self._runtime.last_error = str(exc)
                    continue
                self._runtime.target = target
                tune_hz = int(target.corrected_frequency_hz or target.frequency_hz)
                try:
                    if self._runtime.transport_mode == RadioTransportMode.wifi:
                        if self._wifi_radio is not None:
                            self._set_wifi_radio_frequency(tune_hz)
                    else:
                        self._tune_radio(settings, tune_hz)
                except Exception as exc:
                    self._runtime.last_error = str(exc)

        self._retune_worker = Thread(target=worker, daemon=True)
        self._retune_worker.start()

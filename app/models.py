from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class IssDisplayMode(str, Enum):
    sunlit_only_video = "SunlitOnlyVideo"
    sunlit_and_visible_video = "SunlitAndVisibleVideo"
    telemetry_only = "TelemetryOnly"


class PassProfileMode(str, Enum):
    iss_only = "IssOnly"
    favorites = "Favorites"


class LocationSourceMode(str, Enum):
    manual = "manual"
    browser = "browser"
    gps = "gps"
    auto = "auto"


class NetworkMode(str, Enum):
    station = "station"
    access_point = "access_point"


class GpsConnectionMode(str, Enum):
    usb = "usb"
    bluetooth = "bluetooth"


class DeveloperSceneMode(str, Enum):
    auto = "auto"
    ongoing = "ongoing"
    upcoming = "upcoming"
    iss_upcoming = "iss-upcoming"
    passes = "passes"
    radio = "radio"
    video = "video"


class DeveloperPassPhase(str, Enum):
    real_time = "real-time"
    before_aos = "before-aos"
    at_aos = "at-aos"
    mid_pass = "mid-pass"
    near_los = "near-los"


class RadioRigModel(str, Enum):
    id5100 = "id5100"
    ic705 = "ic705"


class RadioTransportMode(str, Enum):
    usb = "usb"
    wifi = "wifi"


class RadioControlMode(str, Enum):
    idle = "idle"
    manual_applied = "manual_applied"
    auto_tracking = "auto_tracking"


class AprsOperatingMode(str, Enum):
    satellite = "satellite"
    terrestrial = "terrestrial"


class RadioControlScreenState(str, Enum):
    idle = "idle"
    test = "test"
    armed = "armed"
    active = "active"
    released = "released"
    completed = "completed"


class RadioSessionControlState(str, Enum):
    not_connected = "not_connected"
    connected_idle = "connected_idle"
    test_applied = "test_applied"
    armed_waiting_aos = "armed_waiting_aos"
    tracking_active = "tracking_active"
    released = "released"
    ended = "ended"


class GeoPoint(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    alt_m: float = 0.0
    timestamp: datetime | None = None


class LocationProfile(BaseModel):
    id: str
    name: str
    point: GeoPoint


class LocationState(BaseModel):
    source_mode: LocationSourceMode = LocationSourceMode.auto
    selected_profile_id: str | None = None
    profiles: list[LocationProfile] = Field(default_factory=list)
    browser_location: GeoPoint | None = None
    gps_location: GeoPoint | None = None
    last_known_location: GeoPoint | None = None


class NetworkState(BaseModel):
    mode: NetworkMode = NetworkMode.station
    connected_ssid: str | None = None
    known_ssids: list[str] = Field(default_factory=list)
    ap_ssid: str = "ISS-Tracker-Setup"
    internet_available: bool = False
    last_checked: datetime | None = None


class GpsSettings(BaseModel):
    connection_mode: GpsConnectionMode = GpsConnectionMode.usb
    serial_device: str = "/dev/ttyUSB0"
    baud_rate: int = Field(default=9600, ge=1200, le=115200)
    bluetooth_address: str = ""
    bluetooth_channel: int = Field(default=1, ge=1, le=30)


class CachePolicy(BaseModel):
    retention_days: int = Field(default=30, ge=1, le=365)
    max_storage_mb: int = Field(default=512, ge=32, le=10240)
    stale_after_hours: int = Field(default=24, ge=1, le=720)


class RadioSettings(BaseModel):
    enabled: bool = False
    rig_model: RadioRigModel = RadioRigModel.id5100
    transport_mode: RadioTransportMode = RadioTransportMode.usb
    serial_device: str = "/dev/ttyUSB0"
    baud_rate: int = Field(default=19200, ge=4800, le=19200)
    civ_address: str = "0x8C"
    wifi_host: str = ""
    wifi_username: str = ""
    wifi_password: str = ""
    wifi_control_port: int = Field(default=50001, ge=1, le=65535)
    poll_interval_ms: int = Field(default=1000, ge=100, le=10000)
    auto_connect: bool = False
    auto_track_interval_ms: int = Field(default=1500, ge=200, le=10000)
    default_apply_mode_and_tone: bool = True
    safe_tx_guard_enabled: bool = True


class AprsDigipeaterSettings(BaseModel):
    enabled: bool = False
    aliases: list[str] = Field(default_factory=lambda: ["WIDE1-1"])
    max_hops: int = Field(default=1, ge=0, le=7)
    dedupe_window_s: int = Field(default=30, ge=1, le=600)
    callsign_allowlist: list[str] = Field(default_factory=list)
    path_blocklist: list[str] = Field(default_factory=lambda: ["TCPIP", "TCPXX", "NOGATE", "RFONLY"])


class AprsIgateSettings(BaseModel):
    enabled: bool = False
    server_host: str = "rotate.aprs2.net"
    server_port: int = Field(default=14580, ge=1, le=65535)
    login_callsign: str = ""
    passcode: str = ""
    filter: str = "m/25"
    connect_timeout_s: int = Field(default=10, ge=1, le=120)
    gate_terrestrial_rx: bool = True
    gate_satellite_rx: bool = True


class AprsSettings(BaseModel):
    enabled: bool = False
    callsign: str = "N0CALL"
    ssid: int = Field(default=10, ge=0, le=15)
    listen_only: bool = False
    operating_mode: AprsOperatingMode = AprsOperatingMode.terrestrial
    rig_model: RadioRigModel = RadioRigModel.ic705
    hamlib_model_id: int | None = 3085
    serial_device: str = "/dev/ttyUSB0"
    baud_rate: int = Field(default=19200, ge=4800, le=19200)
    civ_address: str = "0xA4"
    audio_input_device: str = "default"
    audio_output_device: str = "default"
    ptt_via_cat: bool = True
    kiss_host: str = "127.0.0.1"
    kiss_port: int = Field(default=8001, ge=1024, le=65535)
    direwolf_binary: str = "direwolf"
    start_on_boot: bool = False
    tx_path: list[str] = Field(default_factory=lambda: ["WIDE1-1", "WIDE2-1"])
    terrestrial_path: str = "WIDE1-1,WIDE2-1"
    satellite_path: str = "ARISS"
    beacon_comment: str = "OrbitDeck APRS"
    terrestrial_beacon_comment: str = "OrbitDeck APRS"
    satellite_beacon_comment: str = "OrbitDeck Space APRS"
    symbol_table: str = "/"
    symbol_code: str = "["
    position_fudge_lat_deg: float = Field(default=0.0, ge=-0.02, le=0.02, multiple_of=0.01)
    position_fudge_lon_deg: float = Field(default=0.0, ge=-0.02, le=0.02, multiple_of=0.01)
    log_enabled: bool = False
    log_max_records: int = Field(default=500, ge=100, le=5000)
    notify_incoming_messages: bool = True
    notify_all_packets: bool = False
    digipeater: AprsDigipeaterSettings = Field(default_factory=AprsDigipeaterSettings)
    igate: AprsIgateSettings = Field(default_factory=AprsIgateSettings)
    future_digipeater_enabled: bool = False
    future_igate_enabled: bool = False
    igate_auto_enable_with_internet: bool = True
    selected_satellite_id: str | None = None
    selected_channel_id: str | None = None
    terrestrial_auto_region: bool = True
    terrestrial_region_label: str | None = None
    terrestrial_manual_frequency_hz: int | None = Field(default=None, ge=1000)
    terrestrial_last_suggested_frequency_hz: int | None = Field(default=None, ge=1000)

    @model_validator(mode="before")
    @classmethod
    def _migrate_legacy_gateway_flags(cls, value):
        if not isinstance(value, dict):
            return value
        payload = dict(value)
        digipeater = payload.get("digipeater")
        igate = payload.get("igate")
        future_digipeater = bool(payload.get("future_digipeater_enabled", False))
        future_igate = bool(payload.get("future_igate_enabled", False))
        if isinstance(digipeater, AprsDigipeaterSettings):
            pass
        elif not isinstance(digipeater, dict):
            payload["digipeater"] = {"enabled": future_digipeater}
        elif "enabled" not in digipeater:
            payload["digipeater"] = {**digipeater, "enabled": future_digipeater}
        if isinstance(igate, AprsIgateSettings):
            pass
        elif not isinstance(igate, dict):
            payload["igate"] = {"enabled": future_igate}
        elif "enabled" not in igate:
            payload["igate"] = {**igate, "enabled": future_igate}
        return payload

    @model_validator(mode="after")
    def _sync_legacy_gateway_flags(self):
        self.future_digipeater_enabled = bool(self.digipeater.enabled)
        self.future_igate_enabled = bool(self.igate.enabled)
        return self


class LiteSettings(BaseModel):
    tracked_sat_ids: list[str] = Field(default_factory=lambda: ["iss-zarya"])
    setup_complete: bool = False


class DeveloperOverridesSettings(BaseModel):
    enabled: bool = False
    force_scene: DeveloperSceneMode = DeveloperSceneMode.auto
    force_sat_id: str | None = None
    simulate_pass_phase: DeveloperPassPhase = DeveloperPassPhase.real_time
    force_iss_video_eligible: bool = False
    force_iss_stream_healthy: bool = False
    show_debug_badge: bool = True


class AppSettings(BaseModel):
    iss_display_mode: IssDisplayMode = IssDisplayMode.sunlit_and_visible_video
    iss_stream_urls: list[str] = Field(
        default_factory=lambda: [
            "https://www.youtube.com/embed/DDU-rZs-Ic4?autoplay=1&mute=1",
            "https://www.youtube.com/embed/21X5lGlDOfg?autoplay=1&mute=1",
        ]
    )
    force_stream_unhealthy: bool = False
    display_timezone: str = "BrowserLocal"
    pass_profile: PassProfileMode = PassProfileMode.iss_only
    pass_sat_ids: list[str] = Field(default_factory=lambda: ["iss-zarya"])
    developer_overrides: DeveloperOverridesSettings = Field(default_factory=DeveloperOverridesSettings)


class Satellite(BaseModel):
    sat_id: str
    norad_id: int
    name: str
    is_iss: bool = False
    has_amateur_radio: bool = True
    transponders: list[str] = Field(default_factory=list)
    repeaters: list[str] = Field(default_factory=list)
    radio_channels: list["SatelliteRadioChannel"] = Field(default_factory=list)
    tle_line1: str | None = None
    tle_line2: str | None = None
    period_minutes: float = 95.0
    phase_offset: float = 0.0
    operational_status: "OperationalStatus | None" = None


class SatelliteRadioChannel(BaseModel):
    channel_id: str
    source: Literal["satnogs", "seed", "curated"] = "satnogs"
    kind: Literal["aprs", "fm", "linear", "other"] = "other"
    label: str
    mode: str | None = None
    uplink_hz: int | None = None
    downlink_hz: int | None = None
    alive: bool = True
    status: str | None = None
    path_default: str | None = None
    requires_pass: bool = False
    tx_enabled: bool = True
    guidance: str | None = None


class StatusReport(BaseModel):
    reported_time: datetime
    callsign: str | None = None
    report: str
    grid_square: str | None = None


class OperationalStatus(BaseModel):
    source: Literal["amsat"]
    checked_at: datetime
    source_url: str
    matched_name: str
    summary: Literal["active", "telemetry_only", "inactive", "conflicting", "unknown"]
    latest_report: StatusReport | None = None
    reports_last_96h: int = 0
    heard_count: int = 0
    telemetry_only_count: int = 0
    not_heard_count: int = 0


class LiveTrack(BaseModel):
    sat_id: str
    name: str
    timestamp: datetime
    az_deg: float
    el_deg: float
    range_km: float
    range_rate_km_s: float
    sunlit: bool
    subpoint_lat: float | None = None
    subpoint_lon: float | None = None


class PassEvent(BaseModel):
    sat_id: str
    name: str
    aos: datetime
    tca: datetime
    los: datetime
    max_el_deg: float


class SettingsUpdate(BaseModel):
    mode: IssDisplayMode


class PassFilterUpdate(BaseModel):
    profile: PassProfileMode
    sat_ids: list[str] | None = None


class TimezoneUpdate(BaseModel):
    timezone: str


class DeveloperOverridesUpdate(BaseModel):
    enabled: bool = False
    force_scene: DeveloperSceneMode = DeveloperSceneMode.auto
    force_sat_id: str | None = None
    simulate_pass_phase: DeveloperPassPhase = DeveloperPassPhase.real_time
    force_iss_video_eligible: bool = False
    force_iss_stream_healthy: bool = False
    show_debug_badge: bool = True


class IssState(BaseModel):
    sunlit: bool
    aboveHorizon: bool
    mode: IssDisplayMode
    videoEligible: bool
    streamHealthy: bool
    activeStreamUrl: str | None


class LocationUpdate(BaseModel):
    source_mode: LocationSourceMode | None = None
    selected_profile_id: str | None = None
    add_profile: LocationProfile | None = None
    browser_location: GeoPoint | None = None
    gps_location: GeoPoint | None = None


class NetworkUpdate(BaseModel):
    mode: NetworkMode | None = None
    connected_ssid: str | None = None
    known_ssids: list[str] | None = None
    internet_available: bool | None = None


class GpsSettingsUpdate(BaseModel):
    connection_mode: GpsConnectionMode | None = None
    serial_device: str | None = None
    baud_rate: int | None = Field(default=None, ge=1200, le=115200)
    bluetooth_address: str | None = None
    bluetooth_channel: int | None = Field(default=None, ge=1, le=30)


class CachePolicyUpdate(BaseModel):
    retention_days: int | None = Field(default=None, ge=1, le=365)
    max_storage_mb: int | None = Field(default=None, ge=32, le=10240)
    stale_after_hours: int | None = Field(default=None, ge=1, le=720)


class LiteSettingsUpdate(BaseModel):
    tracked_sat_ids: list[str] = Field(default_factory=list)
    setup_complete: bool = True


class DatasetSnapshot(BaseModel):
    id: str
    source: Literal["seed", "celestrak", "satnogs", "merged"]
    created_at: datetime
    satellite_count: int


class FrequencyGuideMode(str, Enum):
    fm = "fm"
    linear = "linear"


class DopplerDirection(str, Enum):
    high_to_low = "high_to_low"
    low_to_high = "low_to_high"


class CorrectionSide(str, Enum):
    uhf_only = "uhf_only"
    downlink_only = "downlink_only"
    full_duplex = "full_duplex"


class GuidePassPhase(str, Enum):
    aos = "aos"
    early = "early"
    mid = "mid"
    late = "late"
    los = "los"


class FrequencyGuideRow(BaseModel):
    phase: GuidePassPhase
    uplink_mhz: float | None = None
    downlink_mhz: float | None = None


class FrequencyGuideColumn(BaseModel):
    index: int
    uplink_mhz: float | None = None
    downlink_mid_mhz: float | None = None
    label: str | None = None


class FrequencyGuideProfile(BaseModel):
    sat_id: str
    mode: FrequencyGuideMode
    correction_side: CorrectionSide = CorrectionSide.uhf_only
    doppler_direction: DopplerDirection
    nominal_uplink_mhz: float | None = None
    nominal_downlink_mhz: float | None = None
    uplink_label: str | None = None
    downlink_label: str | None = None
    uplink_mode: str | None = None
    downlink_mode: str | None = None
    uplink_step_hz: int = 1000
    downlink_step_hz: int = 5000
    default_column_index: int | None = None
    tone: str | None = None
    beacon_mhz: float | None = None
    preset: str | None = None
    note: str | None = None
    schedule_note: str | None = None
    columns: list[FrequencyGuideColumn] = Field(default_factory=list)


class FrequencyRecommendation(BaseModel):
    sat_id: str
    mode: FrequencyGuideMode
    phase: GuidePassPhase
    label: str
    is_upcoming: bool
    is_ongoing: bool
    correction_side: CorrectionSide
    doppler_direction: DopplerDirection
    uplink_mhz: float | None = None
    downlink_mhz: float | None = None
    uplink_label: str | None = None
    downlink_label: str | None = None
    uplink_mode: str | None = None
    downlink_mode: str | None = None
    tone: str | None = None
    beacon_mhz: float | None = None
    preset: str | None = None
    note: str | None = None
    schedule_note: str | None = None
    selected_column_index: int | None = None


class FrequencyGuideMatrix(BaseModel):
    sat_id: str
    mode: FrequencyGuideMode
    selected_column_index: int | None = None
    columns: list[FrequencyGuideColumn] = Field(default_factory=list)
    rows: list[FrequencyGuideRow] = Field(default_factory=list)
    active_phase: GuidePassPhase | None = None


class RadioRuntimeState(BaseModel):
    connected: bool = False
    control_mode: RadioControlMode = RadioControlMode.idle
    rig_model: RadioRigModel | None = None
    transport_mode: RadioTransportMode | None = None
    serial_device: str | None = None
    endpoint: str | None = None
    last_error: str | None = None
    last_poll_at: datetime | None = None
    active_sat_id: str | None = None
    active_pass_aos: datetime | None = None
    active_pass_los: datetime | None = None
    selected_column_index: int | None = None
    last_applied_recommendation: FrequencyRecommendation | None = None
    targets: dict[str, int | float | str | bool | None] = Field(default_factory=dict)
    raw_state: dict[str, object] = Field(default_factory=dict)


class RadioControlSessionState(BaseModel):
    active: bool = False
    selected_sat_id: str | None = None
    selected_sat_name: str | None = None
    selected_pass_aos: datetime | None = None
    selected_pass_los: datetime | None = None
    selected_max_el_deg: float | None = None
    screen_state: RadioControlScreenState = RadioControlScreenState.idle
    control_state: RadioSessionControlState = RadioSessionControlState.not_connected
    return_to_rotator_on_end: bool = True
    is_eligible: bool = False
    eligibility_reason: str | None = None
    has_test_pair: bool = False
    test_pair_reason: str | None = None
    test_pair: FrequencyRecommendation | None = None


class AprsTargetState(BaseModel):
    operating_mode: AprsOperatingMode
    label: str
    sat_id: str | None = None
    sat_name: str | None = None
    channel_id: str | None = None
    channel_label: str | None = None
    mode: str | None = None
    frequency_hz: int
    uplink_hz: int | None = None
    downlink_hz: int | None = None
    path_default: str | None = None
    region_label: str | None = None
    guidance: str | None = None
    requires_pass: bool = False
    pass_active: bool = False
    pass_aos: datetime | None = None
    pass_los: datetime | None = None
    corrected_frequency_hz: int | None = None
    corrected_uplink_hz: int | None = None
    corrected_downlink_hz: int | None = None
    correction_side: CorrectionSide | None = None
    active_phase: GuidePassPhase | None = None
    retune_active: bool = False
    can_transmit: bool = True
    tx_block_reason: str | None = None
    reason: str | None = None


class AprsPacketEvent(BaseModel):
    received_at: datetime
    source: str
    destination: str
    path: list[str] = Field(default_factory=list)
    packet_type: str
    text: str
    latitude: float | None = None
    longitude: float | None = None
    addressee: str | None = None
    message_id: str | None = None
    digipeated: bool = False
    igated: bool = False
    raw_tnc2: str


class AprsLogEntry(BaseModel):
    received_at: datetime
    source: str
    destination: str
    path: list[str] = Field(default_factory=list)
    packet_type: str
    text: str
    latitude: float | None = None
    longitude: float | None = None
    addressee: str | None = None
    message_id: str | None = None
    digipeated: bool = False
    igated: bool = False
    raw_tnc2: str


class AprsHeardStation(BaseModel):
    callsign: str
    last_heard_at: datetime
    packet_count: int = 0
    latitude: float | None = None
    longitude: float | None = None
    last_text: str | None = None


class AprsRuntimeState(BaseModel):
    connected: bool = False
    session_active: bool = False
    sidecar_running: bool = False
    kiss_connected: bool = False
    transport_mode: RadioTransportMode | None = None
    control_endpoint: str | None = None
    modem_state: str | None = None
    audio_rx_active: bool = False
    audio_tx_active: bool = False
    capabilities: dict[str, bool] = Field(default_factory=dict)
    owned_resource: str | None = None
    last_error: str | None = None
    last_started_at: datetime | None = None
    last_packet_at: datetime | None = None
    last_tx_at: datetime | None = None
    last_tx_packet_type: str | None = None
    last_tx_text: str | None = None
    last_tx_raw_tnc2: str | None = None
    packets_rx: int = 0
    packets_tx: int = 0
    packets_digipeated: int = 0
    packets_igated: int = 0
    packets_dropped_policy: int = 0
    packets_dropped_duplicate: int = 0
    heard_count: int = 0
    digipeater_requested: bool = False
    digipeater_active: bool = False
    digipeater_reason: str | None = None
    igate_requested: bool = False
    igate_active: bool = False
    igate_auto_enabled: bool = False
    igate_status: str = "disabled"
    igate_connected: bool = False
    igate_reason: str | None = None
    igate_server: str | None = None
    igate_last_connect_at: datetime | None = None
    igate_last_error: str | None = None
    target: AprsTargetState | None = None
    recent_packets: list[AprsPacketEvent] = Field(default_factory=list)
    heard_stations: list[AprsHeardStation] = Field(default_factory=list)
    gateway_debug_lines: list[str] = Field(default_factory=list)
    sidecar_command: list[str] = Field(default_factory=list)
    output_tail: list[str] = Field(default_factory=list)


class PersistedState(BaseModel):
    settings: AppSettings = Field(default_factory=AppSettings)
    location: LocationState = Field(default_factory=LocationState)
    network: NetworkState = Field(default_factory=NetworkState)
    gps_settings: GpsSettings = Field(default_factory=GpsSettings)
    radio_settings: RadioSettings = Field(default_factory=RadioSettings)
    aprs_settings: AprsSettings = Field(default_factory=AprsSettings)
    cache_policy: CachePolicy = Field(default_factory=CachePolicy)
    lite_settings: LiteSettings = Field(default_factory=LiteSettings)
    snapshots: list[DatasetSnapshot] = Field(default_factory=list)


class RadioSettingsUpdate(BaseModel):
    enabled: bool | None = None
    rig_model: RadioRigModel | None = None
    transport_mode: RadioTransportMode | None = None
    serial_device: str | None = None
    baud_rate: int | None = Field(default=None, ge=4800, le=19200)
    civ_address: str | None = None
    wifi_host: str | None = None
    wifi_username: str | None = None
    wifi_password: str | None = None
    wifi_control_port: int | None = Field(default=None, ge=1, le=65535)
    poll_interval_ms: int | None = Field(default=None, ge=100, le=10000)
    auto_connect: bool | None = None
    auto_track_interval_ms: int | None = Field(default=None, ge=200, le=10000)
    default_apply_mode_and_tone: bool | None = None
    safe_tx_guard_enabled: bool | None = None


class AprsSettingsUpdate(BaseModel):
    enabled: bool | None = None
    callsign: str | None = None
    ssid: int | None = Field(default=None, ge=0, le=15)
    listen_only: bool | None = None
    operating_mode: AprsOperatingMode | None = None
    rig_model: RadioRigModel | None = None
    hamlib_model_id: int | None = None
    serial_device: str | None = None
    baud_rate: int | None = Field(default=None, ge=4800, le=19200)
    civ_address: str | None = None
    audio_input_device: str | None = None
    audio_output_device: str | None = None
    ptt_via_cat: bool | None = None
    kiss_host: str | None = None
    kiss_port: int | None = Field(default=None, ge=1024, le=65535)
    direwolf_binary: str | None = None
    start_on_boot: bool | None = None
    tx_path: list[str] | None = None
    beacon_comment: str | None = None
    terrestrial_beacon_comment: str | None = None
    satellite_beacon_comment: str | None = None
    symbol_table: str | None = None
    symbol_code: str | None = None
    position_fudge_lat_deg: float | None = Field(default=None, ge=-0.02, le=0.02, multiple_of=0.01)
    position_fudge_lon_deg: float | None = Field(default=None, ge=-0.02, le=0.02, multiple_of=0.01)
    log_enabled: bool | None = None
    log_max_records: int | None = Field(default=None, ge=100, le=5000)
    notify_incoming_messages: bool | None = None
    notify_all_packets: bool | None = None
    digipeater: AprsDigipeaterSettings | None = None
    igate: AprsIgateSettings | None = None
    future_digipeater_enabled: bool | None = None
    future_igate_enabled: bool | None = None
    igate_auto_enable_with_internet: bool | None = None
    selected_satellite_id: str | None = None
    selected_channel_id: str | None = None
    terrestrial_path: str | None = None
    satellite_path: str | None = None
    terrestrial_auto_region: bool | None = None
    terrestrial_region_label: str | None = None
    terrestrial_manual_frequency_hz: int | None = Field(default=None, ge=1000)
    terrestrial_last_suggested_frequency_hz: int | None = Field(default=None, ge=1000)


class RadioApplyRequest(BaseModel):
    sat_id: str = Field(min_length=1)
    pass_aos: datetime | None = None
    pass_los: datetime | None = None
    selected_column_index: int | None = None
    location_source: LocationSourceMode | None = None
    apply_mode_and_tone: bool | None = None


class RadioAutoTrackStartRequest(RadioApplyRequest):
    interval_ms: int | None = Field(default=None, ge=200, le=10000)


class RadioFrequencySetRequest(BaseModel):
    vfo: str = Field(min_length=1)
    freq_hz: int = Field(ge=1000)


class RadioPairSetRequest(BaseModel):
    uplink_hz: int | None = Field(default=None, ge=1000)
    downlink_hz: int | None = Field(default=None, ge=1000)
    uplink_mode: str | None = None
    downlink_mode: str | None = None
    apply_mode_and_tone: bool | None = None


class RadioControlSessionSelectRequest(BaseModel):
    sat_id: str = Field(min_length=1)
    sat_name: str | None = None
    pass_aos: datetime
    pass_los: datetime
    max_el_deg: float | None = Field(default=None, ge=0.0, le=90.0)


class RadioControlSessionTestPairUpdateRequest(BaseModel):
    uplink_hz: int | None = Field(default=None, ge=1000)
    downlink_hz: int | None = Field(default=None, ge=1000)
    uplink_mode: str | None = None
    downlink_mode: str | None = None
    label: str | None = None


class AprsTargetSelectRequest(BaseModel):
    operating_mode: AprsOperatingMode
    sat_id: str | None = None
    channel_id: str | None = None
    terrestrial_frequency_hz: int | None = Field(default=None, ge=1000)


class AprsSessionIdentityUpdateRequest(BaseModel):
    clear: bool = False
    callsign: str | None = None
    ssid: int | None = Field(default=None, ge=0, le=15)


class AprsSendMessageRequest(BaseModel):
    to: str = Field(min_length=1, max_length=9)
    text: str = Field(min_length=1, max_length=67)
    callsign: str | None = None
    ssid: int | None = Field(default=None, ge=0, le=15)


class AprsSendStatusRequest(BaseModel):
    text: str = Field(min_length=1, max_length=67)
    callsign: str | None = None
    ssid: int | None = Field(default=None, ge=0, le=15)


class AprsSendPositionRequest(BaseModel):
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    comment: str = Field(default="", max_length=40)
    callsign: str | None = None
    ssid: int | None = Field(default=None, ge=0, le=15)


class AprsLogSettingsUpdate(BaseModel):
    log_enabled: bool
    log_max_records: int = Field(ge=100, le=5000)
    notify_incoming_messages: bool
    notify_all_packets: bool
    digipeater: AprsDigipeaterSettings | None = None
    igate: AprsIgateSettings | None = None
    future_digipeater_enabled: bool = False
    future_igate_enabled: bool = False
    igate_auto_enable_with_internet: bool = True


class AprsLogClearRequest(BaseModel):
    age_bucket: Literal["7d", "30d", "90d", "all"] = "all"

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


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


class RadioControlMode(str, Enum):
    idle = "idle"
    manual_applied = "manual_applied"
    auto_tracking = "auto_tracking"


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
    serial_device: str = "/dev/ttyUSB0"
    baud_rate: int = Field(default=19200, ge=4800, le=19200)
    civ_address: str = "0x8C"
    poll_interval_ms: int = Field(default=1000, ge=100, le=10000)
    auto_connect: bool = False
    auto_track_interval_ms: int = Field(default=1500, ge=200, le=10000)
    default_apply_mode_and_tone: bool = True
    safe_tx_guard_enabled: bool = True


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
    display_timezone: str = "UTC"
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
    tle_line1: str | None = None
    tle_line2: str | None = None
    period_minutes: float = 95.0
    phase_offset: float = 0.0
    operational_status: "OperationalStatus | None" = None


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
    serial_device: str | None = None
    last_error: str | None = None
    last_poll_at: datetime | None = None
    active_sat_id: str | None = None
    active_pass_aos: datetime | None = None
    active_pass_los: datetime | None = None
    selected_column_index: int | None = None
    last_applied_recommendation: FrequencyRecommendation | None = None
    targets: dict[str, int | float | str | bool | None] = Field(default_factory=dict)
    raw_state: dict[str, object] = Field(default_factory=dict)


class PersistedState(BaseModel):
    settings: AppSettings = Field(default_factory=AppSettings)
    location: LocationState = Field(default_factory=LocationState)
    network: NetworkState = Field(default_factory=NetworkState)
    gps_settings: GpsSettings = Field(default_factory=GpsSettings)
    radio_settings: RadioSettings = Field(default_factory=RadioSettings)
    cache_policy: CachePolicy = Field(default_factory=CachePolicy)
    lite_settings: LiteSettings = Field(default_factory=LiteSettings)
    snapshots: list[DatasetSnapshot] = Field(default_factory=list)


class RadioSettingsUpdate(BaseModel):
    enabled: bool | None = None
    rig_model: RadioRigModel | None = None
    serial_device: str | None = None
    baud_rate: int | None = Field(default=None, ge=4800, le=19200)
    civ_address: str | None = None
    poll_interval_ms: int | None = Field(default=None, ge=100, le=10000)
    auto_connect: bool | None = None
    auto_track_interval_ms: int | None = Field(default=None, ge=200, le=10000)
    default_apply_mode_and_tone: bool | None = None
    safe_tx_guard_enabled: bool | None = None


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
    uplink_hz: int = Field(ge=1000)
    downlink_hz: int = Field(ge=1000)
    uplink_mode: str | None = None
    downlink_mode: str | None = None
    apply_mode_and_tone: bool | None = None

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class IssDisplayMode(str, Enum):
    sunlit_only_video = "SunlitOnlyVideo"
    sunlit_and_visible_video = "SunlitAndVisibleVideo"
    telemetry_only = "TelemetryOnly"


class LocationSourceMode(str, Enum):
    manual = "manual"
    browser = "browser"
    gps = "gps"
    auto = "auto"


class NetworkMode(str, Enum):
    station = "station"
    access_point = "access_point"


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


class CachePolicy(BaseModel):
    retention_days: int = Field(default=30, ge=1, le=365)
    max_storage_mb: int = Field(default=512, ge=32, le=10240)
    stale_after_hours: int = Field(default=24, ge=1, le=720)


class AppSettings(BaseModel):
    iss_display_mode: IssDisplayMode = IssDisplayMode.sunlit_and_visible_video
    iss_stream_urls: list[str] = Field(
        default_factory=lambda: [
            "https://www.youtube.com/embed/DDU-rZs-Ic4?autoplay=1&mute=1",
            "https://www.youtube.com/embed/21X5lGlDOfg?autoplay=1&mute=1",
        ]
    )
    force_stream_unhealthy: bool = False


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


class LiveTrack(BaseModel):
    sat_id: str
    name: str
    timestamp: datetime
    az_deg: float
    el_deg: float
    range_km: float
    range_rate_km_s: float
    sunlit: bool


class PassEvent(BaseModel):
    sat_id: str
    name: str
    aos: datetime
    tca: datetime
    los: datetime
    max_el_deg: float


class SettingsUpdate(BaseModel):
    mode: IssDisplayMode


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


class CachePolicyUpdate(BaseModel):
    retention_days: int | None = Field(default=None, ge=1, le=365)
    max_storage_mb: int | None = Field(default=None, ge=32, le=10240)
    stale_after_hours: int | None = Field(default=None, ge=1, le=720)


class DatasetSnapshot(BaseModel):
    id: str
    source: Literal["seed", "celestrak", "satnogs", "merged"]
    created_at: datetime
    satellite_count: int


class PersistedState(BaseModel):
    settings: AppSettings = Field(default_factory=AppSettings)
    location: LocationState = Field(default_factory=LocationState)
    network: NetworkState = Field(default_factory=NetworkState)
    cache_policy: CachePolicy = Field(default_factory=CachePolicy)
    snapshots: list[DatasetSnapshot] = Field(default_factory=list)

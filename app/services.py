from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from html import unescape
from pathlib import Path
from typing import Any

import httpx

from app.models import (
    AppSettings,
    CachePolicy,
    CachePolicyUpdate,
    CorrectionSide,
    DopplerDirection,
    FrequencyGuideMatrix,
    FrequencyGuideProfile,
    FrequencyGuideRow,
    FrequencyRecommendation,
    GuidePassPhase,
    IssDisplayMode,
    IssState,
    LiveTrack,
    LocationProfile,
    LocationSourceMode,
    LocationState,
    LocationUpdate,
    OperationalStatus,
    NetworkMode,
    NetworkState,
    NetworkUpdate,
    PassEvent,
    Satellite,
    SatelliteRadioChannel,
    StatusReport,
)


SEED_SATELLITES: list[Satellite] = [
    Satellite(
        sat_id="iss-zarya",
        norad_id=25544,
        name="ISS (ZARYA)",
        is_iss=True,
        transponders=["145.990 MHz downlink", "437.800 MHz APRS"],
        repeaters=["Voice repeater (regional schedule)"],
        period_minutes=92.9,
        phase_offset=0.11,
    ),
    Satellite(
        sat_id="so50",
        norad_id=27607,
        name="SO-50",
        transponders=["U/V FM repeater"],
        repeaters=["145.850 MHz uplink CTCSS 67.0", "436.795 MHz downlink"],
        period_minutes=101.2,
        phase_offset=0.28,
    ),
    Satellite(
        sat_id="ao91",
        norad_id=43017,
        name="AO-91",
        transponders=["U/V FM repeater"],
        repeaters=["145.960 MHz uplink", "435.250 MHz downlink"],
        period_minutes=97.4,
        phase_offset=0.44,
    ),
    Satellite(
        sat_id="xw2a",
        norad_id=40911,
        name="XW-2A",
        transponders=["Linear transponder", "CW beacon"],
        repeaters=["U/V linear transponder"],
        period_minutes=95.6,
        phase_offset=0.63,
    ),
]


@dataclass
class ResolvedLocation:
    source: str
    lat: float
    lon: float
    alt_m: float


class LocationService:
    def resolve(self, state: LocationState) -> ResolvedLocation:
        def from_profile() -> ResolvedLocation | None:
            if not state.selected_profile_id:
                return None
            for profile in state.profiles:
                if profile.id == state.selected_profile_id:
                    return ResolvedLocation(
                        source="manual",
                        lat=profile.point.lat,
                        lon=profile.point.lon,
                        alt_m=profile.point.alt_m,
                    )
            return None

        if state.source_mode == LocationSourceMode.gps and state.gps_location:
            return ResolvedLocation("gps", state.gps_location.lat, state.gps_location.lon, state.gps_location.alt_m)
        if state.source_mode == LocationSourceMode.browser and state.browser_location:
            return ResolvedLocation(
                "browser",
                state.browser_location.lat,
                state.browser_location.lon,
                state.browser_location.alt_m,
            )
        if state.source_mode == LocationSourceMode.manual:
            profile = from_profile()
            if profile:
                return profile

        if state.source_mode == LocationSourceMode.auto:
            if state.gps_location:
                return ResolvedLocation("gps", state.gps_location.lat, state.gps_location.lon, state.gps_location.alt_m)
            if state.browser_location:
                return ResolvedLocation(
                    "browser",
                    state.browser_location.lat,
                    state.browser_location.lon,
                    state.browser_location.alt_m,
                )
            profile = from_profile()
            if profile:
                return profile

        if state.last_known_location:
            return ResolvedLocation(
                "last_known",
                state.last_known_location.lat,
                state.last_known_location.lon,
                state.last_known_location.alt_m,
            )

        return ResolvedLocation(source="default", lat=0.0, lon=0.0, alt_m=0.0)

    def apply_update(self, current: LocationState, update: LocationUpdate) -> LocationState:
        next_state = current.model_copy(deep=True)

        if update.source_mode is not None:
            next_state.source_mode = update.source_mode
        if update.selected_profile_id is not None:
            next_state.selected_profile_id = update.selected_profile_id
        if update.add_profile is not None:
            filtered = [p for p in next_state.profiles if p.id != update.add_profile.id]
            filtered.append(update.add_profile)
            next_state.profiles = filtered
            if not next_state.selected_profile_id:
                next_state.selected_profile_id = update.add_profile.id
        if update.browser_location is not None:
            next_state.browser_location = update.browser_location
        if update.gps_location is not None:
            next_state.gps_location = update.gps_location

        resolved = self.resolve(next_state)
        next_state.last_known_location = LocationProfile(
            id="last-known",
            name="Last Known",
            point={"lat": resolved.lat, "lon": resolved.lon, "alt_m": resolved.alt_m},
        ).point
        return next_state


class TrackingService:
    def __init__(self, cache_path: str = "data/snapshots/latest_catalog.json") -> None:
        self.cache_path = Path(cache_path)
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self._satellites = self._normalize_catalog(self._filter_amateur_catalog(self._ensure_iss(self._load_cached_catalog())))
        self._sat_cache: dict[str, Any] = {}
        self._sky_load = None
        self._sky_wgs84 = None
        self._sky_ts = None
        self._sky_eph = None
        self._init_skyfield()

    def _load_cached_catalog(self) -> list[Satellite]:
        if not self.cache_path.exists():
            return SEED_SATELLITES
        try:
            with self.cache_path.open("r", encoding="utf-8") as f:
                raw = json.load(f)
            items = [Satellite.model_validate(x) for x in raw]
            return self._normalize_catalog(items if items else SEED_SATELLITES)
        except Exception:
            return self._normalize_catalog(SEED_SATELLITES)

    def _save_cached_catalog(self) -> None:
        with self.cache_path.open("w", encoding="utf-8") as f:
            json.dump([s.model_dump(mode="json") for s in self._satellites], f, indent=2)

    def satellites(self) -> list[Satellite]:
        return [s.model_copy(deep=True) for s in self._satellites]

    def _normalize_catalog(self, satellites: list[Satellite]) -> list[Satellite]:
        enriched: list[Satellite] = []
        for sat in satellites:
            channels = list(sat.radio_channels or [])
            if not channels:
                channels = self._infer_seed_channels(sat)
            sat = sat.model_copy(update={"radio_channels": channels})
            enriched.append(sat)
        return enriched

    def _channel_kind(self, label: str, mode: str | None = None) -> str:
        text = f"{label} {mode or ''}".lower()
        if "aprs" in text:
            return "aprs"
        if "linear" in text or "ssb" in text or "cw" in text:
            return "linear"
        if "fm" in text or "repeater" in text:
            return "fm"
        return "other"

    def _infer_seed_channels(self, sat: Satellite) -> list[SatelliteRadioChannel]:
        channels: list[SatelliteRadioChannel] = []
        text_lines = list(sat.transponders or []) + list(sat.repeaters or [])
        for idx, line in enumerate(text_lines):
            if "aprs" not in str(line).lower():
                continue
            freqs = re.findall(r"(\d+(?:\.\d+)?)\s*mhz", str(line), flags=re.IGNORECASE)
            downlink_hz = int(round(float(freqs[0]) * 1_000_000)) if freqs else None
            channels.append(
                SatelliteRadioChannel(
                    channel_id=f"{sat.sat_id}:seed:{idx}",
                    source="seed",
                    kind="aprs",
                    label=str(line).strip(),
                    mode="AFSK",
                    downlink_hz=downlink_hz,
                    uplink_hz=downlink_hz,
                    path_default="ARISS",
                    requires_pass=True,
                    guidance="Seed APRS channel inferred from catalog text",
                )
            )
        return channels

    def merge_operational_statuses(self, statuses: dict[str, OperationalStatus]) -> None:
        if not statuses:
            return
        changed = False
        for sat in self._satellites:
            status = statuses.get(sat.sat_id)
            if status is None:
                continue
            sat.operational_status = status
            changed = True
        if changed:
            self._save_cached_catalog()

    def _is_amateur_satellite(self, sat: Satellite) -> bool:
        if sat.is_iss and sat.norad_id == 25544:
            return True
        if "ISS" in sat.name.upper():
            return False
        if sat.has_amateur_radio is False:
            return False
        tx = [str(x or "") for x in (sat.transponders or [])]
        rx = [str(x or "") for x in (sat.repeaters or [])]
        text = " ".join(tx + rx).lower()
        if not text.strip():
            return False
        # Exclude payloads that are only available after commanding or are marked
        # experimental/engineering rather than normal amateur operation.
        blocked_markers = (
            "active after command",
            "after command",
            "experimental",
            "engineering mode",
            "engineering transponder",
            "test mode",
        )
        if any(marker in text for marker in blocked_markers):
            return False
        has_beacon = ("beacon" in text) or ("cw" in text)
        has_placeholder_payload_only = bool(text.strip()) and all(
            line.strip().lower() in {"amateur payload", "transmitter"}
            for line in (tx + rx)
            if line.strip()
        )
        has_valid_pair = any(
            ("uplink" in line.lower())
            and ("downlink" in line.lower())
            and ("uplink n/a" not in line.lower())
            and ("downlink n/a" not in line.lower())
            for line in rx
        )
        has_transponder = any(
            ("transponder" in line.lower() or "repeater" in line.lower())
            and ("experimental" not in line.lower())
            and ("after command" not in line.lower())
            and ("amateur payload" not in line.lower())
            and ("transmitter" not in line.lower())
            for line in tx + rx
        )
        if has_placeholder_payload_only and not has_valid_pair and not has_beacon and not has_transponder:
            return False
        mode_keywords = (
            "mhz",
            "aprs",
            "fm",
            "ssb",
            "cw",
            "bpsk",
            "fsk",
            "afsk",
            "ctcss",
            "sstv",
        )
        has_named_radio_mode = any(keyword in text for keyword in mode_keywords)
        return has_valid_pair or has_transponder or (has_beacon and has_named_radio_mode)

    def _filter_amateur_catalog(self, satellites: list[Satellite]) -> list[Satellite]:
        filtered = [s for s in satellites if self._is_amateur_satellite(s)]
        return filtered if filtered else self._ensure_iss(SEED_SATELLITES)

    def _ensure_iss(self, satellites: list[Satellite]) -> list[Satellite]:
        has_iss = any(s.is_iss or s.norad_id == 25544 or "ISS" in s.name.upper() for s in satellites)
        if has_iss:
            return satellites
        iss_seed = next((s for s in SEED_SATELLITES if s.is_iss), None)
        if iss_seed is None:
            return satellites
        return satellites + [iss_seed.model_copy(deep=True)]

    def replace_catalog(self, satellites: list[Satellite]) -> None:
        if not satellites:
            return
        self._satellites = self._normalize_catalog(self._filter_amateur_catalog(self._ensure_iss(satellites)))
        self._sat_cache.clear()
        self._save_cached_catalog()

    def _init_skyfield(self) -> None:
        try:
            from skyfield.api import load, wgs84  # type: ignore
        except Exception:
            return
        self._sky_load = load
        self._sky_wgs84 = wgs84
        self._sky_ts = load.timescale()
        eph_path = Path("data/ephemeris/de421.bsp")
        if eph_path.exists():
            try:
                self._sky_eph = load(str(eph_path))
            except Exception:
                self._sky_eph = None

    def _observer(self, location: ResolvedLocation):
        if not self._sky_wgs84:
            return None
        return self._sky_wgs84.latlon(
            latitude_degrees=location.lat,
            longitude_degrees=location.lon,
            elevation_m=location.alt_m,
        )

    def _sat_obj(self, sat: Satellite):
        if not self._sky_ts or not sat.tle_line1 or not sat.tle_line2:
            return None
        try:
            from skyfield.api import EarthSatellite  # type: ignore
        except Exception:
            return None
        key = f"{sat.sat_id}:{sat.tle_line1}:{sat.tle_line2}"
        if key not in self._sat_cache:
            self._sat_cache[key] = EarthSatellite(sat.tle_line1, sat.tle_line2, sat.name, self._sky_ts)
        return self._sat_cache[key]

    def _live_track_from_tle(self, sat: Satellite, now: datetime, location: ResolvedLocation) -> LiveTrack | None:
        sat_obj = self._sat_obj(sat)
        obs = self._observer(location)
        if sat_obj is None or obs is None or self._sky_ts is None:
            return None
        t = self._sky_ts.from_datetime(now.astimezone(UTC).replace(tzinfo=UTC))
        topo = (sat_obj - obs).at(t)
        alt, az, distance = topo.altaz()
        if abs(float(alt.degrees)) > 90:
            return None

        # Estimate range-rate via 1-second finite difference.
        t2 = self._sky_ts.from_datetime((now + timedelta(seconds=1)).astimezone(UTC).replace(tzinfo=UTC))
        d2 = (sat_obj - obs).at(t2).distance().km
        d1 = distance.km
        range_rate = float(d2 - d1)

        sunlit = self._sunlit(sat, now, location)
        if self._sky_eph is not None:
            with_sun = sat_obj.at(t)
            try:
                sunlit = bool(with_sun.is_sunlit(self._sky_eph))
            except Exception:
                pass

        return LiveTrack(
            sat_id=sat.sat_id,
            name=sat.name,
            timestamp=now,
            az_deg=round(float(az.degrees), 2),
            el_deg=round(float(alt.degrees), 2),
            range_km=round(float(distance.km), 1),
            range_rate_km_s=round(range_rate, 3),
            sunlit=sunlit,
            subpoint_lat=round(float(sat_obj.at(t).subpoint().latitude.degrees), 4),
            subpoint_lon=round(float(sat_obj.at(t).subpoint().longitude.degrees), 4),
        )

    def _phase(self, sat: Satellite, now: datetime) -> float:
        epoch_min = now.timestamp() / 60.0
        return (epoch_min / sat.period_minutes + sat.phase_offset) % 1.0

    def _sunlit(self, sat: Satellite, now: datetime, location: ResolvedLocation) -> bool:
        utc_hour = now.hour + now.minute / 60.0
        lon_shift = location.lon / 180.0
        phase = (utc_hour / 24.0 + sat.phase_offset + lon_shift * 0.05) % 1.0
        return math.cos(2 * math.pi * phase) > -0.05

    def live_tracks(
        self,
        now: datetime,
        location: ResolvedLocation,
        sat_ids: set[str] | None = None,
    ) -> list[LiveTrack]:
        tracks: list[LiveTrack] = []
        satellites = self._satellites if sat_ids is None else [s for s in self._satellites if s.sat_id in sat_ids]
        for sat in satellites:
            track = self._track_at(sat, now, location)
            if track is not None:
                tracks.append(track)
        return tracks

    def _track_at(self, sat: Satellite, when: datetime, location: ResolvedLocation) -> LiveTrack | None:
        tle_track = self._live_track_from_tle(sat, when, location)
        if tle_track is not None:
            return tle_track
        phase = self._phase(sat, when)
        sin_term = math.sin(2 * math.pi * phase)
        cos_term = math.cos(2 * math.pi * phase)
        el = max(-15.0, 90.0 * sin_term)
        az = (phase * 360.0 + sat.norad_id % 180 + location.lon * 0.2) % 360.0
        range_km = 2200.0 - max(0.0, sin_term) * 1600.0
        range_rate = -7.5 * cos_term
        return LiveTrack(
            sat_id=sat.sat_id,
            name=sat.name,
            timestamp=when,
            az_deg=round(az, 2),
            el_deg=round(el, 2),
            range_km=round(range_km, 1),
            range_rate_km_s=round(range_rate, 3),
            sunlit=self._sunlit(sat, when, location),
            subpoint_lat=round(-50.0 + 100.0 * sin_term, 4),
            subpoint_lon=round(((phase * 360.0) % 360.0) - 180.0, 4),
        )

    def track_path(
        self,
        now: datetime,
        minutes: int,
        location: ResolvedLocation,
        sat_id: str,
        step_seconds: int = 45,
        start_time: datetime | None = None,
    ) -> list[LiveTrack]:
        sat = next((item for item in self._satellites if item.sat_id == sat_id), None)
        if sat is None:
            return []
        horizon_seconds = max(60, int(minutes * 60))
        step = max(10, int(step_seconds))
        base_time = start_time or now
        items: list[LiveTrack] = []
        for offset in range(0, horizon_seconds + 1, step):
            sample_time = base_time + timedelta(seconds=offset)
            track = self._track_at(sat, sample_time, location)
            if track is not None:
                items.append(track)
        return items

    def pass_predictions(
        self,
        now: datetime,
        hours: int,
        location: ResolvedLocation | None = None,
        sat_ids: set[str] | None = None,
        include_ongoing: bool = False,
    ) -> list[PassEvent]:
        events: list[PassEvent] = []
        horizon = now + timedelta(hours=hours)
        # Highly elliptical satellites can remain above the horizon for many hours,
        # so include a wide enough lookback window to capture the rise event.
        search_start = now - timedelta(hours=12) if include_ongoing else now
        observer_location = location or ResolvedLocation(source="default", lat=0.0, lon=0.0, alt_m=0.0)
        satellites = self._satellites if sat_ids is None else [s for s in self._satellites if s.sat_id in sat_ids]

        for sat in satellites:
            sat_obj = self._sat_obj(sat)
            if sat_obj is None or self._sky_wgs84 is None or self._sky_ts is None:
                # Do not return synthetic pass predictions; they are too misleading.
                continue

            try:
                observer = self._sky_wgs84.latlon(
                    observer_location.lat,
                    observer_location.lon,
                    elevation_m=observer_location.alt_m,
                )
                t0 = self._sky_ts.from_datetime(search_start.astimezone(UTC).replace(tzinfo=UTC))
                t1 = self._sky_ts.from_datetime(horizon.astimezone(UTC).replace(tzinfo=UTC))
                tt, ev = sat_obj.find_events(observer, t0, t1, altitude_degrees=0.0)
                rise = None
                maxe = None
                max_el_val = None
                for t_val, e_val in zip(tt, ev):
                    dt = t_val.utc_datetime().replace(tzinfo=UTC)
                    if e_val == 0:
                        rise = dt
                        maxe = None
                        max_el_val = None
                    elif e_val == 1 and rise is not None:
                        maxe = dt
                        alt, _, _ = (sat_obj - observer).at(t_val).altaz()
                        max_el_val = float(alt.degrees)
                    elif e_val == 2 and rise is not None:
                        los = dt
                        tca = maxe or (rise + (los - rise) / 2)
                        if max_el_val is None and maxe is not None:
                            tca_sf = self._sky_ts.from_datetime(maxe.astimezone(UTC).replace(tzinfo=UTC))
                            alt, _, _ = (sat_obj - observer).at(tca_sf).altaz()
                            max_el_val = float(alt.degrees)
                        event = PassEvent(
                            sat_id=sat.sat_id,
                            name=sat.name,
                            aos=rise,
                            tca=tca,
                            los=los,
                            max_el_deg=round(max_el_val if max_el_val is not None else 0.0, 1),
                        )
                        if event.los >= now and event.aos <= horizon:
                            if include_ongoing or event.aos >= now:
                                events.append(event)
                        rise = None
                        maxe = None
                        max_el_val = None
            except Exception:
                continue

        events.sort(key=lambda e: e.aos)
        return events


class IssService:
    def state(
        self,
        settings: AppSettings,
        iss_track: LiveTrack,
    ) -> IssState:
        above_horizon = iss_track.el_deg > 0
        sunlit = iss_track.sunlit
        stream_healthy = not settings.force_stream_unhealthy and bool(settings.iss_stream_urls)

        if settings.iss_display_mode == IssDisplayMode.telemetry_only:
            video_eligible = False
        elif settings.iss_display_mode == IssDisplayMode.sunlit_only_video:
            video_eligible = sunlit
        else:
            video_eligible = sunlit and above_horizon

        active_stream = settings.iss_stream_urls[0] if (video_eligible and stream_healthy) else None
        return IssState(
            sunlit=sunlit,
            aboveHorizon=above_horizon,
            mode=settings.iss_display_mode,
            videoEligible=video_eligible,
            streamHealthy=stream_healthy,
            activeStreamUrl=active_stream,
        )


class NetworkService:
    def apply_update(self, current: NetworkState, update: NetworkUpdate) -> NetworkState:
        next_state = current.model_copy(deep=True)
        if update.mode is not None:
            next_state.mode = update.mode
        if update.connected_ssid is not None:
            next_state.connected_ssid = update.connected_ssid
        if update.known_ssids is not None:
            next_state.known_ssids = update.known_ssids
        if update.internet_available is not None:
            next_state.internet_available = update.internet_available
        next_state.last_checked = datetime.now(UTC)

        # AP fallback logic approximation; real implementation can be connected to nmcli/hostapd scripts.
        if next_state.mode.value == "station" and not next_state.connected_ssid and not next_state.known_ssids:
            next_state.mode = NetworkMode.access_point

        return next_state


class CacheService:
    def __init__(self, snapshots_dir: str = "data/snapshots") -> None:
        self.snapshots_dir = Path(snapshots_dir)
        self.snapshots_dir.mkdir(parents=True, exist_ok=True)

    def apply_policy(self, current: CachePolicy, update: CachePolicyUpdate) -> CachePolicy:
        next_state = current.model_copy(deep=True)
        if update.retention_days is not None:
            next_state.retention_days = update.retention_days
        if update.max_storage_mb is not None:
            next_state.max_storage_mb = update.max_storage_mb
        if update.stale_after_hours is not None:
            next_state.stale_after_hours = update.stale_after_hours
        return next_state


class PassPredictionCacheService:
    def __init__(self, cache_path: str = "data/snapshots/pass_predictions_cache.json") -> None:
        self.cache_path = Path(cache_path)
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self.cache_path.exists():
            self._entries = {}
            return
        try:
            with self.cache_path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
            raw_entries = data.get("entries", {})
            self._entries = raw_entries if isinstance(raw_entries, dict) else {}
        except Exception:
            self._entries = {}

    def _save(self) -> None:
        with self.cache_path.open("w", encoding="utf-8") as handle:
            json.dump({"entries": self._entries}, handle, indent=2, default=str)

    def get(self, key: str, ttl: timedelta, retention: timedelta) -> dict[str, Any] | None:
        entry = self._entries.get(key)
        if not isinstance(entry, dict):
            return None
        created_at_raw = entry.get("created_at")
        try:
            created_at = datetime.fromisoformat(str(created_at_raw))
        except Exception:
            self._entries.pop(key, None)
            self._save()
            return None
        now = datetime.now(UTC)
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=UTC)
        age = now - created_at.astimezone(UTC)
        if age > retention:
            self._entries.pop(key, None)
            self._save()
            return None
        if age > ttl:
            return None
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            return None
        return payload

    def put(self, key: str, payload: dict[str, Any], retention: timedelta) -> None:
        self.prune(retention)
        self._entries[key] = {
            "created_at": datetime.now(UTC).isoformat(),
            "payload": payload,
        }
        self._save()

    def clear(self) -> None:
        self._entries = {}
        self._save()

    def prune(self, retention: timedelta) -> None:
        now = datetime.now(UTC)
        changed = False
        for key, entry in list(self._entries.items()):
            try:
                created_at = datetime.fromisoformat(str(entry.get("created_at")))
                if created_at.tzinfo is None:
                    created_at = created_at.replace(tzinfo=UTC)
            except Exception:
                self._entries.pop(key, None)
                changed = True
                continue
            if now - created_at.astimezone(UTC) > retention:
                self._entries.pop(key, None)
                changed = True
        if changed:
            self._save()


class FrequencyGuideService:
    SPEED_OF_LIGHT_M_S = 299_792_458.0
    PHASE_PROGRESS: dict[GuidePassPhase, float] = {
        GuidePassPhase.aos: 0.0,
        GuidePassPhase.early: 0.25,
        GuidePassPhase.mid: 0.5,
        GuidePassPhase.late: 0.75,
        GuidePassPhase.los: 1.0,
    }

    def __init__(self, path: str = "data/frequency_guides.json") -> None:
        self.path = Path(path)
        self._profiles = self._load_profiles()

    def _load_profiles(self) -> dict[str, FrequencyGuideProfile]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        profiles: dict[str, FrequencyGuideProfile] = {}
        for item in raw.get("profiles", []):
            try:
                profile = FrequencyGuideProfile.model_validate(item)
            except Exception:
                continue
            profiles[profile.sat_id] = profile
        return profiles

    def profile_for_satellite(self, sat_id: str) -> FrequencyGuideProfile | None:
        return self._profiles.get(sat_id)

    def doppler_shift_hz(self, carrier_mhz: float, range_rate_km_s: float) -> float:
        carrier_hz = carrier_mhz * 1_000_000.0
        range_rate_m_s = range_rate_km_s * 1000.0
        return (range_rate_m_s / self.SPEED_OF_LIGHT_M_S) * carrier_hz

    def quantize_mhz(self, freq_mhz: float | None, step_hz: int) -> float | None:
        if freq_mhz is None:
            return None
        if step_hz <= 0:
            return round(freq_mhz, 6)
        hz = freq_mhz * 1_000_000.0
        snapped = round(hz / step_hz) * step_hz
        return round(snapped / 1_000_000.0, 3)

    def corrected_downlink_mhz(self, nominal_mhz: float | None, range_rate_km_s: float, step_hz: int) -> float | None:
        if nominal_mhz is None:
            return None
        shift_hz = self.doppler_shift_hz(nominal_mhz, range_rate_km_s)
        observed = (nominal_mhz * 1_000_000.0 - shift_hz) / 1_000_000.0
        return self.quantize_mhz(observed, step_hz)

    def corrected_uplink_mhz(self, nominal_mhz: float | None, range_rate_km_s: float, step_hz: int) -> float | None:
        if nominal_mhz is None:
            return None
        shift_hz = self.doppler_shift_hz(nominal_mhz, range_rate_km_s)
        corrected = (nominal_mhz * 1_000_000.0 + shift_hz) / 1_000_000.0
        return self.quantize_mhz(corrected, step_hz)

    def resolve_phase(self, now: datetime, pass_event: PassEvent | None) -> GuidePassPhase:
        if pass_event is None or now <= pass_event.aos:
            return GuidePassPhase.aos
        if now >= pass_event.los:
            return GuidePassPhase.los
        total = max(1.0, (pass_event.los - pass_event.aos).total_seconds())
        progress = max(0.0, min(1.0, (now - pass_event.aos).total_seconds() / total))
        if progress < 0.2:
            return GuidePassPhase.aos
        if progress < 0.4:
            return GuidePassPhase.early
        if progress < 0.6:
            return GuidePassPhase.mid
        if progress < 0.8:
            return GuidePassPhase.late
        return GuidePassPhase.los

    def _column_for_profile(
        self,
        profile: FrequencyGuideProfile,
        selected_column_index: int | None,
    ):
        if not profile.columns:
            return None, selected_column_index
        index = selected_column_index
        if index is None or index < 0 or index >= len(profile.columns):
            if profile.default_column_index is not None and 0 <= profile.default_column_index < len(profile.columns):
                index = profile.default_column_index
            else:
                index = len(profile.columns) // 2
        return profile.columns[index], index

    def _nominal_pair(
        self,
        profile: FrequencyGuideProfile,
        selected_column_index: int | None,
    ) -> tuple[float | None, float | None, int | None]:
        column, index = self._column_for_profile(profile, selected_column_index)
        if column is not None:
            return column.uplink_mhz, column.downlink_mid_mhz, index
        return profile.nominal_uplink_mhz, profile.nominal_downlink_mhz, index

    def _apply_correction(
        self,
        profile: FrequencyGuideProfile,
        nominal_uplink_mhz: float | None,
        nominal_downlink_mhz: float | None,
        range_rate_km_s: float,
    ) -> tuple[float | None, float | None]:
        if profile.correction_side == CorrectionSide.full_duplex:
            uplink = self.corrected_uplink_mhz(nominal_uplink_mhz, range_rate_km_s, profile.uplink_step_hz)
            downlink = self.corrected_downlink_mhz(nominal_downlink_mhz, range_rate_km_s, profile.downlink_step_hz)
        elif profile.correction_side == CorrectionSide.downlink_only:
            uplink = self.quantize_mhz(nominal_uplink_mhz, profile.uplink_step_hz)
            downlink = self.corrected_downlink_mhz(nominal_downlink_mhz, range_rate_km_s, profile.downlink_step_hz)
        else:
            uplink_is_uhf = nominal_uplink_mhz is not None and nominal_uplink_mhz >= 400.0
            downlink_is_uhf = nominal_downlink_mhz is not None and nominal_downlink_mhz >= 400.0
            uplink = (
                self.corrected_uplink_mhz(nominal_uplink_mhz, range_rate_km_s, profile.uplink_step_hz)
                if uplink_is_uhf
                else self.quantize_mhz(nominal_uplink_mhz, profile.uplink_step_hz)
            )
            downlink = (
                self.corrected_downlink_mhz(nominal_downlink_mhz, range_rate_km_s, profile.downlink_step_hz)
                if downlink_is_uhf
                else self.quantize_mhz(nominal_downlink_mhz, profile.downlink_step_hz)
            )
        return uplink, downlink

    def _phase_sample_time(self, pass_event: PassEvent, phase: GuidePassPhase) -> datetime:
        if phase == GuidePassPhase.mid:
            return pass_event.tca
        progress = self.PHASE_PROGRESS[phase]
        duration = pass_event.los - pass_event.aos
        return pass_event.aos + timedelta(seconds=duration.total_seconds() * progress)

    def _track_at_phase(
        self,
        profile: FrequencyGuideProfile,
        pass_event: PassEvent | None,
        phase: GuidePassPhase,
        current_track: LiveTrack | None,
        track_path: list[LiveTrack] | None,
    ) -> LiveTrack | None:
        if pass_event is None:
            return current_track
        target = self._phase_sample_time(pass_event, phase)
        candidates = track_path or []
        if current_track is not None:
            candidates = [current_track, *candidates]
        if not candidates:
            return current_track
        return min(candidates, key=lambda item: abs((item.timestamp - target).total_seconds()))

    def recommendation(
        self,
        sat_id: str,
        pass_event: PassEvent | None,
        current_track: LiveTrack | None = None,
        track_path: list[LiveTrack] | None = None,
        selected_column_index: int | None = None,
        now: datetime | None = None,
    ) -> FrequencyRecommendation | None:
        profile = self.profile_for_satellite(sat_id)
        if profile is None:
            return None
        current = now or datetime.now(UTC)
        phase = self.resolve_phase(current, pass_event)

        is_upcoming = bool(pass_event is not None and current < pass_event.aos)
        is_ongoing = bool(pass_event is not None and pass_event.aos <= current <= pass_event.los)
        label = "AOS cue" if is_upcoming else "Tune now" if is_ongoing else "Reference"
        nominal_uplink, nominal_downlink, column_index = self._nominal_pair(profile, selected_column_index)
        track = self._track_at_phase(profile, pass_event, phase, current_track, track_path)
        range_rate = track.range_rate_km_s if track is not None else 0.0
        uplink, downlink = self._apply_correction(profile, nominal_uplink, nominal_downlink, range_rate)

        return FrequencyRecommendation(
            sat_id=profile.sat_id,
            mode=profile.mode,
            phase=phase,
            label=label,
            is_upcoming=is_upcoming,
            is_ongoing=is_ongoing,
            correction_side=profile.correction_side,
            doppler_direction=profile.doppler_direction,
            uplink_mhz=uplink,
            downlink_mhz=downlink,
            uplink_label=profile.uplink_label,
            downlink_label=profile.downlink_label,
            uplink_mode=profile.uplink_mode,
            downlink_mode=profile.downlink_mode,
            tone=profile.tone,
            beacon_mhz=profile.beacon_mhz,
            preset=profile.preset,
            note=profile.note,
            schedule_note=profile.schedule_note,
            selected_column_index=column_index,
        )

    def matrix(
        self,
        sat_id: str,
        pass_event: PassEvent | None = None,
        current_track: LiveTrack | None = None,
        track_path: list[LiveTrack] | None = None,
        selected_column_index: int | None = None,
        active_phase: GuidePassPhase | None = None,
    ) -> FrequencyGuideMatrix | None:
        profile = self.profile_for_satellite(sat_id)
        if profile is None or profile.mode.value != "linear":
            return None
        _, _, index = self._nominal_pair(profile, selected_column_index)
        rows: list[FrequencyGuideRow] = []
        nominal_uplink, nominal_downlink, _ = self._nominal_pair(profile, index)
        for phase in GuidePassPhase:
            track = self._track_at_phase(profile, pass_event, phase, current_track, track_path)
            range_rate = track.range_rate_km_s if track is not None else 0.0
            uplink, downlink = self._apply_correction(profile, nominal_uplink, nominal_downlink, range_rate)
            rows.append(
                FrequencyGuideRow(
                    phase=phase,
                    uplink_mhz=uplink,
                    downlink_mhz=downlink,
                )
            )
        return FrequencyGuideMatrix(
            sat_id=profile.sat_id,
            mode=profile.mode,
            selected_column_index=index,
            columns=profile.columns,
            rows=rows,
            active_phase=active_phase,
        )


class DataIngestionService:
    CELESTRAK_AMATEUR_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle"
    CELESTRAK_STATIONS_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle"
    SATNOGS_TRANSMITTERS_URL = "https://db.satnogs.org/api/transmitters/?alive=true&format=json"
    EPHEMERIS_URL = "https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de421.bsp"
    AMSAT_STATUS_INDEX_URL = "https://www.amsat.org/status/index.php"
    AMSAT_STATUS_API_URL = "https://www.amsat.org/status/api/v1/sat_info.php"

    def __init__(self, eph_path: str = "data/ephemeris/de421.bsp") -> None:
        self.eph_path = Path(eph_path)
        self.eph_path.parent.mkdir(parents=True, exist_ok=True)
        self.refresh_meta_path = Path("data/snapshots/catalog_refresh_meta.json")
        self.refresh_meta_path.parent.mkdir(parents=True, exist_ok=True)
        self.amsat_status_cache_path = Path("data/snapshots/amsat_status.json")
        self.amsat_refresh_meta_path = Path("data/snapshots/amsat_status_refresh_meta.json")
        self._ephem_loaded = None
        self._ephem_ts = None

    def _load_refresh_meta(self) -> dict[str, Any]:
        if not self.refresh_meta_path.exists():
            return {}
        try:
            return json.loads(self.refresh_meta_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _save_refresh_meta(self, meta: dict[str, Any]) -> None:
        self.refresh_meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    def _load_amsat_refresh_meta(self) -> dict[str, Any]:
        if not self.amsat_refresh_meta_path.exists():
            return {}
        try:
            return json.loads(self.amsat_refresh_meta_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _save_amsat_refresh_meta(self, meta: dict[str, Any]) -> None:
        self.amsat_refresh_meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    def _channel_kind(self, label: str, mode: str | None = None) -> str:
        text = f"{label} {mode or ''}".lower()
        if "aprs" in text:
            return "aprs"
        if "linear" in text or "ssb" in text or "cw" in text:
            return "linear"
        if "fm" in text or "repeater" in text:
            return "fm"
        return "other"

    def _catalog_refresh_guard(self, min_interval_hours: float) -> tuple[bool, str | None]:
        if min_interval_hours <= 0:
            return True, None
        now = datetime.now(UTC)
        meta = self._load_refresh_meta()
        last_success_raw = meta.get("last_success_utc")
        if last_success_raw:
            try:
                last_success = datetime.fromisoformat(last_success_raw.replace("Z", "+00:00")).astimezone(UTC)
                delta = now - last_success
                min_delta = timedelta(hours=min_interval_hours)
                if delta < min_delta:
                    remaining = min_delta - delta
                    mins = max(1, int(remaining.total_seconds() // 60))
                    return False, f"Catalog refresh cooldown active ({mins} min remaining)"
            except Exception:
                pass
        return True, None

    def _amsat_refresh_guard(self, min_interval_hours: float) -> tuple[bool, str | None]:
        if min_interval_hours <= 0:
            return True, None
        now = datetime.now(UTC)
        meta = self._load_amsat_refresh_meta()
        last_success_raw = meta.get("last_success_utc")
        if last_success_raw:
            try:
                last_success = datetime.fromisoformat(last_success_raw.replace("Z", "+00:00")).astimezone(UTC)
                delta = now - last_success
                min_delta = timedelta(hours=min_interval_hours)
                if delta < min_delta:
                    remaining = min_delta - delta
                    mins = max(1, int(remaining.total_seconds() // 60))
                    return False, f"AMSAT status refresh cooldown active ({mins} min remaining)"
            except Exception:
                pass
        return True, None

    def _parse_tle(self, text: str) -> list[tuple[str, int, str, str]]:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        out: list[tuple[str, int, str, str]] = []
        i = 0
        while i + 2 < len(lines):
            if lines[i + 1].startswith("1 ") and lines[i + 2].startswith("2 "):
                name = lines[i]
                line1 = lines[i + 1]
                line2 = lines[i + 2]
                # NORAD catalog id columns 3-7 in TLE line 1.
                try:
                    norad = int(line1[2:7].strip())
                    out.append((name, norad, line1, line2))
                except ValueError:
                    pass
                i += 3
                continue
            i += 1
        return out

    def _load_amsat_status_cache(self) -> dict[str, OperationalStatus]:
        if not self.amsat_status_cache_path.exists():
            return {}
        try:
            raw = json.loads(self.amsat_status_cache_path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        if not isinstance(raw, dict):
            return {}
        out: dict[str, OperationalStatus] = {}
        for sat_id, payload in raw.items():
            try:
                out[sat_id] = OperationalStatus.model_validate(payload)
            except Exception:
                continue
        return out

    def _save_amsat_status_cache(self, statuses: dict[str, OperationalStatus]) -> None:
        payload = {sat_id: status.model_dump(mode="json") for sat_id, status in statuses.items()}
        self.amsat_status_cache_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def cached_amsat_statuses(self) -> dict[str, OperationalStatus]:
        return self._load_amsat_status_cache()

    def _parse_amsat_satellite_names(self, html: str) -> list[str]:
        matches = re.findall(r'<option value="([^"]+_\[[^"]+\])">', html, flags=re.IGNORECASE)
        seen: set[str] = set()
        names: list[str] = []
        for name in matches:
            value = unescape(name.strip())
            if value not in seen:
                seen.add(value)
                names.append(value)
        return names

    def _normalize_sat_name(self, name: str) -> str:
        compact = name.upper().strip()
        compact = compact.replace("(ZARYA)", "")
        compact = re.sub(r"\s+", "", compact)
        compact = compact.replace("_", "")
        compact = compact.replace("-", "")
        compact = compact.replace("/", "")
        compact = compact.replace("[", "")
        compact = compact.replace("]", "")
        compact = compact.replace("(", "")
        compact = compact.replace(")", "")
        return compact

    def _mode_hints_for_satellite(self, sat: Satellite) -> set[str]:
        text = " ".join(list(sat.transponders or []) + list(sat.repeaters or [])).lower()
        hints: set[str] = set()
        if "fm" in text or "ctcss" in text or "voice repeater" in text:
            hints.add("FM")
        if "aprs" in text or "digipeater" in text:
            hints.update({"APRS", "DIGI"})
        if "sstv" in text:
            hints.add("SSTV")
        if "datv" in text:
            hints.add("DATV")
        if "linear" in text or "ssb" in text or "cw" in text:
            hints.add("LINEAR")
        return hints

    def _match_amsat_name(self, sat: Satellite, amsat_names: list[str]) -> str | None:
        sat_key = self._normalize_sat_name(sat.name)
        sat_base = self._normalize_sat_name(sat.name.split("[", 1)[0])
        matches: list[str] = []
        for candidate in amsat_names:
            base = candidate.split("_[", 1)[0]
            base_key = self._normalize_sat_name(base)
            if base_key in {sat_key, sat_base} or sat_key in base_key or base_key in sat_key:
                matches.append(candidate)
        if not matches and sat.is_iss:
            matches = [name for name in amsat_names if name.startswith("ISS_[FM]")]
        if not matches:
            return None

        hints = self._mode_hints_for_satellite(sat)
        for preferred_mode in ("FM", "LINEAR", "APRS", "DIGI", "SSTV", "DATV"):
            if preferred_mode not in hints:
                continue
            for candidate in matches:
                upper_candidate = candidate.upper()
                if preferred_mode == "LINEAR":
                    if any(token in upper_candidate for token in ("[U/", "[V/", "[L/", "[S/")):
                        return candidate
                elif f"[{preferred_mode}]" in upper_candidate:
                    return candidate
        return matches[0]

    def _summarize_amsat_reports(self, matched_name: str, reports: list[dict[str, Any]]) -> OperationalStatus:
        normalized: list[StatusReport] = []
        heard_count = 0
        telemetry_only_count = 0
        not_heard_count = 0

        for item in reports:
            try:
                report = StatusReport(
                    reported_time=datetime.fromisoformat(str(item.get("reported_time", "")).replace("Z", "+00:00")),
                    callsign=item.get("callsign"),
                    report=str(item.get("report") or "").strip() or "Unknown",
                    grid_square=item.get("grid_square"),
                )
            except Exception:
                continue
            normalized.append(report)
            report_upper = report.report.upper()
            if "HEARD" in report_upper and "NOT HEARD" not in report_upper:
                heard_count += 1
            elif "TELEMETRY" in report_upper or "BEACON" in report_upper:
                telemetry_only_count += 1
            elif "NOT HEARD" in report_upper or "NO SIGNAL" in report_upper:
                not_heard_count += 1

        normalized.sort(key=lambda x: x.reported_time, reverse=True)
        if heard_count and not_heard_count:
            summary = "conflicting"
        elif heard_count:
            summary = "active"
        elif telemetry_only_count:
            summary = "telemetry_only"
        elif not_heard_count:
            summary = "inactive"
        else:
            summary = "unknown"

        return OperationalStatus(
            source="amsat",
            checked_at=datetime.now(UTC),
            source_url=self.AMSAT_STATUS_INDEX_URL,
            matched_name=matched_name,
            summary=summary,
            latest_report=normalized[0] if normalized else None,
            reports_last_96h=len(normalized),
            heard_count=heard_count,
            telemetry_only_count=telemetry_only_count,
            not_heard_count=not_heard_count,
        )

    def refresh_catalog(
        self,
        timeout_seconds: float = 10.0,
        min_interval_hours: float = 3.0,
    ) -> tuple[list[Satellite], dict]:
        allowed, reason = self._catalog_refresh_guard(min_interval_hours=min_interval_hours)
        if not allowed:
            raise RuntimeError(reason or "Catalog refresh cooldown active")
        refresh_meta = self._load_refresh_meta()
        refresh_meta["last_attempt_utc"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        self._save_refresh_meta(refresh_meta)
        try:
            with httpx.Client(timeout=timeout_seconds) as client:
                amateur_tle = client.get(self.CELESTRAK_AMATEUR_URL).text
                stations_tle = client.get(self.CELESTRAK_STATIONS_URL).text
                satnogs = client.get(self.SATNOGS_TRANSMITTERS_URL).json()

            transponders_by_norad: dict[int, list[str]] = {}
            repeaters_by_norad: dict[int, list[str]] = {}
            channels_by_norad: dict[int, list[SatelliteRadioChannel]] = {}
            for tx in satnogs:
                norad = tx.get("norad_cat_id")
                if not norad:
                    continue
                desc = tx.get("description") or tx.get("mode") or "Transmitter"
                down = tx.get("downlink_low")
                up = tx.get("uplink_low")
                mode = tx.get("mode") or ""
                line = f"{desc} {mode}".strip()
                transponders_by_norad.setdefault(norad, []).append(line)
                if down or up:
                    repeaters_by_norad.setdefault(norad, []).append(f"Uplink {up or 'n/a'} / Downlink {down or 'n/a'}")
                channels_by_norad.setdefault(norad, []).append(
                    SatelliteRadioChannel(
                        channel_id=f"{norad}:satnogs:{tx.get('uuid') or tx.get('id') or len(channels_by_norad.get(norad, []))}",
                        source="satnogs",
                        kind=self._channel_kind(str(desc), str(mode or "")),
                        label=str(desc).strip(),
                        mode=str(mode or "").strip() or None,
                        uplink_hz=int(up) if up is not None else None,
                        downlink_hz=int(down) if down is not None else None,
                        alive=bool(tx.get("alive", True)),
                        status=str(tx.get("status") or "").strip() or None,
                        path_default="ARISS" if self._channel_kind(str(desc), str(mode or "")) == "aprs" else None,
                        requires_pass=self._channel_kind(str(desc), str(mode or "")) == "aprs",
                        guidance="Derived from SatNOGS transmitter inventory" if self._channel_kind(str(desc), str(mode or "")) == "aprs" else None,
                    )
                )

            parsed_tles = self._parse_tle(amateur_tle) + self._parse_tle(stations_tle)
            merged: dict[int, Satellite] = {}
            for name, norad, tle1, tle2 in parsed_tles:
                sat_id = name.lower().replace(" ", "-").replace("(", "").replace(")", "")
                is_iss = norad == 25544
                sat = Satellite(
                    sat_id=sat_id,
                    norad_id=norad,
                    name=name,
                    is_iss=is_iss,
                    has_amateur_radio=True,
                    transponders=transponders_by_norad.get(norad, ["Amateur payload"]),
                    repeaters=repeaters_by_norad.get(norad, []),
                    radio_channels=channels_by_norad.get(norad, []),
                    tle_line1=tle1,
                    tle_line2=tle2,
                    period_minutes=92.9 if is_iss else 97.0 + (norad % 13) * 0.6,
                    phase_offset=((norad % 97) / 97.0),
                )
                merged[norad] = sat

            satellites = list(merged.values())
            # Treat empty/invalid TLE parses as refresh failure instead of replacing with seed-only data.
            if not satellites:
                raise RuntimeError("No satellites parsed from TLE sources")
            has_iss_tle = any(s.norad_id == 25544 and s.tle_line1 and s.tle_line2 for s in satellites)
            if not has_iss_tle:
                raise RuntimeError("ISS TLE missing from refreshed catalog")

            meta = {
                "count": len(satellites),
                "parsed_tle_records": len(parsed_tles),
                "sources": ["celestrak", "satnogs"],
                "includes_iss": any(s.is_iss for s in satellites),
            }
            refresh_meta["last_success_utc"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            refresh_meta["last_error"] = None
            refresh_meta["last_failure_utc"] = None
            refresh_meta["consecutive_failure_count"] = 0
            self._save_refresh_meta(refresh_meta)
            return satellites, meta
        except Exception as exc:
            refresh_meta["last_error"] = str(exc)
            refresh_meta["last_failure_utc"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            refresh_meta["consecutive_failure_count"] = int(refresh_meta.get("consecutive_failure_count") or 0) + 1
            self._save_refresh_meta(refresh_meta)
            raise

    def refresh_amsat_statuses(
        self,
        satellites: list[Satellite],
        timeout_seconds: float = 20.0,
        min_interval_hours: float = 12.0,
        report_window_hours: int = 96,
    ) -> dict[str, OperationalStatus]:
        allowed, reason = self._amsat_refresh_guard(min_interval_hours=min_interval_hours)
        if not allowed:
            cached = self._load_amsat_status_cache()
            if cached:
                return cached
            raise RuntimeError(reason or "AMSAT status refresh cooldown active")

        with httpx.Client(timeout=timeout_seconds, follow_redirects=True) as client:
            index_html = client.get(self.AMSAT_STATUS_INDEX_URL).text
            amsat_names = self._parse_amsat_satellite_names(index_html)
            statuses: dict[str, OperationalStatus] = {}
            for sat in satellites:
                matched_name = self._match_amsat_name(sat, amsat_names)
                if not matched_name:
                    continue
                response = client.get(
                    self.AMSAT_STATUS_API_URL,
                    params={"name": matched_name, "hours": report_window_hours},
                )
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, list):
                    continue
                statuses[sat.sat_id] = self._summarize_amsat_reports(matched_name, payload)

        if statuses:
            self._save_amsat_status_cache(statuses)
            refresh_meta = self._load_amsat_refresh_meta()
            refresh_meta["last_success_utc"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
            refresh_meta["satellite_count"] = len(statuses)
            self._save_amsat_refresh_meta(refresh_meta)
        return statuses

    def refresh_ephemeris(self, timeout_seconds: float = 30.0) -> dict[str, Any]:
        with httpx.Client(timeout=timeout_seconds, follow_redirects=True) as client:
            r = client.get(self.EPHEMERIS_URL)
            r.raise_for_status()
            self.eph_path.write_bytes(r.content)
        self._ephem_loaded = None
        self._ephem_ts = None
        return {"ok": True, "path": str(self.eph_path), "bytes": self.eph_path.stat().st_size}

    def _ensure_skyfield(self):
        try:
            from skyfield.api import load, wgs84  # type: ignore
        except Exception:
            return None, None, None
        return load, wgs84, True

    def _load_ephemeris(self):
        load, _, ok = self._ensure_skyfield()
        if not ok:
            return None
        if not self.eph_path.exists():
            return None
        if self._ephem_loaded is None:
            self._ephem_loaded = load(str(self.eph_path))
        if self._ephem_ts is None:
            self._ephem_ts = load.timescale()
        return self._ephem_loaded

    def body_positions(self, now: datetime, lat: float, lon: float, alt_m: float) -> list[dict[str, Any]]:
        load, wgs84, ok = self._ensure_skyfield()
        if not ok:
            return []

        eph = self._load_ephemeris()
        if eph is None:
            return []

        ts = self._ephem_ts or load.timescale()
        t = ts.from_datetime(now.astimezone(UTC).replace(tzinfo=UTC))
        observer = eph["earth"] + wgs84.latlon(latitude_degrees=lat, longitude_degrees=lon, elevation_m=alt_m)

        names = [
            ("Sun", "sun", "#ffd54f"),
            ("Moon", "moon", "#c5d9ff"),
            ("Mercury", "mercury", "#d4b483"),
            ("Venus", "venus", "#f2deb6"),
            ("Mars", "mars", "#e89a79"),
            ("Jupiter", "jupiter barycenter", "#d7c49f"),
            ("Saturn", "saturn barycenter", "#d9cf9f"),
        ]
        out: list[dict[str, Any]] = []
        for label, key, color in names:
            if key not in eph:
                continue
            alt, az, _ = observer.at(t).observe(eph[key]).apparent().altaz()
            out.append(
                {
                    "name": label,
                    "az_deg": round(float(az.degrees), 2),
                    "el_deg": round(float(alt.degrees), 2),
                    "color": color,
                    "visible": float(alt.degrees) > 0,
                }
            )
        return out

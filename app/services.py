from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from app.models import (
    AppSettings,
    CachePolicy,
    CachePolicyUpdate,
    IssDisplayMode,
    IssState,
    LiveTrack,
    LocationProfile,
    LocationSourceMode,
    LocationState,
    LocationUpdate,
    NetworkMode,
    NetworkState,
    NetworkUpdate,
    PassEvent,
    Satellite,
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
        self._satellites = self._filter_amateur_catalog(self._ensure_iss(self._load_cached_catalog()))
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
            return items if items else SEED_SATELLITES
        except Exception:
            return SEED_SATELLITES

    def _save_cached_catalog(self) -> None:
        with self.cache_path.open("w", encoding="utf-8") as f:
            json.dump([s.model_dump(mode="json") for s in self._satellites], f, indent=2)

    def satellites(self) -> list[Satellite]:
        return [s.model_copy(deep=True) for s in self._satellites]

    def _is_amateur_satellite(self, sat: Satellite) -> bool:
        if sat.is_iss:
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
        self._satellites = self._filter_amateur_catalog(self._ensure_iss(satellites))
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

    def live_tracks(self, now: datetime, location: ResolvedLocation) -> list[LiveTrack]:
        tracks: list[LiveTrack] = []
        for sat in self._satellites:
            tle_track = self._live_track_from_tle(sat, now, location)
            if tle_track is not None:
                tracks.append(tle_track)
                continue
            phase = self._phase(sat, now)
            sin_term = math.sin(2 * math.pi * phase)
            cos_term = math.cos(2 * math.pi * phase)
            el = max(-15.0, 90.0 * sin_term)
            az = (phase * 360.0 + sat.norad_id % 180 + location.lon * 0.2) % 360.0
            range_km = 2200.0 - max(0.0, sin_term) * 1600.0
            range_rate = -7.5 * cos_term
            tracks.append(
                LiveTrack(
                    sat_id=sat.sat_id,
                    name=sat.name,
                    timestamp=now,
                    az_deg=round(az, 2),
                    el_deg=round(el, 2),
                    range_km=round(range_km, 1),
                    range_rate_km_s=round(range_rate, 3),
                    sunlit=self._sunlit(sat, now, location),
                    subpoint_lat=round(-50.0 + 100.0 * sin_term, 4),
                    subpoint_lon=round(((phase * 360.0) % 360.0) - 180.0, 4),
                )
            )
        return tracks

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


class DataIngestionService:
    CELESTRAK_AMATEUR_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle"
    CELESTRAK_STATIONS_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle"
    SATNOGS_TRANSMITTERS_URL = "https://db.satnogs.org/api/transmitters/?alive=true&format=json"
    EPHEMERIS_URL = "https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de421.bsp"

    def __init__(self, eph_path: str = "data/ephemeris/de421.bsp") -> None:
        self.eph_path = Path(eph_path)
        self.eph_path.parent.mkdir(parents=True, exist_ok=True)
        self.refresh_meta_path = Path("data/snapshots/catalog_refresh_meta.json")
        self.refresh_meta_path.parent.mkdir(parents=True, exist_ok=True)
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

    def refresh_catalog(
        self,
        timeout_seconds: float = 10.0,
        min_interval_hours: float = 3.0,
    ) -> tuple[list[Satellite], dict]:
        allowed, reason = self._catalog_refresh_guard(min_interval_hours=min_interval_hours)
        if not allowed:
            raise RuntimeError(reason or "Catalog refresh cooldown active")

        with httpx.Client(timeout=timeout_seconds) as client:
            amateur_tle = client.get(self.CELESTRAK_AMATEUR_URL).text
            stations_tle = client.get(self.CELESTRAK_STATIONS_URL).text
            satnogs = client.get(self.SATNOGS_TRANSMITTERS_URL).json()

        transponders_by_norad: dict[int, list[str]] = {}
        repeaters_by_norad: dict[int, list[str]] = {}
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
        refresh_meta = self._load_refresh_meta()
        refresh_meta["last_success_utc"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        self._save_refresh_meta(refresh_meta)
        return satellites, meta

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

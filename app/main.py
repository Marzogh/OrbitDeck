from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo
from zoneinfo import available_timezones

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.device import lite_only_ui
from app.models import (
    CachePolicyUpdate,
    DeveloperOverridesUpdate,
    DatasetSnapshot,
    GpsSettingsUpdate,
    IssDisplayMode,
    LiteSettingsUpdate,
    LocationSourceMode,
    LocationUpdate,
    NetworkUpdate,
    PassFilterUpdate,
    PassProfileMode,
    RadioApplyRequest,
    RadioAutoTrackStartRequest,
    RadioFrequencySetRequest,
    RadioPairSetRequest,
    RadioRigModel,
    RadioSettings,
    RadioSettingsUpdate,
    SettingsUpdate,
    TimezoneUpdate,
)
from app.radio.civ import normalize_civ_address
from app.radio.service import RigControlService
from app.services import (
    CacheService,
    DataIngestionService,
    FrequencyGuideService,
    IssService,
    LocationService,
    NetworkService,
    TrackingService,
)
from app.store import StateStore

store = StateStore()
location_service = LocationService()
tracking_service = TrackingService()
iss_service = IssService()
network_service = NetworkService()
cache_service = CacheService()
ingestion_service = DataIngestionService()
frequency_guide_service = FrequencyGuideService()
radio_control_service = RigControlService()
_refresh_task: asyncio.Task | None = None
_lite_snapshot_cache: dict[tuple, tuple[datetime, dict]] = {}


def _resolve_location(source_override: LocationSourceMode | None = None):
    state = store.get()
    location_state = state.location.model_copy(deep=True)
    if source_override is not None:
        location_state.source_mode = source_override
    resolved = location_service.resolve(location_state)
    return state, resolved


def _pick_iss_track(tracks):
    return next(
        (
            t
            for t in tracks
            if t.sat_id == "iss" or "ISS" in t.name.upper() or "ZARYA" in t.name.upper()
        ),
        None,
    )


def _pick_active_track(tracks, sat_id: str | None):
    if sat_id:
        chosen = next((t for t in tracks if t.sat_id == sat_id), None)
        if chosen is not None:
            return chosen
    return _pick_iss_track(tracks)


def _pass_sat_ids(settings) -> set[str]:
    if settings.pass_profile == PassProfileMode.favorites:
        ids = {x for x in settings.pass_sat_ids if isinstance(x, str) and x.strip()}
        if ids:
            return ids
    return {"iss-zarya"}


def _is_valid_timezone(tz_name: str) -> bool:
    if tz_name == "UTC":
        return True
    try:
        ZoneInfo(tz_name)
        return True
    except Exception:
        return False


def _tracked_sat_ids(state) -> set[str]:
    valid_ids = {sat.sat_id for sat in tracking_service.satellites()}
    cleaned: list[str] = []
    seen: set[str] = set()
    for sat_id in state.lite_settings.tracked_sat_ids:
        if not isinstance(sat_id, str):
            continue
        sat_id = sat_id.strip()
        if not sat_id or sat_id in seen or sat_id not in valid_ids:
            continue
        seen.add(sat_id)
        cleaned.append(sat_id)
    if not cleaned:
        cleaned = ["iss-zarya"] if "iss-zarya" in valid_ids else sorted(valid_ids)[:1]
    return set(cleaned)


def _apply_lite_settings_update(state, payload: LiteSettingsUpdate):
    valid_ids = {sat.sat_id for sat in tracking_service.satellites()}
    cleaned: list[str] = []
    seen: set[str] = set()
    for sat_id in payload.tracked_sat_ids:
        sat_id = str(sat_id or "").strip()
        if not sat_id or sat_id in seen or sat_id not in valid_ids:
            continue
        seen.add(sat_id)
        cleaned.append(sat_id)
    if not cleaned:
        raise HTTPException(status_code=400, detail="tracked_sat_ids must include at least one valid satellite")
    if len(cleaned) > 8:
        raise HTTPException(status_code=400, detail="tracked_sat_ids may contain at most 8 satellites")
    state.lite_settings.tracked_sat_ids = cleaned
    state.lite_settings.setup_complete = payload.setup_complete
    return state


def _radio_defaults_for_model(model: RadioRigModel) -> tuple[int, str]:
    if model == RadioRigModel.ic705:
        return 19200, "0xA4"
    return 19200, "0x8C"


def _apply_radio_settings_update(current: RadioSettings, payload: RadioSettingsUpdate) -> RadioSettings:
    next_settings = current.model_copy(deep=True)
    previous_model = next_settings.rig_model
    if payload.enabled is not None:
        next_settings.enabled = payload.enabled
    if payload.rig_model is not None:
        next_settings.rig_model = payload.rig_model
    if payload.serial_device is not None:
        next_settings.serial_device = payload.serial_device.strip()
    if payload.baud_rate is not None:
        next_settings.baud_rate = payload.baud_rate
    if payload.civ_address is not None:
        next_settings.civ_address = normalize_civ_address(payload.civ_address.strip())
    if payload.poll_interval_ms is not None:
        next_settings.poll_interval_ms = payload.poll_interval_ms
    if payload.auto_connect is not None:
        next_settings.auto_connect = payload.auto_connect
    if payload.auto_track_interval_ms is not None:
        next_settings.auto_track_interval_ms = payload.auto_track_interval_ms
    if payload.default_apply_mode_and_tone is not None:
        next_settings.default_apply_mode_and_tone = payload.default_apply_mode_and_tone
    if payload.safe_tx_guard_enabled is not None:
        next_settings.safe_tx_guard_enabled = payload.safe_tx_guard_enabled
    if payload.rig_model is not None and payload.rig_model != previous_model:
        baud, civ = _radio_defaults_for_model(payload.rig_model)
        if payload.baud_rate is None:
            next_settings.baud_rate = baud
        if payload.civ_address is None:
            next_settings.civ_address = civ
    else:
        next_settings.civ_address = normalize_civ_address(next_settings.civ_address)
    return next_settings


def _pick_focus_pass(passes, sat_id: str | None):
    if sat_id:
        chosen = next((p for p in passes if p.sat_id == sat_id), None)
        if chosen is not None:
            return chosen
    now = datetime.now(UTC)
    ongoing = next((p for p in passes if p.aos <= now <= p.los), None)
    if ongoing is not None:
        return ongoing
    return passes[0] if passes else None


def _focus_track_path(location, focus_pass, focus_sat_id: str | None):
    if focus_pass is None or not focus_sat_id:
        return []
    duration_minutes = max(1, int((focus_pass.los - focus_pass.aos).total_seconds() / 60))
    return tracking_service.track_path(
        datetime.now(UTC),
        duration_minutes,
        location,
        sat_id=focus_sat_id,
        step_seconds=30,
        start_time=focus_pass.aos,
    )


def _frequency_bundle(
    location,
    sat_id: str | None,
    pass_event,
    current_track,
    now: datetime | None = None,
) -> tuple[list, object | None, object | None]:
    if not sat_id:
        return [], None, None
    track_path = _focus_track_path(location, pass_event, sat_id)
    current = now or datetime.now(UTC)
    recommendation = frequency_guide_service.recommendation(
        sat_id,
        pass_event,
        current_track=current_track,
        track_path=track_path,
        now=current,
    )
    matrix = None
    if recommendation is not None and recommendation.mode.value == "linear":
        matrix = frequency_guide_service.matrix(
            sat_id,
            pass_event=pass_event,
            current_track=current_track,
            track_path=track_path,
            selected_column_index=recommendation.selected_column_index,
            active_phase=recommendation.phase,
        )
    return track_path, recommendation, matrix


def _resolve_recommendation_for_radio(
    sat_id: str,
    location_source: LocationSourceMode | None = None,
    selected_column_index: int | None = None,
):
    _, location = _resolve_location(location_source)
    now = datetime.now(UTC)
    tracks = tracking_service.live_tracks(now, location, sat_ids={sat_id})
    current_track = tracks[0] if tracks else None
    passes = tracking_service.pass_predictions(
        now,
        24,
        location,
        sat_ids={sat_id},
        include_ongoing=True,
    )
    focus_pass = _pick_focus_pass(passes, sat_id)
    track_path = _focus_track_path(location, focus_pass, sat_id)
    recommendation = frequency_guide_service.recommendation(
        sat_id,
        focus_pass,
        current_track=current_track,
        track_path=track_path,
        selected_column_index=selected_column_index,
        now=now,
    )
    return recommendation, focus_pass


def _serialize_passes_with_frequency(location, now: datetime, passes, tracks_by_sat: dict[str, object]) -> list[dict]:
    items: list[dict] = []
    track_path_cache: dict[tuple[str, str, str], list] = {}
    for pass_event in passes:
        sat_id = pass_event.sat_id
        cache_key = (sat_id, pass_event.aos.isoformat(), pass_event.los.isoformat())
        track_path = track_path_cache.get(cache_key)
        if track_path is None:
            track_path, recommendation, matrix = _frequency_bundle(
                location,
                sat_id,
                pass_event,
                tracks_by_sat.get(sat_id),
                now=now,
            )
            track_path_cache[cache_key] = track_path
        else:
            recommendation = frequency_guide_service.recommendation(
                sat_id,
                pass_event,
                current_track=tracks_by_sat.get(sat_id),
                track_path=track_path,
                now=now,
            )
            matrix = None
            if recommendation is not None and recommendation.mode.value == "linear":
                matrix = frequency_guide_service.matrix(
                    sat_id,
                    pass_event=pass_event,
                    current_track=tracks_by_sat.get(sat_id),
                    track_path=track_path,
                    selected_column_index=recommendation.selected_column_index,
                    active_phase=recommendation.phase,
                )
        item = pass_event.model_dump(mode="json")
        item["frequencyRecommendation"] = recommendation.model_dump(mode="json") if recommendation is not None else None
        item["frequencyMatrix"] = matrix.model_dump(mode="json") if matrix is not None else None
        items.append(item)
    return items


def _lite_snapshot(
    state,
    location,
    sat_id: str | None,
    location_source: LocationSourceMode | None,
) -> dict:
    tracked_ids = _tracked_sat_ids(state)
    cache_key = (
        tuple(sorted(tracked_ids)),
        sat_id or "",
        location_source.value if location_source is not None else "",
        round(location.lat, 4),
        round(location.lon, 4),
        round(location.alt_m, 1),
    )
    cached = _lite_snapshot_cache.get(cache_key)
    now = datetime.now(UTC)
    if cached is not None:
        cached_at, payload = cached
        if now - cached_at < timedelta(seconds=15):
            return payload

    tracks = tracking_service.live_tracks(now, location, sat_ids=tracked_ids)
    track_by_sat = {track.sat_id: track for track in tracks}
    tracked_sats = [sat for sat in tracking_service.satellites() if sat.sat_id in tracked_ids]

    iss_track = track_by_sat.get("iss-zarya")
    if iss_track is None:
        iss_tracks = tracking_service.live_tracks(now, location, sat_ids={"iss-zarya"})
        iss_track = _pick_iss_track(iss_tracks)
    if iss_track is None:
        raise HTTPException(status_code=500, detail="ISS track unavailable after recovery")

    iss_state = iss_service.state(state.settings, iss_track)
    passes = tracking_service.pass_predictions(
        now,
        24,
        location,
        sat_ids=tracked_ids,
        include_ongoing=True,
    )
    focus_track = _pick_active_track(tracks, sat_id)
    focus_pass = _pick_focus_pass(passes, sat_id or (focus_track.sat_id if focus_track else None))
    if focus_track is None and focus_pass is not None:
        focus_track = track_by_sat.get(focus_pass.sat_id)
    if focus_track is None and tracks:
        focus_track = tracks[0]

    focus_sat_id = sat_id or (focus_track.sat_id if focus_track else None) or (focus_pass.sat_id if focus_pass else None)
    focus_sat = next((sat for sat in tracked_sats if sat.sat_id == focus_sat_id), None)
    focus_track_path = _focus_track_path(location, focus_pass, focus_sat_id)

    focus_cue = None
    if focus_pass is not None and now < focus_pass.aos:
        if focus_track_path:
            cue = min(focus_track_path, key=lambda item: abs((item.timestamp - focus_pass.aos).total_seconds()))
            focus_cue = {
                "type": "aos",
                "label": "AOS cue",
                "sat_id": focus_pass.sat_id,
                "time": focus_pass.aos,
                "az_deg": cue.az_deg,
                "el_deg": cue.el_deg,
            }

    focus_track_path, frequency_recommendation, frequency_matrix = _frequency_bundle(
        location,
        focus_sat_id,
        focus_pass,
        focus_track,
        now=now,
    )

    payload = {
        "timestamp": now,
        "location": location.__dict__,
        "network": state.network,
        "iss": iss_state,
        "issTrack": iss_track,
        "trackedSatIds": sorted(tracked_ids),
        "trackedSatellites": tracked_sats,
        "tracks": tracks,
        "passes": passes,
        "focusSatId": focus_sat_id,
        "focusSatellite": focus_sat,
        "focusTrack": focus_track,
        "focusTrackPath": focus_track_path,
        "focusPass": focus_pass,
        "focusCue": focus_cue,
        "frequencyRecommendation": frequency_recommendation,
        "frequencyMatrix": frequency_matrix,
        "timezone": {"timezone": state.settings.display_timezone},
        "gpsSettings": {"state": state.gps_settings},
        "liteSettings": state.lite_settings,
    }
    _lite_snapshot_cache[cache_key] = (now, payload)
    return payload


async def _periodic_refresh_loop() -> None:
    while True:
        await asyncio.sleep(6 * 60 * 60)
        try:
            satellites, _ = ingestion_service.refresh_catalog()
            tracking_service.replace_catalog(satellites)
            with suppress(Exception):
                ingestion_service.refresh_ephemeris()
            with suppress(Exception):
                statuses = ingestion_service.refresh_amsat_statuses(tracking_service.satellites())
                tracking_service.merge_operational_statuses(statuses)
        except Exception:
            # Non-fatal background refresh failure.
            pass


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    global _refresh_task
    with suppress(Exception):
        tracking_service.merge_operational_statuses(ingestion_service.cached_amsat_statuses())
    _refresh_task = asyncio.create_task(_periodic_refresh_loop())
    try:
        yield
    finally:
        if _refresh_task is not None:
            _refresh_task.cancel()
            with suppress(asyncio.CancelledError):
                await _refresh_task
            _refresh_task = None


app = FastAPI(title="OrbitDeck", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory="app/static"), name="static")


@app.get("/")
def kiosk_index() -> FileResponse:
    if lite_only_ui():
        return FileResponse("app/static/lite/index.html")
    return FileResponse("app/static/kiosk/rotator.html")


@app.get("/kiosk")
def legacy_kiosk_index() -> FileResponse:
    if lite_only_ui():
        return FileResponse("app/static/lite/index.html")
    return FileResponse("app/static/kiosk/index.html")


@app.get("/lite")
def lite_index() -> FileResponse:
    return FileResponse("app/static/lite/index.html")


@app.get("/lite/settings")
def lite_settings_index() -> FileResponse:
    return FileResponse("app/static/lite/settings.html")


@app.get("/settings")
def settings_index() -> FileResponse:
    if lite_only_ui():
        return FileResponse("app/static/lite/settings.html")
    return FileResponse("app/static/kiosk/settings.html")


@app.get("/radio")
def radio_index() -> FileResponse:
    return FileResponse("app/static/kiosk/radio.html")


@app.get("/kiosk-rotator")
def kiosk_rotator_index() -> FileResponse:
    if lite_only_ui():
        return FileResponse("app/static/lite/index.html")
    return FileResponse("app/static/kiosk/rotator.html")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "timestamp": datetime.now(UTC)}


@app.get("/api/v1/satellites")
def get_satellites(refresh_from_sources: bool = Query(default=False)) -> dict:
    refreshed = False
    ephemeris_refreshed = False
    refresh_error = None
    if refresh_from_sources:
        try:
            satellites, _ = ingestion_service.refresh_catalog()
            tracking_service.replace_catalog(satellites)
            _lite_snapshot_cache.clear()
            with suppress(Exception):
                ingestion_service.refresh_ephemeris(timeout_seconds=8.0)
                ephemeris_refreshed = True
            with suppress(Exception):
                statuses = ingestion_service.refresh_amsat_statuses(tracking_service.satellites(), timeout_seconds=8.0)
                tracking_service.merge_operational_statuses(statuses)
            refreshed = True
        except Exception as exc:
            refresh_error = str(exc)
    satellites = tracking_service.satellites()
    return {
        "count": len(satellites),
        "items": satellites,
        "refreshed": refreshed,
        "ephemerisRefreshed": ephemeris_refreshed,
        "refreshError": refresh_error,
    }


@app.get("/api/v1/live")
def get_live(location_source: LocationSourceMode | None = Query(default=None)) -> dict:
    _, location = _resolve_location(location_source)
    now = datetime.now(UTC)
    tracks = tracking_service.live_tracks(now, location)
    return {
        "timestamp": now,
        "location": location.__dict__,
        "count": len(tracks),
        "items": tracks,
    }


@app.get("/api/v1/track/path")
def get_track_path(
    sat_id: str = Query(min_length=1),
    minutes: int = Query(default=18, ge=1, le=240),
    step_seconds: int = Query(default=45, ge=10, le=300),
    start_time: datetime | None = Query(default=None),
    location_source: LocationSourceMode | None = Query(default=None),
) -> dict:
    _, location = _resolve_location(location_source)
    now = datetime.now(UTC)
    items = tracking_service.track_path(
        now,
        minutes,
        location,
        sat_id=sat_id,
        step_seconds=step_seconds,
        start_time=start_time,
    )
    return {
        "timestamp": now,
        "location": location.__dict__,
        "sat_id": sat_id,
        "minutes": minutes,
        "step_seconds": step_seconds,
        "start_time": start_time or now,
        "count": len(items),
        "items": items,
    }


@app.get("/api/v1/passes")
def get_passes(
    hours: int = Query(default=24, ge=1, le=168),
    location_source: LocationSourceMode | None = Query(default=None),
    min_max_el: float = Query(default=0.0, ge=0.0, le=90.0),
    include_all_sats: bool = Query(default=False),
    include_ongoing: bool = Query(default=False),
) -> dict:
    state, location = _resolve_location(location_source)
    now = datetime.now(UTC)
    sat_ids = None if include_all_sats else _pass_sat_ids(state.settings)
    passes = tracking_service.pass_predictions(
        now,
        hours,
        location,
        sat_ids=sat_ids,
        include_ongoing=include_ongoing,
    )
    if min_max_el > 0:
        passes = [p for p in passes if p.max_el_deg >= min_max_el]
    track_sat_ids = {p.sat_id for p in passes}
    tracks = tracking_service.live_tracks(now, location, sat_ids=track_sat_ids) if track_sat_ids else []
    tracks_by_sat = {track.sat_id: track for track in tracks}
    items = _serialize_passes_with_frequency(location, now, passes, tracks_by_sat)
    return {
        "timestamp": now,
        "location": location.__dict__,
        "hours": hours,
        "min_max_el": min_max_el,
        "count": len(items),
        "items": items,
    }


@app.get("/api/v1/settings/iss-display-mode")
def get_iss_display_mode() -> dict:
    state = store.get()
    return {"mode": state.settings.iss_display_mode}


@app.post("/api/v1/settings/iss-display-mode")
def set_iss_display_mode(payload: SettingsUpdate) -> dict:
    state = store.get()
    state.settings.iss_display_mode = payload.mode
    store.save(state)
    _lite_snapshot_cache.clear()
    return {"mode": state.settings.iss_display_mode}


@app.get("/api/v1/settings/timezone")
def get_timezone() -> dict:
    state = store.get()
    return {"timezone": state.settings.display_timezone}


@app.get("/api/v1/settings/timezones")
def get_timezones() -> dict:
    return {"timezones": sorted(available_timezones())}


@app.post("/api/v1/settings/timezone")
def set_timezone(payload: TimezoneUpdate) -> dict:
    tz = (payload.timezone or "").strip()
    if not _is_valid_timezone(tz):
        raise HTTPException(status_code=400, detail=f"invalid timezone: {tz}")
    state = store.get()
    state.settings.display_timezone = tz
    store.save(state)
    _lite_snapshot_cache.clear()
    return {"timezone": state.settings.display_timezone}


@app.get("/api/v1/settings/developer-overrides")
def get_developer_overrides() -> dict:
    state = store.get()
    return {"state": state.settings.developer_overrides}


@app.post("/api/v1/settings/developer-overrides")
def set_developer_overrides(payload: DeveloperOverridesUpdate) -> dict:
    state = store.get()
    state.settings.developer_overrides = payload
    store.save(state)
    return {"state": state.settings.developer_overrides}


@app.get("/api/v1/settings/pass-filter")
def get_pass_filter() -> dict:
    state = store.get()
    return {"profile": state.settings.pass_profile, "satIds": state.settings.pass_sat_ids}


@app.post("/api/v1/settings/pass-filter")
def set_pass_filter(payload: PassFilterUpdate) -> dict:
    state = store.get()
    state.settings.pass_profile = payload.profile
    if payload.sat_ids is not None:
        cleaned = [s for s in payload.sat_ids if isinstance(s, str) and s.strip()]
        state.settings.pass_sat_ids = cleaned
    if state.settings.pass_profile == PassProfileMode.iss_only:
        state.settings.pass_sat_ids = ["iss-zarya"]
    elif not state.settings.pass_sat_ids:
        state.settings.pass_sat_ids = ["iss-zarya"]
    store.save(state)
    _lite_snapshot_cache.clear()
    return {"profile": state.settings.pass_profile, "satIds": state.settings.pass_sat_ids}


@app.get("/api/v1/settings/lite")
def get_lite_settings() -> dict:
    state = store.get()
    return {"state": state.lite_settings, "availableSatellites": tracking_service.satellites()}


@app.post("/api/v1/settings/lite")
def post_lite_settings(payload: LiteSettingsUpdate) -> dict:
    state = store.get()
    state = _apply_lite_settings_update(state, payload)
    store.save(state)
    _lite_snapshot_cache.clear()
    return {"state": state.lite_settings}


@app.get("/api/v1/iss/state")
def get_iss_state(location_source: LocationSourceMode | None = Query(default=None)) -> dict:
    state, location = _resolve_location(location_source)
    now = datetime.now(UTC)
    tracks = tracking_service.live_tracks(now, location)
    iss_track = _pick_iss_track(tracks)
    if iss_track is None:
        tracking_service.replace_catalog(tracking_service.satellites())
        tracks = tracking_service.live_tracks(now, location)
        iss_track = _pick_iss_track(tracks)
    if iss_track is None:
        raise HTTPException(status_code=500, detail="ISS track unavailable after recovery")
    iss_state = iss_service.state(state.settings, iss_track)
    return {
        "timestamp": now,
        "location": location.__dict__,
        "issTrack": iss_track,
        "state": iss_state,
    }


@app.get("/api/v1/location")
def get_location() -> dict:
    state = store.get()
    resolved = location_service.resolve(state.location)
    return {"state": state.location, "resolved": resolved.__dict__}


@app.post("/api/v1/location")
def post_location(payload: LocationUpdate) -> dict:
    state = store.get()
    state.location = location_service.apply_update(state.location, payload)
    store.save(state)
    _lite_snapshot_cache.clear()
    resolved = location_service.resolve(state.location)
    return {"state": state.location, "resolved": resolved.__dict__}


@app.get("/api/v1/network")
def get_network() -> dict:
    state = store.get()
    return {"state": state.network}


@app.post("/api/v1/network")
def post_network(payload: NetworkUpdate) -> dict:
    state = store.get()
    state.network = network_service.apply_update(state.network, payload)
    store.save(state)
    _lite_snapshot_cache.clear()
    return {"state": state.network}


@app.get("/api/v1/settings/gps")
def get_gps_settings() -> dict:
    state = store.get()
    return {"state": state.gps_settings}


@app.post("/api/v1/settings/gps")
def post_gps_settings(payload: GpsSettingsUpdate) -> dict:
    state = store.get()
    next_settings = state.gps_settings.model_copy(deep=True)
    if payload.connection_mode is not None:
        next_settings.connection_mode = payload.connection_mode
    if payload.serial_device is not None:
        next_settings.serial_device = payload.serial_device.strip()
    if payload.baud_rate is not None:
        next_settings.baud_rate = payload.baud_rate
    if payload.bluetooth_address is not None:
        next_settings.bluetooth_address = payload.bluetooth_address.strip()
    if payload.bluetooth_channel is not None:
        next_settings.bluetooth_channel = payload.bluetooth_channel
    state.gps_settings = next_settings
    store.save(state)
    _lite_snapshot_cache.clear()
    return {"state": state.gps_settings}


@app.get("/api/v1/settings/radio")
def get_radio_settings() -> dict:
    state = store.get()
    return {"state": state.radio_settings}


@app.post("/api/v1/settings/radio")
def post_radio_settings(payload: RadioSettingsUpdate) -> dict:
    state = store.get()
    try:
        state.radio_settings = _apply_radio_settings_update(state.radio_settings, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    store.save(state)
    return {"state": state.radio_settings}


@app.get("/api/v1/cache-policy")
def get_cache_policy() -> dict:
    state = store.get()
    return {"state": state.cache_policy, "snapshots": state.snapshots}


@app.post("/api/v1/cache-policy")
def post_cache_policy(payload: CachePolicyUpdate) -> dict:
    state = store.get()
    state.cache_policy = cache_service.apply_policy(state.cache_policy, payload)
    store.save(state)
    return {"state": state.cache_policy}


@app.post("/api/v1/snapshots/record")
def record_snapshot(source: str, satellite_count: int) -> dict:
    if source not in {"seed", "celestrak", "satnogs", "merged"}:
        raise HTTPException(status_code=400, detail="invalid snapshot source")
    state = store.get()
    snapshot = DatasetSnapshot(
        id=f"snap-{int(datetime.now(UTC).timestamp())}",
        source=source,
        created_at=datetime.now(UTC),
        satellite_count=satellite_count,
    )
    state.snapshots = [snapshot] + state.snapshots[:31]
    store.save(state)
    return {"snapshot": snapshot, "total": len(state.snapshots)}


@app.get("/api/v1/lite/snapshot")
def get_lite_snapshot(
    location_source: LocationSourceMode | None = Query(default=None),
    sat_id: str | None = Query(default=None),
) -> dict:
    state, location = _resolve_location(location_source)
    return _lite_snapshot(state, location, sat_id, location_source)


@app.get("/api/v1/frequency-guides/recommendation")
def get_frequency_guide_recommendation(
    sat_id: str = Query(min_length=1),
    location_source: LocationSourceMode | None = Query(default=None),
) -> dict:
    _, location = _resolve_location(location_source)
    now = datetime.now(UTC)
    tracks = tracking_service.live_tracks(now, location, sat_ids={sat_id})
    current_track = tracks[0] if tracks else None
    passes = tracking_service.pass_predictions(
        now,
        24,
        location,
        sat_ids={sat_id},
        include_ongoing=True,
    )
    focus_pass = _pick_focus_pass(passes, sat_id)
    track_path = _focus_track_path(location, focus_pass, sat_id)
    recommendation = frequency_guide_service.recommendation(
        sat_id,
        focus_pass,
        current_track=current_track,
        track_path=track_path,
        now=now,
    )
    matrix = None
    if recommendation is not None and recommendation.mode.value == "linear":
        matrix = frequency_guide_service.matrix(
            sat_id,
            pass_event=focus_pass,
            current_track=current_track,
            track_path=track_path,
            selected_column_index=recommendation.selected_column_index,
            active_phase=recommendation.phase,
        )
    return {
        "timestamp": now,
        "sat_id": sat_id,
        "pass": focus_pass,
        "track": current_track,
        "recommendation": recommendation,
        "matrix": matrix,
    }


@app.get("/api/v1/radio/state")
def get_radio_state() -> dict:
    state = store.get()
    return {"settings": state.radio_settings, "runtime": radio_control_service.runtime()}


@app.post("/api/v1/radio/connect")
def connect_radio() -> dict:
    state = store.get()
    runtime = radio_control_service.connect(state.radio_settings)
    return {"settings": state.radio_settings, "runtime": runtime}


@app.post("/api/v1/radio/disconnect")
def disconnect_radio() -> dict:
    runtime = radio_control_service.disconnect()
    state = store.get()
    return {"settings": state.radio_settings, "runtime": runtime}


@app.post("/api/v1/radio/poll")
def poll_radio() -> dict:
    state = store.get()
    runtime = radio_control_service.poll(state.radio_settings)
    return {"settings": state.radio_settings, "runtime": runtime}


@app.post("/api/v1/radio/frequency")
def set_radio_frequency(payload: RadioFrequencySetRequest) -> dict:
    state = store.get()
    try:
        runtime, result = radio_control_service.set_frequency(payload, state.radio_settings)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"settings": state.radio_settings, "runtime": runtime, "result": result}


@app.post("/api/v1/radio/pair")
def set_radio_pair(payload: RadioPairSetRequest) -> dict:
    state = store.get()
    try:
        runtime, recommendation, mapping = radio_control_service.apply_manual_pair(payload, state.radio_settings)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "settings": state.radio_settings,
        "runtime": runtime,
        "recommendation": recommendation,
        "targetMapping": mapping,
        "appliedAt": datetime.now(UTC),
    }


@app.post("/api/v1/radio/apply")
def apply_radio_target(payload: RadioApplyRequest) -> dict:
    state = store.get()
    try:
        runtime, recommendation, mapping = radio_control_service.apply(
            payload,
            state.radio_settings,
            _resolve_recommendation_for_radio,
        )
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "runtime": runtime,
        "recommendation": recommendation,
        "targetMapping": mapping,
        "appliedAt": datetime.now(UTC),
    }


@app.post("/api/v1/radio/auto-track/start")
def start_radio_auto_track(payload: RadioAutoTrackStartRequest) -> dict:
    state = store.get()
    try:
        runtime = radio_control_service.start_auto_track(
            payload,
            state.radio_settings,
            _resolve_recommendation_for_radio,
            interval_ms=payload.interval_ms,
        )
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"runtime": runtime}


@app.post("/api/v1/radio/auto-track/stop")
def stop_radio_auto_track() -> dict:
    return {"runtime": radio_control_service.stop_auto_track()}


@app.get("/api/v1/system/state")
def get_system_state(
    location_source: LocationSourceMode | None = Query(default=None),
    sat_id: str | None = Query(default=None),
) -> dict:
    state, location = _resolve_location(location_source)
    now = datetime.now(UTC)
    tracks = tracking_service.live_tracks(now, location)
    iss_track = _pick_iss_track(tracks)
    if iss_track is None:
        tracking_service.replace_catalog(tracking_service.satellites())
        tracks = tracking_service.live_tracks(now, location)
        iss_track = _pick_iss_track(tracks)
    if iss_track is None:
        raise HTTPException(status_code=500, detail="ISS track unavailable after recovery")
    iss_state = iss_service.state(state.settings, iss_track)
    active_track = _pick_active_track(tracks, sat_id)
    if active_track is None:
        active_track = iss_track
    active_passes = tracking_service.pass_predictions(
        now,
        24,
        location,
        sat_ids={active_track.sat_id} if active_track is not None else None,
        include_ongoing=True,
    ) if active_track is not None else []
    active_pass = _pick_focus_pass(active_passes, active_track.sat_id if active_track is not None else None)
    active_track_path, frequency_recommendation, frequency_matrix = _frequency_bundle(
        location,
        active_track.sat_id if active_track is not None else None,
        active_pass,
        active_track,
        now=now,
    )
    bodies = []
    if hasattr(ingestion_service, "body_positions"):
        with suppress(Exception):
            bodies = ingestion_service.body_positions(now, location.lat, location.lon, location.alt_m)
    return {
        "timestamp": now,
        "location": location.__dict__,
        "settings": state.settings,
        "radioSettings": state.radio_settings,
        "radioRuntime": radio_control_service.runtime(),
        "network": state.network,
        "cachePolicy": state.cache_policy,
        "iss": iss_state,
        "issTrack": iss_track,
        "activeTrack": active_track,
        "tracks": tracks,
        "activePass": active_pass,
        "activeTrackPath": active_track_path,
        "frequencyRecommendation": frequency_recommendation,
        "frequencyMatrix": frequency_matrix,
        "bodies": bodies,
    }


@app.post("/api/v1/datasets/refresh")
def refresh_datasets() -> dict:
    state = store.get()
    try:
        satellites, meta = ingestion_service.refresh_catalog()
        tracking_service.replace_catalog(satellites)
        _lite_snapshot_cache.clear()
        ephem = {"ok": False}
        with suppress(Exception):
            ephem = ingestion_service.refresh_ephemeris()
        with suppress(Exception):
            statuses = ingestion_service.refresh_amsat_statuses(tracking_service.satellites())
            tracking_service.merge_operational_statuses(statuses)
        snapshot = DatasetSnapshot(
            id=f"snap-{int(datetime.now(UTC).timestamp())}",
            source="merged",
            created_at=datetime.now(UTC),
            satellite_count=len(satellites),
        )
        state.snapshots = [snapshot] + state.snapshots[:31]
        store.save(state)
        return {"ok": True, "meta": meta, "ephemeris": ephem, "snapshot": snapshot}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "fallbackCount": len(tracking_service.satellites())}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=False)

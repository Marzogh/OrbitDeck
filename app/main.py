from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import UTC, datetime

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.models import (
    CachePolicyUpdate,
    DatasetSnapshot,
    IssDisplayMode,
    LocationSourceMode,
    LocationUpdate,
    NetworkUpdate,
    SettingsUpdate,
)
from app.services import (
    CacheService,
    DataIngestionService,
    IssService,
    LocationService,
    NetworkService,
    TrackingService,
)
from app.store import StateStore

app = FastAPI(title="ISS Tracker", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

store = StateStore()
location_service = LocationService()
tracking_service = TrackingService()
iss_service = IssService()
network_service = NetworkService()
cache_service = CacheService()
ingestion_service = DataIngestionService()

app.mount("/static", StaticFiles(directory="app/static"), name="static")
_refresh_task: asyncio.Task | None = None


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


async def _periodic_refresh_loop() -> None:
    while True:
        await asyncio.sleep(6 * 60 * 60)
        try:
            satellites, _ = ingestion_service.refresh_catalog()
            tracking_service.replace_catalog(satellites)
            with suppress(Exception):
                ingestion_service.refresh_ephemeris()
        except Exception:
            # Non-fatal background refresh failure.
            pass


@app.on_event("startup")
async def startup_event() -> None:
    global _refresh_task
    _refresh_task = asyncio.create_task(_periodic_refresh_loop())


@app.on_event("shutdown")
async def shutdown_event() -> None:
    global _refresh_task
    if _refresh_task is not None:
        _refresh_task.cancel()
        with suppress(asyncio.CancelledError):
            await _refresh_task
        _refresh_task = None


@app.get("/")
def kiosk_index() -> FileResponse:
    return FileResponse("app/static/kiosk/index.html")


@app.get("/lite")
def lite_index() -> FileResponse:
    return FileResponse("app/static/lite/index.html")


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
            with suppress(Exception):
                ingestion_service.refresh_ephemeris(timeout_seconds=8.0)
                ephemeris_refreshed = True
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


@app.get("/api/v1/passes")
def get_passes(
    hours: int = Query(default=24, ge=1, le=168),
    location_source: LocationSourceMode | None = Query(default=None),
    min_max_el: float = Query(default=0.0, ge=0.0, le=90.0),
) -> dict:
    _, location = _resolve_location(location_source)
    now = datetime.now(UTC)
    passes = tracking_service.pass_predictions(now, hours, location)
    if min_max_el > 0:
        passes = [p for p in passes if p.max_el_deg >= min_max_el]
    return {
        "timestamp": now,
        "location": location.__dict__,
        "hours": hours,
        "min_max_el": min_max_el,
        "count": len(passes),
        "items": passes,
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
    return {"mode": state.settings.iss_display_mode}


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
    return {"state": state.network}


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
    bodies = []
    if hasattr(ingestion_service, "body_positions"):
        with suppress(Exception):
            bodies = ingestion_service.body_positions(now, location.lat, location.lon, location.alt_m)
    return {
        "timestamp": now,
        "location": location.__dict__,
        "settings": state.settings,
        "network": state.network,
        "cachePolicy": state.cache_policy,
        "iss": iss_state,
        "issTrack": iss_track,
        "activeTrack": active_track,
        "tracks": tracks,
        "passes": tracking_service.pass_predictions(now, 24, location)[:30],
        "bodies": bodies,
    }


@app.post("/api/v1/datasets/refresh")
def refresh_datasets() -> dict:
    state = store.get()
    try:
        satellites, meta = ingestion_service.refresh_catalog()
        tracking_service.replace_catalog(satellites)
        ephem = {"ok": False}
        with suppress(Exception):
            ephem = ingestion_service.refresh_ephemeris()
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

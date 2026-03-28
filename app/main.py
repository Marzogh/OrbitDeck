from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import shutil
import platform
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo
from zoneinfo import available_timezones

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from app.aprs.log_store import AprsLogStore
from app.aprs.service import AprsService
from app.device import lite_only_ui
from app.models import (
    AprsOperatingMode,
    AprsLogClearRequest,
    AprsLogSettingsUpdate,
    AprsSendMessageRequest,
    AprsSendPositionRequest,
    AprsSessionIdentityUpdateRequest,
    AprsSendStatusRequest,
    AprsSettings,
    AprsRuntimeState,
    AprsSettingsUpdate,
    AprsTargetSelectRequest,
    CachePolicyUpdate,
    CorrectionSide,
    DeveloperOverridesUpdate,
    DatasetSnapshot,
    GpsSettingsUpdate,
    GuidePassPhase,
    IssDisplayMode,
    LiteSettingsUpdate,
    GeoPoint,
    LocationSourceMode,
    LocationUpdate,
    NetworkUpdate,
    PassEvent,
    PassFilterUpdate,
    PassProfileMode,
    RadioApplyRequest,
    RadioAutoTrackStartRequest,
    RadioControlSessionSelectRequest,
    RadioControlSessionTestPairUpdateRequest,
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
from app.runtime_paths import packaged_app_runtime, static_path, static_root
from app.services import (
    CacheService,
    DataIngestionService,
    FrequencyGuideService,
    IssService,
    LocationService,
    NetworkService,
    PassPredictionCacheService,
    TrackingService,
)
from app.store import StateStore

try:
    from serial.tools import list_ports  # type: ignore
except Exception:  # pragma: no cover
    list_ports = None

store = StateStore()
aprs_log_store = AprsLogStore()
location_service = LocationService()
tracking_service = TrackingService()
iss_service = IssService()
network_service = NetworkService()
cache_service = CacheService()
pass_cache_service = PassPredictionCacheService()
ingestion_service = DataIngestionService()
frequency_guide_service = FrequencyGuideService()
radio_control_service = RigControlService()


def _handle_aprs_received_packet(entry) -> None:
    state = store.get()
    if not state.aprs_settings.log_enabled:
        return
    aprs_log_store.append(entry, max_records=state.aprs_settings.log_max_records)


aprs_service = AprsService(packet_received_callback=_handle_aprs_received_packet)
_refresh_task: asyncio.Task | None = None
_lite_snapshot_cache: dict[tuple, tuple[datetime, dict]] = {}
_CALLSIGN_PATTERN = re.compile(r"^[A-Z0-9]{3,10}$")
_APRS_SESSION_IDENTITY_OVERRIDE: dict[str, object | None] = {"callsign": None, "ssid": None}
_LITE_MAX_TRACKED_SATS = 5
_BACKGROUND_REFRESH_INTERVAL = timedelta(hours=6)
_BACKGROUND_REFRESH_FAILURE_BACKOFF = timedelta(minutes=30)
_BACKGROUND_REFRESH_FAILURE_RETRY_INTERVAL = timedelta(seconds=30)
_BACKGROUND_REFRESH_FAILURE_BURST_LIMIT = 3
_DIREWOLF_COMMON_PATHS = (
    "/opt/homebrew/bin/direwolf",
    "/usr/local/bin/direwolf",
)
_BREW_COMMON_PATHS = (
    "/opt/homebrew/bin/brew",
    "/usr/local/bin/brew",
)


def _pass_cache_retention(state) -> timedelta:
    return timedelta(days=state.cache_policy.retention_days)


def _pass_cache_ttl(state) -> timedelta:
    return timedelta(hours=state.cache_policy.stale_after_hours)


def _invalidate_pass_cache() -> None:
    pass_cache_service.clear()


def _invalidate_lite_snapshot_cache() -> None:
    _lite_snapshot_cache.clear()


def _resolve_binary_path(binary: str | None, *, common_paths: tuple[str, ...] = (), fallback_name: str | None = None) -> str | None:
    seen: set[str] = set()
    candidates: list[str] = []
    configured = str(binary or "").strip()
    if configured:
        candidates.append(configured)
    candidates.extend(common_paths)
    if fallback_name:
        candidates.append(fallback_name)
    for candidate in candidates:
        candidate = str(candidate or "").strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    return None


def _resolve_direwolf_binary_path(binary: str | None) -> str | None:
    return _resolve_binary_path(binary, common_paths=_DIREWOLF_COMMON_PATHS, fallback_name="direwolf")


def _resolve_brew_binary_path() -> str | None:
    return _resolve_binary_path(None, common_paths=_BREW_COMMON_PATHS, fallback_name="brew")


def _terminal_installer_available() -> bool:
    if packaged_app_runtime():
        return bool(shutil.which("osascript"))
    if platform.system() != "Darwin":
        return False
    return bool(shutil.which("osascript")) and os.path.exists("/bin/bash") and os.path.exists("/usr/bin/curl")


def _direwolf_install_action_label(*, brew_path: str | None, installed: bool) -> str | None:
    if installed:
        return None
    if brew_path:
        return "Install Dire Wolf"
    return "Install Homebrew + Dire Wolf"


def _direwolf_install_status(state=None) -> dict[str, object]:
    state = state or store.get()
    configured = state.aprs_settings.direwolf_binary
    resolved = _resolve_direwolf_binary_path(configured)
    brew_path = _resolve_brew_binary_path()
    packaged_app = packaged_app_runtime()
    can_launch_terminal = _terminal_installer_available()
    requires_homebrew = not bool(brew_path)
    can_install = bool(brew_path) if not packaged_app else can_launch_terminal
    install_hint = None
    if not resolved:
        if packaged_app:
            install_hint = (
                "Dire Wolf is required for APRS. OrbitDeck can launch a guided installer, "
                "or you can install Dire Wolf manually and then refresh this status."
            )
        else:
            install_hint = (
                "Install Dire Wolf to enable APRS decode and local audio APRS workflows."
            )
    return {
        "configuredBinary": configured,
        "resolvedBinary": resolved,
        "installed": bool(resolved),
        "canInstall": can_install,
        "installer": "brew" if brew_path else "brew-bootstrap",
        "brewPath": brew_path,
        "canLaunchTerminal": can_launch_terminal,
        "packagedApp": packaged_app,
        "requiresHomebrew": requires_homebrew,
        "actionLabel": _direwolf_install_action_label(brew_path=brew_path, installed=bool(resolved)),
        "installHint": install_hint,
    }


def _persist_resolved_direwolf_binary(state) -> str | None:
    resolved = _resolve_direwolf_binary_path(state.aprs_settings.direwolf_binary)
    if resolved and state.aprs_settings.direwolf_binary != resolved:
        state.aprs_settings.direwolf_binary = resolved
        store.save(state)
    return resolved


def _ensure_direwolf_ready_for_aprs(state) -> str:
    resolved = _persist_resolved_direwolf_binary(state)
    if resolved:
        return resolved
    status = _direwolf_install_status(state)
    detail = str(status.get("installHint") or "Dire Wolf is not installed or could not be found on this Mac.").strip()
    raise RuntimeError(detail)


def _direwolf_install_terminal_command(*, brew_path: str | None) -> str:
    bootstrap_brew = not bool(brew_path)
    parts = [
        "clear",
        "echo 'OrbitDeck APRS setup'",
        "echo",
    ]
    if bootstrap_brew:
        parts.extend(
            [
                "echo 'Homebrew was not found. Installing Homebrew first...'",
                '/bin/bash -c "$(/usr/bin/curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
                "STATUS=$?",
                'if [ "$STATUS" -ne 0 ]; then',
                '  echo "Homebrew install failed with status $STATUS."',
                "  echo",
                '  echo "Press any key to close this window."',
                "  read -n 1",
                "  exit $STATUS",
                "fi",
                "echo",
            ]
        )
    parts.extend(
        [
            'if [ -x "/opt/homebrew/bin/brew" ]; then BREW="/opt/homebrew/bin/brew"; '
            'elif [ -x "/usr/local/bin/brew" ]; then BREW="/usr/local/bin/brew"; '
            'elif command -v brew >/dev/null 2>&1; then BREW="$(command -v brew)"; '
            'else echo "Homebrew is still unavailable after setup."; echo; echo "Press any key to close this window."; read -n 1; exit 1; fi',
            'echo "Installing Dire Wolf with $BREW ..."',
            '"$BREW" install direwolf',
            "STATUS=$?",
            "echo",
            'if [ "$STATUS" -eq 0 ]; then echo "Dire Wolf install finished."; else echo "Dire Wolf install failed with status $STATUS."; fi',
            "echo",
            'echo "Press any key to close this window."',
            "read -n 1",
            "exit $STATUS",
        ]
    )
    return "; ".join(parts)


def _launch_direwolf_install_terminal(*, brew_path: str | None) -> None:
    osascript_path = shutil.which("osascript")
    if not osascript_path:
        raise HTTPException(status_code=400, detail="Terminal-based Dire Wolf install is not available on this system")
    command = _direwolf_install_terminal_command(brew_path=brew_path)
    escaped_command = command.replace("\\", "\\\\").replace('"', '\\"')
    script = (
        'tell application "Terminal"\n'
        "activate\n"
        f'do script "{escaped_command}"\n'
        "end tell\n"
    )
    result = subprocess.run(
        [osascript_path, "-e", script],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "Unable to launch Terminal for Dire Wolf install").strip()
        raise HTTPException(status_code=400, detail=detail)


def _aprs_audio_devices() -> dict[str, list[dict[str, object]]]:
    system = platform.system()
    resolved_direwolf = _resolve_direwolf_binary_path(store.get().aprs_settings.direwolf_binary)
    if resolved_direwolf:
        with tempfile.NamedTemporaryFile("w", suffix=".conf", delete=True) as handle:
            handle.write("CHANNEL 0\nMYCALL N0CALL\nKISSPORT 8001\n")
            handle.flush()
            result = subprocess.run(
                [resolved_direwolf, "-c", handle.name, "-t", "0"],
                capture_output=True,
                text=True,
                check=False,
            )
        text = "\n".join(part for part in [result.stdout, result.stderr] if part)
        if "Number of devices" in text:
            inputs: list[dict[str, object]] = []
            outputs: list[dict[str, object]] = []
            current: dict[str, object] | None = None

            def append_current() -> None:
                nonlocal current
                if current is None:
                    return
                name = str(current.get("name") or "").strip()
                index = int(current.get("index") or 0)
                in_channels = int(current.get("inputs") or 0)
                out_channels = int(current.get("outputs") or 0)
                value = f"{name}:{index}" if name else str(index)
                if name and in_channels > 0:
                    inputs.append({"name": name, "value": value, "channels": in_channels, "index": index})
                if name and out_channels > 0:
                    outputs.append({"name": name, "value": value, "channels": out_channels, "index": index})

            for raw_line in text.splitlines():
                line = raw_line.strip()
                if line.startswith("--------------------------------------- device #"):
                    append_current()
                    marker = line.split("#", 1)[-1]
                    digits = "".join(ch for ch in marker if ch.isdigit())
                    current = {"index": int(digits or "0")}
                    continue
                if current is None:
                    continue
                if line.startswith("Name"):
                    current["name"] = line.split("=", 1)[-1].strip().strip('"')
                elif line.startswith("Max inputs"):
                    current["inputs"] = int(line.split("=", 1)[-1].strip() or "0")
                elif line.startswith("Max outputs"):
                    current["outputs"] = int(line.split("=", 1)[-1].strip() or "0")
            append_current()
            if inputs or outputs:
                return {"inputs": inputs, "outputs": outputs}
    if system == "Darwin":
        result = subprocess.run(
            ["system_profiler", "SPAudioDataType", "-json"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout or "Unable to enumerate audio devices").strip())
        payload = json.loads(result.stdout or "{}")
        groups = payload.get("SPAudioDataType", [])
        items = []
        for group in groups:
            items.extend(group.get("_items", []))
        inputs: list[dict[str, object]] = []
        outputs: list[dict[str, object]] = []
        seen_inputs: set[str] = set()
        seen_outputs: set[str] = set()
        for item in items:
            name = str(item.get("_name") or "").strip()
            if not name:
                continue
            if int(item.get("coreaudio_device_input") or 0) > 0 and name not in seen_inputs:
                seen_inputs.add(name)
                inputs.append({"name": name, "channels": int(item.get("coreaudio_device_input") or 0)})
            if int(item.get("coreaudio_device_output") or 0) > 0 and name not in seen_outputs:
                seen_outputs.add(name)
                outputs.append({"name": name, "channels": int(item.get("coreaudio_device_output") or 0)})
        return {"inputs": inputs, "outputs": outputs}
    return {"inputs": [], "outputs": []}


def _pass_cache_key(
    *,
    now: datetime,
    hours: int,
    resolved_location,
    sat_ids: set[str] | None,
    min_max_el: float,
    include_all_sats: bool,
    include_ongoing: bool,
) -> str:
    sat_fragment = ",".join(sorted(sat_ids or [])) if sat_ids is not None else "*"
    window_bucket = int(now.timestamp() // 300)
    return "|".join(
        [
            f"bucket={window_bucket}",
            f"h={hours}",
            f"src={resolved_location.source}",
            f"lat={resolved_location.lat:.4f}",
            f"lon={resolved_location.lon:.4f}",
            f"alt={resolved_location.alt_m:.1f}",
            f"min={min_max_el:.1f}",
            f"all={int(include_all_sats)}",
            f"ongoing={int(include_ongoing)}",
            f"sats={sat_fragment}",
        ]
    )


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
    if tz_name in {"UTC", "BrowserLocal"}:
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


def _preferred_lite_tracked_ids(state) -> list[str]:
    valid_ids = {sat.sat_id for sat in tracking_service.satellites()}
    preferred: list[str] = []
    seen: set[str] = set()
    for sat_id in state.settings.pass_sat_ids:
        sat_id = str(sat_id or "").strip()
        if not sat_id or sat_id in seen or sat_id not in valid_ids:
            continue
        preferred.append(sat_id)
        seen.add(sat_id)
        if len(preferred) >= _LITE_MAX_TRACKED_SATS:
            break
    if not preferred and "iss-zarya" in valid_ids:
        preferred = ["iss-zarya"]
    return preferred


def _sync_lite_settings_from_main_preferences(state):
    current_ids = _tracked_sat_ids(state)
    preferred = _preferred_lite_tracked_ids(state)
    has_nondefault_main_pass_preferences = (
        state.settings.pass_profile == PassProfileMode.favorites
        and any(str(sat_id or "").strip() and str(sat_id).strip() != "iss-zarya" for sat_id in state.settings.pass_sat_ids)
    )
    should_seed = (
        not state.lite_settings.setup_complete
        and has_nondefault_main_pass_preferences
        and preferred
    )
    if should_seed:
        state.lite_settings.tracked_sat_ids = preferred
        state.lite_settings.setup_complete = True
        store.save(state)
    return state


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
    if len(cleaned) > _LITE_MAX_TRACKED_SATS:
        raise HTTPException(status_code=400, detail=f"tracked_sat_ids may contain at most {_LITE_MAX_TRACKED_SATS} satellites")
    state.lite_settings.tracked_sat_ids = cleaned
    state.lite_settings.setup_complete = payload.setup_complete
    return state


def _radio_defaults_for_model(model: RadioRigModel) -> tuple[int, str]:
    if model == RadioRigModel.ic705:
        return 19200, "0xA4"
    return 19200, "0x8C"


def _hamlib_model_for_radio(model: RadioRigModel) -> int:
    if model == RadioRigModel.ic705:
        return 3085
    return 3071


def _apply_radio_settings_update(current: RadioSettings, payload: RadioSettingsUpdate) -> RadioSettings:
    next_settings = current.model_copy(deep=True)
    previous_model = next_settings.rig_model
    if payload.enabled is not None:
        next_settings.enabled = payload.enabled
    if payload.rig_model is not None:
        next_settings.rig_model = payload.rig_model
    if payload.transport_mode is not None:
        next_settings.transport_mode = payload.transport_mode
    if payload.serial_device is not None:
        next_settings.serial_device = payload.serial_device.strip()
    if payload.baud_rate is not None:
        next_settings.baud_rate = payload.baud_rate
    if payload.civ_address is not None:
        next_settings.civ_address = normalize_civ_address(payload.civ_address.strip())
    if payload.wifi_host is not None:
        next_settings.wifi_host = payload.wifi_host.strip()
    if payload.wifi_username is not None:
        next_settings.wifi_username = payload.wifi_username.strip()
    if payload.wifi_password is not None:
        next_settings.wifi_password = payload.wifi_password
    if payload.wifi_control_port is not None:
        next_settings.wifi_control_port = payload.wifi_control_port
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
    if next_settings.transport_mode.value == "wifi":
        if next_settings.rig_model != RadioRigModel.ic705:
            raise ValueError("Wi-Fi transport is currently supported only for the IC-705")
        if not next_settings.wifi_host:
            raise ValueError("Wi-Fi host is required for IC-705 Wi-Fi transport")
        if not next_settings.wifi_username:
            raise ValueError("Wi-Fi username is required for IC-705 Wi-Fi transport")
    return next_settings


def _apply_aprs_settings_update(current: AprsSettings, payload: AprsSettingsUpdate) -> AprsSettings:
    next_settings = current.model_copy(deep=True)
    previous_model = next_settings.rig_model
    for field in (
        "enabled",
        "listen_only",
        "operating_mode",
        "rig_model",
        "ptt_via_cat",
        "start_on_boot",
        "selected_satellite_id",
        "selected_channel_id",
        "terrestrial_auto_region",
        "terrestrial_region_label",
    ):
        value = getattr(payload, field)
        if value is not None:
            setattr(next_settings, field, value)
    for field in (
        "callsign",
        "serial_device",
        "civ_address",
        "audio_input_device",
        "audio_output_device",
        "kiss_host",
        "direwolf_binary",
        "beacon_comment",
        "terrestrial_beacon_comment",
        "satellite_beacon_comment",
        "symbol_table",
        "symbol_code",
        "terrestrial_path",
        "satellite_path",
    ):
        value = getattr(payload, field)
        if value is not None:
            setattr(next_settings, field, str(value).strip())
    if payload.beacon_comment is not None:
        legacy = str(payload.beacon_comment).strip()
        next_settings.beacon_comment = legacy
        if payload.terrestrial_beacon_comment is None:
            next_settings.terrestrial_beacon_comment = legacy
        if payload.satellite_beacon_comment is None:
            next_settings.satellite_beacon_comment = legacy
    if payload.ssid is not None:
        next_settings.ssid = payload.ssid
    if payload.hamlib_model_id is not None:
        next_settings.hamlib_model_id = payload.hamlib_model_id
    if payload.position_fudge_lat_deg is not None:
        next_settings.position_fudge_lat_deg = payload.position_fudge_lat_deg
    if payload.position_fudge_lon_deg is not None:
        next_settings.position_fudge_lon_deg = payload.position_fudge_lon_deg
    if payload.log_enabled is not None:
        next_settings.log_enabled = payload.log_enabled
    if payload.log_max_records is not None:
        next_settings.log_max_records = payload.log_max_records
    if payload.notify_incoming_messages is not None:
        next_settings.notify_incoming_messages = payload.notify_incoming_messages
    if payload.notify_all_packets is not None:
        next_settings.notify_all_packets = payload.notify_all_packets
    if payload.digipeater is not None:
        next_settings.digipeater = payload.digipeater
    if payload.igate is not None:
        next_settings.igate = payload.igate
    if payload.future_digipeater_enabled is not None:
        next_settings.future_digipeater_enabled = payload.future_digipeater_enabled
        next_settings.digipeater.enabled = payload.future_digipeater_enabled
    if payload.future_igate_enabled is not None:
        next_settings.future_igate_enabled = payload.future_igate_enabled
        next_settings.igate.enabled = payload.future_igate_enabled
    if payload.igate_auto_enable_with_internet is not None:
        next_settings.igate_auto_enable_with_internet = payload.igate_auto_enable_with_internet
    if payload.baud_rate is not None:
        next_settings.baud_rate = payload.baud_rate
    if payload.kiss_port is not None:
        next_settings.kiss_port = payload.kiss_port
    if payload.tx_path is not None:
        next_settings.tx_path = [str(item).strip().upper() for item in payload.tx_path if str(item).strip()]
    if payload.terrestrial_manual_frequency_hz is not None:
        next_settings.terrestrial_manual_frequency_hz = payload.terrestrial_manual_frequency_hz
    if payload.terrestrial_last_suggested_frequency_hz is not None:
        next_settings.terrestrial_last_suggested_frequency_hz = payload.terrestrial_last_suggested_frequency_hz
    if payload.rig_model is not None and payload.rig_model != previous_model and payload.hamlib_model_id is None:
        next_settings.hamlib_model_id = _hamlib_model_for_radio(payload.rig_model)
    return next_settings


def _validate_aprs_gateway_settings(settings: AprsSettings) -> None:
    if settings.igate.enabled:
        if not settings.igate.server_host.strip():
            raise ValueError("APRS iGate server host is required when iGate is enabled")
        if not settings.igate.login_callsign.strip():
            raise ValueError("APRS iGate login callsign is required when iGate is enabled")
        if not settings.igate.passcode.strip():
            raise ValueError("APRS iGate passcode is required when iGate is enabled")
    if settings.digipeater.enabled and not [item for item in settings.digipeater.aliases if str(item).strip()]:
        raise ValueError("At least one digipeater alias is required when digipeater mode is enabled")


def _resolved_location_for_aprs():
    state, location = _resolve_location()
    return state, location


def _effective_aprs_settings_for_connect(state) -> AprsSettings:
    settings = _apply_aprs_session_identity_override(state.aprs_settings)
    has_igate_credentials = bool(settings.igate.login_callsign.strip() and settings.igate.passcode.strip())
    if state.network.internet_available and has_igate_credentials:
        settings.igate.enabled = True
        settings.igate.gate_terrestrial_rx = True
        settings.igate.gate_satellite_rx = True
    elif settings.igate_auto_enable_with_internet and not settings.future_igate_enabled and not settings.igate.enabled:
        settings.igate.enabled = False
    radio_runtime = radio_control_service.runtime()
    if radio_runtime.connected:
        settings.rig_model = state.radio_settings.rig_model
        settings.hamlib_model_id = _hamlib_model_for_radio(state.radio_settings.rig_model)
        settings.civ_address = state.radio_settings.civ_address
        if state.radio_settings.transport_mode != state.radio_settings.transport_mode.wifi:
            settings.serial_device = state.radio_settings.serial_device
            settings.baud_rate = state.radio_settings.baud_rate
    elif settings.hamlib_model_id is None:
        settings.hamlib_model_id = _hamlib_model_for_radio(settings.rig_model)
    return settings


def _aprs_pass_for_satellite(location, sat_id: str | None):
    if not sat_id:
        return None
    now = datetime.now(UTC)
    passes = tracking_service.pass_predictions(
        now,
        24,
        location,
        sat_ids={sat_id},
        include_ongoing=True,
    )
    return _pick_focus_pass(passes, sat_id)


def _aprs_pass_map(location, satellites) -> dict[str, object]:
    sat_ids = [sat.sat_id for sat in satellites if sat.radio_channels]
    out: dict[str, object] = {}
    now = datetime.now(UTC)
    if not sat_ids:
        return out
    passes = tracking_service.pass_predictions(
        now,
        24,
        location,
        sat_ids=set(sat_ids),
        include_ongoing=True,
    )
    for sat_id in sat_ids:
        event = _pick_focus_pass([item for item in passes if item.sat_id == sat_id], sat_id)
        if event is not None:
            out[sat_id] = event
    return out


def _aprs_targets_payload(state, location) -> dict:
    satellites = tracking_service.satellites()
    pass_map = _aprs_pass_map(location, satellites)
    return aprs_service.available_targets(state.aprs_settings, satellites, location, pass_by_sat_id=pass_map)


def _aprs_current_track(location, sat_id: str | None):
    if not sat_id:
        return None
    now = datetime.now(UTC)
    tracks = tracking_service.live_tracks(now, location)
    return next((track for track in tracks if track.sat_id == sat_id), None)


def _aprs_enrich_target_with_doppler(target, current_track, pass_event):
    if target is None:
        return None
    corrected_frequency_hz = target.frequency_hz
    corrected_uplink_hz = target.uplink_hz
    corrected_downlink_hz = target.downlink_hz
    correction_side = None
    active_phase = None
    retune_active = False
    freqs = [target.uplink_hz, target.downlink_hz, target.frequency_hz]
    if (
        target.operating_mode == AprsOperatingMode.satellite
        and any(freq is not None and int(freq) >= 400_000_000 for freq in freqs)
    ):
        correction_side = CorrectionSide.uhf_only
        active_phase = frequency_guide_service.resolve_phase(datetime.now(UTC), pass_event)
        range_rate = current_track.range_rate_km_s if current_track is not None else 0.0

        def corrected_uplink(freq_hz: int | None) -> int | None:
            if freq_hz is None:
                return None
            mhz = freq_hz / 1_000_000.0
            corrected = (
                frequency_guide_service.corrected_uplink_mhz(mhz, range_rate, 1000)
                if mhz >= 400.0
                else frequency_guide_service.quantize_mhz(mhz, 1000)
            )
            return int(round(corrected * 1_000_000)) if corrected is not None else None

        def corrected_downlink(freq_hz: int | None) -> int | None:
            if freq_hz is None:
                return None
            mhz = freq_hz / 1_000_000.0
            corrected = (
                frequency_guide_service.corrected_downlink_mhz(mhz, range_rate, 5000)
                if mhz >= 400.0
                else frequency_guide_service.quantize_mhz(mhz, 5000)
            )
            return int(round(corrected * 1_000_000)) if corrected is not None else None

        corrected_uplink_hz = corrected_uplink(target.uplink_hz)
        corrected_downlink_hz = corrected_downlink(target.downlink_hz)
        corrected_frequency_hz = corrected_downlink_hz or corrected_uplink_hz or target.frequency_hz
        retune_active = bool(target.pass_active and corrected_frequency_hz and corrected_frequency_hz != target.frequency_hz)

    return target.model_copy(
        update={
            "corrected_frequency_hz": corrected_frequency_hz,
            "corrected_uplink_hz": corrected_uplink_hz,
            "corrected_downlink_hz": corrected_downlink_hz,
            "correction_side": correction_side,
            "active_phase": active_phase,
            "retune_active": retune_active,
        }
    )


def _resolve_aprs_target(settings: AprsSettings, location):
    developer_force_enable = bool(store.get().settings.developer_overrides.enabled)
    pass_event = _aprs_pass_for_satellite(location, settings.selected_satellite_id)
    current_track = _aprs_current_track(location, settings.selected_satellite_id)
    target = aprs_service.resolve_target(
        settings,
        tracking_service.satellites(),
        location,
        pass_event=pass_event,
        developer_force_enable=developer_force_enable,
    )
    return _aprs_enrich_target_with_doppler(target, current_track, pass_event)


def _ensure_radio_available_for_manual_control() -> None:
    runtime = aprs_service.runtime()
    if runtime.session_active:
        raise HTTPException(status_code=409, detail="APRS owns radio session")


def _normalized_station_callsign(value: str | None) -> str:
    return str(value or "").strip().upper()


def _clear_aprs_session_identity_override() -> None:
    _APRS_SESSION_IDENTITY_OVERRIDE["callsign"] = None
    _APRS_SESSION_IDENTITY_OVERRIDE["ssid"] = None


def _current_aprs_session_identity_override() -> tuple[str | None, int | None]:
    callsign = _normalized_station_callsign(_APRS_SESSION_IDENTITY_OVERRIDE.get("callsign"))
    raw_ssid = _APRS_SESSION_IDENTITY_OVERRIDE.get("ssid")
    ssid = int(raw_ssid) if raw_ssid is not None else None
    return callsign or None, ssid


def _format_aprs_source_call(callsign: str | None, ssid: int | None) -> str:
    call = _normalized_station_callsign(callsign) or "N0CALL"
    return call if ssid is None or int(ssid) <= 0 else f"{call}-{int(ssid)}"


def _apply_aprs_session_identity_override(settings: AprsSettings) -> AprsSettings:
    effective = settings.model_copy(deep=True)
    override_callsign, override_ssid = _current_aprs_session_identity_override()
    if override_callsign:
        effective.callsign = override_callsign
    if override_ssid is not None:
        effective.ssid = int(override_ssid)
    return effective


def _validated_aprs_session_identity(callsign: str | None, ssid: int | None) -> tuple[str, int]:
    normalized = _normalized_station_callsign(callsign)
    if not normalized or not _CALLSIGN_PATTERN.fullmatch(normalized):
        raise HTTPException(status_code=400, detail="Session callsign must be 3-10 letters or numbers.")
    if ssid is None or int(ssid) < 0 or int(ssid) > 15:
        raise HTTPException(status_code=400, detail="Session SSID must be between 0 and 15.")
    return normalized, int(ssid)


def _aprs_runtime_response(runtime: AprsRuntimeState, settings: AprsSettings) -> dict:
    payload = runtime.model_dump(mode="python")
    session_callsign, session_ssid = _current_aprs_session_identity_override()
    effective_settings = _apply_aprs_session_identity_override(settings)
    payload["session_callsign_override"] = session_callsign
    payload["session_ssid_override"] = session_ssid
    payload["effective_source_call"] = _format_aprs_source_call(effective_settings.callsign, effective_settings.ssid)
    return payload


def _station_identity_ready(settings: AprsSettings) -> bool:
    callsign = _normalized_station_callsign(settings.callsign)
    return bool(callsign and callsign != "N0CALL" and _CALLSIGN_PATTERN.fullmatch(callsign))


def _station_identity_status(settings: AprsSettings) -> dict[str, object]:
    callsign = _normalized_station_callsign(settings.callsign)
    ready = _station_identity_ready(settings)
    if ready:
        reason = None
    elif not callsign or callsign == "N0CALL":
        reason = "Set your amateur radio callsign to enable radio control."
    else:
        reason = "Callsign must be 3-10 letters or numbers."
    return {
        "configured": ready,
        "callsign": callsign,
        "reason": reason,
    }


def _ensure_station_identity_ready() -> None:
    state = store.get()
    identity = _station_identity_status(state.aprs_settings)
    if not identity["configured"]:
        raise HTTPException(status_code=403, detail=str(identity["reason"]))


def _ensure_wifi_host_reachable(settings: RadioSettings) -> None:
    if settings.transport_mode != settings.transport_mode.wifi:
        return
    host = str(settings.wifi_host or "").strip()
    if not host:
        return
    ping_path = shutil.which("ping")
    if not ping_path:
        raise HTTPException(status_code=400, detail="Unable to verify IC-705 Wi-Fi reachability because the system ping command is unavailable")
    command = [ping_path, "-n", "1", host] if platform.system() == "Windows" else [ping_path, "-c", "1", host]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=2.5,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=400, detail=f"IC-705 Wi-Fi host {host} did not respond to ping") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        if detail:
            raise HTTPException(status_code=400, detail=f"IC-705 Wi-Fi host {host} is unreachable: {detail}")
        raise HTTPException(status_code=400, detail=f"IC-705 Wi-Fi host {host} did not respond to ping")


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


def _resolve_default_test_pair_for_radio(payload: RadioControlSessionSelectRequest):
    _, location = _resolve_location(None)
    now = datetime.now(UTC)
    sat_id = payload.sat_id
    tracks = tracking_service.live_tracks(now, location, sat_ids={sat_id})
    current_track = tracks[0] if tracks else None
    passes = tracking_service.pass_predictions(
        now,
        24,
        location,
        sat_ids={sat_id},
        include_ongoing=True,
    )
    focus_pass = next(
        (
            pass_event
            for pass_event in passes
            if pass_event.sat_id == sat_id
            and pass_event.aos == payload.pass_aos
            and pass_event.los == payload.pass_los
        ),
        None,
    )
    if focus_pass is None:
        midpoint = payload.pass_aos + ((payload.pass_los - payload.pass_aos) / 2)
        focus_pass = PassEvent(
            sat_id=sat_id,
            name=payload.sat_name or sat_id,
            aos=payload.pass_aos,
            tca=midpoint,
            los=payload.pass_los,
            max_el_deg=payload.max_el_deg or 0.0,
        )
    track_path = _focus_track_path(location, focus_pass, sat_id)
    recommendation = frequency_guide_service.recommendation(
        sat_id,
        focus_pass,
        current_track=current_track,
        track_path=track_path,
        now=now,
    )
    if recommendation is None or (recommendation.uplink_mhz is None and recommendation.downlink_mhz is None):
        return None
    return recommendation


def _correct_radio_session_test_pair_payload(payload: RadioControlSessionTestPairUpdateRequest) -> RadioControlSessionTestPairUpdateRequest:
    session = radio_control_service.session_state()
    sat_id = session.selected_sat_id
    if not sat_id:
        return payload
    _, location = _resolve_location(None)
    now = datetime.now(UTC)
    tracks = tracking_service.live_tracks(now, location, sat_ids={sat_id})
    current_track = tracks[0] if tracks else None
    if current_track is None:
        return payload

    def corrected_uplink(freq_hz: int | None) -> int | None:
        if freq_hz is None:
            return None
        mhz = freq_hz / 1_000_000.0
        corrected = (
            frequency_guide_service.corrected_uplink_mhz(mhz, current_track.range_rate_km_s, 1000)
            if mhz >= 400.0
            else frequency_guide_service.quantize_mhz(mhz, 1000)
        )
        return int(round(corrected * 1_000_000)) if corrected is not None else None

    def corrected_downlink(freq_hz: int | None) -> int | None:
        if freq_hz is None:
            return None
        mhz = freq_hz / 1_000_000.0
        corrected = (
            frequency_guide_service.corrected_downlink_mhz(mhz, current_track.range_rate_km_s, 5000)
            if mhz >= 400.0
            else frequency_guide_service.quantize_mhz(mhz, 5000)
        )
        return int(round(corrected * 1_000_000)) if corrected is not None else None

    return payload.model_copy(
        update={
            "uplink_hz": corrected_uplink(payload.uplink_hz),
            "downlink_hz": corrected_downlink(payload.downlink_hz),
        }
    )


def _same_focus_pass(session, focus_pass) -> bool:
    if session is None or focus_pass is None:
        return False
    aos_match = False
    los_match = False
    if session.selected_pass_aos is not None and focus_pass.aos is not None:
        aos_match = abs((session.selected_pass_aos - focus_pass.aos).total_seconds()) <= 5
    if session.selected_pass_los is not None and focus_pass.los is not None:
        los_match = abs((session.selected_pass_los - focus_pass.los).total_seconds()) <= 5
    return (
        session.selected_sat_id == focus_pass.sat_id
        and aos_match
        and los_match
    )


def _first_aprs_channel_for_satellite(sat) -> object | None:
    channels = list(getattr(sat, "radio_channels", []) or [])
    return next((item for item in channels if item.kind == "aprs"), None)


def _channel_has_tuned_frequency(channel) -> bool:
    return bool(channel and (channel.downlink_hz or channel.uplink_hz))


def _compact_radio_runtime(runtime) -> dict:
    return {
        "connected": runtime.connected,
        "control_mode": runtime.control_mode,
        "rig_model": runtime.rig_model,
        "transport_mode": runtime.transport_mode,
        "endpoint": runtime.endpoint,
        "last_error": runtime.last_error,
        "last_poll_at": runtime.last_poll_at,
        "active_sat_id": runtime.active_sat_id,
        "active_pass_aos": runtime.active_pass_aos,
        "active_pass_los": runtime.active_pass_los,
        "selected_column_index": runtime.selected_column_index,
        "last_applied_recommendation": runtime.last_applied_recommendation,
        "targets": runtime.targets,
    }


def _compact_aprs_runtime(runtime, settings) -> dict:
    payload = _aprs_runtime_response(runtime, settings)
    recent_packets = payload.get("recent_packets") or []
    heard_stations = payload.get("heard_stations") or []
    return {
        "connected": payload.get("connected"),
        "session_active": payload.get("session_active"),
        "transport_mode": payload.get("transport_mode"),
        "control_endpoint": payload.get("control_endpoint"),
        "modem_state": payload.get("modem_state"),
        "audio_rx_active": payload.get("audio_rx_active"),
        "audio_tx_active": payload.get("audio_tx_active"),
        "last_error": payload.get("last_error"),
        "last_started_at": payload.get("last_started_at"),
        "last_packet_at": payload.get("last_packet_at"),
        "last_tx_at": payload.get("last_tx_at"),
        "last_tx_packet_type": payload.get("last_tx_packet_type"),
        "last_tx_text": payload.get("last_tx_text"),
        "heard_count": payload.get("heard_count"),
        "packets_rx": payload.get("packets_rx"),
        "packets_tx": payload.get("packets_tx"),
        "target": payload.get("target"),
        "effective_source_call": payload.get("effective_source_call"),
        "recent_packets": recent_packets[:5],
        "heard_stations": heard_stations[:5],
    }


def _first_receive_only_frequency_for_satellite(sat, current_track) -> dict | None:
    if sat is None:
        return None
    candidates: list[tuple[float, str | None]] = []
    for line in list(getattr(sat, "repeaters", []) or []):
        text = str(line or "")
        match = re.search(r"Downlink\s+(\d{7,11})", text, flags=re.IGNORECASE)
        if match:
            mhz = int(match.group(1)) / 1_000_000.0
            candidates.append((mhz, None))
            continue
        match = re.search(r"(\d+(?:\.\d+)?)\s*mhz", text, flags=re.IGNORECASE)
        if match:
            candidates.append((float(match.group(1)), None))
    if not candidates:
        for line in list(getattr(sat, "transponders", []) or []):
            text = str(line or "")
            match = re.search(r"(\d+(?:\.\d+)?)\s*mhz", text, flags=re.IGNORECASE)
            if not match:
                continue
            mode = None
            upper = text.upper()
            if "FM" in upper:
                mode = "FM"
            elif "CW" in upper:
                mode = "CW"
            elif "SSB" in upper:
                mode = "SSB"
            candidates.append((float(match.group(1)), mode))
    if not candidates:
        return None
    nominal_mhz, mode = candidates[0]
    range_rate = current_track.range_rate_km_s if current_track is not None else 0.0
    step_hz = 5000 if nominal_mhz >= 400.0 else 1000
    corrected_mhz = frequency_guide_service.corrected_downlink_mhz(nominal_mhz, range_rate, step_hz)
    return {
        "nominalDownlinkMhz": nominal_mhz,
        "downlinkMhz": corrected_mhz or nominal_mhz,
        "downlinkMode": mode,
        "stepHz": step_hz,
    }


def _catalog_refresh_status() -> dict:
    meta = {}
    with suppress(Exception):
        meta = ingestion_service._load_refresh_meta() or {}
    return {
        "lastAttemptUtc": meta.get("last_attempt_utc"),
        "lastFailureUtc": meta.get("last_failure_utc"),
        "lastSuccessUtc": meta.get("last_success_utc"),
        "lastError": meta.get("last_error"),
        "consecutiveFailureCount": int(meta.get("consecutive_failure_count") or 0),
    }


def _parse_refresh_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    with suppress(Exception):
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
    return None


def _next_background_refresh_delay_seconds() -> float:
    meta = _catalog_refresh_status()
    last_failure = _parse_refresh_timestamp(meta.get("lastFailureUtc"))
    last_success = _parse_refresh_timestamp(meta.get("lastSuccessUtc"))
    consecutive_failures = int(meta.get("consecutiveFailureCount") or 0)
    now = datetime.now(UTC)
    success_due_at = (last_success + _BACKGROUND_REFRESH_INTERVAL) if last_success is not None else now
    failure_backoff = (
        _BACKGROUND_REFRESH_FAILURE_RETRY_INTERVAL
        if 0 < consecutive_failures < _BACKGROUND_REFRESH_FAILURE_BURST_LIMIT
        else _BACKGROUND_REFRESH_FAILURE_BACKOFF
    )
    failure_due_at = (last_failure + failure_backoff) if last_failure is not None else now
    due_at = min(success_due_at, failure_due_at)
    return max(0.0, (due_at - now).total_seconds())


async def _run_background_refresh_cycle() -> None:
    satellites, _ = ingestion_service.refresh_catalog(
        min_interval_hours=_BACKGROUND_REFRESH_INTERVAL.total_seconds() / 3600.0
    )
    tracking_service.replace_catalog(satellites)
    _invalidate_lite_snapshot_cache()
    _invalidate_pass_cache()
    with suppress(Exception):
        ingestion_service.refresh_ephemeris()
    with suppress(Exception):
        statuses = ingestion_service.refresh_amsat_statuses(tracking_service.satellites())
        tracking_service.merge_operational_statuses(statuses)


def _build_lite_radio_focus(state, focus_sat, focus_pass, focus_track) -> dict:
    runtime = radio_control_service.runtime()
    session = radio_control_service.session_state()
    focused_session = _same_focus_pass(session, focus_pass)
    payload = {
        "available": bool(focus_pass and focus_sat),
        "focusSessionSelected": focused_session,
        "runtime": _compact_radio_runtime(runtime),
        "session": session,
        "defaultPair": None,
        "receiveOnlyTarget": None,
        "passState": "idle",
        "canSelectSession": False,
        "canTuneDownlink": False,
        "status": "Select a tracked pass to prepare radio control.",
    }
    if focus_pass is None or focus_sat is None:
        return payload
    now = datetime.now(UTC)
    if now < focus_pass.aos:
        payload["passState"] = "upcoming"
    elif focus_pass.aos <= now <= focus_pass.los:
        payload["passState"] = "active"
    else:
        payload["passState"] = "ended"
    select_request = RadioControlSessionSelectRequest(
        sat_id=focus_sat.sat_id,
        sat_name=focus_sat.name,
        pass_aos=focus_pass.aos,
        pass_los=focus_pass.los,
        max_el_deg=focus_pass.max_el_deg,
    )
    recommendation = _resolve_default_test_pair_for_radio(select_request)
    eligible, reason = radio_control_service._recommendation_supported(recommendation, state.radio_settings)
    payload.update({
        "defaultPair": recommendation,
        "isEligible": eligible,
        "eligibilityReason": reason,
        "canSelectSession": True,
        "status": (
            "Focused pass is ready for radio control."
            if eligible
            else (reason or "Focused pass is not eligible for radio control.")
        ),
    })
    if recommendation is None:
        receive_only = _first_receive_only_frequency_for_satellite(focus_sat, focus_track)
        if receive_only is not None:
            payload.update({
                "receiveOnlyTarget": receive_only,
                "canTuneDownlink": True,
                "canSelectSession": False,
                "isEligible": False,
                "eligibilityReason": "Receive-only monitoring is available for this satellite.",
                "status": "Receive-only downlink available. Tune the focused satellite on the rig RX VFO.",
            })
    return payload


def _build_lite_aprs_focus(state, location, focus_sat) -> dict:
    runtime = aprs_service.runtime()
    current_target = runtime.target
    payload = {
        "available": False,
        "state": "unavailable",
        "selectedChannel": None,
        "availableChannels": [],
        "previewTarget": None,
        "runtime": _compact_aprs_runtime(runtime, state.aprs_settings),
        "focusTargetSelected": False,
        "txAllowed": False,
        "txBlockReason": None,
        "status": "Focused satellite does not expose APRS channels.",
    }
    if focus_sat is None:
        return payload
    channels = [item for item in list(focus_sat.radio_channels or []) if item.kind == "aprs"]
    if not channels:
        return payload
    payload["available"] = True
    payload["availableChannels"] = channels
    payload["state"] = "cataloged"
    selected_channel = None
    if (
        current_target
        and current_target.operating_mode == AprsOperatingMode.satellite
        and current_target.sat_id == focus_sat.sat_id
        and current_target.channel_id is not None
    ):
        selected_channel = next((item for item in channels if item.channel_id == current_target.channel_id), None)
    selected_channel = next(
        (item for item in channels if item.channel_id == state.aprs_settings.selected_channel_id),
        None,
    ) if selected_channel is None else selected_channel
    if selected_channel is not None and not _channel_has_tuned_frequency(selected_channel):
        selected_channel = next((item for item in channels if _channel_has_tuned_frequency(item)), selected_channel)
    if selected_channel is None:
        selected_channel = next((item for item in channels if _channel_has_tuned_frequency(item)), None) or channels[0]
    focus_target_selected = bool(
        current_target
        and current_target.operating_mode == AprsOperatingMode.satellite
        and current_target.sat_id == focus_sat.sat_id
        and current_target.channel_id == selected_channel.channel_id
    )
    payload["selectedChannel"] = selected_channel
    payload["focusTargetSelected"] = focus_target_selected
    if not _channel_has_tuned_frequency(selected_channel):
        payload.update({
            "state": "cataloged",
            "status": "Satellite APRS is listed for this satellite, but no tuned frequency is available in the catalog yet.",
        })
        return payload
    settings = state.aprs_settings.model_copy(
        update={
            "operating_mode": AprsOperatingMode.satellite,
            "selected_satellite_id": focus_sat.sat_id,
            "selected_channel_id": selected_channel.channel_id,
        }
    )
    try:
        preview = _resolve_aprs_target(settings, location)
    except ValueError as exc:
        payload.update({
            "state": "blocked",
            "status": str(exc),
        })
        return payload
    state_name = "ready"
    status = "Focused satellite APRS is ready."
    if preview is not None and not preview.can_transmit:
        state_name = "blocked"
        status = preview.tx_block_reason or "Satellite APRS is blocked for this pass state."
    if focus_target_selected and runtime.connected:
        state_name = "connected"
        status = "Satellite APRS is connected for the focused pass."
        if runtime.audio_tx_active:
            state_name = "transmitting"
            status = "Satellite APRS is transmitting for the focused pass."
        elif runtime.audio_rx_active:
            state_name = "receiving"
            status = "Satellite APRS is connected and receiving."
    if runtime.last_error:
        state_name = "error"
        status = runtime.last_error
    payload.update({
        "previewTarget": preview,
        "state": state_name,
        "txAllowed": bool(preview and preview.can_transmit and not state.aprs_settings.listen_only),
        "txBlockReason": preview.tx_block_reason if preview is not None else None,
        "status": status,
    })
    return payload


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
        "catalog": _catalog_refresh_status(),
        "liteSettings": state.lite_settings,
        "stationIdentity": _station_identity_status(state.aprs_settings),
        "radio": {
            "settings": state.radio_settings,
            "focused": _build_lite_radio_focus(state, focus_sat, focus_pass, focus_track),
        },
        "aprs": {
            "settings": {
                "callsign": state.aprs_settings.callsign,
                "ssid": state.aprs_settings.ssid,
                "satellite_path": state.aprs_settings.satellite_path,
                "satellite_beacon_comment": state.aprs_settings.satellite_beacon_comment,
                "listen_only": state.aprs_settings.listen_only,
            },
            "focused": _build_lite_aprs_focus(state, location, focus_sat),
        },
    }
    _lite_snapshot_cache[cache_key] = (now, payload)
    return payload


async def _periodic_refresh_loop() -> None:
    while True:
        delay = _next_background_refresh_delay_seconds()
        if delay > 0:
            await asyncio.sleep(delay)
        try:
            await _run_background_refresh_cycle()
        except Exception:
            # Non-fatal background refresh failure.
            pass
        await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    global _refresh_task
    with suppress(Exception):
        tracking_service.merge_operational_statuses(ingestion_service.cached_amsat_statuses())
    with suppress(Exception):
        if _next_background_refresh_delay_seconds() <= 0:
            await _run_background_refresh_cycle()
    _refresh_task = asyncio.create_task(_periodic_refresh_loop())
    try:
        yield
    finally:
        with suppress(Exception):
            aprs_service.disconnect()
        with suppress(Exception):
            radio_control_service.disconnect()
        with suppress(Exception):
            await asyncio.sleep(0.35)
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
_STATIC_ROOT = static_root()

app.mount("/static", StaticFiles(directory=str(_STATIC_ROOT)), name="static")


def _static_file_response(*parts: str) -> FileResponse:
    return FileResponse(str(static_path(*parts)))


@app.get("/")
def kiosk_index() -> FileResponse:
    if lite_only_ui():
        return _static_file_response("lite", "index.html")
    return _static_file_response("kiosk", "rotator.html")

@app.get("/lite")
def lite_index() -> FileResponse:
    return _static_file_response("lite", "index.html")


@app.get("/lite/settings")
def lite_settings_index() -> FileResponse:
    return _static_file_response("lite", "settings.html")


@app.get("/settings")
def settings_index() -> FileResponse:
    if lite_only_ui():
        return _static_file_response("lite", "settings.html")
    return _static_file_response("kiosk", "settings.html")


@app.get("/settings-v2")
def settings_v2_index() -> Response:
    return RedirectResponse(url="/settings", status_code=307)


@app.get("/radio")
def radio_index() -> FileResponse:
    return _static_file_response("kiosk", "radio.html")


@app.get("/aprs")
def aprs_index() -> FileResponse:
    return _static_file_response("kiosk", "aprs.html")


@app.get("/internal/radio")
def internal_radio_index() -> FileResponse:
    return _static_file_response("kiosk", "radio.html")


@app.get("/internal/aprs")
def internal_aprs_index() -> FileResponse:
    return _static_file_response("kiosk", "aprs.html")


@app.get("/kiosk-rotator")
def kiosk_rotator_index() -> FileResponse:
    if lite_only_ui():
        return _static_file_response("lite", "index.html")
    return _static_file_response("kiosk", "rotator.html")


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
            _invalidate_lite_snapshot_cache()
            _invalidate_pass_cache()
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
    force_refresh: bool = Query(default=False),
) -> dict:
    state, location = _resolve_location(location_source)
    now = datetime.now(UTC)
    sat_ids = None if include_all_sats else _pass_sat_ids(state.settings)
    cache_key = _pass_cache_key(
        now=now,
        hours=hours,
        resolved_location=location,
        sat_ids=sat_ids,
        min_max_el=min_max_el,
        include_all_sats=include_all_sats,
        include_ongoing=include_ongoing,
    )
    if not force_refresh:
        cached = pass_cache_service.get(
            cache_key,
            ttl=_pass_cache_ttl(state),
            retention=_pass_cache_retention(state),
        )
        if cached is not None:
            return {
                **cached,
                "cache": {"source": "cache", "force_refresh": False},
            }
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
    payload = {
        "timestamp": now,
        "location": location.__dict__,
        "hours": hours,
        "min_max_el": min_max_el,
        "count": len(items),
        "items": items,
        "cache": {"source": "generated", "force_refresh": force_refresh},
    }
    pass_cache_service.put(
        cache_key,
        payload,
        retention=_pass_cache_retention(state),
    )
    return payload


@app.get("/api/v1/settings/iss-display-mode")
def get_iss_display_mode() -> dict:
    state = store.get()
    return {"mode": state.settings.iss_display_mode}


@app.post("/api/v1/settings/iss-display-mode")
def set_iss_display_mode(payload: SettingsUpdate) -> dict:
    state = store.get()
    state.settings.iss_display_mode = payload.mode
    store.save(state)
    _invalidate_lite_snapshot_cache()
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
    _invalidate_lite_snapshot_cache()
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
    _invalidate_lite_snapshot_cache()
    _invalidate_pass_cache()
    return {"profile": state.settings.pass_profile, "satIds": state.settings.pass_sat_ids}


@app.get("/api/v1/settings/lite")
def get_lite_settings() -> dict:
    state = _sync_lite_settings_from_main_preferences(store.get())
    return {"state": state.lite_settings, "availableSatellites": tracking_service.satellites()}


@app.post("/api/v1/settings/lite")
def post_lite_settings(payload: LiteSettingsUpdate) -> dict:
    state = store.get()
    state = _apply_lite_settings_update(state, payload)
    store.save(state)
    _invalidate_lite_snapshot_cache()
    _invalidate_pass_cache()
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
    _invalidate_lite_snapshot_cache()
    _invalidate_pass_cache()
    resolved = location_service.resolve(state.location)
    return {"state": state.location, "resolved": resolved.__dict__}


@app.post("/api/v1/desktop/native-location")
def post_desktop_native_location() -> dict:
    if not packaged_app_runtime():
        raise HTTPException(status_code=404, detail="Desktop native location is only available in the packaged app runtime.")
    from app.desktop_main import DesktopApi

    native = DesktopApi().native_location()
    payload = LocationUpdate(
        browser_location=GeoPoint(
            lat=float(native["lat"]),
            lon=float(native["lon"]),
            alt_m=float(native.get("alt_m") or 0.0),
        )
    )
    state = store.get()
    state.location = location_service.apply_update(state.location, payload)
    store.save(state)
    _invalidate_lite_snapshot_cache()
    _invalidate_pass_cache()
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
    _invalidate_lite_snapshot_cache()
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
    _invalidate_lite_snapshot_cache()
    _invalidate_pass_cache()
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


@app.get("/api/v1/settings/aprs")
def get_aprs_settings() -> dict:
    state = store.get()
    return {"state": state.aprs_settings}


@app.post("/api/v1/settings/aprs")
def post_aprs_settings(payload: AprsSettingsUpdate) -> dict:
    state = store.get()
    try:
        state.aprs_settings = _apply_aprs_settings_update(state.aprs_settings, payload)
        _validate_aprs_gateway_settings(state.aprs_settings)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    store.save(state)
    return {"state": state.aprs_settings}


@app.get("/api/v1/cache-policy")
def get_cache_policy() -> dict:
    state = store.get()
    return {"state": state.cache_policy, "snapshots": state.snapshots}


@app.post("/api/v1/cache-policy")
def post_cache_policy(payload: CachePolicyUpdate) -> dict:
    state = store.get()
    state.cache_policy = cache_service.apply_policy(state.cache_policy, payload)
    store.save(state)
    _invalidate_pass_cache()
    return {"state": state.cache_policy}


@app.post("/api/v1/passes/cache/refresh")
def refresh_pass_cache() -> dict:
    _invalidate_pass_cache()
    return {"ok": True, "cache": {"source": "cleared"}}


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
    state = _sync_lite_settings_from_main_preferences(state)
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


@app.get("/api/v1/aprs/state")
def get_aprs_state() -> dict:
    state = store.get()
    _, location = _resolved_location_for_aprs()
    preview = None
    try:
        preview = _resolve_aprs_target(state.aprs_settings, location)
    except Exception:
        preview = None
    return {"settings": state.aprs_settings, "runtime": _aprs_runtime_response(aprs_service.runtime(), state.aprs_settings), "previewTarget": preview}


@app.get("/api/v1/aprs/log/settings")
def get_aprs_log_settings() -> dict:
    settings = store.get().aprs_settings
    return {
        "log_enabled": settings.log_enabled,
        "log_max_records": settings.log_max_records,
        "notify_incoming_messages": settings.notify_incoming_messages,
        "notify_all_packets": settings.notify_all_packets,
        "digipeater": settings.digipeater,
        "igate": settings.igate,
        "future_digipeater_enabled": settings.future_digipeater_enabled,
        "future_igate_enabled": settings.future_igate_enabled,
        "igate_auto_enable_with_internet": settings.igate_auto_enable_with_internet,
    }


@app.post("/api/v1/aprs/log/settings")
def post_aprs_log_settings(payload: AprsLogSettingsUpdate) -> dict:
    state = store.get()
    state.aprs_settings.log_enabled = payload.log_enabled
    state.aprs_settings.log_max_records = payload.log_max_records
    state.aprs_settings.notify_incoming_messages = payload.notify_incoming_messages
    state.aprs_settings.notify_all_packets = payload.notify_all_packets
    if payload.digipeater is not None:
        state.aprs_settings.digipeater = payload.digipeater
    if payload.igate is not None:
        state.aprs_settings.igate = payload.igate
    state.aprs_settings.future_digipeater_enabled = payload.future_digipeater_enabled
    state.aprs_settings.future_igate_enabled = payload.future_igate_enabled
    state.aprs_settings.igate_auto_enable_with_internet = payload.igate_auto_enable_with_internet
    state.aprs_settings.digipeater.enabled = payload.future_digipeater_enabled
    state.aprs_settings.igate.enabled = payload.future_igate_enabled
    try:
        _validate_aprs_gateway_settings(state.aprs_settings)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    store.save(state)
    return get_aprs_log_settings()


@app.post("/api/v1/aprs/session/identity")
def post_aprs_session_identity(payload: AprsSessionIdentityUpdateRequest) -> dict:
    state = store.get()
    if payload.clear:
        _clear_aprs_session_identity_override()
    else:
        callsign = payload.callsign if payload.callsign is not None else state.aprs_settings.callsign
        ssid = payload.ssid if payload.ssid is not None else state.aprs_settings.ssid
        normalized_callsign, normalized_ssid = _validated_aprs_session_identity(callsign, ssid)
        if (
            normalized_callsign == _normalized_station_callsign(state.aprs_settings.callsign)
            and normalized_ssid == int(state.aprs_settings.ssid)
        ):
            _clear_aprs_session_identity_override()
        else:
            _APRS_SESSION_IDENTITY_OVERRIDE["callsign"] = normalized_callsign
            _APRS_SESSION_IDENTITY_OVERRIDE["ssid"] = normalized_ssid
    _invalidate_lite_snapshot_cache()
    return {"runtime": _aprs_runtime_response(aprs_service.runtime(), state.aprs_settings)}


@app.get("/api/v1/aprs/log")
def get_aprs_log(limit: int = Query(50, ge=1, le=5000), packet_type: str = Query("all"), messages_only: bool = Query(False)) -> dict:
    entries = aprs_log_store.list(limit=limit, packet_type=packet_type, messages_only=messages_only)
    return {"items": entries}


@app.post("/api/v1/aprs/log/clear")
def clear_aprs_log(payload: AprsLogClearRequest) -> dict:
    removed = aprs_log_store.clear(age_bucket=payload.age_bucket)
    return {"ok": True, "removed": removed}


@app.get("/api/v1/aprs/log/export.csv")
def export_aprs_log_csv() -> PlainTextResponse:
    return PlainTextResponse(
        aprs_log_store.export_csv(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="aprs-log.csv"'},
    )


@app.get("/api/v1/aprs/log/export.json")
def export_aprs_log_json() -> Response:
    return Response(
        aprs_log_store.export_json(),
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="aprs-log.json"'},
    )


@app.get("/api/v1/aprs/ports")
def get_aprs_ports() -> dict:
    return get_radio_ports()


@app.get("/api/v1/aprs/audio-devices")
def get_aprs_audio_devices() -> dict:
    try:
        return _aprs_audio_devices()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/v1/aprs/direwolf/status")
def get_aprs_direwolf_status() -> dict:
    return _direwolf_install_status()


@app.post("/api/v1/aprs/direwolf/install")
def install_aprs_direwolf() -> dict:
    state = store.get()
    status = _direwolf_install_status(state)
    if status["installed"]:
        _persist_resolved_direwolf_binary(state)
        return {"ok": True, "status": _direwolf_install_status()}
    brew_path = status["brewPath"]
    if status["packagedApp"]:
        if not status["canLaunchTerminal"]:
            raise HTTPException(
                status_code=400,
                detail="Guided Dire Wolf install is not available on this Mac. Install Homebrew and Dire Wolf manually, then refresh APRS status.",
            )
        _launch_direwolf_install_terminal(brew_path=str(brew_path or "").strip() or None)
        return {"ok": True, "status": _direwolf_install_status(), "launched": True}
    if not brew_path:
        if status["canLaunchTerminal"]:
            _launch_direwolf_install_terminal(brew_path=None)
            return {"ok": True, "status": _direwolf_install_status(), "launched": True}
        raise HTTPException(status_code=400, detail="No supported Dire Wolf installer is available on this system")
    result = subprocess.run(
        [brew_path, "install", "direwolf"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "brew install direwolf failed").strip()
        raise HTTPException(status_code=400, detail=detail)
    _persist_resolved_direwolf_binary(state)
    return {"ok": True, "status": _direwolf_install_status(), "stdout": (result.stdout or "").strip()}


@app.post("/api/v1/aprs/direwolf/install-terminal")
def launch_aprs_direwolf_install_terminal() -> dict:
    status = _direwolf_install_status()
    if status["installed"]:
        return {"ok": True, "status": status, "launched": False}
    if not status["canLaunchTerminal"]:
        raise HTTPException(status_code=400, detail="Terminal-based Dire Wolf install is not available on this system")
    _launch_direwolf_install_terminal(brew_path=str(status["brewPath"] or "").strip() or None)
    return {"ok": True, "status": _direwolf_install_status(), "launched": True}


@app.get("/api/v1/aprs/targets")
def get_aprs_targets() -> dict:
    state, location = _resolved_location_for_aprs()
    return {
        "settings": state.aprs_settings,
        "targets": _aprs_targets_payload(state, location),
        "resolvedLocation": location.__dict__,
    }


def _select_aprs_target(payload: AprsTargetSelectRequest) -> dict:
    state, location = _resolved_location_for_aprs()
    _clear_aprs_session_identity_override()
    next_settings = state.aprs_settings.model_copy(deep=True)
    next_settings.operating_mode = payload.operating_mode
    if payload.operating_mode == AprsOperatingMode.satellite:
        sat = next((item for item in tracking_service.satellites() if item.sat_id == payload.sat_id), None)
        if sat is None:
            raise HTTPException(status_code=400, detail="Selected satellite does not support APRS")
        if not any(item.kind == "aprs" for item in sat.radio_channels):
            raise HTTPException(status_code=400, detail="Selected satellite does not support APRS")
        channel = next((item for item in sat.radio_channels if item.channel_id == payload.channel_id and item.kind == "aprs"), None)
        if channel is None:
            raise HTTPException(status_code=400, detail="Selected APRS channel is unavailable")
        next_settings.selected_satellite_id = sat.sat_id
        next_settings.selected_channel_id = channel.channel_id
        next_settings.terrestrial_region_label = None
        next_settings.terrestrial_last_suggested_frequency_hz = None
        next_settings.future_digipeater_enabled = False
        next_settings.digipeater.enabled = False
    else:
        next_settings.selected_satellite_id = None
        next_settings.selected_channel_id = None
        if payload.terrestrial_frequency_hz is not None:
            next_settings.terrestrial_manual_frequency_hz = payload.terrestrial_frequency_hz
        if next_settings.terrestrial_auto_region and location is not None:
            target = _resolve_aprs_target(next_settings, location)
            next_settings.terrestrial_region_label = target.region_label
            next_settings.terrestrial_last_suggested_frequency_hz = target.frequency_hz
    state.aprs_settings = next_settings
    store.save(state)
    preview = None
    try:
        preview = _resolve_aprs_target(state.aprs_settings, location)
    except Exception:
        preview = None
    return {"state": state.aprs_settings, "runtime": _aprs_runtime_response(aprs_service.runtime(), state.aprs_settings), "previewTarget": preview}


@app.post("/api/v1/aprs/select-target")
def select_aprs_target(payload: AprsTargetSelectRequest) -> dict:
    result = _select_aprs_target(payload)
    _invalidate_lite_snapshot_cache()
    return result


@app.post("/api/v1/aprs/session/select")
def select_aprs_session(payload: AprsTargetSelectRequest) -> dict:
    return _select_aprs_target(payload)


@app.post("/api/v1/aprs/connect")
def connect_aprs() -> dict:
    _ensure_station_identity_ready()
    state, location = _resolved_location_for_aprs()
    try:
        effective_settings = _effective_aprs_settings_for_connect(state)
        _ensure_wifi_host_reachable(state.radio_settings)
        _validate_aprs_gateway_settings(effective_settings)
        resolved_direwolf = _ensure_direwolf_ready_for_aprs(state)
        effective_settings.direwolf_binary = resolved_direwolf
        state.aprs_settings.direwolf_binary = resolved_direwolf
        target = _resolve_aprs_target(effective_settings, location)
        if target.region_label is not None:
            state.aprs_settings.terrestrial_region_label = target.region_label
            state.aprs_settings.terrestrial_last_suggested_frequency_hz = target.frequency_hz
        state.aprs_settings.rig_model = effective_settings.rig_model
        state.aprs_settings.serial_device = effective_settings.serial_device
        state.aprs_settings.baud_rate = effective_settings.baud_rate
        state.aprs_settings.civ_address = effective_settings.civ_address
        store.save(state)
        radio_control_service.disconnect()
        runtime = aprs_service.connect(
            effective_settings,
            target,
            radio_settings=state.radio_settings,
            retune_resolver=(lambda: _resolve_aprs_target(_effective_aprs_settings_for_connect(store.get()), _resolve_location()[1])),
        )
    except (RuntimeError, ValueError, TimeoutError, OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _invalidate_lite_snapshot_cache()
    return {"settings": state.aprs_settings, "runtime": _aprs_runtime_response(runtime, state.aprs_settings), "target": target}


@app.post("/api/v1/aprs/disconnect")
def disconnect_aprs() -> dict:
    state = store.get()
    runtime = aprs_service.disconnect()
    _invalidate_lite_snapshot_cache()
    return {"runtime": _aprs_runtime_response(runtime, state.aprs_settings)}


@app.post("/api/v1/aprs/emergency-stop")
def emergency_stop_aprs() -> dict:
    state = store.get()
    runtime = aprs_service.disconnect()
    _invalidate_lite_snapshot_cache()
    return {"ok": True, "runtime": _aprs_runtime_response(runtime, state.aprs_settings)}


@app.post("/api/v1/aprs/send/message")
def send_aprs_message(payload: AprsSendMessageRequest) -> dict:
    _ensure_station_identity_ready()
    state = store.get()
    try:
        override_callsign, override_ssid = _current_aprs_session_identity_override()
        send_payload = payload.model_copy(update={
            "callsign": payload.callsign if payload.callsign is not None else override_callsign,
            "ssid": payload.ssid if payload.ssid is not None else override_ssid,
        })
        if send_payload.callsign is not None or send_payload.ssid is not None:
            normalized_callsign, normalized_ssid = _validated_aprs_session_identity(
                send_payload.callsign if send_payload.callsign is not None else state.aprs_settings.callsign,
                send_payload.ssid if send_payload.ssid is not None else state.aprs_settings.ssid,
            )
            send_payload = send_payload.model_copy(update={"callsign": normalized_callsign, "ssid": normalized_ssid})
        runtime = aprs_service.send_message(state.aprs_settings, send_payload)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _invalidate_lite_snapshot_cache()
    return {"runtime": _aprs_runtime_response(runtime, state.aprs_settings)}


@app.post("/api/v1/aprs/send/status")
def send_aprs_status(payload: AprsSendStatusRequest) -> dict:
    _ensure_station_identity_ready()
    state = store.get()
    try:
        override_callsign, override_ssid = _current_aprs_session_identity_override()
        send_payload = payload.model_copy(update={
            "callsign": payload.callsign if payload.callsign is not None else override_callsign,
            "ssid": payload.ssid if payload.ssid is not None else override_ssid,
        })
        if send_payload.callsign is not None or send_payload.ssid is not None:
            normalized_callsign, normalized_ssid = _validated_aprs_session_identity(
                send_payload.callsign if send_payload.callsign is not None else state.aprs_settings.callsign,
                send_payload.ssid if send_payload.ssid is not None else state.aprs_settings.ssid,
            )
            send_payload = send_payload.model_copy(update={"callsign": normalized_callsign, "ssid": normalized_ssid})
        runtime = aprs_service.send_status(state.aprs_settings, send_payload)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _invalidate_lite_snapshot_cache()
    return {"runtime": _aprs_runtime_response(runtime, state.aprs_settings)}


@app.post("/api/v1/aprs/send/position")
def send_aprs_position(payload: AprsSendPositionRequest) -> dict:
    _ensure_station_identity_ready()
    state, location = _resolved_location_for_aprs()
    try:
        override_callsign, override_ssid = _current_aprs_session_identity_override()
        send_payload = payload.model_copy(update={
            "callsign": payload.callsign if payload.callsign is not None else override_callsign,
            "ssid": payload.ssid if payload.ssid is not None else override_ssid,
        })
        if send_payload.callsign is not None or send_payload.ssid is not None:
            normalized_callsign, normalized_ssid = _validated_aprs_session_identity(
                send_payload.callsign if send_payload.callsign is not None else state.aprs_settings.callsign,
                send_payload.ssid if send_payload.ssid is not None else state.aprs_settings.ssid,
            )
            send_payload = send_payload.model_copy(update={"callsign": normalized_callsign, "ssid": normalized_ssid})
        runtime = aprs_service.send_position(state.aprs_settings, send_payload, location)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _invalidate_lite_snapshot_cache()
    return {"runtime": _aprs_runtime_response(runtime, state.aprs_settings)}


@app.get("/api/v1/radio/state")
def get_radio_state() -> dict:
    state = store.get()
    return {
        "settings": state.radio_settings,
        "runtime": radio_control_service.runtime(),
        "session": radio_control_service.session_state(),
    }


@app.get("/api/v1/radio/ports")
def get_radio_ports() -> dict:
    items: list[dict[str, str]] = []
    if list_ports is not None:
        try:
            for port in list_ports.comports():
                items.append(
                    {
                        "device": str(getattr(port, "device", "") or ""),
                        "description": str(getattr(port, "description", "") or ""),
                        "hwid": str(getattr(port, "hwid", "") or ""),
                    }
                )
        except Exception:
            items = []
    return {"items": items}


@app.get("/api/v1/radio/session")
def get_radio_session() -> dict:
    return {"session": radio_control_service.session_state(), "runtime": radio_control_service.runtime()}


@app.post("/api/v1/radio/session/select")
def select_radio_session(payload: RadioControlSessionSelectRequest) -> dict:
    _ensure_radio_available_for_manual_control()
    _ensure_station_identity_ready()
    state = store.get()
    session = radio_control_service.select_session(payload, _resolve_default_test_pair_for_radio, state.radio_settings)
    _invalidate_lite_snapshot_cache()
    return {"session": session, "runtime": radio_control_service.runtime()}


@app.post("/api/v1/radio/session/test-pair")
def update_radio_session_test_pair(payload: RadioControlSessionTestPairUpdateRequest) -> dict:
    _ensure_radio_available_for_manual_control()
    _ensure_station_identity_ready()
    state = store.get()
    try:
        corrected_payload = _correct_radio_session_test_pair_payload(payload)
        session = radio_control_service.set_session_test_pair(corrected_payload, state.radio_settings)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"session": session, "runtime": radio_control_service.runtime()}


@app.post("/api/v1/radio/session/clear")
def clear_radio_session() -> dict:
    session = radio_control_service.clear_session()
    _invalidate_lite_snapshot_cache()
    return {"session": session, "runtime": radio_control_service.runtime()}


@app.post("/api/v1/radio/connect")
def connect_radio() -> dict:
    _ensure_radio_available_for_manual_control()
    _ensure_station_identity_ready()
    state = store.get()
    _ensure_wifi_host_reachable(state.radio_settings)
    runtime = radio_control_service.connect(state.radio_settings)
    _invalidate_lite_snapshot_cache()
    return {"settings": state.radio_settings, "runtime": runtime, "session": radio_control_service.session_state()}


@app.post("/api/v1/radio/disconnect")
def disconnect_radio() -> dict:
    state = store.get()
    try:
        runtime = radio_control_service.disconnect()
        session = radio_control_service.session_state()
    except Exception as exc:
        runtime = radio_control_service.runtime()
        runtime.last_error = f"Disconnect encountered an error: {exc}"
        session = radio_control_service.session_state()
    _invalidate_lite_snapshot_cache()
    return {"settings": state.radio_settings, "runtime": runtime, "session": session}


@app.post("/api/v1/radio/poll")
def poll_radio() -> dict:
    _ensure_radio_available_for_manual_control()
    _ensure_station_identity_ready()
    state = store.get()
    runtime = radio_control_service.poll(state.radio_settings)
    _invalidate_lite_snapshot_cache()
    return {"settings": state.radio_settings, "runtime": runtime, "session": radio_control_service.session_state()}


@app.post("/api/v1/radio/frequency")
def set_radio_frequency(payload: RadioFrequencySetRequest) -> dict:
    _ensure_radio_available_for_manual_control()
    _ensure_station_identity_ready()
    state = store.get()
    try:
        runtime, result = radio_control_service.set_frequency(payload, state.radio_settings)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _invalidate_lite_snapshot_cache()
    return {"settings": state.radio_settings, "runtime": runtime, "result": result}


@app.post("/api/v1/radio/pair")
def set_radio_pair(payload: RadioPairSetRequest) -> dict:
    _ensure_radio_available_for_manual_control()
    _ensure_station_identity_ready()
    state = store.get()
    try:
        runtime, recommendation, mapping = radio_control_service.apply_manual_pair(payload, state.radio_settings)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _invalidate_lite_snapshot_cache()
    return {
        "settings": state.radio_settings,
        "runtime": runtime,
        "session": radio_control_service.session_state(),
        "recommendation": recommendation,
        "targetMapping": mapping,
        "appliedAt": datetime.now(UTC),
    }


@app.post("/api/v1/radio/session/test")
def run_radio_session_test() -> dict:
    _ensure_radio_available_for_manual_control()
    _ensure_station_identity_ready()
    state = store.get()
    try:
        session, runtime, recommendation, mapping = radio_control_service.run_test_control(state.radio_settings)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _invalidate_lite_snapshot_cache()
    return {
        "session": session,
        "runtime": runtime,
        "recommendation": recommendation,
        "targetMapping": mapping,
        "appliedAt": datetime.now(UTC),
    }


@app.post("/api/v1/radio/session/test/confirm")
def confirm_radio_session_test() -> dict:
    _ensure_radio_available_for_manual_control()
    _ensure_station_identity_ready()
    session, runtime = radio_control_service.confirm_test_success()
    _invalidate_lite_snapshot_cache()
    return {"session": session, "runtime": runtime}


@app.post("/api/v1/radio/session/start")
def start_radio_session_control() -> dict:
    _ensure_radio_available_for_manual_control()
    _ensure_station_identity_ready()
    state = store.get()
    try:
        session, runtime = radio_control_service.start_session_control(
            state.radio_settings,
            _resolve_recommendation_for_radio,
        )
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _invalidate_lite_snapshot_cache()
    return {"session": session, "runtime": runtime}


@app.post("/api/v1/radio/session/stop")
def stop_radio_session_control() -> dict:
    _ensure_radio_available_for_manual_control()
    _ensure_station_identity_ready()
    session, runtime = radio_control_service.stop_session_control()
    _invalidate_lite_snapshot_cache()
    return {"session": session, "runtime": runtime}


@app.post("/api/v1/radio/apply")
def apply_radio_target(payload: RadioApplyRequest) -> dict:
    _ensure_radio_available_for_manual_control()
    _ensure_station_identity_ready()
    state = store.get()
    try:
        runtime, recommendation, mapping = radio_control_service.apply(
            payload,
            state.radio_settings,
            _resolve_recommendation_for_radio,
        )
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _invalidate_lite_snapshot_cache()
    return {
        "runtime": runtime,
        "recommendation": recommendation,
        "targetMapping": mapping,
        "appliedAt": datetime.now(UTC),
    }


@app.post("/api/v1/radio/auto-track/start")
def start_radio_auto_track(payload: RadioAutoTrackStartRequest) -> dict:
    _ensure_radio_available_for_manual_control()
    _ensure_station_identity_ready()
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
    _invalidate_lite_snapshot_cache()
    return {"runtime": runtime}


@app.post("/api/v1/radio/auto-track/stop")
def stop_radio_auto_track() -> dict:
    _ensure_radio_available_for_manual_control()
    _ensure_station_identity_ready()
    runtime = radio_control_service.stop_auto_track()
    _invalidate_lite_snapshot_cache()
    return {"runtime": runtime}


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
    aprs_preview_target = None
    with suppress(Exception):
        aprs_preview_target = _resolve_aprs_target(state.aprs_settings, location)
    return {
        "timestamp": now,
        "location": location.__dict__,
        "settings": state.settings,
        "radioSettings": state.radio_settings,
        "radioRuntime": radio_control_service.runtime(),
        "radioControlSession": radio_control_service.session_state(),
        "aprsSettings": state.aprs_settings,
        "aprsRuntime": aprs_service.runtime(),
        "aprsPreviewTarget": aprs_preview_target,
        "stationIdentity": _station_identity_status(state.aprs_settings),
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
        _invalidate_lite_snapshot_cache()
        _invalidate_pass_cache()
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

from __future__ import annotations

import json
import os
import plistlib
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from contextlib import closing
from pathlib import Path

import uvicorn
from app.runtime_paths import data_path, writable_root


HEALTH_TIMEOUT_S = 30.0
HEALTH_POLL_INTERVAL_S = 0.25


def _pick_free_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as handle:
        handle.bind(("127.0.0.1", 0))
        handle.listen(1)
        return int(handle.getsockname()[1])


class DesktopServer:
    def __init__(self, host: str = "127.0.0.1", port: int | None = None) -> None:
        self.host = host
        self.port = int(port or _pick_free_port())
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}/"

    def start(self) -> None:
        os.environ["ORBITDECK_PACKAGED_APP"] = "1"
        from app.main import app as orbitdeck_app

        config = uvicorn.Config(
            orbitdeck_app,
            host=self.host,
            port=self.port,
            reload=False,
            log_level="info",
        )
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, name="orbitdeck-server", daemon=True)
        self._thread.start()
        self.wait_until_ready()

    def wait_until_ready(self) -> None:
        deadline = time.monotonic() + HEALTH_TIMEOUT_S
        health_url = f"http://{self.host}:{self.port}/health"
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(health_url, timeout=2) as response:
                    if 200 <= int(response.status) < 300:
                        return
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = exc
                time.sleep(HEALTH_POLL_INTERVAL_S)
        raise RuntimeError(f"OrbitDeck server did not become healthy at {health_url}") from last_error

    def stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout=10)


def _first_run() -> bool:
    if not _desktop_launch_marker().exists():
        return True
    state_path = data_path("state.json")
    if not state_path.exists():
        return True
    return not _setup_ready(state_path)


def _setup_ready(state_path: Path) -> bool:
    try:
        payload = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        return False
    aprs_settings = payload.get("aprs_settings") or {}
    location = payload.get("location") or {}
    callsign = str(aprs_settings.get("callsign") or "").strip().upper()
    has_station_identity = bool(callsign) and callsign != "N0CALL"
    has_location = any(
        [
            location.get("selected_profile_id"),
            location.get("browser_location"),
            location.get("gps_location"),
            location.get("last_known_location"),
        ]
    )
    return has_station_identity and has_location


def _app_version() -> str:
    env_version = str(os.environ.get("ORBITDECK_VERSION", "")).strip()
    if env_version:
        return env_version
    if getattr(sys, "frozen", False):
        plist_path = Path(sys.executable).resolve().parents[1] / "Info.plist"
        if plist_path.exists():
            try:
                with plist_path.open("rb") as handle:
                    payload = plistlib.load(handle)
                version = str(payload.get("CFBundleShortVersionString") or payload.get("CFBundleVersion") or "").strip()
                if version:
                    return version
            except Exception:
                pass
    return "0.0.0-dev"


def _desktop_launch_marker() -> Path:
    version = re.sub(r"[^A-Za-z0-9._-]", "-", _app_version())
    build_suffix = version
    if getattr(sys, "frozen", False):
        try:
            build_suffix = f"{version}-{Path(sys.executable).resolve().stat().st_mtime_ns}"
        except Exception:
            build_suffix = version
    return writable_root() / f".desktop-first-run-complete-{build_suffix}"


def _mark_desktop_launch_complete() -> None:
    marker = _desktop_launch_marker()
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("1\n", encoding="utf-8")


def _initial_url(server: DesktopServer, *, first_run: bool) -> str:
    return f"{server.url}settings" if first_run else server.url


def _webview_storage_path() -> str:
    path = writable_root() / "webview"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


class DesktopApi:
    def native_location(self) -> dict[str, float]:
        try:
            from AppKit import NSRunLoop
            from CoreLocation import (
                CLLocationManager,
                kCLAuthorizationStatusAuthorized,
                kCLAuthorizationStatusAuthorizedAlways,
                kCLAuthorizationStatusAuthorizedWhenInUse,
                kCLAuthorizationStatusDenied,
                kCLAuthorizationStatusNotDetermined,
                kCLLocationAccuracyBest,
            )
            from Foundation import NSDate, NSObject
            import objc
        except ImportError as exc:
            raise RuntimeError("Native macOS location support is unavailable in this build.") from exc

        event = threading.Event()
        result: dict[str, float] = {}
        failure: list[str] = []
        manager_box: dict[str, object] = {}

        class LocationDelegate(NSObject):
            def init(self):
                self = objc.super(LocationDelegate, self).init()
                if self is None:
                    return None
                self.manager = None
                return self

            def _finish(self):
                if self.manager is not None:
                    self.manager.stopUpdatingLocation()
                event.set()

            def locationManagerDidChangeAuthorization_(self, manager):
                status = manager.authorizationStatus()
                if status in (
                    kCLAuthorizationStatusAuthorized,
                    kCLAuthorizationStatusAuthorizedAlways,
                    kCLAuthorizationStatusAuthorizedWhenInUse,
                ):
                    manager.startUpdatingLocation()
                    return
                if status == kCLAuthorizationStatusNotDetermined:
                    return
                if status == kCLAuthorizationStatusDenied:
                    failure.append("Location permission was denied in macOS System Settings.")
                else:
                    failure.append(f"Location permission status {int(status)} is not usable.")
                self._finish()

            def locationManager_didUpdateLocations_(self, manager, locations):
                if not locations:
                    return
                location = locations[-1]
                coordinate = location.coordinate()
                result["lat"] = round(float(coordinate.latitude), 6)
                result["lon"] = round(float(coordinate.longitude), 6)
                result["alt_m"] = round(float(location.altitude()), 1)
                self._finish()

            def locationManager_didFailWithError_(self, manager, error):
                failure.append(str(error))
                self._finish()

        manager = CLLocationManager.alloc().init()
        delegate = LocationDelegate.alloc().init()
        delegate.manager = manager
        manager_box["delegate"] = delegate
        manager.setDelegate_(delegate)
        manager.setDesiredAccuracy_(kCLLocationAccuracyBest)

        status = manager.authorizationStatus()
        if status == kCLAuthorizationStatusNotDetermined:
            manager.requestWhenInUseAuthorization()
        elif status in (
            kCLAuthorizationStatusAuthorized,
            kCLAuthorizationStatusAuthorizedAlways,
            kCLAuthorizationStatusAuthorizedWhenInUse,
        ):
            manager.startUpdatingLocation()
        elif status == kCLAuthorizationStatusDenied:
            raise RuntimeError("Location permission was denied in macOS System Settings.")
        else:
            raise RuntimeError(f"Unsupported location authorization status {int(status)}")

        deadline = time.monotonic() + 15.0
        run_loop = NSRunLoop.currentRunLoop()
        while not event.is_set() and time.monotonic() < deadline:
            run_loop.runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.1))

        if result:
            return result
        if failure:
            raise RuntimeError(failure[-1])
        raise RuntimeError("Timed out waiting for macOS location.")


def main() -> None:
    try:
        import webview
        from webview.menu import Menu, MenuAction
    except ImportError as exc:  # pragma: no cover - packaging/runtime failure path
        raise RuntimeError(
            "pywebview is required for the packaged desktop app. Install packaging dependencies before building."
        ) from exc

    first_run = _first_run()
    server = DesktopServer()
    server.start()
    try:
        window = webview.create_window(
            "OrbitDeck",
            _initial_url(server, first_run=first_run),
            js_api=DesktopApi(),
            min_size=(1180, 760),
            text_select=True,
        )

        def open_preferences() -> None:
            if window is not None:
                window.load_url(f"{server.url}settings")

        app_menu = [
            Menu(
                "OrbitDeck",
                [
                    MenuAction("Preferences...", open_preferences),
                ],
            )
        ]
        webview.start(
            debug=False,
            menu=app_menu,
            private_mode=False,
            storage_path=_webview_storage_path(),
        )
    finally:
        _mark_desktop_launch_complete()
        server.stop()


if __name__ == "__main__":
    main()

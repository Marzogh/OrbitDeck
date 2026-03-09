#!/usr/bin/env python3
from __future__ import annotations

import argparse
import platform
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn

# Ensure the repo root is importable when launching via `python3 scripts/run_tracker.py`.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from app.device import lite_only_ui


def _launch_browser(mode: str, url: str) -> None:
    system = platform.system()

    if mode == "headless":
        return

    if mode == "windowed":
        webbrowser.open(url)
        return

    # kiosk mode
    if system == "Linux":
        for cmd in (
            ["chromium-browser", "--kiosk", "--incognito", url],
            ["chromium", "--kiosk", "--incognito", url],
        ):
            try:
                subprocess.Popen(cmd)
                return
            except FileNotFoundError:
                continue
        webbrowser.open(url)
        return

    # macOS and other platforms: fallback to windowed browser open
    webbrowser.open(url)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run OrbitDeck with cross-platform browser launch."
    )
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--mode",
        choices=["auto", "kiosk", "windowed", "headless"],
        default="auto",
        help="UI launch mode. 'auto' => kiosk on Linux, windowed elsewhere.",
    )
    parser.add_argument(
        "--ui",
        choices=["kiosk", "lite"],
        default="kiosk",
        help="Which UI route to open in the browser.",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable uvicorn reload for local development.",
    )

    args = parser.parse_args()

    mode = args.mode
    if mode == "auto":
        mode = "kiosk" if platform.system() == "Linux" else "windowed"

    ui = "lite" if lite_only_ui() else args.ui
    route = "/" if ui == "kiosk" else "/lite"
    url = f"http://localhost:{args.port}{route}"

    threading.Thread(
        target=lambda: (time.sleep(1.2), _launch_browser(mode, url)),
        daemon=True,
    ).start()

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()

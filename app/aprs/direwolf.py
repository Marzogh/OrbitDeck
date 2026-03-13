from __future__ import annotations

import subprocess
from collections import deque
from pathlib import Path
from threading import Event, Thread

from app.models import AprsSettings, AprsTargetState


class DireWolfProcess:
    def __init__(self, workdir: str = "data/aprs") -> None:
        self.workdir = Path(workdir)
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.process: subprocess.Popen[str] | None = None
        self.config_path: Path | None = None
        self.command: list[str] = []
        self.output_tail: deque[str] = deque(maxlen=80)
        self._stop = Event()
        self._threads: list[Thread] = []

    def build_config(self, settings: AprsSettings, target: AprsTargetState) -> str:
        call = settings.callsign.strip().upper() or "N0CALL"
        mycall = call if settings.ssid <= 0 else f"{call}-{settings.ssid}"
        lines = [
            f"ADEVICE {settings.audio_input_device} {settings.audio_output_device}",
            "CHANNEL 0",
            f"MYCALL {mycall}",
            "MODEM 1200",
            f"KISSPORT {settings.kiss_port}",
        ]
        if settings.ptt_via_cat and not settings.listen_only:
            lines.append(f"PTT RIG AUTO {settings.serial_device} {settings.baud_rate}")
        comment = (settings.beacon_comment or "").strip()
        if target.operating_mode.value == "terrestrial" and target.region_label:
            comment = f"{comment} [{target.region_label}]".strip()
        lines.append(f"# Target {target.label} {target.frequency_hz}")
        if comment:
            lines.append(f"# Comment {comment}")
        return "\n".join(lines) + "\n"

    def start(self, settings: AprsSettings, target: AprsTargetState) -> tuple[list[str], list[str]]:
        self.stop()
        config_text = self.build_config(settings, target)
        self.config_path = self.workdir / "direwolf.conf"
        self.config_path.write_text(config_text, encoding="utf-8")
        self.command = [settings.direwolf_binary, "-c", str(self.config_path), "-t", "0"]
        self.process = subprocess.Popen(
            self.command,
            cwd=str(self.workdir),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self._stop.clear()
        self._threads = []
        for stream in (self.process.stdout, self.process.stderr):
            if stream is None:
                continue
            thread = Thread(target=self._consume_stream, args=(stream,), daemon=True)
            thread.start()
            self._threads.append(thread)
        return self.command, list(self.output_tail)

    def _consume_stream(self, stream) -> None:
        while not self._stop.is_set():
            line = stream.readline()
            if not line:
                return
            self.output_tail.append(line.rstrip())

    def stop(self) -> None:
        self._stop.set()
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2.0)
        self.process = None
        for thread in self._threads:
            if thread.is_alive():
                thread.join(timeout=0.2)
        self._threads = []

    def is_running(self) -> bool:
        return self.process is not None and self.process.poll() is None

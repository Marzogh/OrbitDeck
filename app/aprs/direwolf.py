from __future__ import annotations

import subprocess
from collections import deque
from pathlib import Path
from threading import Event, Thread
from time import monotonic, sleep
from typing import Callable

from app.models import AprsSettings, AprsTargetState


OutputObserver = Callable[[str], None]


class DireWolfProcess:
    def __init__(self, workdir: str = "data/aprs", output_observer: OutputObserver | None = None) -> None:
        self.workdir = Path(workdir)
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.process: subprocess.Popen[str] | None = None
        self.config_path: Path | None = None
        self.command: list[str] = []
        self.output_tail: deque[str] = deque(maxlen=80)
        self._stop = Event()
        self._threads: list[Thread] = []
        self._kiss_port: int | None = None
        self._output_observer = output_observer

    @staticmethod
    def _port_in_use(port: int) -> bool:
        probe = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{int(port)}", "-sTCP:LISTEN", "-t"],
            capture_output=True,
            text=True,
            check=False,
        )
        return bool((probe.stdout or "").strip())

    @classmethod
    def _wait_for_port_state(cls, port: int | None, *, in_use: bool, timeout: float = 3.0) -> None:
        if not port:
            return
        deadline = monotonic() + timeout
        while monotonic() < deadline:
            if cls._port_in_use(port) == in_use:
                return
            sleep(0.1)

    @staticmethod
    def _terminate_conflicting_direwolf(port: int | None) -> None:
        if not port:
            return
        lookup = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{int(port)}", "-sTCP:LISTEN", "-Fpct"],
            capture_output=True,
            text=True,
            check=False,
        )
        pid: str | None = None
        command: str | None = None
        for line in (lookup.stdout or "").splitlines():
            if line.startswith("p"):
                pid = line[1:]
                command = None
            elif line.startswith("c"):
                command = line[1:]
            elif line.startswith("t") and line[1:] == "IPv4" and pid and command == "direwolf":
                subprocess.run(["kill", pid], capture_output=True, text=True, check=False)

    def build_config(
        self,
        settings: AprsSettings,
        target: AprsTargetState,
        *,
        include_audio_devices: bool = True,
        include_ptt: bool = True,
    ) -> str:
        def quote_config_value(value: str) -> str:
            escaped = value.replace("\\", "\\\\").replace('"', '\\"')
            return f'"{escaped}"'

        call = settings.callsign.strip().upper() or "N0CALL"
        mycall = call if settings.ssid <= 0 else f"{call}-{settings.ssid}"
        input_device = str(settings.audio_input_device or "").strip()
        output_device = str(settings.audio_output_device or "").strip()
        use_explicit_audio_devices = (
            bool(input_device)
            and bool(output_device)
            and input_device.lower() not in {"default", "system", "auto"}
            and output_device.lower() not in {"default", "system", "auto"}
        )
        lines = [
            "CHANNEL 0",
            f"MYCALL {mycall}",
            "MODEM 1200",
            f"KISSPORT {settings.kiss_port}",
        ]
        if include_audio_devices and use_explicit_audio_devices:
            lines.insert(0, f"ADEVICE {quote_config_value(input_device)} {quote_config_value(output_device)}")
        if include_ptt and settings.ptt_via_cat and not settings.listen_only:
            rig_model = int(settings.hamlib_model_id or 3085)
            lines.append(f"PTT RIG {rig_model} {settings.serial_device} {settings.baud_rate}")
        if settings.digipeater.enabled:
            aliases = [item.strip().upper() for item in settings.digipeater.aliases if str(item).strip()]
            if aliases:
                lines.append(f"DIGIPEAT 0 0 {' '.join(aliases)}")
        if settings.igate.enabled:
            login_call = settings.igate.login_callsign.strip().upper() or mycall
            lines.extend(
                [
                    f"IGSERVER {settings.igate.server_host.strip()}",
                    f"IGLOGIN {login_call} {settings.igate.passcode.strip()}",
                ]
            )
            ig_filter = settings.igate.filter.strip()
            if ig_filter:
                lines.append(f"IGFILTER {ig_filter}")
        comment = (settings.beacon_comment or "").strip()
        if target.operating_mode.value == "terrestrial" and target.region_label:
            comment = f"{comment} [{target.region_label}]".strip()
        lines.append(f"# Target {target.label} {target.frequency_hz}")
        if comment:
            lines.append(f"# Comment {comment}")
        if settings.digipeater.enabled:
            lines.append(f"# Digipeater aliases {','.join(settings.digipeater.aliases)}")
        if settings.igate.enabled:
            lines.append(f"# IGate {settings.igate.server_host.strip()}:{settings.igate.server_port}")
        return "\n".join(lines) + "\n"

    def start(self, settings: AprsSettings, target: AprsTargetState) -> tuple[list[str], list[str]]:
        self.stop()
        self._terminate_conflicting_direwolf(settings.kiss_port)
        self._wait_for_port_state(settings.kiss_port, in_use=False)
        config_text = self.build_config(settings, target)
        self.config_path = self.workdir / "direwolf.conf"
        self.config_path.write_text(config_text, encoding="utf-8")
        self.command = [settings.direwolf_binary, "-c", str(self.config_path.resolve()), "-t", "0"]
        self._kiss_port = int(settings.kiss_port)
        self.output_tail.clear()
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

    def start_network_decoder(
        self,
        settings: AprsSettings,
        target: AprsTargetState,
        *,
        udp_port: int,
        sample_rate: int = 48_000,
    ) -> tuple[list[str], list[str]]:
        self.stop()
        self._terminate_conflicting_direwolf(settings.kiss_port)
        self._wait_for_port_state(settings.kiss_port, in_use=False)
        config_text = self.build_config(settings, target, include_audio_devices=False, include_ptt=False)
        self.config_path = self.workdir / "direwolf.conf"
        self.config_path.write_text(config_text, encoding="utf-8")
        self.command = [
            settings.direwolf_binary,
            "-c",
            str(self.config_path.resolve()),
            "-r",
            str(int(sample_rate)),
            "-n",
            "1",
            "-b",
            "16",
            "-t",
            "0",
            f"UDP:{int(udp_port)}",
        ]
        self._kiss_port = int(settings.kiss_port)
        self.output_tail.clear()
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
            text = line.rstrip()
            self.output_tail.append(text)
            if self._output_observer is not None:
                try:
                    self._output_observer(text)
                except Exception:
                    pass

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
        self._wait_for_port_state(self._kiss_port, in_use=False)

    def is_running(self) -> bool:
        return self.process is not None and self.process.poll() is None

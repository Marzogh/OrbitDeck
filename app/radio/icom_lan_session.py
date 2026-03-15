from __future__ import annotations

"""Threaded OrbitDeck wrapper around the bundled icom-lan async radio API."""

import asyncio
from concurrent.futures import Future
from threading import Event, Thread
from typing import Callable

from app.radio.icom_lan_adapter import AudioCodec, IcomRadio


AudioRxCallback = Callable[[bytes], None]


class IcomLanRadioSession:
    """Threaded synchronous facade over icom-lan's async IcomRadio."""

    def __init__(
        self,
        *,
        host: str,
        control_port: int,
        username: str,
        password: str,
        civ_address: int,
        timeout: float = 8.0,
    ) -> None:
        self._host = host
        self._control_port = int(control_port)
        self._username = username
        self._password = password
        self._civ_address = civ_address
        self._timeout = timeout
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: Thread | None = None
        self._ready = Event()
        self._radio: IcomRadio | None = None

    def _thread_main(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._radio = IcomRadio(
            self._host,
            port=self._control_port,
            username=self._username,
            password=self._password,
            radio_addr=self._civ_address,
            timeout=self._timeout,
            model="IC-705",
            audio_codec=AudioCodec.PCM_1CH_16BIT,
            audio_sample_rate=48000,
        )
        self._ready.set()
        loop.run_forever()
        pending = asyncio.all_tasks(loop)
        for task in pending:
            task.cancel()
        if pending:
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        loop.close()

    def _ensure_loop(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._ready.clear()
        self._thread = Thread(target=self._thread_main, daemon=True)
        self._thread.start()
        self._ready.wait(timeout=3.0)
        if self._loop is None or self._radio is None:
            raise RuntimeError("Failed to start icom-lan session loop")

    def _run(self, coro) -> object:
        self._ensure_loop()
        assert self._loop is not None
        future: Future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=self._timeout + 10.0)

    def connect(self) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.connect())

    def disconnect(self) -> None:
        if self._radio is not None and self._loop is not None:
            try:
                self._run(self._radio.disconnect())
            except Exception:
                pass
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        self._loop = None
        self._thread = None
        self._radio = None

    def snapshot_state(self) -> dict[str, object]:
        self._ensure_loop()
        assert self._radio is not None
        return self._run(self._radio.snapshot_state())

    def restore_state(self, snapshot: dict[str, object]) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.restore_state(snapshot))

    def get_frequency(self) -> int:
        self._ensure_loop()
        assert self._radio is not None
        return self._run(self._radio.get_frequency())

    def get_mode(self, receiver: int = 0) -> tuple[str, int | None]:
        self._ensure_loop()
        assert self._radio is not None
        result = self._run(self._radio.get_mode(receiver=int(receiver)))
        return tuple(result)

    def set_frequency(self, freq_hz: int) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.set_frequency(int(freq_hz)))

    def set_mode(self, mode: str) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.set_mode(mode))

    def set_split_mode(self, on: bool) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.set_split_mode(bool(on)))

    def select_vfo(self, vfo: str) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.select_vfo(vfo))

    def vfo_equalize(self) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.vfo_equalize())

    def set_data_mode(self, on: bool) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.set_data_mode(bool(on)))

    def get_data_mode(self) -> bool:
        self._ensure_loop()
        assert self._radio is not None
        return bool(self._run(self._radio.get_data_mode()))

    def get_data_off_mod_input(self) -> int:
        self._ensure_loop()
        assert self._radio is not None
        return int(self._run(self._radio.get_data_off_mod_input()))

    def get_data1_mod_input(self) -> int:
        self._ensure_loop()
        assert self._radio is not None
        return int(self._run(self._radio.get_data1_mod_input()))

    def set_data_off_mod_input(self, source: int) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.set_data_off_mod_input(int(source)))

    def set_data1_mod_input(self, source: int) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.set_data1_mod_input(int(source)))

    def get_vox(self) -> bool:
        self._ensure_loop()
        assert self._radio is not None
        return bool(self._run(self._radio.get_vox()))

    def set_vox(self, on: bool) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.set_vox(bool(on)))

    def set_squelch(self, level: int, receiver: int = 0) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.set_squelch(int(level), receiver=int(receiver)))

    def enable_scope(self, *, output: bool = False, policy: str = "fast") -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.enable_scope(output=bool(output), policy=policy))

    def set_scope_mode(self, mode: int) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.set_scope_mode(int(mode)))

    def set_scope_span(self, span: int) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.set_scope_span(int(span)))

    def set_ptt(self, on: bool) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.set_ptt(bool(on)))

    def start_audio_rx(self, callback: AudioRxCallback) -> None:
        self._ensure_loop()
        assert self._radio is not None

        def on_audio(packet) -> None:
            if packet is not None and getattr(packet, "data", None):
                callback(bytes(packet.data))

        self._run(self._radio.start_audio_rx_opus(on_audio, jitter_depth=3))

    def stop_audio_rx(self) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.stop_audio_rx_opus())

    def start_audio_tx(self) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.start_audio_tx_opus())

    def push_audio_tx(self, pcm_bytes: bytes) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.push_audio_tx_opus(bytes(pcm_bytes)))

    def stop_audio_tx(self) -> None:
        self._ensure_loop()
        assert self._radio is not None
        self._run(self._radio.stop_audio_tx_opus())

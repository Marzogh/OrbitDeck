from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Lock

from app.models import AprsLogEntry


class AprsLogStore:
    def __init__(self, path: str = "data/aprs/received_log.jsonl") -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    def append(self, entry: AprsLogEntry, *, max_records: int) -> None:
        with self._lock:
            entries = self._load_unlocked()
            entries.insert(0, entry)
            entries = entries[:max(1, int(max_records))]
            self._write_unlocked(entries)

    def list(self, *, limit: int | None = None, packet_type: str | None = None, messages_only: bool = False) -> list[AprsLogEntry]:
        with self._lock:
            entries = self._load_unlocked()
        if messages_only:
            entries = [entry for entry in entries if entry.packet_type == "message"]
        elif packet_type and packet_type != "all":
            entries = [entry for entry in entries if entry.packet_type == packet_type]
        if limit is not None:
            entries = entries[: max(0, int(limit))]
        return entries

    def clear(self, *, age_bucket: str) -> int:
        with self._lock:
            entries = self._load_unlocked()
            if age_bucket == "all":
                removed = len(entries)
                self._write_unlocked([])
                return removed
            now = datetime.now(UTC)
            delta = {
                "7d": timedelta(days=7),
                "30d": timedelta(days=30),
                "90d": timedelta(days=90),
            }.get(age_bucket)
            if delta is None:
                return 0
            cutoff = now - delta
            kept = [entry for entry in entries if entry.received_at >= cutoff]
            removed = len(entries) - len(kept)
            self._write_unlocked(kept)
            return removed

    def export_csv(self) -> str:
        entries = self.list()
        lines = ["received_at,source,destination,packet_type,addressee,path,text,latitude,longitude,message_id,raw_tnc2"]
        for entry in entries:
            lines.append(",".join([
                self._csv(entry.received_at.isoformat()),
                self._csv(entry.source),
                self._csv(entry.destination),
                self._csv(entry.packet_type),
                self._csv(entry.addressee or ""),
                self._csv("|".join(entry.path)),
                self._csv(entry.text),
                self._csv("" if entry.latitude is None else str(entry.latitude)),
                self._csv("" if entry.longitude is None else str(entry.longitude)),
                self._csv(entry.message_id or ""),
                self._csv(entry.raw_tnc2),
            ]))
        return "\n".join(lines) + "\n"

    def export_json(self) -> str:
        entries = [entry.model_dump(mode="json") for entry in self.list()]
        return json.dumps(entries, indent=2)

    def _load_unlocked(self) -> list[AprsLogEntry]:
        if not self.path.exists():
            return []
        entries: list[AprsLogEntry] = []
        with self.path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                entries.append(AprsLogEntry.model_validate_json(line))
        return entries

    def _write_unlocked(self, entries: list[AprsLogEntry]) -> None:
        with self.path.open("w", encoding="utf-8") as handle:
            for entry in entries:
                handle.write(entry.model_dump_json())
                handle.write("\n")

    @staticmethod
    def _csv(value: str) -> str:
        escaped = str(value).replace('"', '""')
        return f'"{escaped}"'

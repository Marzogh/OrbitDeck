from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RegionFrequency:
    label: str
    frequency_hz: int
    min_lat: float
    max_lat: float
    min_lon: float
    max_lon: float

    def matches(self, lat: float, lon: float) -> bool:
        return self.min_lat <= lat <= self.max_lat and self.min_lon <= lon <= self.max_lon


REGION_FREQUENCIES: tuple[RegionFrequency, ...] = (
    RegionFrequency("Japan", 144_660_000, 24.0, 46.5, 123.0, 146.5),
    RegionFrequency("Australia and Oceania", 145_175_000, -50.0, 10.0, 110.0, 180.0),
    RegionFrequency("Europe, Africa, and Middle East", 144_800_000, -40.0, 72.0, -25.0, 60.0),
    RegionFrequency("North and Central America", 144_390_000, 5.0, 85.0, -170.0, -50.0),
    RegionFrequency("South America", 144_390_000, -60.0, 15.0, -90.0, -30.0),
)


def frequency_for_location(lat: float, lon: float) -> tuple[str, int]:
    for region in REGION_FREQUENCIES:
        if region.matches(lat, lon):
            return region.label, region.frequency_hz
    return "Global fallback", 144_390_000

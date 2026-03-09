from datetime import UTC, datetime

from app.models import Satellite
from app.services import DataIngestionService


def test_parse_amsat_satellite_names_from_index_options():
    svc = DataIngestionService()
    html = """
    <select>
      <option value="AO-91_[FM]">AO-91 [FM]</option>
      <option value="ISS_[FM]">ISS [FM]</option>
      <option value="ISS_[APRS]">ISS [APRS]</option>
      <option value="ISS_[FM]">ISS [FM]</option>
    </select>
    """

    assert svc._parse_amsat_satellite_names(html) == ["AO-91_[FM]", "ISS_[FM]", "ISS_[APRS]"]


def test_match_amsat_name_prefers_mode_hint():
    svc = DataIngestionService()
    sat = Satellite(
        sat_id="iss-zarya",
        norad_id=25544,
        name="ISS (ZARYA)",
        is_iss=True,
        transponders=["145.990 MHz downlink", "437.800 MHz APRS"],
        repeaters=["Voice repeater (regional schedule)"],
    )

    match = svc._match_amsat_name(sat, ["ISS_[APRS]", "ISS_[FM]", "ISS_[SSTV]"])

    assert match == "ISS_[FM]"


def test_summarize_amsat_reports_marks_conflicting_when_heard_and_not_heard_exist():
    svc = DataIngestionService()
    status = svc._summarize_amsat_reports(
        "SO-50_[FM]",
        [
            {
                "name": "SO-50_[FM]",
                "reported_time": "2026-03-08T09:30:00Z",
                "callsign": "W1AW",
                "report": "Heard",
                "grid_square": "FN31",
            },
            {
                "name": "SO-50_[FM]",
                "reported_time": "2026-03-08T08:30:00Z",
                "callsign": "K1ABC",
                "report": "Not Heard",
                "grid_square": "EM12",
            },
            {
                "name": "SO-50_[FM]",
                "reported_time": "2026-03-08T07:30:00Z",
                "callsign": "VK4ABC",
                "report": "Telemetry Only",
                "grid_square": "QG62",
            },
        ],
    )

    assert status.summary == "conflicting"
    assert status.reports_last_96h == 3
    assert status.heard_count == 1
    assert status.telemetry_only_count == 1
    assert status.not_heard_count == 1
    assert status.latest_report is not None
    assert status.latest_report.reported_time == datetime(2026, 3, 8, 9, 30, tzinfo=UTC)

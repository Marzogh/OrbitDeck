from datetime import UTC, datetime

from app.models import AppSettings, IssDisplayMode, LiveTrack
from app.services import IssService


def make_track(el: float, sunlit: bool) -> LiveTrack:
    return LiveTrack(
        sat_id="iss",
        name="ISS",
        timestamp=datetime.now(UTC),
        az_deg=120,
        el_deg=el,
        range_km=500,
        range_rate_km_s=1.2,
        sunlit=sunlit,
    )


def test_sunlit_only_video_mode():
    svc = IssService()
    settings = AppSettings(iss_display_mode=IssDisplayMode.sunlit_only_video)

    yes = svc.state(settings, make_track(-10, True))
    no = svc.state(settings, make_track(40, False))

    assert yes.videoEligible is True
    assert no.videoEligible is False


def test_sunlit_and_visible_mode():
    svc = IssService()
    settings = AppSettings(iss_display_mode=IssDisplayMode.sunlit_and_visible_video)

    no_horizon = svc.state(settings, make_track(-1, True))
    no_sun = svc.state(settings, make_track(30, False))
    yes = svc.state(settings, make_track(30, True))

    assert no_horizon.videoEligible is False
    assert no_sun.videoEligible is False
    assert yes.videoEligible is True


def test_telemetry_only_never_eligible():
    svc = IssService()
    settings = AppSettings(iss_display_mode=IssDisplayMode.telemetry_only)

    a = svc.state(settings, make_track(45, True))
    b = svc.state(settings, make_track(-20, False))

    assert a.videoEligible is False
    assert b.videoEligible is False


def test_unhealthy_stream_disables_active_url_only():
    svc = IssService()
    settings = AppSettings(
        iss_display_mode=IssDisplayMode.sunlit_only_video,
        force_stream_unhealthy=True,
        iss_stream_urls=["https://example.com/iss"],
    )
    out = svc.state(settings, make_track(20, True))

    assert out.videoEligible is True
    assert out.streamHealthy is False
    assert out.activeStreamUrl is None

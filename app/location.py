"""Transient observer positions and exclusive station location ownership.

Browser IDs identify an operating device, not an authentication boundary. Existing
TX authorization still applies. Device fixes are never persisted across restarts.
"""
from contextvars import ContextVar
from threading import RLock
from time import monotonic

from app.models import LocationState, LocationUpdate

browser_session: ContextVar[str | None] = ContextVar("browser_session", default=None)


class LocationSessions:
    OWNER_LEASE_S = 90
    MAX_OBSERVERS = 256

    def __init__(self):
        self._lock = RLock()
        self._observers: dict[str, LocationState] = {}
        self._owner: str | None = None
        self._seen = 0.0

    @property
    def owner(self):
        with self._lock:
            if monotonic() - self._seen > self.OWNER_LEASE_S:
                self._owner = None
            return self._owner

    def touch(self, session):
        with self._lock:
            if session and session == self.owner:
                self._seen = monotonic()

    def claim(self, session):
        with self._lock:
            if not session:
                raise ValueError("A browser session ID is required to control the station")
            if self.owner not in (None, session):
                raise ValueError("Another browser holds radio control. Release it there or wait for its 90 second lease to expire.")
            self._owner = session
            self._seen = monotonic()

    def release(self, session):
        with self._lock:
            if session == self.owner:
                self._owner = None

    def observer(self, session, saved):
        with self._lock:
            if session and session in self._observers:
                return self._observers[session].model_copy(deep=True)
            state = saved.model_copy(deep=True)
            state.browser_location = None
            state.gps_location = None
            state.last_known_location = None
            return state

    def clear_device(self, session):
        with self._lock:
            if session in self._observers:
                self._observers[session].browser_location = None

    def update(self, session, saved, update: LocationUpdate, service):
        with self._lock:
            state = service.apply_update(self.observer(session, saved), update)
            if session:
                self._observers.pop(session, None)
                self._observers[session] = state
                while len(self._observers) > self.MAX_OBSERVERS:
                    victim = next(key for key in self._observers if key != self.owner)
                    self._observers.pop(victim)
            return state

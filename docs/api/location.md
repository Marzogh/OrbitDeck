# Location resolution and browser ownership

OrbitDeck keeps the operating device's observer position separate from the
station position used for radio control and APRS. This works with both the
desktop app and hosted browser clients, without deployment-specific URL paths.

## Priority and freshness

- Fresh, valid connected-radio GPS wins for the station and its controlling device.
- Otherwise, the controlling device supplies browser or desktop location.
- An explicitly selected manual profile is the final fallback.
- Missing, invalid or stale fixes resolve to `source: "unavailable"`,
  `available: false`, `lat: null`, `lon: null`. Tracking and predictions return
  empty results. Position transmissions require a resolved station position.
- Radio fixes expire after 30 seconds; device fixes expire after 120 seconds.
  Fix timestamps must include a timezone. Up to five seconds of future clock
  skew is tolerated. Re-reading an old fix never refreshes its timestamp.
- Persisted browser, GPS and last-known coordinates are ignored on startup.
  Manual station configuration persists; live fixes and browser ownership do not.

`GET /api/v1/location` returns the requesting device's `state` and `resolved`,
plus `stationResolved`, `controlOwner`, `controlOccupied` and freshness limits.
Resolved fixes include `source`, `timestamp`, `age_seconds`, `accuracy_m` when
provided, and `available`. Sources are `radio_gps`, `browser`, `desktop`,
`manual` or `unavailable`. Missing accuracy means the provider did not supply it.

## Device sessions

Clients send a stable random `X-OrbitDeck-Session` header. The UI stores this ID
in browser local storage, sharing it across tabs on that browser. It identifies
an operating device; it is not a credential or a replacement for TX authorization.
API clients must send their own distinct session ID for location updates and
radio/APRS operations.

`POST /api/v1/location/control/claim` claims the station explicitly. Radio/APRS
control actions also claim it if free. An existing owner renews its 90 second
lease through API requests; the UI sends a status request every five seconds.
Competing control requests receive HTTP 409. Release with
`POST /api/v1/location/control/release`; release or takeover stops automatic
rig tracking. The emergency-stop endpoint remains accessible to other devices.

Each device posts its own timestamped `browser_location` to
`POST /api/v1/location`. Include `provider` (`browser` or `desktop`) and
`accuracy_m` when available. A device fix never changes another device's
observer or replaces the control owner's station fallback. Browsing-only
clients can select manual observer coordinates and request passes independently.
Only the control owner's location configuration is saved as station settings.

`POST /api/v1/location/device-unavailable` clears that device's fix after
permission denial or revocation. The UI offers permission and manual-coordinate
entry, and continuously watches an approved browser location. Station operations
always resolve the owner's current fix, including background Doppler work.
APRS position sends use that resolved station position, including when a caller
supplies old coordinate fields in the send payload. Configured position offsets
continue to apply. `gps_location` writes are rejected; entered positions belong
in a manual profile, rather than pretending to be radio GPS.

## Radio adapter support

| Model and supported transport | Live GPS acquisition |
| --- | --- |
| IC-705 USB CI-V | Read-only `23 01` GPS selection and `23 00` position status queries, including the UTC fix timestamp. |
| IC-705 Wi-Fi CI-V | Same queries over the existing CI-V connection. APRS uses its existing icom-lan session. |
| ID-5100 serial adapter | No GPS acquisition through this adapter. Use device location or manual coordinates. |

Icom's [IC-705 CI-V reference, pages 15, 21 and 25](https://www.icomeurope.com/wp-content/uploads/2020/08/IC-705_ENG_CI-V_1_20200721.pdf)
specifies the position query and format. OrbitDeck accepts it only with GPS ON,
valid BCD coordinates and a fresh fix time. OFF/manual GPS selections, rejected
commands, timeouts, invalid dates and no-fix data fall back to the device.

The ID-5100 has a built-in receiver, but its current adapter has no GPS reader.
Icom documents [GPS output on the separate DATA jack](https://icomuk.co.uk/files/icom/PDF/productManual/ID-5100_ENG_PRT_1.pdf),
which is not an OrbitDeck-supported GPS transport. A GPS receiver in the radio
is not evidence that its current control adapter supplies location.

Rig-control GPS polling runs every five seconds. During USB APRS, reads piggyback
on the existing tuning connection, with no extra serial reader. Wi-Fi APRS uses
the current async command tracker. GPS query failure does not break tuning or
cause transmission. Disconnect immediately removes that transport's GPS fix.
Transport coverage uses fakes; physical GPS acquisition still needs hardware
acceptance testing. No real transmissions are needed for that test.

## Desktop and hosted runtime

Packaged storage (`ORBITDECK_PACKAGED_APP`) does not enable desktop location.
The desktop launcher independently enables `ORBITDECK_DESKTOP_LOCATION` on its
server; native capability also requires macOS. The native endpoint returns 404
without that capability and 503 on provider failure.

The client calls native location only through its embedded `pywebview` bridge.
A hosted browser never asks the hosting server for native location. Native
errors or stale fixes permit browser geolocation fallback. Browser permission
denial clears the device fix and leaves radio GPS or explicit manual fallback
available. Runtime location status is never served from the lite offline cache.

## Combined TX PIN enforcement

Radio-control ownership does not authorize transmission. APRS send routes also
require the exclusive, boot-scoped TX PIN cookie. Releasing or expiring location
control never expires, transfers or revokes that cookie. Conversely, unlocking
TX does not displace another device's location ownership or create coordinates.
A position send needs both leases on the requesting device and an available
resolved station position. Direct API sends retain these server-side checks.
The shared browser client preserves its device header through a PIN unlock and
retries a rejected send at most once. See [TX authorization](../guide/tx-authorization.md).

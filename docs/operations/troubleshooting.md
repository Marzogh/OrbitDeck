# Troubleshooting

This page covers the most common cases where OrbitDeck starts but does not behave as expected.

## The server starts, but the UI looks wrong or old

Likely causes:

- cached browser assets
- a stale lite service worker
- the backend was restarted but the browser still has older JS/CSS

Try:

1. hard reload the page
2. reopen `/lite` or `/kiosk`
3. if testing lite, revisit `/lite/settings` and `/lite`
4. restart the FastAPI process if frontend and backend changed together

## Lite shows cached data instead of live data

This is expected when the phone cannot currently reach the Pi.

Check:

- whether the Pi is reachable on the network
- whether the cached snapshot age warning says the data is stale
- whether `Sync Now` succeeds once connectivity returns

Important behavior:

- after 12 hours, lite warns strongly that data is stale
- after 24 hours, pass timing should be treated as reference only

## No passes appear in lite

Check:

1. tracked satellites were actually saved in `/lite/settings`
2. the selected location is correct
3. the satellites you chose actually have upcoming passes from that location
4. lite is not outside the next qualifying pass window

Lite and rotator apply filtering rules to the queue output.

## The pass list is empty in kiosk

Check the pass filter profile in `/settings`.

- `IssOnly` will intentionally hide non-ISS passes
- `Favorites` only shows satellites selected in that profile

## GPS mode is selected, but nothing updates

OrbitDeck stores GPS configuration and uses GPS location state if it is present. This repo does not include a GPS daemon or reader process.

So verify:

- `/api/v1/settings/gps` contains the connection settings you expect
- `/api/v1/location` shows `source_mode` set to `gps`
- `gps_location` is actually being populated by whatever external process you are using

If no process is updating `gps_location`, OrbitDeck has nothing live to resolve.

## AMSAT status does not refresh immediately

That can be normal.

OrbitDeck intentionally guards AMSAT refreshes to a minimum 12-hour interval. A manual refresh may still leave AMSAT data unchanged if the guard window has not expired.

## `/radio` connects, but `Poll Rig` fails

Treat this as a CI-V readback problem, not just a UI problem.

Check:

1. the serial device path is correct
2. the configured `civ_address` matches the rig
3. the configured baud rate matches the rig
4. the rig is actually exposing the CI-V port you selected

Important distinction:

- a successful connect only proves that OrbitDeck opened the serial device
- a successful poll proves that OrbitDeck exchanged usable CI-V state with the rig

## `timeout waiting for CI-V response to 0x25`

This can occur after a manual write on the IC-705 path.

Known behavior:

- the rig may still have applied the write successfully
- OrbitDeck may keep the last known good VFO targets in runtime
- a later poll can still recover normal readback

If this appears:

1. verify the rig front panel changed as expected
2. poll again
3. reconnect if the controller state no longer looks trustworthy

## The rig writes the pair, but the runtime still looks stale

Check:

1. poll again after the write
2. reload `/radio` if the page is showing cached frontend code
3. confirm the response payload for the write actually came from the endpoint you used

The `/radio` page now reports the exact endpoint and response body so the request path can be verified without guessing.

## The selected pass says it is not eligible for radio control

The rotator radio workflow currently only accepts:

- VHF `144.000 MHz` to `148.000 MHz`
- UHF `420.000 MHz` to `450.000 MHz`

If both sides fall outside that range, OrbitDeck marks the session ineligible and returns `eligibility_reason`.

## A test session ends, but the rig does not return to the earlier state

OrbitDeck attempts to restore a previously captured snapshot when a test session is confirmed, stopped, or ends after LOS.

If restore fails:

- the request still completes
- the session moves to a released state
- the failure is recorded in `runtime.last_error`

This is intentional so the UI does not crash just because restore failed.

## The rotator is pinned on radio control when you expected normal scene rotation

That means a radio-control session is still active or released-but-pinned.

Use:

- `Back to Rotator` in the rotator UI
- or `POST /api/v1/radio/session/clear`

to clear the selected session and return to the normal rotator flow.

## `ModuleNotFoundError: No module named 'app'`

If this happens when launching from the repo root, you are probably not running the repo’s intended launcher path or interpreter.

Preferred launch commands:

```bash
python3 scripts/run_tracker.py --mode windowed --ui kiosk --host 127.0.0.1 --port 8000
```

or:

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

## The docs site builds locally but GitHub Pages is blank

Check:

1. the `docs` GitHub Actions workflow completed successfully
2. Pages is configured to use `GitHub Actions`
3. the repository Pages URL is the one configured in `mkdocs.yml`

The current docs deployment model does not use a `gh-pages` branch. It uses the GitHub Actions Pages artifact flow.

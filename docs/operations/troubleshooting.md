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

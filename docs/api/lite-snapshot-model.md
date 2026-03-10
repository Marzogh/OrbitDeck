# Lite Snapshot

This page documents the backend behavior behind `GET /api/v1/lite/snapshot`.

## Purpose

The lite snapshot endpoint is the bounded-compute payload used by the lite UI. It is designed to return the full state needed by the low-power/mobile screen in one response.

## What the response includes

The payload includes:

- resolved location
- network state
- ISS state and ISS track
- tracked satellite IDs
- tracked satellite metadata
- live tracks for the tracked set
- pass predictions for the tracked set
- focus satellite, focus track, focus pass, and focus path
- frequency recommendation and matrix for the focus satellite
- timezone state
- GPS settings
- lite settings

## Bounded tracked-satellite enforcement

Lite is intentionally limited to a saved tracked-satellite set.

The enforcement rules are:

- only valid satellite IDs from the current catalog are kept
- duplicate IDs are removed
- the list must contain at least one valid satellite
- the list may contain at most 8 satellites
- if the saved list is empty or invalid, the backend falls back to `iss-zarya` when available

These rules are enforced in `POST /api/v1/settings/lite` and then reused by the lite snapshot builder.

## Snapshot cache behavior

The backend keeps an in-memory `_lite_snapshot_cache`.

The cache key includes:

- the sorted tracked satellite IDs
- requested focus `sat_id`
- optional `location_source`
- rounded latitude
- rounded longitude
- rounded altitude

Each cache entry is valid for:

- 15 seconds

If the same request shape arrives within that window, the cached payload is returned directly.

## Cache invalidation

The lite snapshot cache is cleared when state changes that affect lite output.

Current invalidation points include:

- `GET /api/v1/satellites?refresh_from_sources=true`
- `POST /api/v1/settings/iss-display-mode`
- `POST /api/v1/settings/timezone`
- `POST /api/v1/settings/pass-filter`
- `POST /api/v1/settings/lite`
- `POST /api/v1/location`
- `POST /api/v1/network`
- `POST /api/v1/settings/gps`
- `POST /api/v1/datasets/refresh`

The cache is not cleared for unrelated state changes such as snapshot recording or cache-policy edits.

## Focus selection rules

The lite snapshot builder chooses focus in this order:

1. explicit `sat_id` query parameter if it matches an active track
2. ISS fallback for active track selection when needed
3. first tracked live track if no better match exists

For pass selection:

1. explicit `sat_id` if a matching pass exists
2. ongoing pass if one exists
3. first pass in the ordered pass list

If a future pass is selected and the current time is still before AOS, the snapshot also includes a `focusCue` payload.

## `focusCue`

`focusCue` is produced only when:

- a focus pass exists
- the pass has not started yet

The current implementation emits:

- `type: "aos"`
- the selected satellite ID
- the AOS time
- azimuth and elevation from the track-path sample nearest to AOS

## Relationship to the frontend caches

The lite frontend also maintains:

- a service worker cache for the shell and GET responses
- a `localStorage` snapshot fallback

Those browser-side caches are separate from the backend’s 15-second in-memory lite snapshot cache.

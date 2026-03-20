# Settings-V2 APRS Implementation Log

## 2026-03-15T00:00:00Z - Kickoff
### Implemented
- Seeded local-only implementation log for the APRS console work in `settings-v2`.
- Captured the approved APRS wireframe/spec as the baseline for implementation.

### Design Adjustments
- No design deviations yet.

### Why
- Keep a running local record of design intent, implementation choices, and testing notes without tracking the file in git.

### Tests
- None yet.

### Open Issues
- APRS shared client module still needs extraction.
- APRS local log backend and export endpoints are not implemented yet.
- `settings-v2` APRS section still reflects the older configuration-only layout.

## Approved Wireframe Summary
- Five APRS bands inside `settings-v2`: `Mode Bar`, `Configuration`, `Send`, `Live Heard`, `Inbox / Log`.
- Mode-specific APRS controls:
  - `Terrestrial`: frequency, region hint, PATH, comment, no satellite target controls.
  - `Satellite`: satellite/channel selection, pass state, Doppler/retune context, satellite PATH/comment.
- Single connect/disconnect button with state-driven label and green/red translucent styling.
- `Send` tabs: `Message`, `Status`, `Position`.
- Character limits:
  - message/status hard cap 67
  - position comment hard cap 40 with guidance under 20
- Inline `Live Heard` panel with last 10 packets and filters.
- Drawer/sheet-based `Inbox / Log` with `Recent`, `Messages`, `Stored Log`, and `Future Modes`.
- Stored APRS log is local-only, exportable as CSV and JSON, and clearable by age buckets.

## 2026-03-15T08:35:00Z - Backend Log Plumbing Complete
### Implemented
- Added APRS local log settings to persisted APRS settings state.
- Added `AprsLogStore` JSONL persistence under `data/aprs/received_log.jsonl`.
- Added APRS log APIs for settings, listing, clearing, and CSV/JSON export.
- Hooked APRS receive callbacks so decoded packets are persisted when local logging is enabled.

### Design Adjustments
- Used bounded JSONL rewriting instead of sqlite for the first pass.

### Why
- JSONL keeps the implementation simple and local-only while still supporting export and basic filtering.

### Tests
- Added API tests for APRS log settings round-trip.
- Added API tests for log append on receive, clear, and export endpoints.

### Open Issues
- Frontend still needs to consume the new log and notification APIs.

## 2026-03-15T08:55:00Z - Shared APRS Client Extraction Complete
### Implemented
- Added shared client helpers in `app/static/common/aprs-console.js`.
- Moved APRS packet preview, target summary, character counting, position preview, and API wrappers into the shared module.
- Rewired both `/aprs` and `settings-v2` APRS scripts to use the shared APRS client layer.

### Design Adjustments
- Shared layer is utility-and-API focused rather than a full DOM framework.

### Why
- This keeps business logic aligned across both APRS surfaces without forcing both pages into the same markup.

### Tests
- `node --check app/static/common/aprs-console.js`
- `node --check app/static/kiosk/aprs.js`
- `node --check app/static/kiosk/settings-v2.js`

### Open Issues
- Need broader browser validation for mobile/wide layouts.

## 2026-03-15T09:10:00Z - Settings-V2 APRS UI Shell And Session Flow Complete
### Implemented
- Replaced the old APRS settings form in `settings-v2` with the five-band console structure.
- Added terrestrial/satellite mode pills, single connect/disconnect button, panic unkey, target refresh, send tabs, live heard list, and inbox/log drawer.
- Added live position preview, last TX/last RX cards, heard packet filters, packet detail viewer, and APRS toasts.
- Added log controls for local storage, notifications, max records, export, clear, and future digipeater/iGate placeholders.

### Design Adjustments
- Doppler/pass state currently comes from existing preview/runtime target data rather than introducing new APRS-specific backend fields.
- The inbox/log drawer uses a shared packet detail pane instead of a per-row overlay.

### Why
- This keeps the APRS section dense but still navigable while staying within the existing page architecture.

### Tests
- `node --check app/static/kiosk/settings-v2.js`
- Manual browser validation still pending.

### Open Issues
- Need a real browser pass on desktop and narrow/mobile layouts.
- `/aprs` remains simpler than `settings-v2`, but now shares the same APRS logic and log APIs.

## 2026-03-15T09:18:00Z - Final Polish Pass
### Implemented
- Added APRS counters to both pages with 67-char hard cap for message/status and 40-char hard cap with under-20 guidance for position comments.
- Added targeted APRS API tests and updated test harness setup so local APRS logging is exercised in tests.
- Preserved the local-only implementation log and left it ignored by git.

### Design Adjustments
- Initial packet notifications are suppressed on first page load so historical traffic does not appear as new.

### Why
- Operator notifications should highlight genuinely new traffic, not replay the stored backlog.

### Tests
- `python -m py_compile app/main.py app/models.py app/aprs/service.py app/aprs/log_store.py tests/test_api.py`
- `node --check app/static/common/aprs-console.js`
- `node --check app/static/kiosk/settings-v2.js`
- `node --check app/static/kiosk/aprs.js`
- `PYTHONPATH=. pytest -q tests/test_api.py -k "aprs_log or position_fudge or position_send_uses_mode_specific_default_comment or send_endpoints_increment_tx_counters"`

### Open Issues
- Full end-to-end browser interaction test still required before promoting `/settings-v2` over `/settings`.

## 2026-03-15T09:30:00Z - Post-Integration APRS UI Fixes
### Implemented
- Preserved the APRS terrestrial/satellite mode toggle in `settings-v2` across the background APRS refresh loop until the user saves, refreshes target, or connects.
- Tightened sticky layout rules for the left navigation and runtime cards by making the settings grid explicitly `overflow: visible`, keeping the sticky cards at `fit-content`, and preventing main-column width overflow from interfering with sticky behavior.

### Design Adjustments
- The APRS mode pill is now treated as a local draft control rather than always mirroring the last persisted backend value.

### Why
- The background polling loop is necessary for runtime feedback, but it must not clobber active UI edits.

### Tests
- `node --check app/static/kiosk/settings-v2.js`
- `node --check app/static/common/aprs-console.js`

### Open Issues
- Sticky behavior still needs a live browser check after these CSS adjustments.

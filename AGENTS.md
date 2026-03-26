# Repo Instructions

## Work Logging

Maintain a running local work log for every implementation or debugging session.

Rules:
- Check `notes/logs/` for relevant existing session or feature logs before starting related work.
- Update the log continuously as work happens, not just at the end.
- Record decisions, bugs found, hypotheses, fixes attempted, validation results, and next steps.
- Keep the log local-only and untracked by git.
- Keep all local project logs under `notes/logs/`.
- Preferred session log path: `notes/logs/session.md`
- Branch- or feature-specific logs may use subfolders under `notes/logs/` when helpful.
- If the file does not exist, create it.
- Do not stage or commit the work log unless explicitly asked.

## Branching

- Use `othrys/*` branches by default for feature and debugging work.
- Do not work directly on `main` unless explicitly asked.

## Commit Discipline

- Make detailed commits for meaningful checkpoints.
- Do not bundle unrelated fixes into the same commit.
- Do not commit temporary debug changes, scratch artifacts, or local environment files.

## Shared Backend Safety

- Do not change shared backend behavior unless the bug or requirement actually lives there.
- When lite behavior depends on shared endpoints, prefer isolating lite-specific logic, cache invalidation, and snapshot shaping instead of changing core radio or APRS behavior unnecessarily.

## External Data Refresh Policy

- Respect upstream refresh windows and rate limits.
- Do not force catalog refreshes casually.
- When diagnosing stale external data, surface the current refresh timestamps before changing refresh behavior.
- For background refresh logic, schedule from the last recorded refresh attempt/success time, not from process uptime.

## Lite Product Boundary

Lite mode is the Pi Zero 2 W mobile-first pass-operations surface.

Preserve these priorities:
- bounded tracking
- focused pass workflow
- rig control and Doppler handling
- satellite APRS

Avoid turning lite into a second full kiosk, admin, or terrestrial APRS surface.

## Mobile-First Lite UI

- Treat phone-sized layouts as the primary target for `/lite`.
- Avoid adding controls that depend on wide desktop layouts.
- Keep operator actions explicit, compact, and touch-friendly.

## Testing

- Run the smallest relevant verification first.
- Add targeted regression coverage for bugs you fix when practical.
- If full tests cannot run because dependencies are unavailable in the current shell, state that clearly.

## Local Artifacts

Never stage or commit:
- local notes
- local logs
- temporary virtual environments
- machine-specific scratch files

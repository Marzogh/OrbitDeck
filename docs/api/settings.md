# Settings Models

OrbitDeck persists most operator-facing configuration in app state.

## Main settings groups

### ISS display mode

Controls how ISS-related presentation behaves in the kiosk-oriented UIs.

### Pass filter settings

Controls which satellites are eligible for kiosk pass selection, including favorite-based behavior in the full kiosk workflow.

### Lite settings

Lite settings are separate because lite has its own bounded-compute model. They include:

- tracked satellite IDs
- setup completion
- preferred default focus

The lite settings endpoint enforces:

- at least one valid tracked satellite
- at most 8 tracked satellites

### GPS settings

GPS settings define how Pi GPS hardware should be configured. Supported connection shapes in the current model are:

- USB serial
- Bluetooth

### Developer overrides

Developer overrides are intended for kiosk and rotator debugging, demo control, and scene forcing. They are not a normal end-user requirement.

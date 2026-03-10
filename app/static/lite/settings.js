let trackerApi;
let trackerById;
let trackerSetBrowserLocation;

const MAX_TRACKED_SATS = 8;
const MANUAL_LOCATION_DEBOUNCE_MS = 700;
const LITE_FOCUS_SAT_KEY = "issTrackerLiteFocusSatId";

let currentLiteSettings = null;
let availableSatellites = [];
let selectedDisplayTimezone = "UTC";
let manualLocationTimer = null;
let gpsSettingsTimer = null;
let availableTimezones = [];

function ensureTimezoneSelector() {
  const select = trackerById("displayTimezoneLite");
  if (!select) return;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const fallbackChoices = [browserTz, "UTC"];
  const choices = Array.from(new Set([browserTz, ...availableTimezones, ...fallbackChoices]));
  const sorted = choices.filter((tz) => tz !== "BrowserLocal" && tz !== "UTC").sort((a, b) => a.localeCompare(b));
  const ordered = ["BrowserLocal", "UTC", ...sorted];
  select.innerHTML = ordered
    .map((tz) => `<option value="${tz}">${tz === "BrowserLocal" ? `Browser local (${browserTz})` : tz}</option>`)
    .join("");
}

function renderTrackedSatelliteOptions(selectId, selectedIds) {
  const select = trackerById(selectId);
  if (!select) return;
  const selectedSet = new Set(selectedIds || []);
  select.innerHTML = availableSatellites
    .map((sat) => `<option value="${sat.sat_id}" ${selectedSet.has(sat.sat_id) ? "selected" : ""}>${sat.name}</option>`)
    .join("");
}

function selectedValues(selectId) {
  const select = trackerById(selectId);
  return Array.from(select?.selectedOptions || []).map((o) => o.value).filter(Boolean);
}

function syncLocationControls() {
  const mode = trackerById("locationMode")?.value || "current";
  trackerById("manualCoords")?.classList.toggle("hidden", mode !== "manual");
  trackerById("gpsCardLite")?.classList.toggle("hidden", mode !== "gps");
  const help = trackerById("locationModeHelp");
  if (help) {
    help.textContent = mode === "browser"
      ? "Requests this phone's location and sends it to the Pi immediately."
      : mode === "gps"
        ? "Uses a GPS receiver connected to the Raspberry Pi. Configure USB or Bluetooth below."
        : mode === "manual"
          ? "Shows latitude/longitude entry fields below and saves automatically."
          : "Uses the Raspberry Pi's current saved location source.";
  }
}

function syncGpsControls() {
  const mode = trackerById("gpsConnectionModeLite")?.value || "usb";
  trackerById("gpsUsbFieldsLite")?.classList.toggle("hidden", mode !== "usb");
  trackerById("gpsBluetoothFieldsLite")?.classList.toggle("hidden", mode !== "bluetooth");
}

async function fetchLiteSettings() {
  return trackerApi.get("/api/v1/settings/lite");
}

async function fetchSnapshot() {
  const snapshot = await trackerApi.get("/api/v1/lite/snapshot");
  return snapshot;
}

async function fetchTimezones() {
  try {
    const resp = await trackerApi.get("/api/v1/settings/timezones");
    return Array.isArray(resp.timezones) ? resp.timezones : [];
  } catch (_) {
    return [];
  }
}

async function saveTrackedSatellites() {
  const satIds = selectedValues("liteTrackedSatSettings");
  if (!satIds.length) throw new Error("Select at least one satellite");
  if (satIds.length > MAX_TRACKED_SATS) throw new Error(`Select at most ${MAX_TRACKED_SATS} satellites`);
  const resp = await trackerApi.post("/api/v1/settings/lite", {
    tracked_sat_ids: satIds,
    setup_complete: true,
  });
  currentLiteSettings = resp.state;
  renderTrackedSatelliteOptions("liteTrackedSatSettings", currentLiteSettings.tracked_sat_ids || []);
  trackerById("trackedSatHelp").textContent = `Saved ${satIds.length} tracked satellites.`;
  const focusSelect = trackerById("focusSatSelectLite");
  if (focusSelect && focusSelect.value && !satIds.includes(focusSelect.value)) {
    localStorage.removeItem(LITE_FOCUS_SAT_KEY);
    focusSelect.value = "";
  }
  await hydrate();
}

async function saveTimezone() {
  const picked = trackerById("displayTimezoneLite").value;
  if (!picked) return;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const tzToSave = picked === "BrowserLocal" ? browserTz : picked;
  await trackerApi.post("/api/v1/settings/timezone", { timezone: tzToSave });
  selectedDisplayTimezone = picked === "BrowserLocal" ? "BrowserLocal" : tzToSave;
}

async function saveManual() {
  const lat = Number(trackerById("lat").value);
  const lon = Number(trackerById("lon").value);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return;
  await trackerApi.post("/api/v1/location", {
    add_profile: {
      id: "manual-lite",
      name: "Manual Lite",
      point: { lat, lon, alt_m: 0 },
    },
    selected_profile_id: "manual-lite",
    source_mode: "manual",
  });
}

function scheduleManualLocationSave() {
  if (trackerById("locationMode").value !== "manual") return;
  if (manualLocationTimer) clearTimeout(manualLocationTimer);
  manualLocationTimer = setTimeout(async () => {
    try {
      await saveManual();
    } catch (err) {
      trackerById("manualHelp").textContent = err.message;
    }
  }, MANUAL_LOCATION_DEBOUNCE_MS);
}

async function applyLocationMode() {
  const locationMode = trackerById("locationMode").value;
  if (locationMode === "browser") {
    await trackerSetBrowserLocation();
    await trackerApi.post("/api/v1/location", { source_mode: "browser" });
    return;
  }
  if (locationMode === "gps") {
    await trackerApi.post("/api/v1/location", { source_mode: "gps" });
    return;
  }
  if (locationMode === "current") {
    await trackerApi.post("/api/v1/location", { source_mode: "auto" });
  }
}

async function saveGpsSettings() {
  const payload = {
    connection_mode: trackerById("gpsConnectionModeLite").value,
    serial_device: trackerById("gpsSerialDeviceLite").value,
    baud_rate: Number(trackerById("gpsBaudRateLite").value) || 9600,
    bluetooth_address: trackerById("gpsBluetoothAddressLite").value,
    bluetooth_channel: Number(trackerById("gpsBluetoothChannelLite").value) || 1,
  };
  await trackerApi.post("/api/v1/settings/gps", payload);
}

function scheduleGpsSettingsSave() {
  if (gpsSettingsTimer) clearTimeout(gpsSettingsTimer);
  gpsSettingsTimer = setTimeout(async () => {
    try {
      await saveGpsSettings();
    } catch (_) {}
  }, MANUAL_LOCATION_DEBOUNCE_MS);
}

function populateFocusSelect(trackedSatellites) {
  const focusSatSelect = trackerById("focusSatSelectLite");
  if (!focusSatSelect) return;
  const savedFocusSatId = localStorage.getItem(LITE_FOCUS_SAT_KEY) || "";
  focusSatSelect.innerHTML = [
    '<option value="">Auto (selected/live pass)</option>',
    ...(trackedSatellites || []).map((sat) => `<option value="${sat.sat_id}">${sat.name}</option>`),
  ].join("");
  focusSatSelect.value = savedFocusSatId;
}

async function hydrate() {
  const [settings, snapshot, timezones] = await Promise.all([
    fetchLiteSettings(),
    fetchSnapshot(),
    fetchTimezones(),
  ]);
  currentLiteSettings = settings.state;
  availableSatellites = settings.availableSatellites || [];
  availableTimezones = timezones;
  selectedDisplayTimezone = snapshot.timezone?.timezone || "UTC";

  renderTrackedSatelliteOptions("liteTrackedSatSettings", currentLiteSettings?.tracked_sat_ids || []);
  populateFocusSelect(snapshot.trackedSatellites || []);
  ensureTimezoneSelector();

  const tzSelect = trackerById("displayTimezoneLite");
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const desired = selectedDisplayTimezone === browserTz ? "BrowserLocal" : selectedDisplayTimezone;
  if ([...tzSelect.options].some((o) => o.value === desired)) tzSelect.value = desired;

  trackerById("locationMode").value =
    snapshot.location?.source === "browser" ? "browser"
      : snapshot.location?.source === "gps" ? "gps"
        : snapshot.location?.source === "manual" ? "manual"
          : "current";
  syncLocationControls();

  const gps = snapshot.gpsSettings?.state;
  if (gps) {
    trackerById("gpsConnectionModeLite").value = gps.connection_mode || "usb";
    trackerById("gpsSerialDeviceLite").value = gps.serial_device || "";
    trackerById("gpsBaudRateLite").value = gps.baud_rate || 9600;
    trackerById("gpsBluetoothAddressLite").value = gps.bluetooth_address || "";
    trackerById("gpsBluetoothChannelLite").value = gps.bluetooth_channel || 1;
  }
  syncGpsControls();
}

window.addEventListener("DOMContentLoaded", async () => {
  ({
    api: trackerApi,
    byId: trackerById,
    setBrowserLocation: trackerSetBrowserLocation,
  } = window.issTracker);

  trackerById("saveTrackedSatSettings").addEventListener("click", async () => {
    try {
      await saveTrackedSatellites();
    } catch (err) {
      trackerById("trackedSatHelp").textContent = err.message;
    }
  });

  trackerById("focusSatSelectLite").addEventListener("change", () => {
    const value = trackerById("focusSatSelectLite").value || "";
    if (value) localStorage.setItem(LITE_FOCUS_SAT_KEY, value);
    else localStorage.removeItem(LITE_FOCUS_SAT_KEY);
  });

  trackerById("displayTimezoneLite").addEventListener("change", async () => {
    await saveTimezone();
  });

  trackerById("locationMode").addEventListener("change", async () => {
    syncLocationControls();
    await applyLocationMode();
  });

  trackerById("lat").addEventListener("input", scheduleManualLocationSave);
  trackerById("lon").addEventListener("input", scheduleManualLocationSave);
  trackerById("gpsConnectionModeLite").addEventListener("change", async () => {
    syncGpsControls();
    await saveGpsSettings();
  });
  trackerById("gpsSerialDeviceLite").addEventListener("input", scheduleGpsSettingsSave);
  trackerById("gpsBaudRateLite").addEventListener("input", scheduleGpsSettingsSave);
  trackerById("gpsBluetoothAddressLite").addEventListener("input", scheduleGpsSettingsSave);
  trackerById("gpsBluetoothChannelLite").addEventListener("input", scheduleGpsSettingsSave);

  await hydrate();
});

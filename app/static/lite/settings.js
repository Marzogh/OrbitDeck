let trackerApi;
let trackerById;
let trackerSetBrowserLocation;

const MAX_TRACKED_SATS = 5;
const MANUAL_LOCATION_DEBOUNCE_MS = 700;
const LITE_FOCUS_SAT_KEY = "issTrackerLiteFocusSatId";

let currentLiteSettings = null;
let availableSatellites = [];
let availableTimezones = [];
let manualLocationTimer = null;
let gpsSettingsTimer = null;

function defaultsForModel(model) {
  return model === "ic705"
    ? { baud_rate: 19200, civ_address: "0xA4" }
    : { baud_rate: 19200, civ_address: "0x8C" };
}

function ensureTimezoneSelector(selectedTimezone) {
  const select = trackerById("displayTimezoneLite");
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const fallbackChoices = [browserTz, "UTC"];
  const choices = Array.from(new Set([browserTz, ...availableTimezones, ...fallbackChoices]));
  const sorted = choices.filter((tz) => tz !== "BrowserLocal" && tz !== "UTC").sort((a, b) => a.localeCompare(b));
  const ordered = ["BrowserLocal", "UTC", ...sorted];
  select.innerHTML = ordered
    .map((tz) => `<option value="${tz}">${tz === "BrowserLocal" ? `Browser local (${browserTz})` : tz}</option>`)
    .join("");
  const desired = selectedTimezone === browserTz ? "BrowserLocal" : selectedTimezone;
  if ([...select.options].some((o) => o.value === desired)) select.value = desired;
}

function renderTrackedSatelliteOptions(selectId, selectedIds) {
  const select = trackerById(selectId);
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
  trackerById("locationModeHelp").textContent = mode === "browser"
    ? "Requests this phone's location and sends it to the Pi immediately."
    : mode === "gps"
      ? "Uses a GPS receiver connected to the Raspberry Pi."
      : mode === "manual"
        ? "Shows latitude/longitude entry fields below and saves automatically."
        : "Uses the Raspberry Pi's current saved location source.";
}

function syncGpsControls() {
  const mode = trackerById("gpsConnectionModeLite")?.value || "usb";
  trackerById("gpsUsbFieldsLite")?.classList.toggle("hidden", mode !== "usb");
  trackerById("gpsBluetoothFieldsLite")?.classList.toggle("hidden", mode !== "bluetooth");
}

function syncRadioControls() {
  const mode = trackerById("liteRadioTransportMode").value || "usb";
  trackerById("liteRadioUsbFields").classList.toggle("hidden", mode !== "usb");
  trackerById("liteRadioWifiFields").classList.toggle("hidden", mode !== "wifi");
}

async function fetchLiteSettings() {
  const resp = await trackerApi.get("/api/v1/settings/lite");
  if (!Array.isArray(resp.availableSatellites) || !resp.availableSatellites.length) {
    try {
      const satellites = await trackerApi.get("/api/v1/satellites");
      resp.availableSatellites = satellites.items || [];
    } catch (_) {}
  }
  return resp;
}

async function fetchSnapshot() {
  return trackerApi.get("/api/v1/lite/snapshot");
}

async function fetchTimezones() {
  try {
    const resp = await trackerApi.get("/api/v1/settings/timezones");
    return Array.isArray(resp.timezones) ? resp.timezones : [];
  } catch (_) {
    return [];
  }
}

async function fetchRadioSettings() {
  return trackerApi.get("/api/v1/settings/radio");
}

async function fetchAprsSettings() {
  return trackerApi.get("/api/v1/settings/aprs");
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
  if (focusSelect?.value && !satIds.includes(focusSelect.value)) {
    localStorage.removeItem(LITE_FOCUS_SAT_KEY);
    focusSelect.value = "";
  }
  await hydrate();
}

async function saveTimezone() {
  const picked = trackerById("displayTimezoneLite").value;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const tzToSave = picked === "BrowserLocal" ? browserTz : picked;
  await trackerApi.post("/api/v1/settings/timezone", { timezone: tzToSave });
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
  await trackerApi.post("/api/v1/settings/gps", {
    connection_mode: trackerById("gpsConnectionModeLite").value,
    serial_device: trackerById("gpsSerialDeviceLite").value,
    baud_rate: Number(trackerById("gpsBaudRateLite").value) || 9600,
    bluetooth_address: trackerById("gpsBluetoothAddressLite").value,
    bluetooth_channel: Number(trackerById("gpsBluetoothChannelLite").value) || 1,
  });
}

function scheduleGpsSettingsSave() {
  if (gpsSettingsTimer) clearTimeout(gpsSettingsTimer);
  gpsSettingsTimer = setTimeout(async () => {
    try {
      await saveGpsSettings();
    } catch (_) {}
  }, MANUAL_LOCATION_DEBOUNCE_MS);
}

async function saveRadioSettings() {
  const payload = {
    enabled: true,
    rig_model: trackerById("liteRadioRigModel").value,
    transport_mode: trackerById("liteRadioTransportMode").value,
    serial_device: trackerById("liteRadioSerialDevice").value,
    wifi_host: trackerById("liteRadioWifiHost").value,
    wifi_username: trackerById("liteRadioWifiUsername").value,
    wifi_password: trackerById("liteRadioWifiPassword").value,
    wifi_control_port: Number(trackerById("liteRadioWifiControlPort").value || 50001),
    baud_rate: Number(trackerById("liteRadioBaudRate").value || 19200),
    civ_address: trackerById("liteRadioCivAddress").value,
    auto_track_interval_ms: Number(trackerById("liteRadioTrackIntervalMs").value || 1500),
    default_apply_mode_and_tone: trackerById("liteRadioApplyModeTone").checked,
  };
  await trackerApi.post("/api/v1/settings/radio", payload);
  trackerById("liteRadioSettingsHelp").textContent = "Saved radio settings for lite pass control.";
}

async function saveAprsSettings() {
  const current = await fetchAprsSettings();
  const payload = {
    enabled: true,
    callsign: trackerById("liteAprsCallsign").value,
    ssid: Number(trackerById("liteAprsSsid").value || 10),
    listen_only: trackerById("liteAprsListenOnly").checked,
    operating_mode: "satellite",
    satellite_path: trackerById("liteAprsSatellitePath").value,
    satellite_beacon_comment: trackerById("liteAprsSatelliteComment").value,
    rig_model: current.state?.rig_model || "ic705",
    serial_device: current.state?.serial_device || "/dev/ttyUSB0",
    baud_rate: current.state?.baud_rate || 19200,
    civ_address: current.state?.civ_address || "0xA4",
  };
  await trackerApi.post("/api/v1/settings/aprs", payload);
  trackerById("liteAprsSettingsHelp").textContent = "Saved satellite APRS defaults for lite operations.";
}

function populateFocusSelect(trackedSatellites) {
  const focusSatSelect = trackerById("focusSatSelectLite");
  const savedFocusSatId = localStorage.getItem(LITE_FOCUS_SAT_KEY) || "";
  focusSatSelect.innerHTML = [
    '<option value="">Auto (selected/live pass)</option>',
    ...(trackedSatellites || []).map((sat) => `<option value="${sat.sat_id}">${sat.name}</option>`),
  ].join("");
  focusSatSelect.value = savedFocusSatId;
}

async function hydrate() {
  const [settings, snapshot, timezones, radioSettings, aprsSettings] = await Promise.all([
    fetchLiteSettings(),
    fetchSnapshot(),
    fetchTimezones(),
    fetchRadioSettings(),
    fetchAprsSettings(),
  ]);
  currentLiteSettings = settings.state;
  availableSatellites = settings.availableSatellites || [];
  availableTimezones = timezones;

  renderTrackedSatelliteOptions("liteTrackedSatSettings", currentLiteSettings?.tracked_sat_ids || []);
  populateFocusSelect(snapshot.trackedSatellites || []);
  ensureTimezoneSelector(snapshot.timezone?.timezone || "UTC");

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

  const radio = radioSettings.state || {};
  trackerById("liteRadioRigModel").value = radio.rig_model || "id5100";
  trackerById("liteRadioTransportMode").value = radio.transport_mode || "usb";
  trackerById("liteRadioSerialDevice").value = radio.serial_device || "";
  trackerById("liteRadioWifiHost").value = radio.wifi_host || "";
  trackerById("liteRadioWifiUsername").value = radio.wifi_username || "";
  trackerById("liteRadioWifiPassword").value = radio.wifi_password || "";
  trackerById("liteRadioWifiControlPort").value = radio.wifi_control_port || 50001;
  trackerById("liteRadioBaudRate").value = radio.baud_rate || 19200;
  trackerById("liteRadioCivAddress").value = radio.civ_address || defaultsForModel(radio.rig_model || "id5100").civ_address;
  trackerById("liteRadioTrackIntervalMs").value = radio.auto_track_interval_ms || 1500;
  trackerById("liteRadioApplyModeTone").checked = radio.default_apply_mode_and_tone !== false;
  syncRadioControls();

  const aprs = aprsSettings.state || {};
  trackerById("liteAprsCallsign").value = aprs.callsign || "N0CALL";
  trackerById("liteAprsSsid").value = aprs.ssid ?? 10;
  trackerById("liteAprsListenOnly").checked = !!aprs.listen_only;
  trackerById("liteAprsSatellitePath").value = aprs.satellite_path || "ARISS";
  trackerById("liteAprsSatelliteComment").value = aprs.satellite_beacon_comment || "OrbitDeck Space APRS";
}

window.addEventListener("DOMContentLoaded", async () => {
  ({ api: trackerApi, byId: trackerById, setBrowserLocation: trackerSetBrowserLocation } = window.issTracker);

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
  trackerById("displayTimezoneLite").addEventListener("change", saveTimezone);
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
  trackerById("liteRadioRigModel").addEventListener("change", () => {
    const defaults = defaultsForModel(trackerById("liteRadioRigModel").value);
    trackerById("liteRadioBaudRate").value = defaults.baud_rate;
    trackerById("liteRadioCivAddress").value = defaults.civ_address;
    if (trackerById("liteRadioRigModel").value !== "ic705" && trackerById("liteRadioTransportMode").value === "wifi") {
      trackerById("liteRadioTransportMode").value = "usb";
    }
    syncRadioControls();
  });
  trackerById("liteRadioTransportMode").addEventListener("change", syncRadioControls);
  trackerById("saveLiteRadioSettings").addEventListener("click", async () => {
    try {
      await saveRadioSettings();
    } catch (err) {
      trackerById("liteRadioSettingsHelp").textContent = err.message;
    }
  });
  trackerById("saveLiteAprsSettings").addEventListener("click", async () => {
    try {
      await saveAprsSettings();
    } catch (err) {
      trackerById("liteAprsSettingsHelp").textContent = err.message;
    }
  });

  await hydrate();
});

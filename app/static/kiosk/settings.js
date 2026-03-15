let trackerApi;
let trackerById;
let trackerSetBrowserLocation;
let trackerRenderStationBadge;
let selectedPassProfile = "IssOnly";
let selectedPassSatIds = ["iss-zarya"];
let selectedDisplayTimezone = "UTC";
let passProfileEditorOpen = false;
const TRACKED_SAT_KEY = "kioskTrackedSatId";
const VIDEO_SOURCES_KEY = "kioskVideoSources";
const DEV_MODE_KEY = "kioskDevModeEnabled";
const DEV_FORCE_SCENE_KEY = "kioskDevForceScene";
const DEFAULT_VIDEO_SOURCES = [
  "https://www.youtube.com/embed/fO9e9jnhYK8?autoplay=1&mute=1&rel=0&modestbranding=1",
  "https://www.youtube.com/embed/sWasdbDVNvc?autoplay=1&mute=1&rel=0&modestbranding=1",
];
let availableTimezones = [];

function isHamFrequencySatellite(sat) {
  if (!sat || sat.has_amateur_radio === false) return false;
  const tx = Array.isArray(sat.transponders) ? sat.transponders : [];
  const rx = Array.isArray(sat.repeaters) ? sat.repeaters : [];
  const joined = [...tx, ...rx].join(" ").toLowerCase();
  if (!joined.trim()) return false;
  return /(mhz|aprs|fm|ssb|cw|bpsk|fsk|afsk|transponder|repeater|ctcss|sstv)/.test(joined);
}

function updateClock() {
  const d = new Date();
  const iso = d.toISOString().replace("T", " ").slice(0, 19);
  trackerById("clock").textContent = `${iso} UTC`;
}

function syncPassProfileUi() {
  trackerById("passProfile").value = selectedPassProfile;
  const canEdit = selectedPassProfile === "Favorites";
  trackerById("passSatSelect").disabled = !canEdit;
  trackerById("editPassProfile").style.display = canEdit ? "inline-block" : "none";
  trackerById("passProfileEditor").classList.toggle("hidden", !(canEdit && passProfileEditorOpen));
}

function ensurePassSatSelector(items) {
  const hamItems = items.filter(isHamFrequencySatellite);
  const select = trackerById("passSatSelect");
  select.innerHTML = hamItems
    .map((s) => `<option value="${s.sat_id}">${s.name} (${s.norad_id})</option>`)
    .join("");
  for (const opt of select.options) opt.selected = selectedPassSatIds.includes(opt.value);
}

function ensureTrackSelector(items) {
  const hamItems = items.filter(isHamFrequencySatellite);
  const select = trackerById("trackSatSelect");
  const saved = localStorage.getItem(TRACKED_SAT_KEY) || "iss-zarya";
  select.innerHTML = hamItems.map((s) => `<option value="${s.sat_id}">${s.name}</option>`).join("");
  if (hamItems.some((s) => s.sat_id === saved)) select.value = saved;
  else if (hamItems.length) select.value = hamItems[0].sat_id;
}

function getDevSettings() {
  return {
    enabled: localStorage.getItem(DEV_MODE_KEY) === "1",
    forceScene: localStorage.getItem(DEV_FORCE_SCENE_KEY) || "auto",
  };
}

function ensureTimezoneSelector() {
  const select = trackerById("displayTimezone");
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const fallbackChoices = [browserTz, "UTC"];
  const choices = Array.from(new Set([browserTz, ...availableTimezones, ...fallbackChoices]));
  const sorted = choices.filter((t) => t !== "BrowserLocal" && t !== "UTC").sort((a, b) => a.localeCompare(b));
  const ordered = ["BrowserLocal", "UTC", ...sorted];
  select.innerHTML = ordered
    .map((tz) => `<option value="${tz}">${tz === "BrowserLocal" ? `Browser local (${browserTz})` : tz}</option>`)
    .join("");
  select.value = selectedDisplayTimezone;
}

async function fetchTimezones() {
  try {
    const resp = await trackerApi.get("/api/v1/settings/timezones");
    return Array.isArray(resp.timezones) ? resp.timezones : [];
  } catch (_) {
    return [];
  }
}

function syncLocationModeUi() {
  const mode = trackerById("locationMode").value;
  trackerById("manualLocationGroup").classList.toggle("hidden", mode !== "manual");
  trackerById("gpsLocationGroup").classList.toggle("hidden", mode !== "gps");
}

function syncDeveloperOverridesUi() {
  const dev = getDevSettings();
  trackerById("devOverridesEnabled").checked = dev.enabled;
  trackerById("devOverridesPanel").classList.toggle("hidden", !dev.enabled);
  trackerById("devForceScene").value = dev.forceScene;
}

function syncDeveloperOverridesDraftUi() {
  const enabled = trackerById("devOverridesEnabled").checked;
  trackerById("devOverridesPanel").classList.toggle("hidden", !enabled);
}

function saveDevSettings() {
  const enabled = trackerById("devOverridesEnabled").checked;
  localStorage.setItem(DEV_MODE_KEY, enabled ? "1" : "0");
  localStorage.setItem(DEV_FORCE_SCENE_KEY, enabled ? (trackerById("devForceScene").value || "auto") : "auto");
}

function loadVideoSources() {
  try {
    const raw = localStorage.getItem(VIDEO_SOURCES_KEY);
    if (!raw) return [...DEFAULT_VIDEO_SOURCES];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [...DEFAULT_VIDEO_SOURCES];
    const cleaned = arr.map((x) => String(x || "").trim()).filter(Boolean);
    return cleaned.length ? cleaned : [...DEFAULT_VIDEO_SOURCES];
  } catch (_) {
    return [...DEFAULT_VIDEO_SOURCES];
  }
}

function saveVideoSources() {
  const primary = String(trackerById("videoSourcePrimary").value || "").trim();
  const secondary = String(trackerById("videoSourceSecondary").value || "").trim();
  const sources = [primary, secondary].filter(Boolean);
  if (!sources.length) {
    throw new Error("At least one video source is required");
  }
  localStorage.setItem(VIDEO_SOURCES_KEY, JSON.stringify(sources));
}

async function loadRadioState() {
  try {
    const resp = await trackerApi.get("/api/v1/radio/state");
    const settings = resp.settings || {};
    const runtime = resp.runtime || {};
    trackerById("radioRigModel").value = settings.rig_model || "id5100";
    trackerById("radioSerialDevice").value = settings.serial_device || "";
    trackerById("radioBaudRate").value = settings.baud_rate || 19200;
    trackerById("radioCivAddress").value = settings.civ_address || "0x8C";
    trackerById("radioPollInterval").value = settings.poll_interval_ms || 1000;
    trackerById("radioAutoTrackInterval").value = settings.auto_track_interval_ms || 1500;
    trackerById("radioEnabled").checked = !!settings.enabled;
    trackerById("radioAutoConnect").checked = !!settings.auto_connect;
    trackerById("radioApplyModeTone").checked = settings.default_apply_mode_and_tone !== false;
    trackerById("radioSafeTxGuard").checked = settings.safe_tx_guard_enabled !== false;
    trackerById("radioStatus").textContent =
      `Rig: ${settings.rig_model || "--"} | ${runtime.connected ? "Connected" : "Disconnected"}`
      + (runtime.last_error ? ` | ${runtime.last_error}` : "");
  } catch (err) {
    trackerById("radioStatus").textContent = `Rig: unavailable | ${err?.message || err}`;
  }
}

async function loadAprsState() {
  try {
    const resp = await trackerApi.get("/api/v1/aprs/state");
    const settings = resp.settings || {};
    const runtime = resp.runtime || {};
    trackerById("aprsStatus").textContent =
      `APRS: ${settings.operating_mode || "--"} | ${runtime.connected ? "Connected" : "Disconnected"}`
      + (runtime.target?.frequency_hz ? ` | ${runtime.target.frequency_hz} Hz` : "")
      + (runtime.last_error ? ` | ${runtime.last_error}` : "");
  } catch (err) {
    trackerById("aprsStatus").textContent = `APRS: unavailable | ${err?.message || err}`;
  }
}

async function saveRadioSettings() {
  const payload = {
    enabled: trackerById("radioEnabled").checked,
    rig_model: trackerById("radioRigModel").value,
    serial_device: trackerById("radioSerialDevice").value,
    baud_rate: Number(trackerById("radioBaudRate").value),
    civ_address: trackerById("radioCivAddress").value,
    poll_interval_ms: Number(trackerById("radioPollInterval").value),
    auto_connect: trackerById("radioAutoConnect").checked,
    auto_track_interval_ms: Number(trackerById("radioAutoTrackInterval").value),
    default_apply_mode_and_tone: trackerById("radioApplyModeTone").checked,
    safe_tx_guard_enabled: trackerById("radioSafeTxGuard").checked,
  };
  await trackerApi.post("/api/v1/settings/radio", payload);
  await loadRadioState();
}

async function saveTimezone() {
  const picked = trackerById("displayTimezone").value;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const tzToSave = picked === "BrowserLocal" ? browserTz : picked;
  await trackerApi.post("/api/v1/settings/timezone", { timezone: tzToSave });
  selectedDisplayTimezone = picked === "BrowserLocal" ? "BrowserLocal" : tzToSave;
}

async function loadState() {
  const [mode, sats, locationState, passFilter, timezone, timezones, system, cachePolicy] = await Promise.all([
    trackerApi.get("/api/v1/settings/iss-display-mode"),
    trackerApi.get("/api/v1/satellites"),
    trackerApi.get("/api/v1/location"),
    trackerApi.get("/api/v1/settings/pass-filter"),
    trackerApi.get("/api/v1/settings/timezone"),
    fetchTimezones(),
    trackerApi.get("/api/v1/system/state"),
    trackerApi.get("/api/v1/cache-policy"),
  ]);
  trackerById("issMode").value = mode.mode;
  selectedPassProfile = passFilter.profile || "IssOnly";
  selectedPassSatIds = Array.isArray(passFilter.satIds) && passFilter.satIds.length
    ? passFilter.satIds
    : ["iss-zarya"];
  selectedDisplayTimezone = timezone.timezone || "UTC";
  availableTimezones = timezones;
  trackerById("locationMode").value = locationState.state.source_mode;
  const sources = loadVideoSources();
  trackerById("videoSourcePrimary").value = sources[0] || "";
  trackerById("videoSourceSecondary").value = sources[1] || "";
  if (trackerRenderStationBadge) {
    trackerRenderStationBadge("stationBadge", system.stationIdentity, system.aprsSettings);
  }
  const staleAfter = cachePolicy?.state?.stale_after_hours;
  trackerById("passCacheStatus").textContent = `Pass cache: stored locally | stale after ${staleAfter || "--"}h | use Refresh Pass Cache to rebuild`;
  ensureTrackSelector(sats.items);
  ensurePassSatSelector(sats.items);
  ensureTimezoneSelector();
  syncPassProfileUi();
  syncLocationModeUi();
  syncDeveloperOverridesUi();
  await loadRadioState();
  await loadAprsState();
}

window.addEventListener("DOMContentLoaded", async () => {
  ({
    api: trackerApi,
    byId: trackerById,
    setBrowserLocation: trackerSetBrowserLocation,
    renderStationBadge: trackerRenderStationBadge,
  } = window.issTracker);

  trackerById("saveMode").addEventListener("click", async () => {
    await trackerApi.post("/api/v1/settings/iss-display-mode", { mode: trackerById("issMode").value });
  });

  trackerById("trackSatSelect").addEventListener("change", () => {
    localStorage.setItem(TRACKED_SAT_KEY, trackerById("trackSatSelect").value);
  });

  trackerById("displayTimezone").addEventListener("change", async () => {
    await saveTimezone();
  });

  trackerById("passProfile").addEventListener("change", () => {
    selectedPassProfile = trackerById("passProfile").value;
    if (selectedPassProfile !== "Favorites") passProfileEditorOpen = false;
    syncPassProfileUi();
  });

  trackerById("editPassProfile").addEventListener("click", () => {
    passProfileEditorOpen = !passProfileEditorOpen;
    syncPassProfileUi();
  });

  trackerById("savePassProfile").addEventListener("click", async () => {
    const profile = trackerById("passProfile").value;
    const satIds = Array.from(trackerById("passSatSelect").selectedOptions).map((o) => o.value);
    await trackerApi.post("/api/v1/settings/pass-filter", { profile, sat_ids: satIds });
    selectedPassProfile = profile;
    selectedPassSatIds = satIds.length ? satIds : ["iss-zarya"];
    passProfileEditorOpen = false;
    syncPassProfileUi();
  });

  trackerById("locationMode").addEventListener("change", async () => {
    const source_mode = trackerById("locationMode").value;
    syncLocationModeUi();
    if (source_mode === "browser") await trackerSetBrowserLocation();
    await trackerApi.post("/api/v1/location", { source_mode });
  });

  trackerById("applyManual").addEventListener("click", async () => {
    const lat = Number(trackerById("manualLat").value);
    const lon = Number(trackerById("manualLon").value);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return;
    await trackerApi.post("/api/v1/location", {
      source_mode: "manual",
      add_profile: { id: "manual-kiosk", name: "Manual Kiosk", point: { lat, lon, alt_m: 0 } },
      selected_profile_id: "manual-kiosk",
    });
  });

  trackerById("applyGps").addEventListener("click", async () => {
    const lat = Number(trackerById("gpsLat").value);
    const lon = Number(trackerById("gpsLon").value);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return;
    await trackerApi.post("/api/v1/location", {
      source_mode: "gps",
      gps_location: { lat, lon, alt_m: 0 },
    });
  });

  trackerById("saveVideoSources").addEventListener("click", () => {
    saveVideoSources();
  });

  trackerById("radioRigModel").addEventListener("change", () => {
    const model = trackerById("radioRigModel").value;
    trackerById("radioBaudRate").value = 19200;
    trackerById("radioCivAddress").value = model === "ic705" ? "0xA4" : "0x8C";
  });

  trackerById("saveRadioSettings").addEventListener("click", async () => {
    await saveRadioSettings();
  });

  trackerById("connectRadio").addEventListener("click", async () => {
    await trackerApi.post("/api/v1/radio/connect", {});
    await loadRadioState();
  });

  trackerById("disconnectRadio").addEventListener("click", async () => {
    await trackerApi.post("/api/v1/radio/disconnect", {});
    await loadRadioState();
  });

  trackerById("devOverridesEnabled").addEventListener("change", () => {
    syncDeveloperOverridesDraftUi();
  });

  trackerById("saveDevOverrides").addEventListener("click", () => {
    saveDevSettings();
    syncDeveloperOverridesUi();
  });

  trackerById("refreshNow").addEventListener("click", loadState);
  trackerById("refreshPassCache").addEventListener("click", async () => {
    trackerById("passCacheStatus").textContent = "Pass cache: clearing cached pass data...";
    await trackerApi.post("/api/v1/passes/cache/refresh", {});
    await loadState();
  });
  trackerById("returnKiosk").addEventListener("click", () => {
    window.location.href = "/";
  });
  trackerById("returnRotator").addEventListener("click", () => {
    window.location.href = "/kiosk-rotator";
  });

  updateClock();
  setInterval(updateClock, 1000);
  await loadState();
});

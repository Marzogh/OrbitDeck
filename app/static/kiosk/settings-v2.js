let trackerApi;
let trackerById;
let trackerSetBrowserLocation;
let trackerRenderStationBadge;

const TRACKED_SAT_KEY = "kioskTrackedSatId";
const VIDEO_SOURCES_KEY = "kioskVideoSources";
const DEV_MODE_KEY = "kioskDevModeEnabled";
const DEV_FORCE_SCENE_KEY = "kioskDevForceScene";
const DEFAULT_VIDEO_SOURCES = [
  "https://www.youtube.com/embed/fO9e9jnhYK8?autoplay=1&mute=1&rel=0&modestbranding=1",
  "https://www.youtube.com/embed/sWasdbDVNvc?autoplay=1&mute=1&rel=0&modestbranding=1",
];

let stateCache = {
  satellites: [],
  timezones: [],
  radio: { settings: {}, runtime: {} },
  aprs: { settings: {}, runtime: {}, previewTarget: null },
  aprsTargets: { satellites: [], terrestrial: null },
  location: { state: {} },
  system: {},
  cachePolicy: {},
};

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function setRuntime(action, value) {
  trackerById("v2RuntimeLog").textContent = pretty({ action, ...value });
}

async function runAction(action, fn) {
  setRuntime(action, { status: "pending" });
  try {
    const resp = await fn();
    setRuntime(action, { status: "ok", response: resp });
    return resp;
  } catch (error) {
    setRuntime(action, {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function updateClock() {
  const d = new Date();
  trackerById("clock").textContent = `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
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

function saveVideoSourcesLocal() {
  const primary = String(trackerById("v2VideoSourcePrimary").value || "").trim();
  const secondary = String(trackerById("v2VideoSourceSecondary").value || "").trim();
  const sources = [primary, secondary].filter(Boolean);
  if (!sources.length) {
    throw new Error("At least one video source is required");
  }
  localStorage.setItem(VIDEO_SOURCES_KEY, JSON.stringify(sources));
}

function getDevSettings() {
  return {
    enabled: localStorage.getItem(DEV_MODE_KEY) === "1",
    forceScene: localStorage.getItem(DEV_FORCE_SCENE_KEY) || "auto",
  };
}

function saveDevSettings() {
  const enabled = trackerById("v2DevOverridesEnabled").checked;
  localStorage.setItem(DEV_MODE_KEY, enabled ? "1" : "0");
  localStorage.setItem(DEV_FORCE_SCENE_KEY, enabled ? (trackerById("v2DevForceScene").value || "auto") : "auto");
}

function defaultsForModel(model) {
  return model === "ic705"
    ? { baud_rate: 19200, civ_address: "0xA4" }
    : { baud_rate: 19200, civ_address: "0x8C" };
}

function isHamFrequencySatellite(sat) {
  if (!sat || sat.has_amateur_radio === false) return false;
  const tx = Array.isArray(sat.transponders) ? sat.transponders : [];
  const rx = Array.isArray(sat.repeaters) ? sat.repeaters : [];
  const joined = [...tx, ...rx].join(" ").toLowerCase();
  if (!joined.trim()) return false;
  return /(mhz|aprs|fm|ssb|cw|bpsk|fsk|afsk|transponder|repeater|ctcss|sstv)/.test(joined);
}

function ensureTimezoneSelector() {
  const select = trackerById("v2DisplayTimezone");
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const choices = Array.from(new Set([browserTz, "UTC", ...(stateCache.timezones || [])]));
  const sorted = choices.filter((t) => t !== "BrowserLocal" && t !== "UTC").sort((a, b) => a.localeCompare(b));
  const ordered = ["BrowserLocal", "UTC", ...sorted];
  select.innerHTML = ordered
    .map((tz) => `<option value="${tz}">${tz === "BrowserLocal" ? `Browser local (${browserTz})` : tz}</option>`)
    .join("");
}

function populateRadioPortSelect(items, selectedValue) {
  const select = trackerById("v2RadioSerialDevice");
  const values = Array.isArray(items) ? items : [];
  const selected = String(selectedValue || "").trim();
  const options = [];
  if (selected && !values.some((item) => String(item?.device || "").trim() === selected)) {
    options.push(`<option value="${selected}">${selected} · current</option>`);
  }
  for (const item of values) {
    const device = String(item?.device || "").trim();
    if (!device) continue;
    const desc = String(item?.description || "").trim();
    options.push(`<option value="${device}">${desc ? `${device} · ${desc}` : device}</option>`);
  }
  if (!options.length) {
    options.push('<option value="">No USB serial ports detected</option>');
  }
  select.innerHTML = options.join("");
  select.value = selected || values[0]?.device || "";
}

function populateAudioSelect(selectId, items, selectedValue) {
  const select = trackerById(selectId);
  const values = Array.isArray(items) ? items : [];
  const selected = String(selectedValue || "").trim();
  const optionValues = values.map((item) => String(item.value || item.name || "").trim()).filter(Boolean);
  let resolved = selected;
  if (selected && !optionValues.includes(selected)) {
    const exactName = values.find((item) => String(item.name || "").trim() === selected);
    if (exactName) resolved = String(exactName.value || exactName.name || "").trim();
  }
  const options = [];
  if (resolved && !optionValues.includes(resolved)) {
    options.push(`<option value="${resolved}">${resolved} · current</option>`);
  }
  for (const item of values) {
    const name = String(item.name || "").trim();
    const value = String(item.value || item.name || "").trim();
    if (!name) continue;
    options.push(`<option value="${value}">${name}</option>`);
  }
  if (!options.length) {
    options.push('<option value="default">System Default</option>');
  }
  select.innerHTML = options.join("");
  select.value = resolved || values[0]?.value || values[0]?.name || "default";
}

function renderTargetOptions() {
  const settings = stateCache.aprs.settings || {};
  const targets = stateCache.aprsTargets || { satellites: [], terrestrial: null };
  const satSelect = trackerById("v2AprsSatellite");
  satSelect.innerHTML = (targets.satellites || []).map((item) => `<option value="${item.sat_id}">${item.name}</option>`).join("");
  if (settings.selected_satellite_id) satSelect.value = settings.selected_satellite_id;
  renderChannelOptions();
  const terrestrial = targets.terrestrial || {};
  trackerById("v2AprsTerrestrialFreq").value = settings.terrestrial_manual_frequency_hz || terrestrial.suggested_frequency_hz || "";
  trackerById("v2AprsRegionHint").textContent = terrestrial.region_label
    ? `Suggested terrestrial APRS: ${terrestrial.region_label} | ${terrestrial.suggested_frequency_hz} Hz | PATH ${terrestrial.path_default || "--"}`
    : "No terrestrial APRS region suggestion available yet.";
}

function renderChannelOptions() {
  const settings = stateCache.aprs.settings || {};
  const targets = stateCache.aprsTargets || { satellites: [] };
  const satellite = (targets.satellites || []).find((item) => item.sat_id === trackerById("v2AprsSatellite").value) || null;
  const channels = satellite?.channels || [];
  const select = trackerById("v2AprsChannel");
  select.innerHTML = channels.map((item) => `<option value="${item.channel_id}">${item.label} | ${item.frequency_hz} Hz | ${item.mode}</option>`).join("");
  if (settings.selected_channel_id && channels.some((item) => item.channel_id === settings.selected_channel_id)) {
    select.value = settings.selected_channel_id;
  }
}

function syncRadioTransportUi() {
  const mode = trackerById("v2RadioTransportMode").value || "usb";
  const model = trackerById("v2RadioRigModel").value || "id5100";
  const forceUsb = model !== "ic705" && mode === "wifi";
  const effectiveMode = forceUsb ? "usb" : mode;
  if (forceUsb) trackerById("v2RadioTransportMode").value = "usb";
  trackerById("v2RadioUsbField").classList.toggle("hidden", effectiveMode !== "usb");
  trackerById("v2RadioWifiHostField").classList.toggle("hidden", effectiveMode !== "wifi");
  trackerById("v2RadioWifiUsernameField").classList.toggle("hidden", effectiveMode !== "wifi");
  trackerById("v2RadioWifiPasswordField").classList.toggle("hidden", effectiveMode !== "wifi");
  trackerById("v2RadioWifiPortField").classList.toggle("hidden", effectiveMode !== "wifi");
}

function syncLocationUi() {
  const mode = trackerById("v2LocationMode").value;
  trackerById("v2ManualLatField").classList.toggle("hidden", mode !== "manual");
  trackerById("v2ManualLonField").classList.toggle("hidden", mode !== "manual");
  trackerById("v2GpsLatField").classList.toggle("hidden", mode !== "gps");
  trackerById("v2GpsLonField").classList.toggle("hidden", mode !== "gps");
}

function syncAprsUi() {
  const mode = trackerById("v2AprsMode").value;
  trackerById("v2AprsSatelliteField").classList.toggle("hidden", mode !== "satellite");
  trackerById("v2AprsChannelField").classList.toggle("hidden", mode !== "satellite");
  trackerById("v2AprsTerrestrialField").classList.toggle("hidden", mode !== "terrestrial");
  trackerById("v2AprsTerrestrialPathField").classList.toggle("hidden", mode !== "terrestrial");
  trackerById("v2AprsSatellitePathField").classList.toggle("hidden", mode !== "satellite");
  trackerById("v2AprsTerrestrialCommentField").classList.toggle("hidden", mode !== "terrestrial");
  trackerById("v2AprsSatelliteCommentField").classList.toggle("hidden", mode !== "satellite");
}

function updateSectionSummaries() {
  const radioSettings = stateCache.radio.settings || {};
  const radioRuntime = stateCache.radio.runtime || {};
  const aprsSettings = stateCache.aprs.settings || {};
  const aprsRuntime = stateCache.aprs.runtime || {};
  const locationState = stateCache.location.state || {};
  const passProfile = stateCache.system.passFilter?.profile || "IssOnly";
  const timezone = stateCache.system.timezone?.timezone || "UTC";
  const issMode = stateCache.system.issDisplayMode?.mode || "--";

  trackerById("radioSectionSummary").textContent =
    `${String(radioSettings.transport_mode || "usb").toUpperCase()} | ${radioRuntime.connected ? "Connected" : "Disconnected"}`;
  trackerById("locationSectionSummary").textContent = String(locationState.source_mode || "--");
  trackerById("trackingSectionSummary").textContent = passProfile;
  trackerById("displaySectionSummary").textContent = `${issMode} | ${timezone}`;
  trackerById("aprsSectionSummary").textContent = `${String(aprsSettings.operating_mode || "--")} | ${aprsRuntime.connected ? "Connected" : "Disconnected"}`;
}

function updateRuntimePane() {
  const radioRuntime = stateCache.radio.runtime || {};
  const aprsRuntime = stateCache.aprs.runtime || {};
  trackerById("v2RadioRuntimeSummary").textContent =
    `${radioRuntime.connected ? "Connected" : "Disconnected"}`
    + (radioRuntime.transport_mode ? ` | ${String(radioRuntime.transport_mode).toUpperCase()}` : "")
    + (radioRuntime.endpoint ? ` | ${radioRuntime.endpoint}` : "");
  trackerById("v2AprsRuntimeSummary").textContent =
    `${aprsRuntime.connected ? "Connected" : "Disconnected"}`
    + (aprsRuntime.target?.label ? ` | ${aprsRuntime.target.label}` : "")
    + (aprsRuntime.modem_state ? ` | ${aprsRuntime.modem_state}` : "");
}

function updateRadioContextNote() {
  const radioSettings = stateCache.radio.settings || {};
  trackerById("v2RadioContext").textContent =
    `Shared connection profile | ${String(radioSettings.rig_model || "--").toUpperCase()} | ${String(radioSettings.transport_mode || "usb").toUpperCase()} transport`;
  trackerById("v2AprsRadioContext").textContent =
    `Shared radio context | Rig ${String(radioSettings.rig_model || "--").toUpperCase()} | ${String(radioSettings.transport_mode || "usb").toUpperCase()}`
    + (radioSettings.transport_mode === "wifi"
      ? ` | ${radioSettings.wifi_host || "--"}:${radioSettings.wifi_control_port || 50001}`
      : ` | ${radioSettings.serial_device || "--"}`);
}

function syncAprsAudioUi() {
  const radioSettings = stateCache.radio.settings || {};
  const wifiManaged = radioSettings.rig_model === "ic705" && radioSettings.transport_mode === "wifi";
  trackerById("v2AprsAudioInputField").classList.toggle("hidden", wifiManaged);
  trackerById("v2AprsAudioOutputField").classList.toggle("hidden", wifiManaged);
  const note = trackerById("v2AprsAudioManagedNote");
  note.classList.toggle("hidden", !wifiManaged);
  if (wifiManaged) {
    note.textContent =
      `Audio is managed automatically by the IC-705 Wi-Fi transport | RX: IC-705 WLAN audio stream -> Dire Wolf | TX: OrbitDeck AFSK -> IC-705 WLAN audio`;
  }
}

function applyHashState() {
  const hash = window.location.hash || "#radio-connection";
  const section = document.querySelector(hash);
  if (section && section.tagName.toLowerCase() === "details") {
    section.open = true;
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  trackerById("settingsV2SectionPicker").value = hash;
  for (const link of document.querySelectorAll("[data-section-link]")) {
    link.classList.toggle("active", link.getAttribute("href") === hash);
  }
}

function initSectionObserver() {
  const sections = document.querySelectorAll(".settings-v2-section");
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    const id = `#${visible.target.id}`;
    trackerById("settingsV2SectionPicker").value = id;
    for (const link of document.querySelectorAll("[data-section-link]")) {
      link.classList.toggle("active", link.getAttribute("href") === id);
    }
  }, { rootMargin: "-20% 0px -60% 0px", threshold: [0.2, 0.4, 0.6] });
  sections.forEach((section) => observer.observe(section));
}

async function refreshState() {
  const [
    issDisplayMode,
    satellites,
    location,
    passFilter,
    timezone,
    timezones,
    system,
    cachePolicy,
    radio,
    aprs,
    aprsTargets,
    radioPorts,
    audioDevices,
  ] = await Promise.all([
    trackerApi.get("/api/v1/settings/iss-display-mode"),
    trackerApi.get("/api/v1/satellites"),
    trackerApi.get("/api/v1/location"),
    trackerApi.get("/api/v1/settings/pass-filter"),
    trackerApi.get("/api/v1/settings/timezone"),
    trackerApi.get("/api/v1/settings/timezones"),
    trackerApi.get("/api/v1/system/state"),
    trackerApi.get("/api/v1/cache-policy"),
    trackerApi.get("/api/v1/radio/state"),
    trackerApi.get("/api/v1/aprs/state"),
    trackerApi.get("/api/v1/aprs/targets"),
    trackerApi.get("/api/v1/radio/ports").catch(() => ({ items: [] })),
    trackerApi.get("/api/v1/aprs/audio-devices").catch(() => ({ inputs: [], outputs: [] })),
  ]);

  stateCache = {
    satellites: satellites.items || [],
    timezones: timezones.timezones || [],
    radio,
    aprs,
    aprsTargets: aprsTargets.targets || { satellites: [], terrestrial: null },
    location,
    system: {
      stationIdentity: system.stationIdentity,
      aprsSettings: system.aprsSettings,
      issDisplayMode,
      passFilter,
      timezone,
      cachePolicy,
    },
    radioPorts: radioPorts.items || [],
    audioDevices,
  };

  if (trackerRenderStationBadge) {
    trackerRenderStationBadge("stationBadge", system.stationIdentity, system.aprsSettings);
  }

  const radioSettings = radio.settings || {};
  trackerById("v2RadioRigModel").value = radioSettings.rig_model || "id5100";
  trackerById("v2RadioTransportMode").value = radioSettings.transport_mode || "usb";
  populateRadioPortSelect(stateCache.radioPorts, radioSettings.serial_device || "");
  trackerById("v2RadioWifiHost").value = radioSettings.wifi_host || "";
  trackerById("v2RadioWifiUsername").value = radioSettings.wifi_username || "";
  trackerById("v2RadioWifiPassword").value = radioSettings.wifi_password || "";
  trackerById("v2RadioWifiControlPort").value = radioSettings.wifi_control_port || 50001;
  trackerById("v2RadioBaudRate").value = radioSettings.baud_rate || 19200;
  trackerById("v2RadioCivAddress").value = radioSettings.civ_address || "0x8C";
  trackerById("v2RadioPollInterval").value = radioSettings.poll_interval_ms || 1000;
  trackerById("v2RadioAutoTrackInterval").value = radioSettings.auto_track_interval_ms || 1500;
  trackerById("v2RadioEnabled").checked = !!radioSettings.enabled;
  trackerById("v2RadioAutoConnect").checked = !!radioSettings.auto_connect;
  trackerById("v2RadioApplyModeTone").checked = radioSettings.default_apply_mode_and_tone !== false;
  trackerById("v2RadioSafeTxGuard").checked = radioSettings.safe_tx_guard_enabled !== false;
  syncRadioTransportUi();

  const locationState = location.state || {};
  trackerById("v2LocationMode").value = locationState.source_mode || "browser";
  if (locationState.manual_location) {
    trackerById("v2ManualLat").value = locationState.manual_location.lat ?? "";
    trackerById("v2ManualLon").value = locationState.manual_location.lon ?? "";
  }
  if (locationState.gps_location) {
    trackerById("v2GpsLat").value = locationState.gps_location.lat ?? "";
    trackerById("v2GpsLon").value = locationState.gps_location.lon ?? "";
  }
  trackerById("v2LocationSummary").textContent =
    `Source: ${locationState.source_mode || "--"}`
    + (locationState.resolved_location ? ` | ${locationState.resolved_location.lat?.toFixed?.(6) ?? locationState.resolved_location.lat}, ${locationState.resolved_location.lon?.toFixed?.(6) ?? locationState.resolved_location.lon}` : "");
  syncLocationUi();

  const trackedSat = localStorage.getItem(TRACKED_SAT_KEY) || "iss-zarya";
  const hamItems = stateCache.satellites.filter(isHamFrequencySatellite);
  trackerById("v2TrackedSatellite").innerHTML = hamItems.map((sat) => `<option value="${sat.sat_id}">${sat.name}</option>`).join("");
  trackerById("v2TrackedSatellite").value = hamItems.some((sat) => sat.sat_id === trackedSat) ? trackedSat : (hamItems[0]?.sat_id || "");
  trackerById("v2PassProfile").value = passFilter.profile || "IssOnly";
  trackerById("v2PassSatSelect").innerHTML = hamItems.map((sat) => `<option value="${sat.sat_id}">${sat.name} (${sat.norad_id})</option>`).join("");
  for (const option of trackerById("v2PassSatSelect").options) {
    option.selected = (passFilter.satIds || ["iss-zarya"]).includes(option.value);
  }

  trackerById("v2IssMode").value = issDisplayMode.mode;
  ensureTimezoneSelector();
  const selectedDisplayTimezone = timezone.timezone || "UTC";
  trackerById("v2DisplayTimezone").value = selectedDisplayTimezone;
  const sources = loadVideoSources();
  trackerById("v2VideoSourcePrimary").value = sources[0] || "";
  trackerById("v2VideoSourceSecondary").value = sources[1] || "";

  const aprsSettings = aprs.settings || {};
  trackerById("v2AprsCallsign").value = aprsSettings.callsign || "N0CALL";
  trackerById("v2AprsSsid").value = aprsSettings.ssid ?? 10;
  trackerById("v2AprsMode").value = aprsSettings.operating_mode || "terrestrial";
  trackerById("v2AprsListenOnly").value = String(!!aprsSettings.listen_only);
  trackerById("v2AprsTerrestrialPath").value = aprsSettings.terrestrial_path || "WIDE1-1,WIDE2-1";
  trackerById("v2AprsSatellitePath").value = aprsSettings.satellite_path || "ARISS";
  trackerById("v2AprsTerrestrialComment").value =
    aprsSettings.terrestrial_beacon_comment || aprsSettings.beacon_comment || "OrbitDeck APRS";
  trackerById("v2AprsSatelliteComment").value =
    aprsSettings.satellite_beacon_comment || aprsSettings.beacon_comment || "OrbitDeck Space APRS";
  trackerById("v2AprsPositionFudgeLat").value = Number(aprsSettings.position_fudge_lat_deg || 0).toFixed(2);
  trackerById("v2AprsPositionFudgeLon").value = Number(aprsSettings.position_fudge_lon_deg || 0).toFixed(2);
  populateAudioSelect("v2AprsAudioInput", stateCache.audioDevices.inputs || [], aprsSettings.audio_input_device || "");
  populateAudioSelect("v2AprsAudioOutput", stateCache.audioDevices.outputs || [], aprsSettings.audio_output_device || "");
  renderTargetOptions();
  syncAprsUi();

  const dev = getDevSettings();
  trackerById("v2DevOverridesEnabled").checked = dev.enabled;
  trackerById("v2DevForceScene").value = dev.forceScene;

  updateSectionSummaries();
  updateRuntimePane();
  updateRadioContextNote();
  syncAprsAudioUi();
}

async function saveRadioSection() {
  const payload = {
    enabled: trackerById("v2RadioEnabled").checked,
    rig_model: trackerById("v2RadioRigModel").value,
    transport_mode: trackerById("v2RadioTransportMode").value,
    serial_device: trackerById("v2RadioSerialDevice").value,
    wifi_host: trackerById("v2RadioWifiHost").value,
    wifi_username: trackerById("v2RadioWifiUsername").value,
    wifi_password: trackerById("v2RadioWifiPassword").value,
    wifi_control_port: Number(trackerById("v2RadioWifiControlPort").value || 50001),
    baud_rate: Number(trackerById("v2RadioBaudRate").value || defaultsForModel(trackerById("v2RadioRigModel").value).baud_rate),
    civ_address: trackerById("v2RadioCivAddress").value,
    poll_interval_ms: Number(trackerById("v2RadioPollInterval").value || 1000),
    auto_connect: trackerById("v2RadioAutoConnect").checked,
    auto_track_interval_ms: Number(trackerById("v2RadioAutoTrackInterval").value || 1500),
    default_apply_mode_and_tone: trackerById("v2RadioApplyModeTone").checked,
    safe_tx_guard_enabled: trackerById("v2RadioSafeTxGuard").checked,
  };
  await runAction("POST /api/v1/settings/radio", () => trackerApi.post("/api/v1/settings/radio", payload));
  await refreshState();
}

async function saveLocationSection() {
  const sourceMode = trackerById("v2LocationMode").value;
  const payload = { source_mode: sourceMode };
  if (sourceMode === "browser") {
    await trackerSetBrowserLocation();
  } else if (sourceMode === "manual") {
    const lat = Number(trackerById("v2ManualLat").value);
    const lon = Number(trackerById("v2ManualLon").value);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      throw new Error("Manual latitude and longitude are required");
    }
    payload.add_profile = { id: "manual-kiosk", name: "Manual Kiosk", point: { lat, lon, alt_m: 0 } };
    payload.selected_profile_id = "manual-kiosk";
  } else if (sourceMode === "gps") {
    const lat = Number(trackerById("v2GpsLat").value);
    const lon = Number(trackerById("v2GpsLon").value);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      throw new Error("GPS latitude and longitude are required");
    }
    payload.gps_location = { lat, lon, alt_m: 0 };
  }
  await runAction("POST /api/v1/location", () => trackerApi.post("/api/v1/location", payload));
  await refreshState();
}

async function saveTrackingSection() {
  const profile = trackerById("v2PassProfile").value;
  const satIds = Array.from(trackerById("v2PassSatSelect").selectedOptions).map((o) => o.value);
  localStorage.setItem(TRACKED_SAT_KEY, trackerById("v2TrackedSatellite").value);
  await runAction("POST /api/v1/settings/pass-filter", () => trackerApi.post("/api/v1/settings/pass-filter", { profile, sat_ids: satIds }));
  await refreshState();
}

async function saveDisplaySection() {
  const picked = trackerById("v2DisplayTimezone").value;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const tzToSave = picked === "BrowserLocal" ? browserTz : picked;
  saveVideoSourcesLocal();
  await runAction("POST /api/v1/settings/display", async () => {
    await trackerApi.post("/api/v1/settings/iss-display-mode", { mode: trackerById("v2IssMode").value });
    await trackerApi.post("/api/v1/settings/timezone", { timezone: tzToSave });
    return {
      iss_display_mode: trackerById("v2IssMode").value,
      timezone: tzToSave,
      video_sources: loadVideoSources(),
    };
  });
  await refreshState();
}

async function saveAprsSection() {
  const radioSettings = stateCache.radio.settings || {};
  const rigModel = radioSettings.rig_model || "ic705";
  const payload = {
    enabled: true,
    callsign: trackerById("v2AprsCallsign").value,
    ssid: Number(trackerById("v2AprsSsid").value || 10),
    listen_only: trackerById("v2AprsListenOnly").value === "true",
    operating_mode: trackerById("v2AprsMode").value,
    rig_model: rigModel,
    hamlib_model_id: rigModel === "ic705" ? 3085 : 3071,
    serial_device: radioSettings.serial_device || "",
    baud_rate: Number(radioSettings.baud_rate || 19200),
    civ_address: radioSettings.civ_address || (rigModel === "ic705" ? "0xA4" : "0x8C"),
    position_fudge_lat_deg: Number(trackerById("v2AprsPositionFudgeLat").value || 0),
    position_fudge_lon_deg: Number(trackerById("v2AprsPositionFudgeLon").value || 0),
    terrestrial_path: trackerById("v2AprsTerrestrialPath").value,
    satellite_path: trackerById("v2AprsSatellitePath").value,
    terrestrial_beacon_comment: trackerById("v2AprsTerrestrialComment").value,
    satellite_beacon_comment: trackerById("v2AprsSatelliteComment").value,
  };
  if (!(radioSettings.rig_model === "ic705" && radioSettings.transport_mode === "wifi")) {
    payload.audio_input_device = trackerById("v2AprsAudioInput").value;
    payload.audio_output_device = trackerById("v2AprsAudioOutput").value;
  }
  if (payload.operating_mode === "satellite") {
    payload.selected_satellite_id = trackerById("v2AprsSatellite").value || null;
    payload.selected_channel_id = trackerById("v2AprsChannel").value || null;
  } else {
    payload.terrestrial_manual_frequency_hz = Number(trackerById("v2AprsTerrestrialFreq").value || 0);
  }
  await runAction("POST /api/v1/settings/aprs", () => trackerApi.post("/api/v1/settings/aprs", payload));
  await refreshState();
}

async function saveDeveloperSection() {
  saveDevSettings();
  setRuntime("local developer settings", { status: "ok", response: getDevSettings() });
  await refreshState();
}

window.addEventListener("DOMContentLoaded", async () => {
  ({
    api: trackerApi,
    byId: trackerById,
    setBrowserLocation: trackerSetBrowserLocation,
    renderStationBadge: trackerRenderStationBadge,
  } = window.issTracker);

  trackerById("v2RadioRigModel").addEventListener("change", () => {
    const model = trackerById("v2RadioRigModel").value;
    const defaults = defaultsForModel(model);
    trackerById("v2RadioBaudRate").value = defaults.baud_rate;
    trackerById("v2RadioCivAddress").value = defaults.civ_address;
    syncRadioTransportUi();
  });
  trackerById("v2RadioTransportMode").addEventListener("change", syncRadioTransportUi);
  trackerById("v2LocationMode").addEventListener("change", syncLocationUi);
  trackerById("v2AprsMode").addEventListener("change", syncAprsUi);
  trackerById("v2AprsSatellite").addEventListener("change", renderChannelOptions);

  trackerById("settingsV2SectionPicker").addEventListener("change", () => {
    window.location.hash = trackerById("settingsV2SectionPicker").value;
  });
  window.addEventListener("hashchange", applyHashState);
  trackerById("v2ToggleRuntime").addEventListener("click", () => {
    const body = trackerById("v2RuntimeBody");
    body.classList.toggle("hidden");
    trackerById("v2ToggleRuntime").textContent = body.classList.contains("hidden") ? "Expand" : "Collapse";
  });

  trackerById("v2SaveRadioSettings").addEventListener("click", saveRadioSection);
  trackerById("v2ConnectRadio").addEventListener("click", async () => {
    await runAction("POST /api/v1/radio/connect", () => trackerApi.post("/api/v1/radio/connect", {}));
    await refreshState();
  });
  trackerById("v2DisconnectRadio").addEventListener("click", async () => {
    await runAction("POST /api/v1/radio/disconnect", () => trackerApi.post("/api/v1/radio/disconnect", {}));
    await refreshState();
  });
  trackerById("v2SaveLocation").addEventListener("click", saveLocationSection);
  trackerById("v2SaveTracking").addEventListener("click", saveTrackingSection);
  trackerById("v2SaveDisplay").addEventListener("click", saveDisplaySection);
  trackerById("v2SaveAprs").addEventListener("click", saveAprsSection);
  trackerById("v2SaveDeveloper").addEventListener("click", saveDeveloperSection);
  trackerById("v2RefreshPassCache").addEventListener("click", async () => {
    await runAction("POST /api/v1/passes/cache/refresh", () => trackerApi.post("/api/v1/passes/cache/refresh", {}));
    await refreshState();
  });
  trackerById("v2RefreshPage").addEventListener("click", refreshState);

  updateClock();
  setInterval(updateClock, 1000);
  await refreshState();
  initSectionObserver();
  applyHashState();
});

import {
  aprsClient,
  getEnv,
  initEnvironment,
  stateCache,
  viewState,
  pretty,
  defaultsForModel,
  isHamFrequencySatellite,
  loadVideoSources,
  saveVideoSourcesLocal,
  getDevSettings,
  getDevModeSelection,
  saveDevSettings,
  runAction,
  setRuntime,
  recordEvent,
  formatCoord,
  formatDateTime,
  formatRelativeTone,
  transportSummary,
  radioContextSummary,
  effectiveLocation,
  locationSummary,
  toggleHidden,
  getTrackedSatelliteId,
  setTrackedSatelliteId,
  escapeHtml,
  resolveDisplayTimezoneChoice,
  saveDisplayTimezoneChoice,
} from "./settings/shared.js";
import { renderOverviewSection, bindOverviewSection } from "./settings/overview-section.js";
import { renderRadioSection, bindRadioSection } from "./settings/radio-section.js";
import { renderLocationSection, bindLocationSection } from "./settings/location-section.js";
import { renderTrackingSection, bindTrackingSection } from "./settings/tracking-section.js";
import { renderDisplaySection, bindDisplaySection } from "./settings/display-section.js";
import {
  renderAprsSection,
  bindAprsSection,
  renderAprsDrawer,
  bindAprsDrawer,
  maybeNotifyPackets,
} from "./settings/aprs-section.js";
import { renderDeveloperSection, bindDeveloperSection } from "./settings/developer-section.js";

const SECTION_ORDER = ["overview", "radio", "location", "tracking", "display", "aprs", "developer"];

const sections = {
  overview: { render: renderOverviewSection, bind: bindOverviewSection, dirty: false },
  radio: { render: renderRadioSection, bind: bindRadioSection, dirty: true },
  location: { render: renderLocationSection, bind: bindLocationSection, dirty: true },
  tracking: { render: renderTrackingSection, bind: bindTrackingSection, dirty: true },
  display: { render: renderDisplaySection, bind: bindDisplaySection, dirty: true },
  aprs: { render: renderAprsSection, bind: bindAprsSection, dirty: true },
  developer: { render: renderDeveloperSection, bind: bindDeveloperSection, dirty: true },
};

let trackerApi;
let trackerById;
let trackerSetBrowserLocation;
let trackerRenderStationBadge;

function activeSectionFromHash() {
  const raw = String(window.location.hash || "#overview").replace(/^#/, "");
  return SECTION_ORDER.includes(raw) ? raw : "overview";
}

function updateClock() {
  const d = new Date();
  trackerById("clock").textContent = `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function ensureTimezoneSelector(select, timezones) {
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const choices = Array.from(new Set([browserTz, "UTC", ...(timezones || [])]));
  const sorted = choices.filter((t) => t !== "BrowserLocal" && t !== "UTC").sort((a, b) => a.localeCompare(b));
  const ordered = ["BrowserLocal", "UTC", ...sorted];
  select.innerHTML = ordered
    .map((tz) => `<option value="${tz}">${tz === "BrowserLocal" ? `Browser local (${browserTz})` : tz}</option>`)
    .join("");
}

function updateNav() {
  const active = viewState.activeSection;
  trackerById("settingsV2SectionPicker").value = active;
  for (const link of document.querySelectorAll("[data-section-link]")) {
    link.classList.toggle("active", link.dataset.sectionLink === active);
  }
}

function renderRuntimeRail() {
  const radioRuntime = stateCache.radio.runtime || {};
  const radioSettings = stateCache.radio.settings || {};
  const aprsRuntime = stateCache.aprs.runtime || {};
  const aprsSettings = stateCache.aprs.settings || {};
  const locationState = stateCache.location.state || {};
  const trackedSat = stateCache.satellites.find((sat) => sat.sat_id === getTrackedSatelliteId()) || null;
  const displayMode = stateCache.system.issDisplayMode?.mode || "--";
  const timezone = resolveDisplayTimezoneChoice(stateCache.system.timezone?.timezone || "BrowserLocal");
  const warnings = buildWarnings();

  trackerById("settingsV2RuntimeCards").innerHTML = `
    <article class="settings-v2-rail-card">
      <div class="label mono">Radio Connection</div>
      <div class="settings-v2-rail-value">${radioRuntime.connected ? "Connected" : "Disconnected"}</div>
      <div class="settings-v2-rail-meta">${escapeHtml(transportSummary(radioSettings, radioRuntime))}</div>
    </article>
    <article class="settings-v2-rail-card">
      <div class="label mono">APRS Runtime</div>
      <div class="settings-v2-rail-value">${aprsRuntime.connected ? "Connected" : "Disconnected"}</div>
      <div class="settings-v2-rail-meta">${escapeHtml(aprsRuntime.target?.label || aprsSettings.operating_mode || "No target selected")}</div>
    </article>
    <article class="settings-v2-rail-card">
      <div class="label mono">Satellite Tracking</div>
      <div class="settings-v2-rail-value">${escapeHtml(trackedSat?.name || "No satellite selected")}</div>
      <div class="settings-v2-rail-meta">${escapeHtml(stateCache.system.passFilter?.profile || "IssOnly")}</div>
    </article>
    <article class="settings-v2-rail-card">
      <div class="label mono">Display</div>
      <div class="settings-v2-rail-value">${escapeHtml(displayMode)}</div>
      <div class="settings-v2-rail-meta">${escapeHtml(timezone)}</div>
    </article>
    <article class="settings-v2-rail-card">
      <div class="label mono">Location</div>
      <div class="settings-v2-rail-value">${escapeHtml(locationState.source_mode || "--")}</div>
      <div class="settings-v2-rail-meta">${escapeHtml(locationSummary(stateCache.location))}</div>
    </article>
    <article class="settings-v2-rail-card">
      <div class="label mono">Recent Events</div>
      <div class="settings-v2-runtime-events">
        ${viewState.recentEvents.slice(0, 6).map((event) => `
          <div class="settings-v2-runtime-event">
            <strong>${escapeHtml(event.title)}</strong>
            <span>${escapeHtml(event.detail || formatDateTime(event.at))}</span>
          </div>
        `).join("") || '<div class="settings-v2-runtime-empty">No recent actions yet.</div>'}
      </div>
    </article>
    <article class="settings-v2-rail-card">
      <div class="label mono">Attention</div>
      <div class="settings-v2-runtime-events">
        ${warnings.map((warning) => `
          <div class="settings-v2-runtime-event">
            <strong>${escapeHtml(warning.title)}</strong>
            <span>${escapeHtml(warning.detail)}</span>
          </div>
        `).join("") || '<div class="settings-v2-runtime-empty">No active warnings.</div>'}
      </div>
    </article>
  `;
}

function serializeScope(scope) {
  const values = [];
  for (const el of scope.querySelectorAll("input, select, textarea")) {
    if (el.dataset.transient === "1") continue;
    if (el.disabled || el.closest(".hidden")) continue;
    const key = el.id || el.name || el.dataset.field || el.type;
    if (el.type === "checkbox") {
      values.push(`${key}:${el.checked ? "1" : "0"}`);
      continue;
    }
    if (el.multiple) {
      const selected = Array.from(el.selectedOptions).map((opt) => opt.value).sort().join(",");
      values.push(`${key}:${selected}`);
      continue;
    }
    values.push(`${key}:${el.value}`);
  }
  return values.join("|");
}

function updateDirtyState(sectionId) {
  const scope = document.querySelector(`[data-dirty-scope="${sectionId}"]`);
  if (!scope) return;
  const next = serializeScope(scope);
  viewState.dirtySections[sectionId] = next !== viewState.sectionSnapshots[sectionId];
  const badge = document.querySelector("[data-dirty-badge]");
  if (badge) {
    badge.textContent = viewState.dirtySections[sectionId] ? "Unsaved changes" : "All changes saved";
    badge.classList.toggle("is-dirty", viewState.dirtySections[sectionId]);
  }
  if (sectionId === "radio") updateRadioConnectButton();
}

function mountDirtyTracking(sectionId) {
  const scope = document.querySelector(`[data-dirty-scope="${sectionId}"]`);
  if (!scope) return;
  viewState.sectionSnapshots[sectionId] = serializeScope(scope);
  viewState.dirtySections[sectionId] = false;
  for (const el of scope.querySelectorAll("input, select, textarea")) {
    el.addEventListener("input", () => updateDirtyState(sectionId));
    el.addEventListener("change", () => updateDirtyState(sectionId));
  }
  updateDirtyState(sectionId);
}

function buildWarnings() {
  const warnings = [];
  const radioRuntime = stateCache.radio.runtime || {};
  const locationState = stateCache.location.state || {};
  const aprsRuntime = stateCache.aprs.runtime || {};
  const aprsTarget = stateCache.aprs.previewTarget || aprsRuntime.target || null;
  if (!radioRuntime.connected) warnings.push({ title: "Radio disconnected", detail: radioRuntime.last_error || "Shared radio transport is not connected." });
  if (!effectiveLocation(locationState)) warnings.push({ title: "Location unresolved", detail: "Pass predictions and terrestrial APRS defaults are degraded until a location is resolved." });
  if (aprsTarget?.requires_pass && !aprsTarget?.pass_active) warnings.push({ title: "Satellite APRS transmit blocked", detail: aprsTarget.tx_block_reason || "Transmit is only allowed during an active pass." });
  if (!aprsRuntime.connected) warnings.push({ title: "APRS offline", detail: "APRS runtime is disconnected." });
  if (aprsRuntime.igate_status === "error") warnings.push({ title: "iGate error", detail: aprsRuntime.igate_last_error || "APRS-IS connection did not complete successfully." });
  return warnings;
}

function updateRadioConnectButton() {
  const buttons = document.querySelectorAll("[data-radio-connect]");
  const note = document.querySelector("[data-radio-reconnect-note]");
  if (!buttons.length) return;
  const connected = !!stateCache.radio.runtime?.connected;
  const dirty = !!viewState.dirtySections.radio;
  buttons.forEach((button) => {
    button.disabled = dirty;
    button.textContent = dirty ? "Save Changes First" : (connected ? "Disconnect" : "Connect");
    button.classList.toggle("aprs-connect-green", !connected && !dirty);
    button.classList.toggle("aprs-connect-red", connected && !dirty);
  });
  if (note) toggleHidden(note, !dirty);
}

function updateAprsDrawer({ preserveDraft = false } = {}) {
  const existingDrawer = document.getElementById("v2AprsDrawer");
  const drawerHasFocus = !!(existingDrawer && document.activeElement && existingDrawer.contains(document.activeElement));
  if (preserveDraft && (viewState.aprsDrawerDirty || drawerHasFocus)) {
    return;
  }
  trackerById("settingsV2DrawerHost").innerHTML = renderAprsDrawer({
    stateCache,
    viewState,
  });
  bindAprsDrawer(buildContext());
}

function renderPanel({ preserveActiveDraft = false } = {}) {
  const panel = trackerById("settingsV2Panel");
  const activeElement = document.activeElement;
  const panelHasFocusedField = !!(
    panel
    && activeElement
    && panel.contains(activeElement)
    && ["INPUT", "TEXTAREA", "SELECT"].includes(activeElement.tagName)
  );
  if (preserveActiveDraft && viewState.dirtySections[viewState.activeSection]) {
    return;
  }
  if (preserveActiveDraft && panelHasFocusedField) {
    return;
  }
  const section = sections[viewState.activeSection];
  panel.innerHTML = section.render({
    stateCache,
    viewState,
    formatCoord,
    formatDateTime,
    formatRelativeTone,
    locationSummary,
    radioContextSummary,
    transportSummary,
    buildWarnings,
  });
  section.bind(buildContext());
  if (section.dirty) mountDirtyTracking(viewState.activeSection);
  updateRadioConnectButton();
}

function renderAll({ preserveActiveDraft = false } = {}) {
  updateNav();
  renderRuntimeRail();
  renderPanel({ preserveActiveDraft });
  updateAprsDrawer({ preserveDraft: preserveActiveDraft });
}

function applyRadioResponse(response) {
  if (!response) return;
  stateCache.radio = {
    settings: response.settings || stateCache.radio.settings || {},
    runtime: response.runtime || stateCache.radio.runtime || {},
  };
  renderAll({ preserveActiveDraft: true });
}

async function refreshState({ preserveDraft = false } = {}) {
  const prevAprsRuntime = stateCache.aprs.runtime || {};
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
    aprsBundle,
    radioPorts,
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
    aprsClient.loadBundle(trackerApi),
    trackerApi.get("/api/v1/radio/ports").catch(() => ({ items: [] })),
  ]);

  stateCache.satellites = satellites.items || [];
  stateCache.timezones = timezones.timezones || [];
  stateCache.radio = radio;
  stateCache.aprs = aprsBundle.aprs;
  stateCache.aprsTargets = aprsBundle.targets.targets || { satellites: [], terrestrial: null };
  stateCache.aprsLogSettings = aprsBundle.logSettings || {};
  stateCache.aprsLog = aprsBundle.logRecent || { items: [] };
  stateCache.location = location;
  stateCache.system = {
    stationIdentity: system.stationIdentity,
    aprsSettings: system.aprsSettings,
    issDisplayMode,
    passFilter,
    timezone: { timezone: resolveDisplayTimezoneChoice(timezone.timezone || "BrowserLocal") },
    cachePolicy,
  };
  stateCache.radioPorts = radioPorts.items || [];
  stateCache.audioDevices = aprsBundle.audioDevices || { inputs: [], outputs: [] };

  const nextAprsRuntime = stateCache.aprs.runtime || {};
  if (!prevAprsRuntime.igate_connected && nextAprsRuntime.igate_connected) {
    recordEvent("iGate connected", nextAprsRuntime.igate_server || nextAprsRuntime.igate_reason || "APRS-IS login confirmed.");
  } else if (
    prevAprsRuntime.igate_status !== "error"
    && nextAprsRuntime.igate_status === "error"
    && nextAprsRuntime.igate_last_error
  ) {
    recordEvent("iGate error", nextAprsRuntime.igate_last_error);
  }

  if (trackerRenderStationBadge) {
    trackerRenderStationBadge("stationBadge", system.stationIdentity, system.aprsSettings);
  }
  if (!preserveDraft) {
    viewState.dirtySections = {};
    viewState.sectionSnapshots = {};
  }
  maybeNotifyPackets(stateCache, viewState, trackerById);
  renderAll({ preserveActiveDraft: preserveDraft });
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
  recordEvent("Radio settings saved", payload.transport_mode === "wifi" ? `${payload.wifi_host}:${payload.wifi_control_port}` : payload.serial_device);
  await refreshState();
}

async function toggleRadioConnection() {
  if (viewState.dirtySections.radio) return;
  const buttons = document.querySelectorAll("[data-radio-connect]");
  buttons.forEach((button) => {
    button.disabled = true;
    button.textContent = stateCache.radio.runtime?.connected ? "Disconnecting..." : "Connecting...";
  });
  try {
    if (stateCache.radio.runtime?.connected) {
      const response = await runAction("POST /api/v1/radio/disconnect", () => trackerApi.post("/api/v1/radio/disconnect", {}));
      applyRadioResponse(response);
      recordEvent("Radio disconnected", stateCache.radio.runtime?.endpoint || "");
    } else {
      const response = await runAction("POST /api/v1/radio/connect", () => trackerApi.post("/api/v1/radio/connect", {}));
      applyRadioResponse(response);
      if (response?.runtime?.connected) {
        recordEvent("Radio connected", transportSummary(response.settings || stateCache.radio.settings, response.runtime || stateCache.radio.runtime));
      } else {
        recordEvent("Radio connect failed", response?.runtime?.last_error || "Connection attempt did not succeed.");
      }
    }
    window.setTimeout(() => {
      refreshState({ preserveDraft: true }).catch(() => {
        // Non-fatal reconcile failure.
      });
    }, 600);
  } catch (error) {
    updateRadioConnectButton();
    throw error;
  }
}

async function saveLocationSection() {
  const sourceMode = trackerById("v2LocationMode").value;
  const payload = { source_mode: sourceMode };
  if (sourceMode === "browser" || sourceMode === "auto") {
    await trackerSetBrowserLocation();
  } else if (sourceMode === "manual") {
    const lat = Number(trackerById("v2ManualLat").value);
    const lon = Number(trackerById("v2ManualLon").value);
    if (Number.isNaN(lat) || Number.isNaN(lon)) throw new Error("Manual latitude and longitude are required");
    payload.add_profile = { id: "manual-kiosk", name: "Manual Kiosk", point: { lat, lon, alt_m: 0 } };
    payload.selected_profile_id = "manual-kiosk";
  } else if (sourceMode === "gps") {
    const lat = Number(trackerById("v2GpsLat").value);
    const lon = Number(trackerById("v2GpsLon").value);
    if (Number.isNaN(lat) || Number.isNaN(lon)) throw new Error("GPS latitude and longitude are required");
    payload.gps_location = { lat, lon, alt_m: 0 };
  }
  await runAction("POST /api/v1/location", () => trackerApi.post("/api/v1/location", payload));
  recordEvent("Location settings saved", sourceMode);
  await refreshState();
}

async function saveTrackingSection() {
  const profile = trackerById("v2PassProfile").value;
  const satIds = Array.from(document.querySelectorAll("[data-pass-favorite]:checked")).map((el) => el.value);
  const tracked = trackerById("v2TrackedSatellite").value;
  setTrackedSatelliteId(tracked);
  await runAction("POST /api/v1/settings/pass-filter", () => trackerApi.post("/api/v1/settings/pass-filter", { profile, sat_ids: satIds }));
  recordEvent("Tracking updated", tracked);
  await refreshState();
}

async function saveDisplaySection() {
  const picked = trackerById("v2DisplayTimezone").value;
  const tzToSave = picked || "BrowserLocal";
  saveVideoSourcesLocal(
    {
      mode: trackerById("v2VideoSourcePrimaryMode").value,
      url: trackerById("v2VideoSourcePrimary").value,
    },
    {
      mode: trackerById("v2VideoSourceSecondaryMode").value,
      url: trackerById("v2VideoSourceSecondary").value,
    },
  );
  await runAction("POST /api/v1/settings/display", async () => {
    await trackerApi.post("/api/v1/settings/iss-display-mode", { mode: trackerById("v2IssMode").value });
    await trackerApi.post("/api/v1/settings/timezone", { timezone: tzToSave });
    return {
      iss_display_mode: trackerById("v2IssMode").value,
      timezone: tzToSave,
      video_sources: loadVideoSources(),
    };
  });
  saveDisplayTimezoneChoice(tzToSave);
  recordEvent("Display settings saved", `${trackerById("v2IssMode").value} | ${tzToSave}`);
  await refreshState();
}

function aprsSettingsPayload() {
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
  if (!aprsClient.isWifiManaged(radioSettings)) {
    payload.audio_input_device = trackerById("v2AprsAudioInput").value;
    payload.audio_output_device = trackerById("v2AprsAudioOutput").value;
  }
  if (payload.operating_mode === "satellite") {
    payload.selected_satellite_id = trackerById("v2AprsSatellite").value || null;
    payload.selected_channel_id = trackerById("v2AprsChannel").value || null;
  } else {
    payload.terrestrial_manual_frequency_hz = Number(trackerById("v2AprsTerrestrialFreq").value || 0);
  }
  return payload;
}

function aprsLogSettingsPayload() {
  return {
    log_enabled: trackerById("v2AprsLogEnabled").checked,
    log_max_records: Number(trackerById("v2AprsLogMaxRecords").value || 500),
    notify_incoming_messages: trackerById("v2AprsNotifyMessages").checked,
    notify_all_packets: trackerById("v2AprsNotifyAllPackets").checked,
    digipeater: {
      enabled: trackerById("v2AprsFutureDigipeaterMain").checked,
      aliases: trackerById("v2AprsDigipeaterAliasesMain").value.split(",").map((item) => item.trim()).filter(Boolean),
      max_hops: stateCache.aprsLogSettings.digipeater?.max_hops || 1,
      dedupe_window_s: Number(trackerById("v2AprsDigipeaterDedupeMain").value || 30),
      callsign_allowlist: stateCache.aprsLogSettings.digipeater?.callsign_allowlist || [],
      path_blocklist: stateCache.aprsLogSettings.digipeater?.path_blocklist || ["TCPIP", "TCPXX", "NOGATE", "RFONLY"],
    },
    igate: {
      enabled: trackerById("v2AprsFutureIgateMain").checked,
      server_host: trackerById("v2AprsIgateHostMain").value,
      server_port: Number(trackerById("v2AprsIgatePortMain").value || 14580),
      login_callsign: trackerById("v2AprsIgateLoginMain").value,
      passcode: trackerById("v2AprsIgatePasscodeMain").value,
      filter: trackerById("v2AprsIgateFilterMain").value,
      connect_timeout_s: stateCache.aprsLogSettings.igate?.connect_timeout_s || 10,
      gate_terrestrial_rx: trackerById("v2AprsIgateTerrestrialMain").checked,
      gate_satellite_rx: trackerById("v2AprsIgateSatelliteMain").checked,
    },
    future_digipeater_enabled: trackerById("v2AprsFutureDigipeaterMain").checked,
    future_igate_enabled: trackerById("v2AprsFutureIgateMain").checked,
    igate_auto_enable_with_internet: trackerById("v2AprsIgateAutoEnableMain").checked,
  };
}

async function saveAprsSection() {
  await runAction("POST /api/v1/settings/aprs", () => aprsClient.saveAprsSettings(trackerApi, aprsSettingsPayload()));
  await runAction("POST /api/v1/aprs/log/settings", () => aprsClient.saveLogSettings(trackerApi, aprsLogSettingsPayload()));
  viewState.aprsDraftMode = null;
  recordEvent("APRS settings saved", trackerById("v2AprsMode").value);
  await refreshState();
}

async function refreshAprsTarget() {
  const mode = trackerById("v2AprsMode").value;
  const payload = { operating_mode: mode };
  if (mode === "satellite") {
    payload.sat_id = trackerById("v2AprsSatellite").value || null;
    payload.channel_id = trackerById("v2AprsChannel").value || null;
  } else {
    payload.terrestrial_frequency_hz = Number(trackerById("v2AprsTerrestrialFreq").value || 0);
  }
  await runAction("POST /api/v1/aprs/select-target", () => aprsClient.selectTarget(trackerApi, payload));
  recordEvent("APRS target refreshed", mode);
  await refreshState();
}

async function toggleAprsConnection() {
  if (stateCache.aprs.runtime?.connected) {
    await runAction("POST /api/v1/aprs/disconnect", () => aprsClient.disconnect(trackerApi));
    recordEvent("APRS disconnected", stateCache.aprs.runtime?.target?.label || "");
    await refreshState();
    return;
  }
  await runAction("POST /api/v1/settings/aprs", () => aprsClient.saveAprsSettings(trackerApi, aprsSettingsPayload()));
  await runAction("POST /api/v1/aprs/log/settings", () => aprsClient.saveLogSettings(trackerApi, aprsLogSettingsPayload()));
  await runAction("POST /api/v1/aprs/select-target", async () => {
    const mode = trackerById("v2AprsMode").value;
    const payload = { operating_mode: mode };
    if (mode === "satellite") {
      payload.sat_id = trackerById("v2AprsSatellite").value || null;
      payload.channel_id = trackerById("v2AprsChannel").value || null;
    } else {
      payload.terrestrial_frequency_hz = Number(trackerById("v2AprsTerrestrialFreq").value || 0);
    }
    return aprsClient.selectTarget(trackerApi, payload);
  });
  await runAction("POST /api/v1/aprs/connect", () => aprsClient.connect(trackerApi));
  recordEvent("APRS connected", trackerById("v2AprsMode").value);
  await refreshState();
}

async function saveAprsLogSettingsSection() {
  await runAction("POST /api/v1/aprs/log/settings", () => aprsClient.saveLogSettings(trackerApi, aprsLogSettingsPayload()));
  viewState.aprsDrawerDirty = false;
  recordEvent("APRS log settings saved", "Local storage and gateway settings updated.");
  await refreshState();
}

async function saveDeveloperSection() {
  const selection = trackerById("v2DevModeSelection").value || "disabled";
  saveDevSettings({
    selection,
  });
  setRuntime("local developer settings", { status: "ok", response: getDevSettings() });
  recordEvent("Developer settings saved", selection);
  await refreshState({ preserveDraft: true });
}

function discardSection(sectionId) {
  viewState.dirtySections[sectionId] = false;
  renderPanel();
}

function startPolling() {
  if (viewState.pollTimer) window.clearInterval(viewState.pollTimer);
  viewState.pollTimer = window.setInterval(async () => {
    if (Object.values(viewState.dirtySections).some(Boolean)) return;
    try {
      await refreshState({ preserveDraft: true });
    } catch {
      // Non-fatal polling failure.
    }
  }, 5000);
}

function setActiveSection(sectionId) {
  viewState.activeSection = SECTION_ORDER.includes(sectionId) ? sectionId : "overview";
  window.location.hash = `#${viewState.activeSection}`;
  renderAll();
}

function hasDirtySections() {
  return Object.values(viewState.dirtySections).some(Boolean) || !!viewState.aprsDrawerDirty;
}

function returnToKiosk() {
  if (hasDirtySections()) {
    const confirmed = window.confirm("You have unsaved changes in settings. Leave this page and return to the kiosk anyway?");
    if (!confirmed) return;
  }
  window.location.assign("/");
}

function buildContext() {
  return {
    stateCache,
    viewState,
    trackerApi,
    trackerById,
    trackerSetBrowserLocation,
    trackerRenderStationBadge,
    ensureTimezoneSelector,
    formatCoord,
    formatDateTime,
    formatRelativeTone,
    locationSummary,
    radioContextSummary,
    transportSummary,
    defaultsForModel,
    isHamFrequencySatellite,
    loadVideoSources,
    getDevSettings,
    getDevModeSelection,
    saveRadioSection,
    toggleRadioConnection,
    saveLocationSection,
    saveTrackingSection,
    saveDisplaySection,
    saveAprsSection,
    refreshAprsTarget,
    toggleAprsConnection,
    saveAprsLogSettingsSection,
    saveDeveloperSection,
    discardSection,
    refreshState,
    setActiveSection,
    updateDirtyState,
    updateAprsDrawer,
    recordEvent,
    runAction,
  };
}

window.addEventListener("DOMContentLoaded", async () => {
  initEnvironment();
  ({ trackerApi, trackerById, trackerSetBrowserLocation, trackerRenderStationBadge } = getEnv());

  viewState.activeSection = activeSectionFromHash();

  document.addEventListener("click", (event) => {
    const link = event.target.closest("[data-section-link]");
    if (link) {
      event.preventDefault();
      setActiveSection(link.dataset.sectionLink);
    }
  });

  trackerById("settingsV2SectionPicker").addEventListener("change", () => {
    setActiveSection(trackerById("settingsV2SectionPicker").value);
  });

  window.addEventListener("hashchange", () => {
    viewState.activeSection = activeSectionFromHash();
    renderAll();
  });

  trackerById("v2ToggleRuntime").addEventListener("click", () => {
    const log = trackerById("v2RuntimeLog");
    log.classList.toggle("hidden");
    trackerById("v2ToggleRuntime").textContent = log.classList.contains("hidden") ? "Show Debug" : "Hide Debug";
  });

  trackerById("settingsV2ReturnKiosk").addEventListener("click", returnToKiosk);

  updateClock();
  window.setInterval(updateClock, 1000);
  await refreshState();
  startPolling();
});

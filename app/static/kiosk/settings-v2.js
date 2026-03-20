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

const aprsClient = window.OrbitDeckAprsConsole;

let stateCache = {
  satellites: [],
  timezones: [],
  radio: { settings: {}, runtime: {} },
  aprs: { settings: {}, runtime: {}, previewTarget: null },
  aprsTargets: { satellites: [], terrestrial: null },
  aprsLogSettings: {},
  aprsLog: { items: [] },
  location: { state: {} },
  system: {},
  cachePolicy: {},
};

const aprsUi = {
  sendTab: "message",
  heardFilter: "all",
  drawerTab: "recent",
  draftMode: null,
  seenKeys: new Set(),
  notificationsReady: false,
  pollTimer: null,
  detailPacket: null,
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
  if (!sources.length) throw new Error("At least one video source is required");
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
  if (!options.length) options.push('<option value="">No USB serial ports detected</option>');
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
  if (!options.length) options.push('<option value="default">System Default</option>');
  select.innerHTML = options.join("");
  select.value = resolved || values[0]?.value || values[0]?.name || "default";
}

function renderAprsChannelOptions() {
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

function renderAprsTargetOptions() {
  const settings = stateCache.aprs.settings || {};
  const targets = stateCache.aprsTargets || { satellites: [], terrestrial: null };
  const satSelect = trackerById("v2AprsSatellite");
  satSelect.innerHTML = (targets.satellites || []).map((item) => `<option value="${item.sat_id}">${item.name}</option>`).join("");
  if (settings.selected_satellite_id) satSelect.value = settings.selected_satellite_id;
  renderAprsChannelOptions();
  const terrestrial = targets.terrestrial || {};
  trackerById("v2AprsTerrestrialFreq").value = settings.terrestrial_manual_frequency_hz || terrestrial.suggested_frequency_hz || "";
  trackerById("v2AprsRegionHint").textContent = terrestrial.region_label
    ? `Suggested terrestrial APRS: ${terrestrial.region_label} | ${terrestrial.suggested_frequency_hz} Hz | PATH ${terrestrial.path_default || "--"}`
    : "No terrestrial APRS region suggestion available yet.";
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

function setAprsMode(mode, { preserveDraft = true } = {}) {
  if (preserveDraft) aprsUi.draftMode = mode;
  trackerById("v2AprsModeTerrestrial").classList.toggle("active", mode === "terrestrial");
  trackerById("v2AprsModeSatellite").classList.toggle("active", mode === "satellite");
  trackerById("v2AprsMode").value = mode;
  trackerById("v2AprsSatelliteField").classList.toggle("hidden", mode !== "satellite");
  trackerById("v2AprsChannelField").classList.toggle("hidden", mode !== "satellite");
  trackerById("v2AprsTerrestrialField").classList.toggle("hidden", mode !== "terrestrial");
  trackerById("v2AprsTerrestrialPathField").classList.toggle("hidden", mode !== "terrestrial");
  trackerById("v2AprsSatellitePathField").classList.toggle("hidden", mode !== "satellite");
  trackerById("v2AprsTerrestrialCommentField").classList.toggle("hidden", mode !== "terrestrial");
  trackerById("v2AprsSatelliteCommentField").classList.toggle("hidden", mode !== "satellite");
}

function setAprsSendTab(tab) {
  aprsUi.sendTab = tab;
  trackerById("v2AprsSendTabMessage").classList.toggle("active", tab === "message");
  trackerById("v2AprsSendTabStatus").classList.toggle("active", tab === "status");
  trackerById("v2AprsSendTabPosition").classList.toggle("active", tab === "position");
  trackerById("v2AprsSendMessagePanel").classList.toggle("hidden", tab !== "message");
  trackerById("v2AprsSendStatusPanel").classList.toggle("hidden", tab !== "status");
  trackerById("v2AprsSendPositionPanel").classList.toggle("hidden", tab !== "position");
}

function setAprsDrawerTab(tab) {
  aprsUi.drawerTab = tab;
  for (const button of document.querySelectorAll("[data-aprs-drawer-tab]")) {
    button.classList.toggle("active", button.dataset.aprsDrawerTab === tab);
  }
  trackerById("v2AprsDrawerRecent").classList.toggle("hidden", tab !== "recent");
  trackerById("v2AprsDrawerMessages").classList.toggle("hidden", tab !== "messages");
  trackerById("v2AprsDrawerStored").classList.toggle("hidden", tab !== "stored");
}

function packetKey(packet) {
  return `${packet?.received_at || "--"}|${packet?.source || "--"}|${packet?.destination || "--"}|${packet?.raw_tnc2 || "--"}`;
}

function showAprsToast(title, body) {
  const host = trackerById("v2AprsToastHost");
  const toast = document.createElement("div");
  toast.className = "aprs-toast";
  toast.innerHTML = `<strong>${title}</strong><div>${body}</div>`;
  host.appendChild(toast);
  window.setTimeout(() => {
    toast.remove();
  }, 4200);
}

function maybeNotifyPackets(entries) {
  const settings = stateCache.aprsLogSettings || {};
  if (!aprsUi.notificationsReady) {
    for (const packet of entries) aprsUi.seenKeys.add(packetKey(packet));
    aprsUi.notificationsReady = true;
    return;
  }
  for (const packet of [...entries].reverse()) {
    const key = packetKey(packet);
    if (aprsUi.seenKeys.has(key)) continue;
    aprsUi.seenKeys.add(key);
    if (packet.packet_type === "message" && settings.notify_incoming_messages) {
      showAprsToast(`APRS message from ${packet.source}`, aprsClient.packetPreview(packet));
    } else if (settings.notify_all_packets) {
      showAprsToast(`APRS ${packet.packet_type || "packet"} from ${packet.source}`, aprsClient.packetPreview(packet));
    }
  }
}

function openAprsDrawer() {
  const drawer = trackerById("v2AprsDrawer");
  drawer.classList.remove("hidden");
  drawer.setAttribute("aria-hidden", "false");
}

function closeAprsDrawer() {
  const drawer = trackerById("v2AprsDrawer");
  drawer.classList.add("hidden");
  drawer.setAttribute("aria-hidden", "true");
}

function renderAprsPacketRows(targetId, packets, emptyText) {
  const container = trackerById(targetId);
  if (!packets.length) {
    container.innerHTML = `<div class="settings-v2-inline-note">${emptyText}</div>`;
    return;
  }
  container.innerHTML = packets.map((packet, index) => `
    <button type="button" class="aprs-heard-row" data-aprs-packet-target="${targetId}" data-aprs-packet-index="${index}">
      <div class="aprs-heard-head">
        <strong>${packet.source || "--"}</strong>
        <span class="aprs-heard-meta">${new Date(packet.received_at).toLocaleTimeString()}</span>
      </div>
      <div class="aprs-heard-meta">${aprsClient.packetDetail(packet)} | PATH ${aprsClient.pathText(packet.path)}</div>
      <div class="aprs-heard-text">${aprsClient.packetPreview(packet)}</div>
    </button>
  `).join("");
}

function filteredAprsPackets() {
  const runtimePackets = Array.isArray(stateCache.aprs.runtime?.recent_packets) ? stateCache.aprs.runtime.recent_packets : [];
  const combined = [...runtimePackets];
  for (const packet of stateCache.aprsLog.items || []) {
    if (!combined.some((item) => packetKey(item) === packetKey(packet))) combined.push(packet);
  }
  const filtered = aprsUi.heardFilter === "all"
    ? combined
    : combined.filter((packet) => String(packet.packet_type || "").toLowerCase() === aprsUi.heardFilter);
  return filtered.slice(0, 10);
}

function setAprsPacketDetail(packet) {
  aprsUi.detailPacket = packet || null;
  trackerById("v2AprsPacketDetail").textContent = packet ? pretty(packet) : "Select a packet row for details.";
}

function renderAprsLists() {
  const heardPackets = filteredAprsPackets();
  const allPackets = (stateCache.aprsLog.items || []).slice(0, 10);
  const messagePackets = (stateCache.aprsLog.items || []).filter((packet) => packet.packet_type === "message").slice(0, 10);
  renderAprsPacketRows("v2AprsHeardList", heardPackets, "No APRS packets in the current filter.");
  renderAprsPacketRows("v2AprsDrawerRecent", allPackets.length ? allPackets : heardPackets, "No recent APRS packets stored.");
  renderAprsPacketRows("v2AprsDrawerMessages", messagePackets, "No APRS messages stored.");
  renderAprsPacketRows("v2AprsStoredList", allPackets, "Stored log is empty.");
  trackerById("v2AprsHeardMeta").textContent = `Showing ${heardPackets.length} of the newest APRS packets.`;
}

function renderAprsLastCards() {
  const runtime = stateCache.aprs.runtime || {};
  const lastTx = runtime.last_tx_raw_tnc2
    ? `${runtime.last_tx_packet_type || "packet"} | ${runtime.last_tx_raw_tnc2}`
    : "No local transmission yet.";
  const lastRx = aprsClient.lastRxFromRuntime(runtime);
  trackerById("v2AprsLastTxCard").textContent = lastTx;
  trackerById("v2AprsLastRxCard").textContent = lastRx
    ? `${lastRx.source} | ${aprsClient.packetPreview(lastRx)}`
    : "No packets heard yet.";
}

function renderAprsConnectionState() {
  const runtime = stateCache.aprs.runtime || {};
  const button = trackerById("v2AprsConnectToggle");
  const pill = trackerById("v2AprsConnectionPill");
  const connected = !!runtime.connected;
  pill.textContent = connected ? "Connected" : "Disconnected";
  button.textContent = connected ? "Disconnect" : "Connect";
  button.classList.toggle("aprs-connect-green", !connected);
  button.classList.toggle("aprs-connect-red", connected);
  trackerById("v2AprsPanicUnkey").classList.toggle("hidden", !connected);
  trackerById("v2AprsTxStatus").textContent = aprsClient.summarizeTarget(stateCache.aprs.previewTarget || runtime.target).status;
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
  const wifiManaged = aprsClient.isWifiManaged(radioSettings);
  trackerById("v2AprsAudioInputField").classList.toggle("hidden", wifiManaged);
  trackerById("v2AprsAudioOutputField").classList.toggle("hidden", wifiManaged);
  const note = trackerById("v2AprsAudioManagedNote");
  note.classList.toggle("hidden", !wifiManaged);
  if (wifiManaged) {
    note.textContent =
      "Audio is managed automatically by the IC-705 Wi-Fi transport | RX: IC-705 WLAN audio stream -> Dire Wolf | TX: OrbitDeck AFSK -> IC-705 WLAN audio";
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
      enabled: trackerById("v2AprsFutureDigipeater").checked,
      aliases: trackerById("v2AprsDigipeaterAliases").value.split(",").map((item) => item.trim()).filter(Boolean),
      max_hops: stateCache.aprsLogSettings.digipeater?.max_hops || 1,
      dedupe_window_s: Number(trackerById("v2AprsDigipeaterDedupe").value || 30),
      callsign_allowlist: stateCache.aprsLogSettings.digipeater?.callsign_allowlist || [],
      path_blocklist: stateCache.aprsLogSettings.digipeater?.path_blocklist || ["TCPIP", "TCPXX", "NOGATE", "RFONLY"],
    },
    igate: {
      enabled: trackerById("v2AprsFutureIgate").checked,
      server_host: trackerById("v2AprsIgateHost").value,
      server_port: Number(trackerById("v2AprsIgatePort").value || 14580),
      login_callsign: trackerById("v2AprsIgateLogin").value,
      passcode: trackerById("v2AprsIgatePasscode").value,
      filter: trackerById("v2AprsIgateFilter").value,
      connect_timeout_s: stateCache.aprsLogSettings.igate?.connect_timeout_s || 10,
      gate_terrestrial_rx: trackerById("v2AprsIgateTerrestrial").checked,
      gate_satellite_rx: trackerById("v2AprsIgateSatellite").checked,
    },
    future_digipeater_enabled: trackerById("v2AprsFutureDigipeater").checked,
    future_igate_enabled: trackerById("v2AprsFutureIgate").checked,
  };
}

function updateAprsPositionPreview() {
  trackerById("v2AprsPositionPreview").textContent = aprsClient.buildPositionPreview(stateCache, trackerById("v2AprsPositionComment").value);
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

  stateCache = {
    satellites: satellites.items || [],
    timezones: timezones.timezones || [],
    radio,
    aprs: aprsBundle.aprs,
    aprsTargets: aprsBundle.targets.targets || { satellites: [], terrestrial: null },
    aprsLogSettings: aprsBundle.logSettings || {},
    aprsLog: aprsBundle.logRecent || { items: [] },
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
    audioDevices: aprsBundle.audioDevices || { inputs: [], outputs: [] },
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

  const aprsSettings = stateCache.aprs.settings || {};
  trackerById("v2AprsCallsign").value = aprsSettings.callsign || "N0CALL";
  trackerById("v2AprsSsid").value = aprsSettings.ssid ?? 10;
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
  setAprsMode(aprsUi.draftMode || aprsSettings.operating_mode || "terrestrial", { preserveDraft: false });
  renderAprsTargetOptions();

  trackerById("v2AprsLogEnabled").checked = !!stateCache.aprsLogSettings.log_enabled;
  trackerById("v2AprsLogMaxRecords").value = String(stateCache.aprsLogSettings.log_max_records || 500);
  trackerById("v2AprsNotifyMessages").checked = stateCache.aprsLogSettings.notify_incoming_messages !== false;
  trackerById("v2AprsNotifyAllPackets").checked = !!stateCache.aprsLogSettings.notify_all_packets;
  trackerById("v2AprsFutureDigipeater").checked = !!stateCache.aprsLogSettings.future_digipeater_enabled;
  trackerById("v2AprsFutureIgate").checked = !!stateCache.aprsLogSettings.future_igate_enabled;
  trackerById("v2AprsDigipeaterAliases").value = (stateCache.aprsLogSettings.digipeater?.aliases || ["WIDE1-1"]).join(",");
  trackerById("v2AprsDigipeaterDedupe").value = String(stateCache.aprsLogSettings.digipeater?.dedupe_window_s || 30);
  trackerById("v2AprsIgateHost").value = stateCache.aprsLogSettings.igate?.server_host || "rotate.aprs2.net";
  trackerById("v2AprsIgatePort").value = String(stateCache.aprsLogSettings.igate?.server_port || 14580);
  trackerById("v2AprsIgateLogin").value = stateCache.aprsLogSettings.igate?.login_callsign || "";
  trackerById("v2AprsIgatePasscode").value = stateCache.aprsLogSettings.igate?.passcode || "";
  trackerById("v2AprsIgateFilter").value = stateCache.aprsLogSettings.igate?.filter || "m/25";
  trackerById("v2AprsIgateTerrestrial").checked = stateCache.aprsLogSettings.igate?.gate_terrestrial_rx !== false;
  trackerById("v2AprsIgateSatellite").checked = stateCache.aprsLogSettings.igate?.gate_satellite_rx !== false;

  const targetSummary = aprsClient.summarizeTarget(stateCache.aprs.previewTarget || stateCache.aprs.runtime?.target);
  trackerById("v2AprsTargetSummary").textContent = targetSummary.headline;
  renderAprsConnectionState();
  renderAprsLastCards();
  renderAprsLists();
  updateAprsPositionPreview();
  updateSectionSummaries();
  updateRuntimePane();
  updateRadioContextNote();
  syncAprsAudioUi();

  const dev = getDevSettings();
  trackerById("v2DevOverridesEnabled").checked = dev.enabled;
  trackerById("v2DevForceScene").value = dev.forceScene;

  maybeNotifyPackets(stateCache.aprsLog.items || []);
  if (!aprsUi.detailPacket) {
    setAprsPacketDetail((stateCache.aprsLog.items || [])[0] || null);
  }
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
  await runAction("POST /api/v1/settings/aprs", () => aprsClient.saveAprsSettings(trackerApi, aprsSettingsPayload()));
  aprsUi.draftMode = null;
  await refreshState();
}

async function saveAprsLogSettingsSection() {
  await runAction("POST /api/v1/aprs/log/settings", () => aprsClient.saveLogSettings(trackerApi, aprsLogSettingsPayload()));
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
  aprsUi.draftMode = null;
  await refreshState();
}

async function toggleAprsConnection() {
  if (stateCache.aprs.runtime?.connected) {
    await runAction("POST /api/v1/aprs/disconnect", () => aprsClient.disconnect(trackerApi));
    await refreshState();
    return;
  }
  await runAction("POST /api/v1/settings/aprs", () => aprsClient.saveAprsSettings(trackerApi, aprsSettingsPayload()));
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
  aprsUi.draftMode = null;
  await refreshState();
}

async function saveDeveloperSection() {
  saveDevSettings();
  setRuntime("local developer settings", { status: "ok", response: getDevSettings() });
  await refreshState();
}

function startAprsPolling() {
  if (aprsUi.pollTimer) window.clearInterval(aprsUi.pollTimer);
  aprsUi.pollTimer = window.setInterval(async () => {
    try {
      await refreshState();
    } catch (_) {
      // Non-fatal polling failure.
    }
  }, 5000);
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
  trackerById("v2AprsModeTerrestrial").addEventListener("click", () => setAprsMode("terrestrial"));
  trackerById("v2AprsModeSatellite").addEventListener("click", () => setAprsMode("satellite"));
  trackerById("v2AprsSatellite").addEventListener("change", renderAprsChannelOptions);
  trackerById("v2AprsPositionComment").addEventListener("input", updateAprsPositionPreview);
  trackerById("v2AprsPositionFudgeLat").addEventListener("input", updateAprsPositionPreview);
  trackerById("v2AprsPositionFudgeLon").addEventListener("input", updateAprsPositionPreview);
  trackerById("v2AprsSendTabMessage").addEventListener("click", () => setAprsSendTab("message"));
  trackerById("v2AprsSendTabStatus").addEventListener("click", () => setAprsSendTab("status"));
  trackerById("v2AprsSendTabPosition").addEventListener("click", () => setAprsSendTab("position"));
  aprsClient.bindCounter(trackerById("v2AprsMessageBody"), trackerById("v2AprsMessageCounter"), {});
  aprsClient.bindCounter(trackerById("v2AprsStatusBody"), trackerById("v2AprsStatusCounter"), {});
  aprsClient.bindCounter(trackerById("v2AprsPositionComment"), trackerById("v2AprsPositionCounter"), { hardLimit: 40, softLimit: 20 });

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
  trackerById("v2AprsSelectTarget").addEventListener("click", refreshAprsTarget);
  trackerById("v2AprsConnectToggle").addEventListener("click", toggleAprsConnection);
  trackerById("v2AprsPanicUnkey").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/panic-unkey", () => aprsClient.panicUnkey(trackerApi));
    await refreshState();
  });
  trackerById("v2AprsSendMessage").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/send/message", () => aprsClient.sendMessage(trackerApi, {
      to: trackerById("v2AprsMessageTo").value,
      text: trackerById("v2AprsMessageBody").value,
    }));
    await refreshState();
  });
  trackerById("v2AprsSendStatus").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/send/status", () => aprsClient.sendStatus(trackerApi, {
      text: trackerById("v2AprsStatusBody").value,
    }));
    await refreshState();
  });
  trackerById("v2AprsSendPosition").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/send/position", () => aprsClient.sendPosition(trackerApi, {
      comment: trackerById("v2AprsPositionComment").value,
    }));
    await refreshState();
  });
  trackerById("v2AprsOpenInbox").addEventListener("click", openAprsDrawer);
  trackerById("v2AprsCloseInbox").addEventListener("click", closeAprsDrawer);
  trackerById("v2AprsRefreshLog").addEventListener("click", refreshState);
  trackerById("v2AprsSaveLogSettings").addEventListener("click", saveAprsLogSettingsSection);
  trackerById("v2AprsExportCsv").addEventListener("click", () => {
    window.open(aprsClient.exportUrl("csv"), "_blank", "noopener,noreferrer");
  });
  trackerById("v2AprsExportJson").addEventListener("click", () => {
    window.open(aprsClient.exportUrl("json"), "_blank", "noopener,noreferrer");
  });
  trackerById("v2AprsClearLog").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/log/clear", () => aprsClient.clearLog(trackerApi, trackerById("v2AprsClearAge").value));
    await refreshState();
  });
  trackerById("v2SaveDeveloper").addEventListener("click", saveDeveloperSection);
  trackerById("v2RefreshPassCache").addEventListener("click", async () => {
    await runAction("POST /api/v1/passes/cache/refresh", () => trackerApi.post("/api/v1/passes/cache/refresh", {}));
    await refreshState();
  });
  trackerById("v2RefreshPage").addEventListener("click", refreshState);

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-aprs-filter], [data-aprs-packet-index], [data-aprs-drawer-tab], [data-aprs-drawer-close]");
    if (!target) return;
    if (target.hasAttribute("data-aprs-drawer-close")) {
      closeAprsDrawer();
      return;
    }
    if (target.dataset.aprsFilter) {
      aprsUi.heardFilter = target.dataset.aprsFilter;
      for (const button of document.querySelectorAll("[data-aprs-filter]")) {
        button.classList.toggle("active", button.dataset.aprsFilter === aprsUi.heardFilter);
      }
      renderAprsLists();
      return;
    }
    if (target.dataset.aprsDrawerTab) {
      setAprsDrawerTab(target.dataset.aprsDrawerTab);
      return;
    }
    if (target.dataset.aprsPacketIndex) {
      const sourceId = target.dataset.aprsPacketTarget;
      let packets = [];
      if (sourceId === "v2AprsHeardList") packets = filteredAprsPackets();
      if (sourceId === "v2AprsDrawerRecent") packets = (stateCache.aprsLog.items || []).slice(0, 10);
      if (sourceId === "v2AprsDrawerMessages") packets = (stateCache.aprsLog.items || []).filter((packet) => packet.packet_type === "message").slice(0, 10);
      if (sourceId === "v2AprsStoredList") packets = (stateCache.aprsLog.items || []).slice(0, 10);
      const packet = packets[Number(target.dataset.aprsPacketIndex)] || null;
      setAprsPacketDetail(packet);
    }
  });

  updateClock();
  setInterval(updateClock, 1000);
  setAprsSendTab("message");
  setAprsDrawerTab("recent");
  await refreshState();
  initSectionObserver();
  applyHashState();
  startAprsPolling();
});

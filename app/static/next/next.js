const state = {
  view: "operate",
  context: "radio",
  system: null,
  passes: [],
  selectedPass: null,
  aprs: null,
  aprsTargets: null,
  aprsLog: [],
  aprsDrafts: { to: "", message: "", status: "", position: "" },
  stationSettings: null,
  plannerView: "timeline",
  plannerSettings: null,
  availableSatellites: [],
  mapPaths: {},
  mapHiddenSatIds: new Set(),
  mapSelectedSatId: null,
  radioPorts: [],
  channelSelection: {},
  passVisible: 12,
  busy: false,
};

const mapColors = ["#4ad1c3", "#ffbd52", "#8aa8ff", "#d98cff", "#ff7b72"];
const mapState = {
  zoom: 2,
  centerLat: 0,
  centerLon: 0,
  basemap: localStorage.getItem("orbitdeck.basemap") || "terrain",
  drag: null,
  initialized: false,
};
const esriBasemaps = {
  terrain: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles © Esri — Sources: Esri, HERE, Garmin, USGS, FAO, NOAA, and the GIS User Community",
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
  outline: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    attribution: "Boundaries and places © Esri, HERE, Garmin, FAO, NOAA, USGS, and contributors",
  },
};

const byId = (id) => document.getElementById(id);
const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const number = (value, digits = 1, suffix = "") => finite(value) ? `${Number(value).toFixed(digits)}${suffix}` : "—";
const asDate = (value) => value ? new Date(value) : null;
const time = (value) => {
  const date = asDate(value);
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
};
const activityTime = (value) => {
  const date = asDate(value);
  if (!date || Number.isNaN(date.getTime())) return "—";
  const prefix = date.toDateString() === new Date().toDateString() ? "" : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} · `;
  return `${prefix}${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};
const duration = (milliseconds) => {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const labelize = (value) => String(value || "idle").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const rigLabel = (value) => ({ ic705: "IC-705", id5100: "ID-5100" }[String(value || "").toLowerCase()] || String(value || "Radio").toUpperCase());

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...options.headers, "X-OrbitDeck-Session": window.issTracker.sessionId } });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    const detail = typeof payload.detail === "string" ? payload.detail : payload.detail?.message;
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  return payload;
}

async function post(path, body = {}) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const txAuthorization = {
  mode: "legacy-open",
  status() {
    return { label: "TX policy pending", tone: "attention", detail: "Transmit authorization will connect here after hardware validation." };
  },
  async authorize() { return true; },
};

function showNotice(message, error = false) {
  const notice = byId("notice");
  notice.textContent = message;
  notice.classList.toggle("error", error);
  notice.classList.remove("hidden");
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => notice.classList.add("hidden"), error ? 9000 : 4500);
}

function setChip(id, text, tone = "") {
  const chip = byId(id);
  chip.textContent = text;
  chip.classList.remove("ready", "attention", "danger");
  if (tone) chip.classList.add(tone);
}

function passPhase(pass) {
  if (!pass) return "none";
  const now = Date.now();
  const aos = asDate(pass.aos)?.getTime() ?? Infinity;
  const los = asDate(pass.los)?.getTime() ?? -Infinity;
  if (now < aos) return "upcoming";
  if (now <= los) return "active";
  return "complete";
}

function passForFocus() {
  if (state.selectedPass) return state.selectedPass;
  const active = state.passes.find((item) => passPhase(item) === "active");
  return active || state.passes[0] || state.system?.activePass || null;
}

function matchingTrack(pass) {
  if (!pass) return state.system?.activeTrack || null;
  return state.system?.tracks?.find((item) => item.sat_id === pass.sat_id) || (state.system?.activeTrack?.sat_id === pass.sat_id ? state.system.activeTrack : null);
}

function recommendationFor(pass) {
  if (!pass) return state.system?.frequencyRecommendation || null;
  if (pass.frequencyRecommendation) return pass.frequencyRecommendation;
  return state.system?.activeTrack?.sat_id === pass.sat_id ? state.system.frequencyRecommendation : null;
}

function sessionRecommendation(pass) {
  const session = state.system?.radioControlSession || {};
  const focused = session.active && session.selected_sat_id === pass?.sat_id && (!session.selected_pass_aos || session.selected_pass_aos === pass?.aos);
  return focused && session.test_pair ? session.test_pair : recommendationFor(pass);
}

function channelChoices(pass) {
  if (!pass) return [];
  const recommendation = recommendationFor(pass);
  const choices = [];
  const add = (choice) => {
    if (!finite(choice.uplink_mhz) && !finite(choice.downlink_mhz)) return;
    const key = `${choice.uplink_mhz || ""}|${choice.downlink_mhz || ""}|${choice.uplink_mode || ""}|${choice.downlink_mode || ""}`;
    if (!choices.some((item) => item.key === key)) choices.push({ ...choice, key });
  };
  if (recommendation) add({ ...recommendation, label: recommendation.label || "Recommended channel" });
  const matrix = pass.frequencyMatrix;
  (matrix?.columns || []).forEach((column) => add({
    uplink_mhz: column.uplink_mhz,
    downlink_mhz: column.downlink_mid_mhz,
    uplink_mode: recommendation?.uplink_mode || "FM",
    downlink_mode: recommendation?.downlink_mode || "FM",
    label: column.label || `Channel ${Number(column.index) + 1}`,
  }));
  const sessionPair = state.system?.radioControlSession?.test_pair;
  if (sessionPair && state.system.radioControlSession.selected_sat_id === pass.sat_id) add(sessionPair);
  return choices;
}

function pairSummary(pair) {
  const rx = finite(pair?.downlink_mhz) ? `${Number(pair.downlink_mhz).toFixed(3)} RX` : "receive only unavailable";
  const tx = finite(pair?.uplink_mhz) ? `${Number(pair.uplink_mhz).toFixed(3)} TX` : "RX only";
  return `${rx} · ${tx}`;
}

function renderStationBar() {
  const pass = passForFocus();
  const radio = state.system?.radioRuntime || {};
  const auth = txAuthorization.status();
  setChip("focusStatus", pass ? `${pass.name || pass.sat_id} focused` : "No pass focused");
  setChip("radioStatus", radio.connected ? `${rigLabel(radio.rig_model)} connected` : "Radio disconnected", radio.connected ? "ready" : "");
  const tracking = ["auto_tracking", "tracking_active", "armed_waiting_aos"].includes(radio.control_mode) || state.system?.radioControlSession?.control_state === "tracking_active";
  setChip("dopplerStatus", tracking ? "Doppler automatic" : "Doppler idle", tracking ? "ready" : "");
  setChip("txStatus", auth.label, auth.tone);
  const stamp = asDate(state.system?.timestamp);
  const age = stamp ? Date.now() - stamp.getTime() : null;
  setChip("dataStatus", age == null ? "Data unavailable" : age < 5000 ? "Live data" : `Data ${duration(age)} old`, age != null && age < 60000 ? "ready" : "attention");
}

function renderQueue() {
  const queue = byId("passQueue");
  const selected = passForFocus();
  if (!state.passes.length) {
    queue.innerHTML = '<div class="queue-empty">No qualifying passes in the next 24 hours.</div>';
    return;
  }
  queue.innerHTML = state.passes.slice(0, 5).map((pass) => {
    const phase = passPhase(pass);
    const selectedClass = selected && selected.sat_id === pass.sat_id && selected.aos === pass.aos ? " selected" : "";
    const relative = phase === "active" ? `Live · LOS in ${duration(asDate(pass.los) - Date.now())}` : `in ${duration(asDate(pass.aos) - Date.now())}`;
    return `<button class="pass-item${selectedClass}" type="button" data-pass-key="${escapeHtml(pass.sat_id)}|${escapeHtml(pass.aos)}"><strong>${escapeHtml(pass.name || pass.sat_id)}</strong><time>${phase === "active" ? "LIVE" : time(pass.aos)}</time><small>${relative} · peak ${number(pass.max_el_deg, 0, "°")}</small></button>`;
  }).join("");
}

function readinessItems(pass, recommendation) {
  const system = state.system || {};
  const session = system.radioControlSession || {};
  return [
    ["Station identity", !!system.stationIdentity?.configured, system.stationIdentity?.callsign || system.stationIdentity?.reason || "Not configured"],
    ["Location", finite(system.location?.lat) && finite(system.location?.lon), finite(system.location?.lat) ? `${number(system.location.lat, 3)}, ${number(system.location.lon, 3)}` : "Location unavailable"],
    ["Radio", !!system.radioRuntime?.connected, system.radioRuntime?.connected ? `${labelize(system.radioSettings?.transport_mode)} connection` : "Connect before control"],
    ["Channel pair", !!recommendation, recommendation?.label || "No compatible guide"],
    ["Pass session", !!(session.active && session.selected_sat_id === pass?.sat_id), session.active ? labelize(session.control_state) : "Select Prepare pass"],
  ];
}

function renderReadiness(pass, recommendation) {
  const items = readinessItems(pass, recommendation);
  const ready = items.filter((item) => item[1]).length;
  byId("readinessScore").textContent = `${ready} of ${items.length}`;
  byId("readinessList").innerHTML = items.map(([name, ok, detail]) => `<div class="readiness-row${ok ? " ready" : ""}"><span><strong>${escapeHtml(name)}</strong>${escapeHtml(detail)}</span></div>`).join("");
}

function polarPoint(azimuth, elevation, radius = 112) {
  if (!finite(azimuth) || !finite(elevation)) return [150, 150];
  const distance = radius * (1 - Math.max(0, Math.min(90, Number(elevation))) / 90);
  const angle = Number(azimuth) * Math.PI / 180;
  return [150 + distance * Math.sin(angle), 150 - distance * Math.cos(angle)];
}

function renderPlot(pass, track) {
  let pathPoints = [];
  if (state.system?.activeTrack?.sat_id === pass?.sat_id && state.system?.activePass?.aos === pass?.aos) pathPoints = state.system.activeTrackPath || [];
  const coords = pathPoints.filter((item) => finite(item.az_deg) && finite(item.el_deg)).map((item) => polarPoint(item.az_deg, item.el_deg));
  byId("passPath").setAttribute("d", coords.length ? `M ${coords.map((point) => `${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(" L ")}` : "");
  const [x, y] = polarPoint(track?.az_deg, track?.el_deg);
  byId("satelliteDot").setAttribute("cx", x.toFixed(1));
  byId("satelliteDot").setAttribute("cy", y.toFixed(1));
}

function appliedTargets(runtime) {
  const targets = runtime?.targets || {};
  const receive = targets.sub_freq_hz || targets.rx_freq_hz || targets.main_freq_hz;
  const transmit = targets.main_freq_hz || targets.tx_freq_hz;
  return { receive, transmit };
}

function primaryWorkflow(pass) {
  const system = state.system || {};
  const radio = system.radioRuntime || {};
  const session = system.radioControlSession || {};
  const focused = session.active && session.selected_sat_id === pass?.sat_id && (!session.selected_pass_aos || session.selected_pass_aos === pass?.aos);
  if (!pass) return { label: "No pass available", disabled: true };
  if (!system.stationIdentity?.configured) return { label: "Configure callsign", href: "/settings" };
  if (!focused) return { label: "Prepare pass", action: "prepare" };
  if (!radio.connected) return { label: "Connect radio", action: "connect" };
  if (!session.is_eligible) return { label: "Pass not radio eligible", disabled: true };
  if (session.screen_state === "test") return { label: "Confirm radio test", action: "confirm" };
  if (session.screen_state === "released") return { label: passPhase(pass) === "upcoming" ? "Arm pass" : "Start tracking", action: "start" };
  if (!["armed", "active"].includes(session.screen_state)) return { label: "Test radio control", action: "test" };
  if (session.screen_state === "armed") return { label: "Pass armed", disabled: true };
  return { label: "Tracking active", disabled: true };
}

function renderOperate() {
  const pass = passForFocus();
  const track = matchingTrack(pass);
  const recommendation = sessionRecommendation(pass);
  const radio = state.system?.radioRuntime || {};
  const session = state.system?.radioControlSession || {};
  const phase = passPhase(pass);
  const now = Date.now();
  const aos = asDate(pass?.aos)?.getTime();
  const tca = asDate(pass?.tca)?.getTime();
  const los = asDate(pass?.los)?.getTime();

  const labels = { active: "Live pass", upcoming: "Next pass", complete: "Pass complete", none: "Station ready" };
  byId("phaseLabel").textContent = labels[phase];
  byId("focusTitle").textContent = pass?.name || track?.name || "No pass selected";
  byId("focusSubtitle").textContent = pass ? `${phase === "active" ? "Above horizon" : phase === "upcoming" ? "Below horizon" : "Below horizon"} · ${track?.sunlit ? "sunlit" : "in Earth shadow"} · ${recommendation?.label || "No radio guide"}` : "Choose a pass to begin.";
  byId("countdownLabel").textContent = phase === "active" ? "LOS in" : phase === "upcoming" ? "AOS in" : phase === "complete" ? "Duration" : "Status";
  byId("countdownValue").textContent = phase === "active" ? duration(los - now) : phase === "upcoming" ? duration(aos - now) : phase === "complete" ? duration(los - aos) : "Idle";
  byId("aosTime").textContent = `AOS ${time(pass?.aos)}`;
  byId("tcaTime").textContent = `TCA ${time(pass?.tca)}`;
  byId("losTime").textContent = `LOS ${time(pass?.los)}`;
  const progress = phase === "active" && los > aos ? Math.max(0, Math.min(100, (now - aos) / (los - aos) * 100)) : phase === "complete" ? 100 : 0;
  byId("progressValue").style.width = `${progress}%`;

  byId("azimuthValue").textContent = number(track?.az_deg, 1, "°");
  byId("elevationValue").textContent = number(track?.el_deg, 1, "°");
  byId("rangeValue").textContent = number(track?.range_km, 0, " km");
  byId("maxElevationValue").textContent = number(pass?.max_el_deg, 1, "°");
  renderPlot(pass, track);

  const targets = appliedTargets(radio);
  const rxMhz = recommendation?.downlink_mhz ?? (finite(targets.receive) ? targets.receive / 1_000_000 : null);
  const txMhz = recommendation?.uplink_mhz ?? (finite(targets.transmit) ? targets.transmit / 1_000_000 : null);
  byId("rxFrequency").textContent = finite(rxMhz) ? `${Number(rxMhz).toFixed(3)} MHz` : "—";
  byId("txFrequency").textContent = finite(txMhz) ? `${Number(txMhz).toFixed(3)} MHz` : "—";
  byId("rxMode").textContent = recommendation?.downlink_mode || "—";
  byId("txMode").textContent = [recommendation?.uplink_mode, recommendation?.tone].filter(Boolean).join(" · ") || "—";
  byId("rxDetail").textContent = recommendation?.correction_side ? `${labelize(recommendation.correction_side)} correction` : "No receive target";
  byId("txDetail").textContent = txAuthorization.status().detail;
  const choices = channelChoices(pass);
  const pairSelect = byId("channelPairSelect");
  const wantedKey = state.channelSelection[pass?.sat_id] || choices[0]?.key || "";
  pairSelect.innerHTML = choices.length ? choices.map((choice) => `<option value="${escapeHtml(choice.key)}"${choice.key === wantedKey ? " selected" : ""}>${escapeHtml(choice.label)} · ${escapeHtml(pairSummary(choice))}</option>`).join("") : '<option value="">No compatible channel pair</option>';
  pairSelect.disabled = state.busy || !choices.length;
  byId("applyChannelPair").disabled = state.busy || !choices.length || !pass;
  byId("channelPairDetail").textContent = session.test_pair_reason || (choices.length ? "Applied during the radio test, with live Doppler correction." : "This satellite has no compatible radio guide.");
  byId("trackingState").textContent = labelize(session.control_state || radio.control_mode);
  const confirmation = byId("radioConfirmation");
  confirmation.textContent = radio.last_error ? radio.last_error : radio.connected ? `Radio connected${radio.last_poll_at ? ` · confirmed ${time(radio.last_poll_at)}` : ""}` : "Radio is not connected";
  confirmation.className = `confirmation ${radio.last_error ? "error" : radio.connected ? "ready" : ""}`;
  byId("technicalDetail").textContent = `Range rate ${number(track?.range_rate_km_s, 2, " km/s")} · transport ${labelize(state.system?.radioSettings?.transport_mode)} · endpoint ${radio.endpoint || "—"} · control ${labelize(radio.control_mode)}`;

  renderReadiness(pass, recommendation);
  const workflow = primaryWorkflow(pass);
  const primary = byId("primaryAction");
  primary.textContent = workflow.label;
  primary.disabled = !!workflow.disabled || state.busy;
  primary.dataset.action = workflow.action || "";
  primary.dataset.href = workflow.href || "";
  byId("stopControl").disabled = state.busy || !session.active || !["test", "armed", "active"].includes(session.screen_state);
  byId("releaseSession").disabled = state.busy || !session.active;
  byId("secondaryAction").textContent = radio.connected ? "Disconnect radio" : "Configure radio";
  renderQueue();
  renderContext();
}

function renderContext() {
  const content = byId("contextContent");
  const system = state.system || {};
  const editingAprs = state.context === "aprs" && content.contains(document.activeElement) && document.activeElement.matches("input, textarea");
  if (editingAprs) return;
  content.classList.toggle("aprs-mode", state.context === "aprs");
  if (state.context === "aprs") {
    const runtime = state.aprs?.runtime || system.aprsRuntime || {};
    const preview = state.aprs?.previewTarget || system.aprsPreviewTarget || {};
    const settings = state.aprs?.settings || system.aprsSettings || {};
    const pass = passForFocus();
    const satellites = state.aprsTargets?.targets?.satellites || [];
    const options = satellites.flatMap((satellite) => (satellite.channels || []).map((channel) => ({ ...channel, sat_id: satellite.sat_id, sat_name: satellite.name })));
    options.sort((left, right) => Number(right.sat_id === pass?.sat_id) - Number(left.sat_id === pass?.sat_id) || left.sat_name.localeCompare(right.sat_name));
    const selectedKey = `${settings.selected_satellite_id || preview.sat_id || ""}|${settings.selected_channel_id || preview.channel_id || ""}`;
    const targetReady = runtime.connected && preview.can_transmit && !settings.listen_only;
    const radioInUse = !runtime.connected && !!system.radioRuntime?.connected;
    const txReason = settings.listen_only ? "Listen-only mode is enabled in APRS settings." : preview.tx_block_reason || (runtime.connected ? "Transmit is unavailable for this target." : "Connect APRS before transmitting.");
    const packets = state.aprsLog.slice(0, 5);
    content.innerHTML = `<h2>Satellite APRS</h2><p>${runtime.connected ? `Listening as ${escapeHtml(runtime.effective_source_call || "configured station")}.` : "Select a satellite channel, then connect when you are ready to monitor the pass."}</p>
      <label class="context-select"><span>Satellite channel</span><select id="aprsTargetSelect"><option value="">Choose an APRS channel…</option>${options.map((item) => { const key = `${item.sat_id}|${item.channel_id}`; return `<option value="${escapeHtml(key)}"${key === selectedKey ? " selected" : ""}>${escapeHtml(item.sat_name)} · ${escapeHtml(item.label)} · ${(Number(item.frequency_hz) / 1_000_000).toFixed(3)} MHz</option>`; }).join("")}</select></label>
      <div class="aprs-target-summary">
        <div><span>Target</span><strong>${escapeHtml(preview.label || "Not selected")}</strong></div>
        <div><span>Frequency</span><strong>${finite(preview.corrected_frequency_hz || preview.frequency_hz) ? `${(Number(preview.corrected_frequency_hz || preview.frequency_hz) / 1_000_000).toFixed(3)} MHz` : "—"}</strong></div>
        <div><span>Path</span><strong>${escapeHtml(preview.path_default || "—")}</strong></div>
        <div><span>Traffic</span><strong>${Number(runtime.packets_rx || 0)} RX / ${Number(runtime.packets_tx || 0)} TX</strong></div>
      </div>
      <div class="context-actions aprs-session-actions"><button class="button" type="button" data-aprs-action="${runtime.connected ? "disconnect" : "connect"}"${preview.sat_id ? "" : " disabled"}>${runtime.connected ? "Disconnect APRS" : radioInUse ? "Connect APRS · take radio" : "Connect APRS"}</button><button class="button danger-button" type="button" data-aprs-action="emergency"${runtime.connected ? "" : " disabled"}>Stop APRS now</button></div>
      ${radioInUse ? '<p class="ownership-note">APRS needs exclusive radio control. Connecting will safely end the current radio-control connection.</p>' : ""}
      <div class="aprs-permission ${targetReady ? "ready" : ""}">${targetReady ? "Pass active · APRS transmit available" : escapeHtml(txReason)}</div>
      <details class="aprs-compose"><summary>Send through ${escapeHtml(runtime.effective_source_call || system.stationIdentity?.callsign || "station callsign")}</summary>
        <div class="compose-block"><strong>Message</strong><div class="compose-row"><input id="aprsMessageTo" maxlength="9" placeholder="Callsign" value="${escapeHtml(state.aprsDrafts.to)}"><textarea id="aprsMessageText" maxlength="67" rows="2" placeholder="Message">${escapeHtml(state.aprsDrafts.message)}</textarea><button class="button" type="button" data-aprs-send="message"${targetReady ? "" : " disabled"}>Send message</button></div></div>
        <div class="compose-block"><strong>Status</strong><div class="compose-row"><textarea id="aprsStatusText" maxlength="67" rows="2" placeholder="Station status">${escapeHtml(state.aprsDrafts.status)}</textarea><button class="button" type="button" data-aprs-send="status"${targetReady ? "" : " disabled"}>Send status</button></div></div>
        <div class="compose-block"><strong>Position</strong><div class="compose-row"><input id="aprsPositionComment" maxlength="40" placeholder="Position comment" value="${escapeHtml(state.aprsDrafts.position)}"><button class="button" type="button" data-aprs-send="position"${targetReady ? "" : " disabled"}>Send position</button></div></div>
      </details>
      <section class="packet-preview"><div class="section-heading"><h3>Recent packets</h3><span>${packets.length ? "Stored log" : "Waiting"}</span></div>${packets.length ? packets.map((packet) => `<div class="packet-row"><div><strong>${escapeHtml(packet.source || "Unknown")}</strong><span>${escapeHtml(labelize(packet.packet_type))} · ${activityTime(packet.received_at)}</span></div><p>${escapeHtml(packet.text || packet.raw_tnc2 || "Packet received")}</p></div>`).join("") : '<p class="empty-copy">No packets recorded yet.</p>'}</section>
      <div class="context-actions"><a class="button" href="/aprs">Open full APRS console</a></div>
      <div class="context-note">All APRS send actions use the same authorization boundary reserved for the tested PIN lease. Terrestrial and gateway controls remain in the full console.</div>`;
  } else {
    const settings = system.radioSettings || {};
    const runtime = system.radioRuntime || {};
    const session = system.radioControlSession || {};
    const stage = !session.active ? 0 : !runtime.connected ? 1 : session.screen_state === "idle" ? 2 : session.screen_state === "test" ? 3 : session.screen_state === "released" ? 4 : 5;
    const steps = ["Prepare", "Connect", "Test", "Confirm", "Arm / track"];
    content.innerHTML = `<h2>${escapeHtml(rigLabel(settings.rig_model))}</h2><p>${runtime.connected ? "Connected and reporting state." : "Use the pass workflow to connect and validate the configured radio."}</p>
      <div class="workflow-steps" aria-label="Radio workflow">${steps.map((label, index) => `<span class="${index < stage ? "done" : index === stage ? "current" : ""}">${escapeHtml(label)}</span>`).join("")}</div>
      <div class="context-row"><span>Connection</span><strong>${runtime.connected ? "Connected" : "Disconnected"}</strong></div>
      <div class="context-row"><span>Transport</span><strong>${labelize(settings.transport_mode)}</strong></div>
      <div class="context-row"><span>Session</span><strong>${labelize(session.control_state)}</strong></div>
      <div class="context-row"><span>Restore policy</span><strong>Restore prior state</strong></div>
      <div class="context-row"><span>Selected pair</span><strong>${escapeHtml(session.test_pair?.label || "Not prepared")}</strong></div>
      <div class="context-actions"><button class="button" type="button" data-open-radio>Configure connection</button><a class="button" href="/radio">Open engineering controls</a></div>
      <div class="context-note">Choose the operational channel in the Radio deck. Connection and safe advanced settings stay here; manual tuning remains in engineering controls.</div>`;
  }
}

function filteredPasses() {
  const hours = Number(byId("passWindow")?.value || 24);
  const satellite = byId("passSatellite")?.value || "";
  const minimum = Number(byId("passElevation")?.value || 0);
  const radioOnly = !!byId("passRadioOnly")?.checked;
  const end = Date.now() + hours * 3600000;
  return state.passes.filter((pass) => {
    const aos = asDate(pass.aos)?.getTime() || 0;
    return aos <= end && (!satellite || pass.sat_id === satellite) && Number(pass.max_el_deg || 0) >= minimum && (!radioOnly || !!pass.frequencyRecommendation);
  });
}

function periodLabel(value) {
  const date = asDate(value);
  if (!date) return "Later";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const day = sameDay ? "Today" : date.toDateString() === tomorrow.toDateString() ? "Tomorrow" : date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  const part = date.getHours() < 12 ? "morning" : date.getHours() < 17 ? "afternoon" : "evening";
  return `${day} ${part}`;
}

function renderPassFilters() {
  const current = byId("passSatellite").value;
  const satellites = [...new Map(state.passes.map((pass) => [pass.sat_id, pass.name || pass.sat_id])).entries()];
  byId("passSatellite").innerHTML = '<option value="">All tracked</option>' + satellites.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("");
  byId("passSatellite").value = satellites.some(([id]) => id === current) ? current : "";
}

function renderPasses() {
  renderPassFilters();
  const passes = filteredPasses();
  byId("passCount").textContent = `${passes.length} qualifying ${passes.length === 1 ? "pass" : "passes"}`;
  byId("passHighlights").innerHTML = passes.slice(0, 3).map((pass, index) => `<button class="pass-highlight" type="button" data-focus-key="${escapeHtml(pass.sat_id)}|${escapeHtml(pass.aos)}"><span>${index === 0 ? "Next opportunity" : `Opportunity ${index + 1}`}</span><strong>${escapeHtml(pass.name || pass.sat_id)}</strong><time>${time(pass.aos)}</time><small>Peak ${number(pass.max_el_deg, 1, "°")} · ${pass.frequencyRecommendation ? "radio guide" : "tracking only"}</small></button>`).join("");
  let period = "";
  const visible = passes.slice(0, state.passVisible);
  const rows = visible.map((pass) => {
    const nextPeriod = periodLabel(pass.aos);
    const heading = nextPeriod !== period ? `<div class="pass-period">${escapeHtml(nextPeriod)}</div>` : "";
    period = nextPeriod;
    return `${heading}<div class="pass-table-row" role="button" tabindex="0" data-focus-key="${escapeHtml(pass.sat_id)}|${escapeHtml(pass.aos)}"><strong>${escapeHtml(pass.name || pass.sat_id)}</strong><span>${time(pass.aos)}</span><span>${time(pass.tca)}</span><span>${time(pass.los)}</span><span>${number(pass.max_el_deg, 1, "°")}<span class="elevation-meter"><i style="width:${Math.min(100, Number(pass.max_el_deg || 0))}%"></i></span></span><small>${pass.frequencyRecommendation ? "Radio guide" : "Tracking"}</small></div>`;
  }).join("");
  byId("passTable").innerHTML = rows || '<div class="queue-empty">No passes match these filters.</div>';
  byId("showMorePasses").classList.toggle("hidden", passes.length <= state.passVisible);
}

function mapSize() { return 256 * (2 ** mapState.zoom); }
function minimumMapZoom() { return Math.max(1, Math.log2(mapDimensions().width / 256)); }
function longitudeToWorld(lon) { return (Number(lon) + 180) / 360 * mapSize(); }
function latitudeToWorld(lat) {
  const limited = Math.max(-85.0511, Math.min(85.0511, Number(lat)));
  const rad = limited * Math.PI / 180;
  return (1 - Math.log(Math.tan(rad) + (1 / Math.cos(rad))) / Math.PI) / 2 * mapSize();
}
function worldToLongitude(x) { return x / mapSize() * 360 - 180; }
function worldToLatitude(y) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / mapSize()))) * 180 / Math.PI; }
function mapDimensions() {
  const rect = byId("worldMap").getBoundingClientRect();
  return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
}
function mapOrigin() {
  const { width, height } = mapDimensions();
  return { x: longitudeToWorld(mapState.centerLon) - width / 2, y: latitudeToWorld(mapState.centerLat) - height / 2 };
}
function projectWorld(lat, lon) {
  const origin = mapOrigin();
  const size = mapSize();
  const centerX = longitudeToWorld(mapState.centerLon);
  let x = longitudeToWorld(lon);
  x += Math.round((centerX - x) / size) * size;
  return { x: x - origin.x, y: latitudeToWorld(lat) - origin.y };
}

function worldPath(points) {
  const segments = [];
  let current = [];
  const threshold = mapSize() * .45;
  for (const point of points || []) {
    const projected = projectWorld(point.lat, point.lon);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) continue;
    if (current.length && Math.abs(projected.x - current[current.length - 1].x) > threshold) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(projected);
  }
  if (current.length > 1) segments.push(current);
  return segments.map((segment) => `M ${segment.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" L ")}`).join(" ");
}

function constrainMapCenter() {
  const { height } = mapDimensions();
  const size = mapSize();
  let y = latitudeToWorld(mapState.centerLat);
  y = size <= height ? size / 2 : Math.max(height / 2, Math.min(size - height / 2, y));
  mapState.centerLat = worldToLatitude(y);
}

function renderMapTiles() {
  constrainMapCenter();
  const layer = esriBasemaps[mapState.basemap] || esriBasemaps.terrain;
  const { width, height } = mapDimensions();
  const origin = mapOrigin();
  const tileLevel = Math.ceil(mapState.zoom - 1e-6);
  const tileScale = 2 ** (mapState.zoom - tileLevel);
  const tileSize = 256 * tileScale;
  const count = 2 ** tileLevel;
  const startX = Math.floor(origin.x / tileSize);
  const endX = Math.floor((origin.x + width - .01) / tileSize);
  const startY = Math.max(0, Math.floor(origin.y / tileSize));
  const endY = Math.min(count - 1, Math.floor((origin.y + height - .01) / tileSize));
  const tiles = [];
  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      const wrappedX = ((x % count) + count) % count;
      const src = layer.url.replace("{z}", tileLevel).replace("{y}", y).replace("{x}", wrappedX);
      tiles.push(`<img class="map-tile" alt="" src="${src}" style="width:${tileSize + .5}px;height:${tileSize + .5}px;left:${Math.round(x * tileSize - origin.x)}px;top:${Math.round(y * tileSize - origin.y)}px" />`);
    }
  }
  byId("mapTiles").innerHTML = tiles.join("");
  byId("mapAttribution").innerHTML = `${escapeHtml(layer.attribution)} · <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>`;
  document.querySelectorAll("[data-basemap]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.basemap === mapState.basemap)));
}

function satelliteName(satId) {
  return state.availableSatellites.find((sat) => sat.sat_id === satId)?.name || state.passes.find((pass) => pass.sat_id === satId)?.name || satId;
}

function renderPlannerSettings() {
  const settings = state.plannerSettings || { startup_sat_id: "iss-zarya", map_sat_ids: ["iss-zarya"] };
  const options = state.availableSatellites.map((sat) => `<option value="${escapeHtml(sat.sat_id)}">${escapeHtml(sat.name)}</option>`).join("");
  byId("startupSatellite").innerHTML = options;
  byId("startupSatellite").value = settings.startup_sat_id;
  const selected = settings.map_sat_ids || [];
  byId("mapSatelliteChoices").innerHTML = selected.map((satId, index) => `<label class="map-choice"><input type="checkbox" checked data-map-sat="${escapeHtml(satId)}" ${satId === settings.startup_sat_id ? "disabled" : ""}/><i style="background:${mapColors[index % mapColors.length]}"></i><span>${escapeHtml(satelliteName(satId))}${satId === settings.startup_sat_id ? " · startup" : ""}</span></label>`).join("");
  byId("addMapSatellite").innerHTML = '<option value="">Add satellite track…</option>' + state.availableSatellites.filter((sat) => !selected.includes(sat.sat_id)).map((sat) => `<option value="${escapeHtml(sat.sat_id)}">${escapeHtml(sat.name)}</option>`).join("");
  byId("addMapSatellite").disabled = selected.length >= 5;
}

function nearestTrackPoint(items, timestamp, toleranceMs = 180000) {
  const target = asDate(timestamp)?.getTime();
  if (!finite(target) || !items?.length) return null;
  let nearest = null;
  for (const item of items) {
    const delta = Math.abs(asDate(item.timestamp)?.getTime() - target);
    if (!nearest || delta < nearest.delta) nearest = { item, delta };
  }
  return nearest && nearest.delta <= toleranceMs ? nearest.item : null;
}

function footprintPoints(track) {
  if (!finite(track?.subpoint_lat) || !finite(track?.subpoint_lon)) return [];
  const altitude = Math.max(120, Number(track.altitude_km || 500));
  const angular = Math.acos(6371 / (6371 + altitude));
  const lat1 = Number(track.subpoint_lat) * Math.PI / 180;
  const lon1 = Number(track.subpoint_lon) * Math.PI / 180;
  return [...Array(73)].map((_, index) => {
    const bearing = index / 72 * Math.PI * 2;
    const lat = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
    const lon = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat));
    return { lat: lat * 180 / Math.PI, lon: ((lon * 180 / Math.PI + 540) % 360) - 180 };
  });
}

function solarGeometry() {
  const days = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const meanAnomaly = (357.529 + .98560028 * days) * Math.PI / 180;
  const meanLongitude = (280.459 + .98564736 * days) * Math.PI / 180;
  const eclipticLongitude = meanLongitude + (1.915 * Math.sin(meanAnomaly) + .020 * Math.sin(2 * meanAnomaly)) * Math.PI / 180;
  const obliquity = (23.439 - .00000036 * days) * Math.PI / 180;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude)) * 180 / Math.PI;
  const sidereal = (280.46061837 + 360.98564736629 * days) % 360;
  return { declination, subsolarLon: ((rightAscension - sidereal + 540) % 360) - 180 };
}

function renderLighting() {
  const solar = solarGeometry();
  const startLon = mapState.centerLon - 179.8;
  const samples = [...Array(181)].map((_, index) => {
    const lon = startLon + index * 2;
    const physicalLon = ((lon + 540) % 360) - 180;
    const delta = (physicalLon - solar.subsolarLon) * Math.PI / 180;
    const lat = Math.atan(-Math.cos(delta) / Math.tan(solar.declination || .000001)) * 180 / Math.PI;
    return { lat, lon };
  });
  const line = samples.map((point) => projectWorld(point.lat, point.lon));
  const nightLat = solar.declination > 0 ? -85 : 85;
  const pole = [projectWorld(nightLat, startLon + 360), projectWorld(nightLat, startLon)];
  const lineD = `M ${line.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" L ")}`;
  const nightD = `${lineD} L ${pole[0].x.toFixed(1)} ${pole[0].y.toFixed(1)} L ${pole[1].x.toFixed(1)} ${pole[1].y.toFixed(1)} Z`;
  byId("worldLighting").innerHTML = `<path class="world-night" d="${nightD}"></path><path class="world-terminator" d="${lineD}"></path>`;
}

function renderMapFocusCard() {
  const satId = state.mapSelectedSatId || state.plannerSettings?.startup_sat_id;
  const track = (state.system?.tracks || []).find((item) => item.sat_id === satId);
  const nextPass = state.passes.find((item) => item.sat_id === satId && (asDate(item.los)?.getTime() || 0) > Date.now());
  if (!satId) { byId("mapFocusCard").innerHTML = ""; return; }
  byId("mapFocusCard").innerHTML = `<span class="eyebrow">Map focus</span><h3>${escapeHtml(satelliteName(satId))}</h3><p>${nextPass ? `Next opportunity at ${time(nextPass.aos)} · peak ${number(nextPass.max_el_deg, 1, "°")}` : "No qualifying pass in this planning window."}</p><div class="map-focus-metrics"><span>Position<strong>${number(track?.subpoint_lat, 1, "°")}, ${number(track?.subpoint_lon, 1, "°")}</strong></span><span>Altitude<strong>${number(track?.altitude_km, 0, " km")}</strong></span></div><button class="button" type="button" data-view="operate">Open in Operate</button>`;
}

function renderWorldMap() {
  const selected = state.plannerSettings?.map_sat_ids || ["iss-zarya"];
  const visible = selected.filter((satId) => !state.mapHiddenSatIds.has(satId));
  const { width, height } = mapDimensions();
  const minimumZoom = minimumMapZoom();
  if (!mapState.initialized) {
    mapState.zoom = minimumZoom;
    mapState.centerLat = 0;
    mapState.centerLon = 0;
    mapState.initialized = true;
  } else if (mapState.zoom < minimumZoom) mapState.zoom = minimumZoom;
  byId("mapFallback").setAttribute("viewBox", `0 0 ${width} ${height}`);
  byId("mapOverlay").setAttribute("viewBox", `0 0 ${width} ${height}`);
  byId("mapFallback").querySelector("rect").setAttribute("width", width);
  byId("mapFallback").querySelector("rect").setAttribute("height", height);
  const longitudeLines = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150].map((lon) => worldPath([{ lat: -85, lon }, { lat: 85, lon }]));
  const latitudeLines = [-60, -30, 0, 30, 60].map((lat) => worldPath([...Array(37)].map((_, index) => ({ lat, lon: -180 + index * 10 }))));
  byId("worldGrid").innerHTML = [...longitudeLines, ...latitudeLines].map((path) => `<path class="world-grid-line" d="${path}"></path>`).join("");
  byId("worldLand").innerHTML = (window.TRACKER_HEMISPHERE_LAND || []).map((ring) => `<path class="world-land" d="${worldPath(ring.map(([lon, lat]) => ({ lat, lon })))}"></path>`).join("");
  const tracks = state.system?.tracks || [];
  const now = Date.now();
  byId("worldTracks").innerHTML = visible.map((satId) => {
    const index = selected.indexOf(satId);
    const items = state.mapPaths[satId] || [];
    let split = items.findIndex((item) => (asDate(item.timestamp)?.getTime() || 0) >= now);
    if (split < 0) split = items.length;
    const past = items.slice(0, Math.min(items.length, split + 1));
    const future = items.slice(Math.max(0, split));
    const color = mapColors[index % mapColors.length];
    return `<path class="world-track world-track-past" stroke="${color}" d="${worldPath(past.map((item) => ({ lat: item.subpoint_lat, lon: item.subpoint_lon })))}"></path><path class="world-track world-track-future" stroke="${color}" d="${worldPath(future.map((item) => ({ lat: item.subpoint_lat, lon: item.subpoint_lon })))}"></path>`;
  }).join("");
  byId("worldFootprints").innerHTML = visible.map((satId) => {
    const index = selected.indexOf(satId);
    const track = tracks.find((item) => item.sat_id === satId);
    const points = footprintPoints(track);
    return points.length ? `<path class="world-footprint" fill="${mapColors[index % mapColors.length]}" stroke="${mapColors[index % mapColors.length]}" d="${worldPath(points)} Z"></path>` : "";
  }).join("");
  const eventLabels = [["A", "aos"], ["T", "tca"], ["L", "los"]];
  byId("worldEvents").innerHTML = visible.map((satId) => {
    const index = selected.indexOf(satId);
    const items = state.mapPaths[satId] || [];
    const pass = state.passes.find((item) => item.sat_id === satId && (asDate(item.los)?.getTime() || 0) > now);
    if (!pass) return "";
    return eventLabels.map(([label, field]) => {
      const item = nearestTrackPoint(items, pass[field]);
      if (!item) return "";
      const point = projectWorld(item.subpoint_lat, item.subpoint_lon);
      const color = mapColors[index % mapColors.length];
      return `<g class="world-event"><circle stroke="${color}" cx="${point.x}" cy="${point.y}" r="5"></circle><text x="${point.x + 8}" y="${point.y - 7}">${label}</text></g>`;
    }).join("");
  }).join("");
  const markers = visible.map((satId) => {
    const index = selected.indexOf(satId);
    const track = tracks.find((item) => item.sat_id === satId);
    if (!finite(track?.subpoint_lat) || !finite(track?.subpoint_lon)) return "";
    const point = projectWorld(track.subpoint_lat, track.subpoint_lon);
    const color = mapColors[index % mapColors.length];
    const labelOnLeft = point.x > width - 130;
    return `<g><circle class="world-marker-halo" fill="${color}" cx="${point.x}" cy="${point.y}" r="16"></circle><circle class="world-marker" fill="${color}" cx="${point.x}" cy="${point.y}" r="6"></circle><circle class="satellite-map-hit" role="button" tabindex="0" aria-label="Focus ${escapeHtml(satelliteName(satId))}" data-map-focus="${escapeHtml(satId)}" cx="${point.x}" cy="${point.y}" r="18"></circle><text class="world-label" x="${point.x + (labelOnLeft ? -11 : 11)}" y="${point.y - 9}" text-anchor="${labelOnLeft ? "end" : "start"}">${escapeHtml(satelliteName(satId))}</text></g>`;
  }).join("");
  const location = state.system?.location;
  let station = "";
  if (finite(location?.lat) && finite(location?.lon)) {
    const point = projectWorld(location.lat, location.lon);
    station = `<path class="station-marker" transform="translate(${point.x} ${point.y})" d="M 0 -8 L 7 6 L 0 3 L -7 6 Z"></path>`;
  }
  byId("worldMarkers").innerHTML = markers + station;
  byId("mapLegend").innerHTML = selected.map((satId, index) => `<button type="button" data-map-legend="${escapeHtml(satId)}" aria-pressed="${String(!state.mapHiddenSatIds.has(satId))}"><i style="background:${mapColors[index % mapColors.length]}"></i>${escapeHtml(satelliteName(satId))}</button>`).join("") + '<span><i style="background:var(--attention)"></i>Your station</span>';
  renderLighting();
  renderMapFocusCard();
  renderMapTiles();
}

async function loadMapTracks() {
  const selected = state.plannerSettings?.map_sat_ids || ["iss-zarya"];
  const missing = selected.filter((satId) => !state.mapPaths[satId]);
  if (missing.length) {
    const now = new Date();
    const pastStart = new Date(now.getTime() - 90 * 60000).toISOString();
    const nowIso = now.toISOString();
    const results = await Promise.all(missing.map(async (satId) => {
      const encoded = encodeURIComponent(satId);
      const [past, future] = await Promise.all([
        api(`/api/v1/track/path?sat_id=${encoded}&minutes=90&step_seconds=90&start_time=${encodeURIComponent(pastStart)}`),
        api(`/api/v1/track/path?sat_id=${encoded}&minutes=240&step_seconds=90&start_time=${encodeURIComponent(nowIso)}`),
      ]);
      return [...(past.items || []), ...(future.items || []).slice(1)];
    }));
    results.forEach((items, index) => { state.mapPaths[missing[index]] = items; });
  }
  renderWorldMap();
}

async function savePlannerSettings(startupSatId, mapSatIds) {
  const payload = await post("/api/v1/settings/planner", { startup_sat_id: startupSatId, map_sat_ids: mapSatIds });
  state.plannerSettings = payload.state;
  if (!state.mapSelectedSatId || !payload.state.map_sat_ids.includes(state.mapSelectedSatId)) state.mapSelectedSatId = payload.state.startup_sat_id;
  state.mapPaths = {};
  renderPlannerSettings();
  await loadMapTracks();
}

function renderActivity() {
  const runtime = state.aprs?.runtime || state.system?.aprsRuntime || {};
  const radio = state.system?.radioRuntime || {};
  const error = runtime.last_error || radio.last_error;
  const packets = state.aprsLog.slice(0, 8);
  byId("activityContent").innerHTML = `
    <div class="activity-card"><span>APRS state</span><strong>${runtime.connected ? "Connected" : "Disconnected"}</strong></div>
    <div class="activity-card"><span>Packets</span><strong>${Number(runtime.packets_rx || 0)} RX / ${Number(runtime.packets_tx || 0)} TX</strong></div>
    <div class="activity-card"><span>Radio</span><strong>${labelize(radio.control_mode)}</strong></div>
    <div class="activity-card wide"><span>Latest operator-visible issue</span><strong>${escapeHtml(error || "No current error")}</strong></div>
    <div class="activity-card wide activity-packets"><div class="section-heading"><h2>Recent APRS traffic</h2><a href="/aprs">Full console</a></div>${packets.length ? packets.map((packet) => `<div class="activity-packet"><strong>${escapeHtml(packet.source || "Unknown")}</strong><span>${escapeHtml(labelize(packet.packet_type))} · ${activityTime(packet.received_at)}</span><p>${escapeHtml(packet.text || packet.raw_tnc2 || "Packet received")}</p></div>`).join("") : '<p>No stored packet activity.</p>'}</div>`;
}

function healthRow(label, ok, detail) {
  return `<div class="health-row ${ok ? "ready" : "attention"}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(detail)}</strong></div>`;
}

function syncLocationFields() {
  const mode = byId("stationLocationMode").value;
  document.querySelectorAll("[data-manual-location]").forEach((field) => field.classList.toggle("hidden", mode !== "manual"));
}

function fillLocationProfile() {
  const location = state.stationSettings?.location;
  if (!location) return;
  const id = byId("stationLocationProfile").value;
  const profile = (location.state?.profiles || []).find((item) => item.id === id);
  const point = profile?.point || location.resolved || {};
  byId("stationLocationName").value = profile?.name || "";
  byId("stationLatitude").value = finite(point.lat) ? Number(point.lat).toFixed(6) : "";
  byId("stationLongitude").value = finite(point.lon) ? Number(point.lon).toFixed(6) : "";
  byId("stationAltitude").value = finite(point.alt_m) ? Number(point.alt_m).toFixed(0) : 0;
}

function renderSettings() {
  const view = byId("settingsView");
  const editing = view.contains(document.activeElement) && document.activeElement.matches("input, select");
  if (editing || !state.stationSettings) return;
  const system = state.system || {};
  const identity = system.stationIdentity || {};
  const aprsSettings = state.aprs?.settings || system.aprsSettings || {};
  const location = state.stationSettings.location;
  const locationState = location.state || {};
  const profiles = locationState.profiles || [];
  byId("stationCallsign").value = aprsSettings.callsign || "";
  byId("stationSsid").value = Number(aprsSettings.ssid ?? 0);
  byId("identityHealth").textContent = identity.configured ? identity.callsign : "Not configured";
  byId("stationLocationMode").value = locationState.source_mode || "auto";
  const selectedProfile = locationState.selected_profile_id || profiles[0]?.id || "__new";
  byId("stationLocationProfile").innerHTML = profiles.map((profile) => `<option value="${escapeHtml(profile.id)}"${profile.id === selectedProfile ? " selected" : ""}>${escapeHtml(profile.name)}</option>`).join("") + `<option value="__new"${selectedProfile === "__new" ? " selected" : ""}>Add new location…</option>`;
  byId("locationHealth").textContent = window.issTracker.describeLocation(location.resolved);
  syncLocationFields();
  fillLocationProfile();
  const timezone = state.stationSettings.timezone?.timezone || "BrowserLocal";
  const timezones = ["BrowserLocal", ...new Set(state.stationSettings.timezones?.timezones || [])];
  byId("stationTimezone").innerHTML = timezones.map((item) => `<option value="${escapeHtml(item)}"${item === timezone ? " selected" : ""}>${escapeHtml(item === "BrowserLocal" ? "This device timezone" : item)}</option>`).join("");

  const stamp = asDate(system.timestamp);
  const dataAge = stamp ? Date.now() - stamp.getTime() : Infinity;
  const network = system.network || {};
  const radio = system.radioRuntime || {};
  const aprs = state.aprs?.runtime || system.aprsRuntime || {};
  const locationOk = finite(location.resolved?.lat) && finite(location.resolved?.lon) && !(Number(location.resolved.lat) === 0 && Number(location.resolved.lon) === 0 && location.resolved.source === "default");
  const health = [
    ["Station identity", !!identity.configured, identity.callsign || identity.reason || "Required"],
    ["Location", locationOk, locationOk ? `${number(location.resolved.lat, 3)}, ${number(location.resolved.lon, 3)}` : "No resolved station location"],
    ["Live state", dataAge < 60000, dataAge < Infinity ? `${duration(dataAge)} old` : "Unavailable"],
    ["Internet", !!network.internet_available, network.internet_available ? "Available" : "Offline or unchecked"],
    ["Radio", !radio.last_error, radio.last_error || (radio.connected ? `${rigLabel(radio.rig_model)} connected` : "Configured, disconnected")],
    ["APRS", !aprs.last_error, aprs.last_error || (aprs.connected ? "Connected" : "Configured, disconnected")],
  ];
  byId("stationHealthList").innerHTML = health.map((item) => healthRow(...item)).join("");
  const issueCount = health.filter((item) => !item[1]).length;
  byId("overallHealth").textContent = issueCount ? `${issueCount} need attention` : "Ready";
  byId("overallHealth").className = issueCount ? "attention-text" : "ready-text";

  const cache = state.stationSettings.cache || {};
  const latest = cache.snapshots?.[0];
  byId("dataHealthList").innerHTML = [
    healthRow("Last external refresh", !!latest, latest ? `${labelize(latest.source)} · ${activityTime(latest.created_at)}` : "No refresh recorded"),
    healthRow("Refresh snapshot", !!latest?.satellite_count, latest ? `${latest.satellite_count} satellites` : "Not recorded"),
    healthRow("Stale threshold", true, `${cache.state?.stale_after_hours ?? 24} hours`),
    healthRow("Retention", true, `${cache.state?.retention_days ?? 30} days · ${cache.state?.max_storage_mb ?? 512} MB`),
  ].join("");
}

async function loadStationSettings(force = false) {
  if (state.stationSettings && !force) { renderSettings(); return; }
  try {
    const [location, cache, timezone, timezones] = await Promise.all([
      api("/api/v1/location"),
      api("/api/v1/cache-policy"),
      api("/api/v1/settings/timezone"),
      api("/api/v1/settings/timezones"),
    ]);
    state.stationSettings = { location, cache, timezone, timezones };
    renderSettings();
  } catch (error) {
    showNotice(`Unable to load station settings: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

function render() {
  renderStationBar();
  renderOperate();
  renderPasses();
  renderActivity();
  renderSettings();
  renderPlannerSettings();
  if (state.plannerView === "map") renderWorldMap();
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll("[data-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.panel !== view));
  document.querySelectorAll("[data-view]").forEach((control) => {
    if (control.dataset.view === view) control.setAttribute("aria-current", "page");
    else control.removeAttribute("aria-current");
  });
}

async function switchPlannerView(view) {
  state.plannerView = view;
  byId("timelinePlanner").classList.toggle("hidden", view !== "timeline");
  byId("mapPlanner").classList.toggle("hidden", view !== "map");
  document.querySelectorAll("[data-planner-view]").forEach((control) => control.setAttribute("aria-selected", String(control.dataset.plannerView === view)));
  if (view === "map") {
    try { await loadMapTracks(); } catch (error) { showNotice(`Unable to load ground tracks: ${error instanceof Error ? error.message : String(error)}`, true); }
  }
}

async function selectFocusedSession(pass) {
  return post("/api/v1/radio/session/select", { sat_id: pass.sat_id, sat_name: pass.name, pass_aos: pass.aos, pass_los: pass.los, max_el_deg: pass.max_el_deg });
}

async function runPrimaryAction() {
  const button = byId("primaryAction");
  if (button.dataset.href) {
    window.location.href = button.dataset.href;
    return;
  }
  const pass = passForFocus();
  if (!pass || !button.dataset.action) return;
  state.busy = true;
  renderOperate();
  try {
    if (button.dataset.action === "prepare") {
      await selectFocusedSession(pass);
      showNotice("Pass session prepared. Check the channel pair, then connect the radio.");
    } else if (button.dataset.action === "connect") {
      await post("/api/v1/radio/connect");
      showNotice("Radio connected. Test control before arming the pass.");
    } else if (button.dataset.action === "test") {
      await post("/api/v1/radio/session/test");
      showNotice("Test frequencies applied. Confirm what the rig displays.");
    } else if (button.dataset.action === "confirm") {
      await post("/api/v1/radio/session/test/confirm");
      showNotice("Radio test confirmed and the prior rig state restored.");
    } else if (button.dataset.action === "start") {
      await post("/api/v1/radio/session/start");
      showNotice(passPhase(pass) === "upcoming" ? "Pass armed. Tracking will begin at AOS." : "Doppler tracking started.");
    }
    await refreshData(false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  } finally {
    state.busy = false;
    renderOperate();
  }
}

async function applyChannelPair() {
  const pass = passForFocus();
  const choice = channelChoices(pass).find((item) => item.key === byId("channelPairSelect").value);
  if (!pass || !choice) return;
  state.busy = true;
  renderOperate();
  try {
    const session = state.system?.radioControlSession || {};
    const focused = session.active && session.selected_sat_id === pass.sat_id && (!session.selected_pass_aos || session.selected_pass_aos === pass.aos);
    if (!focused) await selectFocusedSession(pass);
    await post("/api/v1/radio/session/test-pair", {
      uplink_hz: finite(choice.uplink_mhz) ? Math.round(Number(choice.uplink_mhz) * 1_000_000) : null,
      downlink_hz: finite(choice.downlink_mhz) ? Math.round(Number(choice.downlink_mhz) * 1_000_000) : null,
      uplink_mode: choice.uplink_mode || null,
      downlink_mode: choice.downlink_mode || null,
      label: choice.label,
    });
    state.channelSelection[pass.sat_id] = choice.key;
    showNotice(`${choice.label} selected for the radio test.`);
    await refreshData(false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  } finally {
    state.busy = false;
    renderOperate();
  }
}

async function stopControl() {
  state.busy = true;
  renderOperate();
  try {
    await post("/api/v1/radio/session/stop");
    showNotice("Radio control stopped and the prior rig state was restored.");
    await refreshData(false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  } finally {
    state.busy = false;
    renderOperate();
  }
}

async function releaseSession() {
  state.busy = true;
  renderOperate();
  try {
    await post("/api/v1/radio/session/clear");
    showNotice("Pass session released. Any captured rig state was restored.");
    await refreshData(false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  } finally {
    state.busy = false;
    renderOperate();
  }
}

async function selectAprsTarget(value) {
  const [satId, channelId] = String(value || "").split("|");
  if (!satId || !channelId) return;
  try {
    await post("/api/v1/aprs/select-target", { operating_mode: "satellite", sat_id: satId, channel_id: channelId });
    showNotice("Satellite APRS target selected.");
    await refreshData(false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function runAprsAction(action) {
  state.busy = true;
  renderOperate();
  try {
    const endpoint = { connect: "/api/v1/aprs/connect", disconnect: "/api/v1/aprs/disconnect", emergency: "/api/v1/aprs/emergency-stop" }[action];
    if (!endpoint) return;
    await post(endpoint);
    showNotice(action === "connect" ? "Satellite APRS connected and listening." : action === "emergency" ? "APRS stopped immediately." : "APRS disconnected.");
    await refreshData(false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  } finally {
    state.busy = false;
    renderOperate();
  }
}

async function sendAprsPacket(kind) {
  const payload = kind === "message"
    ? { to: state.aprsDrafts.to.trim(), text: state.aprsDrafts.message.trim() }
    : kind === "status"
      ? { text: state.aprsDrafts.status.trim() }
      : { comment: state.aprsDrafts.position.trim() };
  if ((kind === "message" && (!payload.to || !payload.text)) || (kind === "status" && !payload.text)) {
    showNotice("Complete the APRS fields before sending.", true);
    return;
  }
  const authorized = await txAuthorization.authorize({ capability: `aprs-${kind}` });
  if (!authorized) return;
  state.busy = true;
  try {
    await post(`/api/v1/aprs/send/${kind}`, payload);
    if (kind === "message") { state.aprsDrafts.to = ""; state.aprsDrafts.message = ""; }
    else if (kind === "status") state.aprsDrafts.status = "";
    else state.aprsDrafts.position = "";
    showNotice(`APRS ${kind} sent.`);
    await refreshData(false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  } finally {
    state.busy = false;
    renderOperate();
  }
}

async function saveStationIdentity(event) {
  event.preventDefault();
  const callsign = byId("stationCallsign").value.trim().toUpperCase();
  const ssid = Number(byId("stationSsid").value);
  if (!callsign || !Number.isInteger(ssid) || ssid < 0 || ssid > 15) {
    showNotice("Enter a callsign and an APRS SSID from 0 to 15.", true);
    return;
  }
  try {
    await post("/api/v1/settings/aprs", { callsign, ssid });
    showNotice("Station identity saved on OrbitDeck.");
    await refreshData(false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function saveStationLocation(event) {
  event.preventDefault();
  const mode = byId("stationLocationMode").value;
  const payload = { source_mode: mode };
  if (mode === "manual") {
    const lat = byId("stationLatitude").value.trim() ? Number(byId("stationLatitude").value) : NaN;
    const lon = byId("stationLongitude").value.trim() ? Number(byId("stationLongitude").value) : NaN;
    const alt = Number(byId("stationAltitude").value || 0);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      showNotice("Enter valid latitude and longitude values.", true);
      return;
    }
    const selected = byId("stationLocationProfile").value;
    const id = selected && selected !== "__new" ? selected : `station-${Date.now()}`;
    const name = byId("stationLocationName").value.trim() || "Station location";
    payload.selected_profile_id = id;
    payload.add_profile = { id, name, point: { lat, lon, alt_m: alt } };
  }
  try {
    await post("/api/v1/location", payload);
    showNotice("Station location source saved.");
    await loadStationSettings(true);
    await refreshData(false);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function useDeviceLocation() {
  byId("useDeviceLocation").disabled = true;
  try {
    await window.issTracker.setBrowserLocation();
    showNotice("Observer location updated. The radio-control device supplies the station fallback.");
    await loadStationSettings(true);
    await refreshData(false);
  } catch (error) {
    showNotice(error.message || "Device location was unavailable.", true);
  } finally {
    byId("useDeviceLocation").disabled = false;
  }
}

async function saveStationTimezone(event) {
  event.preventDefault();
  try {
    const payload = await post("/api/v1/settings/timezone", { timezone: byId("stationTimezone").value });
    state.stationSettings.timezone = payload;
    showNotice("Display timezone saved.");
    renderSettings();
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

function radioTransportVisibility() {
  const wifi = byId("radioTransport").value === "wifi";
  document.querySelectorAll("[data-radio-wifi]").forEach((field) => field.classList.toggle("hidden", !wifi));
  document.querySelectorAll("[data-radio-usb]").forEach((field) => field.classList.toggle("hidden", wifi));
  if (wifi && byId("radioRig").value !== "ic705") byId("radioRig").value = "ic705";
}

function populateRadioForm() {
  const settings = state.system?.radioSettings || {};
  byId("radioRig").value = settings.rig_model || "id5100";
  byId("radioTransport").value = settings.transport_mode || "usb";
  const serial = settings.serial_device || "";
  const portItems = [...state.radioPorts];
  if (serial && !portItems.some((item) => item.device === serial)) portItems.unshift({ device: serial, description: "Configured device" });
  byId("radioSerial").innerHTML = '<option value="">Choose a serial port…</option>' + portItems.map((item) => `<option value="${escapeHtml(item.device)}"${item.device === serial ? " selected" : ""}>${escapeHtml(item.device)}${item.description ? ` · ${escapeHtml(item.description)}` : ""}</option>`).join("");
  byId("radioBaud").value = String(settings.baud_rate || 9600);
  byId("radioWifiHost").value = settings.wifi_host || "";
  byId("radioWifiPort").value = settings.wifi_control_port || 50001;
  byId("radioWifiUser").value = settings.wifi_username || "";
  byId("radioWifiPassword").value = "";
  byId("radioCiv").value = settings.civ_address || (settings.rig_model === "ic705" ? "0xA4" : "0x8C");
  byId("radioPoll").value = settings.poll_interval_ms || 1000;
  byId("radioTrack").value = settings.auto_track_interval_ms || 1000;
  byId("radioEnabled").checked = settings.enabled !== false;
  byId("radioAutoConnect").checked = !!settings.auto_connect;
  byId("radioApplyMode").checked = settings.default_apply_mode_and_tone !== false;
  byId("radioSafeGuard").checked = settings.safe_tx_guard_enabled !== false;
  byId("radioSetupStatus").textContent = state.system?.radioRuntime?.connected ? "Radio is currently connected. Saving updates the stored profile for the next connection." : "";
  byId("radioSetupStatus").classList.remove("error");
  radioTransportVisibility();
}

async function openRadioSetup() {
  const dialog = byId("radioSetupDialog");
  try {
    const ports = await api("/api/v1/radio/ports");
    state.radioPorts = Array.isArray(ports.items) ? ports.items : [];
  } catch (error) {
    state.radioPorts = [];
  }
  populateRadioForm();
  dialog.showModal();
}

async function saveRadioProfile(event) {
  event.preventDefault();
  const status = byId("radioSetupStatus");
  const connectAfterSave = event.submitter?.value === "connect";
  const payload = {
    enabled: byId("radioEnabled").checked,
    rig_model: byId("radioRig").value,
    transport_mode: byId("radioTransport").value,
    serial_device: byId("radioSerial").value || null,
    baud_rate: Number(byId("radioBaud").value),
    civ_address: byId("radioCiv").value.trim(),
    wifi_host: byId("radioWifiHost").value.trim() || null,
    wifi_username: byId("radioWifiUser").value.trim() || null,
    wifi_control_port: Number(byId("radioWifiPort").value),
    poll_interval_ms: Number(byId("radioPoll").value),
    auto_connect: byId("radioAutoConnect").checked,
    auto_track_interval_ms: Number(byId("radioTrack").value),
    default_apply_mode_and_tone: byId("radioApplyMode").checked,
    safe_tx_guard_enabled: byId("radioSafeGuard").checked,
  };
  const password = byId("radioWifiPassword").value;
  if (password) payload.wifi_password = password;
  status.textContent = connectAfterSave ? "Saving and connecting…" : "Saving…";
  status.classList.remove("error");
  try {
    await post("/api/v1/settings/radio", payload);
    if (connectAfterSave) await post("/api/v1/radio/connect");
    await refreshData(false);
    byId("radioSetupDialog").close();
    showNotice(connectAfterSave ? "Radio profile saved and connected." : "Radio profile saved on OrbitDeck.");
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    status.classList.add("error");
  }
}

async function refreshData(showErrors = true) {
  try {
    const hours = Number(byId("passWindow")?.value || 24);
    const [system, passes, aprs, planner, aprsTargets, aprsLog] = await Promise.all([
      api(`/api/v1/system/state${state.selectedPass ? `?sat_id=${encodeURIComponent(state.selectedPass.sat_id)}` : ""}`),
      api(`/api/v1/passes?hours=${hours}&include_ongoing=true`),
      api("/api/v1/aprs/state"),
      api("/api/v1/settings/planner"),
      state.aprsTargets ? Promise.resolve(state.aprsTargets) : api("/api/v1/aprs/targets"),
      api("/api/v1/aprs/log?limit=12"),
    ]);
    const positionKey = (location) => JSON.stringify([location?.source, location?.lat, location?.lon, location?.alt_m]);
    if (positionKey(state.system?.location) !== positionKey(system.location)) {
      state.mapPaths = {};
      state.selectedPass = null;
    }
    state.system = system;
    state.passes = Array.isArray(passes.items) ? passes.items : [];
    state.aprs = aprs;
    state.aprsTargets = aprsTargets;
    state.aprsLog = Array.isArray(aprsLog.items) ? aprsLog.items : [];
    state.plannerSettings = planner.state;
    state.availableSatellites = planner.availableSatellites || [];
    if (!state.mapSelectedSatId) state.mapSelectedSatId = state.plannerSettings?.startup_sat_id || "iss-zarya";
    if (!state.selectedPass) state.selectedPass = state.passes.find((item) => item.sat_id === state.plannerSettings?.startup_sat_id) || null;
    if (state.selectedPass) state.selectedPass = state.passes.find((item) => item.sat_id === state.selectedPass.sat_id && item.aos === state.selectedPass.aos) || state.selectedPass;
    render();
  } catch (error) {
    if (showErrors) showNotice(`Unable to refresh station state: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

document.addEventListener("click", async (event) => {
  const view = event.target.closest("[data-view]");
  if (view) {
    switchView(view.dataset.view);
    if (view.dataset.view === "settings") await loadStationSettings();
  }

  const plannerView = event.target.closest("[data-planner-view]");
  if (plannerView) await switchPlannerView(plannerView.dataset.plannerView);

  const basemap = event.target.closest("[data-basemap]");
  if (basemap) {
    mapState.basemap = basemap.dataset.basemap;
    localStorage.setItem("orbitdeck.basemap", mapState.basemap);
    renderWorldMap();
  }

  const legend = event.target.closest("[data-map-legend]");
  if (legend) {
    const satId = legend.dataset.mapLegend;
    if (state.mapHiddenSatIds.has(satId)) state.mapHiddenSatIds.delete(satId);
    else state.mapHiddenSatIds.add(satId);
    renderWorldMap();
  }

  const mapFocus = event.target.closest("[data-map-focus]");
  if (mapFocus) {
    const satId = mapFocus.dataset.mapFocus;
    state.mapSelectedSatId = satId;
    state.selectedPass = state.passes.find((item) => item.sat_id === satId && (asDate(item.los)?.getTime() || 0) > Date.now()) || state.selectedPass;
    renderWorldMap();
    if (state.selectedPass?.sat_id === satId) await refreshData(false);
  }

  const context = event.target.closest("[data-context]");
  if (context) {
    state.context = context.dataset.context;
    document.querySelectorAll("[data-context][role='tab']").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.context === state.context)));
    renderContext();
    if (context.hasAttribute("data-scroll-context")) byId("contextContent").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const aprsAction = event.target.closest("[data-aprs-action]");
  if (aprsAction && !aprsAction.disabled) await runAprsAction(aprsAction.dataset.aprsAction);

  const aprsSend = event.target.closest("[data-aprs-send]");
  if (aprsSend && !aprsSend.disabled) await sendAprsPacket(aprsSend.dataset.aprsSend);

  if (event.target.closest("[data-open-radio]")) await openRadioSetup();
  if (event.target.closest("[data-close-radio]")) byId("radioSetupDialog").close();

  const passButton = event.target.closest("[data-pass-key], [data-focus-key]");
  if (passButton) {
    const key = passButton.dataset.passKey || passButton.dataset.focusKey;
    const [satId, aos] = key.split("|");
    state.selectedPass = state.passes.find((item) => item.sat_id === satId && item.aos === aos) || null;
    switchView("operate");
    await refreshData();
  }
});

document.addEventListener("change", async (event) => {
  if (event.target.id === "aprsTargetSelect") await selectAprsTarget(event.target.value);
});

document.addEventListener("input", (event) => {
  const draftKey = { aprsMessageTo: "to", aprsMessageText: "message", aprsStatusText: "status", aprsPositionComment: "position" }[event.target.id];
  if (draftKey) state.aprsDrafts[draftKey] = event.target.value;
});

document.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-focus-key], [data-map-focus]")) event.target.click();
});

["passSatellite", "passElevation", "passRadioOnly"].forEach((id) => byId(id).addEventListener("change", () => {
  state.passVisible = 12;
  renderPasses();
}));
byId("passWindow").addEventListener("change", async () => {
  state.passVisible = 12;
  await refreshData();
});
byId("showMorePasses").addEventListener("click", () => {
  state.passVisible += 12;
  renderPasses();
});
byId("startupSatellite").addEventListener("change", async (event) => {
  const startup = event.target.value;
  const selected = [...(state.plannerSettings?.map_sat_ids || [])].filter((id) => id !== startup);
  selected.unshift(startup);
  if (selected.length > 5) selected.pop();
  try { await savePlannerSettings(startup, selected); } catch (error) { showNotice(error instanceof Error ? error.message : String(error), true); }
});
byId("mapSatelliteChoices").addEventListener("change", async (event) => {
  const satId = event.target.dataset.mapSat;
  if (!satId || event.target.checked) return;
  const selected = (state.plannerSettings?.map_sat_ids || []).filter((id) => id !== satId);
  try { await savePlannerSettings(state.plannerSettings.startup_sat_id, selected); } catch (error) { showNotice(error instanceof Error ? error.message : String(error), true); }
});
byId("addMapSatellite").addEventListener("change", async (event) => {
  const satId = event.target.value;
  if (!satId) return;
  const selected = [...(state.plannerSettings?.map_sat_ids || []), satId];
  try { await savePlannerSettings(state.plannerSettings.startup_sat_id, selected); } catch (error) { showNotice(error instanceof Error ? error.message : String(error), true); }
});

function setMapZoom(zoom) {
  mapState.zoom = Math.max(minimumMapZoom(), Math.min(7, zoom));
  renderWorldMap();
}

byId("mapZoomIn").addEventListener("click", () => setMapZoom(mapState.zoom + 1));
byId("mapZoomOut").addEventListener("click", () => setMapZoom(mapState.zoom - 1));
byId("mapLocate").addEventListener("click", () => {
  const satId = state.mapSelectedSatId || state.plannerSettings?.startup_sat_id;
  const track = (state.system?.tracks || []).find((item) => item.sat_id === satId);
  if (!finite(track?.subpoint_lat) || !finite(track?.subpoint_lon)) return;
  mapState.centerLat = Number(track.subpoint_lat);
  mapState.centerLon = Number(track.subpoint_lon);
  mapState.zoom = Math.max(mapState.zoom, minimumMapZoom() + 1);
  renderWorldMap();
});
byId("mapReset").addEventListener("click", () => {
  mapState.zoom = minimumMapZoom();
  mapState.centerLat = 0;
  mapState.centerLon = 0;
  renderWorldMap();
});

const mapElement = byId("worldMap");
mapElement.addEventListener("wheel", (event) => {
  event.preventDefault();
  setMapZoom(mapState.zoom + (event.deltaY < 0 ? 1 : -1));
}, { passive: false });
mapElement.addEventListener("dblclick", (event) => {
  if (!event.target.closest("button, a, select, input")) setMapZoom(mapState.zoom + 1);
});
mapElement.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button, a, select, input")) return;
  mapElement.setPointerCapture(event.pointerId);
  mapElement.classList.add("dragging");
  mapState.drag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    centerX: longitudeToWorld(mapState.centerLon),
    centerY: latitudeToWorld(mapState.centerLat),
  };
});
mapElement.addEventListener("pointermove", (event) => {
  if (!mapState.drag || mapState.drag.pointerId !== event.pointerId) return;
  const x = mapState.drag.centerX - (event.clientX - mapState.drag.x);
  const y = mapState.drag.centerY - (event.clientY - mapState.drag.y);
  mapState.centerLon = worldToLongitude(x);
  mapState.centerLat = worldToLatitude(y);
  renderWorldMap();
});
function endMapDrag(event) {
  if (!mapState.drag || mapState.drag.pointerId !== event.pointerId) return;
  mapState.drag = null;
  mapElement.classList.remove("dragging");
}
mapElement.addEventListener("pointerup", endMapDrag);
mapElement.addEventListener("pointercancel", endMapDrag);
new ResizeObserver(() => { if (state.plannerView === "map") renderWorldMap(); }).observe(mapElement);

byId("primaryAction").addEventListener("click", runPrimaryAction);
byId("stopControl").addEventListener("click", stopControl);
byId("releaseSession").addEventListener("click", releaseSession);
byId("applyChannelPair").addEventListener("click", applyChannelPair);
byId("channelPairSelect").addEventListener("change", (event) => {
  const pass = passForFocus();
  if (pass) state.channelSelection[pass.sat_id] = event.target.value;
});
byId("radioSetupForm").addEventListener("submit", saveRadioProfile);
byId("stationIdentityForm").addEventListener("submit", saveStationIdentity);
byId("stationLocationForm").addEventListener("submit", saveStationLocation);
byId("stationTimeForm").addEventListener("submit", saveStationTimezone);
byId("useDeviceLocation").addEventListener("click", useDeviceLocation);
byId("stationLocationMode").addEventListener("change", syncLocationFields);
byId("stationLocationProfile").addEventListener("change", fillLocationProfile);
byId("radioTransport").addEventListener("change", radioTransportVisibility);
byId("radioRig").addEventListener("change", () => {
  if (byId("radioRig").value === "id5100" && byId("radioTransport").value === "wifi") byId("radioTransport").value = "usb";
  radioTransportVisibility();
});
byId("secondaryAction").addEventListener("click", async () => {
  if (state.system?.radioRuntime?.connected) {
    try {
      await post("/api/v1/radio/disconnect");
      await refreshData(false);
    } catch (error) { showNotice(error instanceof Error ? error.message : String(error), true); }
  } else {
    await openRadioSetup();
  }
});

function updateClock() {
  const now = new Date();
  byId("localClock").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  byId("clockZone").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
}

updateClock();
window.setInterval(updateClock, 1000);
refreshData();
window.setInterval(() => refreshData(false), 10000);

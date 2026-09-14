const state = {
  view: "operate",
  context: "radio",
  system: null,
  passes: [],
  selectedPass: null,
  aprs: null,
  plannerView: "timeline",
  plannerSettings: null,
  availableSatellites: [],
  mapPaths: {},
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
  const response = await fetch(path, options);
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
  const recommendation = recommendationFor(pass);
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
  byId("stopControl").disabled = state.busy || !session.active;
  byId("secondaryAction").textContent = radio.connected ? "Disconnect radio" : "Open radio setup";
  renderQueue();
  renderContext();
}

function renderContext() {
  const content = byId("contextContent");
  const system = state.system || {};
  if (state.context === "aprs") {
    const runtime = state.aprs?.runtime || system.aprsRuntime || {};
    const preview = state.aprs?.previewTarget || system.aprsPreviewTarget || {};
    content.innerHTML = `<h2>Satellite APRS</h2><p>${runtime.connected ? "Connected and ready for pass activity." : "Available without crowding the primary radio workflow."}</p>
      <div class="context-row"><span>Connection</span><strong>${runtime.connected ? "Connected" : "Disconnected"}</strong></div>
      <div class="context-row"><span>Target</span><strong>${escapeHtml(runtime.target?.label || preview.label || "—")}</strong></div>
      <div class="context-row"><span>Frequency</span><strong>${finite(preview.frequency_hz) ? `${(preview.frequency_hz / 1_000_000).toFixed(3)} MHz` : "—"}</strong></div>
      <div class="context-row"><span>Packets</span><strong>${Number(runtime.packets_rx || 0)} RX / ${Number(runtime.packets_tx || 0)} TX</strong></div>
      <div class="context-actions"><a class="button" href="/aprs">Open APRS controls</a></div>
      <div class="context-note">Transmit actions pass through one authorization boundary. Hardware-validated TX authentication can be connected later without restructuring this screen.</div>`;
  } else {
    const settings = system.radioSettings || {};
    const runtime = system.radioRuntime || {};
    const session = system.radioControlSession || {};
    content.innerHTML = `<h2>${escapeHtml(rigLabel(settings.rig_model))}</h2><p>${runtime.connected ? "Connected and reporting state." : "Use the pass workflow to connect and validate the configured radio."}</p>
      <div class="context-row"><span>Connection</span><strong>${runtime.connected ? "Connected" : "Disconnected"}</strong></div>
      <div class="context-row"><span>Transport</span><strong>${labelize(settings.transport_mode)}</strong></div>
      <div class="context-row"><span>Session</span><strong>${labelize(session.control_state)}</strong></div>
      <div class="context-row"><span>Restore policy</span><strong>Restore prior state</strong></div>
      <div class="context-actions"><a class="button" href="/radio">Open detailed radio controls</a></div>
      <div class="context-note">Advanced CI-V, transport, and pairing controls remain available without competing with the live pass.</div>`;
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
  return { x: longitudeToWorld(lon) - origin.x, y: latitudeToWorld(lat) - origin.y };
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
  const { width, height } = mapDimensions();
  const size = mapSize();
  let x = longitudeToWorld(mapState.centerLon);
  let y = latitudeToWorld(mapState.centerLat);
  x = size <= width ? size / 2 : Math.max(width / 2, Math.min(size - width / 2, x));
  y = size <= height ? size / 2 : Math.max(height / 2, Math.min(size - height / 2, y));
  mapState.centerLon = worldToLongitude(x);
  mapState.centerLat = worldToLatitude(y);
}

function renderMapTiles() {
  constrainMapCenter();
  const layer = esriBasemaps[mapState.basemap] || esriBasemaps.terrain;
  const { width, height } = mapDimensions();
  const origin = mapOrigin();
  const tileSize = 256;
  const count = 2 ** mapState.zoom;
  const startX = Math.floor(origin.x / tileSize);
  const endX = Math.floor((origin.x + width) / tileSize);
  const startY = Math.max(0, Math.floor(origin.y / tileSize));
  const endY = Math.min(count - 1, Math.floor((origin.y + height) / tileSize));
  const tiles = [];
  for (let y = startY; y <= endY; y += 1) {
    for (let x = Math.max(0, startX); x <= Math.min(count - 1, endX); x += 1) {
      const src = layer.url.replace("{z}", mapState.zoom).replace("{y}", y).replace("{x}", x);
      tiles.push(`<img class="map-tile" alt="" src="${src}" style="left:${Math.round(x * tileSize - origin.x)}px;top:${Math.round(y * tileSize - origin.y)}px" />`);
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

function renderWorldMap() {
  const selected = state.plannerSettings?.map_sat_ids || ["iss-zarya"];
  const { width, height } = mapDimensions();
  if (!mapState.initialized) {
    mapState.zoom = width >= 850 ? 2 : 1;
    mapState.initialized = true;
  }
  byId("mapFallback").setAttribute("viewBox", `0 0 ${width} ${height}`);
  byId("mapOverlay").setAttribute("viewBox", `0 0 ${width} ${height}`);
  byId("mapFallback").querySelector("rect").setAttribute("width", width);
  byId("mapFallback").querySelector("rect").setAttribute("height", height);
  const longitudeLines = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150].map((lon) => worldPath([{ lat: -85, lon }, { lat: 85, lon }]));
  const latitudeLines = [-60, -30, 0, 30, 60].map((lat) => worldPath([...Array(37)].map((_, index) => ({ lat, lon: -180 + index * 10 }))));
  byId("worldGrid").innerHTML = [...longitudeLines, ...latitudeLines].map((path) => `<path class="world-grid-line" d="${path}"></path>`).join("");
  byId("worldLand").innerHTML = (window.TRACKER_HEMISPHERE_LAND || []).map((ring) => `<path class="world-land" d="${worldPath(ring.map(([lon, lat]) => ({ lat, lon })))}"></path>`).join("");
  byId("worldTracks").innerHTML = selected.map((satId, index) => `<path class="world-track" stroke="${mapColors[index % mapColors.length]}" d="${worldPath((state.mapPaths[satId] || []).map((item) => ({ lat: item.subpoint_lat, lon: item.subpoint_lon })))}"></path>`).join("");
  const tracks = state.system?.tracks || [];
  const markers = selected.map((satId, index) => {
    const track = tracks.find((item) => item.sat_id === satId);
    if (!finite(track?.subpoint_lat) || !finite(track?.subpoint_lon)) return "";
    const point = projectWorld(track.subpoint_lat, track.subpoint_lon);
    const color = mapColors[index % mapColors.length];
    const labelOnLeft = point.x > width - 130;
    return `<g><circle class="world-marker-halo" fill="${color}" cx="${point.x}" cy="${point.y}" r="16"></circle><circle class="world-marker" fill="${color}" cx="${point.x}" cy="${point.y}" r="6"></circle><text class="world-label" x="${point.x + (labelOnLeft ? -11 : 11)}" y="${point.y - 9}" text-anchor="${labelOnLeft ? "end" : "start"}">${escapeHtml(satelliteName(satId))}</text></g>`;
  }).join("");
  const location = state.system?.location;
  let station = "";
  if (finite(location?.lat) && finite(location?.lon)) {
    const point = projectWorld(location.lat, location.lon);
    station = `<path class="station-marker" transform="translate(${point.x} ${point.y})" d="M 0 -8 L 7 6 L 0 3 L -7 6 Z"></path>`;
  }
  byId("worldMarkers").innerHTML = markers + station;
  byId("mapLegend").innerHTML = selected.map((satId, index) => `<span><i style="background:${mapColors[index % mapColors.length]}"></i>${escapeHtml(satelliteName(satId))}</span>`).join("") + '<span><i style="background:var(--attention)"></i>Your station</span>';
  renderMapTiles();
}

async function loadMapTracks() {
  const selected = state.plannerSettings?.map_sat_ids || ["iss-zarya"];
  const missing = selected.filter((satId) => !state.mapPaths[satId]);
  if (missing.length) {
    const results = await Promise.all(missing.map((satId) => api(`/api/v1/track/path?sat_id=${encodeURIComponent(satId)}&minutes=180&step_seconds=90`)));
    results.forEach((result, index) => { state.mapPaths[missing[index]] = result.items || []; });
  }
  renderWorldMap();
}

async function savePlannerSettings(startupSatId, mapSatIds) {
  const payload = await post("/api/v1/settings/planner", { startup_sat_id: startupSatId, map_sat_ids: mapSatIds });
  state.plannerSettings = payload.state;
  state.mapPaths = {};
  renderPlannerSettings();
  await loadMapTracks();
}

function renderActivity() {
  const runtime = state.aprs?.runtime || state.system?.aprsRuntime || {};
  const radio = state.system?.radioRuntime || {};
  const error = runtime.last_error || radio.last_error;
  byId("activityContent").innerHTML = `
    <div class="activity-card"><span>APRS state</span><strong>${runtime.connected ? "Connected" : "Disconnected"}</strong></div>
    <div class="activity-card"><span>Packets</span><strong>${Number(runtime.packets_rx || 0)} RX / ${Number(runtime.packets_tx || 0)} TX</strong></div>
    <div class="activity-card"><span>Radio</span><strong>${labelize(radio.control_mode)}</strong></div>
    <div class="activity-card wide"><span>Latest operator-visible issue</span><strong>${escapeHtml(error || "No current error")}</strong><p>Detailed packet history and terrestrial gateway controls remain in the full APRS console during this first UI checkpoint.</p></div>`;
}

function render() {
  renderStationBar();
  renderOperate();
  renderPasses();
  renderActivity();
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
      await post("/api/v1/radio/session/select", { sat_id: pass.sat_id, sat_name: pass.name, pass_aos: pass.aos, pass_los: pass.los, max_el_deg: pass.max_el_deg });
    } else if (button.dataset.action === "connect") {
      await post("/api/v1/radio/connect");
    } else if (button.dataset.action === "test") {
      await post("/api/v1/radio/session/test");
    } else if (button.dataset.action === "confirm") {
      await post("/api/v1/radio/session/test/confirm");
    } else if (button.dataset.action === "start") {
      await post("/api/v1/radio/session/start");
    }
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

async function refreshData(showErrors = true) {
  try {
    const hours = Number(byId("passWindow")?.value || 24);
    const [system, passes, aprs, planner] = await Promise.all([
      api(`/api/v1/system/state${state.selectedPass ? `?sat_id=${encodeURIComponent(state.selectedPass.sat_id)}` : ""}`),
      api(`/api/v1/passes?hours=${hours}&include_ongoing=true`),
      api("/api/v1/aprs/state"),
      api("/api/v1/settings/planner"),
    ]);
    state.system = system;
    state.passes = Array.isArray(passes.items) ? passes.items : [];
    state.aprs = aprs;
    state.plannerSettings = planner.state;
    state.availableSatellites = planner.availableSatellites || [];
    if (!state.selectedPass) state.selectedPass = state.passes.find((item) => item.sat_id === state.plannerSettings?.startup_sat_id) || null;
    if (state.selectedPass) state.selectedPass = state.passes.find((item) => item.sat_id === state.selectedPass.sat_id && item.aos === state.selectedPass.aos) || state.selectedPass;
    render();
  } catch (error) {
    if (showErrors) showNotice(`Unable to refresh station state: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

document.addEventListener("click", async (event) => {
  const view = event.target.closest("[data-view]");
  if (view) switchView(view.dataset.view);

  const plannerView = event.target.closest("[data-planner-view]");
  if (plannerView) await switchPlannerView(plannerView.dataset.plannerView);

  const basemap = event.target.closest("[data-basemap]");
  if (basemap) {
    mapState.basemap = basemap.dataset.basemap;
    localStorage.setItem("orbitdeck.basemap", mapState.basemap);
    renderWorldMap();
  }

  const context = event.target.closest("[data-context]");
  if (context) {
    state.context = context.dataset.context;
    document.querySelectorAll("[data-context]").forEach((button) => button.setAttribute("aria-selected", String(button === context)));
    renderContext();
  }

  const passButton = event.target.closest("[data-pass-key], [data-focus-key]");
  if (passButton) {
    const key = passButton.dataset.passKey || passButton.dataset.focusKey;
    const [satId, aos] = key.split("|");
    state.selectedPass = state.passes.find((item) => item.sat_id === satId && item.aos === aos) || null;
    switchView("operate");
    await refreshData();
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-focus-key]")) event.target.click();
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
  mapState.zoom = Math.max(1, Math.min(7, zoom));
  renderWorldMap();
}

byId("mapZoomIn").addEventListener("click", () => setMapZoom(mapState.zoom + 1));
byId("mapZoomOut").addEventListener("click", () => setMapZoom(mapState.zoom - 1));
byId("mapReset").addEventListener("click", () => {
  mapState.zoom = mapDimensions().width >= 850 ? 2 : 1;
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
byId("secondaryAction").addEventListener("click", async () => {
  if (state.system?.radioRuntime?.connected) {
    try {
      await post("/api/v1/radio/disconnect");
      await refreshData(false);
    } catch (error) { showNotice(error instanceof Error ? error.message : String(error), true); }
  } else {
    window.location.href = "/radio";
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

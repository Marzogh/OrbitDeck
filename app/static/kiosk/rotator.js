let trackerApi;
let trackerById;
let trackerRenderStationBadge;
let trackerCreateRigConnectController;

const VIDEO_SOURCES_KEY = "kioskVideoSources";
const DEV_MODE_KEY = "kioskDevModeEnabled";
const DEV_FORCE_SCENE_KEY = "kioskDevForceScene";
const PINNED_VIEW_KEY = "rotatorPinnedView";
const APRS_PINNED_KEY = "rotatorAprsPinned";
const DEFAULT_VIDEO_SOURCES = [
  "https://www.youtube.com/embed/fO9e9jnhYK8?autoplay=1&mute=1&rel=0&modestbranding=1",
  "https://www.youtube.com/embed/sWasdbDVNvc?autoplay=1&mute=1&rel=0&modestbranding=1",
];
const BODY_COLORS = {
  Sun: "#ffd400",
  Moon: "#7fe0ff",
  Mercury: "#ff57b3",
  Venus: "#6dff7b",
  Mars: "#ff623e",
  Jupiter: "#9d7bff",
  Saturn: "#ff9b2e",
};
const MAX_ROTATOR_PASS_DURATION_MIN = 10;
let state = {
  system: null,
  passes: [],
  sats: [],
  timezone: "UTC",
};
let sceneOrder = [];
let sceneIdx = 0;
let nextSwitchAt = 0;
let lastOverride = "";
let activeVideoSource = 0;
let lastRadioPrimaryPass = null;
let fetchStateRequestId = 0;
const trailPoints = [];
const pathCache = new Map();
const STARTUP_LOG_LIMIT = 10;
const STARTUP_GET_RETRY_DELAYS_MS = [250, 750, 1500, 3000];
const STARTUP_RECOVERY_RETRY_MS = 3000;
const startupLines = [];
let rotatorActionError = "";
let aprsSceneState = { packetHighlights: new Map(), lastFeedKeys: [] };
let radioChannelDraftKey = "";
let radioChannelPickerFocused = false;
let connectModalMode = "radio";

function rigModelLabel(model) {
  if (model === "ic705") return "Icom IC-705";
  if (model === "id5100") return "Icom ID-5100";
  return String(model || "Radio");
}

function getDeveloperOverrides() {
  return {
    enabled: localStorage.getItem(DEV_MODE_KEY) === "1",
    force_scene: localStorage.getItem(DEV_FORCE_SCENE_KEY) || "auto",
    show_debug_badge: localStorage.getItem(DEV_MODE_KEY) === "1",
  };
}

function developerOverridesEnabled() {
  return !!getDeveloperOverrides().enabled;
}

function pinnedViewPreference() {
  const value = localStorage.getItem(PINNED_VIEW_KEY);
  return value === "aprs" ? "aprs" : "radio";
}

function setPinnedViewPreference(value) {
  localStorage.setItem(PINNED_VIEW_KEY, value === "aprs" ? "aprs" : "radio");
}

function aprsPinnedEnabled() {
  return localStorage.getItem(APRS_PINNED_KEY) === "1";
}

function setAprsPinnedEnabled(active) {
  localStorage.setItem(APRS_PINNED_KEY, active ? "1" : "0");
}

function getVideoSources() {
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

function fmtClockPair(nowIso) {
  const now = new Date(nowIso || Date.now());
  const tz = state.timezone || "UTC";
  const utc = `${now.toISOString().replace("T", " ").slice(0, 19)} UTC`;
  try {
    return {
      utc,
      local: `${now.toLocaleString("sv-SE", { timeZone: tz, hour12: false })} ${tz}`,
    };
  } catch (_) {
    return { utc, local: utc };
  }
}

function fmtLocal(iso) {
  const d = new Date(iso);
  const tz = state.timezone || "UTC";
  try {
    return d.toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  } catch (_) {
    return d.toISOString().slice(11, 19);
  }
}

function fmtCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isIssPass(p) {
  const satId = String(p.sat_id || "").toLowerCase();
  const name = String(p.name || "").toUpperCase().trim();
  return satId === "iss" || satId === "iss-zarya" || name === "ISS (ZARYA)" || name === "ISS";
}

function aprsChannelsForSatellite(satId) {
  const sat = (state.sats || []).find((item) => item.sat_id === satId);
  return Array.isArray(sat?.radio_channels) ? sat.radio_channels.filter((item) => item.kind === "aprs") : [];
}

function firstAprsChannelForSatellite(satId) {
  return aprsChannelsForSatellite(satId)[0] || null;
}

function defaultSatelliteAprsPath(channel) {
  const configured = String(state.system?.aprsSettings?.satellite_path || "").trim();
  return String(channel?.path_default || configured || "ARISS").trim();
}

function derivedAprsTarget(system) {
  const runtimeTarget = system?.aprsRuntime?.target || null;
  if (runtimeTarget) return runtimeTarget;
  const previewTarget = system?.aprsPreviewTarget || null;
  if (previewTarget) return previewTarget;
  const settings = system?.aprsSettings || {};
  const developerEnabled = !!system?.settings?.developer_overrides?.enabled;
  if (settings.operating_mode === "satellite" && settings.selected_satellite_id) {
    const sat = (state.sats || []).find((item) => item.sat_id === settings.selected_satellite_id);
    const channels = Array.isArray(sat?.radio_channels) ? sat.radio_channels.filter((item) => item.kind === "aprs") : [];
    const channel = channels.find((item) => item.channel_id === settings.selected_channel_id) || channels[0] || null;
    if (sat && channel) {
      return {
        operating_mode: "satellite",
        label: `${sat.name} | ${channel.label || "APRS"}`,
        sat_id: sat.sat_id,
        sat_name: sat.name,
        channel_id: channel.channel_id,
        channel_label: channel.label || "APRS",
        mode: channel.mode || channel.label || "APRS",
        frequency_hz: channel.downlink_hz || channel.uplink_hz || 0,
        uplink_hz: channel.uplink_hz || null,
        downlink_hz: channel.downlink_hz || null,
        path_default: defaultSatelliteAprsPath(channel),
        guidance: channel.guidance || null,
        requires_pass: !!channel.requires_pass,
        can_transmit: developerEnabled || !channel.requires_pass,
        tx_block_reason: developerEnabled || !channel.requires_pass
          ? null
          : "Satellite APRS transmit is only enabled during an active pass",
        reason: developerEnabled && channel.requires_pass
          ? "Developer override active: satellite APRS TX/RX forced enabled outside pass"
          : null,
      };
    }
  }
  if (settings.operating_mode === "terrestrial") {
    return {
      operating_mode: "terrestrial",
      label: "Terrestrial APRS",
      frequency_hz: settings.terrestrial_manual_frequency_hz || settings.terrestrial_last_suggested_frequency_hz || 0,
      path_default: String(settings.terrestrial_path || "WIDE1-1,WIDE2-1").trim(),
      can_transmit: true,
      tx_block_reason: null,
    };
  }
  return null;
}

function passSupportsAprs(pass) {
  return !!firstAprsChannelForSatellite(pass?.sat_id);
}

function isPinnedAprsControl(system) {
  if (!aprsPinnedEnabled()) return false;
  if (system?.aprsRuntime?.session_active || system?.aprsPreviewTarget) return true;
  const settings = system?.aprsSettings || {};
  if (settings.operating_mode === "terrestrial") return true;
  return !!(settings.operating_mode === "satellite" && settings.selected_satellite_id && settings.selected_channel_id);
}

function syncPinnedViewSelector(system) {
  const wrap = trackerById("pinnedViewWrap");
  const select = trackerById("pinnedViewSelect");
  if (!wrap || !select) return;
  const show = !!(isPinnedRadioControl(system?.radioControlSession) && isPinnedAprsControl(system));
  wrap.classList.toggle("hidden", !show);
  select.value = pinnedViewPreference();
}

function packetKey(packet) {
  return `${packet?.received_at || ""}|${packet?.raw_tnc2 || ""}`;
}

function passPriorityLabel(pass) {
  const maxEl = Number(pass?.max_el_deg ?? 0);
  if (isIssPass(pass)) return maxEl >= 45 ? "ISS high-visibility window" : "ISS priority window";
  if (maxEl >= 75) return "High-elevation radio window";
  if (maxEl >= 55) return "Strong radio window";
  return "Amateur radio window";
}

function passQueueDelta(iso) {
  const deltaMs = new Date(iso || 0).getTime() - Date.now();
  if (!Number.isFinite(deltaMs)) return "";
  if (deltaMs <= 0) return "Now";
  return `+${fmtCountdown(deltaMs)}`;
}

function passRowMeta(pass) {
  const labels = [];
  if (isIssPass(pass)) labels.push("ISS");
  const maxEl = Number(pass?.max_el_deg ?? 0);
  if (maxEl >= 75) labels.push("High El");
  else if (maxEl >= 55) labels.push("Strong El");
  return labels.join(" • ");
}

function isRotatorAllowedSat(pass) {
  const name = String(pass?.name || "").toUpperCase();
  return !name.includes("ISS") || isIssPass(pass);
}

function stablePassKey(pass) {
  const aosMs = new Date(pass?.aos || 0).getTime();
  const roundedMinute = Number.isFinite(aosMs) ? Math.round(aosMs / 60000) : 0;
  return `${pass?.sat_id || "unknown"}|${roundedMinute}`;
}

function startupOverlay() {
  return trackerById ? trackerById("rotatorStartup") : document.getElementById("rotatorStartup");
}

function setStartupVisible(active) {
  const overlay = startupOverlay();
  if (overlay) overlay.classList.toggle("hidden", !active);
  document.body.classList.toggle("rotator-booting", !!active);
}

function appendStartupLog(message) {
  const terminal = startupOverlay() ? trackerById("rotatorStartupTerminal") : document.getElementById("rotatorStartupTerminal");
  if (!terminal || !message) return;
  const stamp = new Date().toLocaleTimeString("en-AU", { hour12: false });
  const line = `[${stamp}] ${message}`;
  if (startupLines[startupLines.length - 1] === line) return;
  startupLines.push(line);
  while (startupLines.length > STARTUP_LOG_LIMIT) startupLines.shift();
  terminal.textContent = startupLines.join("\n");
  terminal.scrollTop = terminal.scrollHeight;
}

function setStartupStatus(message, logMessage = message) {
  const status = startupOverlay() ? trackerById("rotatorStartupStatus") : document.getElementById("rotatorStartupStatus");
  if (status) status.textContent = message;
  appendStartupLog(logMessage);
}

function setRotatorActionError(message) {
  rotatorActionError = String(message || "").trim();
}

function clearRotatorActionError() {
  rotatorActionError = "";
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isTransientFetchError(err) {
  const message = String(err?.message || err || "");
  return /NetworkError|Failed to fetch|Load failed|fetch resource/i.test(message);
}

async function getWithRetry(path, report = null) {
  let lastErr = null;
  for (let attempt = 0; attempt <= STARTUP_GET_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await trackerApi.get(path);
    } catch (err) {
      lastErr = err;
      if (!isTransientFetchError(err) || attempt >= STARTUP_GET_RETRY_DELAYS_MS.length) {
        throw err;
      }
      if (typeof report === "function") {
        report("Retrying local OrbitDeck request", `${path} failed transiently; retry ${attempt + 1} of ${STARTUP_GET_RETRY_DELAYS_MS.length}`);
      }
      await sleep(STARTUP_GET_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr || new Error(`GET ${path} failed`);
}

async function bootRotatorUntilReady() {
  for (;;) {
    try {
      await fetchState(setStartupStatus);
      chooseScene();
      setStartupStatus("Initial render ready", "Rotator console online");
      window.setTimeout(() => setStartupVisible(false), 320);
      return;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (!isTransientFetchError(err)) {
        throw err;
      }
      setStartupVisible(true);
      setStartupStatus(
        "Waiting for OrbitDeck backend",
        `Startup fetch failed transiently: ${msg}. Retrying in ${Math.round(STARTUP_RECOVERY_RETRY_MS / 1000)}s`
      );
      await sleep(STARTUP_RECOVERY_RETRY_MS);
    }
  }
}

function pinnedRadioStatusLine(session, runtime) {
  if (rotatorActionError) return rotatorActionError;
  if (runtime?.last_error) return runtime.last_error;
  if (!runtime?.connected) return "Radio not connected";
  const rig = rigModelLabel(runtime?.rig_model);
  if (session?.screen_state === "released") return `${rig} connected. Control released to operator`;
  if (session?.screen_state === "test") return `${rig} connected. Test control applied`;
  if (session?.screen_state === "armed") return `${rig} connected. Waiting for AOS`;
  if (session?.screen_state === "active") return `${rig} connected. Pass control active`;
  return `${rig} connected and ready`;
}

let radioConnectController = null;

function setConnectModalMode(mode) {
  connectModalMode = mode === "aprs" ? "aprs" : "radio";
}

async function openRadioConnectModal(mode = "radio") {
  setConnectModalMode(mode);
  if (!radioConnectController) return;
  await radioConnectController.open();
}

function closeRadioConnectModal() {
  if (radioConnectController) {
    radioConnectController.close();
  }
}

async function submitRadioConnectModal() {
  if (!radioConnectController) return;
  await radioConnectController.submit();
}

function clone(obj) {
  if (obj == null) return obj;
  return JSON.parse(JSON.stringify(obj));
}

function sceneDurationMs(key) {
  if (key.startsWith("telemetry:")) return 15000;
  if (key === "passes") return 15000;
  if (key === "radio") return 15000;
  return 15000;
}

function azElToXY(azDeg, elDeg, radius = 108, cx = 150, cy = 150) {
  const az = (azDeg * Math.PI) / 180;
  const el = Math.max(0, Math.min(90, elDeg));
  const r = ((90 - el) / 90) * radius;
  return { x: cx + r * Math.sin(az), y: cy - r * Math.cos(az) };
}

function bodySymbol(name) {
  const map = { Sun: "☉", Moon: "☾", Mercury: "☿", Venus: "♀", Mars: "♂", Jupiter: "♃", Saturn: "♄" };
  return map[name] || "•";
}

function bodyLegendChip(body) {
  return `<span class="body-key"><span class="body-key-token" style="--body-color:${body.color}"><span class="body-key-sym">${bodySymbol(body.name)}</span></span><span class="body-key-name">${body.name}</span></span>`;
}

function passKey(pass) {
  if (!pass) return "";
  return `${pass.sat_id}|${pass.aos}|${pass.los}`;
}

function activeRadioSession() {
  return state.system?.radioControlSession || null;
}

function isPinnedRadioControl(session) {
  return !!session?.active;
}

function radioSessionPassState(session, nowMs = Date.now()) {
  if (!session?.selected_pass_aos || !session?.selected_pass_los) return "unknown";
  const aos = new Date(session.selected_pass_aos).getTime();
  const los = new Date(session.selected_pass_los).getTime();
  if (nowMs < aos) return "below horizon";
  if (nowMs <= los) return "above horizon";
  return "ended";
}

function findSessionPass(passes, session) {
  if (!session?.selected_sat_id || !session?.selected_pass_aos || !session?.selected_pass_los) return null;
  const matched = (passes || []).find((pass) =>
    pass.sat_id === session.selected_sat_id
    && pass.aos === session.selected_pass_aos
    && pass.los === session.selected_pass_los
  ) || null;
  if (matched) return matched;
  return {
    sat_id: session.selected_sat_id,
    name: session.selected_sat_name || session.selected_sat_id,
    aos: session.selected_pass_aos,
    los: session.selected_pass_los,
    tca: session.selected_pass_aos,
    max_el_deg: Number(session.selected_max_el_deg || 0),
    frequencyRecommendation: null,
    frequencyMatrix: null,
  };
}

function passPhase(pass, nowMs = Date.now()) {
  if (!pass) return "none";
  const aos = new Date(pass.aos).getTime();
  const los = new Date(pass.los).getTime();
  if (nowMs < aos) return "upcoming";
  if (nowMs <= los) return "ongoing";
  return "after";
}

function pathForItems(items) {
  if (!items.length) return "";
  return items.map((item, idx) => {
    const p = azElToXY(item.az_deg, item.el_deg);
    return `${idx === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  }).join(" ");
}

function nearestPathPoint(items, iso) {
  if (!iso || !items?.length) return null;
  const target = new Date(iso).getTime();
  let best = null;
  for (const item of items) {
    const ts = new Date(item.timestamp).getTime();
    const delta = Math.abs(ts - target);
    if (!best || delta < best.delta) best = { item, delta };
  }
  return best && best.delta <= 120000 ? best.item : null;
}

function plotRefs(prefix = "telemetry") {
  if (prefix === "radio") {
    return {
      dot: "radioIssDot",
      halo: "radioIssDotHalo",
      trail: "radioIssTrail",
      bodyLayer: "radioBodyLayer",
      fadedPath: "radioIssPathFaded",
      pastPath: "radioIssPathPast",
      futurePath: "radioIssPathFuture",
      eventMarkers: "radioIssEventMarkers",
      bodyLegend: "radioBodyLegend",
      plotTicks: "radioPlotTicks",
      plotDegrees: "radioPlotDegrees",
    };
  }
  return {
    dot: "issDot",
    halo: "issDotHalo",
    trail: "issTrail",
    bodyLayer: "bodyLayer",
    fadedPath: "issPathFaded",
    pastPath: "issPathPast",
    futurePath: "issPathFuture",
    eventMarkers: "issEventMarkers",
    bodyLegend: "bodyLegend",
    plotTicks: "plotTicks",
    plotDegrees: "plotDegrees",
  };
}

function ensurePlotTicks(elId = "plotTicks", degreeId = "plotDegrees") {
  const degreeLayer = trackerById(degreeId);
  if (degreeLayer && !degreeLayer.childNodes.length) {
    const ns = "http://www.w3.org/2000/svg";
    for (let deg = 0; deg < 360; deg += 30) {
      if (deg % 90 === 0) continue;
      const a = (deg * Math.PI) / 180;
      const r = 122;
      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", (150 + r * Math.sin(a)).toFixed(2));
      text.setAttribute("y", (150 - r * Math.cos(a) + 3).toFixed(2));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("class", "plot-degree-label");
      text.textContent = String(deg);
      degreeLayer.appendChild(text);
    }
  }

  const tickLayer = trackerById(elId);
  if (!tickLayer || tickLayer.childNodes.length) return;
  const ns = "http://www.w3.org/2000/svg";
  for (let deg = 0; deg < 360; deg += 10) {
    const major = deg % 30 === 0;
    const inner = major ? 91 : 98;
    const outer = 108;
    const a = (deg * Math.PI) / 180;
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", (150 + inner * Math.sin(a)).toFixed(2));
    line.setAttribute("y1", (150 - inner * Math.cos(a)).toFixed(2));
    line.setAttribute("x2", (150 + outer * Math.sin(a)).toFixed(2));
    line.setAttribute("y2", (150 - outer * Math.cos(a)).toFixed(2));
    line.setAttribute("class", `plot-tick ${major ? "plot-tick-major" : "plot-tick-minor"}`);
    tickLayer.appendChild(line);
  }
}

function normalizeFreqToken(text) {
  return String(text || "").replace(/\b\d{7,11}\b/g, (m) => {
    const n = Number(m);
    if (!Number.isFinite(n) || n <= 0) return m;
    return `${(n / 1_000_000).toFixed(3)} MHz`;
  });
}

function renderSkyplot(track, bodies, pass = null, pathItems = [], prefix = "telemetry") {
  if (!track) return;
  const refs = plotRefs(prefix);
  ensurePlotTicks(refs.plotTicks, refs.plotDegrees);
  const dot = trackerById(refs.dot);
  const halo = trackerById(refs.halo);
  const trail = trackerById(refs.trail);
  const bodyLayer = trackerById(refs.bodyLayer);
  const fadedPath = trackerById(refs.fadedPath);
  const pastPath = trackerById(refs.pastPath);
  const futurePath = trackerById(refs.futurePath);
  const eventMarkers = trackerById(refs.eventMarkers);
  const bodyLegend = trackerById(refs.bodyLegend);
  if (!dot || !halo || !trail || !bodyLayer || !fadedPath || !pastPath || !futurePath || !eventMarkers || !bodyLegend) return;
  const p = azElToXY(track.az_deg, track.el_deg);
  const phase = passPhase(pass);
  if (phase === "ongoing" || phase === "none") {
    trailPoints.push(p);
    if (trailPoints.length > 6) trailPoints.shift();
    dot.setAttribute("cx", p.x.toFixed(2));
    dot.setAttribute("cy", p.y.toFixed(2));
    dot.style.opacity = "1";
    if (halo) {
      halo.setAttribute("cx", p.x.toFixed(2));
      halo.setAttribute("cy", p.y.toFixed(2));
      halo.style.opacity = "1";
    }
    trail.setAttribute("points", trailPoints.map((x) => `${x.x.toFixed(1)},${x.y.toFixed(1)}`).join(" "));
  } else if (phase === "upcoming") {
    dot.setAttribute("cx", p.x.toFixed(2));
    dot.setAttribute("cy", p.y.toFixed(2));
    dot.style.opacity = "0.56";
    if (halo) {
      halo.setAttribute("cx", p.x.toFixed(2));
      halo.setAttribute("cy", p.y.toFixed(2));
      halo.style.opacity = "0.28";
    }
    trail.setAttribute("points", "");
  } else {
    dot.style.opacity = "0";
    if (halo) halo.style.opacity = "0";
    trail.setAttribute("points", "");
  }

  if (fadedPath) fadedPath.setAttribute("d", "");
  if (pastPath) pastPath.setAttribute("d", "");
  if (futurePath) futurePath.setAttribute("d", "");
  if (eventMarkers) eventMarkers.innerHTML = "";

  const plottedPath = (pathItems || []);
  if (plottedPath.length >= 2 && fadedPath && pastPath && futurePath && eventMarkers) {
    if (phase === "after") {
      fadedPath.setAttribute("d", pathForItems(plottedPath));
    } else if (phase === "ongoing") {
      let splitIdx = plottedPath.findIndex((item) => new Date(item.timestamp).getTime() >= Date.now());
      if (splitIdx < 0) splitIdx = plottedPath.length - 1;
      pastPath.setAttribute("d", pathForItems(plottedPath.slice(0, Math.max(1, splitIdx + 1))));
      futurePath.setAttribute("d", pathForItems(plottedPath.slice(Math.max(0, splitIdx))));
    } else {
      futurePath.setAttribute("d", pathForItems(plottedPath));
    }

    const labels = [
      { key: "AOS", iso: pass?.aos, dx: 8, dy: -8 },
      { key: "TCA", iso: pass?.tca, dx: 8, dy: -10 },
      { key: "LOS", iso: pass?.los, dx: 8, dy: -8 },
    ];
    eventMarkers.innerHTML = labels.map(({ key, iso, dx, dy }) => {
      const item = nearestPathPoint(plottedPath, iso);
      if (!item) return "";
      const q = azElToXY(item.az_deg, item.el_deg);
      return `<g><circle cx="${q.x.toFixed(2)}" cy="${q.y.toFixed(2)}" r="3.6" class="plot-event-dot"></circle><text x="${(q.x + dx).toFixed(2)}" y="${(q.y + dy).toFixed(2)}" class="plot-event-label">${key}</text></g>`;
    }).join("");
  }

  const visible = (bodies || []).filter((b) => b.visible && b.el_deg > 0).map((b) => ({ ...b, color: BODY_COLORS[b.name] || b.color || "#ddd" }));
  bodyLayer.innerHTML = "";
  visible.forEach((b) => {
    const q = azElToXY(b.az_deg, b.el_deg);
    bodyLayer.insertAdjacentHTML("beforeend", `<g><circle cx="${q.x.toFixed(2)}" cy="${q.y.toFixed(2)}" r="6.2" fill="${b.color}" class="plot-body"></circle><text x="${q.x.toFixed(2)}" y="${(q.y + 2.8).toFixed(2)}" text-anchor="middle" class="plot-body-icon">${bodySymbol(b.name)}</text></g>`);
  });
  bodyLegend.innerHTML = visible.length
    ? visible.map((b) => bodyLegendChip(b)).join("")
    : '<span class="label">Bodies: none above horizon</span>';
}

async function populatePathCache(system, passes, progress = null) {
  const locationSource = system?.location?.source;
  const queryLocation = locationSource && locationSource !== "default" && locationSource !== "last_known"
    ? `&location_source=${encodeURIComponent(locationSource)}`
    : "";
  const candidates = [];
  const seen = new Set();
  for (const pass of passes || []) {
    const key = passKey(pass);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isRotatorAllowedSat(pass) || !isRotatorEligiblePass(pass)) continue;
    candidates.push(pass);
    if (candidates.length >= 6) break;
  }
  if (typeof progress === "function") {
    progress(
      "Preparing sky paths",
      candidates.length ? `Caching ${candidates.length} eligible trajectory previews` : "No eligible trajectories needed for the first render"
    );
  }
  await Promise.all(candidates.map(async (pass) => {
    const key = passKey(pass);
    if (pathCache.has(key)) return;
    try {
      pathCache.set(key, await fetchPathForPass(pass, queryLocation));
    } catch (_) {
      pathCache.set(key, []);
    }
  }));
}

async function fetchPathForPass(pass, queryLocation = "") {
  const start = new Date(pass.aos);
  const end = new Date(pass.los);
  const minutes = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 60000) + 1);
  const resp = await trackerApi.get(
    `/api/v1/track/path?sat_id=${encodeURIComponent(pass.sat_id)}&minutes=${minutes}&step_seconds=30&start_time=${encodeURIComponent(start.toISOString())}${queryLocation}`
  );
  return Array.isArray(resp.items) ? resp.items : [];
}

async function ensurePathForDisplayedPass(system, pass) {
  if (!pass) return [];
  const key = passKey(pass);
  if (pathCache.has(key)) return pathCache.get(key) || [];
  const locationSource = system?.location?.source;
  const queryLocation = locationSource && locationSource !== "default" && locationSource !== "last_known"
    ? `&location_source=${encodeURIComponent(locationSource)}`
    : "";
  try {
    const items = await fetchPathForPass(pass, queryLocation);
    pathCache.set(key, items);
    return items;
  } catch (_) {
    pathCache.set(key, []);
    return [];
  }
}

function parsePair(text) {
  const s = normalizeFreqToken(text);
  const m = s.match(/Uplink\s+(.+?)\s*\/\s*Downlink\s+(.+)$/i);
  if (!m) {
    const bare = s.match(/(\d+(?:\.\d+)?)\s*MHz/i);
    return bare ? { up: "—", down: bare[0] } : { up: "—", down: "—" };
  }
  const up = m[1].trim();
  const down = m[2].trim();
  return {
    up: /^n\/?a$/i.test(up) ? "—" : up,
    down: /^n\/?a$/i.test(down) ? "—" : down,
  };
}

function extractFirstMHz(text) {
  const m = normalizeFreqToken(text).match(/(\d+(?:\.\d+)?)\s*MHz/i);
  return m ? Number(m[1]) : null;
}

function bandFromMHz(v) {
  if (!Number.isFinite(v)) return "Unknown";
  if (v >= 144 && v <= 148) return "VHF 2m";
  if (v >= 420 && v <= 450) return "UHF 70cm";
  if (v >= 1240 && v <= 1300) return "L 23cm";
  if (v >= 2200 && v <= 2450) return "S 13cm";
  if (v >= 10450 && v <= 10500) return "X 3cm";
  return `${v.toFixed(3)} MHz`;
}

function describeBandPair(up, down) {
  if (up !== "Unknown" && down !== "Unknown") return `${up} -> ${down}`;
  if (up === "Unknown" && down !== "Unknown") return `Downlink only -> ${down}`;
  if (up !== "Unknown" && down === "Unknown") return `${up} uplink only`;
  return "Band unknown";
}

function inferRadioMode(...texts) {
  const joined = texts.map((text) => String(text || "").toUpperCase()).join(" ");
  if (/\bD-STAR\b/.test(joined)) return "D-STAR";
  if (/\bUSB\b/.test(joined)) return "USB";
  if (/\bLSB\b/.test(joined)) return "LSB";
  if (/\bAM\b/.test(joined)) return "AM";
  if (/\bCW\b/.test(joined)) return "CW";
  return "FM";
}

function mhzToHz(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num * 1_000_000) : null;
}

function radioChannelChoiceKey(choice) {
  return [
    choice.uplink_hz || 0,
    choice.downlink_hz || 0,
    choice.uplink_mode || "",
    choice.downlink_mode || "",
  ].join("|");
}

function radioChannelDraftStorageKey(session) {
  if (!session?.selected_sat_id || !session?.selected_pass_aos || !session?.selected_pass_los) return "";
  return `rotatorRadioChannelDraft:${session.selected_sat_id}:${session.selected_pass_aos}:${session.selected_pass_los}`;
}

function loadPersistedRadioChannelDraft(session) {
  const key = radioChannelDraftStorageKey(session);
  if (!key) return "";
  try {
    return localStorage.getItem(key) || "";
  } catch (_) {
    return "";
  }
}

function savePersistedRadioChannelDraft(session, value) {
  const key = radioChannelDraftStorageKey(session);
  if (!key) return;
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (_) {}
}

function choiceFromRecommendation(recommendation, prefix = "Recommended") {
  if (!recommendation || (!Number.isFinite(Number(recommendation.uplink_mhz)) && !Number.isFinite(Number(recommendation.downlink_mhz)))) {
    return null;
  }
  const uplink_hz = mhzToHz(recommendation.uplink_mhz);
  const downlink_hz = mhzToHz(recommendation.downlink_mhz);
  const uplink_mode = uplink_hz ? String(recommendation.uplink_mode || inferRadioMode(recommendation.label, recommendation.note)).toUpperCase() : null;
  const downlink_mode = downlink_hz ? String(recommendation.downlink_mode || inferRadioMode(recommendation.label, recommendation.note)).toUpperCase() : null;
  return {
    key: "",
    group: uplink_hz && downlink_hz ? "Voice" : "Monitoring",
    label: `${prefix}: ${recommendation.label || "Channel"}`,
    detail: [
      uplink_hz ? `TX ${normalizeFreqToken(String(uplink_hz))} ${uplink_mode}` : "TX —",
      downlink_hz ? `RX ${normalizeFreqToken(String(downlink_hz))} ${downlink_mode}` : "RX —",
    ].join(" | "),
    uplink_hz,
    downlink_hz,
    uplink_mode,
    downlink_mode,
  };
}

function choiceFromFrequencyRow(row) {
  const uplink_mhz = extractFirstMHz(row.up);
  const downlink_mhz = extractFirstMHz(row.down);
  if (!Number.isFinite(uplink_mhz) && !Number.isFinite(downlink_mhz)) return null;
  const uplink_hz = mhzToHz(uplink_mhz);
  const downlink_hz = mhzToHz(downlink_mhz);
  const uplink_mode = uplink_hz ? inferRadioMode(row.mode, row.up) : null;
  const downlink_mode = downlink_hz ? inferRadioMode(row.mode, row.down) : null;
  return {
    key: "",
    group: "Voice",
    label: row.mode || "Channel",
    detail: [
      row.up !== "—" ? `TX ${row.up}${uplink_mode ? ` ${uplink_mode}` : ""}` : "TX —",
      row.down !== "—" ? `RX ${row.down}${downlink_mode ? ` ${downlink_mode}` : ""}` : "RX —",
      row.bands || "",
    ].filter(Boolean).join(" | "),
    uplink_hz,
    downlink_hz,
    uplink_mode,
    downlink_mode,
  };
}

function isAprsChannelRow(row) {
  const text = `${row.mode} ${row.up} ${row.down} ${row.bands}`.toLowerCase();
  return /aprs|packet|afsk/.test(text);
}

function isAnalogVoiceChannelRow(row) {
  const text = `${row.mode} ${row.up} ${row.down} ${row.bands}`.toLowerCase();
  if (isAprsChannelRow(row)) return false;
  return (/(voice repeater|repeater|ctcss|fm)/.test(text) && row.up !== "—" && row.down !== "—");
}

function isMonitoringChannelRow(row) {
  const text = `${row.mode} ${row.up} ${row.down} ${row.bands}`.toLowerCase();
  if (isAprsChannelRow(row)) return false;
  return /(sstv|cw|beacon)/.test(text) && row.down !== "—";
}

function choiceFromMonitoringRow(row) {
  const downlink_mhz = extractFirstMHz(row.down);
  if (!Number.isFinite(downlink_mhz)) return null;
  const downlink_hz = mhzToHz(downlink_mhz);
  const downlink_mode = downlink_hz ? inferRadioMode(row.mode, row.down) : null;
  return {
    key: "",
    group: "Monitoring",
    label: `${row.mode || "Monitor"} | RX only`,
    detail: [
      downlink_hz ? `RX ${row.down}${downlink_mode ? ` ${downlink_mode}` : ""}` : "RX —",
      "Downlink only",
      row.bands || "",
    ].filter(Boolean).join(" | "),
    uplink_hz: null,
    downlink_hz,
    uplink_mode: null,
    downlink_mode,
  };
}

function currentRigModel() {
  return state.system?.radioRuntime?.rig_model || state.system?.radioSettings?.rig_model || "id5100";
}

function choiceSupportedByRig(choice) {
  if (!choice) return false;
  const uplinkMhz = choice.uplink_hz ? (choice.uplink_hz / 1_000_000) : null;
  const downlinkMhz = choice.downlink_hz ? (choice.downlink_hz / 1_000_000) : null;
  const hasUplink = Number.isFinite(uplinkMhz);
  const hasDownlink = Number.isFinite(downlinkMhz);
  const uplinkOk = !hasUplink || supportsAmateurTx(uplinkMhz);
  const downlinkOk = !hasDownlink || supportsRigReceive(downlinkMhz, currentRigModel());
  return (hasUplink || hasDownlink) && uplinkOk && downlinkOk;
}

function radioControlChoiceFromRow(row) {
  const direct = choiceFromFrequencyRow(row);
  if (choiceSupportedByRig(direct)) return direct;
  const monitoring = choiceFromMonitoringRow(row);
  if (choiceSupportedByRig(monitoring)) return monitoring;
  return null;
}

function recommendationFromChannelChoice(satId, choice) {
  if (!choice || (!choice.uplink_hz && !choice.downlink_hz)) return null;
  return {
    sat_id: satId || "",
    label: choice.label || "Channel",
    uplink_mhz: choice.uplink_hz ? (choice.uplink_hz / 1_000_000) : null,
    downlink_mhz: choice.downlink_hz ? (choice.downlink_hz / 1_000_000) : null,
    uplink_mode: choice.uplink_mode || null,
    downlink_mode: choice.downlink_mode || null,
  };
}

function radioControlSupportFromDisplay(satId, recommendation, rows = []) {
  const fallbackChoice = (rows || []).map(radioControlChoiceFromRow).find(Boolean) || null;
  const recommendationCandidate = choiceSupportedByRig(choiceFromRecommendation(recommendation))
    ? recommendation
    : null;
  const candidate = recommendationCandidate || recommendationFromChannelChoice(satId, fallbackChoice);
  return {
    availability: radioControlAvailability(candidate),
    fallbackChoice,
  };
}

function deriveFallbackRadioChoiceForSelection(target) {
  const fallbackUplinkText = String(target?.dataset?.fallbackUplinkHz || "").trim();
  const fallbackDownlinkText = String(target?.dataset?.fallbackDownlinkHz || "").trim();
  if (fallbackUplinkText || fallbackDownlinkText) {
    const fallbackUplinkHz = fallbackUplinkText ? Number(fallbackUplinkText) : NaN;
    const fallbackDownlinkHz = fallbackDownlinkText ? Number(fallbackDownlinkText) : NaN;
    if (Number.isFinite(fallbackUplinkHz) || Number.isFinite(fallbackDownlinkHz)) {
      return {
        label: target.dataset.fallbackLabel || "Fallback channel",
        uplink_hz: Number.isFinite(fallbackUplinkHz) ? fallbackUplinkHz : null,
        downlink_hz: Number.isFinite(fallbackDownlinkHz) ? fallbackDownlinkHz : null,
        uplink_mode: target.dataset.fallbackUplinkMode || null,
        downlink_mode: target.dataset.fallbackDownlinkMode || null,
      };
    }
  }

  const syntheticSession = {
    selected_sat_id: target?.dataset?.satId || "",
    selected_sat_name: target?.dataset?.satName || target?.dataset?.satId || "",
    selected_pass_aos: target?.dataset?.passAos || "",
    selected_pass_los: target?.dataset?.passLos || "",
    selected_max_el_deg: Number(target?.dataset?.maxEl || 0),
  };
  const pass = findSessionPass(state.passes, syntheticSession);
  const sat = (state.sats || []).find((item) => item.sat_id === syntheticSession.selected_sat_id);
  const guideRows = rowsFromGuide(pass?.frequencyRecommendation, pass?.frequencyMatrix, "real-time");
  const rows = guideRows.length ? [...guideRows, ...frequencyEntriesForSatellite(sat)] : frequencyEntriesForSatellite(sat);
  return rows.map(radioControlChoiceFromRow).find(Boolean) || null;
}

function buildRadioSessionTestPairPayload(choice) {
  if (!choice) return null;
  const uplink_hz = Number.isFinite(Number(choice.uplink_hz)) ? Math.round(Number(choice.uplink_hz)) : null;
  const downlink_hz = Number.isFinite(Number(choice.downlink_hz)) ? Math.round(Number(choice.downlink_hz)) : null;
  const uplink_mode = uplink_hz ? String(choice.uplink_mode || "").trim().toUpperCase() || null : null;
  const downlink_mode = downlink_hz ? String(choice.downlink_mode || "").trim().toUpperCase() || null : null;
  const label = String(choice.label || "Fallback channel").trim() || "Fallback channel";
  if (!uplink_hz && !downlink_hz) return null;
  return { label, uplink_hz, downlink_hz, uplink_mode, downlink_mode };
}

function modeLongName(modeText) {
  const mode = String(modeText || "").replace(/^Mode\s*/i, "").trim();
  const map = { V: "VHF 2m", U: "UHF 70cm", L: "L 23cm", S: "S 13cm", X: "X 3cm" };
  const slash = mode.match(/\b([VULSX])\/([VULSX])\b/i);
  if (slash) {
    const a = slash[1].toUpperCase();
    const b = slash[2].toUpperCase();
    return `${mode} (${map[a] || a} up, ${map[b] || b} down)`;
  }
  const single = mode.match(/\b([VULSX])\b/i);
  if (single) {
    const k = single[1].toUpperCase();
    return `${mode} (${map[k] || k})`;
  }
  return mode || "General";
}

function supportsAmateurTx(freqMhz) {
  const value = Number(freqMhz);
  if (!Number.isFinite(value)) return false;
  return (value >= 144 && value <= 148) || (value >= 420 && value <= 450);
}

function supportsRigReceive(freqMhz, rigModel = currentRigModel()) {
  const value = Number(freqMhz);
  if (!Number.isFinite(value)) return false;
  if (rigModel === "ic705") {
    return (value >= 0.030 && value <= 199.999) || (value >= 400 && value <= 470);
  }
  if (rigModel === "id5100") {
    return (value >= 118 && value <= 174) || (value >= 375 && value <= 550);
  }
  return supportsAmateurTx(value);
}

function radioControlAvailability(recommendation) {
  const hasUplink = Number.isFinite(Number(recommendation?.uplink_mhz));
  const hasDownlink = Number.isFinite(Number(recommendation?.downlink_mhz));
  if (!recommendation || (!hasUplink && !hasDownlink)) {
    return {
      eligible: false,
      reason: "Radio control unavailable: no usable in-range uplink or downlink is defined for this pass.",
    };
  }
  const uplinkOk = !hasUplink || supportsAmateurTx(recommendation.uplink_mhz);
  const downlinkOk = !hasDownlink || supportsRigReceive(recommendation.downlink_mhz);
  if (!uplinkOk && !hasDownlink) {
    return {
      eligible: false,
      reason: `Radio control unavailable: uplink ${Number(recommendation.uplink_mhz).toFixed(3)} MHz is outside the allowed amateur transmit ranges.`,
    };
  }
  if (!downlinkOk && !hasUplink) {
    return {
      eligible: false,
      reason: `Radio control unavailable: downlink ${Number(recommendation.downlink_mhz).toFixed(3)} MHz is outside ${rigModelLabel(currentRigModel())} receive coverage.`,
    };
  }
  if (!uplinkOk) {
    return {
      eligible: false,
      reason: `Radio control unavailable: uplink ${Number(recommendation.uplink_mhz).toFixed(3)} MHz is outside the allowed amateur transmit ranges.`,
    };
  }
  if (!downlinkOk) {
    return {
      eligible: false,
      reason: `Radio control unavailable: downlink ${Number(recommendation.downlink_mhz).toFixed(3)} MHz is outside ${rigModelLabel(currentRigModel())} receive coverage.`,
    };
  }
  return {
    eligible: true,
    reason: hasUplink && hasDownlink
      ? "This pass is supported by the current radio-control workflow."
      : `Receive-only radio control is available for this pass on ${rigModelLabel(currentRigModel())}.`,
  };
}

function scoreHamUsefulness(row) {
  const text = `${row.mode} ${row.up} ${row.down} ${row.bands}`.toLowerCase();
  const hasPair = row.up !== "—" || row.down !== "—";
  if (!hasPair) return -100;
  if (/(crew|soyuz|spacex|service module|zvezda|telemetry|control)/i.test(text)) return -50;
  if (/aprs/i.test(text)) return 100;
  if (/(voice repeater|repeater|ctcss)/i.test(text)) return 90;
  if (/transponder/i.test(text)) return 80;
  if (/(ssb|cw|fm|afsk|fsk|gfsk|gmsk|bpsk|packet|sstv|dvb-s2)/i.test(text)) return 60;
  return 20;
}

function frequencyEntriesForSatellite(sat) {
  const tx = (sat?.transponders || []).map(normalizeFreqToken);
  const rx = (sat?.repeaters || []).map(normalizeFreqToken);
  const rows = [];
  const n = Math.max(tx.length, rx.length, 1);
  for (let i = 0; i < n; i++) {
    const modeText = tx[i] || `Channel ${i + 1}`;
    const pair = parsePair(rx[i] || "");
    const upBand = bandFromMHz(extractFirstMHz(pair.up));
    const downBand = bandFromMHz(extractFirstMHz(pair.down));
    rows.push({
      mode: modeLongName(modeText),
      up: pair.up,
      down: pair.down,
      bands: pair.up !== "—" || pair.down !== "—" ? describeBandPair(upBand, downBand) : "Band unknown",
    });
  }
  return rows
    .filter((r) => r.up !== "—" || r.down !== "—")
    .sort((a, b) => scoreHamUsefulness(b) - scoreHamUsefulness(a))
    .slice(0, 6);
}

function buildFreqRows(sat) {
  return frequencyEntriesForSatellite(sat).map((row) => ({
    mode: row.mode,
    up: row.up,
    down: row.down,
    bands: row.bands,
  }));
}

function fmtGuideMHz(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(3)} MHz` : "—";
}

function correctionSideLabel(side) {
  if (side === "full_duplex") return "Full duplex correction";
  if (side === "downlink_only") return "Downlink Doppler only";
  if (side === "uhf_only") return "UHF-side Doppler only";
  return "";
}

function debugPhaseLabel(phase) {
  if (phase === "before-aos") return "Simulated before AOS";
  if (phase === "at-aos") return "Simulated at AOS";
  if (phase === "mid-pass") return "Simulated mid-pass";
  if (phase === "near-los") return "Simulated near LOS";
  return "";
}

function phaseForSceneMode(mode, matrix) {
  if (!matrix?.rows?.length) return null;
  if (mode === "ongoing") return "mid";
  if (mode === "iss-upcoming" || mode === "upcoming") return "aos";
  return matrix.active_phase || null;
}

function rowsFromGuide(recommendation, matrix, sceneMode = "real-time", debugMeta = "") {
  if (!recommendation) return [];
  const phase = phaseForSceneMode(sceneMode, matrix);
  const phaseRow = (matrix?.rows || []).find((row) => row.phase === phase);
  const activeUp = phaseRow ? fmtGuideMHz(phaseRow.uplink_mhz) : fmtGuideMHz(recommendation.uplink_mhz);
  const activeDown = phaseRow ? fmtGuideMHz(phaseRow.downlink_mhz) : fmtGuideMHz(recommendation.downlink_mhz);
  const items = [{
    mode: `${recommendation.label}${phase ? ` | ${String(phase).toUpperCase()}` : ""}`,
    up: `${activeUp}${recommendation.uplink_mode ? ` ${recommendation.uplink_mode}` : ""}`,
    down: `${activeDown}${recommendation.downlink_mode ? ` ${recommendation.downlink_mode}` : ""}`,
    bands: [
      `${recommendation.uplink_label || "Uplink"} -> ${recommendation.downlink_label || "Downlink"}`,
      correctionSideLabel(recommendation.correction_side),
      debugMeta,
    ].filter(Boolean).join(" | "),
  }];
  (matrix?.rows || []).forEach((row) => {
    items.push({
      mode: `Phase ${String(row.phase).toUpperCase()}`,
      up: fmtGuideMHz(row.uplink_mhz),
      down: fmtGuideMHz(row.downlink_mhz),
      bands: row.phase === phase ? "Scene phase" : "Reference",
    });
  });
  return items;
}

function isUsefulAlternateRow(row) {
  return scoreHamUsefulness(row) >= 60;
}

function buildRadioChannelChoices(session, pass) {
  const sat = (state.sats || []).find((item) => item.sat_id === session?.selected_sat_id);
  const guideRows = rowsFromGuide(pass?.frequencyRecommendation, pass?.frequencyMatrix, "real-time");
  const rawChoices = [];
  const currentChoice = choiceFromRecommendation(session?.test_pair, "Active test pair");
  if (choiceSupportedByRig(currentChoice)) rawChoices.push(currentChoice);
  guideRows
    .filter(isAnalogVoiceChannelRow)
    .forEach((row) => {
      const choice = choiceFromFrequencyRow(row);
      if (choiceSupportedByRig(choice)) rawChoices.push(choice);
    });
  frequencyEntriesForSatellite(sat)
    .filter(isAnalogVoiceChannelRow)
    .forEach((row) => {
      const choice = choiceFromFrequencyRow(row);
      if (choiceSupportedByRig(choice)) rawChoices.push(choice);
    });
  frequencyEntriesForSatellite(sat)
    .filter(isMonitoringChannelRow)
    .forEach((row) => {
      const choice = choiceFromMonitoringRow(row);
      if (choiceSupportedByRig(choice)) rawChoices.push(choice);
    });
  return rawChoices.reduce((items, choice) => {
    const key = radioChannelChoiceKey(choice);
    if (!key) return items;
    if (!items.some((item) => item.key === key)) {
      items.push({ ...choice, key });
    }
    return items;
  }, []);
}

function telemetryState(track, pass, mode) {
  const now = Date.now();
  const aosMs = new Date(pass?.aos || 0).getTime();
  const losMs = new Date(pass?.los || 0).getTime();
  const alt = Number(track?.el_deg ?? 0);
  if (mode === "ongoing" || (pass && aosMs <= now && losMs >= now && alt > 0)) {
    return {
      label: "Live Pass",
      tone: "live",
      detail: `LOS in ${fmtCountdown(losMs - now)}`,
    };
  }
  if (alt < 0) {
    return {
      label: "Below Horizon",
      tone: "upcoming",
      detail: `AOS in ${fmtCountdown(aosMs - now)}`,
    };
  }
  return {
    label: "Approaching AOS",
    tone: "upcoming",
    detail: `AOS in ${fmtCountdown(aosMs - now)}`,
  };
}

function metricCardHtml(label, value, meta = "") {
  return `
    <article class="telemetry-metric-card">
      <div class="telemetry-metric-label">${escapeHtml(label)}</div>
      <div class="telemetry-metric-value mono">${escapeHtml(value)}</div>
      ${meta ? `<div class="telemetry-metric-meta">${escapeHtml(meta)}</div>` : ""}
    </article>
  `;
}

function renderFreqRowsHtml(rows) {
  return rows.length
    ? rows.map((r) => `
      <tr>
        <td>
          <div class="freq-mode-title">${escapeHtml(r.mode)}</div>
          <div class="freq-mode-band">${escapeHtml(r.bands || "")}</div>
        </td>
        <td class="mono">${escapeHtml(r.up)}</td>
        <td class="mono">${escapeHtml(r.down)}</td>
      </tr>
    `).join("")
    : '<tr><td colspan="3" class="label">No frequency rows</td></tr>';
}

function renderUpcomingTelemetryPanel({ track, pass, rows, scene, recommendation }) {
  const status = telemetryState(track, pass, scene.mode);
  const satName = track?.name || pass?.name || "--";
  const primary = rows[0] || null;
  const sunlit = track?.sunlit ? "Sunlit" : "In Earth shadow";
  const maxEl = Number(pass?.max_el_deg ?? 0);
  const aosMs = new Date(pass?.aos || 0).getTime();
  const now = Date.now();
  const untilAos = Math.max(0, aosMs - now);
  const title = scene.mode === "iss-upcoming"
    ? (untilAos > 6 * 3600 * 1000 ? "ISS Visible Window Later" : untilAos > 60 * 60 * 1000 ? "ISS Next Visible Window" : "ISS Approaching Pass")
    : (untilAos > 6 * 3600 * 1000 ? "Next Pass Later" : untilAos > 60 * 60 * 1000 ? "Next Pass" : "Approaching Pass");
  const pointMeta = track ? `${track.az_deg.toFixed(1)}° azimuth` : "Track unavailable";
  const altMeta = track
    ? (Number(track.el_deg) >= 0 ? "Currently above horizon" : "Currently below horizon")
    : "Track unavailable";
  const heroTags = [sunlit, `MaxEl ${maxEl.toFixed(1)}°`];
  if (primary?.bands && primary.bands !== "Band unknown") heroTags.push(primary.bands);
  const upcomingRows = rows.slice(0, 4);
  const radioControl = radioControlSupportFromDisplay(pass?.sat_id, recommendation, rows);
  return `
    <section class="telemetry-panel telemetry-panel-upcoming">
      <div class="telemetry-hero-card telemetry-tone-${status.tone}">
        <div class="telemetry-hero-kicker">${escapeHtml(title)}</div>
        <div class="telemetry-hero-main">
          <div>
            <h2 class="telemetry-sat-name">${escapeHtml(satName)}</h2>
            <div class="telemetry-sat-sub">${escapeHtml(heroTags.join(" • "))}</div>
          </div>
          <div class="telemetry-status-stack">
            <span class="telemetry-status-pill telemetry-status-pill-${status.tone}">${escapeHtml(status.label)}</span>
            <div class="telemetry-countdown mono">${escapeHtml(status.detail)}</div>
          </div>
        </div>
      </div>

      <div class="telemetry-card-grid">
        ${metricCardHtml("Pointing", track ? `Az ${track.az_deg.toFixed(1)}°` : "--", pointMeta)}
        ${metricCardHtml("Altitude", track ? `${track.el_deg.toFixed(1)}°` : "--", altMeta)}
        ${metricCardHtml("Range", track ? `${track.range_km.toFixed(1)} km` : "--", pass ? `AOS ${fmtLocal(pass.aos)}` : "")}
        ${metricCardHtml("Pass Window", pass ? `${fmtLocal(pass.aos)} → ${fmtLocal(pass.los)}` : "--", pass ? `Peak ${fmtLocal(pass.tca)}` : "")}
      </div>

      <section class="telemetry-primary-channel-card">
        <div class="telemetry-primary-label">Tune Next</div>
        <div class="telemetry-primary-mode">${escapeHtml(primary?.mode || "No parsed channel available")}</div>
        <div class="telemetry-primary-pairs">
          <div><span>Up</span><strong class="mono">${escapeHtml(primary?.up || "—")}</strong></div>
          <div><span>Down</span><strong class="mono">${escapeHtml(primary?.down || "—")}</strong></div>
          <div><span>Bands</span><strong>${escapeHtml(primary?.bands || "Unknown")}</strong></div>
        </div>
        ${recommendation?.note ? `<div class="telemetry-metric-meta">${escapeHtml(recommendation.note)}</div>` : ""}
        <div class="telemetry-metric-meta">${escapeHtml(radioControl.availability.reason)}</div>
        <div class="controls">
          <button
            type="button"
            data-radio-action="select-session"
            data-sat-id="${escapeHtml(pass?.sat_id || "")}"
            data-sat-name="${escapeHtml(pass?.name || satName)}"
            data-pass-aos="${escapeHtml(pass?.aos || "")}"
            data-pass-los="${escapeHtml(pass?.los || "")}"
            data-max-el="${escapeHtml(String(pass?.max_el_deg ?? ""))}"
            data-fallback-label="${escapeHtml(radioControl.fallbackChoice?.label || "")}"
            data-fallback-uplink-hz="${escapeHtml(String(radioControl.fallbackChoice?.uplink_hz || ""))}"
            data-fallback-downlink-hz="${escapeHtml(String(radioControl.fallbackChoice?.downlink_hz || ""))}"
            data-fallback-uplink-mode="${escapeHtml(radioControl.fallbackChoice?.uplink_mode || "")}"
            data-fallback-downlink-mode="${escapeHtml(radioControl.fallbackChoice?.downlink_mode || "")}"
            ${radioControl.availability.eligible && pass ? "" : " disabled"}
          >Radio Control</button>
        </div>
      </section>

      <section class="telemetry-radio-card">
        <div class="telemetry-section-head">
          <div class="telemetry-section-title">Radio Channels</div>
          <div class="telemetry-section-meta">Top ${Math.min(upcomingRows.length, 4)} channels</div>
        </div>
        <table class="data-table freq-table telemetry-freq-table">
          <thead><tr><th>Mode</th><th>Up</th><th>Down</th></tr></thead>
          <tbody id="telemetryFreqRows">${renderFreqRowsHtml(upcomingRows)}</tbody>
        </table>
      </section>
    </section>
  `;
}

function renderAlternatesHtml(rows) {
  const items = (rows || []).slice(1).filter(isUsefulAlternateRow).slice(0, 2);
  return items.length
    ? items.map((row) => `
      <div class="telemetry-alt-item">
        <div class="telemetry-alt-mode">${escapeHtml(row.mode)}</div>
        <div class="telemetry-alt-pair mono">${escapeHtml(row.up)} | ${escapeHtml(row.down)}</div>
        <div class="telemetry-alt-band">${escapeHtml(row.bands || "Band unknown")}</div>
      </div>
    `).join("")
    : '<div class="telemetry-alt-empty">No alternate channels parsed for this pass.</div>';
}

function renderOngoingRadioOps(primary, rows, variant = "inline", recommendation = null) {
  const rootClass = variant === "card"
    ? "telemetry-radio-card telemetry-ops-card"
    : "telemetry-inline-radio";
  const alternateCount = (rows || []).slice(1).filter(isUsefulAlternateRow).length;
  return `
    <section class="${rootClass}">
      <div class="telemetry-inline-radio-head">
        <div class="telemetry-inline-radio-title">Radio Ops</div>
        <div class="telemetry-inline-radio-meta">${escapeHtml(alternateCount ? "Live channels" : "Primary channel")}</div>
      </div>
      <div class="telemetry-inline-primary">
        <div class="telemetry-inline-primary-label">Tune Now</div>
        <div class="telemetry-inline-primary-mode">${escapeHtml(primary?.mode || "No parsed channel available")}</div>
        <div class="telemetry-inline-primary-pairs">
          <div><span>Up</span><strong class="mono">${escapeHtml(primary?.up || "—")}</strong></div>
          <div><span>Down</span><strong class="mono">${escapeHtml(primary?.down || "—")}</strong></div>
          <div><span>Bands</span><strong>${escapeHtml(primary?.bands || "Band unknown")}</strong></div>
        </div>
        ${recommendation?.note ? `<div class="telemetry-metric-meta">${escapeHtml(recommendation.note)}</div>` : ""}
      </div>
      <div class="telemetry-inline-alternates">
        <div class="telemetry-inline-primary-label">Alternates</div>
        <div class="telemetry-alt-list">
          ${renderAlternatesHtml(rows)}
        </div>
      </div>
    </section>
  `;
}

function renderOngoingVisualAux({ isIss, hasVideo, url, lat, lon, pathItems, pass, track, observerLocation, sunlitText }) {
  if (isIss && hasVideo) {
    return `
      <section class="telemetry-visual-aux telemetry-visual-aux-live">
        <iframe
          id="ongoingVideo"
          title="ISS Ongoing Video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowfullscreen
          src="${escapeHtml(url)}"
        ></iframe>
        <div class="telemetry-visual-meta mono">${escapeHtml(sunlitText)}</div>
      </section>
    `;
  }
  const globe = window.issTrackerHemisphere.render({
    pass,
    pathItems,
    track,
    observerLocation,
    ariaLabel: "Observer-centered hemisphere ground track",
  });
  return `
    <section class="telemetry-visual-aux">
      ${globe}
      <div class="telemetry-visual-meta mono">Lat ${lat.toFixed(2)} | Lon ${lon.toFixed(2)}</div>
    </section>
  `;
}

function renderUpcomingVisualAux({ track, pass, pathItems, observerLocation }) {
  if (!track || !pass || !window.issTrackerHemisphere) return "";
  const lat = Number(track.subpoint_lat ?? 0);
  const lon = Number(track.subpoint_lon ?? 0);
  const globe = window.issTrackerHemisphere.render({
    pass,
    pathItems,
    track,
    observerLocation,
    ariaLabel: "Observer-centered hemisphere preview",
    showTcaLabel: true,
    showDirectionArrow: true,
    emptyText: "Track preview unavailable",
  });
  return `
    <section class="telemetry-visual-aux">
      ${globe}
      <div class="telemetry-visual-meta mono">Lat ${lat.toFixed(2)} | Lon ${lon.toFixed(2)}</div>
    </section>
  `;
}

function renderOngoingTelemetryPanel({ track, pass, rows, isIss, hasVideo, url, lat, lon, pathItems, observerLocation, recommendation }) {
  const status = telemetryState(track, pass, "ongoing");
  const satName = track?.name || pass?.name || "--";
  const primary = rows[0] || null;
  const sunlitText = track?.sunlit ? "Sunlit" : "In Earth shadow";
  const maxEl = Number(pass?.max_el_deg ?? 0);
  const losMs = new Date(pass?.los || 0).getTime();
  const heroKicker = isIss ? "Live ISS Pass" : "Live Pass";
  const heroTags = [track?.sunlit ? "Sunlit now" : "Shadowed now", `Peak ${maxEl.toFixed(1)}°`];
  if (isIss) heroTags.push(hasVideo ? "Video feed active" : "Map fallback");
  const losDetail = losMs ? `LOS in ${fmtCountdown(losMs - Date.now())}` : status.detail;
  return `
    <section class="telemetry-panel telemetry-panel-ongoing">
      <div class="telemetry-hero-card telemetry-tone-live">
        <div class="telemetry-hero-kicker">${escapeHtml(heroKicker)}</div>
        <div class="telemetry-hero-main">
          <div>
            <h2 class="telemetry-sat-name">${escapeHtml(satName)}</h2>
            <div class="telemetry-sat-sub">${escapeHtml(heroTags.join(" • "))}</div>
          </div>
          <div class="telemetry-status-stack">
            <span class="telemetry-status-pill telemetry-status-pill-live">${escapeHtml("In View")}</span>
            <div class="telemetry-countdown mono">${escapeHtml(losDetail)}</div>
          </div>
        </div>
      </div>

      <div class="telemetry-card-grid telemetry-card-grid-live">
        ${metricCardHtml("Azimuth", track ? `${track.az_deg.toFixed(1)}°` : "--", "Current pointing")}
        ${metricCardHtml("Altitude", track ? `${track.el_deg.toFixed(1)}°` : "--", "Live elevation")}
        ${metricCardHtml("Range", track ? `${track.range_km.toFixed(1)} km` : "--", pass ? `Peak ${fmtLocal(pass.tca)}` : "")}
        ${metricCardHtml("LOS", pass ? fmtLocal(pass.los) : "--", pass ? `AOS ${fmtLocal(pass.aos)}` : "")}
      </div>

      ${renderOngoingRadioOps(primary, rows, "card", recommendation)}

    </section>
  `;
}

function renderOngoingVideoPanel({ readout, passTime, diag, rows, url }) {
  return `
    <div id="telemetryReadout" class="mono telemetry-readout">${escapeHtml(readout)}</div>
    <div id="telemetryPassTime" class="mono telemetry-readout">${escapeHtml(passTime)}</div>
    <div id="telemetryDiag" class="mono">${escapeHtml(diag)}</div>
    <iframe id="ongoingVideo" title="ISS Ongoing Video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen src="${escapeHtml(url)}"></iframe>
    <div class="scene-overlay mono">ISS ongoing pass with eligible video</div>
    <table class="data-table freq-table"><thead><tr><th>Mode</th><th>Up</th><th>Down</th></tr></thead><tbody id="telemetryFreqRows">${renderFreqRowsHtml(rows)}</tbody></table>
  `;
}

function renderOngoingMapPanel({ readout, passTime, diag, rows, lat, lon, pts }) {
  return `
    <div id="telemetryReadout" class="mono telemetry-readout">${escapeHtml(readout)}</div>
    <div id="telemetryPassTime" class="mono telemetry-readout">${escapeHtml(passTime)}</div>
    <svg viewBox="0 0 100 100" class="rotator-map">
      <rect x="0" y="0" width="100" height="100" fill="#4a1820"></rect>
      <path d="M0,50 L100,50 M50,0 L50,100" stroke="rgba(255,240,222,0.18)" stroke-width="0.35"></path>
      <polyline points="${pts}" fill="none" stroke="#ff7a59" stroke-width="0.8"></polyline>
      <circle cx="${((lon + 180) / 360 * 100).toFixed(2)}" cy="${((90 - lat) / 180 * 100).toFixed(2)}" r="1.6" fill="#3fe0c5"></circle>
    </svg>
    <div class="scene-overlay mono">Live map proxy | lat ${lat.toFixed(2)} lon ${lon.toFixed(2)}</div>
    <div id="telemetryDiag" class="mono">${escapeHtml(diag)}</div>
    <table class="data-table freq-table"><thead><tr><th>Mode</th><th>Up</th><th>Down</th></tr></thead><tbody id="telemetryFreqRows">${renderFreqRowsHtml(rows)}</tbody></table>
  `;
}

function passDurationMinutes(pass) {
  return (new Date(pass.los).getTime() - new Date(pass.aos).getTime()) / 60000;
}

function setIso(date) {
  return new Date(date).toISOString();
}

function synthesizePassForPhase(pass, phase) {
  if (!pass || !phase || phase === "real-time") return pass;
  const next = { ...pass };
  const now = Date.now();
  if (phase === "before-aos") {
    next.aos = setIso(now + 7 * 60 * 1000);
    next.tca = setIso(now + 12 * 60 * 1000);
    next.los = setIso(now + 17 * 60 * 1000);
  } else if (phase === "at-aos") {
    next.aos = setIso(now - 15 * 1000);
    next.tca = setIso(now + 5 * 60 * 1000);
    next.los = setIso(now + 10 * 60 * 1000);
  } else if (phase === "mid-pass") {
    next.aos = setIso(now - 5 * 60 * 1000);
    next.tca = setIso(now);
    next.los = setIso(now + 5 * 60 * 1000);
  } else if (phase === "near-los") {
    next.aos = setIso(now - 9 * 60 * 1000);
    next.tca = setIso(now - 4 * 60 * 1000);
    next.los = setIso(now + 90 * 1000);
  }
  return next;
}

function synthesizeTrackForPhase(track, pass, phase) {
  if (!track) return track;
  if (!phase || phase === "real-time") return { ...track };
  const next = { ...track, timestamp: setIso(Date.now()) };
  if (phase === "before-aos") {
    next.el_deg = -6;
  } else if (phase === "at-aos") {
    next.el_deg = 1.8;
  } else if (phase === "mid-pass") {
    next.el_deg = Math.max(22, Number(pass?.max_el_deg || 30) * 0.72);
  } else if (phase === "near-los") {
    next.el_deg = 5.5;
  }
  next.range_km = Math.max(350, Number(next.range_km || 1200));
  return next;
}

function applyDeveloperSystemOverrides(system) {
  const overrides = getDeveloperOverrides();
  if (!overrides.enabled) return system;
  const next = clone(system);
  if (overrides.force_iss_video_eligible && next?.iss) next.iss.videoEligible = true;
  if (overrides.force_iss_stream_healthy && next?.iss) next.iss.streamHealthy = true;
  return next;
}

function selectOverridePass(passes, sceneMode, satId) {
  const all = passes || [];
  const satFiltered = satId ? all.filter((p) => p.sat_id === satId) : all;
  if (sceneMode === "iss-upcoming") {
    return satFiltered.find((p) => isIssPass(p) && isRotatorEligiblePass(p) && passMeetsRotatorElevation(p))
      || all.find((p) => isIssPass(p) && isRotatorEligiblePass(p) && passMeetsRotatorElevation(p))
      || null;
  }
  const qualified = satFiltered.filter(isRotatorAllowedSat).filter(isRotatorEligiblePass);
  const ongoing = qualified.find((p) => new Date(p.aos).getTime() <= Date.now() && new Date(p.los).getTime() >= Date.now());
  if (sceneMode === "ongoing" && ongoing) return ongoing;
  const upcoming = qualified
    .filter((p) => passMeetsRotatorElevation(p))
    .sort((a, b) => new Date(a.aos).getTime() - new Date(b.aos).getTime());
  return upcoming[0] || qualified[0] || null;
}

function appendDebugBadge(text) {
  const overrides = getDeveloperOverrides();
  if (!overrides.enabled || !overrides.show_debug_badge) return text;
  return `${text} [DEV]`;
}

function resolveDeveloperScene(system, passes) {
  const overrides = getDeveloperOverrides();
  if (!overrides.enabled || !overrides.force_scene || overrides.force_scene === "auto") return null;
  const forceScene = overrides.force_scene;
  if (forceScene === "passes" || forceScene === "radio" || forceScene === "video") {
    return { key: `debug:${forceScene}`, mode: forceScene, debug: true };
  }
  const pass = selectOverridePass(passes, forceScene, "");
  const phase = forceScene === "ongoing" ? "mid-pass" : "real-time";
  const adjustedPass = synthesizePassForPhase(pass, phase);
  const sourceTrack = (system.tracks || []).find((t) => t.sat_id === adjustedPass?.sat_id)
    || system.activeTrack
    || system.issTrack;
  const track = synthesizeTrackForPhase(sourceTrack, adjustedPass, phase);
  return {
    key: `debug:${forceScene}:${adjustedPass?.sat_id || "none"}`,
    mode: forceScene,
    pass: adjustedPass,
    track,
    debug: true,
    debugPhase: phase,
    };
}

function isRotatorEligiblePass(pass) {
  const duration = passDurationMinutes(pass);
  if (!Number.isFinite(duration) || duration <= 0) return false;
  if (isIssPass(pass)) return true;
  return duration <= MAX_ROTATOR_PASS_DURATION_MIN;
}

function passMeetsRotatorElevation(pass) {
  return Number(pass.max_el_deg) >= (isIssPass(pass) ? 10 : 40);
}

function filterConsolePasses(passes) {
  const now = Date.now();
  return (passes || [])
    .filter(isRotatorAllowedSat)
    .filter((p) => new Date(p.aos).getTime() > now)
    .filter(isRotatorEligiblePass)
    .filter(passMeetsRotatorElevation);
}

function pickOngoingPass(system, passes) {
  const nowMs = Date.now();
  const tracks = system?.tracks || [];
  const ongoingPasses = (passes || [])
    .filter(isRotatorAllowedSat)
    .filter((p) => new Date(p.aos).getTime() <= nowMs && new Date(p.los).getTime() >= nowMs)
    .filter(isRotatorEligiblePass)
    .filter(passMeetsRotatorElevation)
    .map((p) => ({ pass: p, track: tracks.find((t) => t.sat_id === p.sat_id) }))
    .filter((x) => x.track && Number(x.track.el_deg) > 0);
  if (!ongoingPasses.length) return null;
  ongoingPasses.sort((a, b) => b.track.el_deg - a.track.el_deg);
  return ongoingPasses[0];
}

function buildRotationSequence(system, passes) {
  const nowMs = Date.now();
  const upcoming = (passes || [])
    .filter(isRotatorAllowedSat)
    .filter((p) => new Date(p.aos).getTime() > nowMs)
    .filter(isRotatorEligiblePass)
    .filter(passMeetsRotatorElevation);
  const issUpcoming = upcoming.find((p) => isIssPass(p) && passMeetsRotatorElevation(p));
  const exclusionKey = issUpcoming ? stablePassKey(issUpcoming) : "";
  const nonOngoingCandidates = upcoming.filter((p) => Number(p.max_el_deg) >= 40);
  const nextFour = [];
  for (const p of nonOngoingCandidates) {
    const k = stablePassKey(p);
    if (k === exclusionKey) continue;
    if (nextFour.some((x) => stablePassKey(x) === k)) continue;
    nextFour.push(p);
    if (nextFour.length >= 4) break;
  }

  const seq = [];
  if (issUpcoming) seq.push({ key: `telemetry:${stablePassKey(issUpcoming)}`, mode: "iss-upcoming", pass: issUpcoming });
  seq.push({ key: "passes", mode: "passes" });
  nextFour.forEach((p) => seq.push({ key: `telemetry:${stablePassKey(p)}`, mode: "upcoming", pass: p }));
  seq.push({ key: "radio", mode: "radio" });
  return seq;
}

function setSceneVisible(id) {
  ["sceneVideo", "sceneTelemetry", "scenePasses", "sceneRadio", "sceneAprs"].forEach((x) => trackerById(x).classList.add("hidden"));
  trackerById(id).classList.remove("hidden");
}

function renderVideoScene(system) {
  setSceneVisible("sceneVideo");
  const urls = getVideoSources();
  const url = urls[Math.min(activeVideoSource, urls.length - 1)];
  const iframe = trackerById("rotatorVideo");
  if (iframe.src !== url) iframe.src = url;
  const iss = system.iss || {};
  trackerById("videoOverlay").textContent =
    `Sunlit=${iss.sunlit ? "yes" : "no"} | AboveHorizon=${iss.aboveHorizon ? "yes" : "no"} | Source=${activeVideoSource === 0 ? "primary" : "secondary"}`;
  if (developerOverridesEnabled() && getDeveloperOverrides().show_debug_badge) {
    trackerById("videoOverlay").textContent += " | DEV override";
  }
}

async function renderTelemetryScene(system, scene) {
  setSceneVisible("sceneTelemetry");
  const right = trackerById("telemetryRight");
  const leftAux = trackerById("telemetryLeftAux");
  const tracks = system.tracks || [];
  const targetSatId = scene.pass?.sat_id || scene.track?.sat_id || system.issTrack?.sat_id;
  const track = scene.track || tracks.find((t) => t.sat_id === targetSatId) || system.issTrack;
  const sat = (state.sats || []).find((s) => s.sat_id === targetSatId);
  const pass = scene.pass;
  const pathItems = pass ? await ensurePathForDisplayedPass(system, pass) : [];
  const recommendation = pass?.frequencyRecommendation || null;
  const matrix = pass?.frequencyMatrix || null;
  trackerById("telemetryTitle").textContent =
    appendDebugBadge(scene.mode === "ongoing"
      ? `Ongoing Pass - ${track?.name || "--"}`
      : scene.mode === "iss-upcoming"
        ? "ISS Upcoming Visible Pass"
        : `Upcoming Pass - ${track?.name || "--"}`);

  if (track) {
    const telemetryReadout = `Az ${track.az_deg.toFixed(1)}° | Alt ${track.el_deg.toFixed(1)}° | Range ${track.range_km.toFixed(1)} km`;
    const telemetryDiag = `Sat ${track.name} (${track.sat_id}) | Sunlit=${track.sunlit ? "yes" : "no"} | UTC ${system.timestamp}`;
    const telemetryPassTime = pass
      ? `AOS ${fmtLocal(pass.aos)} | TCA ${fmtLocal(pass.tca)} | LOS ${fmtLocal(pass.los)} | MaxEl ${pass.max_el_deg.toFixed(1)}°`
      : "AOS -- | TCA -- | LOS --";

    renderSkyplot(track, system.bodies || [], pass, pathItems);
    const staticRows = buildFreqRows(sat);
    const debugMeta = scene.debug ? debugPhaseLabel(scene.debugPhase) : "";
    const rows = rowsFromGuide(recommendation, matrix, scene.mode, debugMeta).length
      ? rowsFromGuide(recommendation, matrix, scene.mode, debugMeta)
      : staticRows;

    if (scene.mode !== "ongoing") {
      leftAux.innerHTML = renderUpcomingVisualAux({
        track,
        pass,
        pathItems,
        observerLocation: system.location,
      });
      right.innerHTML = renderUpcomingTelemetryPanel({ track, pass, rows, scene, recommendation });
      return;
    }

    const lat = Number(track?.subpoint_lat ?? 0);
    const lon = Number(track?.subpoint_lon ?? 0);
    const isIss = isIssPass({ sat_id: targetSatId, name: track?.name || "" });
    const hasVideo = isIss && system.iss?.videoEligible && system.iss?.streamHealthy;
    const url = hasVideo ? getVideoSources()[Math.min(activeVideoSource, getVideoSources().length - 1)] : "";
    leftAux.innerHTML = renderOngoingVisualAux({
      isIss,
      hasVideo,
      url,
      lat,
      lon,
      pathItems,
      pass,
      track,
      observerLocation: system.location,
      sunlitText: track?.sunlit ? "Sunlit" : "In Earth shadow",
    });
    right.innerHTML = renderOngoingTelemetryPanel({
      track,
      pass,
      rows,
      isIss,
      hasVideo,
      url,
      lat,
      lon,
      pathItems,
      observerLocation: system.location,
      recommendation,
    });
  } else {
    leftAux.innerHTML = "";
    right.innerHTML = `
      <section class="telemetry-panel telemetry-panel-upcoming">
        <div class="telemetry-hero-card telemetry-tone-upcoming">
          <div class="telemetry-hero-kicker">Tracking Unavailable</div>
          <div class="telemetry-hero-main">
            <div>
              <h2 class="telemetry-sat-name">${escapeHtml(pass?.name || "--")}</h2>
              <div class="telemetry-sat-sub">Waiting for live track recovery</div>
            </div>
            <div class="telemetry-status-stack">
              <span class="telemetry-status-pill telemetry-status-pill-upcoming">No Live Data</span>
              <div class="telemetry-countdown mono">${pass ? `AOS ${escapeHtml(fmtLocal(pass.aos))}` : "--"}</div>
            </div>
          </div>
        </div>
      </section>
    `;
  }
}

function renderPassesScene(passes) {
  setSceneVisible("scenePasses");
  const now = Date.now();
  const items = filterConsolePasses(passes).slice(0, 6);
  const next = items[0] || null;
  const queue = items.slice(1, 4);
  const nextCountdown = next ? fmtCountdown(new Date(next.aos).getTime() - now) : "None in 24h";
  const nextLabel = next ? passPriorityLabel(next) : "No qualifying window";
  const nextAosTime = next ? fmtLocal(next.aos) : "--";
  const nextPeakTime = next ? fmtLocal(next.tca) : "--";
  const nextLosTime = next ? fmtLocal(next.los) : "--";
  trackerById("passesMeta").innerHTML = `
    <div class="passes-summary-card passes-summary-card-primary">
      <div class="passes-summary-label">Next AOS</div>
      <div class="passes-summary-value mono">${escapeHtml(nextCountdown)}</div>
      <div class="passes-summary-meta">${escapeHtml(nextLabel)}</div>
    </div>
    <div class="passes-summary-tags">
      <div class="passes-summary-tag">
        <span class="passes-summary-tag-label">Timezone</span>
        <strong>${escapeHtml(state.timezone || "UTC")}</strong>
      </div>
      <div class="passes-summary-tag">
        <span class="passes-summary-tag-label">Filter</span>
        <strong>ISS &gt;=10°, others &gt;=40°</strong>
      </div>
    </div>
    ${rotatorActionError ? `
      <div class="passes-summary-card passes-summary-card-dev">
        <div class="passes-summary-label">Radio Control</div>
        <div class="passes-summary-value">${escapeHtml(rotatorActionError)}</div>
      </div>
    ` : ""}
  `;
  if (developerOverridesEnabled() && getDeveloperOverrides().show_debug_badge) {
    trackerById("passesMeta").insertAdjacentHTML("beforeend", `
      <div class="passes-summary-card passes-summary-card-dev">
        <div class="passes-summary-label">Mode</div>
        <div class="passes-summary-value">DEV override</div>
      </div>
    `);
  }
  trackerById("rotatorPassRows").innerHTML = items.length
    ? items.map((p, idx) => `
      <tr class="${idx === 0 ? "selected-row" : ""}">
        <td>
          <div class="passes-sat-cell">
            ${idx === 0 ? '<span class="passes-next-badge">Next</span>' : ""}
            <div>
              <strong>${escapeHtml(p.name)}</strong>
              ${passRowMeta(p) ? `<div class="passes-sat-meta">${escapeHtml(passRowMeta(p))}</div>` : ""}
            </div>
          </div>
        </td>
        <td class="mono">${escapeHtml(fmtLocal(p.aos))}</td>
        <td class="mono">${escapeHtml(fmtLocal(p.tca))}</td>
        <td class="mono">${escapeHtml(fmtLocal(p.los))}</td>
        <td class="mono">${escapeHtml(`${p.max_el_deg.toFixed(1)}°`)}</td>
        <td>
          <button
            type="button"
            class="passes-radio-action"
            data-radio-action="select-session"
            data-sat-id="${escapeHtml(p.sat_id)}"
            data-sat-name="${escapeHtml(p.name)}"
            data-pass-aos="${escapeHtml(p.aos)}"
            data-pass-los="${escapeHtml(p.los)}"
            data-max-el="${escapeHtml(String(p.max_el_deg))}"
            onclick="window.orbitDeckSelectRadioControlSession?.(this)"
          >Radio Control</button>
          ${passSupportsAprs(p) ? `
            <button
              type="button"
              class="passes-radio-action"
              data-aprs-action="select-session"
              data-sat-id="${escapeHtml(p.sat_id)}"
              data-sat-name="${escapeHtml(p.name)}"
              onclick="window.orbitDeckSelectAprsSession?.(this.dataset.satId, this.dataset.satName || '')"
            >APRS</button>
          ` : ""}
        </td>
      </tr>`).join("")
    : '<tr><td colspan="6" class="label">No qualifying passes</td></tr>';

  trackerById("passesFocus").innerHTML = next
    ? `
      <div class="passes-focus-head">
        <div class="passes-focus-kicker">Next Pass</div>
        <div class="passes-focus-countdown mono">AOS in ${escapeHtml(nextCountdown)}</div>
      </div>
      <div class="passes-focus-body">
        <div class="passes-focus-summary">
          <div>
          <div class="passes-focus-name">${escapeHtml(next.name)}</div>
          <div class="passes-focus-sub">${escapeHtml(nextLabel)}</div>
          </div>
          <button
            type="button"
            class="passes-radio-action passes-focus-action"
            data-radio-action="select-session"
            data-sat-id="${escapeHtml(next.sat_id)}"
            data-sat-name="${escapeHtml(next.name)}"
            data-pass-aos="${escapeHtml(next.aos)}"
            data-pass-los="${escapeHtml(next.los)}"
            data-max-el="${escapeHtml(String(next.max_el_deg))}"
            onclick="window.orbitDeckSelectRadioControlSession?.(this)"
          >Radio Control</button>
          ${passSupportsAprs(next) ? `
            <button
              type="button"
              class="passes-radio-action passes-focus-action"
              data-aprs-action="select-session"
              data-sat-id="${escapeHtml(next.sat_id)}"
              data-sat-name="${escapeHtml(next.name)}"
              onclick="window.orbitDeckSelectAprsSession?.(this.dataset.satId, this.dataset.satName || '')"
            >APRS</button>
          ` : ""}
        </div>
        <div class="passes-focus-grid">
          <div><span>AOS</span><strong class="mono">${escapeHtml(nextAosTime)}</strong></div>
          <div><span>Peak</span><strong class="mono">${escapeHtml(nextPeakTime)}</strong></div>
          <div><span>LOS</span><strong class="mono">${escapeHtml(nextLosTime)}</strong></div>
          <div><span>Max El</span><strong class="mono">${escapeHtml(`${next.max_el_deg.toFixed(1)}°`)}</strong></div>
        </div>
      </div>
      <div class="passes-focus-queue">
        <div class="passes-focus-queue-title">Queue</div>
        ${queue.length
          ? queue.map((p) => `
            <div class="passes-queue-item">
              <div class="passes-queue-head">
                <div class="passes-queue-name">${escapeHtml(p.name)}</div>
                <div class="passes-queue-delta mono">${escapeHtml(passQueueDelta(p.aos))}</div>
              </div>
              <div class="passes-queue-meta mono">${escapeHtml(fmtLocal(p.aos))} · ${escapeHtml(`${p.max_el_deg.toFixed(1)}°`)}</div>
            </div>
          `).join("")
          : '<div class="passes-focus-empty">No additional qualifying passes.</div>'}
      </div>
    `
    : '<div class="passes-focus-empty">No qualifying passes in the next 24 hours.</div>';
}

function renderRigOpsCard(pass, runtime) {
  const targets = runtime?.targets || {};
  const labelLeft = targets.main_label || targets.vfo_a_label || "TX";
  const labelRight = targets.sub_label || targets.vfo_b_label || "RX";
  const valueLeft = targets.main_freq_hz || targets.vfo_a_freq_hz || "--";
  const valueRight = targets.sub_freq_hz || targets.vfo_b_freq_hz || "--";
  const status = runtime?.connected ? `Connected | ${runtime.rig_model || "--"}` : `Disconnected | ${runtime?.rig_model || "--"}`;
  return `
    <article class="radio-primary-card radio-rig-card">
      <div class="radio-card-label">Rig Control</div>
      <div class="radio-sat-name">${escapeHtml(status)}</div>
      <div class="radio-pass-time mono">${escapeHtml(runtime?.last_error || "No active radio error")}</div>
      <div class="radio-channel">
        <div class="radio-channel-mode">Applied Targets</div>
        <div class="radio-pair">
          <div class="radio-pair-label">${escapeHtml(labelLeft)}</div>
          <div class="radio-pair-value mono">${escapeHtml(normalizeFreqToken(String(valueLeft)))}</div>
        </div>
        <div class="radio-pair">
          <div class="radio-pair-label">${escapeHtml(labelRight)}</div>
          <div class="radio-pair-value mono">${escapeHtml(normalizeFreqToken(String(valueRight)))}</div>
        </div>
        <div class="radio-band-line">${escapeHtml(pass ? `${pass.name} | AOS ${fmtLocal(pass.aos)}` : "No primary radio pass selected")}</div>
      </div>
      <div class="controls">
        <button id="radioApplyBtn" type="button"${pass ? "" : " disabled"}>Apply to Rig</button>
        <button id="radioAutoStartBtn" type="button"${pass ? "" : " disabled"}>Start Auto-Track</button>
        <button id="radioAutoStopBtn" type="button">Stop Auto-Track</button>
      </div>
    </article>
  `;
}

function renderPinnedRadioControl(session, pass, runtime) {
  const passState = radioSessionPassState(session);
  const testPair = session?.test_pair || null;
  const targets = runtime?.targets || {};
  const txLabel = targets.main_label || targets.vfo_a_label || "TX";
  const rxLabel = targets.sub_label || targets.vfo_b_label || "RX";
  const txValue = targets.main_freq_hz || targets.vfo_a_freq_hz || "--";
  const rxValue = targets.sub_freq_hz || targets.vfo_b_freq_hz || "--";
  const txMode = targets.main_mode || targets.vfo_a_mode || "--";
  const rxMode = targets.sub_mode || targets.vfo_b_mode || "--";
  const connected = !!runtime?.connected;
  const eligible = !!session?.is_eligible;
  const canTest = connected && eligible && !!session?.has_test_pair;
  const inTest = session?.screen_state === "test";
  const inActive = session?.screen_state === "active";
  const inArmed = session?.screen_state === "armed";
  const connectLabel = connected ? "Disconnect Radio" : "Connect Radio";
  const testLabel = inTest ? "Stop Radio Test" : "Test Radio Control";
  const startLabel = (inActive || inArmed)
    ? "Disarm Radio Control"
    : (passState === "above horizon" ? "Start Radio Control for Pass" : "Arm Radio Control for Pass");
  const showBack = !inArmed && !inActive;
  const testTx = testPair?.uplink_mhz ? normalizeFreqToken(String(Math.round(testPair.uplink_mhz * 1_000_000))) : "--";
  const testRx = testPair?.downlink_mhz ? normalizeFreqToken(String(Math.round(testPair.downlink_mhz * 1_000_000))) : "--";
  const channelChoices = buildRadioChannelChoices(session, pass);
  const currentChoice = choiceFromRecommendation(testPair, "Active test pair");
  const currentChoiceKey = currentChoice ? radioChannelChoiceKey(currentChoice) : "";
  const persistedDraftKey = loadPersistedRadioChannelDraft(session);
  const selectedChoiceKey = channelChoices.some((choice) => choice.key === radioChannelDraftKey)
    ? radioChannelDraftKey
    : channelChoices.some((choice) => choice.key === persistedDraftKey)
      ? persistedDraftKey
      : currentChoiceKey;
  radioChannelDraftKey = selectedChoiceKey;
  savePersistedRadioChannelDraft(session, selectedChoiceKey);
  const showCommitChannel = !!selectedChoiceKey && selectedChoiceKey !== currentChoiceKey;
  const commitChannelLabel = connected ? "Commit Channel To Rig" : "Save Channel Choice";
  const groupedChannelOptions = ["Voice", "Monitoring"].map((group) => ({
    group,
    items: channelChoices.filter((choice) => (choice.group || "Voice") === group),
  })).filter((section) => section.items.length);
  trackerById("radioPrimary").textContent = `Radio Control: ${session?.selected_sat_name || session?.selected_sat_id || "--"} | ${passState.toUpperCase()} | ${session?.screen_state || "idle"}`;
  trackerById("radioBoard").innerHTML = `
    <article class="radio-primary-card radio-session-card">
      <div class="radio-card-label">Pinned Radio Control</div>
      <div class="radio-sat-name">${escapeHtml(session?.selected_sat_name || session?.selected_sat_id || "--")}</div>
      <div class="radio-pass-time mono">AOS ${escapeHtml(session?.selected_pass_aos ? fmtLocal(session.selected_pass_aos) : "--")} | LOS ${escapeHtml(session?.selected_pass_los ? fmtLocal(session.selected_pass_los) : "--")} | MaxEl ${escapeHtml(session?.selected_max_el_deg != null ? `${Number(session.selected_max_el_deg).toFixed(1)}°` : "--")}</div>
      <div class="radio-channel">
        <div class="radio-channel-mode">Session State</div>
        <div class="radio-band-line">Pass: ${escapeHtml(passState)} | Screen: ${escapeHtml(session?.screen_state || "idle")} | Control: ${escapeHtml(session?.control_state || "not_connected")}</div>
        <div class="radio-band-line">${escapeHtml(session?.eligibility_reason || "Satellite is eligible for VHF/UHF radio control")}</div>
        <div class="radio-band-line">${escapeHtml(pinnedRadioStatusLine(session, runtime))}</div>
      </div>
      <div class="radio-channel">
        <div class="radio-channel-mode">Applied Targets</div>
        <div class="radio-pair">
          <div class="radio-pair-label">${escapeHtml(txLabel)}</div>
          <div class="radio-pair-value mono">${escapeHtml(normalizeFreqToken(String(txValue)))}</div>
        </div>
        <div class="radio-pair">
          <div class="radio-pair-label">${escapeHtml(rxLabel)}</div>
          <div class="radio-pair-value mono">${escapeHtml(normalizeFreqToken(String(rxValue)))}</div>
        </div>
        <div class="radio-band-line">Modes: ${escapeHtml(String(txMode))} / ${escapeHtml(String(rxMode))}</div>
      </div>
      <div class="radio-channel">
        <div class="radio-channel-mode">Test Pair</div>
        <div class="radio-pair">
          <div class="radio-pair-label">TX</div>
          <div class="radio-pair-value mono">${escapeHtml(testTx)}</div>
        </div>
        <div class="radio-pair">
          <div class="radio-pair-label">RX</div>
          <div class="radio-pair-value mono">${escapeHtml(testRx)}</div>
        </div>
        <div class="radio-band-line">${escapeHtml(session?.test_pair_reason || "Default profile voice pair ready")}</div>
      </div>
      ${channelChoices.length > 1 ? `
      <div class="radio-channel">
        <div class="radio-channel-mode">Channel Options</div>
        <label class="radio-channel-picker">
          <span class="label">Selectable pairs</span>
          <select id="radioChannelSelect">
            ${groupedChannelOptions.map((section) => `
              <optgroup label="${escapeHtml(section.group)}">
                ${section.items.map((choice) => `
                  <option value="${escapeHtml(choice.key)}"${choice.key === selectedChoiceKey ? " selected" : ""}>${escapeHtml(choice.label)} | ${escapeHtml(choice.detail)}</option>
                `).join("")}
              </optgroup>
            `).join("")}
          </select>
        </label>
        ${showCommitChannel ? `<div class="controls radio-session-actions"><button id="radioCommitChannelBtn" type="button">${escapeHtml(commitChannelLabel)}</button></div>` : ""}
      </div>
      ` : ""}
      <div class="controls radio-session-actions">
        <button id="radioSessionConnectBtn" type="button">${escapeHtml(connectLabel)}</button>
        <button id="radioSessionTestBtn" type="button"${inTest || canTest ? "" : " disabled"}>${escapeHtml(testLabel)}</button>
        <button id="radioSessionStartBtn" type="button"${((inActive || inArmed) || (connected && eligible && passState !== "ended")) ? "" : " disabled"}${passState === "above horizon" && eligible && !inActive && !inArmed ? ' class="radio-session-go-live"' : ""}>${escapeHtml(startLabel)}</button>
        ${showBack ? '<button id="radioSessionBackBtn" type="button">Back to Rotator</button>' : ""}
      </div>
      <div class="radio-band-line">Note: CI-V control can take up to 60 seconds to stabilize. Please wait for session-state feedback and do not click the button multiple times.</div>
    </article>
  `;
}

function aprsPacketSummary(packet) {
  if (!packet) return "--";
  if (packet.packet_type === "message") {
    return `Msg to ${packet.addressee || packet.destination}: ${packet.text || "--"}`;
  }
  if (packet.packet_type === "position") {
    const pos = (packet.latitude != null && packet.longitude != null)
      ? `${Number(packet.latitude).toFixed(3)}, ${Number(packet.longitude).toFixed(3)}`
      : "Position";
    return `${pos}${packet.text ? ` | ${packet.text}` : ""}`;
  }
  if (packet.packet_type === "status") {
    return packet.text || "Status";
  }
  return packet.text || packet.raw_tnc2 || "--";
}

function renderAprsPacketFeed(runtime) {
  const packets = Array.isArray(runtime?.recent_packets) ? runtime.recent_packets.slice(0, 10) : [];
  const nowMs = Date.now();
  return packets.length
    ? packets.map((packet) => {
      const key = packetKey(packet);
      if (!aprsSceneState.packetHighlights.has(key) && !aprsSceneState.lastFeedKeys.includes(key)) {
        aprsSceneState.packetHighlights.set(key, nowMs);
      }
      const started = aprsSceneState.packetHighlights.get(key);
      const isNew = Number.isFinite(started) && (nowMs - started) < 4000;
      return `
        <div class="aprs-packet-row${isNew ? " aprs-packet-row-new" : ""}">
          <div class="aprs-packet-head">
            <strong>${escapeHtml(packet.source || "--")}</strong>
            <span class="mono">${escapeHtml(fmtLocal(packet.received_at))}</span>
          </div>
          <div class="aprs-packet-meta">${escapeHtml((packet.packet_type || "raw").toUpperCase())}${packet.addressee ? ` | ${escapeHtml(packet.addressee)}` : ""}</div>
          <div class="aprs-packet-text">${escapeHtml(aprsPacketSummary(packet))}</div>
        </div>
      `;
    }).join("")
    : '<div class="radio-empty">No APRS packets received yet.</div>';
}

function renderAprsSceneCard(system) {
  const runtime = system?.aprsRuntime || {};
  const settings = system?.aprsSettings || {};
  const target = derivedAprsTarget(system);
  const heard = Array.isArray(runtime?.heard_stations) ? runtime.heard_stations.slice(0, 5) : [];
  const connected = !!runtime?.connected;
  const isSatellite = target?.operating_mode === "satellite";
  const modeLine = target?.mode || target?.channel_label || "--";
  const targetFreq = target?.corrected_frequency_hz || target?.frequency_hz || null;
  const uplinkFreq = target?.corrected_uplink_hz || target?.uplink_hz || null;
  const downlinkFreq = target?.corrected_downlink_hz || target?.downlink_hz || null;
  const passText = isSatellite
    ? (target?.pass_active
      ? `Pass active until ${fmtLocal(target.pass_los)}`
      : target?.pass_aos
        ? `Next pass ${fmtLocal(target.pass_aos)} to ${fmtLocal(target.pass_los)}`
        : "No pass in current window")
    : "Terrestrial APRS does not require a pass";
  const correction = target?.correction_side
    ? `Doppler ${String(target.correction_side).replaceAll("_", " ")} | ${target.active_phase || "--"} | ${normalizeFreqToken(String(target.corrected_frequency_hz || target.frequency_hz || "--"))}`
    : "No Doppler correction required";
  return `
    <article class="radio-primary-card aprs-session-card">
      <div class="radio-card-label">Pinned APRS</div>
      <div class="radio-sat-name">${escapeHtml(target?.label || "No APRS target selected")}</div>
      <div class="radio-pass-time mono">${escapeHtml(passText)}</div>
      <div class="radio-channel">
        <div class="radio-channel-mode">Session State</div>
        <div class="radio-band-line">Mode: ${escapeHtml(settings.operating_mode || "--")} | ${connected ? "Connected" : "Disconnected"}</div>
        <div class="radio-band-line">Channel: ${escapeHtml(modeLine)}</div>
        <div class="radio-band-line">PATH: ${escapeHtml(target?.path_default || "--")}</div>
        <div class="radio-band-line">Target: ${escapeHtml(normalizeFreqToken(String(targetFreq || "--")))}</div>
        <div class="radio-band-line">Uplink: ${escapeHtml(normalizeFreqToken(String(uplinkFreq || "--")))}</div>
        <div class="radio-band-line">Downlink: ${escapeHtml(normalizeFreqToken(String(downlinkFreq || "--")))}</div>
        <div class="radio-band-line">${escapeHtml(target?.tx_block_reason || target?.reason || "Transmit allowed")}</div>
      </div>
      <div class="radio-channel">
        <div class="radio-channel-mode">Doppler</div>
        <div class="radio-band-line">${escapeHtml(correction)}</div>
        <div class="radio-band-line">${escapeHtml(target?.retune_active ? "Auto-tune active" : "Auto-tune idle")}</div>
      </div>
      <div class="radio-channel">
        <div class="radio-channel-mode">Heard Summary</div>
        <div class="radio-band-line">Packets RX: ${escapeHtml(String(runtime?.packets_rx || 0))} | TX: ${escapeHtml(String(runtime?.packets_tx || 0))}</div>
        <div class="radio-band-line">Heard stations: ${escapeHtml(String(runtime?.heard_count || 0))}</div>
        <div class="radio-band-line">Last packet: ${escapeHtml(runtime?.last_packet_at ? fmtLocal(runtime.last_packet_at) : "--")}</div>
      </div>
      <div class="controls radio-session-actions">
        <button id="aprsUseTerrestrialBtn" type="button">Use Terrestrial APRS</button>
        <button id="aprsConnectBtn" type="button">${connected ? "Reconnect APRS" : "Connect APRS"}</button>
        <button id="aprsDisconnectBtn" type="button"${connected ? "" : " disabled"}>Disconnect APRS</button>
        <button id="aprsPanicBtn" type="button"${connected ? "" : " disabled"}>Panic Unkey</button>
        <button id="aprsBackBtn" type="button">Back to Rotator</button>
      </div>
      <div class="controls radio-session-actions">
        <input id="aprsMessageToRotator" type="text" placeholder="VK4XYZ-7" />
        <input id="aprsMessageTextRotator" type="text" placeholder="Message" />
        <button id="aprsSendMessageBtn" type="button"${target?.can_transmit === false ? " disabled" : ""}>Send Message</button>
      </div>
      <div class="controls radio-session-actions">
        <input id="aprsStatusTextRotator" type="text" placeholder="Status" />
        <button id="aprsSendStatusBtn" type="button"${target?.can_transmit === false ? " disabled" : ""}>Send Status</button>
        <input id="aprsPositionCommentRotator" type="text" placeholder="Position comment" />
        <button id="aprsSendPositionBtn" type="button"${target?.can_transmit === false ? " disabled" : ""}>Send Position</button>
      </div>
      <div class="radio-channel">
        <div class="radio-channel-mode">Recently Heard</div>
        ${heard.length
          ? heard.map((item) => `<div class="radio-band-line">${escapeHtml(item.callsign)} | ${escapeHtml(fmtLocal(item.last_heard_at))} | ${escapeHtml(item.last_text || "--")}</div>`).join("")
          : '<div class="radio-band-line">No heard stations yet</div>'}
      </div>
      <div class="radio-channel">
        <div class="radio-channel-mode">Live Packet Feed</div>
        <div class="aprs-packet-feed">${renderAprsPacketFeed(runtime)}</div>
      </div>
    </article>
  `;
}

async function renderAprsScene() {
  setSceneVisible("sceneAprs");
  const system = state.system || {};
  const target = derivedAprsTarget(system);
  trackerById("aprsPrimary").textContent = target
    ? `APRS: ${target.label} | ${target.can_transmit ? "TX ready" : (target.tx_block_reason || "TX blocked")}`
    : "APRS: no target selected";
  trackerById("aprsBoard").innerHTML = renderAprsSceneCard(system);
  aprsSceneState.lastFeedKeys = (system.aprsRuntime?.recent_packets || []).map(packetKey);
  for (const [key, timestamp] of aprsSceneState.packetHighlights.entries()) {
    if ((Date.now() - timestamp) > 4000 || !aprsSceneState.lastFeedKeys.includes(key)) {
      aprsSceneState.packetHighlights.delete(key);
    }
  }
  const visuals = trackerById("aprsVisuals");
  const aux = trackerById("aprsLeftAux");
  const pass = target?.sat_id ? findSessionPass(state.passes, {
    selected_sat_id: target.sat_id,
    selected_pass_aos: target.pass_aos,
    selected_pass_los: target.pass_los,
    selected_sat_name: target.sat_name,
    selected_max_el_deg: null,
  }) : null;
  const track = target?.sat_id
    ? (system.tracks || []).find((item) => item.sat_id === target.sat_id) || null
    : null;
  if (visuals) visuals.classList.toggle("hidden", !(track && pass));
  if (track && pass && aux) {
    const pathItems = await ensurePathForDisplayedPass(system, pass);
    aux.innerHTML = renderUpcomingVisualAux({
      track,
      pass,
      pathItems,
      observerLocation: system.location,
    });
  } else if (aux) {
    aux.innerHTML = '<section class="telemetry-visual-card"><div class="telemetry-section-title">APRS monitor</div><div class="telemetry-visual-meta mono">Waiting for APRS pass/track context.</div></section>';
  }
}

async function renderRadioScene(passes) {
  setSceneVisible("sceneRadio");
  const session = activeRadioSession();
  if (isPinnedRadioControl(session)) {
    const pass = findSessionPass(passes, session);
    renderPinnedRadioControl(session, pass, state.system?.radioRuntime || null);
    const visuals = trackerById("radioVisuals");
    const aux = trackerById("radioLeftAux");
    const sys = state.system || {};
    const track = (sys.tracks || []).find((t) => t.sat_id === session?.selected_sat_id)
      || (sys.activeTrack?.sat_id === session?.selected_sat_id ? sys.activeTrack : null)
      || (sys.issTrack?.sat_id === session?.selected_sat_id ? sys.issTrack : null)
      || null;
    if (visuals) visuals.classList.toggle("hidden", !track || !pass);
    if (track && pass) {
      const pathItems = await ensurePathForDisplayedPass(sys, pass);
      renderSkyplot(track, sys.bodies || [], pass, pathItems, "radio");
      aux.innerHTML = `
        ${renderUpcomingVisualAux({
          track,
          pass,
          pathItems,
          observerLocation: sys.location,
        })}
      `;
    } else if (aux) {
      aux.innerHTML = '<section class="telemetry-visual-card"><div class="telemetry-section-title">Track preview unavailable</div><div class="telemetry-visual-meta mono">Waiting for live track data for the selected satellite.</div></section>';
    }
    return;
  }
  const visuals = trackerById("radioVisuals");
  const aux = trackerById("radioLeftAux");
  if (visuals) visuals.classList.add("hidden");
  if (aux) aux.innerHTML = "";
  const upcoming = [];
  const seenSatIds = new Set();
  for (const pass of filterConsolePasses(passes)) {
    if (seenSatIds.has(pass.sat_id)) continue;
    seenSatIds.add(pass.sat_id);
    upcoming.push(pass);
    if (upcoming.length >= 5) break;
  }
  const cards = upcoming.map((p) => {
    const sat = state.sats.find((s) => s.sat_id === p.sat_id);
    const guideRows = rowsFromGuide(p.frequencyRecommendation, p.frequencyMatrix, "upcoming");
    const channels = guideRows.length ? guideRows : frequencyEntriesForSatellite(sat);
    return { pass: p, channels };
  });
  const primary = cards[0] || null;
  lastRadioPrimaryPass = primary ? primary.pass : null;
  const primaryChannel = primary?.channels[0] || null;
  trackerById("radioPrimary").textContent = primary
    ? `Primary: ${primary.pass.name} | ${primaryChannel?.mode || "No channel detail"} | AOS ${fmtLocal(primary.pass.aos)} | MaxEl ${primary.pass.max_el_deg.toFixed(1)}°`
    : "Primary: --";
  if (developerOverridesEnabled() && getDeveloperOverrides().show_debug_badge) {
    trackerById("radioPrimary").textContent = `DEV override | ${trackerById("radioPrimary").textContent}`;
  }
  trackerById("radioBoard").innerHTML = cards.length
    ? cards.map((card, idx) => {
      const shell = idx === 0 ? "radio-primary-card" : "radio-sat-card";
      const label = idx === 0 ? "Primary Window" : `Queue ${idx + 1}`;
      const channels = card.channels.length
        ? card.channels.slice(0, idx === 0 ? 3 : 2).map((ch) => `
            <div class="radio-channel">
              <div class="radio-channel-mode">${ch.mode}</div>
              <div class="radio-pair">
                <div class="radio-pair-label">Uplink</div>
                <div class="radio-pair-value mono">${ch.up}</div>
              </div>
              <div class="radio-pair">
                <div class="radio-pair-label">Downlink</div>
                <div class="radio-pair-value mono">${ch.down}</div>
              </div>
              <div class="radio-band-line">${ch.bands}</div>
            </div>
          `).join("")
        : '<div class="radio-empty">No parsed radio channels for this pass.</div>';
      return `
        <article class="${shell}">
          <div class="radio-card-label">${label}</div>
          <div class="radio-sat-name">${card.pass.name}</div>
          <div class="radio-pass-time mono">AOS ${fmtLocal(card.pass.aos)} | LOS ${fmtLocal(card.pass.los)} | MaxEl ${card.pass.max_el_deg.toFixed(1)}°</div>
          ${channels}
        </article>
      `;
    }).join("") + renderRigOpsCard(primary?.pass || null, state.system?.radioRuntime || null)
    : '<div class="radio-empty">No upcoming qualified radio passes.</div>';
}

async function applyCurrentRadioTarget(mode) {
  if (!lastRadioPrimaryPass) return;
  clearRotatorActionError();
  const payload = {
    sat_id: lastRadioPrimaryPass.sat_id,
    pass_aos: lastRadioPrimaryPass.aos,
    pass_los: lastRadioPrimaryPass.los,
  };
  if (mode === "apply") {
    await trackerApi.post("/api/v1/radio/apply", payload);
  } else if (mode === "start") {
    await trackerApi.post("/api/v1/radio/auto-track/start", payload);
  } else {
    await trackerApi.post("/api/v1/radio/auto-track/stop", {});
  }
  await fetchState();
  chooseScene();
}

async function selectRadioControlSessionFromElement(target) {
  clearRotatorActionError();
  radioChannelDraftKey = "";
  radioChannelPickerFocused = false;
  try {
    const fallbackChoice = deriveFallbackRadioChoiceForSelection(target);
    const payload = {
      sat_id: target.dataset.satId,
      sat_name: target.dataset.satName,
      pass_aos: target.dataset.passAos,
      pass_los: target.dataset.passLos,
      max_el_deg: Number(target.dataset.maxEl),
    };
    const response = await trackerApi.post("/api/v1/radio/session/select", payload);
    const testPairPayload = buildRadioSessionTestPairPayload(fallbackChoice);
    if (testPairPayload && !response.session?.has_test_pair) {
      const updated = await trackerApi.post("/api/v1/radio/session/test-pair", testPairPayload);
      response.session = updated.session;
    }
    state.system = state.system || {};
    state.system.radioControlSession = response.session;
    chooseScene();
    try {
      await fetchState();
      chooseScene();
    } catch (refreshErr) {
      setRotatorActionError(refreshErr?.message || String(refreshErr));
      chooseScene();
    }
  } catch (err) {
    setRotatorActionError(err?.message || String(err));
    chooseScene();
  }
}

async function commitSelectedRadioChannel() {
  const session = state.system?.radioControlSession;
  const runtime = state.system?.radioRuntime;
  const pass = findSessionPass(state.passes, session);
  const channelChoices = buildRadioChannelChoices(session, pass);
  const choice = channelChoices.find((item) => item.key === radioChannelDraftKey);
  if (!session?.active || !choice) return;
  clearRotatorActionError();
  try {
    const testPairPayload = buildRadioSessionTestPairPayload(choice);
    if (!testPairPayload) return;
    const sessionResp = await trackerApi.post("/api/v1/radio/session/test-pair", testPairPayload);
    state.system = state.system || {};
    state.system.radioControlSession = sessionResp.session;
    savePersistedRadioChannelDraft(sessionResp.session, choice.key);
    chooseScene();
    if (runtime?.connected) {
      const pairResp = await trackerApi.post("/api/v1/radio/pair", {
        uplink_hz: choice.uplink_hz,
        downlink_hz: choice.downlink_hz,
        uplink_mode: choice.uplink_mode,
        downlink_mode: choice.downlink_mode,
      });
      state.system.radioRuntime = pairResp.runtime;
      state.system.radioControlSession = pairResp.session || state.system.radioControlSession;
    }
    await fetchState();
    chooseScene();
  } catch (err) {
    setRotatorActionError(err?.message || String(err));
    chooseScene();
  }
}

async function runPinnedRadioAction(action, options = {}) {
  const { rethrow = false } = options;
  const endpointMap = {
    connect: "/api/v1/radio/connect",
    disconnect: "/api/v1/radio/disconnect",
    test: "/api/v1/radio/session/test",
    confirm: "/api/v1/radio/session/test/confirm",
    start: "/api/v1/radio/session/start",
    stop: "/api/v1/radio/session/stop",
    back: "/api/v1/radio/session/clear",
  };
  const endpoint = endpointMap[action];
  if (!endpoint) return;
  clearRotatorActionError();
  try {
    const response = await trackerApi.post(endpoint, {});
    if (action === "connect" && response?.runtime?.connected !== true) {
      throw new Error(response?.runtime?.last_error || "Connection attempt did not succeed.");
    }
    if (response?.session && state.system) {
      state.system.radioControlSession = response.session;
    }
    if (response?.runtime && state.system) {
      state.system.radioRuntime = response.runtime;
    }
    chooseScene();
    await fetchState();
    chooseScene();
    return response;
  } catch (err) {
    setRotatorActionError(err?.message || String(err));
    chooseScene();
    if (rethrow) throw err;
  }
}

async function selectAprsSessionForSatellite(satId, satName = "") {
  try {
    const channel = firstAprsChannelForSatellite(satId);
    if (!channel) {
      throw new Error(`No APRS channel available for ${satName || satId}`);
    }
    clearRotatorActionError();
    setAprsPinnedEnabled(true);
    setPinnedViewPreference("aprs");
    state.system = state.system || {};
    state.system.aprsPreviewTarget = {
      operating_mode: "satellite",
      sat_id: satId,
      sat_name: satName || channel.satellite_name || satId,
      label: `${satName || channel.satellite_name || satId} | ${channel.label || "APRS"}`,
      channel_id: channel.channel_id,
      channel_label: channel.label || "APRS",
      mode: channel.mode || channel.label || "APRS",
      frequency_hz: channel.downlink_hz || channel.uplink_hz || 0,
      uplink_hz: channel.uplink_hz || null,
      downlink_hz: channel.downlink_hz || null,
      path_default: defaultSatelliteAprsPath(channel),
      guidance: channel.guidance || null,
      requires_pass: true,
      can_transmit: false,
      tx_block_reason: "Loading APRS target...",
    };
    chooseScene();
    const response = await trackerApi.post("/api/v1/aprs/session/select", {
      operating_mode: "satellite",
      sat_id: satId,
      channel_id: channel.channel_id,
    });
    state.system = state.system || {};
    state.system.aprsPreviewTarget = response?.previewTarget || null;
    await refreshAprsOnly();
    chooseScene();
  } catch (err) {
    setRotatorActionError(err?.message || String(err));
    chooseScene();
  }
}

async function selectAprsTerrestrial() {
  try {
    clearRotatorActionError();
    setAprsPinnedEnabled(true);
    setPinnedViewPreference("aprs");
    state.system = state.system || {};
    state.system.aprsPreviewTarget = {
      operating_mode: "terrestrial",
      label: "Terrestrial APRS",
      path_default: "WIDE1-1,WIDE2-1",
      can_transmit: true,
      tx_block_reason: null,
    };
    chooseScene();
    const response = await trackerApi.post("/api/v1/aprs/session/select", {
      operating_mode: "terrestrial",
    });
    state.system = state.system || {};
    state.system.aprsPreviewTarget = response?.previewTarget || null;
    await refreshAprsOnly();
    chooseScene();
  } catch (err) {
    setRotatorActionError(err?.message || String(err));
    chooseScene();
  }
}

window.orbitDeckSelectAprsSession = (satId, satName = "") => {
  void selectAprsSessionForSatellite(satId, satName);
};

window.orbitDeckSelectRadioControlSession = (element) => {
  if (element instanceof HTMLElement) {
    void selectRadioControlSessionFromElement(element);
  }
};

async function refreshAprsOnly() {
  if (!state.system) return;
  const response = await trackerApi.get("/api/v1/aprs/state");
  state.system.aprsSettings = response.settings;
  state.system.aprsRuntime = response.runtime;
  state.system.aprsPreviewTarget = response.previewTarget || derivedAprsTarget({
    aprsSettings: response.settings,
    aprsRuntime: response.runtime,
    aprsPreviewTarget: null,
  });
}

async function runAprsAction(action) {
  const endpointMap = {
    connect: "/api/v1/aprs/connect",
    disconnect: "/api/v1/aprs/disconnect",
    panic: "/api/v1/aprs/panic-unkey",
  };
  clearRotatorActionError();
  try {
    if (action === "terrestrial") {
      await selectAprsTerrestrial();
      return;
    }
    if (action === "back") {
      setAprsPinnedEnabled(false);
      chooseScene();
      return;
    }
    if (action === "message") {
      await trackerApi.post("/api/v1/aprs/send/message", {
        to: trackerById("aprsMessageToRotator").value,
        text: trackerById("aprsMessageTextRotator").value,
      });
    } else if (action === "status") {
      await trackerApi.post("/api/v1/aprs/send/status", {
        text: trackerById("aprsStatusTextRotator").value,
      });
    } else if (action === "position") {
      await trackerApi.post("/api/v1/aprs/send/position", {
        comment: trackerById("aprsPositionCommentRotator").value,
      });
    } else {
      const endpoint = endpointMap[action];
      if (!endpoint) return;
      await trackerApi.post(endpoint, {});
    }
    await refreshAprsOnly();
    await fetchState();
    chooseScene();
  } catch (err) {
    setRotatorActionError(err?.message || String(err));
    chooseScene();
  }
}

async function showScene(scene, system, passes) {
  if (scene.mode === "video") return renderVideoScene(system);
  if (scene.mode === "passes") return renderPassesScene(passes);
  if (scene.mode === "radio") return renderRadioScene(passes);
  if (scene.mode === "aprs") return renderAprsScene();
  return renderTelemetryScene(system, scene);
}

async function fetchState(progress = null) {
  const requestId = ++fetchStateRequestId;
  const report = typeof progress === "function"
    ? (status, detail = "") => setStartupStatus(status, detail ? `${status}... ${detail}` : status)
    : () => {};
  report("Waiting for OrbitDeck backend", "Requesting live tracking snapshot");
  const system = await getWithRetry("/api/v1/system/state", report);
  report(
    "Resolving observer location",
    `${system.location?.source || "default"} ${Number(system.location?.lat || 0).toFixed(4)},${Number(system.location?.lon || 0).toFixed(4)}`
  );
  report("Fetching pass predictions", "Loading the next 24 hours of passes");
  const passesResp = await getWithRetry("/api/v1/passes?hours=24&include_all_sats=true&include_ongoing=true", report);
  report("Loading satellite catalog", "Reading current satellite definitions");
  const sats = await getWithRetry("/api/v1/satellites", report);
  report("Loading kiosk timezone", "Syncing local clock display");
  const tz = await getWithRetry("/api/v1/settings/timezone", report);
  if (requestId !== fetchStateRequestId) {
    return;
  }
  state = { system, passes: passesResp.items || [], sats: sats.items || [], timezone: tz.timezone || "UTC" };
  await populatePathCache(system, state.passes, report);
}

function tickClock() {
  const parts = fmtClockPair(Date.now());
  trackerById("clockUtc").textContent = `UTC: ${parts.utc.replace(" UTC", "")}`;
  trackerById("clockLocal").textContent = `Local: ${parts.local}`;
}

function syncDevSettingsLink() {
  const link = trackerById("devSettingsLink");
  if (!link) return;
  link.classList.toggle("hidden", !developerOverridesEnabled());
}

function updateTopMeta(system) {
  if (trackerRenderStationBadge) {
    trackerRenderStationBadge("stationBadge", system?.stationIdentity, system?.aprsSettings);
  }
  syncPinnedViewSelector(system);
  const session = system?.radioControlSession;
  if (session?.active) {
    trackerById("rotatorTracked").textContent = `Tracked: ${session.selected_sat_name || session.selected_sat_id || "--"} (Radio)`;
    trackerById("rotatorLocation").textContent = `Loc: ${system.location?.source || "--"} ${Number(system.location?.lat || 0).toFixed(4)},${Number(system.location?.lon || 0).toFixed(4)}`;
    return;
  }
  const active = system.activeTrack || system.issTrack;
  trackerById("rotatorTracked").textContent = `Tracked: ${active?.name || "--"}`;
  trackerById("rotatorLocation").textContent = `Loc: ${system.location?.source || "--"} ${Number(system.location?.lat || 0).toFixed(4)},${Number(system.location?.lon || 0).toFixed(4)}`;
}

function chooseScene() {
  const sys = applyDeveloperSystemOverrides(state.system);
  const passes = state.passes;
  if (!sys) return;
  const radioPinned = isPinnedRadioControl(sys.radioControlSession);
  const aprsPinned = isPinnedAprsControl(sys);
  const preferredPinnedView = pinnedViewPreference();

  if (radioPinned && preferredPinnedView !== "aprs" && radioChannelPickerFocused) {
    updateTopMeta(sys);
    return;
  }

  if (radioPinned || aprsPinned) {
    updateTopMeta(sys);
    lastOverride = preferredPinnedView;
    if (aprsPinned && (!radioPinned || preferredPinnedView === "aprs")) {
      void showScene({ key: "aprs:session", mode: "aprs" }, sys, passes);
      return;
    }
    if (radioPinned) {
      void showScene({ key: "radio:session", mode: "radio" }, sys, passes);
      return;
    }
  }

  const forced = resolveDeveloperScene(sys, passes);
  if (forced) {
    if (forced.track) sys.activeTrack = forced.track;
    updateTopMeta(sys);
    lastOverride = "developer";
    void showScene(forced, sys, passes);
    return;
  }

  updateTopMeta(sys);

  const ongoing = pickOngoingPass(sys, passes);
  const overrideOngoing = ongoing ? { key: `telemetry:ongoing:${ongoing.pass.sat_id}`, mode: "ongoing", track: ongoing.track, pass: ongoing.pass } : null;
  const overrideVideo = !overrideOngoing && sys.iss?.videoEligible && sys.iss?.streamHealthy
    ? { key: "video", mode: "video" }
    : null;

  if (overrideOngoing) {
    lastOverride = "ongoing";
    void showScene(overrideOngoing, sys, passes);
    return;
  }
  if (overrideVideo) {
    lastOverride = "video";
    void showScene(overrideVideo, sys, passes);
    return;
  }

  const seq = buildRotationSequence(sys, passes);
  if (!seq.length) {
    void showScene({ key: "passes", mode: "passes" }, sys, passes);
    return;
  }
  if (lastOverride) {
    sceneIdx = 0;
    nextSwitchAt = 0;
    lastOverride = "";
  }
  if (sceneOrder.map((x) => x.key).join("|") !== seq.map((x) => x.key).join("|")) {
    sceneOrder = seq;
    sceneIdx = 0;
    nextSwitchAt = 0;
  }
  const now = Date.now();
  if (!nextSwitchAt || now >= nextSwitchAt) {
    if (nextSwitchAt) sceneIdx = (sceneIdx + 1) % sceneOrder.length;
    nextSwitchAt = now + sceneDurationMs(sceneOrder[sceneIdx].key);
  }
  void showScene(sceneOrder[sceneIdx], sys, passes);
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    ({
      api: trackerApi,
      byId: trackerById,
      renderStationBadge: trackerRenderStationBadge,
      createRigConnectController: trackerCreateRigConnectController,
    } = window.issTracker);
    radioConnectController = trackerCreateRigConnectController({
      modalId: "radioConnectModal",
      statusId: "radioConnectModalStatus",
      rigModelId: "radioConnectRigModel",
      transportModeId: "radioConnectTransportMode",
      portSelectId: "radioConnectPortSelect",
      manualId: "radioConnectPortManual",
      usbFieldsId: "radioConnectUsbFields",
      wifiFieldsId: "radioConnectWifiFields",
      wifiHostId: "radioConnectWifiHost",
      wifiUsernameId: "radioConnectWifiUsername",
      wifiPasswordId: "radioConnectWifiPassword",
      wifiControlPortId: "radioConnectWifiControlPort",
      baudRateId: "radioConnectBaudRate",
      civAddressId: "radioConnectCivAddress",
      pollIntervalId: "radioConnectPollInterval",
      autoTrackIntervalId: "radioConnectAutoTrackInterval",
      autoConnectId: "radioConnectAutoConnect",
      applyModeToneId: "radioConnectApplyModeTone",
      safeTxGuardId: "radioConnectSafeTxGuard",
      titleId: "radioConnectModalTitle",
      loadCurrent: async () => {
        const settingsResp = await trackerApi.get("/api/v1/settings/radio");
        return settingsResp.state || {};
      },
      saveSelection: async (payload) => {
        await trackerApi.post("/api/v1/settings/radio", payload);
      },
      connectingMessage: (profile) => {
        const rig = rigModelLabel(profile.rig_model);
        const transport = String(profile.transport_mode || "usb").toUpperCase();
        if (connectModalMode === "aprs") {
          return `Saving ${rig} ${transport} profile and connecting APRS...`;
        }
        return `Saving ${rig} ${transport} profile and connecting radio...`;
      },
      onConnected: async () => {
        if (connectModalMode === "aprs") {
          await runAprsAction("connect");
          return;
        }
        await runPinnedRadioAction("connect", { rethrow: true });
      },
    });
    radioConnectController.bind();
    setStartupVisible(true);
    setStartupStatus("Preparing live tracking console", "Boot sequence started");
    syncDevSettingsLink();
    tickClock();
    setInterval(tickClock, 1000);
    await bootRotatorUntilReady();
    document.body.addEventListener("click", (event) => {
      const clicked = event.target;
      if (!(clicked instanceof HTMLElement)) return;
      const target = clicked.closest("[data-radio-action], [data-aprs-action], button");
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset.radioAction === "select-session") {
        void selectRadioControlSessionFromElement(target);
      } else if (target.dataset.aprsAction === "select-session") {
        void selectAprsSessionForSatellite(target.dataset.satId, target.dataset.satName || "");
      } else if (target.id === "radioApplyBtn") {
        void applyCurrentRadioTarget("apply");
      } else if (target.id === "radioAutoStartBtn") {
        void applyCurrentRadioTarget("start");
      } else if (target.id === "radioAutoStopBtn") {
        void applyCurrentRadioTarget("stop");
      } else if (target.id === "radioSessionConnectBtn") {
        const connected = !!state.system?.radioRuntime?.connected;
        if (connected) {
          void runPinnedRadioAction("disconnect");
        } else {
          void openRadioConnectModal("radio");
        }
      } else if (target.id === "radioSessionTestBtn") {
        const inTest = state.system?.radioControlSession?.screen_state === "test";
        void runPinnedRadioAction(inTest ? "stop" : "test");
      } else if (target.id === "radioSessionStartBtn") {
        const screenState = state.system?.radioControlSession?.screen_state;
        void runPinnedRadioAction(screenState === "active" || screenState === "armed" ? "stop" : "start");
      } else if (target.id === "radioSessionBackBtn") {
        void runPinnedRadioAction("back");
      } else if (target.id === "radioCommitChannelBtn") {
        void commitSelectedRadioChannel();
      } else if (target.id === "aprsUseTerrestrialBtn") {
        void runAprsAction("terrestrial");
      } else if (target.id === "aprsConnectBtn") {
        const radioConnected = !!state.system?.radioRuntime?.connected;
        if (radioConnected) {
          void runAprsAction("connect");
        } else {
          void openRadioConnectModal("aprs");
        }
      } else if (target.id === "aprsDisconnectBtn") {
        void runAprsAction("disconnect");
      } else if (target.id === "aprsPanicBtn") {
        void runAprsAction("panic");
      } else if (target.id === "aprsBackBtn") {
        void runAprsAction("back");
      } else if (target.id === "aprsSendMessageBtn") {
        void runAprsAction("message");
      } else if (target.id === "aprsSendStatusBtn") {
        void runAprsAction("status");
      } else if (target.id === "aprsSendPositionBtn") {
        void runAprsAction("position");
      } else if (target.id === "radioConnectModalCloseBtn") {
        closeRadioConnectModal();
      } else if (target.id === "radioConnectRefreshPortsBtn") {
        void openRadioConnectModal();
      } else if (target.id === "radioConnectConfirmBtn") {
        void submitRadioConnectModal();
      }
    });
    document.body.addEventListener("change", (event) => {
      const changed = event.target;
      if (!(changed instanceof HTMLElement)) return;
      if (changed.id === "radioChannelSelect") {
        radioChannelDraftKey = changed.value || "";
        savePersistedRadioChannelDraft(state.system?.radioControlSession, radioChannelDraftKey);
        chooseScene();
      }
    });
    document.body.addEventListener("focusin", (event) => {
      const focused = event.target;
      if (!(focused instanceof HTMLElement)) return;
      if (focused.id === "radioChannelSelect") {
        radioChannelPickerFocused = true;
      }
    });
    document.body.addEventListener("focusout", (event) => {
      const blurred = event.target;
      if (!(blurred instanceof HTMLElement)) return;
      if (blurred.id === "radioChannelSelect") {
        radioChannelPickerFocused = false;
      }
    });
    const pinnedViewSelect = trackerById("pinnedViewSelect");
    if (pinnedViewSelect) {
      pinnedViewSelect.value = pinnedViewPreference();
      pinnedViewSelect.addEventListener("change", () => {
        setPinnedViewPreference(pinnedViewSelect.value);
        chooseScene();
      });
    }
    setInterval(() => {
      try {
        chooseScene();
      } catch (_) {}
    }, 1000);
    setInterval(async () => {
      try {
        if (!isPinnedAprsControl(state.system)) return;
        await refreshAprsOnly();
        chooseScene();
      } catch (_) {}
    }, 1000);
    setInterval(async () => {
      try {
        await fetchState();
        chooseScene();
      } catch (_) {}
    }, 5000);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    setStartupVisible(true);
    setStartupStatus("Rotator startup failed", `Startup failed: ${msg}`);
    const meta = document.getElementById("passesMeta");
    const rows = document.getElementById("rotatorPassRows");
    if (meta) meta.textContent = `Rotator init error: ${msg}`;
    if (rows && !rows.innerHTML.trim()) {
      rows.innerHTML = '<tr><td colspan="5" class="label">Rotator failed to initialize. Check browser console.</td></tr>';
    }
  }
});

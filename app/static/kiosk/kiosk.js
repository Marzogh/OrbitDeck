let trackerApi;
let trackerById;
let trackerSetBrowserLocation;
let trackerRenderStationBadge;
let selectedSatId = null;
let selectedLocationSource = null;
let selectedPassProfile = "IssOnly";
let selectedPassSatIds = ["iss-zarya"];
let selectedDisplayTimezone = "UTC";
let passProfileEditorOpen = false;
let telemetryDrawerOpen = false;
let previousTrack = null;
const trailPoints = [];
const MAX_TRAIL = 25;
let latestPassItems = [];
let forecastTrackItems = [];
let forecastSatId = null;
let lastForecastRefreshAt = 0;
let forecastPassKey = "";
let dialPassState = null;
const TIMEZONE_CHOICES = [
  "BrowserLocal",
  "UTC",
  "Australia/Brisbane",
  "Australia/Sydney",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Tokyo",
];
const VIDEO_SOURCES_KEY = "kioskVideoSources";
const DEFAULT_YOUTUBE_ISS_EMBED_SOURCES = [
  "https://www.youtube.com/embed/fO9e9jnhYK8?autoplay=1&mute=1&rel=0&modestbranding=1",
  "https://www.youtube.com/embed/sWasdbDVNvc?autoplay=1&mute=1&rel=0&modestbranding=1",
];
let activeVideoSourceIndex = 0;
let youtubeIssEmbedSources = [...DEFAULT_YOUTUBE_ISS_EMBED_SOURCES];
const TRACKED_SAT_KEY = "kioskTrackedSatId";
const DISPLAY_TIMEZONE_CHOICE_KEY = "orbitdeckDisplayTimezoneChoice";
const BODY_COLORS = {
  Sun: "#ffd400",
  Moon: "#7fe0ff",
  Mercury: "#ff57b3",
  Venus: "#6dff7b",
  Mars: "#ff623e",
  Jupiter: "#9d7bff",
  Saturn: "#ff9b2e",
};

function renderStationIdentity(identity, settings) {
  const input = trackerById("bootCallsign");
  const status = trackerById("bootCallsignStatus");
  if (!input || !status) return;
  const callsign = (identity?.callsign || settings?.callsign || "").trim();
  input.value = callsign && callsign !== "N0CALL" ? callsign : "";
  if (identity?.configured) {
    status.textContent = `Callsign ${identity.callsign} saved. Radio and APRS control are enabled.`;
  } else {
    status.textContent = identity?.reason || "Radio control is disabled until a valid callsign is saved.";
  }
}

function effectiveDisplayTimezone() {
  const selection = resolvedDisplayTimezoneSelection();
  return selection === "BrowserLocal"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    : selection;
}

function resolvedDisplayTimezoneSelection() {
  if (selectedDisplayTimezone === "UTC" && !localStorage.getItem(DISPLAY_TIMEZONE_CHOICE_KEY)) {
    return "BrowserLocal";
  }
  return selectedDisplayTimezone || "BrowserLocal";
}

function fmtDisplayTime(iso) {
  const d = new Date(iso);
  const tz = effectiveDisplayTimezone();
  try {
    const s = d.toLocaleString("sv-SE", { timeZone: tz, hour12: false });
    return `${s} ${tz}`;
  } catch (_) {
    return `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
  }
}

function dayLabelFor(d, now) {
  const dayMs = 24 * 60 * 60 * 1000;
  const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const n0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const deltaDays = Math.round((d0 - n0) / dayMs);
  if (deltaDays === 0) return "Today";
  if (deltaDays === 1) return "Tomorrow";
  if (deltaDays === -1) return "Yesterday";
  return d.toLocaleDateString("en-CA");
}

function fmtPassCellTime(iso) {
  const d = new Date(iso);
  const tz = effectiveDisplayTimezone();
  try {
    const now = new Date();
    const day = dayLabelFor(
      new Date(d.toLocaleString("en-US", { timeZone: tz })),
      new Date(now.toLocaleString("en-US", { timeZone: tz }))
    );
    const t = d.toLocaleTimeString("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    return `${day} ${t}`;
  } catch (_) {
    return fmtDisplayTime(iso);
  }
}

function updateClock() {
  trackerById("clock").textContent = fmtDisplayTime(new Date().toISOString());
}

function statusText(iss) {
  const s = [];
  s.push(`Sunlit: ${iss.sunlit ? "yes" : "no"}`);
  s.push(`Above horizon: ${iss.aboveHorizon ? "yes" : "no"}`);
  s.push(`Video eligible: ${iss.videoEligible ? "yes" : "no"}`);
  s.push(`Stream healthy: ${iss.streamHealthy ? "yes" : "no"}`);
  return s.join(" | ");
}

function modeLabel(mode) {
  if (mode === "SunlitOnlyVideo") return "Video when ISS is sunlit";
  if (mode === "SunlitAndVisibleVideo") return "Video when ISS is sunlit + above horizon";
  return "Telemetry only";
}

function fmtRelativeHours(iso) {
  if (!iso) return "";
  const deltaMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(deltaMs)) return "";
  const hours = Math.max(0, deltaMs / (1000 * 60 * 60));
  if (hours < 1) return "within the last hour";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function amsatSummaryLabel(summary) {
  const map = {
    active: "Active",
    telemetry_only: "Telemetry Only",
    inactive: "Inactive",
    conflicting: "Conflicting",
    unknown: "Unknown",
  };
  return map[summary] || "Unknown";
}

function amsatSummaryClass(summary) {
  const map = {
    active: "chip chip-ok",
    telemetry_only: "chip chip-warn",
    inactive: "chip chip-danger",
    conflicting: "chip chip-warn",
    unknown: "chip",
  };
  return map[summary] || "chip";
}

function renderAmsatSummary(status) {
  const wrap = trackerById("amsatSummary");
  const badge = trackerById("amsatBadge");
  const detail = trackerById("amsatDetail");
  const counts = trackerById("amsatCounts");
  const matched = trackerById("amsatMatched");
  if (!wrap || !badge || !detail || !counts || !matched) return;

  if (!status) {
    wrap.classList.add("hidden");
    badge.textContent = "";
    detail.textContent = "";
    counts.innerHTML = "";
    matched.textContent = "";
    return;
  }

  wrap.classList.remove("hidden");
  badge.className = amsatSummaryClass(status.summary);
  badge.textContent = amsatSummaryLabel(status.summary);
  const latest = status.latest_report;
  detail.textContent = latest
    ? `Latest report: ${latest.report}${latest.callsign ? ` by ${latest.callsign}` : ""} (${fmtRelativeHours(latest.reported_time)})`
    : "No AMSAT reports available in the sampled window";
  counts.innerHTML = [
    `<span class="chip">Reports 96h: ${status.reports_last_96h}</span>`,
    `<span class="chip">Heard: ${status.heard_count}</span>`,
    `<span class="chip">Telemetry: ${status.telemetry_only_count}</span>`,
    `<span class="chip">Not heard: ${status.not_heard_count}</span>`,
  ].join("");
  matched.textContent = `AMSAT match: ${status.matched_name} | Checked ${fmtDisplayTime(status.checked_at)}`;
}

function normalizeFreqToken(text) {
  return String(text).replace(/\b\d{7,10}\b/g, (m) => {
    const n = Number(m);
    if (!Number.isFinite(n) || n <= 0) return m;
    const mhz = n / 1_000_000;
    return `${mhz.toFixed(3)} MHz`;
  });
}

function isHamFrequencySatellite(sat) {
  if (!sat || sat.has_amateur_radio === false) return false;
  const tx = Array.isArray(sat.transponders) ? sat.transponders : [];
  const rx = Array.isArray(sat.repeaters) ? sat.repeaters : [];
  const joined = [...tx, ...rx].join(" ").toLowerCase();
  if (!joined.trim()) return false;
  return /(mhz|aprs|fm|ssb|cw|bpsk|fsk|afsk|transponder|repeater|ctcss|sstv)/.test(joined);
}

function parsePair(text) {
  const s = String(text || "");
  const m = s.match(/Uplink\s+([^/]+)\s*\/\s*Downlink\s+(.+)$/i);
  if (m) return { uplink: m[1].trim(), downlink: m[2].trim() };
  return { uplink: "", downlink: "" };
}

function extractFirstMHz(text) {
  const m = String(text || "").match(/(\d+(?:\.\d+)?)\s*MHz/i);
  return m ? Number(m[1]) : null;
}

function bandFromMHz(v) {
  if (!Number.isFinite(v)) return "Unknown";
  if (v >= 144 && v <= 148) return "VHF 2m";
  if (v >= 430 && v <= 440) return "UHF 70cm";
  if (v >= 1240 && v <= 1300) return "L 23cm";
  if (v >= 2200 && v <= 2450) return "S 13cm";
  return `${v.toFixed(3)} MHz`;
}

function modeLongName(modeText) {
  const mode = String(modeText || "").replace(/^Mode\s*/i, "").trim();
  const map = { V: "VHF 2m", U: "UHF 70cm", L: "L 23cm" };
  const slash = mode.match(/\b([VUL])\/([VUL])\b/i);
  if (slash) {
    const a = slash[1].toUpperCase();
    const b = slash[2].toUpperCase();
    return `${mode} (${map[a] || a} up, ${map[b] || b} down)`;
  }
  const single = mode.match(/\b([VUL])\b/i);
  if (single) {
    const k = single[1].toUpperCase();
    return `${mode} (${map[k] || k})`;
  }
  return mode || "General";
}

function frequencyEntriesForSatellite(sat) {
  const tx = (sat.transponders || []).map(normalizeFreqToken);
  const rx = (sat.repeaters || []).map(normalizeFreqToken);
  const n = Math.max(tx.length, rx.length, 1);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const mode = tx[i] || `Channel ${i + 1}`;
    const pair = parsePair(rx[i] || "");
    const up = pair.uplink || "—";
    const down = pair.downlink || "—";
    const upBand = bandFromMHz(extractFirstMHz(up));
    const downBand = bandFromMHz(extractFirstMHz(down));
    rows.push({
      mode: modeLongName(mode),
      uplink: up,
      downlink: down,
      bands: `${upBand} -> ${downBand}`,
    });
  }
  return rows;
}

function scoreHamUsefulness(row) {
  const text = `${row.mode} ${row.uplink} ${row.downlink}`.toLowerCase();
  const hasPair = row.uplink !== "—" || row.downlink !== "—";
  if (!hasPair) return -100;
  if (/(crew|soyuz|spacex|service module|zvezda|telemetry|control)/i.test(text)) return -50;
  if (/(voice repeater|repeater|ctcss)/i.test(text)) return 100;
  if (/aprs/i.test(text)) return 90;
  if (/transponder/i.test(text)) return 80;
  if (/(ssb|cw|fm|afsk|fsk|bpsk|packet|sstv)/i.test(text)) return 60;
  return 20;
}

function compactHamRows(rows, maxRows = 3) {
  return rows
    .map((row, idx) => ({ row, idx, score: scoreHamUsefulness(row) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .slice(0, maxRows)
    .map((x) => x.row);
}

function sortedRowsForAll(rows) {
  return rows
    .map((row, idx) => ({ row, idx, score: scoreHamUsefulness(row) }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .map((x) => x.row);
}

function renderFrequencyRows(rows, limit = null) {
  const list = Number.isFinite(limit) ? rows.slice(0, limit) : rows;
  if (!list.length) return '<tr><td colspan="4" class="label">No frequency entries</td></tr>';
  return list.map((r) => `
    <tr>
      <td>${r.mode}</td>
      <td class="mono">${r.uplink}</td>
      <td class="mono">${r.downlink}</td>
      <td>${r.bands}</td>
    </tr>
  `).join("");
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

function rowsFromRecommendation(recommendation, matrix) {
  if (!recommendation) return [];
  const primaryRow = {
    mode: `${recommendation.label}${recommendation.phase ? ` | ${String(recommendation.phase).toUpperCase()}` : ""}`,
    uplink: `${fmtGuideMHz(recommendation.uplink_mhz)}${recommendation.uplink_mode ? ` ${recommendation.uplink_mode}` : ""}`,
    downlink: `${fmtGuideMHz(recommendation.downlink_mhz)}${recommendation.downlink_mode ? ` ${recommendation.downlink_mode}` : ""}`,
    bands: `${recommendation.uplink_label || "Uplink"} -> ${recommendation.downlink_label || "Downlink"}`,
  };
  const matrixRows = (matrix?.rows || []).map((row) => ({
    mode: `Phase ${String(row.phase).toUpperCase()}`,
    uplink: fmtGuideMHz(row.uplink_mhz),
    downlink: fmtGuideMHz(row.downlink_mhz),
    bands: row.phase === matrix.active_phase ? "Active phase" : "Reference",
  }));
  return [primaryRow, ...matrixRows];
}

function bodySymbol(name) {
  const map = {
    Sun: "☉",
    Moon: "☾",
    Mercury: "☿",
    Venus: "♀",
    Mars: "♂",
    Jupiter: "♃",
    Saturn: "♄",
  };
  return map[name] || "•";
}

function bodyLegendChip(body) {
  return `<span class="body-key"><span class="body-key-token" style="--body-color:${body.color}"><span class="body-key-sym">${bodySymbol(body.name)}</span></span><span class="body-key-name">${body.name}</span></span>`;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function azElToXY(azDeg, elDeg, radius = 108, cx = 120, cy = 120) {
  const az = (azDeg * Math.PI) / 180;
  const el = clamp(elDeg, 0, 90);
  const r = ((90 - el) / 90) * radius;
  const x = cx + r * Math.sin(az);
  const y = cy - r * Math.cos(az);
  return { x, y };
}

function ensurePlotDialScaffold(tickId = "plotTicks", degreeId = "plotDegrees") {
  const degreeLayer = trackerById(degreeId);
  if (degreeLayer && !degreeLayer.childNodes.length) {
    const ns = "http://www.w3.org/2000/svg";
    for (let deg = 0; deg < 360; deg += 30) {
      if (deg % 90 === 0) continue;
      const a = (deg * Math.PI) / 180;
      const r = 118;
      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", (120 + r * Math.sin(a)).toFixed(2));
      text.setAttribute("y", (120 - r * Math.cos(a) + 3).toFixed(2));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("class", "plot-degree-label");
      text.textContent = String(deg);
      degreeLayer.appendChild(text);
    }
  }

  const tickLayer = trackerById(tickId);
  if (!tickLayer || tickLayer.childNodes.length) return;
  const ns = "http://www.w3.org/2000/svg";
  for (let deg = 0; deg < 360; deg += 10) {
    const major = deg % 30 === 0;
    const inner = major ? 91 : 98;
    const outer = 108;
    const a = (deg * Math.PI) / 180;
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", (120 + inner * Math.sin(a)).toFixed(2));
    line.setAttribute("y1", (120 - inner * Math.cos(a)).toFixed(2));
    line.setAttribute("x2", (120 + outer * Math.sin(a)).toFixed(2));
    line.setAttribute("y2", (120 - outer * Math.cos(a)).toFixed(2));
    line.setAttribute("class", `plot-tick ${major ? "plot-tick-major" : "plot-tick-minor"}`);
    tickLayer.appendChild(line);
  }
}

function passKey(pass) {
  if (!pass) return "";
  return `${pass.sat_id}|${pass.aos}|${pass.los}`;
}

function selectedFrequencyPass() {
  const satId = selectedSatId || "";
  if (!satId) return null;
  if (
    dialPassState
    && dialPassState.sat_id === satId
    && passPhase(dialPassState.pass) !== "after"
  ) {
    return dialPassState.pass;
  }
  const relevant = latestPassItems
    .filter((item) => item.sat_id === satId)
    .sort((a, b) => new Date(a.aos).getTime() - new Date(b.aos).getTime());
  const ongoing = relevant.find((item) => passPhase(item) === "ongoing");
  if (ongoing) return ongoing;
  return relevant.find((item) => passPhase(item) === "upcoming") || relevant[0] || null;
}

function passPhase(pass, nowMs = Date.now()) {
  if (!pass) return "none";
  const aos = new Date(pass.aos).getTime();
  const los = new Date(pass.los).getTime();
  if (nowMs < aos) return "upcoming";
  if (nowMs <= los) return "ongoing";
  return "after";
}

function clearDialLayers() {
  const faded = trackerById("issPathFaded");
  const past = trackerById("issPathPast");
  const future = trackerById("issPathFuture");
  const markers = trackerById("issEventMarkers");
  if (faded) faded.setAttribute("d", "");
  if (past) past.setAttribute("d", "");
  if (future) future.setAttribute("d", "");
  if (markers) markers.innerHTML = "";
}

function nearestForecastPoint(targetIso) {
  if (!targetIso || !forecastTrackItems.length) return null;
  const target = new Date(targetIso).getTime();
  let best = null;
  for (const item of forecastTrackItems) {
    const ts = new Date(item.timestamp).getTime();
    const delta = Math.abs(ts - target);
    if (!best || delta < best.delta) best = { item, delta };
  }
  return best && best.delta <= 120000 ? best.item : null;
}

function chooseDialPass(track) {
  const nowMs = Date.now();
  const satId = selectedSatId || track?.sat_id || "";
  if (
    dialPassState
    && dialPassState.sat_id === satId
    && nowMs <= dialPassState.fade_until_ms
    && passPhase(dialPassState.pass, nowMs) === "after"
  ) {
    return dialPassState.pass;
  }

  const relevant = latestPassItems
    .filter((item) => !satId || item.sat_id === satId)
    .sort((a, b) => new Date(a.aos).getTime() - new Date(b.aos).getTime());

  const ongoing = relevant.find((item) => passPhase(item, nowMs) === "ongoing");
  const upcoming = relevant.find((item) => passPhase(item, nowMs) === "upcoming");
  const chosen = ongoing || upcoming || null;
  if (chosen) {
    dialPassState = {
      pass: chosen,
      sat_id: chosen.sat_id,
      fade_until_ms: new Date(chosen.los).getTime() + (8 * 60 * 1000),
    };
  }
  return chosen;
}

function pathForItems(items) {
  if (!items.length) return "";
  return items
    .map((item, idx) => {
      const point = azElToXY(item.az_deg, item.el_deg);
      return `${idx === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    })
    .join(" ");
}

function renderPassLayers(pass, track) {
  const faded = trackerById("issPathFaded");
  const past = trackerById("issPathPast");
  const future = trackerById("issPathFuture");
  const markers = trackerById("issEventMarkers");
  if (!faded || !past || !future || !markers) return;
  if (!forecastTrackItems.length) {
    clearDialLayers();
    return;
  }
  const plotted = forecastTrackItems;
  if (plotted.length < 2) {
    clearDialLayers();
    return;
  }

  const nowMs = Date.now();
  const phase = passPhase(pass, nowMs);
  let splitIdx = plotted.findIndex((item) => new Date(item.timestamp).getTime() >= nowMs);
  if (track) {
    const trackTime = new Date(track.timestamp || Date.now()).getTime();
    const idxFromTrack = plotted.findIndex((item) => new Date(item.timestamp).getTime() >= trackTime);
    if (idxFromTrack >= 0) splitIdx = idxFromTrack;
  }
  if (splitIdx < 0) splitIdx = plotted.length - 1;

  const pastItems = plotted.slice(0, Math.max(1, splitIdx + 1));
  const futureItems = plotted.slice(Math.max(0, splitIdx));

  faded.setAttribute("d", "");
  past.setAttribute("d", "");
  future.setAttribute("d", "");

  if (phase === "after") {
    faded.setAttribute("d", pathForItems(plotted));
  } else if (phase === "ongoing") {
    past.setAttribute("d", pathForItems(pastItems));
    future.setAttribute("d", pathForItems(futureItems));
  } else {
    future.setAttribute("d", pathForItems(plotted));
  }

  const labels = [
    { key: "AOS", iso: pass?.aos, dx: 8, dy: -8 },
    { key: "TCA", iso: pass?.tca, dx: 8, dy: -10 },
    { key: "LOS", iso: pass?.los, dx: 8, dy: -8 },
  ];
  markers.innerHTML = labels
    .map(({ key, iso, dx, dy }) => {
      const item = nearestForecastPoint(iso);
      if (!item) return "";
      const point = azElToXY(item.az_deg, item.el_deg);
      return `<g><circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3.6" class="plot-event-dot"></circle><text x="${(point.x + dx).toFixed(2)}" y="${(point.y + dy).toFixed(2)}" class="plot-event-label">${key}</text></g>`;
    })
    .join("");
}

function trackCue(track, previous) {
  if (!previous) return "Cue: acquiring target";
  const dAzRaw = track.az_deg - previous.az_deg;
  const dAz = ((dAzRaw + 540) % 360) - 180;
  const dAlt = track.el_deg - previous.el_deg;
  const azText = dAz > 0 ? `turn right ${Math.abs(dAz).toFixed(1)}°` : `turn left ${Math.abs(dAz).toFixed(1)}°`;
  const altText = dAlt > 0 ? `raise ${Math.abs(dAlt).toFixed(1)}°` : `lower ${Math.abs(dAlt).toFixed(1)}°`;
  return `Cue: ${azText}, ${altText}`;
}

function renderBodyLegend(elId, visibleBodies) {
  trackerById(elId).innerHTML = visibleBodies.length
    ? visibleBodies.map((b) => bodyLegendChip(b)).join("")
    : '<span class="label">Bodies: none above horizon</span>';
}

function renderMiniSkyplot(track) {
  const { x, y } = azElToXY(track.az_deg, track.el_deg);
  const dot = trackerById("miniIssDot");
  const vector = trackerById("miniIssVector");
  dot.setAttribute("cx", x.toFixed(2));
  dot.setAttribute("cy", y.toFixed(2));
  vector.setAttribute("x2", x.toFixed(2));
  vector.setAttribute("y2", y.toFixed(2));
}

function approxBodiesFromLocation(location) {
  const now = new Date();
  const t = now.getUTCHours() + now.getUTCMinutes() / 60;
  const lon = location?.lon || 0;
  const lat = location?.lat || 0;
  const sunAz = (t * 15 + lon + 180) % 360;
  const sunEl = 45 * Math.sin((2 * Math.PI * (t + lon / 30)) / 24) * Math.cos((lat * Math.PI) / 180);
  const moonAz = (sunAz + 105) % 360;
  const moonEl = sunEl * 0.6 + 15;
  const planets = [
    { name: "Mercury", az_deg: (sunAz + 20) % 360, el_deg: sunEl * 0.6 + 8, color: BODY_COLORS.Mercury },
    { name: "Venus", az_deg: (sunAz + 45) % 360, el_deg: sunEl * 0.7 + 12, color: BODY_COLORS.Venus },
    { name: "Mars", az_deg: (sunAz + 80) % 360, el_deg: sunEl * 0.5 + 6, color: BODY_COLORS.Mars },
    { name: "Jupiter", az_deg: (sunAz + 120) % 360, el_deg: sunEl * 0.55 + 9, color: BODY_COLORS.Jupiter },
    { name: "Saturn", az_deg: (sunAz + 150) % 360, el_deg: sunEl * 0.45 + 7, color: BODY_COLORS.Saturn },
  ];
  return [
    { name: "Sun", az_deg: sunAz, el_deg: sunEl, color: BODY_COLORS.Sun },
    { name: "Moon", az_deg: moonAz, el_deg: moonEl, color: BODY_COLORS.Moon },
    ...planets,
  ].filter((b) => b.el_deg > 0).map((b) => ({ ...b, visible: true }));
}

function renderSkyplot(track, bodies, location) {
  ensurePlotDialScaffold();
  const pass = chooseDialPass(track);
  const phase = passPhase(pass);
  const { x, y } = azElToXY(track.az_deg, track.el_deg);

  const dot = trackerById("issDot");
  const halo = trackerById("issDotHalo");
  const trail = trackerById("issTrail");
  if (phase === "ongoing" || phase === "none") {
    trailPoints.push({ x, y });
    if (trailPoints.length > MAX_TRAIL) trailPoints.shift();
    dot.setAttribute("cx", x.toFixed(2));
    dot.setAttribute("cy", y.toFixed(2));
    dot.style.opacity = "1";
    if (halo) {
      halo.setAttribute("cx", x.toFixed(2));
      halo.setAttribute("cy", y.toFixed(2));
      halo.style.opacity = "1";
    }
    const tail = trailPoints.slice(-6);
    trail.setAttribute(
      "points",
      tail.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
    );
  } else if (phase === "upcoming") {
    dot.setAttribute("cx", x.toFixed(2));
    dot.setAttribute("cy", y.toFixed(2));
    dot.style.opacity = "0.56";
    if (halo) {
      halo.setAttribute("cx", x.toFixed(2));
      halo.setAttribute("cy", y.toFixed(2));
      halo.style.opacity = "0.28";
    }
    trail.setAttribute("points", "");
    trailPoints.length = 0;
  } else {
    dot.style.opacity = "0";
    if (halo) halo.style.opacity = "0";
    trail.setAttribute("points", "");
    trailPoints.length = 0;
  }
  renderPassLayers(pass, track);

  const bodyLayer = trackerById("bodyLayer");
  bodyLayer.innerHTML = "";
  const inputBodies = (bodies && bodies.length ? bodies : approxBodiesFromLocation(location)) || [];
  const visibleBodies = inputBodies
    .filter((b) => b.visible && b.el_deg > 0)
    .map((b) => ({ ...b, color: BODY_COLORS[b.name] || b.color || "#dddddd" }));
  for (const b of visibleBodies) {
    const p = azElToXY(b.az_deg, b.el_deg);
    bodyLayer.insertAdjacentHTML(
      "beforeend",
      `<g><circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="6.2" fill="${b.color || "#ddd"}" class="plot-body"></circle><text x="${p.x.toFixed(2)}" y="${(p.y + 2.8).toFixed(2)}" text-anchor="middle" class="plot-body-icon">${bodySymbol(b.name)}</text></g>`
    );
  }
  renderBodyLegend("bodyLegend", visibleBodies);
}

async function refreshForecastPath(pass) {
  if (!selectedSatId || !pass) {
    forecastSatId = null;
    forecastTrackItems = [];
    lastForecastRefreshAt = 0;
    forecastPassKey = "";
    clearDialLayers();
    return;
  }
  const nextKey = passKey(pass);
  if (
    forecastSatId === selectedSatId
    && forecastPassKey === nextKey
    && (Date.now() - lastForecastRefreshAt) < 60000
  ) {
    return;
  }
  const start = new Date(pass.aos);
  const end = new Date(pass.los);
  const minutes = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 60000) + 1);
  const locationQuery = selectedLocationSource ? `&location_source=${encodeURIComponent(selectedLocationSource)}` : "";
  const resp = await trackerApi.get(
    `/api/v1/track/path?sat_id=${encodeURIComponent(selectedSatId)}&minutes=${minutes}&step_seconds=30&start_time=${encodeURIComponent(start.toISOString())}${locationQuery}`
  );
  forecastSatId = selectedSatId;
  forecastPassKey = nextKey;
  forecastTrackItems = Array.isArray(resp.items) ? resp.items : [];
  lastForecastRefreshAt = Date.now();
}

function renderPasses(items) {
  const upcoming = (items || []).filter((p) => new Date(p.aos).getTime() >= Date.now());
  const selectedPass = selectedFrequencyPass();
  const selectedPassId = passKey(selectedPass);
  trackerById("passTimeBasis").textContent = `Times shown in ${effectiveDisplayTimezone()}`;
  trackerById("nextPassCountdown").textContent = "";

  if (!upcoming.length) {
    trackerById("passRows").innerHTML = '<tr><td colspan="5" class="label">No passes in range for selected pass profile</td></tr>';
    return;
  }
  const nextAos = new Date(upcoming[0].aos).getTime();
  const deltaSec = Math.floor((nextAos - Date.now()) / 1000);
  if (Number.isFinite(deltaSec) && deltaSec > 0) {
    const h = Math.floor(deltaSec / 3600);
    const m = Math.floor((deltaSec % 3600) / 60);
    const s = deltaSec % 60;
    const text = h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
    trackerById("nextPassCountdown").textContent = `Next AOS in ${text}`;
  }
  const rows = upcoming.slice(0, 10).map((p) => `
    <tr data-sat-id="${p.sat_id}" data-pass-key="${passKey(p)}" class="${selectedPassId === passKey(p) ? "selected-row" : ""}">
      <td><strong>${p.name}</strong></td>
      <td title="${fmtDisplayTime(p.aos)}">${fmtPassCellTime(p.aos)}</td>
      <td title="${fmtDisplayTime(p.tca)}">${fmtPassCellTime(p.tca)}</td>
      <td title="${fmtDisplayTime(p.los)}">${fmtPassCellTime(p.los)}</td>
      <td>${p.max_el_deg.toFixed(1)}\u00B0</td>
    </tr>
  `);
  trackerById("passRows").innerHTML = rows.join("");
}

function renderFrequencies(items) {
  const hamItems = items.filter(isHamFrequencySatellite);
  if (!hamItems.length) {
    trackerById("freqSelectedName").textContent = "No satellite catalog loaded";
    renderAmsatSummary(null);
    trackerById("freqModeLegend").textContent = "";
    trackerById("freqPrimaryLine").textContent = "";
    trackerById("freqRowsCompact").innerHTML = '<tr><td colspan="4" class="label">-</td></tr>';
    trackerById("freqRowsAll").innerHTML = '<tr><td colspan="4" class="label">-</td></tr>';
    return;
  }

  const sat = hamItems.find((s) => s.sat_id === selectedSatId)
    || hamItems.find((s) => s.sat_id === "iss-zarya")
    || hamItems[0];
  selectedSatId = sat.sat_id;

  const activePass = selectedFrequencyPass();
  const recommendation = activePass?.frequencyRecommendation || null;
  const matrix = activePass?.frequencyMatrix || null;
  const guideRows = rowsFromRecommendation(recommendation, matrix);
  const rows = frequencyEntriesForSatellite(sat);
  const compactRows = compactHamRows(rows, 3);
  const allRows = sortedRowsForAll(rows);
  const primary = recommendation
    ? {
        mode: recommendation.label || "Pass Frequencies",
        uplink: fmtGuideMHz(recommendation.uplink_mhz),
        downlink: fmtGuideMHz(recommendation.downlink_mhz),
        bands: `${recommendation.uplink_label || "Uplink"} -> ${recommendation.downlink_label || "Downlink"}`,
      }
    : compactRows[0] || rows[0] || { mode: "General", uplink: "—", downlink: "—", bands: "Unknown -> Unknown" };

  trackerById("freqSelectedName").textContent = `${sat.name} (${sat.norad_id})`;
  renderAmsatSummary(sat.operational_status || null);
  trackerById("freqModeLegend").textContent = "Beginner legend: V = VHF 2m, U = UHF 70cm, L = 23cm";
  trackerById("freqPrimaryLine").textContent =
    recommendation
      ? `Primary: ${primary.mode} | ${primary.uplink} up / ${primary.downlink} down | ${correctionSideLabel(recommendation.correction_side)}`
      : `Primary: ${primary.mode} | ${primary.uplink} up / ${primary.downlink} down`;
  trackerById("freqStatus").textContent = recommendation
    ? `${recommendation.is_ongoing ? "Tune now" : "Tune next"} from active pass ${activePass?.name || sat.name}`
    : "Showing static catalog frequencies";
  trackerById("freqRowsCompact").innerHTML = renderFrequencyRows(
    guideRows.length ? guideRows : (compactRows.length ? compactRows : rows),
    3
  );
  trackerById("freqRowsAll").innerHTML = renderFrequencyRows(allRows);
}

function ensureTrackSelector(items) {
  const hamItems = items.filter(isHamFrequencySatellite);
  const select = trackerById("trackSatSelect");
  if (!select) return;
  const current = selectedSatId;
  const options = hamItems.map((s) => `<option value="${s.sat_id}">${s.name}</option>`).join("");
  select.innerHTML = options;
  if (current && hamItems.some((s) => s.sat_id === current)) {
    select.value = current;
  } else if (hamItems.length) {
    select.value = hamItems[0].sat_id;
    selectedSatId = hamItems[0].sat_id;
  }
}

function ensurePassSatSelector(items) {
  const hamItems = items.filter(isHamFrequencySatellite);
  const select = trackerById("passSatSelect");
  if (!select) return;
  const options = hamItems
    .map((s) => `<option value="${s.sat_id}">${s.name} (${s.norad_id})</option>`)
    .join("");
  select.innerHTML = options;
  for (const opt of select.options) {
    opt.selected = selectedPassSatIds.includes(opt.value);
  }
}

function syncPassProfileUi() {
  const passProfile = trackerById("passProfile");
  const passSatSelect = trackerById("passSatSelect");
  const editPassProfile = trackerById("editPassProfile");
  const passProfileEditor = trackerById("passProfileEditor");
  if (!passProfile || !passSatSelect || !editPassProfile || !passProfileEditor) return;
  passProfile.value = selectedPassProfile;
  const canEdit = selectedPassProfile === "Favorites";
  passSatSelect.disabled = !canEdit;
  editPassProfile.style.display = canEdit ? "inline-block" : "none";
  const showEditor = canEdit && passProfileEditorOpen;
  passProfileEditor.classList.toggle("hidden", !showEditor);
}

function syncTimezoneUi() {
  const select = trackerById("displayTimezone");
  if (!select) return;
  const selection = resolvedDisplayTimezoneSelection();
  if (![...select.options].some((o) => o.value === selection)) {
    select.insertAdjacentHTML("beforeend", `<option value="${selection}">${selection}</option>`);
  }
  select.value = selection;
}

function ensureTimezoneSelector() {
  const select = trackerById("displayTimezone");
  if (!select) return;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const choices = Array.from(new Set([browserTz, ...TIMEZONE_CHOICES]));
  const sorted = choices
    .filter((tz) => tz !== "BrowserLocal" && tz !== "UTC")
    .sort((a, b) => a.localeCompare(b));
  const ordered = ["BrowserLocal", "UTC", ...sorted];
  select.innerHTML = ordered
    .map((tz) => `<option value="${tz}">${tz === "BrowserLocal" ? `Browser local (${browserTz})` : tz}</option>`)
    .join("");
  syncTimezoneUi();
}

function syncLocationModeUi() {
  const locationMode = trackerById("locationMode");
  const manual = trackerById("manualLocationGroup");
  const gps = trackerById("gpsLocationGroup");
  if (!locationMode || !manual || !gps) return;
  const mode = locationMode.value;
  manual.classList.toggle("hidden", mode !== "manual");
  gps.classList.toggle("hidden", mode !== "gps");
}

function setTelemetryDrawer(open) {
  telemetryDrawerOpen = Boolean(open);
  const drawer = trackerById("telemetryDrawer");
  drawer.classList.toggle("hidden", !telemetryDrawerOpen);
  drawer.setAttribute("aria-hidden", telemetryDrawerOpen ? "false" : "true");
}

function resetDialState() {
  trailPoints.length = 0;
  forecastTrackItems = [];
  forecastPassKey = "";
  forecastSatId = null;
  lastForecastRefreshAt = 0;
  dialPassState = null;
  clearDialLayers();
}

function loadVideoSourcesFromStorage() {
  try {
    const raw = localStorage.getItem(VIDEO_SOURCES_KEY);
    if (!raw) {
      youtubeIssEmbedSources = [...DEFAULT_YOUTUBE_ISS_EMBED_SOURCES];
      return;
    }
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      youtubeIssEmbedSources = [...DEFAULT_YOUTUBE_ISS_EMBED_SOURCES];
      return;
    }
    const cleaned = arr.map((x) => String(x || "").trim()).filter(Boolean);
    youtubeIssEmbedSources = cleaned.length ? cleaned : [...DEFAULT_YOUTUBE_ISS_EMBED_SOURCES];
    activeVideoSourceIndex = Math.min(activeVideoSourceIndex, youtubeIssEmbedSources.length - 1);
  } catch (_) {
    youtubeIssEmbedSources = [...DEFAULT_YOUTUBE_ISS_EMBED_SOURCES];
  }
}

function applyVideoSource(videoEl, index) {
  const safeIndex = Math.max(0, Math.min(youtubeIssEmbedSources.length - 1, index));
  activeVideoSourceIndex = safeIndex;
  const url = youtubeIssEmbedSources[safeIndex];
  if (videoEl.src !== url) videoEl.src = url;
}

function buildSystemQuery() {
  const satQuery = selectedSatId ? `?sat_id=${encodeURIComponent(selectedSatId)}` : "";
  const locationQuery = selectedLocationSource ? `location_source=${encodeURIComponent(selectedLocationSource)}` : "";
  return satQuery
    ? `${satQuery}&${locationQuery}`.replace("?&", "?")
    : (locationQuery ? `?${locationQuery}` : "");
}

function buildPassesQuery() {
  const passParams = new URLSearchParams({ hours: "24", include_ongoing: "true" });
  if (selectedLocationSource) passParams.set("location_source", selectedLocationSource);
  return `?${passParams.toString()}`;
}

function applySystemSnapshot(sys, mode) {
  const issMode = trackerById("issMode");
  if (mode?.mode && issMode) issMode.value = mode.mode;
  const iss = sys.iss;
  const track = sys.activeTrack || sys.issTrack;
  if (track && track.sat_id && !selectedSatId) {
    selectedSatId = track.sat_id;
  }
  trackerById("issSummary").textContent = modeLabel(iss.mode);
  trackerById("issTrack").textContent =
    `${track.name} | Az ${track.az_deg.toFixed(1)}\u00B0 | Alt ${track.el_deg.toFixed(1)}\u00B0 | Range ${track.range_km.toFixed(1)} km`;

  trackerById("locationSummary").textContent =
    `${sys.location.source}: ${sys.location.lat.toFixed(4)}, ${sys.location.lon.toFixed(4)}`;
  trackerById("networkSummary").textContent = `Network mode: ${sys.network.mode}`;
  trackerById("diagSat").textContent =
    `Satellite: ${track.name} (${track.sat_id}) | Range ${track.range_km.toFixed(1)} km`;
  trackerById("diagLoc").textContent =
    `Observer: ${sys.location.source} | lat ${Number(sys.location.lat).toFixed(6)} lon ${Number(sys.location.lon).toFixed(6)} alt ${Number(sys.location.alt_m || 0).toFixed(1)} m`;
  trackerById("diagTime").textContent =
    `UTC Used: ${sys.timestamp} | Sunlit=${track.sunlit ? "yes" : "no"}`;
  if (trackerRenderStationBadge) {
    trackerRenderStationBadge("stationBadge", sys.stationIdentity, sys.aprsSettings);
  }
  renderStationIdentity(sys.stationIdentity, sys.aprsSettings);

  const cue = trackCue(track, previousTrack);
  previousTrack = { az_deg: track.az_deg, el_deg: track.el_deg };
  renderMiniSkyplot(track);
  renderSkyplot(track, sys.bodies || [], sys.location);
  trackerById("compassReadout").textContent = `Az ${track.az_deg.toFixed(1)}\u00B0 | Alt ${track.el_deg.toFixed(1)}\u00B0`;
  trackerById("drawerReadout").textContent = trackerById("compassReadout").textContent;
  trackerById("telemetryCue").textContent = cue;
  trackerById("drawerCue").textContent = cue;
  trackerById("compassText").textContent = statusText(iss);
  trackerById("diagSatDrawer").textContent = trackerById("diagSat").textContent;
  trackerById("diagLocDrawer").textContent = trackerById("diagLoc").textContent;
  trackerById("diagTimeDrawer").textContent = trackerById("diagTime").textContent;
  trackerById("miniBadges").innerHTML = [
    `<span class="chip">${track.sunlit ? "Sunlit" : "Dark"}</span>`,
    `<span class="chip">${iss.aboveHorizon ? "Above Horizon" : "Below Horizon"}</span>`,
    `<span class="chip">${iss.videoEligible ? "Video Eligible" : "Telemetry Mode"}</span>`,
  ].join("");

  const videoCard = trackerById("videoCard");
  const video = trackerById("issVideo");
  const videoStatus = trackerById("videoStatus");
  loadVideoSourcesFromStorage();
  if (iss.mode === "TelemetryOnly") {
    videoCard.style.display = "none";
    video.src = "";
    videoStatus.textContent = "";
  } else if (iss.videoEligible && iss.streamHealthy) {
    videoCard.style.display = "block";
    applyVideoSource(video, activeVideoSourceIndex);
    videoStatus.textContent = activeVideoSourceIndex === 0
      ? "YouTube live feed active (primary source)"
      : "YouTube live feed active (secondary source)";
  } else {
    videoCard.style.display = "block";
    applyVideoSource(video, activeVideoSourceIndex);
    videoStatus.textContent = "ISS telemetry not video-eligible; showing YouTube feed";
  }
}

async function loadState() {
  const systemQuery = buildSystemQuery();
  const passesQuery = buildPassesQuery();
  const [sys, passes, mode, sats, locationState, passFilter, timezone] = await Promise.all([
    trackerApi.get(`/api/v1/system/state${systemQuery}`),
    trackerApi.get(`/api/v1/passes${passesQuery}`),
    trackerApi.get("/api/v1/settings/iss-display-mode"),
    trackerApi.get("/api/v1/satellites"),
    trackerApi.get("/api/v1/location"),
    trackerApi.get("/api/v1/settings/pass-filter"),
    trackerApi.get("/api/v1/settings/timezone"),
  ]);

  const issMode = trackerById("issMode");
  if (issMode) issMode.value = mode.mode;
  selectedPassProfile = passFilter.profile || "IssOnly";
  selectedPassSatIds = Array.isArray(passFilter.satIds) && passFilter.satIds.length
    ? passFilter.satIds
    : ["iss-zarya"];
  selectedDisplayTimezone = timezone.timezone || "BrowserLocal";
  updateClock();
  const locationMode = trackerById("locationMode");
  if (locationMode) locationMode.value = locationState.state.source_mode;
  selectedLocationSource = locationState.state.source_mode;
  syncLocationModeUi();
  latestPassItems = passes.items || [];
  if (!selectedSatId && sys.activeTrack?.sat_id) selectedSatId = sys.activeTrack.sat_id;
  await refreshForecastPath(chooseDialPass(sys.activeTrack || sys.issTrack));
  applySystemSnapshot(sys, mode);

  renderPasses(latestPassItems);
  renderFrequencies(sats.items);
  ensureTrackSelector(sats.items);
  ensurePassSatSelector(sats.items);
  syncPassProfileUi();
  ensureTimezoneSelector();
  syncTimezoneUi();
}

async function saveBootCallsign() {
  const input = trackerById("bootCallsign");
  const value = (input?.value || "").trim().toUpperCase();
  const response = await trackerApi.post("/api/v1/settings/aprs", { callsign: value });
  renderStationIdentity(
    {
      configured: value.length >= 3 && value !== "N0CALL",
      callsign: value,
      reason: value ? null : "Radio control is disabled until a valid callsign is saved.",
    },
    response.state
  );
  await loadState();
}

async function refreshLiveOnly() {
  const [sys, mode] = await Promise.all([
    trackerApi.get(`/api/v1/system/state${buildSystemQuery()}`),
    trackerApi.get("/api/v1/settings/iss-display-mode"),
  ]);
  await refreshForecastPath(chooseDialPass(sys.activeTrack || sys.issTrack));
  applySystemSnapshot(sys, mode);
}

async function refreshPassesOnly() {
  const passes = await trackerApi.get(`/api/v1/passes${buildPassesQuery()}`);
  latestPassItems = passes.items || [];
  renderPasses(latestPassItems);
}

async function refreshCatalogOnly() {
  const sats = await trackerApi.get("/api/v1/satellites");
  renderFrequencies(sats.items);
  ensureTrackSelector(sats.items);
  ensurePassSatSelector(sats.items);
}

async function refreshFromSources() {
  const sats = await trackerApi.get("/api/v1/satellites?refresh_from_sources=true");
  trackerById("freqStatus").textContent = sats.refreshed
    ? `Frequencies refreshed from sources (${sats.count} satellites) | Ephemeris: ${sats.ephemerisRefreshed ? "updated" : "cached"}`
    : `Frequency refresh failed, using cache: ${sats.refreshError || "unknown error"}`;
}

async function setMode() {
  const mode = trackerById("issMode").value;
  await trackerApi.post("/api/v1/settings/iss-display-mode", { mode });
  await loadState();
}

async function savePassProfile() {
  const profile = trackerById("passProfile").value;
  const satIds = Array.from(trackerById("passSatSelect").selectedOptions).map((o) => o.value);
  await trackerApi.post("/api/v1/settings/pass-filter", { profile, sat_ids: satIds });
  selectedPassProfile = profile;
  selectedPassSatIds = satIds.length ? satIds : ["iss-zarya"];
  passProfileEditorOpen = false;
  syncPassProfileUi();
  await loadState();
}

async function saveTimezone() {
  const picked = trackerById("displayTimezone").value;
  if (!picked) return;
  const tzToSave = picked;
  await trackerApi.post("/api/v1/settings/timezone", { timezone: tzToSave });
  selectedDisplayTimezone = tzToSave;
  localStorage.setItem(DISPLAY_TIMEZONE_CHOICE_KEY, tzToSave);
  updateClock();
  syncTimezoneUi();
  await refreshPassesOnly();
}

async function applyLocationMode() {
  const locationMode = trackerById("locationMode");
  if (!locationMode) return;
  const source_mode = locationMode.value;
  selectedLocationSource = source_mode;
  syncLocationModeUi();
  if (source_mode === "browser") {
    // Capture fresh system location before switching source.
    await trackerSetBrowserLocation();
  }
  await trackerApi.post("/api/v1/location", { source_mode });
  resetDialState();
  await loadState();
}

async function applyManualLocation() {
  const lat = Number(trackerById("manualLat").value);
  const lon = Number(trackerById("manualLon").value);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return;
  await trackerApi.post("/api/v1/location", {
    source_mode: "manual",
    add_profile: { id: "manual-kiosk", name: "Manual Kiosk", point: { lat, lon, alt_m: 0 } },
    selected_profile_id: "manual-kiosk",
  });
  selectedLocationSource = "manual";
  resetDialState();
  await loadState();
}

async function applyGpsLocation() {
  const lat = Number(trackerById("gpsLat").value);
  const lon = Number(trackerById("gpsLon").value);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return;
  await trackerApi.post("/api/v1/location", {
    source_mode: "gps",
    gps_location: { lat, lon, alt_m: 0 },
  });
  selectedLocationSource = "gps";
  resetDialState();
  await loadState();
}

window.addEventListener("DOMContentLoaded", async () => {
  if (!window.issTracker) {
    const el = document.getElementById("issSummary");
    if (el) el.textContent = "Error: core script not loaded (window.issTracker missing)";
    return;
  }
  ({
    api: trackerApi,
    byId: trackerById,
    setBrowserLocation: trackerSetBrowserLocation,
    renderStationBadge: trackerRenderStationBadge,
  } = window.issTracker);
  selectedSatId = localStorage.getItem(TRACKED_SAT_KEY) || selectedSatId;

  const saveModeBtn = trackerById("saveMode");
  if (saveModeBtn) saveModeBtn.addEventListener("click", setMode);
  const savePassProfileBtn = trackerById("savePassProfile");
  if (savePassProfileBtn) savePassProfileBtn.addEventListener("click", async () => {
    try {
      await savePassProfile();
    } catch (err) {
      trackerById("issSummary").textContent = `Error: ${err.message}`;
    }
  });
  const passProfile = trackerById("passProfile");
  if (passProfile) passProfile.addEventListener("change", () => {
    selectedPassProfile = trackerById("passProfile").value;
    if (selectedPassProfile !== "Favorites") passProfileEditorOpen = false;
    syncPassProfileUi();
  });
  const editPassProfile = trackerById("editPassProfile");
  if (editPassProfile) editPassProfile.addEventListener("click", () => {
    passProfileEditorOpen = !passProfileEditorOpen;
    syncPassProfileUi();
  });
  const displayTimezone = trackerById("displayTimezone");
  if (displayTimezone) displayTimezone.addEventListener("change", async () => {
    try {
      await saveTimezone();
    } catch (err) {
      trackerById("locationSummary").textContent = `Timezone error: ${err.message}`;
    }
  });
  const trackSatSelect = trackerById("trackSatSelect");
  if (trackSatSelect) trackSatSelect.addEventListener("change", async (ev) => {
    selectedSatId = ev.target.value || null;
    if (selectedSatId) localStorage.setItem(TRACKED_SAT_KEY, selectedSatId);
    resetDialState();
    setTelemetryDrawer(true);
    try {
      await loadState();
    } catch (err) {
      trackerById("issSummary").textContent = `Error: ${err.message}`;
    }
  });
  trackerById("openTelemetryDrawer").addEventListener("click", () => setTelemetryDrawer(true));
  trackerById("closeTelemetryDrawer").addEventListener("click", () => setTelemetryDrawer(false));
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && telemetryDrawerOpen) setTelemetryDrawer(false);
  });
  const locationMode = trackerById("locationMode");
  if (locationMode) locationMode.addEventListener("change", async () => {
    syncLocationModeUi();
    try {
      await applyLocationMode();
    } catch (err) {
      trackerById("locationSummary").textContent = `Error: ${err.message}`;
    }
  });
  const applyManualBtn = trackerById("applyManual");
  if (applyManualBtn) applyManualBtn.addEventListener("click", async () => {
    try {
      await applyManualLocation();
    } catch (err) {
      trackerById("locationSummary").textContent = `Error: ${err.message}`;
    }
  });
  const applyGpsBtn = trackerById("applyGps");
  if (applyGpsBtn) applyGpsBtn.addEventListener("click", async () => {
    try {
      await applyGpsLocation();
    } catch (err) {
      trackerById("locationSummary").textContent = `Error: ${err.message}`;
    }
  });
  trackerById("passRows").addEventListener("click", async (ev) => {
    const row = ev.target.closest("tr[data-sat-id]");
    if (!row) return;
    selectedSatId = row.dataset.satId || null;
    if (selectedSatId) localStorage.setItem(TRACKED_SAT_KEY, selectedSatId);
    resetDialState();
    setTelemetryDrawer(true);
    try {
      await loadState();
    } catch (err) {
      trackerById("issSummary").textContent = `Error: ${err.message}`;
    }
  });
  const refreshNowBtn = trackerById("refreshNow");
  if (refreshNowBtn) refreshNowBtn.addEventListener("click", async () => {
    try {
      await loadState();
    } catch (err) {
      trackerById("issSummary").textContent = `Error: ${err.message}`;
    }
  });
  updateClock();
  setInterval(updateClock, 1000);

  const issVideo = trackerById("issVideo");
  if (issVideo) {
    issVideo.addEventListener("error", () => {
      if (activeVideoSourceIndex === 0 && youtubeIssEmbedSources.length > 1) {
        activeVideoSourceIndex = 1;
        applyVideoSource(issVideo, activeVideoSourceIndex);
        const videoStatus = trackerById("videoStatus");
        if (videoStatus) videoStatus.textContent = "Primary stream unavailable; switched to secondary source";
      }
    });
  }

  trackerById("freqStatus").textContent = "Using cached satellite/frequency catalog";
  const saveBootCallsignBtn = trackerById("saveBootCallsign");
  if (saveBootCallsignBtn) saveBootCallsignBtn.addEventListener("click", async () => {
    try {
      await saveBootCallsign();
    } catch (err) {
      const status = trackerById("bootCallsignStatus");
      if (status) status.textContent = `Callsign save error: ${err.message}`;
    }
  });
  const bootCallsign = trackerById("bootCallsign");
  if (bootCallsign) bootCallsign.addEventListener("keydown", async (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    try {
      await saveBootCallsign();
    } catch (err) {
      const status = trackerById("bootCallsignStatus");
      if (status) status.textContent = `Callsign save error: ${err.message}`;
    }
  });

  const tick = async () => {
    try {
      await refreshLiveOnly();
    } catch (err) {
      trackerById("issSummary").textContent = `Error: ${err.message}`;
      trackerById("locationSummary").textContent = "API error";
    }
  };

  // Prime all UI sections once at startup so selectors/tables are populated immediately.
  await loadState();
  syncLocationModeUi();
  setTelemetryDrawer(false);
  await tick();
  setInterval(tick, 5000);
  setInterval(async () => {
    try {
      await refreshPassesOnly();
      await refreshCatalogOnly();
    } catch (_) {}
  }, 30000);
});

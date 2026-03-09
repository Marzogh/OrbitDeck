let trackerApi;
let trackerById;
let trackerSetBrowserLocation;
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
const BODY_COLORS = {
  Sun: "#ffd400",
  Moon: "#7fe0ff",
  Mercury: "#ff57b3",
  Venus: "#6dff7b",
  Mars: "#ff623e",
  Jupiter: "#9d7bff",
  Saturn: "#ff9b2e",
};

function effectiveDisplayTimezone() {
  return selectedDisplayTimezone === "BrowserLocal"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    : selectedDisplayTimezone;
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
  if (/aprs/i.test(text)) return 100;
  if (/(voice repeater|repeater|ctcss)/i.test(text)) return 90;
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
    ? visibleBodies.map((b) => `<span class="body-key"><span class="body-key-dot" style="background:${b.color}"></span><span class="body-key-sym">${bodySymbol(b.name)}</span>${b.name}</span>`).join("")
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
  const { x, y } = azElToXY(track.az_deg, track.el_deg);
  trailPoints.push({ x, y });
  if (trailPoints.length > MAX_TRAIL) trailPoints.shift();

  const dot = trackerById("issDot");
  const vector = trackerById("issVector");
  const trail = trackerById("issTrail");
  dot.setAttribute("cx", x.toFixed(2));
  dot.setAttribute("cy", y.toFixed(2));
  vector.setAttribute("x2", x.toFixed(2));
  vector.setAttribute("y2", y.toFixed(2));
  trail.setAttribute(
    "points",
    trailPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
  );

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

function renderPasses(items) {
  trackerById("passTimeBasis").textContent = `Times shown in ${effectiveDisplayTimezone()}`;
  trackerById("nextPassCountdown").textContent = "";

  if (!items.length) {
    trackerById("passRows").innerHTML = '<tr><td colspan="5" class="label">No passes in range for selected pass profile</td></tr>';
    return;
  }
  const nextAos = new Date(items[0].aos).getTime();
  const deltaSec = Math.floor((nextAos - Date.now()) / 1000);
  if (Number.isFinite(deltaSec) && deltaSec > 0) {
    const h = Math.floor(deltaSec / 3600);
    const m = Math.floor((deltaSec % 3600) / 60);
    const s = deltaSec % 60;
    const text = h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
    trackerById("nextPassCountdown").textContent = `Next AOS in ${text}`;
  }
  const rows = items.slice(0, 10).map((p) => `
    <tr data-sat-id="${p.sat_id}" class="${selectedSatId === p.sat_id ? "selected-row" : ""}">
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

  const rows = frequencyEntriesForSatellite(sat);
  const compactRows = compactHamRows(rows, 3);
  const allRows = sortedRowsForAll(rows);
  const primary = compactRows[0] || rows[0] || { mode: "General", uplink: "—", downlink: "—", bands: "Unknown -> Unknown" };

  trackerById("freqSelectedName").textContent = `${sat.name} (${sat.norad_id})`;
  renderAmsatSummary(sat.operational_status || null);
  trackerById("freqModeLegend").textContent = "Beginner legend: V = VHF 2m, U = UHF 70cm, L = 23cm";
  trackerById("freqPrimaryLine").textContent =
    `Primary: ${primary.mode} | ${primary.uplink} up / ${primary.downlink} down`;
  trackerById("freqRowsCompact").innerHTML = renderFrequencyRows(compactRows.length ? compactRows : rows, 3);
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
  if (![...select.options].some((o) => o.value === selectedDisplayTimezone)) {
    select.insertAdjacentHTML("beforeend", `<option value="${selectedDisplayTimezone}">${selectedDisplayTimezone}</option>`);
  }
  select.value = selectedDisplayTimezone;
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
  const passParams = new URLSearchParams({ hours: "24" });
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
  selectedDisplayTimezone = timezone.timezone || "UTC";
  updateClock();
  const locationMode = trackerById("locationMode");
  if (locationMode) locationMode.value = locationState.state.source_mode;
  selectedLocationSource = locationState.state.source_mode;
  syncLocationModeUi();
  applySystemSnapshot(sys, mode);

  renderPasses(passes.items);
  renderFrequencies(sats.items);
  ensureTrackSelector(sats.items);
  ensurePassSatSelector(sats.items);
  syncPassProfileUi();
  ensureTimezoneSelector();
  syncTimezoneUi();
}

async function refreshLiveOnly() {
  const [sys, mode] = await Promise.all([
    trackerApi.get(`/api/v1/system/state${buildSystemQuery()}`),
    trackerApi.get("/api/v1/settings/iss-display-mode"),
  ]);
  applySystemSnapshot(sys, mode);
}

async function refreshPassesOnly() {
  const passes = await trackerApi.get(`/api/v1/passes${buildPassesQuery()}`);
  renderPasses(passes.items);
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
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const tzToSave = picked === "BrowserLocal" ? browserTz : picked;
  await trackerApi.post("/api/v1/settings/timezone", { timezone: tzToSave });
  selectedDisplayTimezone = picked === "BrowserLocal" ? "BrowserLocal" : tzToSave;
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
  trailPoints.length = 0;
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
  trailPoints.length = 0;
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
  trailPoints.length = 0;
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
    trailPoints.length = 0;
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
    trailPoints.length = 0;
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

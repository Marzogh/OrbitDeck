let trackerApi;
let trackerById;
const LITE_CACHE_KEY = "issTrackerLiteSnapshotV2";
const LITE_FOCUS_SAT_KEY = "issTrackerLiteFocusSatId";
const LIVE_REFRESH_MS = 30000;
const HIDDEN_REFRESH_MS = 120000;
const SNAPSHOT_WARN_AFTER_HOURS = 12;
const SNAPSHOT_CRITICAL_AFTER_HOURS = 24;
const MAX_TRACKED_SATS = 8;
let refreshTimer = null;
let latestRenderedSnapshot = null;
let savedFocusSatId = localStorage.getItem(LITE_FOCUS_SAT_KEY) || null;
let temporaryFocusSatId = null;
let currentLiteSettings = null;
let availableSatellites = [];
let setupGatePinnedOpen = false;

function updateClock() {
  const now = new Date();
  trackerById("clock").textContent = `${now.toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    month: "short",
    day: "numeric",
  })}`;
}

function modeLabel(mode) {
  if (mode === "SunlitOnlyVideo") return "Video when ISS is sunlit";
  if (mode === "SunlitAndVisibleVideo") return "Video when ISS is sunlit and above horizon";
  return "Telemetry only";
}

function effectiveDisplayTimezone() {
  return latestRenderedSnapshot?.timezone?.timezone || "UTC";
}

function fmtLocalTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString([], {
    timeZone: effectiveDisplayTimezone(),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtRelativeAge(iso) {
  if (!iso) return "unknown age";
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta)) return "unknown age";
  const sec = Math.max(0, Math.round(delta / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

function fmtFreshness(iso) {
  if (!iso) return "unknown";
  return `Last sync ${fmtRelativeAge(iso)}`;
}

function snapshotAgeHours(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta)) return Number.POSITIVE_INFINITY;
  return Math.max(0, delta / (1000 * 60 * 60));
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

function normalizeFreqToken(text) {
  return String(text || "").replace(/\b\d{7,11}\b/g, (m) => {
    const n = Number(m);
    if (!Number.isFinite(n) || n <= 0) return m;
    return `${(n / 1_000_000).toFixed(3)} MHz`;
  });
}

function azElToXY(azDeg, elDeg, radius = 108, cx = 120, cy = 120) {
  const az = (azDeg * Math.PI) / 180;
  const el = Math.max(0, Math.min(90, elDeg));
  const r = ((90 - el) / 90) * radius;
  return { x: cx + r * Math.sin(az), y: cy - r * Math.cos(az) };
}

function skyplotPathD(items) {
  const visible = (items || [])
    .filter((item) => Number.isFinite(Number(item?.az_deg)) && Number.isFinite(Number(item?.el_deg)))
    .map((item) => azElToXY(Number(item.az_deg), Number(item.el_deg)));
  if (visible.length < 2) return "";
  return visible.map((point, idx) => `${idx === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

function splitTrackPath(trackPath, activeTime, isUpcoming) {
  const points = (trackPath || []).filter((item) => item && item.timestamp);
  if (points.length < 2) return { faded: [], past: [], future: [] };
  if (isUpcoming) return { faded: [], past: [], future: points };
  if (!activeTime) return { faded: points, past: [], future: [] };
  const activeMs = new Date(activeTime).getTime();
  let splitIdx = -1;
  points.forEach((item, idx) => {
    if (new Date(item.timestamp).getTime() <= activeMs) splitIdx = idx;
  });
  if (splitIdx < 0) return { faded: [], past: [], future: points };
  if (splitIdx >= points.length - 1) return { faded: [], past: points, future: [] };
  return {
    faded: [],
    past: points.slice(0, splitIdx + 1),
    future: points.slice(splitIdx, points.length),
  };
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
  if (v >= 430 && v <= 440) return "UHF 70cm";
  if (v >= 1240 && v <= 1300) return "L 23cm";
  if (v >= 2200 && v <= 2450) return "S 13cm";
  if (v >= 10450 && v <= 10500) return "X 3cm";
  return `${v.toFixed(3)} MHz`;
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
      bands: pair.up !== "—" || pair.down !== "—" ? `${upBand} -> ${downBand}` : "Unknown",
    });
  }
  return rows
    .filter((r) => r.up !== "—" || r.down !== "—")
    .sort((a, b) => scoreHamUsefulness(b) - scoreHamUsefulness(a))
    .slice(0, 6);
}

function isRotatorEligiblePass(pass) {
  const duration = (new Date(pass.los).getTime() - new Date(pass.aos).getTime()) / 60000;
  return Number.isFinite(duration) && duration <= 10;
}

function passMeetsRotatorElevation(pass) {
  const isIss = String(pass?.sat_id || "").toLowerCase() === "iss-zarya";
  return Number(pass.max_el_deg) >= (isIss ? 20 : 40);
}

function filterConsolePasses(passes) {
  const now = Date.now();
  return (passes || [])
    .filter((p) => new Date(p.los).getTime() >= now)
    .filter(isRotatorEligiblePass)
    .filter(passMeetsRotatorElevation);
}

function buildRadioQueue(snapshot) {
  const qualifyingPasses = filterConsolePasses(snapshot.passes || []);
  const satMap = new Map((snapshot.trackedSatellites || []).map((sat) => [sat.sat_id, sat]));
  const seenSatIds = new Set();
  const queue = [];
  for (const pass of qualifyingPasses) {
    if (seenSatIds.has(pass.sat_id)) continue;
    seenSatIds.add(pass.sat_id);
    const sat = satMap.get(pass.sat_id);
    queue.push({ pass, sat, channels: frequencyEntriesForSatellite(sat) });
    if (queue.length >= 5) break;
  }
  return queue;
}

function passTimeMarkup(pass, options = {}) {
  const parts = [
    `<span>AOS ${fmtLocalTime(pass.aos)}</span>`,
    `<span>TCA ${fmtLocalTime(pass.tca)}</span>`,
    `<span>LOS ${fmtLocalTime(pass.los)}</span>`,
  ];
  if (options.includeMaxEl) parts.push(`<span>MaxEl ${pass.max_el_deg.toFixed(1)} deg</span>`);
  return `<div class="lite-pass-times mono">${parts.join("")}</div>`;
}

function fmtGuideMHz(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(3)} MHz` : "—";
}

function frequencyGuideMarkup(recommendation, matrix) {
  if (!recommendation) return "";
  const chips = [
    `<span class="chip">${recommendation.label}</span>`,
    recommendation.phase ? `<span class="chip">${String(recommendation.phase).toUpperCase()}</span>` : "",
    recommendation.tone ? `<span class="chip">Tone ${recommendation.tone}</span>` : "",
    recommendation.beacon_mhz ? `<span class="chip">Beacon ${fmtGuideMHz(recommendation.beacon_mhz)}</span>` : "",
    recommendation.preset ? `<span class="chip">${recommendation.preset}</span>` : "",
  ].filter(Boolean).join("");
  const rows = `
    <div class="lite-radio-channel">
      <div class="lite-radio-channel-mode">Pass Frequencies</div>
      <div class="lite-guide-primary">
        <div class="lite-radio-pair"><span class="lite-radio-label">Up</span><span class="mono">${fmtGuideMHz(recommendation.uplink_mhz)}${recommendation.uplink_mode ? ` ${recommendation.uplink_mode}` : ""}</span></div>
        <div class="lite-radio-pair"><span class="lite-radio-label">Down</span><span class="mono">${fmtGuideMHz(recommendation.downlink_mhz)}${recommendation.downlink_mode ? ` ${recommendation.downlink_mode}` : ""}</span></div>
      </div>
      <div class="lite-pass-chip-row">${chips}</div>
      <div class="lite-radio-band-line">${recommendation.uplink_label || "Uplink"} -> ${recommendation.downlink_label || "Downlink"} | ${recommendation.correction_side === "full_duplex" ? "Full duplex correction" : recommendation.correction_side === "downlink_only" ? "Downlink Doppler only" : "UHF-side Doppler only"}</div>
      ${recommendation.note ? `<div class="lite-card-hint">${recommendation.note}</div>` : ""}
      ${recommendation.schedule_note ? `<div class="lite-card-hint">${recommendation.schedule_note}</div>` : ""}
    </div>
  `;
  if (!matrix || !(matrix.rows || []).length) return rows;
  const matrixRows = matrix.rows.map((row) => `
    <div class="lite-guide-matrix-row ${row.phase === matrix.active_phase ? "is-active" : ""}">
      <span>${String(row.phase).toUpperCase()}</span>
      <span>${fmtGuideMHz(row.uplink_mhz)}</span>
      <span>${fmtGuideMHz(row.downlink_mhz)}</span>
    </div>
  `).join("");
  return `${rows}<div class="lite-guide-matrix"><div class="lite-guide-matrix-head"><span>Phase</span><span>Up</span><span>Down</span></div>${matrixRows}</div>`;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/static/lite/sw.js", { scope: "/" });
  } catch (_) {}
}

function loadCachedSnapshot() {
  try {
    const raw = localStorage.getItem(LITE_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function saveCachedSnapshot(snapshot) {
  try {
    localStorage.setItem(LITE_CACHE_KEY, JSON.stringify(snapshot));
  } catch (_) {}
}

async function fetchLiteSettings() {
  return trackerApi.get("/api/v1/settings/lite");
}

async function fetchSnapshot() {
  const satId = temporaryFocusSatId || savedFocusSatId;
  const query = satId ? `?sat_id=${encodeURIComponent(satId)}` : "";
  const snapshot = await trackerApi.get(`/api/v1/lite/snapshot${query}`);
  snapshot.cachedAt = new Date().toISOString();
  snapshot.source = "live";
  return snapshot;
}

function renderTrackedSatelliteOptions(selectId, selectedIds) {
  const select = trackerById(selectId);
  if (!select) return;
  const selectedSet = new Set(selectedIds || []);
  select.innerHTML = availableSatellites
    .map((sat) => `<option value="${sat.sat_id}" ${selectedSet.has(sat.sat_id) ? "selected" : ""}>${sat.name}</option>`)
    .join("");
}

function trackedSatelliteSummary(selectedIds) {
  const ids = selectedIds || [];
  if (!ids.length) return "No tracked satellites selected.";
  const names = ids
    .map((satId) => availableSatellites.find((sat) => sat.sat_id === satId)?.name || satId)
    .slice(0, 3);
  const extra = ids.length > names.length ? ` +${ids.length - names.length} more` : "";
  return `Tracking ${ids.length}/${MAX_TRACKED_SATS}: ${names.join(", ")}${extra}`;
}

function selectedValues(selectId) {
  const select = trackerById(selectId);
  return Array.from(select?.selectedOptions || []).map((o) => o.value).filter(Boolean);
}

function syncSetupState() {
  const setupComplete = Boolean(currentLiteSettings?.setup_complete);
  const gateVisible = !setupComplete || setupGatePinnedOpen;
  trackerById("liteSetupGate")?.classList.toggle("hidden", !gateVisible);
  trackerById("liteDashboard")?.classList.toggle("hidden", !setupComplete);
  trackerById("cancelLiteSetup")?.classList.toggle("hidden", !setupComplete || !setupGatePinnedOpen);
  renderTrackedSatelliteOptions("liteTrackedSatSelect", currentLiteSettings?.tracked_sat_ids || ["iss-zarya"]);
  renderTrackedSatelliteOptions("liteTrackedSatSettings", currentLiteSettings?.tracked_sat_ids || []);
  const trackedSummary = trackerById("liteTrackedSummary");
  if (trackedSummary) trackedSummary.textContent = trackedSatelliteSummary(currentLiteSettings?.tracked_sat_ids || []);
}

function renderControlSummary(snapshot) {
  const locationSummary = trackerById("liteLocationSummary");
  const focusSummary = trackerById("liteFocusSummary");
  if (locationSummary) {
    locationSummary.textContent =
      `${snapshot.location.source}: ${snapshot.location.lat.toFixed(4)}, ${snapshot.location.lon.toFixed(4)}`;
  }
  if (focusSummary) {
    if (!savedFocusSatId) {
      focusSummary.textContent = "Auto";
      return;
    }
    focusSummary.textContent = availableSatellites.find((sat) => sat.sat_id === savedFocusSatId)?.name || savedFocusSatId;
  }
}

function heroBadges(selectedSat, snapshot) {
  const iss = snapshot.iss || {};
  const ageHours = snapshotAgeHours(snapshot.cachedAt);
  const ageBadgeClass = ageHours >= SNAPSHOT_CRITICAL_AFTER_HOURS
    ? "chip chip-danger"
    : ageHours >= SNAPSHOT_WARN_AFTER_HOURS
      ? "chip chip-warn"
      : "chip";
  return [
    `<span class="chip ${snapshot.source === "live" ? "chip-ok" : "chip-warn"}">${snapshot.source === "live" ? "Live Pi Link" : "Cached Snapshot"}</span>`,
    `<span class="chip">${selectedSat?.name || "No sat selected"}</span>`,
    `<span class="chip">${iss.sunlit ? "Sunlit" : "Dark Side"}</span>`,
    `<span class="chip">${iss.aboveHorizon ? "Above Horizon" : "Below Horizon"}</span>`,
    `<span class="chip">${modeLabel(iss.mode)}</span>`,
    `<span class="${ageBadgeClass}">${fmtFreshness(snapshot.cachedAt)}</span>`,
  ].join("");
}

function renderAmsatSummary(status) {
  const wrap = trackerById("liteAmsatSummary");
  const badge = trackerById("liteAmsatBadge");
  const detail = trackerById("liteAmsatDetail");
  const counts = trackerById("liteAmsatCounts");
  const matched = trackerById("liteAmsatMatched");
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
    ? `Latest: ${latest.report}${latest.callsign ? ` by ${latest.callsign}` : ""} (${fmtRelativeAge(latest.reported_time)})`
    : "No recent AMSAT reports";
  counts.innerHTML = [
    `<span class="chip">96h reports ${status.reports_last_96h}</span>`,
    `<span class="chip">Heard ${status.heard_count}</span>`,
    `<span class="chip">Telemetry ${status.telemetry_only_count}</span>`,
    `<span class="chip">Not heard ${status.not_heard_count}</span>`,
  ].join("");
  matched.textContent = `AMSAT match: ${status.matched_name} | Checked ${fmtLocalTime(status.checked_at)}`;
}

function renderPassCards(passes, focusSatId) {
  const target = trackerById("passCards");
  const qualifying = filterConsolePasses(passes || []);
  if (!qualifying.length) {
    target.innerHTML = '<div class="lite-pass-item"><div class="lite-pass-title">No passes in the next 24 hours.</div></div>';
    return;
  }
  target.innerHTML = qualifying.slice(0, 6).map((p) => `
    <article class="lite-pass-item ${p.sat_id === focusSatId ? "is-selected" : ""}" data-sat-id="${p.sat_id}">
      <div class="lite-pass-row">
        <div>
          <div class="lite-pass-title">${p.name}</div>
          <div class="lite-card-hint">${p.sat_id === focusSatId ? "Loaded into focus compass" : "Tap card to load this pass into the focus compass"}</div>
        </div>
        <div class="lite-pass-chip-row">
          ${p.sat_id === focusSatId ? '<span class="chip chip-ok">Selected</span>' : ""}
          ${p.sat_id !== focusSatId ? '<span class="chip">Load focus</span>' : ""}
          <span class="chip">${p.max_el_deg.toFixed(0)} deg max</span>
        </div>
      </div>
      ${passTimeMarkup(p)}
    </article>
  `).join("");
}

function renderRadioQueue(snapshot, focusSatId) {
  const target = trackerById("freqRows");
  const queue = buildRadioQueue(snapshot);
  if (!queue.length) {
    target.innerHTML = '<div class="lite-radio-item"><div class="lite-radio-title">No upcoming qualified radio passes.</div></div>';
    return;
  }
  target.innerHTML = queue.map((entry, idx) => {
    const preview = entry.channels[0];
    const channels = entry.channels.length
      ? entry.channels.slice(0, idx === 0 ? 3 : 2).map((ch) => `
        <div class="lite-radio-channel">
          <div class="lite-radio-channel-mode">${ch.mode}</div>
          <div class="lite-radio-pair"><span class="lite-radio-label">Up</span><span class="mono">${ch.up}</span></div>
          <div class="lite-radio-pair"><span class="lite-radio-label">Down</span><span class="mono">${ch.down}</span></div>
          <div class="lite-radio-band-line">${ch.bands}</div>
        </div>
      `).join("")
      : '<div class="lite-radio-empty">No parsed radio channels for this pass.</div>';
    return `
    <article class="lite-radio-item ${idx === 0 ? "lite-radio-item-primary" : ""} ${entry.pass.sat_id === focusSatId ? "is-selected" : ""}" data-sat-id="${entry.pass.sat_id}">
      <div class="lite-pass-row">
        <div>
          <div class="lite-radio-queue-label">${idx === 0 ? "Primary Window" : `Queue ${idx + 1}`}</div>
          <div class="lite-radio-title">${entry.pass.name}</div>
          <div class="lite-card-hint">${entry.pass.sat_id === focusSatId ? "Focus compass and RF loaded" : "Tap card to inspect this pass in the focus card"}</div>
        </div>
        <div class="lite-pass-chip-row">
          ${entry.pass.sat_id === focusSatId ? '<span class="chip chip-ok">Selected</span>' : ""}
          ${entry.pass.sat_id !== focusSatId ? '<span class="chip">Inspect</span>' : ""}
          <span class="${amsatSummaryClass(entry.sat?.operational_status?.summary)}">${amsatSummaryLabel(entry.sat?.operational_status?.summary)}</span>
        </div>
      </div>
      ${passTimeMarkup(entry.pass, { includeMaxEl: true })}
      ${preview ? `
        <div class="lite-radio-preview">
          <span class="lite-radio-preview-mode">${preview.mode}</span>
          <span class="mono">${preview.up === "—" ? "" : `Up ${preview.up}`}${preview.up !== "—" && preview.down !== "—" ? " | " : ""}${preview.down === "—" ? "" : `Down ${preview.down}`}</span>
        </div>
      ` : ""}
      <details class="lite-radio-details">
        <summary>${entry.channels.length ? `Show ${Math.min(entry.channels.length, idx === 0 ? 3 : 2)} channels` : "Channel details"}</summary>
        ${channels}
      </details>
    </article>
  `;
  }).join("");
}

function renderLiteSkyplot(track, cue, trackPath) {
  const dot = trackerById("liteDot");
  const vector = trackerById("liteVector");
  const fadedPath = trackerById("liteTrackPathFaded");
  const pastPath = trackerById("liteTrackPathPast");
  const futurePath = trackerById("liteTrackPathFuture");
  if (!dot || !vector || !fadedPath || !pastPath || !futurePath) return;
  const source = cue || track || { az_deg: 0, el_deg: 0 };
  const p = azElToXY(Number(source.az_deg || 0), Number(source.el_deg || 0));
  dot.setAttribute("cx", p.x.toFixed(2));
  dot.setAttribute("cy", p.y.toFixed(2));
  vector.setAttribute("x2", p.x.toFixed(2));
  vector.setAttribute("y2", p.y.toFixed(2));
  const split = splitTrackPath(trackPath, cue ? cue.time : track?.timestamp, Boolean(cue));
  fadedPath.setAttribute("d", skyplotPathD(split.faded));
  pastPath.setAttribute("d", skyplotPathD(split.past));
  futurePath.setAttribute("d", skyplotPathD(split.future));
}

function focusRfMarkup(sat, pass, recommendation, matrix) {
  if (recommendation) {
    const passLine = pass
      ? passTimeMarkup(pass, { includeMaxEl: true })
      : '<div class="lite-pass-times mono">No associated qualifying pass selected</div>';
    return `${passLine}${frequencyGuideMarkup(recommendation, matrix)}`;
  }
  const channels = frequencyEntriesForSatellite(sat).slice(0, 3);
  const passLine = pass
    ? passTimeMarkup(pass, { includeMaxEl: true })
    : '<div class="lite-pass-times mono">No associated qualifying pass selected</div>';
  const rows = channels.length
    ? channels.map((ch) => `
        <div class="lite-radio-channel">
          <div class="lite-radio-channel-mode">${ch.mode}</div>
          <div class="lite-radio-pair"><span class="lite-radio-label">Up</span><span class="mono">${ch.up}</span></div>
          <div class="lite-radio-pair"><span class="lite-radio-label">Down</span><span class="mono">${ch.down}</span></div>
          <div class="lite-radio-band-line">${ch.bands}</div>
        </div>
      `).join("")
    : '<div class="lite-radio-empty">No parsed RF rows for this satellite.</div>';
  return `${passLine}${rows}`;
}

function renderFocusCard(snapshot) {
  const focusSat = snapshot.focusSatellite || (snapshot.trackedSatellites || [])[0];
  const focusTrack = snapshot.focusTrack || null;
  const focusTrackPath = snapshot.focusTrackPath || [];
  const focusPass = snapshot.focusPass || null;
  const focusCue = snapshot.focusCue || null;

  trackerById("focusModeLabel").textContent = focusCue
    ? "Upcoming Pass Cue"
    : focusTrack?.el_deg > 0
      ? "Live Pass Now"
      : "Tracking Focus";
  trackerById("focusTitle").textContent = focusSat ? `${focusSat.name} (${focusSat.norad_id})` : "Selected satellite";
  trackerById("focusReadout").textContent = focusCue
    ? `AOS cue Az ${Number(focusCue.az_deg).toFixed(1)} deg | Alt ${Number(focusCue.el_deg).toFixed(1)} deg`
    : focusTrack
      ? `Az ${focusTrack.az_deg.toFixed(1)} deg | Alt ${focusTrack.el_deg.toFixed(1)} deg | Range ${focusTrack.range_km.toFixed(1)} km`
      : "Az -- | Alt -- | Range --";
  trackerById("focusSubpoint").textContent = focusCue
    ? `Cue time ${fmtLocalTime(focusCue.time)} | Compass shows where to point at AOS`
    : focusTrack?.subpoint_lat != null && focusTrack?.subpoint_lon != null
      ? `Subpoint ${Number(focusTrack.subpoint_lat).toFixed(2)}, ${Number(focusTrack.subpoint_lon).toFixed(2)} | Sunlit ${focusTrack.sunlit ? "yes" : "no"}`
      : `Observer ${snapshot.location.source} | Network ${snapshot.network.mode}`;
  trackerById("focusPassMeta").textContent = focusCue
    ? "This is the rise direction for the selected upcoming pass. It switches to live tracking when the pass begins."
    : temporaryFocusSatId
      ? "Temporarily selected from the pass or radio queue."
      : focusPass
        ? "Showing your saved default focus."
        : "Tap a pass or radio card below to inspect that satellite.";
  trackerById("focusRfPanel").innerHTML = focusRfMarkup(
    focusSat,
    focusPass,
    snapshot.frequencyRecommendation,
    snapshot.frequencyMatrix
  );
  renderLiteSkyplot(focusTrack, focusCue, focusTrackPath);
  renderAmsatSummary(focusSat?.operational_status || null);
}

function renderSnapshot(snapshot) {
  latestRenderedSnapshot = snapshot;
  const ageHours = snapshotAgeHours(snapshot.cachedAt);
  const stale = ageHours >= SNAPSHOT_WARN_AFTER_HOURS;
  const critical = ageHours >= SNAPSHOT_CRITICAL_AFTER_HOURS;
  const selectedSat = snapshot.focusSatellite || snapshot.issTrack;
  const activeTrack = snapshot.focusTrack || snapshot.issTrack;

  trackerById("summary").textContent =
    `${snapshot.location.source}: ${snapshot.location.lat.toFixed(4)}, ${snapshot.location.lon.toFixed(4)}`;
  trackerById("telemetry").textContent =
    `${activeTrack?.name || "No active track"} | ${modeLabel(snapshot.iss.mode)}`;
  trackerById("syncMeta").textContent =
    snapshot.source === "live"
      ? `Connected to Pi | Snapshot ${fmtLocalTime(snapshot.cachedAt)}`
      : `Offline fallback | Last good snapshot ${fmtLocalTime(snapshot.cachedAt)}`;
  if (critical) {
    trackerById("syncMeta").textContent += " | Cached data is older than 24h; pass times may be unreliable";
  } else if (stale) {
    trackerById("syncMeta").textContent += " | Cached data is older than 12h";
  }
  trackerById("heroBadges").innerHTML = heroBadges(selectedSat, snapshot);
  renderControlSummary(snapshot);
  renderFocusCard(snapshot);

  trackerById("passMeta").textContent = critical
    ? "Cached snapshot is older than 24h. Pass timing is shown for reference only."
    : snapshot.passes?.length
      ? `Showing next ${Math.min(6, snapshot.passes.length)} tracked-satellite passes in your selected timezone`
      : "No upcoming tracked-satellite passes in current window";
  renderPassCards(snapshot.passes || [], snapshot.focusSatId);

  const radioQueue = buildRadioQueue(snapshot);
  trackerById("freqStatus").textContent = snapshot.source === "live"
    ? `Radio queue synced from tracked satellites | ${radioQueue.length} qualified passes`
    : `Showing cached radio queue | ${radioQueue.length} qualified passes`;
  renderRadioQueue(snapshot, snapshot.focusSatId);
}

function refreshSnapshotFreshness() {
  if (!latestRenderedSnapshot) return;
  const snapshot = latestRenderedSnapshot;
  const ageHours = snapshotAgeHours(snapshot.cachedAt);
  const stale = ageHours >= SNAPSHOT_WARN_AFTER_HOURS;
  const critical = ageHours >= SNAPSHOT_CRITICAL_AFTER_HOURS;
  const selectedSat = snapshot.focusSatellite || snapshot.issTrack;
  const activeTrack = snapshot.focusTrack || snapshot.issTrack;

  trackerById("telemetry").textContent =
    `${activeTrack?.name || "No active track"} | ${modeLabel(snapshot.iss.mode)}`;
  trackerById("heroBadges").innerHTML = heroBadges(selectedSat, snapshot);
  trackerById("syncMeta").textContent =
    snapshot.source === "live"
      ? `Connected to Pi | Snapshot ${fmtLocalTime(snapshot.cachedAt)}`
      : `Offline fallback | Last good snapshot ${fmtLocalTime(snapshot.cachedAt)}`;
  if (critical) {
    trackerById("syncMeta").textContent += " | Cached data is older than 24h; pass times may be unreliable";
  } else if (stale) {
    trackerById("syncMeta").textContent += " | Cached data is older than 12h";
  }
}

async function ensureFocusTrackPath(snapshot) {
  if ((snapshot.focusTrackPath || []).length || !snapshot.focusPass || !snapshot.focusSatId) {
    return snapshot;
  }
  const aos = new Date(snapshot.focusPass.aos);
  const los = new Date(snapshot.focusPass.los);
  const minutes = Math.max(1, Math.ceil((los.getTime() - aos.getTime()) / 60000));
  try {
    const resp = await trackerApi.get(
      `/api/v1/track/path?sat_id=${encodeURIComponent(snapshot.focusSatId)}&minutes=${minutes}&step_seconds=30&start_time=${encodeURIComponent(snapshot.focusPass.aos)}`
    );
    snapshot.focusTrackPath = resp.items || [];
  } catch (_) {
    snapshot.focusTrackPath = snapshot.focusTrackPath || [];
  }
  return snapshot;
}

async function refresh() {
  try {
    const snapshot = await ensureFocusTrackPath(await fetchSnapshot());
    saveCachedSnapshot(snapshot);
    renderSnapshot(snapshot);
  } catch (err) {
    const cached = loadCachedSnapshot();
    if (cached) {
      cached.source = "cache";
      await ensureFocusTrackPath(cached);
      renderSnapshot(cached);
      trackerById("summary").textContent = `${trackerById("summary").textContent} | Link down`;
      return;
    }
    trackerById("summary").textContent = `Error: ${err.message}`;
    trackerById("telemetry").textContent = "No cached snapshot available";
  }
}

function snapToFocusCard() {
  const card = trackerById("focusTitle")?.closest(".lite-focus-card");
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "start" });
}

function scheduleRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refresh().catch(() => {});
  }, document.visibilityState === "visible" ? LIVE_REFRESH_MS : HIDDEN_REFRESH_MS);
}

async function saveTrackedSatellites(selectId, setupComplete) {
  const satIds = selectedValues(selectId);
  if (!satIds.length) {
    throw new Error("Select at least one satellite");
  }
  if (satIds.length > MAX_TRACKED_SATS) {
    throw new Error(`Select at most ${MAX_TRACKED_SATS} satellites`);
  }
  const resp = await trackerApi.post("/api/v1/settings/lite", {
    tracked_sat_ids: satIds,
    setup_complete: setupComplete,
  });
  currentLiteSettings = resp.state;
  setupGatePinnedOpen = false;
  if (savedFocusSatId && !satIds.includes(savedFocusSatId)) {
    savedFocusSatId = null;
    localStorage.removeItem(LITE_FOCUS_SAT_KEY);
  }
  if (temporaryFocusSatId && !satIds.includes(temporaryFocusSatId)) {
    temporaryFocusSatId = null;
  }
  syncSetupState();
  await refresh();
}

function cancelLiteSetup() {
  setupGatePinnedOpen = false;
  syncSetupState();
}

async function bootstrapLite() {
  try {
    const settings = await fetchLiteSettings();
    currentLiteSettings = settings.state;
    availableSatellites = settings.availableSatellites || [];
    syncSetupState();
    if (currentLiteSettings?.setup_complete) {
      await refresh();
    }
  } catch (err) {
    trackerById("liteSetupHelp").textContent = `Error: ${err.message}`;
    trackerById("liteSetupGate")?.classList.remove("hidden");
    trackerById("liteDashboard")?.classList.add("hidden");
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  if (!window.issTracker) {
    const el = document.getElementById("summary");
    if (el) el.textContent = "Error: core script not loaded (window.issTracker missing)";
    return;
  }
  ({
    api: trackerApi,
    byId: trackerById,
  } = window.issTracker);

  registerServiceWorker();
  trackerById("passCards").addEventListener("click", async (ev) => {
    const card = ev.target.closest("[data-sat-id]");
    if (!card) return;
    temporaryFocusSatId = card.dataset.satId || null;
    snapToFocusCard();
    try {
      await refresh();
    } catch (_) {}
  });
  trackerById("freqRows").addEventListener("click", async (ev) => {
    const card = ev.target.closest("[data-sat-id]");
    if (!card) return;
    temporaryFocusSatId = card.dataset.satId || null;
    snapToFocusCard();
    try {
      await refresh();
    } catch (_) {}
  });
  trackerById("refreshNow").addEventListener("click", async () => {
    try {
      await refresh();
    } catch (_) {}
  });
  trackerById("saveLiteSetup").addEventListener("click", async () => {
    try {
      await saveTrackedSatellites("liteTrackedSatSelect", true);
    } catch (err) {
      trackerById("liteSetupHelp").textContent = err.message;
    }
  });
  trackerById("cancelLiteSetup").addEventListener("click", cancelLiteSetup);

  document.addEventListener("visibilitychange", scheduleRefreshLoop);

  updateClock();
  setInterval(updateClock, 1000);
  setInterval(refreshSnapshotFreshness, 1000);
  await bootstrapLite();
  scheduleRefreshLoop();
});

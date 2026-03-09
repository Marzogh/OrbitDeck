let trackerApi;
let trackerById;
let trackerSetBrowserLocation;

const LITE_CACHE_KEY = "issTrackerLiteSnapshotV1";
const LITE_FOCUS_SAT_KEY = "issTrackerLiteFocusSatId";
const LIVE_REFRESH_MS = 15000;
const HIDDEN_REFRESH_MS = 60000;
const MAX_ROTATOR_PASS_DURATION_MIN = 10;
const MANUAL_LOCATION_DEBOUNCE_MS = 700;
const SNAPSHOT_WARN_AFTER_HOURS = 12;
const SNAPSHOT_CRITICAL_AFTER_HOURS = 24;
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
let manualLocationTimer = null;
let gpsSettingsTimer = null;
let savedFocusSatId = localStorage.getItem(LITE_FOCUS_SAT_KEY) || null;
let temporaryFocusSatId = null;
let selectedDisplayTimezone = "UTC";

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
  return selectedDisplayTimezone === "BrowserLocal"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    : selectedDisplayTimezone;
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
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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

function isIssPass(p) {
  const satId = String(p.sat_id || "").toLowerCase();
  const name = String(p.name || "").toUpperCase().trim();
  return satId === "iss" || satId === "iss-zarya" || name === "ISS (ZARYA)" || name === "ISS";
}

function isRotatorAllowedSat(pass) {
  const name = String(pass?.name || "").toUpperCase();
  return !name.includes("ISS") || isIssPass(pass);
}

function passDurationMinutes(pass) {
  return (new Date(pass.los).getTime() - new Date(pass.aos).getTime()) / 60000;
}

function isRotatorEligiblePass(pass) {
  return Number.isFinite(passDurationMinutes(pass)) && passDurationMinutes(pass) <= MAX_ROTATOR_PASS_DURATION_MIN;
}

function passMeetsRotatorElevation(pass) {
  return Number(pass.max_el_deg) >= (isIssPass(pass) ? 20 : 40);
}

function filterConsolePasses(passes) {
  const now = Date.now();
  return (passes || [])
    .filter(isRotatorAllowedSat)
    .filter((p) => new Date(p.aos).getTime() > now)
    .filter(isRotatorEligiblePass)
    .filter((p) => isIssPass(p) || passMeetsRotatorElevation(p));
}

function pickOngoingPass(snapshot) {
  const nowMs = Date.now();
  const tracks = snapshot.system?.tracks || [];
  const ongoing = (snapshot.passes.items || [])
    .filter(isRotatorAllowedSat)
    .filter((p) => new Date(p.aos).getTime() <= nowMs && new Date(p.los).getTime() >= nowMs)
    .filter(isRotatorEligiblePass)
    .filter(passMeetsRotatorElevation)
    .map((pass) => ({ pass, track: tracks.find((t) => t.sat_id === pass.sat_id) }))
    .filter((x) => x.track && Number(x.track.el_deg) > 0);
  if (!ongoing.length) return null;
  ongoing.sort((a, b) => b.track.el_deg - a.track.el_deg);
  return ongoing[0];
}

function buildRadioQueue(snapshot) {
  const qualifyingPasses = filterConsolePasses(snapshot.passes.items || []);
  const seenSatIds = new Set();
  const queue = [];
  for (const pass of qualifyingPasses) {
    if (seenSatIds.has(pass.sat_id)) continue;
    seenSatIds.add(pass.sat_id);
    const sat = (snapshot.satellites.items || []).find((item) => item.sat_id === pass.sat_id);
    queue.push({ pass, sat, channels: frequencyEntriesForSatellite(sat) });
    if (queue.length >= 5) break;
  }
  return queue;
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

function syncLocationControls() {
  const mode = trackerById("locationMode")?.value || "current";
  trackerById("manualCoords")?.classList.toggle("hidden", mode !== "manual");
  trackerById("gpsSetupLite")?.classList.toggle("hidden", mode !== "gps");
  const help = trackerById("locationModeHelp");
  if (help) {
    help.textContent = mode === "browser"
      ? "Requests this phone's location and sends it to the Pi immediately."
      : mode === "gps"
        ? "Uses a GPS receiver connected to the Raspberry Pi. Configure USB or Bluetooth below."
      : mode === "manual"
        ? "Shows latitude/longitude entry fields below and saves automatically."
        : "Uses the Raspberry Pi's current saved location source.";
  }
}

function syncGpsControls() {
  const mode = trackerById("gpsConnectionModeLite")?.value || "usb";
  trackerById("gpsUsbFieldsLite")?.classList.toggle("hidden", mode !== "usb");
  trackerById("gpsBluetoothFieldsLite")?.classList.toggle("hidden", mode !== "bluetooth");
}

async function fetchSnapshot() {
  const [system, passes, satellites, timezone, gpsSettings] = await Promise.all([
    trackerApi.get("/api/v1/system/state"),
    trackerApi.get("/api/v1/passes?hours=24&include_all_sats=true&include_ongoing=true"),
    trackerApi.get("/api/v1/satellites"),
    trackerApi.get("/api/v1/settings/timezone"),
    trackerApi.get("/api/v1/settings/gps"),
  ]);
  return {
    system,
    passes,
    satellites,
    timezone,
    gpsSettings,
    cachedAt: new Date().toISOString(),
    source: "live",
  };
}

function ensureTimezoneSelector() {
  const select = trackerById("displayTimezoneLite");
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
}

function syncDetailedSettings(snapshot) {
  selectedDisplayTimezone = snapshot.timezone?.timezone || selectedDisplayTimezone || "UTC";

  ensureTimezoneSelector();
  const tzSelect = trackerById("displayTimezoneLite");
  if (tzSelect) {
    const desired = selectedDisplayTimezone === (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")
      ? "BrowserLocal"
      : selectedDisplayTimezone;
    if ([...tzSelect.options].some((o) => o.value === desired)) tzSelect.value = desired;
  }
  const focusSatSelect = trackerById("focusSatSelectLite");
  if (focusSatSelect) {
    const items = snapshot.satellites.items || [];
    focusSatSelect.innerHTML = [
      '<option value="">Auto (active/live pass)</option>',
      ...items.map((sat) => `<option value="${sat.sat_id}">${sat.name}</option>`),
    ].join("");
    focusSatSelect.value = savedFocusSatId || "";
  }
  const gps = snapshot.gpsSettings?.state;
  if (gps) {
    trackerById("gpsConnectionModeLite").value = gps.connection_mode || "usb";
    trackerById("gpsSerialDeviceLite").value = gps.serial_device || "";
    trackerById("gpsBaudRateLite").value = gps.baud_rate || 9600;
    trackerById("gpsBluetoothAddressLite").value = gps.bluetooth_address || "";
    trackerById("gpsBluetoothChannelLite").value = gps.bluetooth_channel || 1;
    syncGpsControls();
  }
}

function heroBadges(system, selectedSat, snapshot) {
  const iss = system.iss || {};
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
    `<span class="${ageBadgeClass}">Age ${fmtRelativeAge(snapshot.cachedAt)}</span>`,
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

function renderPassCards(passes) {
  const target = trackerById("passCards");
  const qualifying = filterConsolePasses(passes.items || []);
  if (!qualifying.length) {
    target.innerHTML = '<div class="lite-pass-item"><div class="lite-pass-title">No passes in the next 24 hours.</div></div>';
    return;
  }
  target.innerHTML = qualifying.slice(0, 6).map((p) => `
    <article class="lite-pass-item" data-sat-id="${p.sat_id}">
      <div class="lite-pass-row">
        <div class="lite-pass-title">${p.name}</div>
        <span class="chip">${p.max_el_deg.toFixed(0)}° max</span>
      </div>
      <div class="lite-pass-times mono">AOS ${fmtLocalTime(p.aos)} | TCA ${fmtLocalTime(p.tca)} | LOS ${fmtLocalTime(p.los)}</div>
    </article>
  `).join("");
}

function renderRadioQueue(snapshot) {
  const target = trackerById("freqRows");
  const queue = buildRadioQueue(snapshot);
  if (!queue.length) {
    target.innerHTML = '<div class="lite-radio-item"><div class="lite-radio-title">No upcoming qualified radio passes.</div></div>';
    return;
  }
  target.innerHTML = queue.map((entry, idx) => {
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
    <article class="lite-radio-item ${idx === 0 ? "lite-radio-item-primary" : ""}" data-sat-id="${entry.pass.sat_id}">
      <div class="lite-pass-row">
        <div>
          <div class="lite-radio-queue-label">${idx === 0 ? "Primary Window" : `Queue ${idx + 1}`}</div>
          <div class="lite-radio-title">${entry.pass.name}</div>
        </div>
        <span class="${amsatSummaryClass(entry.sat?.operational_status?.summary)}">${amsatSummaryLabel(entry.sat?.operational_status?.summary)}</span>
      </div>
      <div class="lite-pass-times mono">AOS ${fmtLocalTime(entry.pass.aos)} | LOS ${fmtLocalTime(entry.pass.los)} | MaxEl ${entry.pass.max_el_deg.toFixed(1)}°</div>
      ${channels}
    </article>
  `;
  }).join("");
}

function renderLiteSkyplot(track) {
  const dot = trackerById("liteDot");
  const vector = trackerById("liteVector");
  if (!dot || !vector) return;
  const p = azElToXY(Number(track?.az_deg || 0), Number(track?.el_deg || 0));
  dot.setAttribute("cx", p.x.toFixed(2));
  dot.setAttribute("cy", p.y.toFixed(2));
  vector.setAttribute("x2", p.x.toFixed(2));
  vector.setAttribute("y2", p.y.toFixed(2));
}

function focusRfMarkup(sat, pass) {
  const channels = frequencyEntriesForSatellite(sat).slice(0, 3);
  const passLine = pass
    ? `<div class="lite-pass-times mono">AOS ${fmtLocalTime(pass.aos)} | TCA ${fmtLocalTime(pass.tca)} | LOS ${fmtLocalTime(pass.los)} | MaxEl ${pass.max_el_deg.toFixed(1)}°</div>`
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
  const sats = snapshot.satellites.items || [];
  const tracks = snapshot.system.tracks || [];
  const ongoing = pickOngoingPass(snapshot);
  const preferredFocusSatId = temporaryFocusSatId || savedFocusSatId;
  const selectedPass = (snapshot.passes.items || []).find((p) => p.sat_id === preferredFocusSatId) || null;
  const focusSatId = ongoing?.pass?.sat_id || preferredFocusSatId || snapshot.system.activeTrack?.sat_id || snapshot.system.issTrack?.sat_id;
  const focusSat = sats.find((s) => s.sat_id === focusSatId) || sats[0];
  const focusTrack = tracks.find((t) => t.sat_id === focusSatId) || snapshot.system.activeTrack || snapshot.system.issTrack;
  const focusPass = ongoing?.pass || selectedPass || null;

  trackerById("focusModeLabel").textContent = ongoing ? "Live Pass Now" : "Tracking Focus";
  trackerById("focusTitle").textContent = focusSat ? `${focusSat.name} (${focusSat.norad_id})` : "Selected satellite";
  trackerById("focusReadout").textContent = focusTrack
    ? `Az ${focusTrack.az_deg.toFixed(1)}° | Alt ${focusTrack.el_deg.toFixed(1)}° | Range ${focusTrack.range_km.toFixed(1)} km`
    : "Az -- | Alt -- | Range --";
  trackerById("focusSubpoint").textContent = focusTrack?.subpoint_lat != null && focusTrack?.subpoint_lon != null
    ? `Subpoint ${Number(focusTrack.subpoint_lat).toFixed(2)}, ${Number(focusTrack.subpoint_lon).toFixed(2)} | Sunlit ${focusTrack.sunlit ? "yes" : "no"}`
    : `Observer ${snapshot.system.location.source} | Network ${snapshot.system.network.mode}`;
  trackerById("focusPassMeta").textContent = ongoing
    ? "A qualified pass is happening right now. This card is showing live satellite details and RF info."
    : temporaryFocusSatId
      ? "Temporarily selected from the pass/radio queue."
      : focusPass
        ? "Showing your saved default focus."
        : "Tap a pass or radio card below to inspect that satellite.";
  trackerById("focusRfPanel").innerHTML = focusRfMarkup(focusSat, focusPass);
  renderLiteSkyplot(focusTrack);
  renderAmsatSummary(focusSat?.operational_status || null);
}

function renderSnapshot(snapshot) {
  const sys = snapshot.system;
  const passes = snapshot.passes;
  const ageHours = snapshotAgeHours(snapshot.cachedAt);
  const stale = ageHours >= SNAPSHOT_WARN_AFTER_HOURS;
  const critical = ageHours >= SNAPSHOT_CRITICAL_AFTER_HOURS;
  const sats = snapshot.satellites;
  const selectedSat = sats.items.find((s) => s.sat_id === sys.activeTrack?.sat_id)
    || sats.items.find((s) => s.sat_id === sys.issTrack?.sat_id)
    || sats.items[0];
  const activeTrack = sys.activeTrack || sys.issTrack;

  trackerById("summary").textContent =
    `${sys.location.source}: ${sys.location.lat.toFixed(4)}, ${sys.location.lon.toFixed(4)}`;
  trackerById("telemetry").textContent =
    `${activeTrack?.name || "No active track"} | ${modeLabel(sys.iss.mode)} | Updated ${fmtRelativeAge(snapshot.cachedAt)}`;
  trackerById("locationMode").value = "current";
  syncLocationControls();
  trackerById("syncMeta").textContent =
    snapshot.source === "live"
      ? `Connected to Pi | Snapshot ${fmtLocalTime(snapshot.cachedAt)}`
      : `Offline fallback | Last good snapshot ${fmtLocalTime(snapshot.cachedAt)}`;
  if (critical) {
    trackerById("syncMeta").textContent += " | Cached data is older than 24h; pass times may be unreliable";
  } else if (stale) {
    trackerById("syncMeta").textContent += " | Cached data is older than 12h";
  }
  trackerById("heroBadges").innerHTML = heroBadges(sys, selectedSat, snapshot);
  syncDetailedSettings(snapshot);
  renderFocusCard(snapshot);

  trackerById("passMeta").textContent = critical
    ? "Cached snapshot is older than 24h. Pass timing is shown for reference only."
    : passes.items?.length
      ? `Showing next ${Math.min(6, passes.items.length)} passes in your phone's local time`
      : "No upcoming passes in current window";
  renderPassCards(passes);

  const radioQueue = buildRadioQueue(snapshot);
  trackerById("freqStatus").textContent = snapshot.source === "live"
    ? `Radio queue synced from rotator filters | ${radioQueue.length} qualified passes`
    : `Showing cached radio queue | ${radioQueue.length} qualified passes`;
  renderRadioQueue(snapshot);
}

async function refresh() {
  try {
    const snapshot = await fetchSnapshot();
    saveCachedSnapshot(snapshot);
    renderSnapshot(snapshot);
  } catch (err) {
    const cached = loadCachedSnapshot();
    if (cached) {
      cached.source = "cache";
      renderSnapshot(cached);
      trackerById("summary").textContent = `${trackerById("summary").textContent} | Link down`;
      return;
    }
    trackerById("summary").textContent = `Error: ${err.message}`;
    trackerById("telemetry").textContent = "No cached snapshot available";
  }
}

async function saveManual() {
  const lat = Number(trackerById("lat").value);
  const lon = Number(trackerById("lon").value);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return;
  await trackerApi.post("/api/v1/location", {
    add_profile: {
      id: "manual-lite",
      name: "Manual Lite",
      point: { lat, lon, alt_m: 0 },
    },
    selected_profile_id: "manual-lite",
    source_mode: "manual",
  });
  await refresh();
}

async function applyLocationMode() {
  const locationMode = trackerById("locationMode").value;

  if (locationMode === "browser") {
    await trackerSetBrowserLocation();
    await trackerApi.post("/api/v1/location", { source_mode: "browser" });
    await refresh();
    return;
  }

  if (locationMode === "gps") {
    await trackerApi.post("/api/v1/location", { source_mode: "gps" });
    await refresh();
    return;
  }

  if (locationMode === "current") {
    await refresh();
  }
}

async function saveTimezone() {
  const picked = trackerById("displayTimezoneLite").value;
  if (!picked) return;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const tzToSave = picked === "BrowserLocal" ? browserTz : picked;
  await trackerApi.post("/api/v1/settings/timezone", { timezone: tzToSave });
  selectedDisplayTimezone = picked === "BrowserLocal" ? "BrowserLocal" : tzToSave;
  await refresh();
}

function scheduleManualLocationSave() {
  if (trackerById("locationMode").value !== "manual") return;
  if (manualLocationTimer) clearTimeout(manualLocationTimer);
  manualLocationTimer = setTimeout(async () => {
    try {
      await saveManual();
    } catch (err) {
      trackerById("summary").textContent = `Error: ${err.message}`;
    }
  }, MANUAL_LOCATION_DEBOUNCE_MS);
}

async function saveGpsSettings() {
  const payload = {
    connection_mode: trackerById("gpsConnectionModeLite").value,
    serial_device: trackerById("gpsSerialDeviceLite").value,
    baud_rate: Number(trackerById("gpsBaudRateLite").value) || 9600,
    bluetooth_address: trackerById("gpsBluetoothAddressLite").value,
    bluetooth_channel: Number(trackerById("gpsBluetoothChannelLite").value) || 1,
  };
  await trackerApi.post("/api/v1/settings/gps", payload);
}

function scheduleGpsSettingsSave() {
  if (trackerById("locationMode").value !== "gps") return;
  if (gpsSettingsTimer) clearTimeout(gpsSettingsTimer);
  gpsSettingsTimer = setTimeout(async () => {
    try {
      await saveGpsSettings();
    } catch (err) {
      trackerById("summary").textContent = `Error: ${err.message}`;
    }
  }, MANUAL_LOCATION_DEBOUNCE_MS);
}

function snapToFocusCard() {
  const card = trackerById("focusTitle")?.closest(".lite-focus-card");
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "start" });
}

let refreshTimer = null;

function scheduleRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refresh().catch(() => {});
  }, document.visibilityState === "visible" ? LIVE_REFRESH_MS : HIDDEN_REFRESH_MS);
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
    setBrowserLocation: trackerSetBrowserLocation,
  } = window.issTracker);
  registerServiceWorker();
  trackerById("locationMode").addEventListener("change", async () => {
    syncLocationControls();
    try {
      await applyLocationMode();
    } catch (err) {
      trackerById("summary").textContent = `Error: ${err.message}`;
    }
  });
  trackerById("displayTimezoneLite").addEventListener("change", async () => {
    try {
      await saveTimezone();
    } catch (err) {
      trackerById("summary").textContent = `Error: ${err.message}`;
    }
  });
  trackerById("focusSatSelectLite").addEventListener("change", async () => {
    savedFocusSatId = trackerById("focusSatSelectLite").value || null;
    temporaryFocusSatId = null;
    if (savedFocusSatId) localStorage.setItem(LITE_FOCUS_SAT_KEY, savedFocusSatId);
    else localStorage.removeItem(LITE_FOCUS_SAT_KEY);
    try {
      await refresh();
    } catch (_) {}
  });
  trackerById("lat").addEventListener("input", scheduleManualLocationSave);
  trackerById("lon").addEventListener("input", scheduleManualLocationSave);
  trackerById("gpsConnectionModeLite").addEventListener("change", async () => {
    syncGpsControls();
    try {
      await saveGpsSettings();
    } catch (err) {
      trackerById("summary").textContent = `Error: ${err.message}`;
    }
  });
  trackerById("gpsSerialDeviceLite").addEventListener("input", scheduleGpsSettingsSave);
  trackerById("gpsBaudRateLite").addEventListener("input", scheduleGpsSettingsSave);
  trackerById("gpsBluetoothAddressLite").addEventListener("input", scheduleGpsSettingsSave);
  trackerById("gpsBluetoothChannelLite").addEventListener("input", scheduleGpsSettingsSave);
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

  document.addEventListener("visibilitychange", scheduleRefreshLoop);

  updateClock();
  setInterval(updateClock, 1000);
  syncLocationControls();
  await refresh();
  scheduleRefreshLoop();
});

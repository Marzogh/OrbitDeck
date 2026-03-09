let trackerApi;
let trackerById;

const VIDEO_SOURCES_KEY = "kioskVideoSources";
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
const trailPoints = [];
const mapTrailBySat = new Map();

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

function isRotatorAllowedSat(pass) {
  const name = String(pass?.name || "").toUpperCase();
  return !name.includes("ISS") || isIssPass(pass);
}

function stablePassKey(pass) {
  const aosMs = new Date(pass?.aos || 0).getTime();
  const roundedMinute = Number.isFinite(aosMs) ? Math.round(aosMs / 60000) : 0;
  return `${pass?.sat_id || "unknown"}|${roundedMinute}`;
}

function sceneDurationMs(key) {
  if (key.startsWith("telemetry:")) return 15000;
  if (key === "passes") return 15000;
  if (key === "radio") return 15000;
  return 15000;
}

function azElToXY(azDeg, elDeg, radius = 108, cx = 120, cy = 120) {
  const az = (azDeg * Math.PI) / 180;
  const el = Math.max(0, Math.min(90, elDeg));
  const r = ((90 - el) / 90) * radius;
  return { x: cx + r * Math.sin(az), y: cy - r * Math.cos(az) };
}

function bodySymbol(name) {
  const map = { Sun: "☉", Moon: "☾", Mercury: "☿", Venus: "♀", Mars: "♂", Jupiter: "♃", Saturn: "♄" };
  return map[name] || "•";
}

function normalizeFreqToken(text) {
  return String(text || "").replace(/\b\d{7,11}\b/g, (m) => {
    const n = Number(m);
    if (!Number.isFinite(n) || n <= 0) return m;
    return `${(n / 1_000_000).toFixed(3)} MHz`;
  });
}

function renderSkyplot(track, bodies) {
  if (!track) return;
  const dot = trackerById("issDot");
  const vec = trackerById("issVector");
  const trail = trackerById("issTrail");
  const bodyLayer = trackerById("bodyLayer");
  const p = azElToXY(track.az_deg, track.el_deg);
  trailPoints.push(p);
  if (trailPoints.length > 40) trailPoints.shift();
  dot.setAttribute("cx", p.x.toFixed(2));
  dot.setAttribute("cy", p.y.toFixed(2));
  vec.setAttribute("x2", p.x.toFixed(2));
  vec.setAttribute("y2", p.y.toFixed(2));
  trail.setAttribute("points", trailPoints.map((x) => `${x.x.toFixed(1)},${x.y.toFixed(1)}`).join(" "));

  const visible = (bodies || []).filter((b) => b.visible && b.el_deg > 0).map((b) => ({ ...b, color: BODY_COLORS[b.name] || b.color || "#ddd" }));
  bodyLayer.innerHTML = "";
  visible.forEach((b) => {
    const q = azElToXY(b.az_deg, b.el_deg);
    bodyLayer.insertAdjacentHTML("beforeend", `<g><circle cx="${q.x.toFixed(2)}" cy="${q.y.toFixed(2)}" r="6.2" fill="${b.color}" class="plot-body"></circle><text x="${q.x.toFixed(2)}" y="${(q.y + 2.8).toFixed(2)}" text-anchor="middle" class="plot-body-icon">${bodySymbol(b.name)}</text></g>`);
  });
  trackerById("bodyLegend").innerHTML = visible.map((b) => `<span class="body-key"><span class="body-key-dot" style="background:${b.color}"></span><span class="body-key-sym">${bodySymbol(b.name)}</span>${b.name}</span>`).join("");
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

function describeBandPair(up, down) {
  if (up !== "Unknown" && down !== "Unknown") return `${up} -> ${down}`;
  if (up === "Unknown" && down !== "Unknown") return `Downlink only -> ${down}`;
  if (up !== "Unknown" && down === "Unknown") return `${up} uplink only`;
  return "Band unknown";
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

function renderUpcomingTelemetryPanel({ track, pass, rows, scene }) {
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
  const issUpcoming = upcoming.find((p) => isIssPass(p) && Number(p.max_el_deg) >= 20);
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
  ["sceneVideo", "sceneTelemetry", "scenePasses", "sceneRadio"].forEach((x) => trackerById(x).classList.add("hidden"));
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
}

function renderTelemetryScene(system, scene) {
  setSceneVisible("sceneTelemetry");
  const right = trackerById("telemetryRight");
  const tracks = system.tracks || [];
  const targetSatId = scene.pass?.sat_id || scene.track?.sat_id || system.issTrack?.sat_id;
  const track = tracks.find((t) => t.sat_id === targetSatId) || system.issTrack;
  const sat = (state.sats || []).find((s) => s.sat_id === targetSatId);
  const pass = scene.pass;
  trackerById("telemetryTitle").textContent =
    scene.mode === "ongoing"
      ? `Screen 2: Ongoing Pass - ${track?.name || "--"}`
      : scene.mode === "iss-upcoming"
        ? "Screen 3: ISS Upcoming Visible Pass"
        : `Upcoming Pass - ${track?.name || "--"}`;

  if (track) {
    const telemetryReadout = `Az ${track.az_deg.toFixed(1)}° | Alt ${track.el_deg.toFixed(1)}° | Range ${track.range_km.toFixed(1)} km`;
    const telemetryDiag = `Sat ${track.name} (${track.sat_id}) | Sunlit=${track.sunlit ? "yes" : "no"} | UTC ${system.timestamp}`;
    const telemetryPassTime = pass
      ? `AOS ${fmtLocal(pass.aos)} | TCA ${fmtLocal(pass.tca)} | LOS ${fmtLocal(pass.los)} | MaxEl ${pass.max_el_deg.toFixed(1)}°`
      : "AOS -- | TCA -- | LOS --";

    renderSkyplot(track, system.bodies || []);
    const rows = buildFreqRows(sat);

    if (scene.mode !== "ongoing") {
      right.innerHTML = renderUpcomingTelemetryPanel({ track, pass, rows, scene });
      return;
    }

    if (isIssPass({ sat_id: targetSatId, name: track?.name || "" }) && system.iss?.videoEligible && system.iss?.streamHealthy) {
      const url = getVideoSources()[Math.min(activeVideoSource, getVideoSources().length - 1)];
      right.innerHTML = renderOngoingVideoPanel({
        readout: telemetryReadout,
        passTime: telemetryPassTime,
        diag: telemetryDiag,
        rows,
        url,
      });
      return;
    }

    const lat = Number(track?.subpoint_lat ?? 0);
    const lon = Number(track?.subpoint_lon ?? 0);
    const key = track?.sat_id || "unknown";
    const arr = mapTrailBySat.get(key) || [];
    arr.push({ lat, lon });
    if (arr.length > 32) arr.shift();
    mapTrailBySat.set(key, arr);
    const pts = arr.map((p) => `${((p.lon + 180) / 360 * 100).toFixed(2)},${((90 - p.lat) / 180 * 100).toFixed(2)}`).join(" ");
    right.innerHTML = renderOngoingMapPanel({
      readout: telemetryReadout,
      passTime: telemetryPassTime,
      diag: telemetryDiag,
      rows,
      lat,
      lon,
      pts,
    });
  } else {
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
  const items = filterConsolePasses(passes).slice(0, 10);
  trackerById("passesMeta").textContent = items.length
    ? `Next AOS in ${Math.max(0, Math.floor((new Date(items[0].aos).getTime() - now) / 1000))}s | TZ ${state.timezone} | ISS all passes, others>=40°`
    : `No qualifying passes in 24h | TZ ${state.timezone} | ISS all passes, others>=40°`;
  trackerById("rotatorPassRows").innerHTML = items.length
    ? items.map((p, idx) => `<tr class="${idx === 0 ? "selected-row" : ""}"><td><strong>${p.name}</strong></td><td>${fmtLocal(p.aos)}</td><td>${fmtLocal(p.tca)}</td><td>${fmtLocal(p.los)}</td><td>${p.max_el_deg.toFixed(1)}°</td></tr>`).join("")
    : '<tr><td colspan="5" class="label">No qualifying passes</td></tr>';
}

function renderRadioScene(passes) {
  setSceneVisible("sceneRadio");
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
    const channels = frequencyEntriesForSatellite(sat);
    return { pass: p, channels };
  });
  const primary = cards[0] || null;
  const primaryChannel = primary?.channels[0] || null;
  trackerById("radioPrimary").textContent = primary
    ? `Primary: ${primary.pass.name} | ${primaryChannel?.mode || "No channel detail"} | AOS ${fmtLocal(primary.pass.aos)} | MaxEl ${primary.pass.max_el_deg.toFixed(1)}°`
    : "Primary: --";
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
    }).join("")
    : '<div class="radio-empty">No upcoming qualified radio passes.</div>';
}

function showScene(scene, system, passes) {
  if (scene.mode === "video") return renderVideoScene(system);
  if (scene.mode === "passes") return renderPassesScene(passes);
  if (scene.mode === "radio") return renderRadioScene(passes);
  return renderTelemetryScene(system, scene);
}

async function fetchState() {
  const [system, passesResp, sats, tz] = await Promise.all([
    trackerApi.get("/api/v1/system/state"),
    trackerApi.get("/api/v1/passes?hours=24&include_all_sats=true&include_ongoing=true"),
    trackerApi.get("/api/v1/satellites"),
    trackerApi.get("/api/v1/settings/timezone"),
  ]);
  state = { system, passes: passesResp.items || [], sats: sats.items || [], timezone: tz.timezone || "UTC" };
}

function tickClock() {
  const parts = fmtClockPair(Date.now());
  trackerById("clockUtc").textContent = `UTC: ${parts.utc.replace(" UTC", "")}`;
  trackerById("clockLocal").textContent = `Local: ${parts.local}`;
}

function updateTopMeta(system) {
  const active = system.activeTrack || system.issTrack;
  trackerById("rotatorTracked").textContent = `Tracked: ${active?.name || "--"}`;
  trackerById("rotatorLocation").textContent = `Loc: ${system.location?.source || "--"} ${Number(system.location?.lat || 0).toFixed(4)},${Number(system.location?.lon || 0).toFixed(4)}`;
}

function chooseScene() {
  const sys = state.system;
  const passes = state.passes;
  if (!sys) return;
  updateTopMeta(sys);

  const ongoing = pickOngoingPass(sys, passes);
  const overrideOngoing = ongoing ? { key: `telemetry:ongoing:${ongoing.pass.sat_id}`, mode: "ongoing", track: ongoing.track, pass: ongoing.pass } : null;
  const overrideVideo = !overrideOngoing && sys.iss?.videoEligible && sys.iss?.streamHealthy
    ? { key: "video", mode: "video" }
    : null;

  if (overrideOngoing) {
    lastOverride = "ongoing";
    showScene(overrideOngoing, sys, passes);
    return;
  }
  if (overrideVideo) {
    lastOverride = "video";
    showScene(overrideVideo, sys, passes);
    return;
  }

  const seq = buildRotationSequence(sys, passes);
  if (!seq.length) {
    showScene({ key: "passes", mode: "passes" }, sys, passes);
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
  showScene(sceneOrder[sceneIdx], sys, passes);
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    ({ api: trackerApi, byId: trackerById } = window.issTracker);
    tickClock();
    setInterval(tickClock, 1000);
    await fetchState();
    chooseScene();
    setInterval(() => {
      try {
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
    const meta = document.getElementById("passesMeta");
    const rows = document.getElementById("rotatorPassRows");
    if (meta) meta.textContent = `Rotator init error: ${msg}`;
    if (rows && !rows.innerHTML.trim()) {
      rows.innerHTML = '<tr><td colspan="5" class="label">Rotator failed to initialize. Check browser console.</td></tr>';
    }
  }
});

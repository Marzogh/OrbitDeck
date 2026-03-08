let trackerApi;
let trackerFmtUtc;
let trackerById;
let trackerSetBrowserLocation;
let selectedSatId = null;
let selectedLocationSource = null;
let minMaxEl = 0;
const trailPoints = [];
const MAX_TRAIL = 25;

function updateClock() {
  trackerById("clock").textContent = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
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

function normalizeFreqToken(text) {
  return String(text).replace(/\b\d{7,10}\b/g, (m) => {
    const n = Number(m);
    if (!Number.isFinite(n) || n <= 0) return m;
    const mhz = n / 1_000_000;
    return `${mhz.toFixed(3)} MHz`;
  });
}

function toChip(text) {
  return `<span class="chip mono">${text}</span>`;
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

function azElToXY(azDeg, elDeg) {
  const az = (azDeg * Math.PI) / 180;
  const el = clamp(elDeg, 0, 90);
  const r = ((90 - el) / 90) * 108;
  const x = 120 + r * Math.sin(az);
  const y = 120 - r * Math.cos(az);
  return { x, y };
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
    { name: "Mercury", az_deg: (sunAz + 20) % 360, el_deg: sunEl * 0.6 + 8, color: "#d4b483" },
    { name: "Venus", az_deg: (sunAz + 45) % 360, el_deg: sunEl * 0.7 + 12, color: "#f2deb6" },
    { name: "Mars", az_deg: (sunAz + 80) % 360, el_deg: sunEl * 0.5 + 6, color: "#e89a79" },
    { name: "Jupiter", az_deg: (sunAz + 120) % 360, el_deg: sunEl * 0.55 + 9, color: "#d7c49f" },
    { name: "Saturn", az_deg: (sunAz + 150) % 360, el_deg: sunEl * 0.45 + 7, color: "#d9cf9f" },
  ];
  return [
    { name: "Sun", az_deg: sunAz, el_deg: sunEl, color: "#ffd54f" },
    { name: "Moon", az_deg: moonAz, el_deg: moonEl, color: "#c5d9ff" },
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
  const visibleBodies = inputBodies.filter((b) => b.visible && b.el_deg > 0);
  for (const b of visibleBodies) {
    const p = azElToXY(b.az_deg, b.el_deg);
    bodyLayer.insertAdjacentHTML(
      "beforeend",
      `<g><circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="6.2" fill="${b.color || "#ddd"}" class="plot-body"></circle><text x="${p.x.toFixed(2)}" y="${(p.y + 2.8).toFixed(2)}" text-anchor="middle" class="plot-body-icon">${bodySymbol(b.name)}</text><text x="${(p.x + 8).toFixed(2)}" y="${(p.y - 7).toFixed(2)}" class="plot-body-label">${b.name}</text></g>`
    );
  }
  trackerById("bodyLegend").textContent = visibleBodies.length
    ? `Bodies: ${visibleBodies.map((b) => b.name).join(", ")}`
    : "Bodies: none above horizon";
}

function renderPasses(items) {
  const rows = items.slice(0, 10).map((p) => `
    <tr data-sat-id="${p.sat_id}" class="${selectedSatId === p.sat_id ? "selected-row" : ""}">
      <td><strong>${p.name}</strong></td>
      <td>${trackerFmtUtc(p.aos)}</td>
      <td>${trackerFmtUtc(p.tca)}</td>
      <td>${trackerFmtUtc(p.los)}</td>
      <td>${p.max_el_deg.toFixed(1)}\u00B0</td>
    </tr>
  `);
  trackerById("passRows").innerHTML = rows.join("");
}

function renderFrequencies(items) {
  const rows = items.slice(0, 15).map((s) => `
    <tr>
      <td><strong>${s.name}</strong></td>
      <td>
        <div class="stack">
          ${
            (s.transponders || []).slice(0, 4).map((v) => toChip(normalizeFreqToken(v))).join("")
            || '<span class="label">-</span>'
          }
        </div>
      </td>
      <td>
        <div class="stack">
          ${
            (s.repeaters || []).slice(0, 4).map((v) => toChip(normalizeFreqToken(v))).join("")
            || '<span class="label">-</span>'
          }
        </div>
      </td>
    </tr>
  `);
  trackerById("freqRows").innerHTML = rows.join("");
}

function ensureTrackSelector(items) {
  const select = trackerById("trackSatSelect");
  const current = selectedSatId;
  const options = items.map((s) => `<option value="${s.sat_id}">${s.name}</option>`).join("");
  select.innerHTML = options;
  if (current && items.some((s) => s.sat_id === current)) {
    select.value = current;
  } else if (items.length) {
    select.value = items[0].sat_id;
    selectedSatId = items[0].sat_id;
  }
}

async function loadState() {
  const satQuery = selectedSatId ? `?sat_id=${encodeURIComponent(selectedSatId)}` : "";
  const locationQuery = selectedLocationSource ? `location_source=${encodeURIComponent(selectedLocationSource)}` : "";
  const systemQuery = satQuery
    ? `${satQuery}&${locationQuery}`.replace("?&", "?")
    : (locationQuery ? `?${locationQuery}` : "");
  const passParams = new URLSearchParams({ hours: "24", min_max_el: String(minMaxEl) });
  if (selectedLocationSource) passParams.set("location_source", selectedLocationSource);
  const passesQuery = `?${passParams.toString()}`;
  const [sys, passes, mode, sats, locationState] = await Promise.all([
    trackerApi.get(`/api/v1/system/state${systemQuery}`),
    trackerApi.get(`/api/v1/passes${passesQuery}`),
    trackerApi.get("/api/v1/settings/iss-display-mode"),
    trackerApi.get("/api/v1/satellites"),
    trackerApi.get("/api/v1/location"),
  ]);

  trackerById("issMode").value = mode.mode;

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
  trackerById("locationMode").value = locationState.state.source_mode;
  selectedLocationSource = locationState.state.source_mode;
  trackerById("networkSummary").textContent = `Network mode: ${sys.network.mode}`;
  trackerById("minMaxEl").value = String(minMaxEl);
  trackerById("diagSat").textContent =
    `Satellite: ${track.name} (${track.sat_id}) | Range ${track.range_km.toFixed(1)} km`;
  trackerById("diagLoc").textContent =
    `Observer: ${sys.location.source} | lat ${Number(sys.location.lat).toFixed(6)} lon ${Number(sys.location.lon).toFixed(6)} alt ${Number(sys.location.alt_m || 0).toFixed(1)} m`;
  trackerById("diagTime").textContent =
    `UTC Used: ${sys.timestamp} | Sunlit=${track.sunlit ? "yes" : "no"}`;

  renderSkyplot(track, sys.bodies || [], sys.location);
  trackerById("compassReadout").textContent = `Az ${track.az_deg.toFixed(1)}\u00B0 | Alt ${track.el_deg.toFixed(1)}\u00B0`;
  trackerById("compassText").textContent = statusText(iss);

  const videoCard = trackerById("videoCard");
  const video = trackerById("issVideo");
  const videoStatus = trackerById("videoStatus");
  if (iss.videoEligible && iss.streamHealthy && iss.activeStreamUrl) {
    videoCard.style.display = "block";
    if (video.src !== iss.activeStreamUrl) video.src = iss.activeStreamUrl;
    videoStatus.textContent = "Auto video active";
  } else if (iss.mode === "TelemetryOnly") {
    videoCard.style.display = "none";
    video.src = "";
  } else {
    videoCard.style.display = "block";
    video.src = "";
    videoStatus.textContent = "Video unavailable or not eligible; telemetry view active";
  }

  renderPasses(passes.items);
  renderFrequencies(sats.items);
  ensureTrackSelector(sats.items);
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

async function applyLocationMode() {
  const source_mode = trackerById("locationMode").value;
  selectedLocationSource = source_mode;
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

async function applySystemLocation() {
  await trackerSetBrowserLocation();
  await trackerApi.post("/api/v1/location", { source_mode: "browser" });
  selectedLocationSource = "browser";
  trailPoints.length = 0;
  await loadState();
}

async function applyMinMaxEl() {
  const raw = Number(trackerById("minMaxEl").value);
  minMaxEl = Number.isFinite(raw) ? Math.max(0, Math.min(90, raw)) : 0;
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
    fmtUtc: trackerFmtUtc,
    byId: trackerById,
    setBrowserLocation: trackerSetBrowserLocation,
  } = window.issTracker);
  trackerById("saveMode").addEventListener("click", setMode);
  trackerById("applyMinMaxEl").addEventListener("click", async () => {
    try {
      await applyMinMaxEl();
    } catch (err) {
      trackerById("issSummary").textContent = `Error: ${err.message}`;
    }
  });
  trackerById("trackSatSelect").addEventListener("change", async (ev) => {
    selectedSatId = ev.target.value || null;
    trailPoints.length = 0;
    try {
      await loadState();
    } catch (err) {
      trackerById("issSummary").textContent = `Error: ${err.message}`;
    }
  });
  trackerById("locationMode").addEventListener("change", async () => {
    try {
      await applyLocationMode();
    } catch (err) {
      trackerById("locationSummary").textContent = `Error: ${err.message}`;
    }
  });
  trackerById("useSystemLocation").addEventListener("click", async () => {
    try {
      await applySystemLocation();
    } catch (err) {
      trackerById("locationSummary").textContent = `Error: ${err.message}`;
    }
  });
  trackerById("applyManual").addEventListener("click", async () => {
    try {
      await applyManualLocation();
    } catch (err) {
      trackerById("locationSummary").textContent = `Error: ${err.message}`;
    }
  });
  trackerById("applyGps").addEventListener("click", async () => {
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
    trailPoints.length = 0;
    try {
      await loadState();
    } catch (err) {
      trackerById("issSummary").textContent = `Error: ${err.message}`;
    }
  });
  trackerById("refreshNow").addEventListener("click", async () => {
    try {
      await loadState();
    } catch (err) {
      trackerById("issSummary").textContent = `Error: ${err.message}`;
    }
  });
  updateClock();
  setInterval(updateClock, 1000);

  try {
    await refreshFromSources();
  } catch (err) {
    trackerById("freqStatus").textContent = `Refresh failed: ${err.message}`;
  }

  const tick = async () => {
    try {
      await loadState();
    } catch (err) {
      trackerById("issSummary").textContent = `Error: ${err.message}`;
      trackerById("locationSummary").textContent = "API error";
    }
  };

  await tick();
  setInterval(tick, 5000);
});

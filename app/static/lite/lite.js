let trackerApi;
let trackerFmtUtc;
let trackerById;
let trackerSetBrowserLocation;

function updateClock() {
  trackerById("clock").textContent = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
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

async function refresh() {
  const [sys, passes, mode, sats] = await Promise.all([
    trackerApi.get("/api/v1/system/state"),
    trackerApi.get("/api/v1/passes?hours=24"),
    trackerApi.get("/api/v1/settings/iss-display-mode"),
    trackerApi.get("/api/v1/satellites"),
  ]);

  trackerById("issMode").value = mode.mode;
  trackerById("summary").textContent =
    `${sys.location.source}: ${sys.location.lat.toFixed(4)}, ${sys.location.lon.toFixed(4)} | ${sys.iss.mode}`;
  trackerById("telemetry").textContent =
    `ISS az ${sys.issTrack.az_deg.toFixed(1)}\u00B0, el ${sys.issTrack.el_deg.toFixed(1)}\u00B0, sunlit=${sys.iss.sunlit}`;

  trackerById("rows").innerHTML = passes.items.slice(0, 8).map((p) =>
    `<tr><td>${p.name}</td><td>${trackerFmtUtc(p.aos)}</td><td>${p.max_el_deg.toFixed(1)}\u00B0</td></tr>`
  ).join("");

  trackerById("freqRows").innerHTML = sats.items.slice(0, 10).map((s) =>
    `<tr><td>${s.name}</td><td>${(s.transponders || []).slice(0, 1).join(", ") || "-"}</td><td>${(s.repeaters || []).slice(0, 1).join(", ") || "-"}</td></tr>`
  ).join("");
}

async function refreshFromSources() {
  const sats = await trackerApi.get("/api/v1/satellites?refresh_from_sources=true");
  trackerById("freqStatus").textContent = sats.refreshed
    ? `Refreshed from CelesTrak/SatNOGS (${sats.count}) | Ephemeris: ${sats.ephemerisRefreshed ? "updated" : "cached"}`
    : `Refresh failed, cache active`;
}

window.addEventListener("DOMContentLoaded", async () => {
  if (!window.issTracker) {
    const el = document.getElementById("summary");
    if (el) el.textContent = "Error: core script not loaded (window.issTracker missing)";
    return;
  }
  ({
    api: trackerApi,
    fmtUtc: trackerFmtUtc,
    byId: trackerById,
    setBrowserLocation: trackerSetBrowserLocation,
  } = window.issTracker);
  trackerById("useGeo").addEventListener("click", async () => {
    try {
      await trackerSetBrowserLocation();
      await trackerApi.post("/api/v1/location", { source_mode: "browser" });
      await refresh();
    } catch (err) {
      trackerById("summary").textContent = `Error: ${err.message}`;
    }
  });

  trackerById("saveManual").addEventListener("click", async () => {
    try {
      await saveManual();
    } catch (err) {
      trackerById("summary").textContent = `Error: ${err.message}`;
    }
  });

  trackerById("saveMode").addEventListener("click", async () => {
    try {
      await trackerApi.post("/api/v1/settings/iss-display-mode", { mode: trackerById("issMode").value });
      await refresh();
    } catch (err) {
      trackerById("summary").textContent = `Error: ${err.message}`;
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
      await refresh();
    } catch (err) {
      trackerById("summary").textContent = `Error: ${err.message}`;
    }
  };

  await tick();
  setInterval(tick, 7000);
});

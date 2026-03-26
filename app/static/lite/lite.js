let trackerApi;
let trackerById;

const LITE_CACHE_KEY = "issTrackerLiteSnapshotV3";
const LITE_FOCUS_SAT_KEY = "issTrackerLiteFocusSatId";
const LIVE_REFRESH_MS = 30000;
const HIDDEN_REFRESH_MS = 120000;
const SNAPSHOT_WARN_AFTER_HOURS = 12;
const SNAPSHOT_CRITICAL_AFTER_HOURS = 24;
const MAX_TRACKED_SATS = 5;

let refreshTimer = null;
let latestRenderedSnapshot = null;
let savedFocusSatId = localStorage.getItem(LITE_FOCUS_SAT_KEY) || null;
let temporaryFocusSatId = null;
let currentLiteSettings = null;
let availableSatellites = [];
let setupGatePinnedOpen = false;

function updateClock() {
  const now = new Date();
  trackerById("clock").textContent = now.toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    month: "short",
    day: "numeric",
  });
}

function effectiveDisplayTimezone() {
  return latestRenderedSnapshot?.timezone?.timezone || "UTC";
}

function fmtLocalTime(iso) {
  if (!iso) return "--";
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
  return `${days}d ago`;
}

function snapshotAgeHours(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta)) return Number.POSITIVE_INFINITY;
  return Math.max(0, delta / (1000 * 60 * 60));
}

function normalizeFreqToken(text) {
  return String(text || "").replace(/\b\d{7,11}\b/g, (m) => {
    const n = Number(m);
    if (!Number.isFinite(n) || n <= 0) return m;
    return `${(n / 1_000_000).toFixed(3)} MHz`;
  });
}

function fmtFreqMHz(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(3)} MHz` : "—";
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
    future: points.slice(splitIdx),
  };
}

function loadCachedSnapshot() {
  try {
    const raw = localStorage.getItem(LITE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function saveCachedSnapshot(snapshot) {
  try {
    localStorage.setItem(LITE_CACHE_KEY, JSON.stringify(snapshot));
  } catch (_) {}
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/static/lite/sw.js", { scope: "/" });
  } catch (_) {}
}

async function fetchLiteSettings() {
  const resp = await trackerApi.get("/api/v1/settings/lite");
  if (!Array.isArray(resp.availableSatellites) || !resp.availableSatellites.length) {
    try {
      const satellites = await trackerApi.get("/api/v1/satellites");
      resp.availableSatellites = satellites.items || [];
    } catch (_) {}
  }
  return resp;
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

function selectedValues(selectId) {
  const select = trackerById(selectId);
  return Array.from(select?.selectedOptions || []).map((o) => o.value).filter(Boolean);
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

function syncSetupState() {
  const setupComplete = Boolean(currentLiteSettings?.setup_complete);
  const gateVisible = !setupComplete || setupGatePinnedOpen;
  trackerById("liteSetupGate")?.classList.toggle("hidden", !gateVisible);
  trackerById("liteDashboard")?.classList.toggle("hidden", !setupComplete);
  trackerById("cancelLiteSetup")?.classList.toggle("hidden", !setupComplete || !setupGatePinnedOpen);
  renderTrackedSatelliteOptions("liteTrackedSatSelect", currentLiteSettings?.tracked_sat_ids || ["iss-zarya"]);
  const trackedSummary = trackerById("liteTrackedSummary");
  if (trackedSummary) trackedSummary.textContent = trackedSatelliteSummary(currentLiteSettings?.tracked_sat_ids || []);
}

function heroBadges(snapshot) {
  const focusSat = snapshot.focusSatellite;
  const ageHours = snapshotAgeHours(snapshot.cachedAt);
  const ageBadgeClass = ageHours >= SNAPSHOT_CRITICAL_AFTER_HOURS
    ? "chip chip-danger"
    : ageHours >= SNAPSHOT_WARN_AFTER_HOURS
      ? "chip chip-warn"
      : "chip";
  const radioRuntime = snapshot.radio?.focused?.runtime || {};
  return [
    `<span class="chip ${snapshot.source === "live" ? "chip-ok" : "chip-warn"}">${snapshot.source === "live" ? "Live Pi Link" : "Cached Snapshot"}</span>`,
    `<span class="chip">${focusSat?.name || "No focus selected"}</span>`,
    `<span class="chip">${radioRuntime.connected ? "Rig Connected" : "Rig Offline"}</span>`,
    `<span class="${ageBadgeClass}">Last sync ${fmtRelativeAge(snapshot.cachedAt)}</span>`,
  ].join("");
}

function renderControlSummary(snapshot) {
  trackerById("liteLocationSummary").textContent =
    `${snapshot.location.source}: ${snapshot.location.lat.toFixed(4)}, ${snapshot.location.lon.toFixed(4)}`;
  trackerById("liteFocusSummary").textContent =
    snapshot.focusSatellite?.name || (savedFocusSatId || "Auto");
  trackerById("liteTrackedCountSummary").textContent =
    `${(snapshot.trackedSatIds || []).length}/${MAX_TRACKED_SATS} selected`;
  const radioRuntime = snapshot.radio?.focused?.runtime || {};
  trackerById("liteRigSummary").textContent =
    radioRuntime.connected ? `${String(radioRuntime.control_mode || "connected").replaceAll("_", " ")}` : "Not connected";
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

function frequencyGuideMarkup(recommendation, matrix) {
  if (!recommendation) return '<div class="lite-radio-empty">No compact RF guidance for this satellite.</div>';
  const chips = [
    `<span class="chip">${recommendation.label}</span>`,
    recommendation.phase ? `<span class="chip">${String(recommendation.phase).toUpperCase()}</span>` : "",
    recommendation.tone ? `<span class="chip">Tone ${recommendation.tone}</span>` : "",
    recommendation.preset ? `<span class="chip">${recommendation.preset}</span>` : "",
  ].filter(Boolean).join("");
  const primary = `
    <div class="lite-radio-channel">
      <div class="lite-radio-channel-mode">Pass Frequencies</div>
      <div class="lite-guide-primary">
        <div class="lite-radio-pair"><span class="lite-radio-label">Up</span><span class="mono">${fmtFreqMHz(recommendation.uplink_mhz)}${recommendation.uplink_mode ? ` ${recommendation.uplink_mode}` : ""}</span></div>
        <div class="lite-radio-pair"><span class="lite-radio-label">Down</span><span class="mono">${fmtFreqMHz(recommendation.downlink_mhz)}${recommendation.downlink_mode ? ` ${recommendation.downlink_mode}` : ""}</span></div>
      </div>
      <div class="lite-pass-chip-row">${chips}</div>
      <div class="lite-radio-band-line">${recommendation.note || recommendation.schedule_note || "Shared Doppler guidance for the focused pass."}</div>
    </div>
  `;
  if (!matrix || !(matrix.rows || []).length) return primary;
  const matrixRows = matrix.rows.map((row) => `
    <div class="lite-guide-matrix-row ${row.phase === matrix.active_phase ? "is-active" : ""}">
      <span>${String(row.phase).toUpperCase()}</span>
      <span>${fmtFreqMHz(row.uplink_mhz)}</span>
      <span>${fmtFreqMHz(row.downlink_mhz)}</span>
    </div>
  `).join("");
  return `${primary}<div class="lite-guide-matrix"><div class="lite-guide-matrix-head"><span>Phase</span><span>Up</span><span>Down</span></div>${matrixRows}</div>`;
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
  trackerById("focusSubpoint").textContent = focusPass
    ? `AOS ${fmtLocalTime(focusPass.aos)} | TCA ${fmtLocalTime(focusPass.tca)} | LOS ${fmtLocalTime(focusPass.los)}`
    : `Observer ${snapshot.location.source} | Network ${snapshot.network.mode}`;
  trackerById("focusPassMeta").textContent = focusCue
    ? "Compass shows where to point at AOS. It switches to live pass tracking when the pass begins."
    : temporaryFocusSatId
      ? "Focus selected from the tracked pass list."
      : "Tap an upcoming pass below to load it into focus and prepare operations.";
  trackerById("focusRfPanel").innerHTML = frequencyGuideMarkup(
    snapshot.frequencyRecommendation,
    snapshot.frequencyMatrix
  );
  renderLiteSkyplot(focusTrack, focusCue, focusTrackPath);
}

function passTimeMarkup(pass) {
  return `
    <div class="lite-pass-times mono">
      <span>AOS ${fmtLocalTime(pass.aos)}</span>
      <span>TCA ${fmtLocalTime(pass.tca)}</span>
      <span>LOS ${fmtLocalTime(pass.los)}</span>
      <span>MaxEl ${Number(pass.max_el_deg).toFixed(1)} deg</span>
    </div>
  `;
}

function renderPassCards(snapshot) {
  const target = trackerById("passCards");
  const passes = (snapshot.passes || []).slice(0, 6);
  if (!passes.length) {
    target.innerHTML = '<div class="lite-pass-item"><div class="lite-pass-title">No tracked-satellite passes in the current window.</div></div>';
    return;
  }
  target.innerHTML = passes.map((p) => `
    <article class="lite-pass-item ${p.sat_id === snapshot.focusSatId ? "is-selected" : ""}" data-sat-id="${p.sat_id}">
      <div class="lite-pass-row">
        <div>
          <div class="lite-pass-title">${p.name}</div>
          <div class="lite-card-hint">${p.sat_id === snapshot.focusSatId ? "Loaded into the pass operations surface" : "Tap to focus this pass"}</div>
        </div>
        <div class="lite-pass-chip-row">
          ${p.sat_id === snapshot.focusSatId ? '<span class="chip chip-ok">Focused</span>' : '<span class="chip">Load</span>'}
        </div>
      </div>
      ${passTimeMarkup(p)}
    </article>
  `).join("");
}

function renderAmsatSummary(status) {
  const wrap = trackerById("liteAmsatSummary");
  if (!wrap) return;
  if (!status) {
    wrap.classList.add("hidden");
    return;
  }
  trackerById("liteAmsatBadge").textContent = String(status.summary || "unknown").replaceAll("_", " ");
  trackerById("liteAmsatDetail").textContent = status.latest_report
    ? `Latest: ${status.latest_report.report}${status.latest_report.callsign ? ` by ${status.latest_report.callsign}` : ""} (${fmtRelativeAge(status.latest_report.reported_time)})`
    : "No recent AMSAT reports";
  trackerById("liteAmsatCounts").innerHTML = [
    `<span class="chip">96h reports ${status.reports_last_96h}</span>`,
    `<span class="chip">Heard ${status.heard_count}</span>`,
    `<span class="chip">Telemetry ${status.telemetry_only_count}</span>`,
  ].join("");
  trackerById("liteAmsatMatched").textContent = `AMSAT match: ${status.matched_name}`;
  wrap.classList.remove("hidden");
}

async function ensureFocusedRadioSession(snapshot) {
  const focusPass = snapshot.focusPass;
  const focusSat = snapshot.focusSatellite;
  if (!focusPass || !focusSat) throw new Error("Select a pass before using rig control.");
  if (snapshot.radio?.focused?.focusSessionSelected) return;
  await trackerApi.post("/api/v1/radio/session/select", {
    sat_id: focusSat.sat_id,
    sat_name: focusSat.name,
    pass_aos: focusPass.aos,
    pass_los: focusPass.los,
    max_el_deg: focusPass.max_el_deg,
  });
}

async function runRadioAction(action) {
  const snapshot = latestRenderedSnapshot;
  if (!snapshot) return;
  if (["test", "start", "stop", "clear"].includes(action)) {
    await ensureFocusedRadioSession(snapshot);
  }
  const endpoints = {
    connect: "/api/v1/radio/connect",
    disconnect: "/api/v1/radio/disconnect",
    test: "/api/v1/radio/session/test",
    confirm: "/api/v1/radio/session/test/confirm",
    start: "/api/v1/radio/session/start",
    stop: "/api/v1/radio/session/stop",
    clear: "/api/v1/radio/session/clear",
    select: "/api/v1/radio/session/select",
  };
  if (action === "select") {
    await ensureFocusedRadioSession(snapshot);
    await refresh();
    return;
  }
  await trackerApi.post(endpoints[action], {});
  await refresh();
}

async function ensureFocusedAprsTarget(snapshot) {
  const focusSat = snapshot.focusSatellite;
  const focusedAprs = snapshot.aprs?.focused;
  if (!focusSat || !focusedAprs?.available || !focusedAprs.selectedChannel) {
    throw new Error("Focused satellite does not expose APRS channels.");
  }
  await trackerApi.post("/api/v1/aprs/select-target", {
    operating_mode: "satellite",
    sat_id: focusSat.sat_id,
    channel_id: focusedAprs.selectedChannel.channel_id,
  });
}

async function runAprsAction(action) {
  const snapshot = latestRenderedSnapshot;
  if (!snapshot) return;
  await ensureFocusedAprsTarget(snapshot);
  const endpointMap = {
    connect: "/api/v1/aprs/connect",
    disconnect: "/api/v1/aprs/disconnect",
    stopTx: "/api/v1/aprs/emergency-stop",
  };
  await trackerApi.post(endpointMap[action], {});
  await refresh();
}

async function sendAprsMessage() {
  await ensureFocusedAprsTarget(latestRenderedSnapshot);
  await trackerApi.post("/api/v1/aprs/send/message", {
    to: trackerById("liteAprsMessageTo").value.trim(),
    text: trackerById("liteAprsMessageBody").value.trim(),
  });
  await refresh();
}

async function sendAprsStatus() {
  await ensureFocusedAprsTarget(latestRenderedSnapshot);
  await trackerApi.post("/api/v1/aprs/send/status", {
    text: trackerById("liteAprsStatusText").value.trim(),
  });
  await refresh();
}

async function sendAprsPosition() {
  await ensureFocusedAprsTarget(latestRenderedSnapshot);
  await trackerApi.post("/api/v1/aprs/send/position", {
    comment: trackerById("liteAprsPositionComment").value.trim(),
  });
  await refresh();
}

function renderRigOps(snapshot) {
  const focused = snapshot.radio?.focused || {};
  const runtime = focused.runtime || {};
  const session = focused.session || {};
  const defaultPair = focused.defaultPair;
  let rigStatus = focused.status || "No rig state available.";
  if (focused.focusSessionSelected) {
    if (session.screen_state === "test") {
      rigStatus = "Pass prepared. Test control is applied to the rig.";
    } else if (session.screen_state === "armed") {
      rigStatus = "Pass prepared. Radio control is armed and waiting for AOS.";
    } else if (session.screen_state === "active") {
      rigStatus = "Pass prepared. Live tracking is active for the focused pass.";
    } else if (focused.isEligible) {
      rigStatus = "Pass prepared. Next step: Test Control or Arm Pass.";
    } else {
      rigStatus = session.eligibility_reason || focused.eligibilityReason || "Pass prepared, but this pass is not eligible for radio control.";
    }
  }
  trackerById("liteRigStatus").textContent = rigStatus;
  trackerById("liteRigReadout").textContent = defaultPair
    ? `Pair ${fmtFreqMHz(defaultPair.uplink_mhz)} / ${fmtFreqMHz(defaultPair.downlink_mhz)} | ${defaultPair.uplink_mode || "--"} / ${defaultPair.downlink_mode || "--"}`
    : normalizeFreqToken(JSON.stringify(runtime.targets || {}));
  const actions = [];
  actions.push(`<button type="button" data-radio-action="${runtime.connected ? "disconnect" : "connect"}">${runtime.connected ? "Disconnect Radio" : "Connect Radio"}</button>`);
  if (focused.canSelectSession && !focused.focusSessionSelected) {
    actions.push('<button type="button" data-radio-action="select">Prepare Pass</button>');
  }
  if (runtime.connected && focused.focusSessionSelected) {
    if (session.screen_state === "test") {
      actions.push('<button type="button" data-radio-action="confirm">Confirm Test</button>');
    } else if (session.has_test_pair) {
      actions.push('<button type="button" data-radio-action="test">Test Control</button>');
    }
    if (session.screen_state === "armed" || session.screen_state === "active") {
      actions.push('<button type="button" data-radio-action="stop">Stop Control</button>');
    } else if (focused.isEligible) {
      actions.push(`<button type="button" data-radio-action="start">${focused.passState === "active" ? "Start Tracking" : "Arm Pass"}</button>`);
    }
    actions.push('<button type="button" data-radio-action="clear">Clear Session</button>');
  }
  trackerById("liteRigActions").innerHTML = actions.join("");
}

function renderAprsOps(snapshot) {
  const focused = snapshot.aprs?.focused || {};
  const runtime = focused.runtime || {};
  trackerById("liteAprsStatus").textContent = focused.status || "No APRS state available.";
  trackerById("liteAprsReadout").textContent = focused.previewTarget
    ? `${focused.previewTarget.label} | ${normalizeFreqToken(String(focused.previewTarget.corrected_frequency_hz || focused.previewTarget.frequency_hz || ""))}${focused.previewTarget.tx_block_reason ? ` | ${focused.previewTarget.tx_block_reason}` : ""}`
    : "No APRS target selected for the current focus.";
  const compose = trackerById("liteAprsCompose");
  if (!focused.available) {
    compose.classList.add("hidden");
    trackerById("liteAprsActions").innerHTML = "";
    return;
  }
  compose.classList.remove("hidden");
  trackerById("liteAprsActions").innerHTML = [
    `<button type="button" data-aprs-action="connect">${runtime.connected ? "Reconnect APRS" : "Connect APRS"}</button>`,
    `<button type="button" data-aprs-action="disconnect">${runtime.connected ? "Disconnect APRS" : "Clear APRS Link"}</button>`,
    '<button type="button" data-aprs-action="stopTx">Stop TX</button>',
  ].join("");
}

function renderSnapshot(snapshot) {
  latestRenderedSnapshot = snapshot;
  const ageHours = snapshotAgeHours(snapshot.cachedAt);
  const critical = ageHours >= SNAPSHOT_CRITICAL_AFTER_HOURS;
  const focusSat = snapshot.focusSatellite;

  trackerById("summary").textContent = focusSat ? `${focusSat.name} in focus` : "No focused satellite";
  trackerById("telemetry").textContent = snapshot.focusPass
    ? `Pass window ${fmtLocalTime(snapshot.focusPass.aos)} -> ${fmtLocalTime(snapshot.focusPass.los)}`
    : "Tap an upcoming pass to prepare radio and APRS operations";
  trackerById("syncMeta").textContent = snapshot.source === "live"
    ? `Connected to Pi | Snapshot ${fmtLocalTime(snapshot.cachedAt)}`
    : `Offline fallback | Last good snapshot ${fmtLocalTime(snapshot.cachedAt)}`;
  if (critical) trackerById("syncMeta").textContent += " | Cached data is older than 24h";
  trackerById("heroBadges").innerHTML = heroBadges(snapshot);
  renderControlSummary(snapshot);
  renderFocusCard(snapshot);
  renderRigOps(snapshot);
  renderAprsOps(snapshot);
  renderAmsatSummary(focusSat?.operational_status || null);
  trackerById("passMeta").textContent = snapshot.passes?.length
    ? `Showing next ${Math.min(6, snapshot.passes.length)} tracked passes in ${effectiveDisplayTimezone()}`
    : "No upcoming tracked passes in the current window";
  renderPassCards(snapshot);
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
      return;
    }
    trackerById("summary").textContent = `Error: ${err.message}`;
    trackerById("telemetry").textContent = "No cached snapshot available";
  }
}

function refreshSnapshotFreshness() {
  if (!latestRenderedSnapshot) return;
  trackerById("heroBadges").innerHTML = heroBadges(latestRenderedSnapshot);
}

function scheduleRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refresh().catch(() => {});
  }, document.visibilityState === "visible" ? LIVE_REFRESH_MS : HIDDEN_REFRESH_MS);
}

async function saveTrackedSatellites(selectId, setupComplete) {
  const satIds = selectedValues(selectId);
  if (!satIds.length) throw new Error("Select at least one satellite");
  if (satIds.length > MAX_TRACKED_SATS) throw new Error(`Select at most ${MAX_TRACKED_SATS} satellites`);
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
  if (temporaryFocusSatId && !satIds.includes(temporaryFocusSatId)) temporaryFocusSatId = null;
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
    if (currentLiteSettings?.setup_complete) await refresh();
  } catch (err) {
    trackerById("liteSetupHelp").textContent = `Error: ${err.message}`;
    trackerById("liteSetupGate")?.classList.remove("hidden");
    trackerById("liteDashboard")?.classList.add("hidden");
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  if (!window.issTracker) {
    const el = document.getElementById("summary");
    if (el) el.textContent = "Error: core script not loaded";
    return;
  }
  ({ api: trackerApi, byId: trackerById } = window.issTracker);

  await registerServiceWorker();
  trackerById("passCards").addEventListener("click", async (ev) => {
    const card = ev.target.closest("[data-sat-id]");
    if (!card) return;
    temporaryFocusSatId = card.dataset.satId || null;
    await refresh();
  });
  trackerById("liteRigActions").addEventListener("click", async (ev) => {
    const button = ev.target.closest("[data-radio-action]");
    if (!button) return;
    try {
      await runRadioAction(button.dataset.radioAction);
    } catch (err) {
      trackerById("liteRigStatus").textContent = err.message;
    }
  });
  trackerById("liteAprsActions").addEventListener("click", async (ev) => {
    const button = ev.target.closest("[data-aprs-action]");
    if (!button) return;
    try {
      await runAprsAction(button.dataset.aprsAction);
    } catch (err) {
      trackerById("liteAprsStatus").textContent = err.message;
    }
  });
  trackerById("liteAprsSendMessage").addEventListener("click", async () => {
    try {
      await sendAprsMessage();
    } catch (err) {
      trackerById("liteAprsStatus").textContent = err.message;
    }
  });
  trackerById("liteAprsSendStatus").addEventListener("click", async () => {
    try {
      await sendAprsStatus();
    } catch (err) {
      trackerById("liteAprsStatus").textContent = err.message;
    }
  });
  trackerById("liteAprsSendPosition").addEventListener("click", async () => {
    try {
      await sendAprsPosition();
    } catch (err) {
      trackerById("liteAprsStatus").textContent = err.message;
    }
  });
  trackerById("refreshNow").addEventListener("click", async () => {
    await refresh();
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

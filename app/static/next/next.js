const state = {
  view: "operate",
  context: "radio",
  system: null,
  passes: [],
  selectedPass: null,
  aprs: null,
  busy: false,
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

function renderPasses() {
  byId("passCount").textContent = `${state.passes.length} qualifying passes`;
  byId("passTable").innerHTML = `<div class="pass-table-row header"><span>Satellite</span><span>AOS</span><span>TCA</span><span>LOS</span><span>Max el</span><span></span></div>${state.passes.map((pass) => `<div class="pass-table-row"><strong>${escapeHtml(pass.name || pass.sat_id)}</strong><span>${time(pass.aos)}</span><span>${time(pass.tca)}</span><span>${time(pass.los)}</span><span>${number(pass.max_el_deg, 1, "°")}</span><button class="button" type="button" data-focus-key="${escapeHtml(pass.sat_id)}|${escapeHtml(pass.aos)}">Focus pass</button></div>`).join("") || '<div class="queue-empty">No qualifying passes.</div>'}`;
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
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll("[data-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.panel !== view));
  document.querySelectorAll("[data-view]").forEach((control) => {
    if (control.dataset.view === view) control.setAttribute("aria-current", "page");
    else control.removeAttribute("aria-current");
  });
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
    const [system, passes, aprs] = await Promise.all([
      api(`/api/v1/system/state${state.selectedPass ? `?sat_id=${encodeURIComponent(state.selectedPass.sat_id)}` : ""}`),
      api("/api/v1/passes?hours=24&include_ongoing=true"),
      api("/api/v1/aprs/state"),
    ]);
    state.system = system;
    state.passes = Array.isArray(passes.items) ? passes.items : [];
    state.aprs = aprs;
    if (state.selectedPass) state.selectedPass = state.passes.find((item) => item.sat_id === state.selectedPass.sat_id && item.aos === state.selectedPass.aos) || state.selectedPass;
    render();
  } catch (error) {
    if (showErrors) showNotice(`Unable to refresh station state: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

document.addEventListener("click", async (event) => {
  const view = event.target.closest("[data-view]");
  if (view) switchView(view.dataset.view);

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

let trackerApi;
let trackerById;
let trackerRenderStationBadge;

const aprsClient = window.OrbitDeckAprsConsole;

let pageState = {
  aprs: { settings: {}, runtime: {}, previewTarget: null },
  targets: { satellites: [], terrestrial: null },
  system: {},
  audioDevices: { inputs: [], outputs: [] },
  direwolfStatus: null,
  logSettings: {},
  log: { items: [] },
  radioState: { settings: {}, runtime: {} },
  location: { state: {} },
};
const sendDrafts = {
  messageTo: "",
  messageText: "",
  statusText: "",
  positionComment: "",
};

function setRuntime(action, value) {
  trackerById("aprsRuntimePage").textContent = aprsClient.pretty({ action, ...value });
}

async function runAction(action, fn) {
  setRuntime(action, { status: "pending" });
  try {
    const resp = await fn();
    setRuntime(action, { status: "ok", response: resp });
    return resp;
  } catch (error) {
    setRuntime(action, {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function populateAudioSelect(selectId, items, selectedValue) {
  const select = trackerById(selectId);
  const values = Array.isArray(items) ? items : [];
  const selected = String(selectedValue || "").trim();
  const options = [];
  if (selected && !values.some((item) => String(item.value || item.name || "").trim() === selected)) {
    options.push(`<option value="${selected}">${selected} · current</option>`);
  }
  for (const item of values) {
    const name = String(item.name || "").trim();
    const value = String(item.value || item.name || "").trim();
    if (!name) continue;
    options.push(`<option value="${value}">${name}</option>`);
  }
  if (!options.length) options.push('<option value="default">System Default</option>');
  select.innerHTML = options.join("");
  select.value = selected || values[0]?.value || values[0]?.name || "default";
}

function syncModeUi() {
  const mode = trackerById("aprsModePage").value;
  trackerById("aprsSatellitePage").disabled = mode !== "satellite";
  trackerById("aprsChannelPage").disabled = mode !== "satellite";
  trackerById("aprsTerrestrialFreqPage").disabled = mode !== "terrestrial";
  trackerById("aprsSatelliteModeGroup").classList.toggle("hidden", mode !== "satellite");
  trackerById("aprsTerrestrialModeGroup").classList.toggle("hidden", mode !== "terrestrial");
  trackerById("aprsTerrestrialSettingsGroup").classList.toggle("hidden", mode !== "terrestrial");
  trackerById("aprsSatelliteSettingsGroup").classList.toggle("hidden", mode !== "satellite");
}

function renderChannelOptions() {
  const satellite = (pageState.targets.satellites || []).find((item) => item.sat_id === trackerById("aprsSatellitePage").value) || null;
  const channels = satellite?.channels || [];
  const select = trackerById("aprsChannelPage");
  select.innerHTML = channels.map((item) => `<option value="${item.channel_id}">${item.label} | ${item.frequency_hz} Hz | ${item.mode}</option>`).join("");
  if (pageState.aprs.settings?.selected_channel_id && channels.some((item) => item.channel_id === pageState.aprs.settings.selected_channel_id)) {
    select.value = pageState.aprs.settings.selected_channel_id;
  }
}

function renderPreviewTarget(target) {
  const summary = aprsClient.summarizeTarget(target);
  trackerById("aprsTargetMetaPage").textContent = summary.headline;
  trackerById("aprsTxStatusPage").textContent = summary.status;
}

function syncAprsAudioUi(settings) {
  const radioSettings = pageState.radioState.settings || {};
  const wifiManaged = aprsClient.isWifiManaged(radioSettings);
  trackerById("aprsAudioInputField").classList.toggle("hidden", wifiManaged);
  trackerById("aprsAudioOutputField").classList.toggle("hidden", wifiManaged);
  const note = trackerById("aprsAudioManagedNotePage");
  note.classList.toggle("hidden", !wifiManaged);
  if (wifiManaged) {
    note.textContent =
      "Audio is managed automatically by the IC-705 Wi-Fi transport | RX: IC-705 WLAN audio stream -> Dire Wolf | TX: OrbitDeck AFSK -> IC-705 WLAN audio";
  } else {
    note.textContent = `Audio Input: ${settings?.audio_input_device || "default"} | Audio Output: ${settings?.audio_output_device || "default"}`;
  }
}

function aprsSettingsPayload() {
  const radioSettings = pageState.radioState.settings || {};
  const rigModel = radioSettings.rig_model || "ic705";
  const payload = {
    enabled: true,
    callsign: trackerById("aprsCallsignPage").value,
    ssid: Number(trackerById("aprsSsidPage").value || 10),
    operating_mode: trackerById("aprsModePage").value,
    rig_model: rigModel,
    hamlib_model_id: rigModel === "ic705" ? 3085 : 3071,
    serial_device: radioSettings.serial_device || "",
    baud_rate: Number(radioSettings.baud_rate || 19200),
    civ_address: radioSettings.civ_address || (rigModel === "ic705" ? "0xA4" : "0x8C"),
    position_fudge_lat_deg: Number(trackerById("aprsPositionFudgeLatPage").value || 0),
    position_fudge_lon_deg: Number(trackerById("aprsPositionFudgeLonPage").value || 0),
    listen_only: trackerById("aprsListenOnlyPage").checked,
    terrestrial_path: trackerById("aprsTerrestrialPathPage").value,
    satellite_path: trackerById("aprsSatellitePathPage").value,
    terrestrial_beacon_comment: trackerById("aprsTerrestrialCommentPage").value,
    satellite_beacon_comment: trackerById("aprsSatelliteCommentPage").value,
  };
  if (!aprsClient.isWifiManaged(radioSettings)) {
    payload.audio_input_device = trackerById("aprsAudioInputPage").value;
    payload.audio_output_device = trackerById("aprsAudioOutputPage").value;
  }
  if (payload.operating_mode === "satellite") {
    payload.selected_satellite_id = trackerById("aprsSatellitePage").value || null;
    payload.selected_channel_id = trackerById("aprsChannelPage").value || null;
  } else {
    payload.terrestrial_manual_frequency_hz = Number(trackerById("aprsTerrestrialFreqPage").value || 0);
  }
  return payload;
}

function renderStoredLog() {
  const container = trackerById("aprsStoredLogPage");
  const items = (pageState.log.items || []).slice(0, 10);
  if (!items.length) {
    container.innerHTML = '<div class="label">No stored APRS log entries yet.</div>';
    return;
  }
  container.innerHTML = items.map((packet) => `
    <div class="aprs-packet-row">
      <div class="aprs-packet-head">
        <strong>${packet.source || "--"}</strong>
        <span class="aprs-packet-meta">${new Date(packet.received_at).toLocaleTimeString()}</span>
      </div>
      <div class="aprs-packet-meta">${aprsClient.packetDetail(packet)} | PATH ${aprsClient.pathText(packet.path)}</div>
      <div class="aprs-packet-text">${aprsClient.packetPreview(packet)}</div>
    </div>
  `).join("");
}

function renderGatewayPolicy() {
  const runtime = pageState.aprs.runtime || {};
  const bits = [
    `Digipeater: ${runtime.digipeater_active ? "active" : "inactive"}`,
    runtime.digipeater_reason || "no digipeater policy message",
    `iGate: ${runtime.igate_active ? "active" : "inactive"}`,
    `Status: ${runtime.igate_status || (runtime.igate_connected ? "connected" : "disabled")}`,
    runtime.igate_reason || "no iGate policy message",
  ];
  if (runtime.igate_server) bits.push(`Server ${runtime.igate_server}`);
  if (runtime.igate_connected && runtime.igate_last_connect_at) bits.push(`Connected ${new Date(runtime.igate_last_connect_at).toLocaleTimeString()}`);
  if (runtime.igate_last_error) bits.push(`Last error ${runtime.igate_last_error}`);
  trackerById("aprsGatewayPolicyPage").textContent = bits.join(" | ");
}

function updatePositionPreview() {
  trackerById("aprsPositionPreviewPage").textContent = aprsClient.buildPositionPreview({
    aprs: pageState.aprs,
    location: pageState.location,
  }, trackerById("aprsPositionCommentPage").value);
}

function renderDirewolfStatus() {
  const card = trackerById("direwolfInstallCard");
  const statusNode = trackerById("direwolfInstallStatus");
  const installBtn = trackerById("installDirewolfBtn");
  const refreshBtn = trackerById("refreshDirewolfStatusBtn");
  const status = pageState.direwolfStatus;
  if (!status) {
    card.classList.remove("hidden");
    installBtn.classList.add("hidden");
    refreshBtn.classList.remove("hidden");
    statusNode.textContent = "Dire Wolf status unavailable. Refresh to retry detection.";
    return;
  }

  const bits = [];
  bits.push(status.installed ? "Dire Wolf detected." : "Dire Wolf not found.");
  if (status.resolvedBinary) bits.push(`Binary: ${status.resolvedBinary}`);
  if (!status.installed && status.installHint) bits.push(status.installHint);
  if (!status.installed && !status.installHint) {
    bits.push(
      status.canInstall
        ? "OrbitDeck can launch the supported installer flow for this machine."
        : "Install Dire Wolf separately to enable APRS decode and local audio APRS workflows."
    );
  }
  if (!status.installed && status.requiresHomebrew) {
    bits.push("Homebrew is also required for the guided install path.");
  }
  statusNode.textContent = bits.join(" ");
  installBtn.textContent = status.actionLabel || "Install Dire Wolf";
  installBtn.classList.toggle("hidden", !status.canInstall);
  refreshBtn.classList.remove("hidden");
  card.classList.toggle("hidden", !!status.installed && !status.packagedApp);
}

async function loadAprsPage() {
  const bundle = await aprsClient.loadBundle(trackerApi);
  const [radioState, location] = await Promise.all([
    trackerApi.get("/api/v1/radio/state"),
    trackerApi.get("/api/v1/location"),
  ]);
  pageState = {
    aprs: bundle.aprs,
    targets: bundle.targets.targets || { satellites: [], terrestrial: null },
    system: bundle.system || {},
    audioDevices: bundle.audioDevices || { inputs: [], outputs: [] },
    direwolfStatus: bundle.direwolfStatus || null,
    logSettings: bundle.logSettings || {},
    log: bundle.logRecent || { items: [] },
    radioState,
    location,
  };
  const settings = pageState.aprs.settings || {};
  if (trackerRenderStationBadge) {
    trackerRenderStationBadge("stationBadge", pageState.system.stationIdentity, pageState.system.aprsSettings);
  }
  trackerById("aprsCallsignPage").value = settings.callsign || "N0CALL";
  trackerById("aprsSsidPage").value = settings.ssid ?? 10;
  trackerById("aprsModePage").value = settings.operating_mode || "terrestrial";
  populateAudioSelect("aprsAudioInputPage", pageState.audioDevices.inputs, settings.audio_input_device || "");
  populateAudioSelect("aprsAudioOutputPage", pageState.audioDevices.outputs, settings.audio_output_device || "");
  trackerById("aprsListenOnlyPage").checked = !!settings.listen_only;
  trackerById("aprsTerrestrialPathPage").value = settings.terrestrial_path || "WIDE1-1,WIDE2-1";
  trackerById("aprsSatellitePathPage").value = settings.satellite_path || "ARISS";
  trackerById("aprsTerrestrialCommentPage").value =
    settings.terrestrial_beacon_comment || settings.beacon_comment || "OrbitDeck APRS";
  trackerById("aprsSatelliteCommentPage").value =
    settings.satellite_beacon_comment || settings.beacon_comment || "OrbitDeck Space APRS";
  trackerById("aprsPositionFudgeLatPage").value = Number(settings.position_fudge_lat_deg || 0).toFixed(2);
  trackerById("aprsPositionFudgeLonPage").value = Number(settings.position_fudge_lon_deg || 0).toFixed(2);
  trackerById("aprsSatellitePage").innerHTML = (pageState.targets.satellites || [])
    .map((item) => `<option value="${item.sat_id}">${item.name}</option>`)
    .join("");
  if (settings.selected_satellite_id) trackerById("aprsSatellitePage").value = settings.selected_satellite_id;
  renderChannelOptions();
  const terrestrial = pageState.targets.terrestrial || {};
  trackerById("aprsTerrestrialFreqPage").value = settings.terrestrial_manual_frequency_hz || terrestrial.suggested_frequency_hz || "";
  trackerById("aprsRegionHintPage").textContent = terrestrial.region_label
    ? `Suggested terrestrial APRS: ${terrestrial.region_label} | ${terrestrial.suggested_frequency_hz} Hz | PATH ${terrestrial.path_default || "--"}`
    : "No terrestrial APRS region suggestion available yet";
  trackerById("aprsTransportHintPage").textContent =
    `Transport: ${String(radioState?.runtime?.transport_mode || radioState?.settings?.transport_mode || "usb").toUpperCase()} | Endpoint: ${pageState.aprs.runtime?.control_endpoint || "--"} | Modem: ${pageState.aprs.runtime?.modem_state || "--"}`;
  trackerById("aprsConnectionHintPage").textContent =
    `Rig connection settings are shared with Radio Control | ${String(radioState?.settings?.rig_model || settings.rig_model || "--").toUpperCase()} | Change transport/port/host on Settings or Radio page`;
  trackerById("aprsLogEnabledPage").checked = !!pageState.logSettings.log_enabled;
  trackerById("aprsNotifyMessagesPage").checked = pageState.logSettings.notify_incoming_messages !== false;
  trackerById("aprsNotifyAllPacketsPage").checked = !!pageState.logSettings.notify_all_packets;
  trackerById("aprsLogMaxRecordsPage").value = String(pageState.logSettings.log_max_records || 500);
  trackerById("aprsDigipeaterEnabledPage").checked = !!pageState.logSettings.digipeater?.enabled;
  trackerById("aprsDigipeaterAliasesPage").value = (pageState.logSettings.digipeater?.aliases || ["WIDE1-1"]).join(",");
  trackerById("aprsDigipeaterMaxHopsPage").value = String(pageState.logSettings.digipeater?.max_hops ?? 1);
  trackerById("aprsDigipeaterDedupePage").value = String(pageState.logSettings.digipeater?.dedupe_window_s ?? 30);
  trackerById("aprsIgateEnabledPage").checked = !!pageState.logSettings.igate?.enabled;
  trackerById("aprsIgateAutoEnablePage").checked = pageState.logSettings.igate_auto_enable_with_internet !== false;
  trackerById("aprsIgateHostPage").value = pageState.logSettings.igate?.server_host || "rotate.aprs2.net";
  trackerById("aprsIgatePortPage").value = String(pageState.logSettings.igate?.server_port || 14580);
  trackerById("aprsIgateLoginPage").value = pageState.logSettings.igate?.login_callsign || "";
  trackerById("aprsIgatePasscodePage").value = pageState.logSettings.igate?.passcode || "";
  trackerById("aprsIgateFilterPage").value = pageState.logSettings.igate?.filter || "m/25";
  trackerById("aprsIgateTerrestrialPage").checked = pageState.logSettings.igate?.gate_terrestrial_rx !== false;
  trackerById("aprsIgateSatellitePage").checked = pageState.logSettings.igate?.gate_satellite_rx !== false;
  trackerById("aprsMessageToPage").value = sendDrafts.messageTo;
  trackerById("aprsMessageBodyPage").value = sendDrafts.messageText;
  trackerById("aprsStatusPage").value = sendDrafts.statusText;
  trackerById("aprsPositionCommentPage").value = sendDrafts.positionComment;
  aprsClient.updateCounter(trackerById("aprsMessageBodyPage"), trackerById("aprsMessageCounterPage"), {});
  aprsClient.updateCounter(trackerById("aprsStatusPage"), trackerById("aprsStatusCounterPage"), {});
  aprsClient.updateCounter(trackerById("aprsPositionCommentPage"), trackerById("aprsPositionCounterPage"), { hardLimit: 40, softLimit: 20 });
  renderPreviewTarget(pageState.aprs.previewTarget || pageState.aprs.runtime?.target || null);
  syncAprsAudioUi(settings);
  syncModeUi();
  renderStoredLog();
  renderGatewayPolicy();
  updatePositionPreview();
  renderDirewolfStatus();
  setRuntime("loadAprsPage", { status: "ok", response: pageState.aprs });
}

window.addEventListener("DOMContentLoaded", async () => {
  ({ api: trackerApi, byId: trackerById, renderStationBadge: trackerRenderStationBadge } = window.issTracker);
  trackerById("aprsModePage").addEventListener("change", syncModeUi);
  trackerById("aprsSatellitePage").addEventListener("change", renderChannelOptions);
  trackerById("aprsPositionCommentPage").addEventListener("input", updatePositionPreview);
  trackerById("aprsPositionFudgeLatPage").addEventListener("input", updatePositionPreview);
  trackerById("aprsPositionFudgeLonPage").addEventListener("input", updatePositionPreview);
  trackerById("aprsMessageToPage").addEventListener("input", (event) => {
    sendDrafts.messageTo = event.target.value || "";
  });
  trackerById("aprsMessageBodyPage").addEventListener("input", (event) => {
    sendDrafts.messageText = event.target.value || "";
  });
  trackerById("aprsStatusPage").addEventListener("input", (event) => {
    sendDrafts.statusText = event.target.value || "";
  });
  trackerById("aprsPositionCommentPage").addEventListener("input", (event) => {
    sendDrafts.positionComment = event.target.value || "";
  });
  aprsClient.bindCounter(trackerById("aprsMessageBodyPage"), trackerById("aprsMessageCounterPage"), {});
  aprsClient.bindCounter(trackerById("aprsStatusPage"), trackerById("aprsStatusCounterPage"), {});
  aprsClient.bindCounter(trackerById("aprsPositionCommentPage"), trackerById("aprsPositionCounterPage"), { hardLimit: 40, softLimit: 20 });

  trackerById("saveAprsPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/settings/aprs", () => aprsClient.saveAprsSettings(trackerApi, aprsSettingsPayload()));
    await loadAprsPage();
  });
  trackerById("selectAprsTargetPage").addEventListener("click", async () => {
    const mode = trackerById("aprsModePage").value;
    const payload = { operating_mode: mode };
    if (mode === "satellite") {
      payload.sat_id = trackerById("aprsSatellitePage").value || null;
      payload.channel_id = trackerById("aprsChannelPage").value || null;
    } else {
      payload.terrestrial_frequency_hz = Number(trackerById("aprsTerrestrialFreqPage").value || 0);
    }
    await runAction("POST /api/v1/aprs/select-target", () => aprsClient.selectTarget(trackerApi, payload));
    await loadAprsPage();
  });
  trackerById("connectAprsPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/settings/aprs", () => aprsClient.saveAprsSettings(trackerApi, aprsSettingsPayload()));
    await runAction("POST /api/v1/aprs/connect", () => aprsClient.connect(trackerApi));
    await loadAprsPage();
  });
  trackerById("disconnectAprsPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/disconnect", () => aprsClient.disconnect(trackerApi));
    await loadAprsPage();
  });
  trackerById("stopTxAprsPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/emergency-stop", () => aprsClient.emergencyStop(trackerApi));
    await loadAprsPage();
  });
  trackerById("sendAprsMessagePage").addEventListener("click", async () => {
    sendDrafts.messageTo = trackerById("aprsMessageToPage").value || "";
    sendDrafts.messageText = trackerById("aprsMessageBodyPage").value || "";
    await runAction("POST /api/v1/aprs/send/message", () => aprsClient.sendMessage(trackerApi, {
      to: sendDrafts.messageTo,
      text: sendDrafts.messageText,
    }));
    await loadAprsPage();
  });
  trackerById("sendAprsStatusPage").addEventListener("click", async () => {
    sendDrafts.statusText = trackerById("aprsStatusPage").value || "";
    await runAction("POST /api/v1/aprs/send/status", () => aprsClient.sendStatus(trackerApi, {
      text: sendDrafts.statusText,
    }));
    await loadAprsPage();
  });
  trackerById("sendAprsPositionPage").addEventListener("click", async () => {
    sendDrafts.positionComment = trackerById("aprsPositionCommentPage").value || "";
    await runAction("POST /api/v1/aprs/send/position", () => aprsClient.sendPosition(trackerApi, {
      comment: sendDrafts.positionComment,
    }));
    await loadAprsPage();
  });
  trackerById("saveAprsLogPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/log/settings", () => aprsClient.saveLogSettings(trackerApi, {
      log_enabled: trackerById("aprsLogEnabledPage").checked,
      log_max_records: Number(trackerById("aprsLogMaxRecordsPage").value || 500),
      notify_incoming_messages: trackerById("aprsNotifyMessagesPage").checked,
      notify_all_packets: trackerById("aprsNotifyAllPacketsPage").checked,
      digipeater: {
        enabled: trackerById("aprsDigipeaterEnabledPage").checked,
        aliases: trackerById("aprsDigipeaterAliasesPage").value.split(",").map((item) => item.trim()).filter(Boolean),
        max_hops: Number(trackerById("aprsDigipeaterMaxHopsPage").value || 1),
        dedupe_window_s: Number(trackerById("aprsDigipeaterDedupePage").value || 30),
        callsign_allowlist: pageState.logSettings.digipeater?.callsign_allowlist || [],
        path_blocklist: pageState.logSettings.digipeater?.path_blocklist || ["TCPIP", "TCPXX", "NOGATE", "RFONLY"],
      },
      igate: {
        enabled: trackerById("aprsIgateEnabledPage").checked,
        server_host: trackerById("aprsIgateHostPage").value,
        server_port: Number(trackerById("aprsIgatePortPage").value || 14580),
        login_callsign: trackerById("aprsIgateLoginPage").value,
        passcode: trackerById("aprsIgatePasscodePage").value,
        filter: trackerById("aprsIgateFilterPage").value,
        connect_timeout_s: pageState.logSettings.igate?.connect_timeout_s || 10,
        gate_terrestrial_rx: trackerById("aprsIgateTerrestrialPage").checked,
        gate_satellite_rx: trackerById("aprsIgateSatellitePage").checked,
      },
      future_digipeater_enabled: trackerById("aprsDigipeaterEnabledPage").checked,
      future_igate_enabled: trackerById("aprsIgateEnabledPage").checked,
      igate_auto_enable_with_internet: trackerById("aprsIgateAutoEnablePage").checked,
    }));
    await loadAprsPage();
  });
  trackerById("exportAprsLogCsvPage").addEventListener("click", () => {
    window.open(aprsClient.exportUrl("csv"), "_blank", "noopener,noreferrer");
  });
  trackerById("exportAprsLogJsonPage").addEventListener("click", () => {
    window.open(aprsClient.exportUrl("json"), "_blank", "noopener,noreferrer");
  });
  trackerById("clearAprsLogPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/log/clear", () => aprsClient.clearLog(trackerApi, trackerById("aprsClearAgePage").value));
    await loadAprsPage();
  });
  trackerById("installDirewolfBtn").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/direwolf/install", () => trackerApi.post("/api/v1/aprs/direwolf/install", {}));
    await loadAprsPage();
  });
  trackerById("refreshDirewolfStatusBtn").addEventListener("click", async () => {
    pageState.direwolfStatus = await runAction("GET /api/v1/aprs/direwolf/status", () => trackerApi.get("/api/v1/aprs/direwolf/status"));
    renderDirewolfStatus();
  });

  await loadAprsPage();
});

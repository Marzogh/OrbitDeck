let trackerApi;
let trackerById;
let trackerRenderStationBadge;
let trackerCreateRigConnectController;
let latestTargets = { satellites: [], terrestrial: null };
let latestPreviewTarget = null;
let aprsConnectController = null;
let latestAudioDevices = { inputs: [], outputs: [] };
let latestAprsPorts = [];

function hamlibDefaultsForRig(model) {
  if (String(model || "") === "ic705") return "3085";
  return "3071";
}

function isDirewolfMissingMessage(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("direwolf") && (text.includes("no such file") || text.includes("not found"));
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function setRuntime(action, value) {
  trackerById("aprsRuntimePage").textContent = pretty({ action, ...value });
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

function selectedSatelliteRecord() {
  return (latestTargets.satellites || []).find((item) => item.sat_id === trackerById("aprsSatellitePage").value) || null;
}

function renderChannelOptions(settings) {
  const satellite = selectedSatelliteRecord();
  const select = trackerById("aprsChannelPage");
  const channels = satellite?.channels || [];
  select.innerHTML = channels.map((item) => `<option value="${item.channel_id}">${item.label} | ${item.frequency_hz} Hz | ${item.mode}</option>`).join("");
  if (settings?.selected_channel_id && channels.some((item) => item.channel_id === settings.selected_channel_id)) {
    select.value = settings.selected_channel_id;
  }
}

function renderPreviewTarget(target) {
  latestPreviewTarget = target || null;
  if (!target) {
    trackerById("aprsTargetMetaPage").textContent = "No APRS target preview available";
    trackerById("aprsTxStatusPage").textContent = "No APRS TX state available";
    return;
  }
  const passLine = target.requires_pass
    ? (target.pass_active
      ? `Pass active until ${new Date(target.pass_los).toLocaleString()}`
      : target.pass_aos
        ? `Next pass ${new Date(target.pass_aos).toLocaleString()} to ${new Date(target.pass_los).toLocaleString()}`
        : "No upcoming pass in current window")
    : "Terrestrial APRS does not require a pass";
  trackerById("aprsTargetMetaPage").textContent =
    `Target ${target.label} | PATH ${target.path_default || "--"} | ${passLine}`
    + (target.guidance ? ` | ${target.guidance}` : "");
  trackerById("aprsTxStatusPage").textContent = target.can_transmit
    ? "Transmit allowed"
    : `Transmit blocked | ${target.tx_block_reason || "Unavailable"}`;
  const disabled = !target.can_transmit;
  trackerById("sendAprsMessagePage").disabled = disabled;
  trackerById("sendAprsStatusPage").disabled = disabled;
  trackerById("sendAprsPositionPage").disabled = disabled;
}

function renderTargets(targets, settings, previewTarget) {
  latestTargets = targets || { satellites: [], terrestrial: null };
  const select = trackerById("aprsSatellitePage");
  select.innerHTML = (latestTargets.satellites || [])
    .map((item) => `<option value="${item.sat_id}">${item.name}</option>`)
    .join("");
  if (settings.selected_satellite_id) {
    select.value = settings.selected_satellite_id;
  }
  renderChannelOptions(settings);
  const terrestrial = latestTargets.terrestrial || {};
  if (settings.terrestrial_manual_frequency_hz) {
    trackerById("aprsTerrestrialFreqPage").value = settings.terrestrial_manual_frequency_hz;
  } else if (terrestrial.suggested_frequency_hz) {
    trackerById("aprsTerrestrialFreqPage").value = terrestrial.suggested_frequency_hz;
  }
  trackerById("aprsRegionHintPage").textContent = terrestrial.region_label
    ? `Suggested terrestrial APRS: ${terrestrial.region_label} | ${terrestrial.suggested_frequency_hz} Hz | PATH ${terrestrial.path_default || "--"}`
    : "No terrestrial APRS region suggestion available yet";
  renderPreviewTarget(previewTarget);
}

function populateAudioSelect(selectId, items, selectedValue) {
  const select = trackerById(selectId);
  if (!select) return;
  const values = Array.isArray(items) ? items : [];
  const selected = String(selectedValue || "").trim();
  const optionValues = values.map((item) => String(item.value || item.name || "").trim()).filter(Boolean);
  let resolvedSelected = selected;
  if (selected && !optionValues.includes(selected)) {
    const exactNameMatch = values.find((item) => String(item.name || "").trim() === selected);
    if (exactNameMatch) {
      resolvedSelected = String(exactNameMatch.value || exactNameMatch.name || "").trim();
    }
  }
  const options = [];
  if (resolvedSelected && !optionValues.includes(resolvedSelected)) {
    options.push(`<option value="${selected}">${selected} · current</option>`);
  }
  for (const item of values) {
    const name = String(item.name || "").trim();
    const value = String(item.value || item.name || "").trim();
    if (!name) continue;
    const channels = Number(item.channels || 0);
    const index = Number.isInteger(Number(item.index)) ? ` #${item.index}` : "";
    options.push(`<option value="${value}">${channels > 0 ? `${name}${index} (${channels} ch)` : `${name}${index}`}</option>`);
  }
  if (!options.length) {
    options.push('<option value="default">System Default</option>');
  }
  select.innerHTML = options.join("");
  select.value = resolvedSelected || values[0]?.value || values[0]?.name || "default";
}

function populateSerialPortSelect(items, selectedValue) {
  const select = trackerById("aprsSerialDevicePage");
  if (!select) return;
  const values = Array.isArray(items) ? items : [];
  const selected = String(selectedValue || "").trim();
  const seen = new Set();
  const options = [];
  if (selected && !values.some((item) => String(item?.device || "").trim() === selected)) {
    options.push(`<option value="${selected}">${selected} · current</option>`);
    seen.add(selected);
  }
  for (const item of values) {
    const device = String(item?.device || "").trim();
    if (!device || seen.has(device)) continue;
    seen.add(device);
    const desc = String(item?.description || "").trim();
    options.push(`<option value="${device}">${desc ? `${device} · ${desc}` : device}</option>`);
  }
  if (!options.length) {
    options.push('<option value="">No serial ports detected</option>');
  }
  select.innerHTML = options.join("");
  select.value = selected || values[0]?.device || "";
}

function updateDirewolfInstallCard(status, hint = "") {
  const card = trackerById("direwolfInstallCard");
  const label = trackerById("direwolfInstallStatus");
  const installBtn = trackerById("installDirewolfBtn");
  if (!card || !label || !installBtn) return;
  const installed = !!status?.installed;
  card.classList.toggle("hidden", installed);
  installBtn.disabled = !(status?.canInstall || status?.canLaunchTerminal);
  installBtn.textContent = status?.canLaunchTerminal ? "Install Dire Wolf In Terminal" : "Install Dire Wolf";
  if (installed) {
    label.textContent = `Dire Wolf installed at ${status.resolvedBinary || status.configuredBinary || "--"}`;
    return;
  }
  const installer = status?.canLaunchTerminal
    ? "Install available via Terminal.app + Homebrew"
    : status?.installer
      ? `Install available via ${status.installer}`
      : "No supported installer available";
  label.textContent = `Dire Wolf not found. ${installer}.${hint ? ` ${hint}` : ""}`;
}

async function refreshDirewolfStatus(hint = "") {
  try {
    const status = await trackerApi.get("/api/v1/aprs/direwolf/status");
    updateDirewolfInstallCard(status, hint);
    return status;
  } catch (error) {
    updateDirewolfInstallCard({ installed: false, canInstall: false, installer: null }, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function installDirewolf() {
  const status = await refreshDirewolfStatus();
  if (status?.canLaunchTerminal) {
    await runAction("POST /api/v1/aprs/direwolf/install-terminal", () => trackerApi.post("/api/v1/aprs/direwolf/install-terminal", {}));
    await refreshDirewolfStatus("Terminal launched. Follow the Homebrew install there, then click Refresh Status.");
    return;
  }
  await runAction("POST /api/v1/aprs/direwolf/install", () => trackerApi.post("/api/v1/aprs/direwolf/install", {}));
  await refreshDirewolfStatus("Dire Wolf installed. Try Connect again.");
  await loadAprsPage();
}

async function openAprsConnectModal() {
  if (!aprsConnectController) return;
  await aprsConnectController.open();
}

async function submitAprsConnectModal() {
  if (!aprsConnectController) return;
  await aprsConnectController.submit();
}

async function loadAprsPage() {
  const [stateResp, targetResp, systemResp, audioResp, portsResp] = await Promise.all([
    trackerApi.get("/api/v1/aprs/state"),
    trackerApi.get("/api/v1/aprs/targets"),
    trackerApi.get("/api/v1/system/state"),
    trackerApi.get("/api/v1/aprs/audio-devices").catch(() => ({ inputs: [], outputs: [] })),
    trackerApi.get("/api/v1/aprs/ports").catch(() => ({ items: [] })),
  ]);
  const settings = stateResp.settings || {};
  latestAudioDevices = audioResp || { inputs: [], outputs: [] };
  latestAprsPorts = portsResp?.items || [];
  if (trackerRenderStationBadge) {
    trackerRenderStationBadge("stationBadge", systemResp.stationIdentity, systemResp.aprsSettings);
  }
  trackerById("aprsCallsignPage").value = settings.callsign || "N0CALL";
  trackerById("aprsSsidPage").value = settings.ssid ?? 10;
  trackerById("aprsModePage").value = settings.operating_mode || "terrestrial";
  populateSerialPortSelect(latestAprsPorts, settings.serial_device || "");
  trackerById("aprsHamlibModelPage").value = String(settings.hamlib_model_id || hamlibDefaultsForRig(settings.rig_model));
  trackerById("aprsBaudRatePage").value = settings.baud_rate || 19200;
  trackerById("aprsCivAddressPage").value = settings.civ_address || "0xA4";
  populateAudioSelect("aprsAudioInputPage", latestAudioDevices.inputs, settings.audio_input_device || "");
  populateAudioSelect("aprsAudioOutputPage", latestAudioDevices.outputs, settings.audio_output_device || "");
  trackerById("aprsListenOnlyPage").checked = !!settings.listen_only;
  trackerById("aprsTerrestrialPathPage").value = settings.terrestrial_path || "WIDE1-1,WIDE2-1";
  trackerById("aprsSatellitePathPage").value = settings.satellite_path || "ARISS";
  trackerById("aprsTerrestrialCommentPage").value =
    settings.terrestrial_beacon_comment || settings.beacon_comment || "OrbitDeck APRS";
  trackerById("aprsSatelliteCommentPage").value =
    settings.satellite_beacon_comment || settings.beacon_comment || "OrbitDeck Space APRS";
  renderTargets(targetResp.targets || {}, settings, stateResp.previewTarget || stateResp.runtime?.target || null);
  syncModeUi();
  await refreshDirewolfStatus();
  setRuntime("loadAprsPage", { status: "ok", response: stateResp });
}

async function saveAprsSettingsPage() {
  const payload = {
    enabled: true,
    callsign: trackerById("aprsCallsignPage").value,
    ssid: Number(trackerById("aprsSsidPage").value),
    operating_mode: trackerById("aprsModePage").value,
    serial_device: trackerById("aprsSerialDevicePage").value,
    hamlib_model_id: Number(trackerById("aprsHamlibModelPage").value),
    baud_rate: Number(trackerById("aprsBaudRatePage").value),
    civ_address: trackerById("aprsCivAddressPage").value,
    audio_input_device: trackerById("aprsAudioInputPage").value,
    audio_output_device: trackerById("aprsAudioOutputPage").value,
    listen_only: trackerById("aprsListenOnlyPage").checked,
    terrestrial_path: trackerById("aprsTerrestrialPathPage").value,
    satellite_path: trackerById("aprsSatellitePathPage").value,
    terrestrial_beacon_comment: trackerById("aprsTerrestrialCommentPage").value,
    satellite_beacon_comment: trackerById("aprsSatelliteCommentPage").value,
  };
  if (payload.operating_mode === "satellite") {
    payload.selected_satellite_id = trackerById("aprsSatellitePage").value || null;
    payload.selected_channel_id = trackerById("aprsChannelPage").value || null;
  } else {
    payload.terrestrial_manual_frequency_hz = Number(trackerById("aprsTerrestrialFreqPage").value);
  }
  return runAction("POST /api/v1/settings/aprs", () => trackerApi.post("/api/v1/settings/aprs", payload));
}

async function connectAprsPage() {
  await saveAprsSettingsPage();
  const [radioState, aprsState] = await Promise.all([
    trackerApi.get("/api/v1/radio/state"),
    trackerApi.get("/api/v1/settings/aprs"),
  ]);
  if (radioState?.runtime?.connected) {
    const radioSettings = radioState.settings || {};
    await runAction("POST /api/v1/settings/aprs", () => trackerApi.post("/api/v1/settings/aprs", {
      rig_model: radioSettings.rig_model,
      serial_device: radioSettings.serial_device,
      baud_rate: radioSettings.baud_rate,
      civ_address: radioSettings.civ_address,
    }));
    await runAction("POST /api/v1/aprs/connect", () => trackerApi.post("/api/v1/aprs/connect", {}));
    await loadAprsPage();
    return;
  }
  const serialDevice = String(aprsState?.state?.serial_device || "").trim();
  if (!serialDevice) {
    await openAprsConnectModal();
    return;
  }
  try {
    await runAction("POST /api/v1/aprs/connect", () => trackerApi.post("/api/v1/aprs/connect", {}));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("could not open port") || message.includes("No such file or directory")) {
      await openAprsConnectModal();
      updateAprsConnectModalStatus(`${message} Select the rig and USB port to continue.`);
      return;
    }
    if (isDirewolfMissingMessage(message)) {
      await refreshDirewolfStatus("Connect failed because Dire Wolf is not installed.");
      return;
    }
    throw error;
  }
  await loadAprsPage();
}

window.addEventListener("DOMContentLoaded", async () => {
  ({ api: trackerApi, byId: trackerById, renderStationBadge: trackerRenderStationBadge } = window.issTracker);
  trackerCreateRigConnectController = window.issTracker.createRigConnectController;
  aprsConnectController = trackerCreateRigConnectController({
    modalId: "aprsConnectModal",
    statusId: "aprsConnectModalStatus",
    rigModelId: "aprsConnectRigModel",
    portSelectId: "aprsConnectPortSelect",
    manualId: "aprsConnectPortManual",
    loadCurrent: async () => {
      const [aprsResp, radioResp] = await Promise.all([
        trackerApi.get("/api/v1/settings/aprs"),
        trackerApi.get("/api/v1/settings/radio"),
      ]);
      const aprsSettings = aprsResp.state || {};
      const radioSettings = radioResp.state || {};
      return {
        rigModel: aprsSettings.rig_model || radioSettings.rig_model || "ic705",
        selectedDevice: aprsSettings.serial_device || radioSettings.serial_device || "",
      };
    },
    readyMessage: "Select the rig and USB port to connect APRS",
    connectingMessage: (rigModel) => `Saving ${rigModel} settings and connecting APRS...`,
    saveSelection: async ({ rigModel, serialDevice, defaults }) => {
      await trackerApi.post("/api/v1/settings/radio", {
        enabled: true,
        rig_model: rigModel,
        serial_device: serialDevice,
        baud_rate: defaults.baud_rate,
        civ_address: defaults.civ_address,
      });
      await trackerApi.post("/api/v1/settings/aprs", {
        enabled: true,
        rig_model: rigModel,
        hamlib_model_id: Number(hamlibDefaultsForRig(rigModel)),
        serial_device: serialDevice,
        baud_rate: defaults.baud_rate,
        civ_address: defaults.civ_address,
      });
    },
    onConnected: async () => {
      await runAction("POST /api/v1/aprs/connect", () => trackerApi.post("/api/v1/aprs/connect", {}));
      await loadAprsPage();
    },
  });
  aprsConnectController.bind();

  trackerById("aprsModePage").addEventListener("change", syncModeUi);
  trackerById("aprsConnectRigModel").addEventListener("change", (event) => {
    const rigModel = event.target.value;
    trackerById("aprsHamlibModelPage").value = hamlibDefaultsForRig(rigModel);
  });
  trackerById("aprsSatellitePage").addEventListener("change", () => {
    renderChannelOptions({ selected_channel_id: null });
  });
  trackerById("saveAprsPage").addEventListener("click", async () => {
    await saveAprsSettingsPage();
    await loadAprsPage();
  });
  trackerById("selectAprsTargetPage").addEventListener("click", async () => {
    const mode = trackerById("aprsModePage").value;
    const payload = { operating_mode: mode };
    if (mode === "satellite") {
      payload.sat_id = trackerById("aprsSatellitePage").value || null;
      payload.channel_id = trackerById("aprsChannelPage").value || null;
    }
    else payload.terrestrial_frequency_hz = Number(trackerById("aprsTerrestrialFreqPage").value);
    await runAction("POST /api/v1/aprs/select-target", () => trackerApi.post("/api/v1/aprs/select-target", payload));
    await loadAprsPage();
  });
  trackerById("connectAprsPage").addEventListener("click", async () => {
    await connectAprsPage();
  });
  trackerById("disconnectAprsPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/disconnect", () => trackerApi.post("/api/v1/aprs/disconnect", {}));
  });
  trackerById("panicUnkeyAprsPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/panic-unkey", () => trackerApi.post("/api/v1/aprs/panic-unkey", {}));
    await loadAprsPage();
  });
  trackerById("installDirewolfBtn").addEventListener("click", async () => {
    await installDirewolf();
  });
  trackerById("refreshDirewolfStatusBtn").addEventListener("click", async () => {
    await refreshDirewolfStatus();
  });
  trackerById("aprsConnectModalCloseBtn").addEventListener("click", () => {
    if (aprsConnectController) aprsConnectController.close();
  });
  trackerById("aprsConnectRefreshPortsBtn").addEventListener("click", async () => {
    await openAprsConnectModal();
  });
  trackerById("aprsConnectConfirmBtn").addEventListener("click", async () => {
    await submitAprsConnectModal();
  });
  trackerById("sendAprsMessagePage").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/send/message", () => trackerApi.post("/api/v1/aprs/send/message", {
      to: trackerById("aprsMessageToPage").value,
      text: trackerById("aprsMessageBodyPage").value,
    }));
  });
  trackerById("sendAprsStatusPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/send/status", () => trackerApi.post("/api/v1/aprs/send/status", {
      text: trackerById("aprsStatusPage").value,
    }));
  });
  trackerById("sendAprsPositionPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/send/position", () => trackerApi.post("/api/v1/aprs/send/position", {
      comment: trackerById("aprsPositionCommentPage").value,
    }));
  });

  await loadAprsPage();
});

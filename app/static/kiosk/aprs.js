let trackerApi;
let trackerById;
let trackerRenderStationBadge;
let latestTargets = { satellites: [], terrestrial: null };
let latestPreviewTarget = null;

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

async function loadAprsPage() {
  const [stateResp, targetResp, systemResp] = await Promise.all([
    trackerApi.get("/api/v1/aprs/state"),
    trackerApi.get("/api/v1/aprs/targets"),
    trackerApi.get("/api/v1/system/state"),
  ]);
  const settings = stateResp.settings || {};
  if (trackerRenderStationBadge) {
    trackerRenderStationBadge("stationBadge", systemResp.stationIdentity, systemResp.aprsSettings);
  }
  trackerById("aprsCallsignPage").value = settings.callsign || "N0CALL";
  trackerById("aprsSsidPage").value = settings.ssid ?? 10;
  trackerById("aprsModePage").value = settings.operating_mode || "terrestrial";
  trackerById("aprsSerialDevicePage").value = settings.serial_device || "";
  trackerById("aprsBaudRatePage").value = settings.baud_rate || 19200;
  trackerById("aprsCivAddressPage").value = settings.civ_address || "0xA4";
  trackerById("aprsAudioInputPage").value = settings.audio_input_device || "default";
  trackerById("aprsAudioOutputPage").value = settings.audio_output_device || "default";
  trackerById("aprsListenOnlyPage").checked = !!settings.listen_only;
  trackerById("aprsTerrestrialPathPage").value = settings.terrestrial_path || "WIDE1-1,WIDE2-1";
  trackerById("aprsSatellitePathPage").value = settings.satellite_path || "ARISS";
  trackerById("aprsTerrestrialCommentPage").value =
    settings.terrestrial_beacon_comment || settings.beacon_comment || "OrbitDeck APRS";
  trackerById("aprsSatelliteCommentPage").value =
    settings.satellite_beacon_comment || settings.beacon_comment || "OrbitDeck Space APRS";
  renderTargets(targetResp.targets || {}, settings, stateResp.previewTarget || stateResp.runtime?.target || null);
  syncModeUi();
  setRuntime("loadAprsPage", { status: "ok", response: stateResp });
}

async function saveAprsSettingsPage() {
  const payload = {
    enabled: true,
    callsign: trackerById("aprsCallsignPage").value,
    ssid: Number(trackerById("aprsSsidPage").value),
    operating_mode: trackerById("aprsModePage").value,
    serial_device: trackerById("aprsSerialDevicePage").value,
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

window.addEventListener("DOMContentLoaded", async () => {
  ({ api: trackerApi, byId: trackerById, renderStationBadge: trackerRenderStationBadge } = window.issTracker);

  trackerById("aprsModePage").addEventListener("change", syncModeUi);
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
    await runAction("POST /api/v1/aprs/connect", () => trackerApi.post("/api/v1/aprs/connect", {}));
  });
  trackerById("disconnectAprsPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/aprs/disconnect", () => trackerApi.post("/api/v1/aprs/disconnect", {}));
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

let trackerApi;
let trackerById;

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function displayText(value, fallback = "--") {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  return String(value);
}

function titleCase(value) {
  return displayText(value, "--")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatFrequency(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return "--";
  }
  return `${num.toLocaleString("en-US")} Hz`;
}

function formatDateTime(value) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

function formatWindow(aos, los) {
  if (!aos && !los) {
    return "No active pass";
  }
  return `${formatDateTime(aos)} -> ${formatDateTime(los)}`;
}

function getTarget(runtime, keys) {
  for (const key of keys) {
    const value = runtime.targets?.[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function setText(id, value, fallback = "--") {
  trackerById(id).textContent = displayText(value, fallback);
}

function renderDashboard(resp, action = "state") {
  const settings = resp.settings || {};
  const runtime = resp.runtime || {};
  const session = resp.session || {};

  const rigLabel = settings.rig_model === "ic705" ? "IC-705" : settings.rig_model === "id5100" ? "ID-5100" : settings.rig_model;
  const connectionLabel = runtime.connected ? "Connected" : "Offline";
  const controlLabel = titleCase(runtime.control_mode || "idle");
  const screenState = titleCase(session.screen_state || "idle");
  const controlState = titleCase(session.control_state || "not_connected");

  setText("radioHeaderRig", rigLabel);
  setText("radioHeaderLink", connectionLabel);
  setText("radioHeaderControl", controlLabel);
  setText("radioConnectionState", connectionLabel);
  setText(
    "radioSerialState",
    [settings.serial_device, settings.civ_address].filter(Boolean).join(" / "),
    "No serial device configured"
  );
  setText("radioScreenState", screenState);
  setText("radioControlState", controlState);
  setText("radioSessionSat", session.selected_sat_name || session.selected_sat_id, "No satellite selected");
  setText("radioSessionWindow", formatWindow(session.selected_pass_aos, session.selected_pass_los), "No active pass");
  setText(
    "radioSelectedColumn",
    runtime.selected_column_index !== null && runtime.selected_column_index !== undefined
      ? `Column ${runtime.selected_column_index}`
      : "Auto"
  );
  setText("radioLastPoll", runtime.last_poll_at ? `Last poll ${formatDateTime(runtime.last_poll_at)}` : "No poll yet");

  const mainFreq = getTarget(runtime, ["main_freq_hz", "vfo_a_freq_hz"]);
  const subFreq = getTarget(runtime, ["sub_freq_hz", "vfo_b_freq_hz"]);
  const mainMode = getTarget(runtime, ["main_mode", "vfo_a_mode"]);
  const subMode = getTarget(runtime, ["sub_mode", "vfo_b_mode"]);
  const vfoA = getTarget(runtime, ["vfo_a", "main_vfo"]);
  const vfoB = getTarget(runtime, ["vfo_b", "sub_vfo"]);
  const preset = runtime.last_applied_recommendation?.preset || runtime.last_applied_recommendation?.label;
  const tone = runtime.last_applied_recommendation?.tone;

  setText("radioUplinkReadout", formatFrequency(mainFreq));
  setText("radioUplinkModeReadout", mainMode || "No mode");
  setText("radioDownlinkReadout", formatFrequency(subFreq));
  setText("radioDownlinkModeReadout", subMode || "No mode");
  setText("radioTargetVfoA", vfoA || (settings.rig_model === "ic705" ? "A" : "MAIN"));
  setText("radioTargetVfoB", vfoB || (settings.rig_model === "ic705" ? "B" : "SUB"));
  setText("radioManualUplink", formatFrequency(trackerById("radioUplinkHzPage").value));
  setText("radioManualDownlink", formatFrequency(trackerById("radioDownlinkHzPage").value));

  setText("radioMetricMain", `${formatFrequency(mainFreq)} / ${displayText(mainMode, "--")}`);
  setText("radioMetricSub", `${formatFrequency(subFreq)} / ${displayText(subMode, "--")}`);
  setText("radioMetricPreset", [preset, tone].filter(Boolean).join(" / "), "None");
  setText("radioMetricError", runtime.last_error || "None");
  trackerById("radioMetricError").classList.toggle("danger", Boolean(runtime.last_error));

  setRuntime(action, {
    status: "ok",
    response: resp,
  });
}

function setRuntime(action, value) {
  trackerById("radioRuntimePage").textContent = pretty({ action, ...value });
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

function defaultsForModel(model) {
  return model === "ic705"
    ? { baud_rate: 19200, civ_address: "0xA4" }
    : { baud_rate: 19200, civ_address: "0x8C" };
}

async function loadRadioPage() {
  const resp = await trackerApi.get("/api/v1/radio/state");
  const settings = resp.settings || {};
  const runtime = resp.runtime || {};
  trackerById("radioRigModelPage").value = settings.rig_model || "id5100";
  trackerById("radioSerialDevicePage").value = settings.serial_device || "";
  trackerById("radioBaudRatePage").value = settings.baud_rate || 19200;
  trackerById("radioCivAddressPage").value = settings.civ_address || "0x8C";
  trackerById("radioSatIdPage").value = trackerById("radioSatIdPage").value || "iss-zarya";
  trackerById("radioVfoPage").value = settings.rig_model === "ic705" ? "A" : "MAIN";
  trackerById("radioFreqHzPage").value = runtime.targets?.vfo_a_freq_hz || runtime.targets?.main_freq_hz || "";
  trackerById("radioUplinkHzPage").value = runtime.targets?.vfo_a_freq_hz || runtime.targets?.main_freq_hz || "";
  trackerById("radioDownlinkHzPage").value = runtime.targets?.vfo_b_freq_hz || runtime.targets?.sub_freq_hz || "";
  trackerById("radioUplinkModePage").value = runtime.targets?.vfo_a_mode || runtime.targets?.main_mode || "FM";
  trackerById("radioDownlinkModePage").value = runtime.targets?.vfo_b_mode || runtime.targets?.sub_mode || "FM";
  renderDashboard(resp, "loadRadioPage");
}

async function saveRadioSettingsPage() {
  const payload = {
    enabled: true,
    rig_model: trackerById("radioRigModelPage").value,
    serial_device: trackerById("radioSerialDevicePage").value,
    baud_rate: Number(trackerById("radioBaudRatePage").value),
    civ_address: trackerById("radioCivAddressPage").value,
  };
  return runAction("POST /api/v1/settings/radio", async () => {
    const response = await trackerApi.post("/api/v1/settings/radio", payload);
    return { ...response, runtime: (await trackerApi.get("/api/v1/radio/state")).runtime };
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  ({ api: trackerApi, byId: trackerById } = window.issTracker);

  const manualIds = [
    "radioUplinkHzPage",
    "radioDownlinkHzPage",
    "radioUplinkModePage",
    "radioDownlinkModePage",
    "radioFreqHzPage",
    "radioVfoPage",
  ];

  for (const id of manualIds) {
    trackerById(id).addEventListener("input", () => {
      setText("radioManualUplink", formatFrequency(trackerById("radioUplinkHzPage").value));
      setText("radioManualDownlink", formatFrequency(trackerById("radioDownlinkHzPage").value));
    });
    trackerById(id).addEventListener("change", () => {
      setText("radioManualUplink", formatFrequency(trackerById("radioUplinkHzPage").value));
      setText("radioManualDownlink", formatFrequency(trackerById("radioDownlinkHzPage").value));
    });
  }

  trackerById("radioRigModelPage").addEventListener("change", () => {
    const model = trackerById("radioRigModelPage").value;
    const defaults = defaultsForModel(model);
    trackerById("radioBaudRatePage").value = defaults.baud_rate;
    trackerById("radioCivAddressPage").value = defaults.civ_address;
    trackerById("radioVfoPage").value = model === "ic705" ? "A" : "MAIN";
    setText("radioHeaderRig", model === "ic705" ? "IC-705" : "ID-5100");
  });
  trackerById("saveRadioPage").addEventListener("click", async () => {
    await saveRadioSettingsPage();
    await loadRadioPage();
  });
  trackerById("connectRadioPage").addEventListener("click", async () => {
    const resp = await runAction("POST /api/v1/radio/connect", () => trackerApi.post("/api/v1/radio/connect", {}));
    renderDashboard(resp, "POST /api/v1/radio/connect");
  });
  trackerById("pollRadioPage").addEventListener("click", async () => {
    const resp = await runAction("POST /api/v1/radio/poll", () => trackerApi.post("/api/v1/radio/poll", {}));
    renderDashboard(resp, "POST /api/v1/radio/poll");
  });
  trackerById("disconnectRadioPage").addEventListener("click", async () => {
    const resp = await runAction("POST /api/v1/radio/disconnect", () => trackerApi.post("/api/v1/radio/disconnect", {}));
    renderDashboard(resp, "POST /api/v1/radio/disconnect");
  });
  trackerById("applyRadioPage").addEventListener("click", async () => {
    const resp = await runAction("POST /api/v1/radio/apply", () => trackerApi.post("/api/v1/radio/apply", {
      sat_id: trackerById("radioSatIdPage").value || "iss-zarya",
    }));
    renderDashboard(resp, "POST /api/v1/radio/apply");
  });
  trackerById("setFreqRadioPage").addEventListener("click", async () => {
    const resp = await runAction("POST /api/v1/radio/frequency", () => trackerApi.post("/api/v1/radio/frequency", {
      vfo: trackerById("radioVfoPage").value,
      freq_hz: Number(trackerById("radioFreqHzPage").value),
    }));
    renderDashboard(resp, "POST /api/v1/radio/frequency");
  });
  trackerById("setPairRadioPage").addEventListener("click", async () => {
    const resp = await runAction("POST /api/v1/radio/pair", () => trackerApi.post("/api/v1/radio/pair", {
      uplink_hz: Number(trackerById("radioUplinkHzPage").value),
      downlink_hz: Number(trackerById("radioDownlinkHzPage").value),
      uplink_mode: trackerById("radioUplinkModePage").value,
      downlink_mode: trackerById("radioDownlinkModePage").value,
    }));
    renderDashboard(resp, "POST /api/v1/radio/pair");
  });
  await loadRadioPage();
});

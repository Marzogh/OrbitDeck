let trackerApi;
let trackerById;

function pretty(value) {
  return JSON.stringify(value, null, 2);
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
  setRuntime("loadRadioPage", { status: "ok", response: resp });
}

async function saveRadioSettingsPage() {
  const payload = {
    enabled: true,
    rig_model: trackerById("radioRigModelPage").value,
    serial_device: trackerById("radioSerialDevicePage").value,
    baud_rate: Number(trackerById("radioBaudRatePage").value),
    civ_address: trackerById("radioCivAddressPage").value,
  };
  return runAction("POST /api/v1/settings/radio", () => trackerApi.post("/api/v1/settings/radio", payload));
}

window.addEventListener("DOMContentLoaded", async () => {
  ({ api: trackerApi, byId: trackerById } = window.issTracker);
  trackerById("radioRigModelPage").addEventListener("change", () => {
    const model = trackerById("radioRigModelPage").value;
    const defaults = defaultsForModel(model);
    trackerById("radioBaudRatePage").value = defaults.baud_rate;
    trackerById("radioCivAddressPage").value = defaults.civ_address;
    trackerById("radioVfoPage").value = model === "ic705" ? "A" : "MAIN";
  });
  trackerById("saveRadioPage").addEventListener("click", async () => {
    await saveRadioSettingsPage();
    await loadRadioPage();
  });
  trackerById("connectRadioPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/radio/connect", () => trackerApi.post("/api/v1/radio/connect", {}));
  });
  trackerById("pollRadioPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/radio/poll", () => trackerApi.post("/api/v1/radio/poll", {}));
  });
  trackerById("disconnectRadioPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/radio/disconnect", () => trackerApi.post("/api/v1/radio/disconnect", {}));
  });
  trackerById("applyRadioPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/radio/apply", () => trackerApi.post("/api/v1/radio/apply", {
      sat_id: trackerById("radioSatIdPage").value || "iss-zarya",
    }));
  });
  trackerById("setFreqRadioPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/radio/frequency", () => trackerApi.post("/api/v1/radio/frequency", {
      vfo: trackerById("radioVfoPage").value,
      freq_hz: Number(trackerById("radioFreqHzPage").value),
    }));
  });
  trackerById("setPairRadioPage").addEventListener("click", async () => {
    await runAction("POST /api/v1/radio/pair", () => trackerApi.post("/api/v1/radio/pair", {
      uplink_hz: Number(trackerById("radioUplinkHzPage").value),
      downlink_hz: Number(trackerById("radioDownlinkHzPage").value),
      uplink_mode: trackerById("radioUplinkModePage").value,
      downlink_mode: trackerById("radioDownlinkModePage").value,
    }));
  });
  await loadRadioPage();
});

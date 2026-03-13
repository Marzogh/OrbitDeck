let trackerApi;
let trackerById;

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function defaultsForModel(model) {
  return model === "ic705"
    ? { baud_rate: 19200, civ_address: "0xA4" }
    : { baud_rate: 19200, civ_address: "0x8C" };
}

async function loadRadioPage() {
  const resp = await trackerApi.get("/api/v1/radio/state");
  const settings = resp.settings || {};
  trackerById("radioRigModelPage").value = settings.rig_model || "id5100";
  trackerById("radioSerialDevicePage").value = settings.serial_device || "";
  trackerById("radioBaudRatePage").value = settings.baud_rate || 19200;
  trackerById("radioCivAddressPage").value = settings.civ_address || "0x8C";
  trackerById("radioSatIdPage").value = trackerById("radioSatIdPage").value || "iss-zarya";
  trackerById("radioRuntimePage").textContent = pretty(resp);
}

async function saveRadioSettingsPage() {
  const payload = {
    enabled: true,
    rig_model: trackerById("radioRigModelPage").value,
    serial_device: trackerById("radioSerialDevicePage").value,
    baud_rate: Number(trackerById("radioBaudRatePage").value),
    civ_address: trackerById("radioCivAddressPage").value,
  };
  const resp = await trackerApi.post("/api/v1/settings/radio", payload);
  trackerById("radioRuntimePage").textContent = pretty(resp);
}

window.addEventListener("DOMContentLoaded", async () => {
  ({ api: trackerApi, byId: trackerById } = window.issTracker);
  trackerById("radioRigModelPage").addEventListener("change", () => {
    const model = trackerById("radioRigModelPage").value;
    const defaults = defaultsForModel(model);
    trackerById("radioBaudRatePage").value = defaults.baud_rate;
    trackerById("radioCivAddressPage").value = defaults.civ_address;
  });
  trackerById("saveRadioPage").addEventListener("click", async () => {
    await saveRadioSettingsPage();
    await loadRadioPage();
  });
  trackerById("connectRadioPage").addEventListener("click", async () => {
    const resp = await trackerApi.post("/api/v1/radio/connect", {});
    trackerById("radioRuntimePage").textContent = pretty(resp);
  });
  trackerById("pollRadioPage").addEventListener("click", async () => {
    const resp = await trackerApi.post("/api/v1/radio/poll", {});
    trackerById("radioRuntimePage").textContent = pretty(resp);
  });
  trackerById("disconnectRadioPage").addEventListener("click", async () => {
    const resp = await trackerApi.post("/api/v1/radio/disconnect", {});
    trackerById("radioRuntimePage").textContent = pretty(resp);
  });
  trackerById("applyRadioPage").addEventListener("click", async () => {
    const resp = await trackerApi.post("/api/v1/radio/apply", {
      sat_id: trackerById("radioSatIdPage").value || "iss-zarya",
    });
    trackerById("radioRuntimePage").textContent = pretty(resp);
  });
  await loadRadioPage();
});

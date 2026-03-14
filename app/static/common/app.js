const api = {
  get: async (path) => {
    const res = await fetch(path);
    if (!res.ok) {
      let detail = "";
      try {
        const payload = await res.json();
        detail = payload?.detail ? `: ${payload.detail}` : "";
      } catch {}
      throw new Error(`GET ${path} failed: ${res.status}${detail}`);
    }
    return res.json();
  },
  post: async (path, body) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const payload = await res.json();
        detail = payload?.detail ? `: ${payload.detail}` : "";
      } catch {}
      throw new Error(`POST ${path} failed: ${res.status}${detail}`);
    }
    return res.json();
  },
};

function fmtUtc(iso) {
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function byId(id) {
  return document.getElementById(id);
}

function formatStationIdentity(identity, aprsSettings = null) {
  const configured = !!identity?.configured;
  const callsign = String(identity?.callsign || "").trim();
  const ssid = Number(aprsSettings?.ssid);
  if (!configured || !callsign) return "Station: Not Set";
  const suffix = Number.isInteger(ssid) && ssid > 0 ? `-${ssid}` : "";
  return `Station: ${callsign}${suffix}`;
}

function renderStationBadge(targetOrId, identity, aprsSettings = null) {
  const el = typeof targetOrId === "string" ? byId(targetOrId) : targetOrId;
  if (!el) return;
  el.textContent = formatStationIdentity(identity, aprsSettings);
  el.title = identity?.reason || el.textContent;
}

function rigModelDefaults(model) {
  if (model === "ic705") return { baud_rate: 19200, civ_address: "0xA4" };
  return { baud_rate: 19200, civ_address: "0x8C" };
}

function createRigConnectController(config) {
  const {
    modalId,
    statusId,
    rigModelId,
    portSelectId,
    manualId,
    loadCurrent,
    saveSelection,
    onConnected,
    loadingMessage = "Loading available USB ports...",
    readyMessage = "Select the rig and USB port to connect",
    emptyMessage = "No USB ports detected automatically. Use manual override if needed.",
    connectingMessage = (rigModel) => `Saving ${rigModel} settings and connecting...`,
  } = config;

  const setVisible = (active) => {
    const modal = byId(modalId);
    if (!modal) return;
    modal.classList.toggle("hidden", !active);
    modal.setAttribute("aria-hidden", active ? "false" : "true");
  };

  const setStatus = (message) => {
    const el = byId(statusId);
    if (el) el.textContent = message;
  };

  const markManualDirty = (active) => {
    const input = byId(manualId);
    if (input) input.dataset.dirty = active ? "1" : "0";
  };

  const populatePortOptions = (items, selectedValue = "") => {
    const select = byId(portSelectId);
    if (!select) return;
    const options = [];
    const seen = new Set();
    for (const item of items || []) {
      const device = String(item?.device || "").trim();
      if (!device || seen.has(device)) continue;
      seen.add(device);
      const desc = String(item?.description || "").trim();
      options.push(`<option value="${device}">${desc ? `${device} · ${desc}` : device}</option>`);
    }
    if (selectedValue && !seen.has(selectedValue)) {
      options.unshift(`<option value="${selectedValue}">${selectedValue} · current</option>`);
    }
    if (!options.length) {
      options.push('<option value="">No USB ports detected</option>');
    }
    select.innerHTML = options.join("");
    if (selectedValue) select.value = selectedValue;
  };

  const bind = () => {
    const portSelect = byId(portSelectId);
    const manualInput = byId(manualId);
    if (portSelect && manualInput && !portSelect.dataset.bound) {
      portSelect.dataset.bound = "1";
      portSelect.addEventListener("change", () => {
        manualInput.value = portSelect.value || "";
        markManualDirty(false);
      });
      manualInput.addEventListener("input", () => {
        markManualDirty(true);
      });
    }
  };

  const open = async () => {
    bind();
    setVisible(true);
    setStatus(loadingMessage);
    try {
      const [current, portsResp] = await Promise.all([
        loadCurrent(),
        api.get("/api/v1/radio/ports"),
      ]);
      const selectedDevice = String(current?.selectedDevice || "").trim();
      const rigModel = String(current?.rigModel || "ic705").trim() || "ic705";
      const rigModelSelect = byId(rigModelId);
      const manualInput = byId(manualId);
      if (rigModelSelect) rigModelSelect.value = rigModel;
      if (manualInput) manualInput.value = selectedDevice;
      markManualDirty(false);
      populatePortOptions(portsResp.items || [], selectedDevice);
      setStatus((portsResp.items || []).length ? readyMessage : emptyMessage);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const close = () => setVisible(false);

  const submit = async () => {
    const rigModel = byId(rigModelId)?.value || "ic705";
    const selectedPort = byId(portSelectId)?.value || "";
    const manualInput = byId(manualId);
    const manualPort = manualInput?.value?.trim() || "";
    const manualDirty = manualInput?.dataset?.dirty === "1";
    const serialDevice = manualDirty ? (manualPort || selectedPort) : (selectedPort || manualPort);
    if (!serialDevice) {
      setStatus("Choose a USB port or enter a manual device path");
      return;
    }
    setStatus(connectingMessage(rigModel));
    try {
      await saveSelection({
        rigModel,
        serialDevice,
        defaults: rigModelDefaults(rigModel),
      });
      close();
      if (typeof onConnected === "function") {
        await onConnected();
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return { open, close, submit, bind, setStatus };
}

async function setBrowserLocation() {
  if (!navigator.geolocation) {
    throw new Error("Browser geolocation not supported");
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const payload = {
          browser_location: {
            lat: Number(pos.coords.latitude.toFixed(6)),
            lon: Number(pos.coords.longitude.toFixed(6)),
            alt_m: Number((pos.coords.altitude || 0).toFixed(1)),
          },
        };
        try {
          await api.post("/api/v1/location", payload);
          resolve(payload.browser_location);
        } catch (err) {
          reject(err);
        }
      },
      (err) => reject(err),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 }
    );
  });
}

window.issTracker = {
  api,
  fmtUtc,
  byId,
  setBrowserLocation,
  renderStationBadge,
  formatStationIdentity,
  rigModelDefaults,
  createRigConnectController,
};

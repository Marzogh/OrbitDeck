function errorDetailText(payload) {
  const detail = payload?.detail;
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch (_) {
    return String(detail);
  }
}

const txAuth = (() => {
  let status = { configured: false, authorized: false, scope: "system-boot" };
  let promptPromise = null;

  const updateIndicator = () => {
    const button = document.getElementById("txAuthIndicator");
    if (!button) return;
    button.classList.toggle("is-unlocked", !!status.authorized);
    button.textContent = status.authorized ? "TX Unlocked" : status.inUse ? "TX In Use" : "TX Locked";
    button.title = status.authorized
      ? "This browser holds transmit authorization. Select to lock and release it."
      : status.inUse
        ? "Another browser holds transmit authorization. Receive and tuning remain available."
        : "Receive and tuning remain available. Select to unlock transmit controls.";
  };

  const requestJson = async (path, options = {}) => {
    const response = await fetch(path, options);
    let payload = {};
    try {
      payload = await response.json();
    } catch {}
    if (!response.ok) {
      throw new Error(errorDetailText(payload) || `${response.status} ${response.statusText}`);
    }
    return payload;
  };

  const refresh = async () => {
    try {
      status = await requestJson("/api/v1/tx-auth/status");
      updateIndicator();
    } catch {}
    return status;
  };

  const ensureShell = () => {
    if (document.getElementById("txAuthIndicator")) return;
    const indicator = document.createElement("button");
    indicator.id = "txAuthIndicator";
    indicator.className = "tx-auth-indicator";
    indicator.type = "button";
    indicator.textContent = "TX Locked";
    indicator.addEventListener("click", async () => {
      await refresh();
      if (status.authorized) {
        if (!window.confirm("Lock transmit controls on all currently authorized OrbitDeck browsers?")) return;
        try {
          status = await requestJson("/api/v1/tx-auth/lock", { method: "POST" });
          updateIndicator();
        } catch (error) {
          window.alert(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      await requestUnlock();
    });
    document.body.appendChild(indicator);

    const overlay = document.createElement("div");
    overlay.id = "txAuthOverlay";
    overlay.className = "tx-auth-overlay hidden";
    overlay.innerHTML = `
      <form id="txAuthForm" class="tx-auth-dialog">
        <div class="tx-auth-kicker">TRANSMIT AUTHORIZATION</div>
        <h2 id="txAuthTitle">Unlock TX</h2>
        <p id="txAuthDescription">Receive, tracking, and tuning remain available while TX is locked.</p>
        <label for="txAuthPin">PIN</label>
        <input id="txAuthPin" type="password" minlength="4" maxlength="256" autocomplete="current-password" required />
        <label id="txAuthConfirmLabel" for="txAuthConfirm" class="hidden">Confirm PIN</label>
        <input id="txAuthConfirm" class="hidden" type="password" minlength="4" maxlength="256" autocomplete="new-password" />
        <div id="txAuthError" class="tx-auth-error" role="alert"></div>
        <div class="tx-auth-actions">
          <button id="txAuthCancel" type="button">Cancel</button>
          <button id="txAuthSubmit" type="submit">Unlock TX</button>
        </div>
      </form>`;
    document.body.appendChild(overlay);
  };

  const requestUnlock = async () => {
    if (promptPromise) return promptPromise;
    promptPromise = (async () => {
      ensureShell();
      await refresh();
      if (status.authorized) return true;
      const setupMode = !status.configured;
      const overlay = document.getElementById("txAuthOverlay");
      const form = document.getElementById("txAuthForm");
      const pin = document.getElementById("txAuthPin");
      const confirm = document.getElementById("txAuthConfirm");
      const confirmLabel = document.getElementById("txAuthConfirmLabel");
      const errorBox = document.getElementById("txAuthError");
      document.getElementById("txAuthTitle").textContent = setupMode ? "Create TX PIN" : "Unlock TX";
      document.getElementById("txAuthDescription").textContent = setupMode
        ? "Create the PIN used to unlock RF transmission. Authorization lasts until the system restarts."
        : status.inUse
          ? "TX is unlocked in another browser. Use Lock TX there before unlocking this session."
          : "Unlock RF transmission until you explicitly lock it or restart the system. There is no inactivity timeout.";
      document.getElementById("txAuthSubmit").textContent = setupMode ? "Create And Unlock" : "Unlock TX";
      pin.autocomplete = setupMode ? "new-password" : "current-password";
      confirm.classList.toggle("hidden", !setupMode);
      confirmLabel.classList.toggle("hidden", !setupMode);
      confirm.required = setupMode;
      pin.value = "";
      confirm.value = "";
      errorBox.textContent = "";
      overlay.classList.remove("hidden");
      pin.focus();

      return new Promise((resolve) => {
        const finish = (result) => {
          overlay.classList.add("hidden");
          form.removeEventListener("submit", submit);
          document.getElementById("txAuthCancel").removeEventListener("click", cancel);
          resolve(result);
        };
        const cancel = () => finish(false);
        const submit = async (event) => {
          event.preventDefault();
          errorBox.textContent = "";
          if (setupMode && pin.value !== confirm.value) {
            errorBox.textContent = "PINs do not match.";
            return;
          }
          try {
            const path = setupMode ? "/api/v1/tx-auth/setup" : "/api/v1/tx-auth/unlock";
            status = await requestJson(path, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pin: pin.value }),
            });
            updateIndicator();
            finish(true);
          } catch (error) {
            errorBox.textContent = error instanceof Error ? error.message : String(error);
          }
        };
        form.addEventListener("submit", submit);
        document.getElementById("txAuthCancel").addEventListener("click", cancel);
      });
    })();
    try {
      return await promptPromise;
    } finally {
      promptPromise = null;
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    ensureShell();
    void refresh();
  });

  return {
    get status() { return { ...status }; },
    refresh,
    requestUnlock,
  };
})();

const api = {
  get: async (path) => {
    const res = await fetch(path);
    if (!res.ok) {
      let detail = "";
      try {
        const payload = await res.json();
        const text = errorDetailText(payload);
        detail = text ? `: ${text}` : "";
      } catch {}
      throw new Error(`GET ${path} failed: ${res.status}${detail}`);
    }
    return res.json();
  },
  post: async (path, body, allowTxUnlock = true) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      let payload = null;
      try {
        payload = await res.json();
        const text = errorDetailText(payload);
        detail = text ? `: ${text}` : "";
      } catch {}
      const authCode = payload?.detail?.code;
      if (
        allowTxUnlock
        && res.status === 401
        && (authCode === "tx_auth_required" || authCode === "tx_auth_setup_required")
        && await txAuth.requestUnlock()
      ) {
        return api.post(path, body, false);
      }
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
    transportModeId,
    portSelectId,
    manualId,
    usbFieldsId,
    wifiFieldsId,
    wifiHostId,
    wifiUsernameId,
    wifiPasswordId,
    wifiControlPortId,
    baudRateId,
    civAddressId,
    pollIntervalId,
    autoTrackIntervalId,
    autoConnectId,
    applyModeToneId,
    safeTxGuardId,
    titleId,
    loadCurrent,
    saveSelection,
    onConnected,
    loadingMessage = "Loading available USB ports...",
    readyMessage = "Review the radio profile and connect",
    emptyMessage = "No USB ports detected automatically. Use manual override if needed.",
    connectingMessage = (profile) => `Saving ${profile.rig_model} ${profile.transport_mode} profile and connecting...`,
  } = config;
  let currentProfile = {};

  const normalizeProfile = (profile = {}) => {
    const model = String(profile?.rig_model || "ic705") || "ic705";
    const defaults = rigModelDefaults(model);
    return {
      enabled: profile?.enabled !== false,
      rig_model: model,
      transport_mode: String(profile?.transport_mode || "usb") || "usb",
      serial_device: String(profile?.serial_device || "").trim(),
      baud_rate: Number(profile?.baud_rate || defaults.baud_rate),
      civ_address: String(profile?.civ_address || defaults.civ_address || "").trim(),
      wifi_host: String(profile?.wifi_host || "").trim(),
      wifi_username: String(profile?.wifi_username || "").trim(),
      wifi_password: String(profile?.wifi_password || ""),
      wifi_control_port: Number(profile?.wifi_control_port || 50001),
      poll_interval_ms: Number(profile?.poll_interval_ms || 1000),
      auto_connect: !!profile?.auto_connect,
      auto_track_interval_ms: Number(profile?.auto_track_interval_ms || 1500),
      default_apply_mode_and_tone: profile?.default_apply_mode_and_tone !== false,
      safe_tx_guard_enabled: profile?.safe_tx_guard_enabled !== false,
    };
  };

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

  const setFieldValue = (id, value) => {
    const el = byId(id);
    if (!el) return;
    el.value = value == null ? "" : String(value);
  };

  const setChecked = (id, value) => {
    const el = byId(id);
    if (el) el.checked = !!value;
  };

  const markManualDirty = (active) => {
    const input = byId(manualId);
    if (input) input.dataset.dirty = active ? "1" : "0";
  };

  const syncTransportFields = () => {
    const rigModel = byId(rigModelId)?.value || "ic705";
    const transportMode = byId(transportModeId);
    if (transportMode && rigModel !== "ic705" && transportMode.value === "wifi") {
      transportMode.value = "usb";
    }
    const wifiActive = transportMode?.value === "wifi" && rigModel === "ic705";
    const usbFields = byId(usbFieldsId);
    const wifiFields = byId(wifiFieldsId);
    if (usbFields) usbFields.classList.toggle("hidden", wifiActive);
    if (wifiFields) wifiFields.classList.toggle("hidden", !wifiActive);
    const title = byId(titleId);
    if (title) {
      title.textContent = wifiActive ? "Review Wi-Fi profile and connect" : "Review USB profile and connect";
    }
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

  const readDraftProfile = () => {
    const rigModel = byId(rigModelId)?.value || currentProfile.rig_model || "ic705";
    const defaults = rigModelDefaults(rigModel);
    const transportMode = byId(transportModeId)?.value || currentProfile.transport_mode || "usb";
    const selectedPort = byId(portSelectId)?.value || "";
    const manualInput = byId(manualId);
    const manualPort = manualInput?.value?.trim() || "";
    const manualDirty = manualInput?.dataset?.dirty === "1";
    return {
      enabled: true,
      rig_model: rigModel,
      transport_mode: transportMode,
      serial_device: manualDirty ? (manualPort || selectedPort) : (selectedPort || manualPort || currentProfile.serial_device || ""),
      baud_rate: Number(byId(baudRateId)?.value || defaults.baud_rate),
      civ_address: byId(civAddressId)?.value || currentProfile.civ_address || defaults.civ_address,
      wifi_host: byId(wifiHostId)?.value?.trim() || "",
      wifi_username: byId(wifiUsernameId)?.value?.trim() || "",
      wifi_password: byId(wifiPasswordId)?.value || "",
      wifi_control_port: Number(byId(wifiControlPortId)?.value || currentProfile.wifi_control_port || 50001),
      poll_interval_ms: Number(byId(pollIntervalId)?.value || currentProfile.poll_interval_ms || 1000),
      auto_connect: !!byId(autoConnectId)?.checked,
      auto_track_interval_ms: Number(byId(autoTrackIntervalId)?.value || currentProfile.auto_track_interval_ms || 1500),
      default_apply_mode_and_tone: byId(applyModeToneId)?.checked !== false,
      safe_tx_guard_enabled: byId(safeTxGuardId)?.checked !== false,
      _manualPort: manualPort,
      _manualDirty: manualDirty,
      _selectedPort: selectedPort,
    };
  };

  const applyProfile = (profile, options = {}) => {
    const normalized = normalizeProfile(profile);
    const manualInput = byId(manualId);
    const selectedPort = options.selectedPort || normalized.serial_device;
    const manualPort = options.manualPort != null ? options.manualPort : normalized.serial_device;
    setFieldValue(rigModelId, normalized.rig_model);
    setFieldValue(transportModeId, normalized.transport_mode);
    setFieldValue(wifiHostId, normalized.wifi_host);
    setFieldValue(wifiUsernameId, normalized.wifi_username);
    setFieldValue(wifiPasswordId, normalized.wifi_password);
    setFieldValue(wifiControlPortId, normalized.wifi_control_port);
    setFieldValue(baudRateId, normalized.baud_rate);
    setFieldValue(civAddressId, normalized.civ_address);
    setFieldValue(pollIntervalId, normalized.poll_interval_ms);
    setFieldValue(autoTrackIntervalId, normalized.auto_track_interval_ms);
    setChecked(autoConnectId, normalized.auto_connect);
    setChecked(applyModeToneId, normalized.default_apply_mode_and_tone);
    setChecked(safeTxGuardId, normalized.safe_tx_guard_enabled);
    if (manualInput) manualInput.value = manualPort;
    markManualDirty(!!options.manualDirty);
    populatePortOptions(options.ports || [], selectedPort);
    syncTransportFields();
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
    const rigModel = byId(rigModelId);
    if (rigModel && !rigModel.dataset.bound) {
      rigModel.dataset.bound = "1";
      rigModel.addEventListener("change", () => {
        const defaults = rigModelDefaults(rigModel.value);
        setFieldValue(baudRateId, defaults.baud_rate);
        setFieldValue(civAddressId, defaults.civ_address);
        syncTransportFields();
      });
    }
    const transportMode = byId(transportModeId);
    if (transportMode && !transportMode.dataset.bound) {
      transportMode.dataset.bound = "1";
      transportMode.addEventListener("change", syncTransportFields);
    }
  };

  const open = async () => {
    bind();
    const modal = byId(modalId);
    const wasVisible = !!modal && !modal.classList.contains("hidden");
    const previousDraft = wasVisible ? readDraftProfile() : null;
    setVisible(true);
    setStatus(loadingMessage);
    try {
      const [current, portsResp] = await Promise.all([
        loadCurrent(),
        api.get("/api/v1/radio/ports"),
      ]);
      currentProfile = normalizeProfile(current);
      const ports = portsResp.items || [];
      const effectiveProfile = wasVisible && previousDraft ? { ...currentProfile, ...previousDraft } : currentProfile;
      applyProfile(effectiveProfile, {
        ports,
        selectedPort: wasVisible && previousDraft ? previousDraft._selectedPort : currentProfile.serial_device,
        manualPort: wasVisible && previousDraft ? previousDraft._manualPort : currentProfile.serial_device,
        manualDirty: wasVisible && previousDraft ? previousDraft._manualDirty : false,
      });
      const transportMode = effectiveProfile.transport_mode;
      if (transportMode === "wifi") {
        setStatus(readyMessage);
      } else {
        setStatus(ports.length ? readyMessage : emptyMessage);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const close = () => setVisible(false);

  const submit = async () => {
    const payload = readDraftProfile();
    if (payload.transport_mode === "wifi") {
      if (payload.rig_model !== "ic705") {
        setStatus("Wi-Fi transport is currently supported only for the IC-705");
        return;
      }
      if (!payload.wifi_host) {
        setStatus("Enter the Wi-Fi host before connecting");
        return;
      }
      if (!payload.wifi_username) {
        setStatus("Enter the Wi-Fi username before connecting");
        return;
      }
    } else if (!payload.serial_device) {
      setStatus("Choose a USB port or enter a manual device path");
      return;
    }
    setStatus(connectingMessage(payload));
    try {
      await saveSelection(payload);
      currentProfile = normalizeProfile(payload);
      if (typeof onConnected === "function") {
        await onConnected(payload);
      }
      close();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return { open, close, submit, bind, setStatus };
}

async function setBrowserLocation() {
  try {
    const nativeResponse = await api.post("/api/v1/desktop/native-location", {});
    const nativeLocation = nativeResponse?.state?.browser_location || nativeResponse?.resolved || null;
    if (nativeLocation && nativeLocation.lat != null && nativeLocation.lon != null) {
      return {
        lat: Number(Number(nativeLocation.lat).toFixed(6)),
        lon: Number(Number(nativeLocation.lon).toFixed(6)),
        alt_m: Number(Number(nativeLocation.alt_m || 0).toFixed(1)),
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("404")) {
      throw error;
    }
  }

  const nativeLocationApi = window.pywebview?.api?.native_location;
  if (typeof nativeLocationApi === "function") {
    const native = await nativeLocationApi();
    const payload = {
      browser_location: {
        lat: Number(Number(native.lat).toFixed(6)),
        lon: Number(Number(native.lon).toFixed(6)),
        alt_m: Number(Number(native.alt_m || 0).toFixed(1)),
      },
    };
    await api.post("/api/v1/location", payload);
    return payload.browser_location;
  }
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
  txAuth,
};

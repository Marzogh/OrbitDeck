(() => {
  function pretty(value) {
    return JSON.stringify(value, null, 2);
  }

  function isDirewolfMissingMessage(message) {
    const text = String(message || "").toLowerCase();
    return text.includes("direwolf") && (text.includes("no such file") || text.includes("not found"));
  }

  function packetPreview(packet) {
    const text = String(packet?.text || "").trim();
    if (!text) return "(no text)";
    return text.length > 96 ? `${text.slice(0, 93)}...` : text;
  }

  function packetDetail(packet) {
    const parts = [String(packet?.packet_type || "raw").toUpperCase()];
    if (packet?.addressee) parts.push(`to ${packet.addressee}`);
    if (packet?.latitude != null && packet?.longitude != null) {
      parts.push(`${Number(packet.latitude).toFixed(4)}, ${Number(packet.longitude).toFixed(4)}`);
    }
    return parts.join(" | ");
  }

  function pathText(path) {
    return Array.isArray(path) && path.length ? path.join(",") : "--";
  }

  function lastRxFromRuntime(runtime) {
    const packets = Array.isArray(runtime?.recent_packets) ? runtime.recent_packets : [];
    return packets[0] || null;
  }

  function updateCounter(input, counter, config = {}) {
    if (!input || !counter) return;
    const hardLimit = Number(config.hardLimit || 67);
    const softLimit = Number(config.softLimit || 0);
    const text = String(input.value || "");
    if (text.length > hardLimit) {
      input.value = text.slice(0, hardLimit);
    }
    const remaining = hardLimit - input.value.length;
    const bits = [];
    if (config.prefix) bits.push(config.prefix);
    bits.push(`${hardLimit} max`);
    if (softLimit > 0) bits.push(`best under ${softLimit}`);
    bits.push(`${remaining} remaining`);
    counter.textContent = bits.join(" • ");
    counter.classList.toggle("warning", remaining <= Math.min(10, Math.floor(hardLimit * 0.2)));
  }

  function bindCounter(input, counter, config) {
    if (!input || !counter) return;
    const render = () => updateCounter(input, counter, config);
    input.addEventListener("input", render);
    render();
  }

  function buildPositionPreview(state, comment) {
    const runtimeText = String(state?.aprs?.runtime?.last_tx_text || "").trim();
    if (runtimeText) return runtimeText;
    const settings = state?.aprs?.settings || {};
    const location = state?.location?.state?.resolved_location || state?.location?.state?.browser_location || state?.location?.state?.gps_location || null;
    if (!location || location.lat == null || location.lon == null) {
      return "Position preview unavailable until location is resolved";
    }
    const lat = Number(location.lat || 0) + Number(settings.position_fudge_lat_deg || 0);
    const lon = Number(location.lon || 0) + Number(settings.position_fudge_lon_deg || 0);
    const latAbs = Math.abs(lat);
    const lonAbs = Math.abs(lon);
    const latDeg = Math.floor(latAbs);
    const lonDeg = Math.floor(lonAbs);
    const latMin = (latAbs - latDeg) * 60;
    const lonMin = (lonAbs - lonDeg) * 60;
    const latH = lat >= 0 ? "N" : "S";
    const lonH = lon >= 0 ? "E" : "W";
    const symbolTable = String(settings.symbol_table || "/").slice(0, 1) || "/";
    let symbolCode = String(settings.symbol_code || "[").slice(0, 1) || ">";
    if ((settings.operating_mode || "terrestrial") === "terrestrial" && symbolCode === "[") {
      symbolCode = ">";
    }
    const commentText = String(comment || "").slice(0, 40);
    return `!${String(latDeg).padStart(2, "0")}${latMin.toFixed(2).padStart(5, "0")}${latH}${symbolTable}${String(lonDeg).padStart(3, "0")}${lonMin.toFixed(2).padStart(5, "0")}${lonH}${symbolCode}${commentText}`;
  }

  function summarizeTarget(target) {
    if (!target) {
      return {
        headline: "No APRS target preview available",
        status: "No APRS TX state available",
      };
    }
    const passLine = target.requires_pass
      ? (target.pass_active
        ? `Pass active until ${new Date(target.pass_los).toLocaleString()}`
        : target.pass_aos
          ? `Next pass ${new Date(target.pass_aos).toLocaleString()} to ${new Date(target.pass_los).toLocaleString()}`
          : "No upcoming pass in current window")
      : "Terrestrial APRS does not require a pass";
    return {
      headline: `Target ${target.label} | PATH ${target.path_default || "--"} | ${passLine}${target.guidance ? ` | ${target.guidance}` : ""}`,
      status: target.can_transmit ? "Transmit allowed" : `Transmit blocked | ${target.tx_block_reason || "Unavailable"}`,
    };
  }

  function isWifiManaged(radioSettings) {
    return radioSettings?.rig_model === "ic705" && radioSettings?.transport_mode === "wifi";
  }

  async function loadBundle(api) {
    const [aprs, targets, system, audioDevices, logSettings, logRecent] = await Promise.all([
      api.get("/api/v1/aprs/state"),
      api.get("/api/v1/aprs/targets"),
      api.get("/api/v1/system/state"),
      api.get("/api/v1/aprs/audio-devices").catch(() => ({ inputs: [], outputs: [] })),
      api.get("/api/v1/aprs/log/settings"),
      api.get("/api/v1/aprs/log?limit=50"),
    ]);
    return { aprs, targets, system, audioDevices, logSettings, logRecent };
  }

  async function saveAprsSettings(api, payload) {
    return api.post("/api/v1/settings/aprs", payload);
  }

  async function saveLogSettings(api, payload) {
    return api.post("/api/v1/aprs/log/settings", payload);
  }

  async function selectTarget(api, payload) {
    return api.post("/api/v1/aprs/select-target", payload);
  }

  async function connect(api) {
    return api.post("/api/v1/aprs/connect", {});
  }

  async function disconnect(api) {
    return api.post("/api/v1/aprs/disconnect", {});
  }

  async function panicUnkey(api) {
    return api.post("/api/v1/aprs/panic-unkey", {});
  }

  async function sendMessage(api, payload) {
    return api.post("/api/v1/aprs/send/message", payload);
  }

  async function sendStatus(api, payload) {
    return api.post("/api/v1/aprs/send/status", payload);
  }

  async function sendPosition(api, payload) {
    return api.post("/api/v1/aprs/send/position", payload);
  }

  async function fetchLog(api, query = "limit=50") {
    return api.get(`/api/v1/aprs/log?${query}`);
  }

  async function clearLog(api, ageBucket) {
    return api.post("/api/v1/aprs/log/clear", { age_bucket: ageBucket });
  }

  function exportUrl(format) {
    return format === "json" ? "/api/v1/aprs/log/export.json" : "/api/v1/aprs/log/export.csv";
  }

  window.OrbitDeckAprsConsole = {
    pretty,
    isDirewolfMissingMessage,
    packetPreview,
    packetDetail,
    pathText,
    lastRxFromRuntime,
    bindCounter,
    updateCounter,
    buildPositionPreview,
    summarizeTarget,
    isWifiManaged,
    loadBundle,
    saveAprsSettings,
    saveLogSettings,
    selectTarget,
    connect,
    disconnect,
    panicUnkey,
    sendMessage,
    sendStatus,
    sendPosition,
    fetchLog,
    clearLog,
    exportUrl,
  };
})();

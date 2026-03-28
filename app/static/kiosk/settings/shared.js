export const TRACKED_SAT_KEY = "kioskTrackedSatId";
export const VIDEO_SOURCES_KEY = "kioskVideoSources";
export const DEV_MODE_KEY = "kioskDevModeEnabled";
export const DEV_FORCE_SCENE_KEY = "kioskDevForceScene";
export const DISPLAY_TIMEZONE_CHOICE_KEY = "orbitdeckDisplayTimezoneChoice";

export const DEFAULT_VIDEO_SOURCES = [
  "https://www.youtube.com/embed/fO9e9jnhYK8?autoplay=1&mute=1&rel=0&modestbranding=1",
  "https://www.youtube.com/embed/sWasdbDVNvc?autoplay=1&mute=1&rel=0&modestbranding=1",
];

export const aprsClient = window.OrbitDeckAprsConsole;

const env = {
  trackerApi: null,
  trackerById: null,
  trackerSetBrowserLocation: null,
  trackerRenderStationBadge: null,
};

export const stateCache = {
  satellites: [],
  timezones: [],
  radio: { settings: {}, runtime: {} },
  aprs: { settings: {}, runtime: {}, previewTarget: null },
  aprsTargets: { satellites: [], terrestrial: null },
  aprsLogSettings: {},
  aprsLog: { items: [] },
  location: { state: {} },
  system: {},
  radioPorts: [],
  audioDevices: { inputs: [], outputs: [] },
};

export const viewState = {
  activeSection: "overview",
  activeAprsTab: "configuration",
  aprsSendTab: "message",
  aprsDrafts: {
    messageTo: "",
    messageBody: "",
    statusBody: "",
    positionComment: "",
  },
  aprsDrawerTab: "recent",
  aprsDrawerDirty: false,
  heardFilter: "all",
  displayValidation: {},
  recentEvents: [],
  dirtySections: {},
  sectionSnapshots: {},
  seenPacketKeys: new Set(),
  notificationsReady: false,
  detailPacket: null,
  pollTimer: null,
};

export function initEnvironment() {
  env.trackerApi = window.issTracker.api;
  env.trackerById = window.issTracker.byId;
  env.trackerSetBrowserLocation = window.issTracker.setBrowserLocation;
  env.trackerRenderStationBadge = window.issTracker.renderStationBadge;
}

export function getEnv() {
  return { ...env };
}

export function pretty(value) {
  return JSON.stringify(value, null, 2);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function defaultsForModel(model) {
  return model === "ic705"
    ? { baud_rate: 19200, civ_address: "0xA4" }
    : { baud_rate: 19200, civ_address: "0x8C" };
}

export function isHamFrequencySatellite(sat) {
  if (!sat || sat.has_amateur_radio === false) return false;
  const tx = Array.isArray(sat.transponders) ? sat.transponders : [];
  const rx = Array.isArray(sat.repeaters) ? sat.repeaters : [];
  const joined = [...tx, ...rx].join(" ").toLowerCase();
  if (!joined.trim()) return false;
  return /(mhz|aprs|fm|ssb|cw|bpsk|fsk|afsk|transponder|repeater|ctcss|sstv)/.test(joined);
}

export function loadVideoSources() {
  const selections = loadVideoSourceSelections();
  return [
    resolveVideoSourceSelection(selections.primary),
    resolveVideoSourceSelection(selections.secondary),
  ].filter(Boolean);
}

export function loadVideoSourceSelections() {
  try {
    const raw = localStorage.getItem(VIDEO_SOURCES_KEY);
    if (!raw) {
      return {
        primary: { mode: "default_primary", url: "" },
        secondary: { mode: "default_secondary", url: "" },
      };
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const cleaned = parsed.map((item) => String(item || "").trim()).filter(Boolean);
      return {
        primary: inferVideoSelection(cleaned[0], "default_primary"),
        secondary: inferVideoSelection(cleaned[1], "default_secondary"),
      };
    }
    if (parsed && typeof parsed === "object") {
      return {
        primary: normalizeVideoSelection(parsed.primary, "default_primary"),
        secondary: normalizeVideoSelection(parsed.secondary, "default_secondary"),
      };
    }
  } catch {
    // Fall through to defaults.
  }
  return {
    primary: { mode: "default_primary", url: "" },
    secondary: { mode: "default_secondary", url: "" },
  };
}

export function saveVideoSourcesLocal(primary, secondary) {
  const primarySelection = normalizeVideoSelection(primary, "default_primary");
  const secondarySelection = normalizeVideoSelection(secondary, "default_secondary");
  if (!resolveVideoSourceSelection(primarySelection)) throw new Error("A primary video source is required");
  localStorage.setItem(VIDEO_SOURCES_KEY, JSON.stringify({
    primary: primarySelection,
    secondary: secondarySelection,
  }));
}

export function resolveVideoSourceSelection(selection) {
  const normalized = normalizeVideoSelection(selection, "default_primary");
  if (normalized.mode === "default_primary") return DEFAULT_VIDEO_SOURCES[0];
  if (normalized.mode === "default_secondary") return DEFAULT_VIDEO_SOURCES[1];
  return String(normalized.url || "").trim();
}

function inferVideoSelection(url, fallbackMode) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return { mode: fallbackMode, url: "" };
  if (trimmed === DEFAULT_VIDEO_SOURCES[0]) return { mode: "default_primary", url: "" };
  if (trimmed === DEFAULT_VIDEO_SOURCES[1]) return { mode: "default_secondary", url: "" };
  return { mode: "custom", url: trimmed };
}

function normalizeVideoSelection(selection, fallbackMode) {
  if (typeof selection === "string") return inferVideoSelection(selection, fallbackMode);
  if (!selection || typeof selection !== "object") return { mode: fallbackMode, url: "" };
  const mode = String(selection.mode || fallbackMode);
  if (mode === "default_primary" || mode === "default_secondary") {
    return { mode, url: "" };
  }
  return { mode: "custom", url: String(selection.url || "").trim() };
}

export function getDevSettings() {
  return {
    enabled: localStorage.getItem(DEV_MODE_KEY) === "1",
    forceScene: localStorage.getItem(DEV_FORCE_SCENE_KEY) || "auto",
  };
}

export function getDevModeSelection() {
  const dev = getDevSettings();
  return dev.enabled ? (dev.forceScene || "auto") : "disabled";
}

export function saveDevSettings({ enabled, forceScene, selection } = {}) {
  const requested = String(selection || "").trim();
  const nextSelection = requested || (enabled ? (forceScene || "auto") : "disabled");
  if (nextSelection === "disabled") {
    localStorage.removeItem(DEV_MODE_KEY);
    localStorage.removeItem(DEV_FORCE_SCENE_KEY);
    return;
  }
  localStorage.setItem(DEV_MODE_KEY, "1");
  localStorage.setItem(DEV_FORCE_SCENE_KEY, nextSelection || forceScene || "auto");
}

export function saveDisplayTimezoneChoice(choice) {
  const value = String(choice || "").trim() || "BrowserLocal";
  localStorage.setItem(DISPLAY_TIMEZONE_CHOICE_KEY, value);
}

export function getDisplayTimezoneChoice() {
  return localStorage.getItem(DISPLAY_TIMEZONE_CHOICE_KEY);
}

export function resolveDisplayTimezoneChoice(savedTimezone) {
  const normalized = String(savedTimezone || "").trim() || "BrowserLocal";
  if (normalized === "UTC" && !getDisplayTimezoneChoice()) {
    return "BrowserLocal";
  }
  return normalized;
}

export function setRuntime(action, value) {
  const el = env.trackerById ? env.trackerById("v2RuntimeLog") : null;
  if (!el) return;
  el.textContent = pretty({ action, ...value });
}

export async function runAction(action, fn) {
  setRuntime(action, { status: "pending" });
  try {
    const response = await fn();
    setRuntime(action, { status: "ok", response });
    return response;
  } catch (error) {
    setRuntime(action, {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function recordEvent(title, detail = "") {
  viewState.recentEvents.unshift({
    title,
    detail,
    at: new Date().toISOString(),
  });
  viewState.recentEvents = viewState.recentEvents.slice(0, 12);
}

export function formatCoord(value) {
  if (value == null || value === "") return "--";
  return Number(value).toFixed(6);
}

export function formatDateTime(value) {
  if (!value) return "--";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

export function formatRelativeTone(value) {
  return value ? String(value).replaceAll("_", " ") : "--";
}

export function transportSummary(radioSettings, radioRuntime = {}) {
  const transport = String(radioSettings?.transport_mode || radioRuntime?.transport_mode || "usb").toUpperCase();
  if ((radioSettings?.transport_mode || radioRuntime?.transport_mode) === "wifi") {
    const host = radioSettings?.wifi_host || radioRuntime?.endpoint || "--";
    const port = radioSettings?.wifi_control_port || "--";
    return `${transport} | ${host}${port !== "--" ? `:${port}` : ""}`;
  }
  return `${transport} | ${radioSettings?.serial_device || radioRuntime?.serial_device || "--"}`;
}

export function radioContextSummary(radioSettings) {
  return `Rig ${String(radioSettings?.rig_model || "--").toUpperCase()} | ${transportSummary(radioSettings)}`;
}

export function effectiveLocation(state) {
  const current = state || {};
  return current.resolved_location || current.browser_location || current.gps_location || current.manual_location || null;
}

export function locationSummary(location) {
  const state = location?.state || {};
  const resolved = effectiveLocation(state);
  if (!resolved) return "No resolved coordinates";
  return `${formatCoord(resolved.lat)}, ${formatCoord(resolved.lon)}`;
}

export function toggleHidden(el, hidden) {
  if (!el) return;
  el.classList.toggle("hidden", hidden);
}

export function getTrackedSatelliteId() {
  return localStorage.getItem(TRACKED_SAT_KEY) || "iss-zarya";
}

export function setTrackedSatelliteId(value) {
  localStorage.setItem(TRACKED_SAT_KEY, value);
}

import { defaultsForModel, escapeHtml, transportSummary } from "./shared.js";

function populateRadioPorts(select, items, selectedValue) {
  const options = [];
  const selected = String(selectedValue || "").trim();
  if (selected && !items.some((item) => String(item?.device || "").trim() === selected)) {
    options.push(`<option value="${escapeHtml(selected)}">${escapeHtml(selected)} · current</option>`);
  }
  for (const item of items) {
    const device = String(item?.device || "").trim();
    if (!device) continue;
    const desc = String(item?.description || "").trim();
    options.push(`<option value="${escapeHtml(device)}">${escapeHtml(desc ? `${device} · ${desc}` : device)}</option>`);
  }
  if (!options.length) options.push('<option value="">No USB serial ports detected</option>');
  select.innerHTML = options.join("");
  select.value = selected || items[0]?.device || "";
}

export function renderRadioSection({ stateCache, viewState }) {
  const radioSettings = stateCache.radio.settings || {};
  const radioRuntime = stateCache.radio.runtime || {};
  const dirty = !!viewState.dirtySections.radio;
  const reconnectNote = dirty ? "Save these changes before reconnecting the radio." : "";
  const connectLabel = dirty ? "Save Changes First" : (radioRuntime.connected ? "Disconnect" : "Connect");
  const connectClass = radioRuntime.connected ? "aprs-connect-red" : "aprs-connect-green";

  return `
    <section class="settings-v2-screen">
      <header class="settings-v2-screen-head">
        <div>
          <div class="label mono">Radio</div>
          <h2>Radio Connection</h2>
          <p>Configure the radio connection used by rig control and APRS.</p>
        </div>
        <div class="settings-v2-status-cluster">
          <span class="settings-v2-summary-pill">${escapeHtml(transportSummary(radioSettings, radioRuntime))}</span>
          <span class="settings-v2-summary-pill">${radioRuntime.connected ? "Connected" : "Disconnected"}</span>
        </div>
      </header>

      <div class="settings-v2-section-actions settings-v2-section-actions-top">
        <button type="button" data-save-radio>Save Radio Settings</button>
        <button type="button" data-radio-connect class="${connectClass}">${connectLabel}</button>
      </div>

      <div data-dirty-scope="radio" class="settings-v2-stack">
        <article class="card settings-v2-card">
          <div class="settings-v2-card-head">
            <h3>Radio Profile</h3>
            <div class="settings-v2-card-note">This connection is the transport dependency for APRS.</div>
          </div>
          <div class="settings-v2-form-grid">
            <label>
              <span>Rig Model</span>
              <select id="v2RadioRigModel">
                <option value="id5100">Icom ID-5100</option>
                <option value="ic705">Icom IC-705</option>
              </select>
            </label>
            <label>
              <span>Connection Type</span>
              <select id="v2RadioTransportMode">
                <option value="usb">USB</option>
                <option value="wifi">Wi-Fi</option>
              </select>
            </label>
            <label id="v2RadioUsbField">
              <span>USB Serial Device</span>
              <select id="v2RadioSerialDevice"></select>
            </label>
            <div class="settings-v2-inline-note settings-v2-span-2">
              Active profile: ${escapeHtml(transportSummary(radioSettings, radioRuntime))}
            </div>
          </div>
        </article>

        <article class="card settings-v2-card">
          <h3>Transport</h3>
          <div class="settings-v2-form-grid">
            <label id="v2RadioWifiHostField">
              <span>Radio IP Address</span>
              <input id="v2RadioWifiHost" type="text" placeholder="192.168.2.70" />
            </label>
            <label id="v2RadioWifiPortField">
              <span>Control Port</span>
              <input id="v2RadioWifiControlPort" type="number" min="1" max="65535" step="1" />
            </label>
            <label id="v2RadioWifiUsernameField">
              <span>Username</span>
              <input id="v2RadioWifiUsername" type="text" />
            </label>
            <label id="v2RadioWifiPasswordField">
              <span>Password</span>
              <input id="v2RadioWifiPassword" type="password" autocomplete="new-password" />
            </label>
          </div>
        </article>

        <article class="card settings-v2-card">
          <h3>Rig Control</h3>
          <div class="settings-v2-form-grid">
            <label>
              <span>Baud Rate</span>
              <input id="v2RadioBaudRate" type="number" min="4800" max="19200" step="1" />
            </label>
            <label>
              <span>CI-V Address</span>
              <input id="v2RadioCivAddress" type="text" placeholder="0xA4" />
            </label>
            <label>
              <span>Status Refresh Interval (ms)</span>
              <input id="v2RadioPollInterval" type="number" min="100" max="10000" step="100" />
            </label>
            <label>
              <span>Tracking Refresh Interval (ms)</span>
              <input id="v2RadioAutoTrackInterval" type="number" min="200" max="10000" step="100" />
            </label>
          </div>
        </article>

        <article class="card settings-v2-card">
          <h3>Connection Behavior</h3>
          <div class="settings-v2-toggle-grid">
            <label class="settings-v2-toggle"><input id="v2RadioEnabled" type="checkbox" /> <span>Radio Enabled</span></label>
            <label class="settings-v2-toggle"><input id="v2RadioAutoConnect" type="checkbox" /> <span>Auto Connect On Launch</span></label>
            <label class="settings-v2-toggle"><input id="v2RadioApplyModeTone" type="checkbox" /> <span>Apply Mode And Tone</span></label>
            <label class="settings-v2-toggle"><input id="v2RadioSafeTxGuard" type="checkbox" /> <span>Safe TX Guard</span></label>
          </div>
        </article>
      </div>

      <article class="card settings-v2-card">
        <h3>Connection State</h3>
        <div class="settings-v2-readonly-grid">
          <div><span>Status</span><strong>${radioRuntime.connected ? "Connected" : "Disconnected"}</strong></div>
          <div><span>Endpoint</span><strong>${escapeHtml(radioRuntime.endpoint || radioSettings.serial_device || "--")}</strong></div>
          <div><span>Last Poll</span><strong>${escapeHtml(radioRuntime.last_poll_at || "--")}</strong></div>
          <div><span>Last Error</span><strong>${escapeHtml(radioRuntime.last_error || "None")}</strong></div>
        </div>
        <div class="settings-v2-inline-note hidden" data-radio-reconnect-note>${escapeHtml(reconnectNote)}</div>
      </article>

      <footer class="settings-v2-footer">
        <div class="settings-v2-footer-state" data-dirty-badge>${dirty ? "Unsaved changes" : "All changes saved"}</div>
        <div class="settings-v2-section-actions">
          <button type="button" data-discard-section="radio">Discard Changes</button>
          <button type="button" data-save-radio>Save Radio Settings</button>
          <button type="button" data-radio-connect class="${connectClass}">${connectLabel}</button>
        </div>
      </footer>
    </section>
  `;
}

export function bindRadioSection(ctx) {
  const settings = ctx.stateCache.radio.settings || {};
  const rigModel = document.getElementById("v2RadioRigModel");
  const transportMode = document.getElementById("v2RadioTransportMode");
  const serialDevice = document.getElementById("v2RadioSerialDevice");
  const usbField = document.getElementById("v2RadioUsbField");
  const wifiFields = [
    document.getElementById("v2RadioWifiHostField"),
    document.getElementById("v2RadioWifiPortField"),
    document.getElementById("v2RadioWifiUsernameField"),
    document.getElementById("v2RadioWifiPasswordField"),
  ];

  rigModel.value = settings.rig_model || "id5100";
  transportMode.value = settings.transport_mode || "usb";
  populateRadioPorts(serialDevice, ctx.stateCache.radioPorts || [], settings.serial_device || "");
  document.getElementById("v2RadioWifiHost").value = settings.wifi_host || "";
  document.getElementById("v2RadioWifiControlPort").value = settings.wifi_control_port || 50001;
  document.getElementById("v2RadioWifiUsername").value = settings.wifi_username || "";
  document.getElementById("v2RadioWifiPassword").value = settings.wifi_password || "";
  document.getElementById("v2RadioBaudRate").value = settings.baud_rate || 19200;
  document.getElementById("v2RadioCivAddress").value = settings.civ_address || defaultsForModel(rigModel.value).civ_address;
  document.getElementById("v2RadioPollInterval").value = settings.poll_interval_ms || 1000;
  document.getElementById("v2RadioAutoTrackInterval").value = settings.auto_track_interval_ms || 1500;
  document.getElementById("v2RadioEnabled").checked = !!settings.enabled;
  document.getElementById("v2RadioAutoConnect").checked = !!settings.auto_connect;
  document.getElementById("v2RadioApplyModeTone").checked = settings.default_apply_mode_and_tone !== false;
  document.getElementById("v2RadioSafeTxGuard").checked = settings.safe_tx_guard_enabled !== false;

  const syncTransport = () => {
    const forceUsb = rigModel.value !== "ic705" && transportMode.value === "wifi";
    if (forceUsb) transportMode.value = "usb";
    const wifi = transportMode.value === "wifi" && rigModel.value === "ic705";
    usbField.classList.toggle("hidden", wifi);
    wifiFields.forEach((field) => field.classList.toggle("hidden", !wifi));
  };

  rigModel.addEventListener("change", () => {
    const defaults = defaultsForModel(rigModel.value);
    document.getElementById("v2RadioBaudRate").value = defaults.baud_rate;
    document.getElementById("v2RadioCivAddress").value = defaults.civ_address;
    syncTransport();
    ctx.updateDirtyState("radio");
  });
  transportMode.addEventListener("change", syncTransport);
  syncTransport();

  document.querySelectorAll("[data-save-radio]").forEach((button) => button.addEventListener("click", ctx.saveRadioSection));
  document.querySelectorAll("[data-radio-connect]").forEach((button) => button.addEventListener("click", ctx.toggleRadioConnection));
  document.querySelector("[data-discard-section='radio']").addEventListener("click", () => ctx.discardSection("radio"));
}

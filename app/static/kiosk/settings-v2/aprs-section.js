import { aprsClient, escapeHtml, formatDateTime, pretty, radioContextSummary } from "./shared.js";

function renderPacketRows(targetId, packets, emptyText) {
  if (!packets.length) {
    return `<div class="settings-v2-inline-note">${escapeHtml(emptyText)}</div>`;
  }
  return packets.map((packet, index) => `
    <button type="button" class="aprs-heard-row" data-aprs-packet-target="${targetId}" data-aprs-packet-index="${index}">
      <div class="aprs-heard-head">
        <div class="aprs-heard-title">
          <strong>${escapeHtml(packet.source || "--")}</strong>
          <div class="aprs-heard-badges">
            ${packet.digipeated ? '<span class="aprs-heard-badge">DIGI</span>' : ""}
            ${packet.igated ? '<span class="aprs-heard-badge">IGATE</span>' : ""}
          </div>
        </div>
        <span class="aprs-heard-meta">${escapeHtml(packet.received_at ? new Date(packet.received_at).toLocaleTimeString() : "--")}</span>
      </div>
      <div class="aprs-heard-meta">${escapeHtml(aprsClient.packetDetail(packet))} | PATH ${escapeHtml(aprsClient.pathText(packet.path))}</div>
      <div class="aprs-heard-text">${escapeHtml(aprsClient.packetPreview(packet))}</div>
    </button>
  `).join("");
}

function filteredPackets(stateCache, heardFilter) {
  const runtimePackets = Array.isArray(stateCache.aprs.runtime?.recent_packets) ? stateCache.aprs.runtime.recent_packets : [];
  const combined = [...runtimePackets];
  for (const packet of stateCache.aprsLog.items || []) {
    if (!combined.some((item) => item.received_at === packet.received_at && item.raw_tnc2 === packet.raw_tnc2)) combined.push(packet);
  }
  return heardFilter === "all"
    ? combined.slice(0, 12)
    : combined.filter((packet) => String(packet.packet_type || "").toLowerCase() === heardFilter).slice(0, 12);
}

function syncAprsModeDom(mode) {
  document.querySelectorAll("[data-aprs-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.aprsMode === mode);
  });
  document.getElementById("v2AprsMode").value = mode;
  document.getElementById("v2AprsTerrestrialField").classList.toggle("hidden", mode !== "terrestrial");
  document.getElementById("v2AprsTerrestrialPathField").classList.toggle("hidden", mode !== "terrestrial");
  document.getElementById("v2AprsTerrestrialCommentField").classList.toggle("hidden", mode !== "terrestrial");
  document.getElementById("v2AprsSatelliteField").classList.toggle("hidden", mode !== "satellite");
  document.getElementById("v2AprsChannelField").classList.toggle("hidden", mode !== "satellite");
  document.getElementById("v2AprsSatellitePathField").classList.toggle("hidden", mode !== "satellite");
  document.getElementById("v2AprsSatelliteCommentField").classList.toggle("hidden", mode !== "satellite");
}

function renderAudioNote(stateCache) {
  return aprsClient.isWifiManaged(stateCache.radio.settings || {})
    ? "Audio is managed automatically by the IC-705 Wi-Fi transport. RX and TX device selectors are disabled."
    : "Audio input and output devices can be selected for Dire Wolf AFSK transport.";
}

function summarizeTarget(stateCache) {
  return aprsClient.summarizeTarget(stateCache.aprs.previewTarget || stateCache.aprs.runtime?.target);
}

function gatewayStatusText(stateCache, overrides = {}) {
  const aprsRuntime = stateCache.aprs.runtime || {};
  const aprsLogSettings = stateCache.aprsLogSettings || {};
  const digipeaterEnabled = overrides.digipeaterEnabled ?? aprsLogSettings.future_digipeater_enabled ?? false;
  const igateEnabled = overrides.igateEnabled ?? aprsLogSettings.future_igate_enabled ?? false;
  const server = overrides.server ?? aprsRuntime.igate_server;
  const digipeaterState = aprsRuntime.digipeater_active
    ? "Digipeater active"
    : (digipeaterEnabled ? "Digipeater enabled" : "Digipeater inactive");
  const igateState = aprsRuntime.igate_active
    ? (
      aprsRuntime.igate_status === "connected"
        ? "iGate connected"
        : aprsRuntime.igate_status === "error"
          ? "iGate error"
          : "iGate connecting"
    )
    : (igateEnabled ? "iGate enabled" : "iGate inactive");
  return [digipeaterState, igateState, server || null].filter(Boolean).join(" | ");
}

export function renderAprsSection({ stateCache, viewState }) {
  const aprsSettings = stateCache.aprs.settings || {};
  const aprsRuntime = stateCache.aprs.runtime || {};
  const aprsLogSettings = stateCache.aprsLogSettings || {};
  const radioRuntime = stateCache.radio.runtime || {};
  const targetSummary = summarizeTarget(stateCache);
  const lastTx = aprsRuntime.last_tx_raw_tnc2
    ? `${aprsRuntime.last_tx_packet_type || "packet"} | ${aprsRuntime.last_tx_raw_tnc2}`
    : "No local transmission yet.";
  const lastRx = aprsClient.lastRxFromRuntime(aprsRuntime);
  const radioAprsState = aprsRuntime.connected
    ? "APRS connected"
    : (radioRuntime.connected ? "Radio ready for APRS" : "Radio unavailable for APRS");
  const igateState = aprsRuntime.igate_active
    ? (
      aprsRuntime.igate_status === "connected"
        ? "iGate connected"
        : aprsRuntime.igate_status === "error"
          ? "iGate error"
          : "iGate connecting"
    )
    : "iGate inactive";
  const igateMeta = [
    igateState,
    aprsRuntime.igate_auto_enabled ? "auto-enabled" : null,
    aprsRuntime.igate_server || null,
  ].filter(Boolean).join(" | ");
  const gatewayStatus = gatewayStatusText(stateCache);
  const gatewayPolicy = aprsRuntime.igate_reason || aprsRuntime.digipeater_reason || "Gateway features are idle.";

  return `
    <section class="settings-v2-screen">
      <header class="settings-v2-screen-head">
        <div>
          <div class="label mono">APRS</div>
          <h2>Operator console</h2>
          <p>Operate APRS on the radio connection, with separate tools for configuration, sending, packet monitoring, and diagnostics.</p>
        </div>
      </header>

      <article class="card settings-v2-card">
        <div class="settings-v2-aprs-bar">
          <div class="aprs-mode-toggle" role="tablist" aria-label="APRS operating mode">
            <button type="button" data-aprs-mode="terrestrial" class="${(aprsSettings.operating_mode || "terrestrial") === "terrestrial" ? "active" : ""}">Terrestrial</button>
            <button type="button" data-aprs-mode="satellite" class="${(aprsSettings.operating_mode || "terrestrial") === "satellite" ? "active" : ""}">Satellite</button>
          </div>
          <input id="v2AprsMode" type="hidden" value="${escapeHtml(aprsSettings.operating_mode || "terrestrial")}" />
          <div class="settings-v2-aprs-bar-meta">
            <span class="settings-v2-summary-pill">${aprsRuntime.connected ? "Connected" : "Disconnected"}</span>
            <span class="settings-v2-inline-note">${escapeHtml(radioAprsState)} | ${escapeHtml(radioContextSummary(stateCache.radio.settings || {}))}</span>
            <span class="settings-v2-inline-note">${escapeHtml(igateMeta)}</span>
          </div>
          <div class="settings-v2-section-actions">
            <button type="button" id="v2AprsConnectToggle" class="${aprsRuntime.connected ? "aprs-connect-red" : "aprs-connect-green"}">${aprsRuntime.connected ? "Disconnect" : "Connect"}</button>
            <button type="button" id="v2AprsOpenInbox">Open Inbox / Log</button>
          </div>
        </div>
      </article>

      <div class="settings-v2-tab-row" role="tablist" aria-label="APRS section tabs">
        <button type="button" data-aprs-tab="configuration" class="${viewState.activeAprsTab === "configuration" ? "active" : ""}">Configuration</button>
        <button type="button" data-aprs-tab="send" class="${viewState.activeAprsTab === "send" ? "active" : ""}">Send</button>
        <button type="button" data-aprs-tab="live-heard" class="${viewState.activeAprsTab === "live-heard" ? "active" : ""}">Live Heard</button>
        <button type="button" data-aprs-tab="diagnostics" class="${viewState.activeAprsTab === "diagnostics" ? "active" : ""}">Diagnostics</button>
      </div>

      <div data-dirty-scope="aprs" class="settings-v2-stack ${viewState.activeAprsTab === "configuration" ? "" : "hidden"}" data-aprs-panel="configuration">
        <article class="card settings-v2-card">
          <h3>Station Identity</h3>
          <div class="settings-v2-form-grid">
            <label>
              <span>Callsign</span>
              <input id="v2AprsCallsign" type="text" placeholder="VK4ABC" />
            </label>
            <label>
              <span>SSID</span>
              <input id="v2AprsSsid" type="number" min="0" max="15" step="1" />
            </label>
            <label>
              <span>Listen Mode</span>
              <select id="v2AprsListenOnly">
                <option value="false">Transmit + Receive</option>
                <option value="true">Listen Only</option>
              </select>
            </label>
          </div>
        </article>

        <article class="card settings-v2-card">
          <h3>Operating Target</h3>
          <div class="settings-v2-form-grid">
            <label id="v2AprsTerrestrialField">
              <span>Terrestrial Frequency (Hz)</span>
              <input id="v2AprsTerrestrialFreq" type="number" min="1000" step="1" />
            </label>
            <label id="v2AprsSatelliteField" class="hidden">
              <span>APRS Satellite</span>
              <select id="v2AprsSatellite"></select>
            </label>
            <label id="v2AprsChannelField" class="hidden">
              <span>Satellite APRS Channel</span>
              <select id="v2AprsChannel"></select>
            </label>
          </div>
          <div class="settings-v2-inline-note" id="v2AprsRegionHint"></div>
        </article>

        <article class="card settings-v2-card">
          <h3>Path And Comment</h3>
          <div class="settings-v2-form-grid">
            <label id="v2AprsTerrestrialPathField">
              <span>Terrestrial PATH</span>
              <input id="v2AprsTerrestrialPath" type="text" placeholder="WIDE1-1,WIDE2-1" />
            </label>
            <label id="v2AprsSatellitePathField" class="hidden">
              <span>Satellite PATH</span>
              <input id="v2AprsSatellitePath" type="text" placeholder="ARISS" />
            </label>
            <label id="v2AprsTerrestrialCommentField">
              <span>Terrestrial Comment</span>
              <input id="v2AprsTerrestrialComment" type="text" placeholder="OrbitDeck APRS" />
            </label>
            <label id="v2AprsSatelliteCommentField" class="hidden">
              <span>Satellite Comment</span>
              <input id="v2AprsSatelliteComment" type="text" placeholder="OrbitDeck Space APRS" />
            </label>
          </div>
        </article>

        <article class="card settings-v2-card">
          <div class="settings-v2-card-head">
            <div>
              <h3>Gateway Modes</h3>
              <div class="settings-v2-card-note">Control APRS digipeating and APRS-IS forwarding.</div>
            </div>
            <button
              type="button"
              id="v2AprsGatewayAdvancedToggle"
              class="settings-v2-inline-action"
              aria-expanded="${viewState.aprsGatewayAdvanced ? "true" : "false"}"
              aria-controls="v2AprsGatewayAdvanced"
            >
              ${viewState.aprsGatewayAdvanced ? "Hide Advanced" : "Show Advanced"}
            </button>
          </div>
          <div class="settings-v2-toggle-grid">
            <label class="settings-v2-toggle"><input id="v2AprsFutureDigipeaterMain" type="checkbox" ${aprsLogSettings.future_digipeater_enabled ? "checked" : ""} /> <span>Enable Digipeater<br /><small>Available only in terrestrial mode.</small></span></label>
            <label class="settings-v2-toggle"><input id="v2AprsFutureIgateMain" type="checkbox" ${aprsLogSettings.future_igate_enabled ? "checked" : ""} /> <span>Enable RX-only iGate</span></label>
            <label class="settings-v2-toggle"><input id="v2AprsIgateAutoEnableMain" type="checkbox" ${aprsLogSettings.igate_auto_enable_with_internet !== false ? "checked" : ""} /> <span>Auto-enable iGate when internet is available</span></label>
            <label class="settings-v2-toggle"><input id="v2AprsIgateTerrestrialMain" type="checkbox" ${aprsLogSettings.igate?.gate_terrestrial_rx !== false ? "checked" : ""} /> <span>Gate terrestrial APRS RX</span></label>
            <label class="settings-v2-toggle"><input id="v2AprsIgateSatelliteMain" type="checkbox" ${aprsLogSettings.igate?.gate_satellite_rx !== false ? "checked" : ""} /> <span>Gate satellite APRS RX</span></label>
          </div>
          <div id="v2AprsGatewayAdvanced" class="settings-v2-form-grid ${viewState.aprsGatewayAdvanced ? "" : "hidden"}">
            <label><span>Digipeater Aliases</span><input id="v2AprsDigipeaterAliasesMain" type="text" value="${escapeHtml((aprsLogSettings.digipeater?.aliases || ["WIDE1-1"]).join(","))}" /></label>
            <label><span>Duplicate Window (s)</span><input id="v2AprsDigipeaterDedupeMain" type="number" min="1" max="600" step="1" value="${escapeHtml(String(aprsLogSettings.digipeater?.dedupe_window_s || 30))}" /></label>
            <label><span>APRS-IS Host</span><input id="v2AprsIgateHostMain" type="text" value="${escapeHtml(aprsLogSettings.igate?.server_host || "rotate.aprs2.net")}" /></label>
            <label><span>APRS-IS Port</span><input id="v2AprsIgatePortMain" type="number" min="1" max="65535" step="1" value="${escapeHtml(String(aprsLogSettings.igate?.server_port || 14580))}" /></label>
            <label><span>Login Callsign</span><input id="v2AprsIgateLoginMain" type="text" value="${escapeHtml(aprsLogSettings.igate?.login_callsign || "")}" /></label>
            <label><span>Passcode</span><input id="v2AprsIgatePasscodeMain" type="password" value="${escapeHtml(aprsLogSettings.igate?.passcode || "")}" /></label>
            <label class="settings-v2-span-2"><span>Filter</span><input id="v2AprsIgateFilterMain" type="text" value="${escapeHtml(aprsLogSettings.igate?.filter || "m/25")}" /></label>
          </div>
          <div class="settings-v2-note-card">
            <strong>Gateway Status</strong>
            <div id="v2AprsGatewayStatusLine" class="settings-v2-inline-note">${escapeHtml(gatewayStatus)}</div>
            <div id="v2AprsGatewayPolicyLine" class="settings-v2-inline-note">${escapeHtml(gatewayPolicy)}</div>
            <div id="v2AprsGatewayErrorLine" class="settings-v2-inline-note ${aprsRuntime.igate_last_error ? "" : "hidden"}">${escapeHtml(aprsRuntime.igate_last_error ? `Last error: ${aprsRuntime.igate_last_error}` : "")}</div>
          </div>
        </article>

        <article class="card settings-v2-card">
          <h3>Audio And Position Adjustments</h3>
          <div class="settings-v2-form-grid">
            <label id="v2AprsAudioInputField">
              <span>Audio Input</span>
              <select id="v2AprsAudioInput"></select>
            </label>
            <label id="v2AprsAudioOutputField">
              <span>Audio Output</span>
              <select id="v2AprsAudioOutput"></select>
            </label>
            <label>
              <span>Latitude Offset (deg)</span>
              <input id="v2AprsPositionFudgeLat" type="number" min="-0.02" max="0.02" step="0.01" />
            </label>
            <label>
              <span>Longitude Offset (deg)</span>
              <input id="v2AprsPositionFudgeLon" type="number" min="-0.02" max="0.02" step="0.01" />
            </label>
          </div>
          <div class="settings-v2-inline-note">${escapeHtml(renderAudioNote(stateCache))}</div>
        </article>
      </div>

      <div class="settings-v2-stack ${viewState.activeAprsTab === "send" ? "" : "hidden"}" data-aprs-panel="send">
        <article class="card settings-v2-card">
          <div class="settings-v2-card-head">
            <h3>Send</h3>
            <div class="settings-v2-card-note" id="v2AprsTxStatus">${escapeHtml(targetSummary.status)}</div>
          </div>
          <div class="aprs-send-tabs" role="tablist" aria-label="APRS send action">
            <button id="v2AprsSendTabMessage" type="button" class="${viewState.aprsSendTab === "message" ? "active" : ""}">Message</button>
            <button id="v2AprsSendTabStatus" type="button" class="${viewState.aprsSendTab === "status" ? "active" : ""}">Status</button>
            <button id="v2AprsSendTabPosition" type="button" class="${viewState.aprsSendTab === "position" ? "active" : ""}">Position</button>
          </div>

          <div id="v2AprsSendMessagePanel" class="${viewState.aprsSendTab === "message" ? "" : "hidden"}">
            <div class="settings-v2-form-grid">
              <label>
                <span>Message To</span>
                <input id="v2AprsMessageTo" type="text" placeholder="VK4XYZ-7" />
              </label>
              <label class="settings-v2-span-2">
                <span>Message Text</span>
                <input id="v2AprsMessageBody" type="text" placeholder="Test from OrbitDeck" />
                <small id="v2AprsMessageCounter" class="aprs-counter"></small>
              </label>
            </div>
            <div class="settings-v2-section-actions">
              <button id="v2AprsSendMessage" type="button">Send Message</button>
            </div>
          </div>

          <div id="v2AprsSendStatusPanel" class="${viewState.aprsSendTab === "status" ? "" : "hidden"}">
            <div class="settings-v2-form-grid">
              <label class="settings-v2-span-2">
                <span>Status Text</span>
                <input id="v2AprsStatusBody" type="text" placeholder="IC-705 linked and monitoring." />
                <small id="v2AprsStatusCounter" class="aprs-counter"></small>
              </label>
            </div>
            <div class="settings-v2-section-actions">
              <button id="v2AprsSendStatus" type="button">Send Status</button>
            </div>
          </div>

          <div id="v2AprsSendPositionPanel" class="${viewState.aprsSendTab === "position" ? "" : "hidden"}">
            <div class="settings-v2-form-grid">
              <label class="settings-v2-span-2">
                <span>Position Comment</span>
                <input id="v2AprsPositionComment" type="text" placeholder="IC-705 over Wi-Fi" />
                <small id="v2AprsPositionCounter" class="aprs-counter"></small>
              </label>
            </div>
            <div id="v2AprsPositionPreview" class="settings-v2-note-card mono"></div>
            <div class="settings-v2-section-actions">
              <button id="v2AprsSendPosition" type="button">Send Position</button>
            </div>
          </div>
        </article>
      </div>

      <div class="settings-v2-stack ${viewState.activeAprsTab === "live-heard" ? "" : "hidden"}" data-aprs-panel="live-heard">
        <article class="card settings-v2-card">
          <div class="settings-v2-card-head">
            <h3>Live Heard</h3>
            <div class="settings-v2-card-note" id="v2AprsHeardMeta"></div>
          </div>
          <div class="aprs-last-grid">
            <article class="settings-v2-note-card">
              <strong>Last TX</strong>
              <div id="v2AprsLastTxCard" class="aprs-last-card">${escapeHtml(lastTx)}</div>
            </article>
            <article class="settings-v2-note-card">
              <strong>Last RX</strong>
              <div id="v2AprsLastRxCard" class="aprs-last-card">${escapeHtml(lastRx ? `${lastRx.source} | ${aprsClient.packetPreview(lastRx)}` : "No packets heard yet.")}</div>
            </article>
          </div>
          <div class="aprs-filter-chips">
            <button type="button" data-aprs-filter="all" class="${viewState.heardFilter === "all" ? "active" : ""}">All</button>
            <button type="button" data-aprs-filter="message" class="${viewState.heardFilter === "message" ? "active" : ""}">Messages</button>
            <button type="button" data-aprs-filter="position" class="${viewState.heardFilter === "position" ? "active" : ""}">Positions</button>
            <button type="button" data-aprs-filter="status" class="${viewState.heardFilter === "status" ? "active" : ""}">Status</button>
            <button type="button" data-aprs-filter="raw" class="${viewState.heardFilter === "raw" ? "active" : ""}">Raw</button>
          </div>
          <div id="v2AprsHeardList" class="aprs-heard-list"></div>
        </article>
      </div>

      <div class="settings-v2-stack ${viewState.activeAprsTab === "diagnostics" ? "" : "hidden"}" data-aprs-panel="diagnostics">
        <article class="card settings-v2-card">
          <h3>Derived Target</h3>
          <div class="settings-v2-inline-note" id="v2AprsTargetSummary">${escapeHtml(targetSummary.headline)}</div>
        </article>
        <article class="card settings-v2-card">
          <h3>Runtime State</h3>
          <div class="settings-v2-readonly-grid">
            <div><span>Connection</span><strong>${aprsRuntime.connected ? "Connected" : "Disconnected"}</strong></div>
            <div><span>Target</span><strong>${escapeHtml(aprsRuntime.target?.label || "--")}</strong></div>
            <div><span>Modem</span><strong>${escapeHtml(aprsRuntime.modem_state || "--")}</strong></div>
            <div><span>iGate Status</span><strong>${escapeHtml(aprsRuntime.igate_active ? (aprsRuntime.igate_status || "connecting") : "Inactive")}</strong></div>
            <div><span>iGate Server</span><strong>${escapeHtml(aprsRuntime.igate_server || "--")}</strong></div>
            <div><span>iGate Connected At</span><strong>${escapeHtml(aprsRuntime.igate_last_connect_at ? formatDateTime(aprsRuntime.igate_last_connect_at) : "--")}</strong></div>
            <div><span>iGate Auto-Enable</span><strong>${aprsRuntime.igate_auto_enabled ? "Yes" : "No"}</strong></div>
            <div><span>iGate Last Error</span><strong>${escapeHtml(aprsRuntime.igate_last_error || "None")}</strong></div>
            <div><span>Last Error</span><strong>${escapeHtml(aprsRuntime.last_error || "None")}</strong></div>
          </div>
          <div class="settings-v2-inline-note">${escapeHtml(aprsRuntime.igate_reason || targetSummary.status)}</div>
        </article>
      </div>

      <footer class="settings-v2-footer ${viewState.activeAprsTab === "configuration" ? "" : "hidden"}" data-aprs-footer>
        <div class="settings-v2-footer-state" data-dirty-badge>All changes saved</div>
        <div class="settings-v2-section-actions">
          <button type="button" data-discard-section="aprs">Discard Changes</button>
          <button type="button" id="v2SaveAprs">Save APRS Settings</button>
          <button type="button" id="v2AprsSelectTarget">Refresh Target</button>
        </div>
      </footer>
    </section>
  `;
}

function packetKey(packet) {
  return `${packet?.received_at || "--"}|${packet?.source || "--"}|${packet?.destination || "--"}|${packet?.raw_tnc2 || "--"}`;
}

export function maybeNotifyPackets(stateCache, viewState, trackerById) {
  const settings = stateCache.aprsLogSettings || {};
  const entries = stateCache.aprsLog.items || [];
  if (!viewState.notificationsReady) {
    for (const packet of entries) viewState.seenPacketKeys.add(packetKey(packet));
    viewState.notificationsReady = true;
    return;
  }
  const host = trackerById("v2AprsToastHost");
  for (const packet of [...entries].reverse()) {
    const key = packetKey(packet);
    if (viewState.seenPacketKeys.has(key)) continue;
    viewState.seenPacketKeys.add(key);
    if (!(packet.packet_type === "message" && settings.notify_incoming_messages) && !settings.notify_all_packets) continue;
    const toast = document.createElement("div");
    toast.className = "aprs-toast";
    toast.innerHTML = `<strong>${escapeHtml(packet.packet_type === "message" ? `APRS message from ${packet.source}` : `APRS ${packet.packet_type || "packet"} from ${packet.source}`)}</strong><div>${escapeHtml(aprsClient.packetPreview(packet))}</div>`;
    host.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }
}

function renderLiveHeard(stateCache, viewState) {
  const heard = filteredPackets(stateCache, viewState.heardFilter);
  document.getElementById("v2AprsHeardList").innerHTML = renderPacketRows("heard", heard, "No APRS packets in the current filter.");
  document.getElementById("v2AprsHeardMeta").textContent = `Showing ${heard.length} of the newest APRS packets.`;
}

function renderAprsChannels(stateCache) {
  const settings = stateCache.aprs.settings || {};
  const targets = stateCache.aprsTargets || { satellites: [], terrestrial: null };
  const satSelect = document.getElementById("v2AprsSatellite");
  const channelSelect = document.getElementById("v2AprsChannel");
  satSelect.innerHTML = (targets.satellites || []).map((item) => `<option value="${escapeHtml(item.sat_id)}">${escapeHtml(item.name)}</option>`).join("");
  if (settings.selected_satellite_id) satSelect.value = settings.selected_satellite_id;
  const selectedSat = (targets.satellites || []).find((item) => item.sat_id === satSelect.value) || (targets.satellites || [])[0] || null;
  const channels = selectedSat?.channels || [];
  channelSelect.innerHTML = channels.map((item) => `<option value="${escapeHtml(item.channel_id)}">${escapeHtml(`${item.label} | ${item.frequency_hz} Hz | ${item.mode}`)}</option>`).join("");
  if (settings.selected_channel_id && channels.some((item) => item.channel_id === settings.selected_channel_id)) {
    channelSelect.value = settings.selected_channel_id;
  }
}

function populateAudioSelect(select, items, selectedValue) {
  const values = Array.isArray(items) ? items : [];
  const selected = String(selectedValue || "").trim();
  const optionValues = values.map((item) => String(item.value || item.name || "").trim()).filter(Boolean);
  let resolved = selected;
  if (selected && !optionValues.includes(selected)) {
    const exactName = values.find((item) => String(item.name || "").trim() === selected);
    if (exactName) resolved = String(exactName.value || exactName.name || "").trim();
  }
  const options = [];
  if (resolved && !optionValues.includes(resolved)) options.push(`<option value="${escapeHtml(resolved)}">${escapeHtml(resolved)} · current</option>`);
  for (const item of values) {
    const name = String(item.name || "").trim();
    const value = String(item.value || item.name || "").trim();
    if (!name) continue;
    options.push(`<option value="${escapeHtml(value)}">${escapeHtml(name)}</option>`);
  }
  if (!options.length) options.push('<option value="default">System Default</option>');
  select.innerHTML = options.join("");
  select.value = resolved || values[0]?.value || values[0]?.name || "default";
}

function updatePositionPreview(stateCache) {
  const comment = document.getElementById("v2AprsPositionComment");
  const preview = document.getElementById("v2AprsPositionPreview");
  if (!comment || !preview) return;
  preview.textContent = aprsClient.buildPositionPreview(stateCache, comment.value);
}

function updateGatewayStatusPreview(stateCache) {
  const statusLine = document.getElementById("v2AprsGatewayStatusLine");
  if (!statusLine) return;
  statusLine.textContent = gatewayStatusText(stateCache, {
    digipeaterEnabled: document.getElementById("v2AprsFutureDigipeaterMain")?.checked,
    igateEnabled: document.getElementById("v2AprsFutureIgateMain")?.checked,
    server: document.getElementById("v2AprsIgateHostMain")?.value
      ? `${document.getElementById("v2AprsIgateHostMain").value}:${document.getElementById("v2AprsIgatePortMain")?.value || 14580}`
      : (stateCache.aprs.runtime?.igate_server || null),
  });
}

function showAprsTab(viewState, tab) {
  viewState.activeAprsTab = tab;
  document.querySelectorAll("[data-aprs-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.aprsTab === tab);
  });
  document.querySelectorAll("[data-aprs-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.aprsPanel !== tab);
  });
  const footer = document.querySelector("[data-aprs-footer]");
  if (footer) footer.classList.toggle("hidden", tab !== "configuration");
}

function showSendTab(viewState, tab) {
  viewState.aprsSendTab = tab;
  document.getElementById("v2AprsSendTabMessage").classList.toggle("active", tab === "message");
  document.getElementById("v2AprsSendTabStatus").classList.toggle("active", tab === "status");
  document.getElementById("v2AprsSendTabPosition").classList.toggle("active", tab === "position");
  document.getElementById("v2AprsSendMessagePanel").classList.toggle("hidden", tab !== "message");
  document.getElementById("v2AprsSendStatusPanel").classList.toggle("hidden", tab !== "status");
  document.getElementById("v2AprsSendPositionPanel").classList.toggle("hidden", tab !== "position");
}

export function bindAprsSection(ctx) {
  const settings = ctx.stateCache.aprs.settings || {};
  document.getElementById("v2AprsCallsign").value = settings.callsign || "N0CALL";
  document.getElementById("v2AprsSsid").value = settings.ssid ?? 10;
  document.getElementById("v2AprsListenOnly").value = String(!!settings.listen_only);
  document.getElementById("v2AprsTerrestrialPath").value = settings.terrestrial_path || "WIDE1-1,WIDE2-1";
  document.getElementById("v2AprsSatellitePath").value = settings.satellite_path || "ARISS";
  document.getElementById("v2AprsTerrestrialComment").value = settings.terrestrial_beacon_comment || settings.beacon_comment || "OrbitDeck APRS";
  document.getElementById("v2AprsSatelliteComment").value = settings.satellite_beacon_comment || settings.beacon_comment || "OrbitDeck Space APRS";
  document.getElementById("v2AprsPositionFudgeLat").value = Number(settings.position_fudge_lat_deg || 0).toFixed(2);
  document.getElementById("v2AprsPositionFudgeLon").value = Number(settings.position_fudge_lon_deg || 0).toFixed(2);
  document.getElementById("v2AprsTerrestrialFreq").value = settings.terrestrial_manual_frequency_hz || ctx.stateCache.aprsTargets.terrestrial?.suggested_frequency_hz || "";
  renderAprsChannels(ctx.stateCache);
  populateAudioSelect(document.getElementById("v2AprsAudioInput"), ctx.stateCache.audioDevices.inputs || [], settings.audio_input_device || "");
  populateAudioSelect(document.getElementById("v2AprsAudioOutput"), ctx.stateCache.audioDevices.outputs || [], settings.audio_output_device || "");
  document.getElementById("v2AprsRegionHint").textContent = ctx.stateCache.aprsTargets.terrestrial?.region_label
    ? `Suggested terrestrial APRS: ${ctx.stateCache.aprsTargets.terrestrial.region_label} | ${ctx.stateCache.aprsTargets.terrestrial.suggested_frequency_hz} Hz | PATH ${ctx.stateCache.aprsTargets.terrestrial.path_default || "--"}`
    : "No terrestrial APRS region suggestion available yet.";

  syncAprsModeDom(settings.operating_mode || "terrestrial");
  showAprsTab(ctx.viewState, ctx.viewState.activeAprsTab || "configuration");
  showSendTab(ctx.viewState, ctx.viewState.aprsSendTab || "message");
  updatePositionPreview(ctx.stateCache);
  renderLiveHeard(ctx.stateCache, ctx.viewState);
  aprsClient.bindCounter(document.getElementById("v2AprsMessageBody"), document.getElementById("v2AprsMessageCounter"), {});
  aprsClient.bindCounter(document.getElementById("v2AprsStatusBody"), document.getElementById("v2AprsStatusCounter"), {});
  aprsClient.bindCounter(document.getElementById("v2AprsPositionComment"), document.getElementById("v2AprsPositionCounter"), { hardLimit: 40, softLimit: 20 });

  const wifiManaged = aprsClient.isWifiManaged(ctx.stateCache.radio.settings || {});
  document.getElementById("v2AprsAudioInputField").classList.toggle("hidden", wifiManaged);
  document.getElementById("v2AprsAudioOutputField").classList.toggle("hidden", wifiManaged);
  document.getElementById("v2AprsGatewayAdvancedToggle").addEventListener("click", () => {
    ctx.viewState.aprsGatewayAdvanced = !ctx.viewState.aprsGatewayAdvanced;
    const panel = document.getElementById("v2AprsGatewayAdvanced");
    const button = document.getElementById("v2AprsGatewayAdvancedToggle");
    panel.classList.toggle("hidden", !ctx.viewState.aprsGatewayAdvanced);
    button.textContent = ctx.viewState.aprsGatewayAdvanced ? "Hide Advanced" : "Show Advanced";
    button.setAttribute("aria-expanded", ctx.viewState.aprsGatewayAdvanced ? "true" : "false");
  });

  document.querySelectorAll("[data-aprs-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      syncAprsModeDom(button.dataset.aprsMode);
      ctx.updateDirtyState("aprs");
    });
  });
  document.querySelectorAll("[data-aprs-tab]").forEach((button) => {
    button.addEventListener("click", () => showAprsTab(ctx.viewState, button.dataset.aprsTab));
  });
  document.getElementById("v2AprsSendTabMessage").addEventListener("click", () => showSendTab(ctx.viewState, "message"));
  document.getElementById("v2AprsSendTabStatus").addEventListener("click", () => showSendTab(ctx.viewState, "status"));
  document.getElementById("v2AprsSendTabPosition").addEventListener("click", () => showSendTab(ctx.viewState, "position"));
  document.getElementById("v2AprsSatellite").addEventListener("change", () => {
    renderAprsChannels(ctx.stateCache);
    ctx.updateDirtyState("aprs");
  });
  document.getElementById("v2AprsPositionComment").addEventListener("input", () => updatePositionPreview(ctx.stateCache));
  document.getElementById("v2AprsPositionFudgeLat").addEventListener("input", () => updatePositionPreview(ctx.stateCache));
  document.getElementById("v2AprsPositionFudgeLon").addEventListener("input", () => updatePositionPreview(ctx.stateCache));
  [
    "v2AprsFutureDigipeaterMain",
    "v2AprsFutureIgateMain",
    "v2AprsIgateHostMain",
    "v2AprsIgatePortMain",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => updateGatewayStatusPreview(ctx.stateCache));
    el.addEventListener("change", () => updateGatewayStatusPreview(ctx.stateCache));
  });
  updateGatewayStatusPreview(ctx.stateCache);

  document.querySelectorAll("[data-aprs-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      ctx.viewState.heardFilter = button.dataset.aprsFilter;
      document.querySelectorAll("[data-aprs-filter]").forEach((chip) => chip.classList.toggle("active", chip === button));
      renderLiveHeard(ctx.stateCache, ctx.viewState);
    });
  });

  document.getElementById("v2AprsConnectToggle").addEventListener("click", ctx.toggleAprsConnection);
  document.getElementById("v2AprsOpenInbox").addEventListener("click", () => {
    const drawer = document.getElementById("v2AprsDrawer");
    drawer.classList.remove("hidden");
    drawer.setAttribute("aria-hidden", "false");
  });
  document.getElementById("v2SaveAprs").addEventListener("click", ctx.saveAprsSection);
  document.getElementById("v2AprsSelectTarget").addEventListener("click", ctx.refreshAprsTarget);
  document.querySelector("[data-discard-section='aprs']").addEventListener("click", () => ctx.discardSection("aprs"));

  document.getElementById("v2AprsSendMessage").addEventListener("click", async () => {
    await ctx.runAction("POST /api/v1/aprs/send/message", () => ctx.trackerApi.post("/api/v1/aprs/send/message", {
      to: document.getElementById("v2AprsMessageTo").value,
      text: document.getElementById("v2AprsMessageBody").value,
    }));
    ctx.recordEvent("APRS message sent", document.getElementById("v2AprsMessageTo").value);
    await ctx.refreshState();
  });
  document.getElementById("v2AprsSendStatus").addEventListener("click", async () => {
    await ctx.runAction("POST /api/v1/aprs/send/status", () => ctx.trackerApi.post("/api/v1/aprs/send/status", {
      text: document.getElementById("v2AprsStatusBody").value,
    }));
    ctx.recordEvent("APRS status sent", document.getElementById("v2AprsStatusBody").value);
    await ctx.refreshState();
  });
  document.getElementById("v2AprsSendPosition").addEventListener("click", async () => {
    await ctx.runAction("POST /api/v1/aprs/send/position", () => ctx.trackerApi.post("/api/v1/aprs/send/position", {
      comment: document.getElementById("v2AprsPositionComment").value,
    }));
    ctx.recordEvent("APRS position sent", document.getElementById("v2AprsPositionComment").value);
    await ctx.refreshState();
  });

  document.getElementById("v2AprsHeardList").addEventListener("click", (event) => {
    const target = event.target.closest("[data-aprs-packet-index]");
    if (!target) return;
    const packets = filteredPackets(ctx.stateCache, ctx.viewState.heardFilter);
    const packet = packets[Number(target.dataset.aprsPacketIndex)] || null;
    if (!packet) return;
    ctx.viewState.detailPacket = packet;
    ctx.updateAprsDrawer();
  });
}

export function renderAprsDrawer({ stateCache, viewState }) {
  const allPackets = (stateCache.aprsLog.items || []).slice(0, 20);
  const messagePackets = (stateCache.aprsLog.items || []).filter((packet) => packet.packet_type === "message").slice(0, 20);
  const detail = viewState.detailPacket || allPackets[0] || null;
  return `
    <div id="v2AprsDrawer" class="aprs-drawer hidden" aria-hidden="true">
      <div class="aprs-drawer-backdrop" data-aprs-drawer-close></div>
      <section class="aprs-drawer-sheet">
        <div class="aprs-drawer-head">
          <div>
            <div class="label mono">APRS Inbox / Log</div>
            <h3>Recent Traffic And Local Storage</h3>
          </div>
          <button id="v2AprsCloseInbox" type="button">Close</button>
        </div>
        <div class="aprs-send-tabs" role="tablist" aria-label="APRS inbox tabs">
          <button type="button" data-aprs-drawer-tab="recent" class="${viewState.aprsDrawerTab === "recent" ? "active" : ""}">Recent</button>
          <button type="button" data-aprs-drawer-tab="messages" class="${viewState.aprsDrawerTab === "messages" ? "active" : ""}">Messages</button>
          <button type="button" data-aprs-drawer-tab="stored" class="${viewState.aprsDrawerTab === "stored" ? "active" : ""}">Stored Log</button>
        </div>
        <div id="v2AprsDrawerRecent" class="aprs-drawer-panel ${viewState.aprsDrawerTab === "recent" ? "" : "hidden"}">${renderPacketRows("drawer-recent", allPackets, "No recent APRS packets stored.")}</div>
        <div id="v2AprsDrawerMessages" class="aprs-drawer-panel ${viewState.aprsDrawerTab === "messages" ? "" : "hidden"}">${renderPacketRows("drawer-messages", messagePackets, "No APRS messages stored.")}</div>
        <div id="v2AprsDrawerStored" class="aprs-drawer-panel ${viewState.aprsDrawerTab === "stored" ? "" : "hidden"}">
          <div class="settings-v2-toggle-grid">
            <label class="settings-v2-toggle"><input id="v2AprsLogEnabled" type="checkbox" ${stateCache.aprsLogSettings.log_enabled ? "checked" : ""} /> <span>Store received APRS locally</span></label>
            <label class="settings-v2-toggle"><input id="v2AprsNotifyMessages" type="checkbox" ${stateCache.aprsLogSettings.notify_incoming_messages !== false ? "checked" : ""} /> <span>Notify of incoming APRS messages</span></label>
            <label class="settings-v2-toggle"><input id="v2AprsNotifyAllPackets" type="checkbox" ${stateCache.aprsLogSettings.notify_all_packets ? "checked" : ""} /> <span>Notify for all heard packets</span></label>
          </div>
          <div class="settings-v2-form-grid">
            <label>
              <span>Max Stored Records</span>
              <select id="v2AprsLogMaxRecords">
                ${[100, 500, 1000, 5000].map((value) => `<option value="${value}" ${Number(stateCache.aprsLogSettings.log_max_records || 500) === value ? "selected" : ""}>${value}</option>`).join("")}
              </select>
            </label>
            <label>
              <span>Clear Older Than</span>
              <select id="v2AprsClearAge">
                ${["7d", "30d", "90d", "all"].map((value) => `<option value="${value}">${value === "all" ? "Everything" : value.replace("d", " days")}</option>`).join("")}
              </select>
            </label>
          </div>
          <div class="settings-v2-actions">
            <button id="v2AprsSaveLogSettings" type="button">Save Log Settings</button>
            <button id="v2AprsExportCsv" type="button">Export CSV</button>
            <button id="v2AprsExportJson" type="button">Export JSON</button>
            <button id="v2AprsClearLog" type="button">Clear Stored Log</button>
          </div>
        </div>
        <pre id="v2AprsPacketDetail" class="mono settings-v2-runtime-log">${escapeHtml(detail ? pretty(detail) : "Select a packet row for details.")}</pre>
      </section>
    </div>
  `;
}

export function bindAprsDrawer(ctx) {
  const drawer = document.getElementById("v2AprsDrawer");
  if (!drawer) return;
  document.getElementById("v2AprsCloseInbox").addEventListener("click", () => {
    ctx.viewState.aprsDrawerDirty = false;
    drawer.classList.add("hidden");
    drawer.setAttribute("aria-hidden", "true");
  });
  drawer.querySelector("[data-aprs-drawer-close]").addEventListener("click", () => {
    ctx.viewState.aprsDrawerDirty = false;
    drawer.classList.add("hidden");
    drawer.setAttribute("aria-hidden", "true");
  });
  drawer.querySelectorAll("[data-aprs-drawer-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      ctx.viewState.aprsDrawerTab = button.dataset.aprsDrawerTab;
      ctx.updateAprsDrawer();
      document.getElementById("v2AprsDrawer").classList.remove("hidden");
      document.getElementById("v2AprsDrawer").setAttribute("aria-hidden", "false");
    });
  });
  const bindPacketRows = (id, packets) => {
    const host = document.getElementById(id);
    if (!host) return;
    host.addEventListener("click", (event) => {
      const row = event.target.closest("[data-aprs-packet-index]");
      if (!row) return;
      ctx.viewState.detailPacket = packets[Number(row.dataset.aprsPacketIndex)] || null;
      ctx.updateAprsDrawer();
      document.getElementById("v2AprsDrawer").classList.remove("hidden");
      document.getElementById("v2AprsDrawer").setAttribute("aria-hidden", "false");
    });
  };
  bindPacketRows("v2AprsDrawerRecent", (ctx.stateCache.aprsLog.items || []).slice(0, 20));
  bindPacketRows("v2AprsDrawerMessages", (ctx.stateCache.aprsLog.items || []).filter((packet) => packet.packet_type === "message").slice(0, 20));

  drawer.querySelectorAll("input, select, textarea").forEach((el) => {
    el.addEventListener("input", () => {
      ctx.viewState.aprsDrawerDirty = true;
    });
    el.addEventListener("change", () => {
      ctx.viewState.aprsDrawerDirty = true;
    });
  });

  const save = document.getElementById("v2AprsSaveLogSettings");
  if (save) save.addEventListener("click", ctx.saveAprsLogSettingsSection);
  const csv = document.getElementById("v2AprsExportCsv");
  if (csv) csv.addEventListener("click", () => window.open(aprsClient.exportUrl("csv"), "_blank", "noopener,noreferrer"));
  const json = document.getElementById("v2AprsExportJson");
  if (json) json.addEventListener("click", () => window.open(aprsClient.exportUrl("json"), "_blank", "noopener,noreferrer"));
  const clear = document.getElementById("v2AprsClearLog");
  if (clear) {
    clear.addEventListener("click", async () => {
      ctx.viewState.aprsDrawerDirty = false;
      await ctx.runAction("POST /api/v1/aprs/log/clear", () => ctx.trackerApi.post("/api/v1/aprs/log/clear", { age_bucket: document.getElementById("v2AprsClearAge").value }));
      ctx.recordEvent("APRS log cleared", document.getElementById("v2AprsClearAge").value);
      await ctx.refreshState();
      document.getElementById("v2AprsDrawer").classList.remove("hidden");
      document.getElementById("v2AprsDrawer").setAttribute("aria-hidden", "false");
    });
  }
}

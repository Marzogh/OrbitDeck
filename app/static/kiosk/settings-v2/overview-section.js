import { escapeHtml, getTrackedSatelliteId } from "./shared.js";

export function renderOverviewSection({ stateCache, buildWarnings, locationSummary, transportSummary }) {
  const radioSettings = stateCache.radio.settings || {};
  const radioRuntime = stateCache.radio.runtime || {};
  const aprsRuntime = stateCache.aprs.runtime || {};
  const aprsSettings = stateCache.aprs.settings || {};
  const trackedSat = stateCache.satellites.find((sat) => sat.sat_id === getTrackedSatelliteId()) || null;
  const passFilter = stateCache.system.passFilter || {};
  const warnings = buildWarnings();

  return `
    <section class="settings-v2-screen">
      <header class="settings-v2-screen-head">
        <div>
          <div class="label mono">Overview</div>
          <h2>Current system status</h2>
          <p>Use this page to confirm the radio connection, kiosk target, display state, and APRS readiness before editing anything.</p>
        </div>
      </header>

      <div class="settings-v2-card-grid">
        <article class="card settings-v2-card">
          <div class="label mono">Radio Connection</div>
          <h3>${radioRuntime.connected ? "Connected" : "Disconnected"}</h3>
          <p>${escapeHtml(transportSummary(radioSettings, radioRuntime))}</p>
        </article>
        <article class="card settings-v2-card">
          <div class="label mono">Location</div>
          <h3>${escapeHtml(stateCache.location.state?.source_mode || "--")}</h3>
          <p>${escapeHtml(locationSummary(stateCache.location))}</p>
        </article>
        <article class="card settings-v2-card">
          <div class="label mono">Satellite Tracking</div>
          <h3>${escapeHtml(trackedSat?.name || "No satellite selected")}</h3>
          <p>${escapeHtml(passFilter.profile || "IssOnly")}</p>
        </article>
        <article class="card settings-v2-card">
          <div class="label mono">Display</div>
          <h3>${escapeHtml(stateCache.system.issDisplayMode?.mode || "--")}</h3>
          <p>${escapeHtml(stateCache.system.timezone?.timezone || "UTC")}</p>
        </article>
        <article class="card settings-v2-card">
          <div class="label mono">APRS</div>
          <h3>${aprsRuntime.connected ? "Connected" : "Disconnected"}</h3>
          <p>${escapeHtml(aprsRuntime.target?.label || aprsSettings.operating_mode || "No target selected")}</p>
        </article>
        <article class="card settings-v2-card">
          <div class="label mono">Attention</div>
          <div class="settings-v2-warning-list">
            ${warnings.map((warning) => `
              <div class="settings-v2-warning-row">
                <strong>${escapeHtml(warning.title)}</strong>
                <span>${escapeHtml(warning.detail)}</span>
              </div>
            `).join("") || '<div class="settings-v2-runtime-empty">No active warnings.</div>'}
          </div>
        </article>
      </div>

      <div class="settings-v2-section-actions">
        <button type="button" data-open-section="radio">Open Radio</button>
        <button type="button" data-open-section="tracking">Open Satellite Tracking</button>
        <button type="button" data-open-section="aprs">Open APRS</button>
      </div>
    </section>
  `;
}

export function bindOverviewSection(ctx) {
  for (const button of document.querySelectorAll("[data-open-section]")) {
    button.addEventListener("click", () => ctx.setActiveSection(button.dataset.openSection));
  }
}

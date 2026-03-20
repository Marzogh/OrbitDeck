import { escapeHtml } from "./shared.js";

export function renderLocationSection({ stateCache, locationSummary }) {
  const locationState = stateCache.location.state || {};
  const resolved = locationState.resolved_location
    || locationState.browser_location
    || locationState.gps_location
    || locationState.manual_location
    || null;
  return `
    <section class="settings-v2-screen">
      <header class="settings-v2-screen-head">
        <div>
          <div class="label mono">Location</div>
          <h2>Source for pass predictions</h2>
          <p>Choose the location source used to derive terrestrial APRS defaults and pass predictions.</p>
        </div>
        <span class="settings-v2-summary-pill">${escapeHtml(locationState.source_mode || "--")}</span>
      </header>

      <div data-dirty-scope="location" class="settings-v2-stack">
        <article class="card settings-v2-card">
          <h3>Location Source</h3>
          <div class="settings-v2-form-grid">
            <label>
              <span>Location Source</span>
              <select id="v2LocationMode">
                <option value="browser">System Location</option>
                <option value="gps">GPS</option>
                <option value="manual">Manual Coordinates</option>
                <option value="auto">Auto</option>
              </select>
            </label>
          </div>
        </article>

        <article class="card settings-v2-card">
          <h3>Resolved Location</h3>
          <div class="settings-v2-readonly-grid">
            <div><span>Source</span><strong>${escapeHtml(locationState.source_mode || "--")}</strong></div>
            <div><span>Summary</span><strong>${escapeHtml(locationSummary(stateCache.location))}</strong></div>
            <div><span>Latitude</span><strong>${escapeHtml(resolved?.lat != null ? String(resolved.lat) : "--")}</strong></div>
            <div><span>Longitude</span><strong>${escapeHtml(resolved?.lon != null ? String(resolved.lon) : "--")}</strong></div>
          </div>
        </article>

        <article class="card settings-v2-card hidden" id="v2ManualLocationCard">
          <h3>Manual Coordinates</h3>
          <div class="settings-v2-form-grid">
            <label>
              <span>Latitude</span>
              <input id="v2ManualLat" type="number" step="0.000001" placeholder="-27.470125" />
            </label>
            <label>
              <span>Longitude</span>
              <input id="v2ManualLon" type="number" step="0.000001" placeholder="153.021072" />
            </label>
          </div>
        </article>

        <article class="card settings-v2-card hidden" id="v2GpsLocationCard">
          <h3>GPS Coordinates</h3>
          <div class="settings-v2-form-grid">
            <label>
              <span>Latitude</span>
              <input id="v2GpsLat" type="number" step="0.000001" placeholder="-27.470125" />
            </label>
            <label>
              <span>Longitude</span>
              <input id="v2GpsLon" type="number" step="0.000001" placeholder="153.021072" />
            </label>
          </div>
        </article>
      </div>

      <article class="card settings-v2-card">
        <h3>Effects</h3>
        <div class="settings-v2-inline-note">Location affects pass prediction timing and regional terrestrial APRS suggestions. It does not change the radio connection profile.</div>
      </article>

      <footer class="settings-v2-footer">
        <div class="settings-v2-footer-state" data-dirty-badge>All changes saved</div>
        <div class="settings-v2-section-actions">
          <button type="button" data-discard-section="location">Discard Changes</button>
          <button type="button" data-save-location>Save Location</button>
        </div>
      </footer>
    </section>
  `;
}

export function bindLocationSection(ctx) {
  const locationState = ctx.stateCache.location.state || {};
  const mode = document.getElementById("v2LocationMode");
  const manualCard = document.getElementById("v2ManualLocationCard");
  const gpsCard = document.getElementById("v2GpsLocationCard");
  mode.value = locationState.source_mode || "browser";
  if (locationState.manual_location) {
    document.getElementById("v2ManualLat").value = locationState.manual_location.lat ?? "";
    document.getElementById("v2ManualLon").value = locationState.manual_location.lon ?? "";
  }
  if (locationState.gps_location) {
    document.getElementById("v2GpsLat").value = locationState.gps_location.lat ?? "";
    document.getElementById("v2GpsLon").value = locationState.gps_location.lon ?? "";
  }

  const sync = () => {
    manualCard.classList.toggle("hidden", mode.value !== "manual");
    gpsCard.classList.toggle("hidden", mode.value !== "gps");
  };
  mode.addEventListener("change", sync);
  sync();

  document.querySelector("[data-save-location]").addEventListener("click", ctx.saveLocationSection);
  document.querySelector("[data-discard-section='location']").addEventListener("click", () => ctx.discardSection("location"));
}

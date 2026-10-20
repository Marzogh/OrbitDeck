import { escapeHtml } from "./shared.js";

export function renderLocationSection({ stateCache, locationSummary }) {
  const locationState = stateCache.location.state || {};
  const resolved = stateCache.location.resolved;
  return `
    <section class="settings-v2-screen">
      <header class="settings-v2-screen-head">
        <div>
          <div class="label mono">Location</div>
          <h2>Source for pass predictions</h2>
          <p>Fresh radio GPS takes priority, followed by this device. Manual coordinates provide an explicit fallback. Browsing observers do not change the station.</p>
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
            <div><span>Source</span><strong>${escapeHtml(resolved?.source || "unavailable")}</strong></div>
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
          <h3>Radio GPS</h3><p>Read automatically from a connected supported radio. Entered coordinates belong under Manual Coordinates.</p>

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
  const manual = (locationState.profiles || []).find((profile) => profile.id === locationState.selected_profile_id)?.point;
  if (manual) {
    document.getElementById("v2ManualLat").value = manual.lat ?? "";
    document.getElementById("v2ManualLon").value = manual.lon ?? "";
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

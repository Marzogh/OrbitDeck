import { escapeHtml, getTrackedSatelliteId } from "./shared.js";

export function renderTrackingSection({ stateCache }) {
  const trackedId = getTrackedSatelliteId();
  const tracked = stateCache.satellites.find((sat) => sat.sat_id === trackedId) || null;
  const passFilter = stateCache.system.passFilter || {};
  return `
    <section class="settings-v2-screen">
      <header class="settings-v2-screen-head">
        <div>
          <div class="label mono">Satellite Tracking</div>
          <h2>Kiosk target and pass profile</h2>
          <p>Choose which satellite stays on this kiosk and which pass profile defines the wider selection policy.</p>
        </div>
        <div class="settings-v2-status-cluster">
          <span class="settings-v2-summary-pill">${escapeHtml(tracked?.name || "No satellite selected")}</span>
          <span class="settings-v2-summary-pill">${escapeHtml(passFilter.profile || "IssOnly")}</span>
        </div>
      </header>

      <div data-dirty-scope="tracking" class="settings-v2-stack">
        <article class="card settings-v2-card">
          <h3>Active Tracking</h3>
          <div class="settings-v2-form-grid">
            <label>
              <span>Tracked Satellite</span>
              <select id="v2TrackedSatellite"></select>
            </label>
            <label>
              <span>Pass Profile</span>
              <select id="v2PassProfile">
                <option value="IssOnly">ISS Only</option>
                <option value="Favorites">Favorites</option>
              </select>
            </label>
          </div>
        </article>

        <article class="card settings-v2-card">
          <div class="settings-v2-card-head">
            <h3>Favorites</h3>
            <input id="v2TrackingSearch" type="search" placeholder="Filter favorites" class="settings-v2-inline-search" data-transient="1" />
          </div>
          <div id="v2TrackingFavorites" class="settings-v2-checklist"></div>
        </article>
      </div>

      <article class="card settings-v2-card">
        <h3>Tracking Scope</h3>
        <div class="settings-v2-inline-note">Tracked satellite is saved for this kiosk only. Pass profile favorites remain part of the shared settings model.</div>
      </article>

      <footer class="settings-v2-footer">
        <div class="settings-v2-footer-state" data-dirty-badge>All changes saved</div>
        <div class="settings-v2-section-actions">
          <button type="button" data-discard-section="tracking">Discard Changes</button>
          <button type="button" data-save-tracking>Save Tracking</button>
        </div>
      </footer>
    </section>
  `;
}

export function bindTrackingSection(ctx) {
  const passFilter = ctx.stateCache.system.passFilter || {};
  const trackedSatellite = document.getElementById("v2TrackedSatellite");
  const passProfile = document.getElementById("v2PassProfile");
  const search = document.getElementById("v2TrackingSearch");
  const favoritesHost = document.getElementById("v2TrackingFavorites");
  const satellites = ctx.stateCache.satellites.filter(ctx.isHamFrequencySatellite);

  trackedSatellite.innerHTML = satellites.map((sat) => `<option value="${escapeHtml(sat.sat_id)}">${escapeHtml(sat.name)}</option>`).join("");
  trackedSatellite.value = satellites.some((sat) => sat.sat_id === getTrackedSatelliteId()) ? getTrackedSatelliteId() : (satellites[0]?.sat_id || "");
  passProfile.value = passFilter.profile || "IssOnly";

  favoritesHost.innerHTML = satellites.map((sat) => `
    <label class="settings-v2-check-row" data-searchable-text="${escapeHtml(`${sat.name} ${sat.norad_id || ""}`.toLowerCase())}">
      <input type="checkbox" data-pass-favorite value="${escapeHtml(sat.sat_id)}" ${(passFilter.satIds || ["iss-zarya"]).includes(sat.sat_id) ? "checked" : ""} />
      <span>${escapeHtml(sat.name)} <small>${escapeHtml(String(sat.norad_id || ""))}</small></span>
    </label>
  `).join("");
  search.addEventListener("input", () => {
    const query = String(search.value || "").trim().toLowerCase();
    favoritesHost.querySelectorAll("[data-searchable-text]").forEach((row) => {
      row.style.display = query && !row.dataset.searchableText.includes(query) ? "none" : "";
    });
  });

  document.querySelector("[data-save-tracking]").addEventListener("click", ctx.saveTrackingSection);
  document.querySelector("[data-discard-section='tracking']").addEventListener("click", () => ctx.discardSection("tracking"));
}

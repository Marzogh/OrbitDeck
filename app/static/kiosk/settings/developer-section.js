import { escapeHtml, getDevModeSelection } from "./shared.js";

export function renderDeveloperSection({ stateCache }) {
  return `
    <section class="settings-v2-screen">
      <header class="settings-v2-screen-head">
        <div>
          <div class="label mono">Developer</div>
          <h2>Diagnostics and maintenance</h2>
          <p>Keep debug-only controls separate from the operator workflow.</p>
        </div>
      </header>

      <div data-dirty-scope="developer" class="settings-v2-stack">
        <article class="card settings-v2-card">
          <h3>Diagnostics</h3>
          <div class="settings-v2-form-grid">
            <label>
              <span>Developer Mode</span>
              <select id="v2DevModeSelection">
                <option value="disabled">Disabled</option>
                <option value="auto">Auto</option>
                <option value="ongoing">Fake live pass</option>
                <option value="upcoming">Upcoming pass</option>
                <option value="iss-upcoming">ISS upcoming</option>
                <option value="passes">Passes console</option>
                <option value="radio">Radio ops</option>
                <option value="video">Video</option>
              </select>
            </label>
          </div>
          <div class="settings-v2-inline-note">
            Disabled clears the kiosk override keys. Fake live pass matches the documented console shortcut and synthesizes a mid-pass view when needed.
          </div>
        </article>
      </div>

      <article class="card settings-v2-card">
        <h3>Maintenance</h3>
        <div class="settings-v2-inline-note">Cache policy: ${escapeHtml(JSON.stringify(stateCache.system.cachePolicy || {}))}</div>
        <div class="settings-v2-section-actions">
          <button type="button" id="v2RefreshPassCache">Refresh Pass Cache</button>
          <button type="button" id="v2RefreshPage">Refresh Page State</button>
        </div>
      </article>
      <footer class="settings-v2-footer">
        <div class="settings-v2-footer-state" data-dirty-badge>All changes saved</div>
        <div class="settings-v2-section-actions">
          <button type="button" data-discard-section="developer">Discard Changes</button>
          <button type="button" data-save-developer>Save Developer Settings</button>
        </div>
      </footer>
    </section>
  `;
}

export function bindDeveloperSection(ctx) {
  document.getElementById("v2DevModeSelection").value = getDevModeSelection();
  document.querySelector("[data-save-developer]").addEventListener("click", ctx.saveDeveloperSection);
  document.querySelector("[data-discard-section='developer']").addEventListener("click", () => ctx.discardSection("developer"));
  document.getElementById("v2RefreshPassCache").addEventListener("click", async () => {
    await ctx.trackerApi.post("/api/v1/passes/cache/refresh", {});
    ctx.recordEvent("Pass cache refreshed", "Derived pass cache invalidated.");
    await ctx.refreshState();
  });
  document.getElementById("v2RefreshPage").addEventListener("click", ctx.refreshState);
}

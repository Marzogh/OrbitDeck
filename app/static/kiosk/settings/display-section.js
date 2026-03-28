import {
  escapeHtml,
  loadVideoSourceSelections,
  resolveDisplayTimezoneChoice,
  resolveVideoSourceSelection,
} from "./shared.js";

function validateSource(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function renderDisplaySection({ stateCache, viewState }) {
  const validation = viewState.displayValidation || {};
  return `
    <section class="settings-v2-screen">
      <header class="settings-v2-screen-head">
        <div>
          <div class="label mono">Display</div>
          <h2>Kiosk presentation setup</h2>
          <p>Configure the audience-facing scene, timezone, and fallback video sources.</p>
        </div>
        <span class="settings-v2-summary-pill">${escapeHtml(stateCache.system.issDisplayMode?.mode || "--")}</span>
      </header>

      <div data-dirty-scope="display" class="settings-v2-stack">
        <article class="card settings-v2-card">
          <h3>Presentation Mode</h3>
          <div class="settings-v2-form-grid">
            <label>
              <span>ISS Display Mode</span>
              <select id="v2IssMode">
                <option value="SunlitOnlyVideo">Video: ISS Sunlit</option>
                <option value="SunlitAndVisibleVideo">Video: Sunlit + Above Horizon</option>
                <option value="TelemetryOnly">Telemetry Only</option>
              </select>
            </label>
            <label>
              <span>Display Timezone</span>
              <select id="v2DisplayTimezone"></select>
            </label>
          </div>
        </article>

        <article class="card settings-v2-card">
          <div class="settings-v2-card-head">
            <h3>Primary Video Source</h3>
            <div class="settings-v2-card-note">${escapeHtml(validation.primary || "Untested")}</div>
          </div>
          <div class="settings-v2-form-grid">
            <label>
              <span>Source Choice</span>
              <select id="v2VideoSourcePrimaryMode">
                <option value="default_primary">OrbitDeck Default Primary</option>
                <option value="default_secondary">OrbitDeck Default Secondary</option>
                <option value="custom">Custom URL</option>
              </select>
            </label>
            <label class="settings-v2-span-2">
              <span>Resolved Source</span>
              <input id="v2VideoSourcePrimaryResolved" type="text" readonly data-transient="1" />
            </label>
            <label class="settings-v2-span-2 hidden" id="v2VideoSourcePrimaryCustomField">
              <span>Custom URL</span>
              <input id="v2VideoSourcePrimary" type="text" placeholder="https://www.youtube.com/embed/..." />
            </label>
          </div>
          <div class="settings-v2-section-actions">
            <button type="button" data-validate-source="primary">Validate Source</button>
            <button type="button" data-preview-source="primary">Preview Source</button>
          </div>
        </article>

        <article class="card settings-v2-card">
          <div class="settings-v2-card-head">
            <h3>Secondary Video Source</h3>
            <div class="settings-v2-card-note">${escapeHtml(validation.secondary || "Optional")}</div>
          </div>
          <div class="settings-v2-form-grid">
            <label>
              <span>Source Choice</span>
              <select id="v2VideoSourceSecondaryMode">
                <option value="default_secondary">OrbitDeck Default Secondary</option>
                <option value="default_primary">OrbitDeck Default Primary</option>
                <option value="custom">Custom URL</option>
              </select>
            </label>
            <label class="settings-v2-span-2">
              <span>Resolved Source</span>
              <input id="v2VideoSourceSecondaryResolved" type="text" readonly data-transient="1" />
            </label>
            <label class="settings-v2-span-2 hidden" id="v2VideoSourceSecondaryCustomField">
              <span>Custom URL</span>
              <input id="v2VideoSourceSecondary" type="text" placeholder="https://www.youtube.com/embed/... (optional)" />
            </label>
          </div>
          <div class="settings-v2-section-actions">
            <button type="button" data-validate-source="secondary">Validate Source</button>
            <button type="button" data-preview-source="secondary">Preview Source</button>
          </div>
        </article>
      </div>

      <article class="card settings-v2-card">
        <h3>Display Summary</h3>
        <div class="settings-v2-inline-note">Display mode and timezone are saved in the backend. Video source URLs stay local to this kiosk browser session.</div>
      </article>

      <footer class="settings-v2-footer">
        <div class="settings-v2-footer-state" data-dirty-badge>All changes saved</div>
        <div class="settings-v2-section-actions">
          <button type="button" data-discard-section="display">Discard Changes</button>
          <button type="button" data-save-display>Save Display Settings</button>
        </div>
      </footer>
    </section>
  `;
}

export function bindDisplaySection(ctx) {
  const selections = loadVideoSourceSelections();
  const mode = document.getElementById("v2IssMode");
  const timezone = document.getElementById("v2DisplayTimezone");
  const primaryMode = document.getElementById("v2VideoSourcePrimaryMode");
  const primary = document.getElementById("v2VideoSourcePrimary");
  const primaryResolved = document.getElementById("v2VideoSourcePrimaryResolved");
  const primaryCustomField = document.getElementById("v2VideoSourcePrimaryCustomField");
  const secondaryMode = document.getElementById("v2VideoSourceSecondaryMode");
  const secondary = document.getElementById("v2VideoSourceSecondary");
  const secondaryResolved = document.getElementById("v2VideoSourceSecondaryResolved");
  const secondaryCustomField = document.getElementById("v2VideoSourceSecondaryCustomField");
  mode.value = ctx.stateCache.system.issDisplayMode?.mode || "SunlitOnlyVideo";
  ctx.ensureTimezoneSelector(timezone, ctx.stateCache.timezones);
  timezone.value = resolveDisplayTimezoneChoice(ctx.stateCache.system.timezone?.timezone || "BrowserLocal");
  primaryMode.value = selections.primary.mode;
  primary.value = selections.primary.url || "";
  secondaryMode.value = selections.secondary.mode;
  secondary.value = selections.secondary.url || "";

  const syncSourceFields = () => {
    const primarySelection = { mode: primaryMode.value, url: primary.value };
    const secondarySelection = { mode: secondaryMode.value, url: secondary.value };
    primaryResolved.value = resolveVideoSourceSelection(primarySelection);
    secondaryResolved.value = resolveVideoSourceSelection(secondarySelection);
    primaryCustomField.classList.toggle("hidden", primaryMode.value !== "custom");
    secondaryCustomField.classList.toggle("hidden", secondaryMode.value !== "custom");
  };
  primaryMode.addEventListener("change", syncSourceFields);
  secondaryMode.addEventListener("change", syncSourceFields);
  primary.addEventListener("input", syncSourceFields);
  secondary.addEventListener("input", syncSourceFields);
  syncSourceFields();

  for (const button of document.querySelectorAll("[data-validate-source]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.validateSource;
      const resolved = key === "primary"
        ? resolveVideoSourceSelection({ mode: primaryMode.value, url: primary.value })
        : resolveVideoSourceSelection({ mode: secondaryMode.value, url: secondary.value });
      ctx.viewState.displayValidation[key] = validateSource(resolved) ? "Reachable format" : "Invalid URL format";
      ctx.recordEvent("Display source checked", `${key}: ${ctx.viewState.displayValidation[key]}`);
      const note = button.closest(".settings-v2-card")?.querySelector(".settings-v2-card-note");
      if (note) note.textContent = ctx.viewState.displayValidation[key];
    });
  }

  for (const button of document.querySelectorAll("[data-preview-source]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.previewSource;
      const resolved = key === "primary"
        ? resolveVideoSourceSelection({ mode: primaryMode.value, url: primary.value })
        : resolveVideoSourceSelection({ mode: secondaryMode.value, url: secondary.value });
      if (!resolved) return;
      window.open(resolved, "_blank", "noopener,noreferrer");
    });
  }

  document.querySelector("[data-save-display]").addEventListener("click", ctx.saveDisplaySection);
  document.querySelector("[data-discard-section='display']").addEventListener("click", () => ctx.discardSection("display"));
}

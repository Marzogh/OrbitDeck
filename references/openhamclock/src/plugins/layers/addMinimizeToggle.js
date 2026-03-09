const _controllers = {};

export function addMinimizeToggle(element, storageKey, options = {}) {
  if (!element) return;

  const {
    contentClassName = 'panel-content',
    buttonClassName = 'panel-minimize-btn',
    titleColor = '#00b4ff',
    getIsMinimized,
    onToggle,
    persist = true,
    manageButtonEvents = true,
  } = options;

  const minimizeKey = `${storageKey}-minimized`;
  const controllerKey = `${storageKey}:${buttonClassName}`;
  if (_controllers[controllerKey]) {
    _controllers[controllerKey].abort();
  }
  const controller = new AbortController();
  const { signal } = controller;
  _controllers[controllerKey] = controller;

  const header = element.firstElementChild;
  if (!header) return;

  const existingTitle = header.querySelector('[data-drag-handle="true"]');
  const existingButton = header.querySelector(`.${buttonClassName}`);
  const existingWrapper = element.querySelector(`.${contentClassName}`);

  if (existingTitle) {
    existingTitle.style.fontFamily = "'JetBrains Mono', monospace";
    existingTitle.style.fontSize = '13px';
    existingTitle.style.fontWeight = '700';
    existingTitle.style.color = titleColor;
  }

  const readState = () => {
    if (typeof getIsMinimized === 'function') return !!getIsMinimized();
    return localStorage.getItem(minimizeKey) === 'true';
  };

  const writeState = (next) => {
    if (typeof onToggle === 'function') onToggle(next);
    if (persist) localStorage.setItem(minimizeKey, String(next));
  };

  const syncState = (button, wrapper) => {
    const isMinimized = readState();
    wrapper.style.display = isMinimized ? 'none' : 'block';
    button.innerHTML = isMinimized ? '▶' : '▼';
    element.style.cursor = isMinimized ? 'pointer' : 'default';
  };

  if (existingButton && existingWrapper) {
    if (manageButtonEvents) {
      existingButton.addEventListener(
        'mousedown',
        (e) => {
          e.stopPropagation();
        },
        { signal },
      );
      existingButton.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          const next = existingWrapper.style.display !== 'none';
          existingWrapper.style.display = next ? 'none' : 'block';
          existingButton.innerHTML = next ? '▶' : '▼';
          element.style.cursor = next ? 'pointer' : 'default';
          writeState(next);
        },
        { signal },
      );
    }
    syncState(existingButton, existingWrapper);
    return;
  }

  const content = Array.from(element.children).slice(1);
  const contentWrapper = document.createElement('div');
  contentWrapper.className = contentClassName;
  content.forEach((child) => contentWrapper.appendChild(child));
  element.appendChild(contentWrapper);

  const minimizeBtn = document.createElement('button');
  minimizeBtn.className = buttonClassName;
  minimizeBtn.innerHTML = '▼';
  minimizeBtn.style.cssText = `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    min-width: 16px;
    height: 16px;
    background: none;
    border: none;
    color: #888;
    cursor: pointer;
    user-select: none;
    padding: 2px 4px;
    margin: 0;
    font-size: 10px;
    line-height: 1;
  `;
  minimizeBtn.title = 'Minimize/Maximize';
  minimizeBtn.addEventListener(
    'mousedown',
    (e) => {
      e.stopPropagation();
    },
    { signal },
  );

  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';

  const title = document.createElement('span');
  title.textContent = header.textContent.replace(/[▼▶]/g, '').trim();
  title.dataset.dragHandle = 'true';
  title.style.flex = '1';
  title.style.cursor = 'grab';
  title.style.userSelect = 'none';
  title.style.fontFamily = "'JetBrains Mono', monospace";
  title.style.fontSize = '13px';
  title.style.fontWeight = '700';
  title.style.color = titleColor;

  header.textContent = '';
  header.appendChild(title);
  header.appendChild(minimizeBtn);

  syncState(minimizeBtn, contentWrapper);

  minimizeBtn.addEventListener(
    'click',
    (e) => {
      e.stopPropagation();
      const hidden = contentWrapper.style.display === 'none';
      contentWrapper.style.display = hidden ? 'block' : 'none';
      minimizeBtn.innerHTML = hidden ? '▼' : '▶';
      element.style.cursor = hidden ? 'default' : 'pointer';
      writeState(!hidden);
    },
    { signal },
  );
}

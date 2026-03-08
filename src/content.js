(() => {
  const RESULT_SELECTOR = '.gs_r.gs_or.gs_scl';
  const CITE_LABEL = 'Cite';
  const BUTTON_CLASS = 'super-cite-btn';
  const BUILTIN_FORMATS = ['apa', 'mla', 'chicago', 'ieee', 'gbt7714_numeric', 'gbt7714_author_year', 'bibtex', 'ris'];
  const FORMAT_LABELS = {
    apa: 'APA (APA 7th)',
    mla: 'MLA',
    chicago: 'CHICAGO',
    ieee: 'IEEE',
    gbt7714_numeric: 'GB/T 7714 (Numeric)',
    gbt7714_author_year: 'GB/T 7714 (Author-Year)',
    bibtex: 'BIBTEX',
    ris: 'RIS'
  };
  const SETTINGS_KEY = 'superCiteSettings';
  const TEMPLATES_KEY = 'superCiteTemplates';
  const FETCH_CACHE_TTL_MS = 5 * 60 * 1000;
  const SLOW_FETCH_HINT_MS = 600;
  const MAX_VISIBLE_FORMATS = 4;

  const DEFAULT_SETTINGS = {
    clickSelect: true,
    clickCopy: false,
    showCopyButton: true,
    displayFormats: ['apa']
  };

  let overlay;
  let settings = { ...DEFAULT_SETTINGS };
  let viewMode = 'main'; // main | settings | editor
  let activeFetchRequestId = 0;
  let slowFetchTimer = null;
  let lastFetchEntry = null;
  let renderedOutputItems = [];

  const citationFetchCache = new Map();

  const currentState = {
    record: {},
    formats: {},
    active: 'apa',
    note: '',
    customTemplates: [],
    customOutputs: {}
  };

  const editorState = {
    draft: null,
    draggingTokenId: '',
    draggingPaletteKey: ''
  };

  function init() {
    ensureOverlay();
    injectButtons(document);
    observeDomChanges();
    loadSettings();
    loadTemplates();
  }

  function observeDomChanges() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          injectButtons(document);
          break;
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function injectButtons(root) {
    const results = root.querySelectorAll(RESULT_SELECTOR);
    results.forEach((result) => {
      if (result.querySelector(`.${BUTTON_CLASS}`)) return;

      const citeAnchor = findCiteAnchor(result);
      if (!citeAnchor) return;

      const button = document.createElement('a');
      button.innerHTML = `
        <span class="super-cite-btn-icon" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 7H6a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2l-1 3" />
            <path d="M19 7h-4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2l-1 3" />
          </svg>
        </span>
        <span class="super-cite-btn-label">Super Cite</span>
      `;
      button.className = BUTTON_CLASS;
      button.href = '#';
      button.addEventListener('click', (e) => {
        e.preventDefault();
        onSuperCiteClick(result);
      });

      const separator = document.createElement('span');
      separator.textContent = ' · ';
      separator.className = 'super-cite-separator';

      citeAnchor.insertAdjacentElement('afterend', separator);
      separator.insertAdjacentElement('afterend', button);
    });
  }

  function findCiteAnchor(resultNode) {
    const links = resultNode.querySelectorAll('.gs_fl a');
    for (const link of links) {
      const text = (link.textContent || '').trim();
      if (text === CITE_LABEL) return link;
    }
    return null;
  }

  function extractEntryMetadata(resultNode) {
    const titleEl = resultNode.querySelector('.gs_rt');
    const metaEl = resultNode.querySelector('.gs_a');

    const title = cleanTitle(titleEl ? titleEl.textContent : '');
    const primaryLink = resultNode.querySelector('.gs_rt a');
    const sourceUrl = primaryLink ? primaryLink.href : '';
    const metaRaw = metaEl ? metaEl.textContent : '';

    const yearMatch = metaRaw.match(/\b(19|20)\d{2}\b/g);
    const year = yearMatch ? yearMatch[yearMatch.length - 1] : '';

    const parts = metaRaw.split(' - ').map((x) => x.trim()).filter(Boolean);
    const authorsPart = parts[0] || '';
    const container = parts[1] || '';

    const authors = authorsPart
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .map((name) => ({ raw: name }));

    return {
      title,
      authors,
      year,
      container,
      sourceUrl,
      metaRaw
    };
  }

  function cleanTitle(rawTitle) {
    return (rawTitle || '')
      .replace(/^[\[【].*?[\]】]\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function onSuperCiteClick(resultNode) {
    const entry = extractEntryMetadata(resultNode);
    lastFetchEntry = entry;
    showModal(entry.title || 'Super Cite');
    await loadCitationForEntry(entry, { allowCache: true });
  }

  function ensureOverlay() {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.className = 'super-cite-overlay';
    overlay.innerHTML = `
      <div class="super-cite-modal">
        <div class="super-cite-header">
          <div class="super-cite-title"></div>
          <div class="super-cite-header-actions">
            <button class="super-cite-settings-toggle" type="button" data-action="settings" aria-label="Settings" title="Settings"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2.5" fill="currentColor"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.5" fill="currentColor"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="18" r="2.5" fill="currentColor"/></svg></button>
            <button class="super-cite-close" type="button" aria-label="Close">&times;</button>
          </div>
        </div>
        <div class="super-cite-body">
          <div class="super-cite-main">
            <div class="super-cite-tabs"></div>
            <div class="super-cite-output"></div>
            <div class="super-cite-actions">
              <button class="super-cite-action-btn" type="button" data-action="retry" style="display:none;">Retry</button>
              <button class="super-cite-action-btn" type="button" data-action="copy">Copy</button>
              <button class="super-cite-action-btn primary" type="button" data-action="close">Close</button>
            </div>
            <div class="super-cite-status"></div>
          </div>
          <div class="super-cite-settings">
            <div class="super-cite-settings-title">Interaction Settings</div>
            <div class="super-cite-settings-subtitle">Display Formats (up to 4)</div>
            <div class="super-cite-settings-formats"></div>
            <div class="super-cite-settings-note" data-role="format-note">Select up to 4 formats to show together in output.</div>
            <label class="super-cite-setting-item">
              <input type="checkbox" data-setting="clickSelect" />
              Click output to select citation text
            </label>
            <label class="super-cite-setting-item">
              <input type="checkbox" data-setting="clickCopy" />
              Click output to copy citation directly
            </label>
            <label class="super-cite-setting-item">
              <input type="checkbox" data-setting="showCopyButton" />
              Show Copy button
            </label>
            <div class="super-cite-settings-note">Mutual rule: "Click select" and "Click direct copy" cannot both be enabled.</div>
            <div class="super-cite-settings-actions">
              <button class="super-cite-action-btn primary" type="button" data-action="close-settings">Close</button>
            </div>
          </div>
          <div class="super-cite-template-editor">
            <div class="super-cite-template-top">
              <div class="super-cite-template-title">Create Citation Template</div>
              <div class="super-cite-template-subtitle">Choose a base format, then drag parts to compose your own rule.</div>
            </div>
            <div class="super-cite-template-meta">
              <label class="super-cite-template-field">
                <span>Template Name</span>
                <input type="text" data-template="name" maxlength="80" placeholder="e.g., Journal Submission Custom" />
              </label>
              <label class="super-cite-template-field">
                <span>Base Format</span>
                <select data-template="base"></select>
              </label>
            </div>
            <div class="super-cite-template-workbench-new">
              <div class="super-cite-template-palette-bar">
                <div class="super-cite-template-panel-title">Citation Parts</div>
                <div class="super-cite-template-palette"></div>
              </div>
              <div class="super-cite-template-lower">
                <div class="super-cite-template-panel wide">
                  <div class="super-cite-template-panel-title">Template Layout (drag to reorder, click to edit)</div>
                  <div class="super-cite-template-canvas" data-dropzone="template"></div>
                </div>
                <div class="super-cite-template-panel">
                  <div class="super-cite-template-panel-title">Preview</div>
                  <div class="super-cite-template-preview"></div>
                </div>
              </div>
            </div>
            <div class="super-cite-template-actions">
              <button class="super-cite-action-btn" type="button" data-action="template-cancel">Cancel</button>
              <button class="super-cite-action-btn" type="button" data-action="template-reset">Reset From Base</button>
              <button class="super-cite-action-btn primary" type="button" data-action="template-save">Save Template</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('.super-cite-close').addEventListener('click', closeModal);
    overlay.querySelector('[data-action="close"]').addEventListener('click', closeModal);
    overlay.querySelector('[data-action="retry"]').addEventListener('click', onRetryClick);
    overlay.querySelector('[data-action="copy"]').addEventListener('click', copyCurrent);
    overlay.querySelector('[data-action="settings"]').addEventListener('click', toggleSettingsPanel);
    overlay.querySelector('[data-action="close-settings"]').addEventListener('click', () => setViewMode('main'));
    overlay.querySelector('.super-cite-output').addEventListener('click', onOutputClick);
    overlay.querySelector('.super-cite-settings').addEventListener('change', onSettingsFormatChange);

    overlay.querySelector('[data-action="template-cancel"]').addEventListener('click', closeTemplateEditor);
    overlay.querySelector('[data-action="template-reset"]').addEventListener('click', onTemplateReset);
    overlay.querySelector('[data-action="template-save"]').addEventListener('click', onTemplateSave);

    overlay.querySelector('input[data-template="name"]').addEventListener('input', onTemplateNameInput);
    overlay.querySelector('select[data-template="base"]').addEventListener('change', onTemplateBaseChange);

    overlay.querySelector('.super-cite-template-palette').addEventListener('click', onPaletteClick);
    overlay.querySelector('.super-cite-template-palette').addEventListener('dragstart', onPaletteDragStart);

    const canvas = overlay.querySelector('.super-cite-template-canvas');
    canvas.addEventListener('click', onCanvasClick);
    canvas.addEventListener('dragstart', onCanvasDragStart);
    canvas.addEventListener('dragend', onCanvasDragEnd);
    canvas.addEventListener('dragover', onCanvasDragOver);
    canvas.addEventListener('drop', onCanvasDrop);

    const inputs = overlay.querySelectorAll('input[data-setting]');
    inputs.forEach((input) => {
      input.addEventListener('change', onSettingsInputChange);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    updateViewMode();
    renderSettingsUI();
    applySettingsToUI();
  }

  function showModal(title) {
    ensureOverlay();
    overlay.querySelector('.super-cite-title').textContent = title || 'Super Cite';
    overlay.style.display = 'flex';
    editorState.draft = null;
    setViewMode('main');
  }

  function closeModal() {
    if (!overlay) return;
    activeFetchRequestId += 1;
    clearSlowFetchTimer();
    overlay.style.display = 'none';
    editorState.draft = null;
    setViewMode('main');
  }

  async function onRetryClick() {
    if (!lastFetchEntry) return;
    await loadCitationForEntry(lastFetchEntry, { allowCache: false });
  }

  async function loadCitationForEntry(entry, options = {}) {
    const allowCache = options.allowCache !== false;
    const cacheKey = buildFetchCacheKey(entry);

    setRetryVisible(false);
    setLoadingState(true);
    setStatus('Fetching complete metadata...');
    setOutput('', { loading: true });

    if (allowCache) {
      const cachedData = getCachedFetch(cacheKey);
      if (cachedData) {
        await applyCitationData(cachedData, { cached: true });
        return;
      }
    }

    const requestId = Date.now();
    activeFetchRequestId = requestId;
    clearSlowFetchTimer();
    slowFetchTimer = window.setTimeout(() => {
      if (activeFetchRequestId !== requestId) return;
      setStatus('Still working... this may take a few more seconds.');
    }, SLOW_FETCH_HINT_MS);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SUPER_CITE_FETCH',
        payload: entry
      });

      if (activeFetchRequestId !== requestId) return;

      if (!response || !response.ok) {
        throw new Error(response?.error || 'Unknown error');
      }

      setCachedFetch(cacheKey, response.data || {});
      await applyCitationData(response.data || {}, { cached: false });
    } catch (err) {
      if (activeFetchRequestId !== requestId) return;
      setLoadingState(false);
      setRetryVisible(true);
      setStatus(`Failed to generate citation: ${err.message}`, true);
      setOutput('No citation available. Please retry.');
      renderTabs();
    } finally {
      if (activeFetchRequestId === requestId) {
        clearSlowFetchTimer();
      }
    }
  }

  async function applyCitationData(data, options = {}) {
    currentState.record = data.record || {};
    currentState.formats = data.formats || {};

    if (options.cached) {
      currentState.note = data.note || 'Citation loaded from cache.';
    } else {
      currentState.note = data.note || 'Citation generated from enriched metadata.';
    }

    await rebuildCustomOutputs();

    const tabItems = getTabItems();
    currentState.active = tabItems[0]?.key || 'apa';

    renderTabs();
    renderOutput();
    setLoadingState(false);
    setRetryVisible(false);
    if (typeof currentState.note === 'string') {
      setStatus({ text: currentState.note, cached: Boolean(options.cached) });
    } else {
      setStatus({ ...(currentState.note || {}), cached: Boolean(options.cached) });
    }
  }

  function setLoadingState(isLoading) {
    const copyBtn = overlay.querySelector('[data-action="copy"]');
    const tabs = overlay.querySelector('.super-cite-tabs');

    copyBtn.disabled = Boolean(isLoading);

    if (isLoading) {
      tabs.innerHTML = '<div class="super-cite-tabs-empty">Loading citation formats...</div>';
    }
  }

  function setRetryVisible(isVisible) {
    const retryBtn = overlay.querySelector('[data-action="retry"]');
    retryBtn.style.display = isVisible ? 'inline-block' : 'none';
  }

  function clearSlowFetchTimer() {
    if (slowFetchTimer !== null) {
      clearTimeout(slowFetchTimer);
      slowFetchTimer = null;
    }
  }

  function buildFetchCacheKey(entry) {
    const title = cleanText(entry?.title).toLowerCase();
    const year = cleanText(entry?.year);
    const url = sanitizeHttpUrl(entry?.sourceUrl);
    const meta = cleanText(entry?.metaRaw);
    return `${title}|${year}|${url}|${meta}`;
  }

  function getCachedFetch(cacheKey) {
    const hit = citationFetchCache.get(cacheKey);
    if (!hit) return null;
    if (Date.now() > hit.expireAt) {
      citationFetchCache.delete(cacheKey);
      return null;
    }
    return hit.data;
  }

  function setCachedFetch(cacheKey, data) {
    citationFetchCache.set(cacheKey, {
      data,
      expireAt: Date.now() + FETCH_CACHE_TTL_MS
    });
  }

  function setStatus(note, isError = false) {
    const status = overlay.querySelector('.super-cite-status');
    status.textContent = '';

    if (typeof note === 'string') {
      status.textContent = note || '';
    } else if (note && typeof note === 'object') {
      const text = String(note.text || '');
      const sourceUrl = sanitizeHttpUrl(note.sourceUrl);
      const cached = Boolean(note.cached);

      status.appendChild(document.createTextNode(text));
      if (cached) {
        const badge = document.createElement('span');
        badge.className = 'super-cite-status-badge';
        badge.textContent = 'Cached';
        status.appendChild(document.createTextNode(' '));
        status.appendChild(badge);
      }
      if (sourceUrl) {
        status.appendChild(document.createTextNode(' Source URL: '));
        const link = document.createElement('a');
        link.href = sourceUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = sourceUrl;
        link.className = 'super-cite-source-link';
        status.appendChild(link);
      }
    }

    status.classList.toggle('error', isError);
  }

  function setOutput(text, options = {}) {
    const outputEl = overlay.querySelector('.super-cite-output');
    renderedOutputItems = [];
    outputEl.textContent = text || '';
    outputEl.classList.toggle('loading', Boolean(options.loading));
  }

  function sanitizeHttpUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch (_error) {
      return '';
    }
    return '';
  }

  function getCombinedFormats() {
    return {
      ...currentState.formats,
      ...currentState.customOutputs
    };
  }

  function getBuiltinTabItems() {
    return BUILTIN_FORMATS
      .filter((key) => Boolean(currentState.formats[key]))
      .map((key) => ({ key, label: formatLabel(key), custom: false }));
  }

  function getCustomTabItems() {
    return currentState.customTemplates
      .filter((tpl) => Boolean(currentState.customOutputs[`tpl:${tpl.id}`]))
      .map((tpl) => ({ key: `tpl:${tpl.id}`, label: tpl.name, custom: true }));
  }

  function getTabItems() {
    return [...getBuiltinTabItems(), ...getCustomTabItems()];
  }

  function renderTabs() {
    const tabs = overlay.querySelector('.super-cite-tabs');
    tabs.innerHTML = '';

    const tabItems = getTabItems();
    const highlightedBuiltinKeys = new Set(getCurrentOutputItems().map((item) => item.key).filter((key) => BUILTIN_FORMATS.includes(key)));
    if (!tabItems.length) {
      const empty = document.createElement('div');
      empty.className = 'super-cite-tabs-empty';
      empty.textContent = 'No citation format available.';
      tabs.appendChild(empty);
      return;
    }

    if (!tabItems.some((item) => item.key === currentState.active)) {
      currentState.active = tabItems[0].key;
    }

    for (const item of tabItems) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isActive = item.custom ? currentState.active === item.key : highlightedBuiltinKeys.has(item.key);
      btn.className = `super-cite-tab ${isActive ? 'active' : ''}`;
      btn.textContent = item.label;
      btn.title = item.custom ? 'Custom template' : 'Built-in format';
      btn.addEventListener('click', () => {
        handleTabClick(item);
      });
      tabs.appendChild(btn);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'super-cite-tab super-cite-tab-add';
    addBtn.textContent = '+ Add';
    addBtn.title = 'Create custom citation template';
    addBtn.addEventListener('click', openTemplateEditor);
    tabs.appendChild(addBtn);
  }

  function handleTabClick(item) {
    if (!item) return;

    if (item.custom) {
      currentState.active = item.key;
      renderTabs();
      renderOutput();
      return;
    }

    const selected = normalizeVisibleFormats(settings.displayFormats);
    if (selected.includes(item.key)) {
      if (selected.length <= 1) {
        setStatus('At least one format must remain visible.', true);
        return;
      }

      settings.displayFormats = normalizeVisibleFormats(selected.filter((key) => key !== item.key));
      if (currentState.active === item.key) {
        currentState.active = settings.displayFormats[0] || currentState.active;
      }
      renderSettingsUI();
      applySettingsToUI();
      void persistSettings();
      renderTabs();
      renderOutput();
      return;
    }

    if (!selected.includes(item.key)) {
      if (selected.length >= MAX_VISIBLE_FORMATS) {
        setStatus(`You can show up to ${MAX_VISIBLE_FORMATS} formats. Remove one in Settings before adding another.`, true);
        return;
      }

      settings.displayFormats = normalizeVisibleFormats([...selected, item.key]);
      renderSettingsUI();
      applySettingsToUI();
      void persistSettings();
    }

    currentState.active = item.key;
    renderTabs();
    renderOutput();
  }

  function renderOutput() {
    const items = getCurrentOutputItems();
    if (!items.length) {
      setOutput('No output for selected format.');
      return;
    }
    renderOutputList(items);
  }

  async function copyCurrent() {
    const items = getCurrentOutputItems();
    const preferred = getPreferredOutputItem(items);
    const text = preferred?.text || '';
    if (!text) {
      setStatus('Nothing to copy.', true);
      return;
    }

    const label = preferred?.label || currentState.active;
    await copyText(text, `Copied ${label} citation.`);
  }

  async function onOutputClick(event) {
    const target = event.target;
    if (!target) return;

    const lineTextEl = target.closest('.super-cite-output-line-text');
    const lineIndex = Number(lineTextEl?.getAttribute('data-output-index'));
    const lineItem = Number.isInteger(lineIndex) ? renderedOutputItems[lineIndex] : null;
    const preferred = getPreferredOutputItem(getCurrentOutputItems());
    const text = lineItem?.text || preferred?.text || '';
    if (!text) return;

    if (settings.clickCopy) {
      const label = lineItem?.label || preferred?.label || currentState.active;
      await copyText(text, `Copied ${label} citation.`);
      return;
    }

    if (settings.clickSelect) {
      selectOutputText(lineTextEl);
      setStatus('Citation text selected.');
    }
  }

  async function copyText(text, successMessage) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(successMessage || 'Copied.');
    } catch (err) {
      setStatus(`Copy failed: ${err.message}`, true);
    }
  }

  function selectOutputText(targetElement = null) {
    const outputEl = overlay.querySelector('.super-cite-output');
    const selectTarget = targetElement || outputEl;
    const selection = window.getSelection();
    if (!selection || !selectTarget) return;

    const range = document.createRange();
    range.selectNodeContents(selectTarget);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function getCurrentOutputItems() {
    const combined = getCombinedFormats();

    if (String(currentState.active || '').startsWith('tpl:')) {
      const text = combined[currentState.active] || '';
      if (!text) return [];
      const label = getTabItems().find((item) => item.key === currentState.active)?.label || 'Custom Template';
      return [{ key: currentState.active, label, text }];
    }

    const selected = normalizeVisibleFormats(settings.displayFormats)
      .filter((formatKey) => Boolean(combined[formatKey]))
      .map((formatKey) => ({
        key: formatKey,
        label: formatLabel(formatKey),
        text: combined[formatKey]
      }));

    if (selected.length) return selected;

    const fallback = BUILTIN_FORMATS.find((formatKey) => Boolean(combined[formatKey]));
    if (!fallback) return [];

    return [{ key: fallback, label: formatLabel(fallback), text: combined[fallback] }];
  }

  function getPreferredOutputItem(items) {
    if (!Array.isArray(items) || !items.length) return null;
    return items.find((item) => item.key === currentState.active) || items[0];
  }

  function renderOutputList(items) {
    const outputEl = overlay.querySelector('.super-cite-output');
    renderedOutputItems = items;
    outputEl.classList.remove('loading');

    const html = items.map((item, index) => `
      <div class="super-cite-output-item">
        <div class="super-cite-output-item-label">${escapeHtml(item.label)}</div>
        <div class="super-cite-output-line-text" data-output-index="${index}">${escapeHtml(item.text)}</div>
      </div>
    `).join('');

    outputEl.innerHTML = `<div class="super-cite-output-list">${html}</div>`;
  }

  function toggleSettingsPanel() {
    if (viewMode === 'settings') {
      setViewMode('main');
    } else {
      setViewMode('settings');
    }
  }

  function setViewMode(mode) {
    viewMode = mode;
    updateViewMode();
    if (mode === 'main') {
      renderTabs();
      renderOutput();
    }
  }

  function updateViewMode() {
    const main = overlay.querySelector('.super-cite-main');
    const settingsPanel = overlay.querySelector('.super-cite-settings');
    const editor = overlay.querySelector('.super-cite-template-editor');
    const headerSettingsBtn = overlay.querySelector('[data-action="settings"]');

    main.style.display = viewMode === 'main' ? '' : 'none';
    settingsPanel.classList.toggle('open', viewMode === 'settings');
    editor.classList.toggle('open', viewMode === 'editor');

    if (viewMode === 'settings') {
      headerSettingsBtn.style.display = 'none';
    } else {
      headerSettingsBtn.style.display = '';
      headerSettingsBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2.5" fill="currentColor"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.5" fill="currentColor"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="18" r="2.5" fill="currentColor"/></svg>';
      headerSettingsBtn.title = 'Settings';
      headerSettingsBtn.disabled = viewMode === 'editor';
    }
  }

  async function onSettingsInputChange(event) {
    const input = event.target;
    const key = input?.getAttribute('data-setting');
    if (!key) return;

    settings[key] = Boolean(input.checked);

    if (key === 'clickSelect' && settings.clickSelect) settings.clickCopy = false;
    if (key === 'clickCopy' && settings.clickCopy) settings.clickSelect = false;

    settings = normalizeSettings(settings);
    renderSettingsUI();
    applySettingsToUI();
    renderOutput();
    await persistSettings();
  }

  async function onSettingsFormatChange(event) {
    const input = event.target;
    const format = input?.getAttribute('data-setting-format');
    if (!format) return;

    let selected = normalizeVisibleFormats(settings.displayFormats);
    const shouldEnable = Boolean(input.checked);

    if (shouldEnable) {
      if (!selected.includes(format)) {
        if (selected.length >= MAX_VISIBLE_FORMATS) {
          input.checked = false;
          setStatus(`You can select up to ${MAX_VISIBLE_FORMATS} formats.`, true);
          return;
        }
        selected.push(format);
      }
    } else {
      if (selected.length <= 1) {
        input.checked = true;
        setStatus('At least one format must remain visible.', true);
        return;
      }
      selected = selected.filter((item) => item !== format);
    }

    settings.displayFormats = normalizeVisibleFormats(selected);
    renderSettingsUI();
    applySettingsToUI();
    renderTabs();
    renderOutput();
    await persistSettings();
  }

  async function persistSettings() {
    try {
      await storageSet(SETTINGS_KEY, settings);
      setStatus('Settings saved.');
    } catch (err) {
      setStatus(`Failed to save settings: ${err.message}`, true);
    }
  }

  function normalizeSettings(raw) {
    const normalized = {
      clickSelect: raw?.clickSelect !== undefined ? Boolean(raw.clickSelect) : DEFAULT_SETTINGS.clickSelect,
      clickCopy: raw?.clickCopy !== undefined ? Boolean(raw.clickCopy) : DEFAULT_SETTINGS.clickCopy,
      showCopyButton: raw?.showCopyButton !== undefined ? Boolean(raw.showCopyButton) : DEFAULT_SETTINGS.showCopyButton,
      displayFormats: normalizeVisibleFormats(raw?.displayFormats)
    };

    if (normalized.clickSelect && normalized.clickCopy) {
      normalized.clickCopy = false;
    }

    return normalized;
  }

  function renderSettingsUI() {
    const panel = overlay.querySelector('.super-cite-settings');
    if (!panel) return;

    panel.querySelector('input[data-setting="clickSelect"]').checked = settings.clickSelect;
    panel.querySelector('input[data-setting="clickCopy"]').checked = settings.clickCopy;
    panel.querySelector('input[data-setting="showCopyButton"]').checked = settings.showCopyButton;

    const selectedSet = new Set(normalizeVisibleFormats(settings.displayFormats));
    const formatsEl = panel.querySelector('.super-cite-settings-formats');
    formatsEl.innerHTML = BUILTIN_FORMATS.map((format) => {
      const checked = selectedSet.has(format) ? 'checked' : '';
      return `
        <label class="super-cite-format-chip">
          <input type="checkbox" data-setting-format="${format}" ${checked} />
          <span>${escapeHtml(formatLabel(format))}</span>
        </label>
      `;
    }).join('');

    const noteEl = panel.querySelector('[data-role="format-note"]');
    noteEl.textContent = `Selected ${selectedSet.size}/${MAX_VISIBLE_FORMATS}. Choose up to ${MAX_VISIBLE_FORMATS} formats to show together in output.`;
  }

  function applySettingsToUI() {
    const outputEl = overlay.querySelector('.super-cite-output');
    const copyBtn = overlay.querySelector('[data-action="copy"]');

    copyBtn.style.display = settings.showCopyButton ? 'inline-block' : 'none';

    outputEl.classList.toggle('interactive', settings.clickSelect || settings.clickCopy);
    if (settings.clickCopy) {
      outputEl.title = 'Click to copy citation';
    } else if (settings.clickSelect) {
      outputEl.title = 'Click to select citation';
    } else {
      outputEl.title = '';
    }
  }

  async function loadSettings() {
    try {
      const data = await storageGet(SETTINGS_KEY);
      settings = normalizeSettings(data[SETTINGS_KEY]);
      renderSettingsUI();
      applySettingsToUI();
    } catch (_err) {
      settings = { ...DEFAULT_SETTINGS };
      renderSettingsUI();
      applySettingsToUI();
    }
  }

  function normalizeVisibleFormats(rawFormats) {
    const source = Array.isArray(rawFormats) ? rawFormats : DEFAULT_SETTINGS.displayFormats;
    const unique = [];

    for (const item of source) {
      if (!BUILTIN_FORMATS.includes(item)) continue;
      if (unique.includes(item)) continue;
      unique.push(item);
      if (unique.length >= MAX_VISIBLE_FORMATS) break;
    }

    if (!unique.length) return ['apa'];
    return unique;
  }

  async function loadTemplates() {
    try {
      const data = await storageGet(TEMPLATES_KEY);
      const list = Array.isArray(data[TEMPLATES_KEY]) ? data[TEMPLATES_KEY] : [];
      currentState.customTemplates = list.map(normalizeTemplate).filter(Boolean);
      await rebuildCustomOutputs();
      renderTabs();
      renderOutput();
    } catch (_error) {
      currentState.customTemplates = [];
    }
  }

  function normalizeTemplate(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const baseFormat = BUILTIN_FORMATS.includes(raw.baseFormat) ? raw.baseFormat : 'apa';
    const name = cleanText(raw.name) || `Custom ${Date.now()}`;
    const id = cleanText(raw.id) || createId();
    const tokens = normalizeTokens(raw.tokens);

    return {
      id,
      name,
      baseFormat,
      tokens,
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now()
    };
  }

  function normalizeTokens(tokens) {
    if (!Array.isArray(tokens) || !tokens.length) return [];

    return tokens
      .map((token) => {
        if (!token || typeof token !== 'object') return null;
        if (token.type === 'field') {
          const key = cleanText(token.key);
          if (!key) return null;
          return {
            id: cleanText(token.id) || createId(),
            type: 'field',
            key,
            label: cleanText(token.label) || toFieldLabel(key),
            override: token.override !== undefined ? String(token.override) : ''
          };
        }
        if (token.type === 'text') {
          return {
            id: cleanText(token.id) || createId(),
            type: 'text',
            text: token.text !== undefined ? String(token.text) : ''
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  async function rebuildCustomOutputs() {
    const outputs = {};
    for (const template of currentState.customTemplates) {
      outputs[`tpl:${template.id}`] = renderTemplateCitation(template);
    }
    currentState.customOutputs = outputs;
  }

  function renderTemplateCitation(template) {
    if (!template || !Array.isArray(template.tokens)) return '';

    const catalog = buildFieldCatalog(template.baseFormat);
    const fieldMap = new Map(catalog.map((item) => [item.key, item]));

    const pieces = template.tokens.map((token) => {
      if (token.type === 'text') return String(token.text || '');
      if (token.type === 'field') {
        if (token.override) return token.override;
        return fieldMap.get(token.key)?.value || '';
      }
      return '';
    });

    return polishCitationText(pieces.join(''));
  }

  function polishCitationText(text) {
    const raw = String(text || '');
    if (!raw) return '';

    if (raw.includes('\n')) {
      return raw
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    return raw
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/,\s*,+/g, ', ')
      .replace(/\.\s*\./g, '.')
      .replace(/,\s*\./g, '.')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function buildFieldCatalog(baseFormat) {
    const rec = currentState.record || {};
    const authors = formatTemplateAuthors(rec.authors);
    const year = cleanText(rec.year) || 'n.d.';
    const title = cleanText(rec.title);
    const container = cleanText(rec.container);
    const volume = cleanText(rec.volume);
    const issue = cleanText(rec.issue);
    const pages = cleanText(rec.page);
    const publisher = cleanText(rec.publisher);
    const doi = cleanText(rec.doi);
    const url = cleanText(rec.url);

    const doiUrl = doi ? `https://doi.org/${doi}` : '';
    const volumeIssue = [volume, issue ? `(${issue})` : ''].filter(Boolean).join(' ');
    const volIssuePages = [volumeIssue, pages ? `:${pages}` : ''].filter(Boolean).join(' ');

    return [
      { key: 'authors', label: 'Authors', value: authors },
      { key: 'year', label: 'Year', value: year },
      { key: 'title', label: 'Title', value: title },
      { key: 'container', label: 'Journal/Container', value: container },
      { key: 'volume', label: 'Volume', value: volume },
      { key: 'issue', label: 'Issue', value: issue },
      { key: 'pages', label: 'Pages', value: pages },
      { key: 'volume_issue_pages', label: 'Vol/Issue/Pages', value: volIssuePages },
      { key: 'publisher', label: 'Publisher', value: publisher },
      { key: 'doi', label: 'DOI', value: doi },
      { key: 'doi_url', label: 'DOI URL', value: doiUrl },
      { key: 'url', label: 'URL', value: url },
      { key: 'base_citation', label: 'Base Citation Text', value: String(currentState.formats[baseFormat] || '') }
    ];
  }

  function formatTemplateAuthors(authors) {
    if (!Array.isArray(authors) || !authors.length) return 'Unknown Author';
    const names = authors
      .map((author) => {
        const given = cleanText(author?.given);
        const family = cleanText(author?.family);
        return cleanText(`${given} ${family}`);
      })
      .filter(Boolean);
    return names.join(', ') || 'Unknown Author';
  }

  function toFieldLabel(key) {
    const map = {
      authors: 'Authors',
      year: 'Year',
      title: 'Title',
      container: 'Journal/Container',
      volume: 'Volume',
      issue: 'Issue',
      pages: 'Pages',
      volume_issue_pages: 'Vol/Issue/Pages',
      publisher: 'Publisher',
      doi: 'DOI',
      doi_url: 'DOI URL',
      url: 'URL',
      base_citation: 'Base Citation Text'
    };
    return map[key] || key;
  }

  function openTemplateEditor() {
    if (!Object.keys(currentState.formats || {}).length) {
      setStatus('Generate a citation first, then create a custom template.', true);
      return;
    }

    const preferredBase = BUILTIN_FORMATS.includes(currentState.active) ? currentState.active : 'apa';
    editorState.draft = createDraftTemplate(preferredBase);
    renderTemplateEditor();
    setViewMode('editor');
  }

  function closeTemplateEditor() {
    editorState.draft = null;
    setViewMode('main');
  }

  function createDraftTemplate(baseFormat) {
    const safeBase = BUILTIN_FORMATS.includes(baseFormat) && currentState.formats[baseFormat] ? baseFormat : firstAvailableBaseFormat();
    return {
      id: createId(),
      name: suggestTemplateName(),
      baseFormat: safeBase,
      tokens: buildBaseTokens(safeBase),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  function suggestTemplateName() {
    return `Custom Template ${currentState.customTemplates.length + 1}`;
  }

  function firstAvailableBaseFormat() {
    return BUILTIN_FORMATS.find((format) => currentState.formats[format]) || 'apa';
  }

  function buildBaseTokens(baseFormat) {
    const addField = (key) => ({ id: createId(), type: 'field', key, label: toFieldLabel(key), override: '' });
    const addText = (text) => ({ id: createId(), type: 'text', text });

    if (baseFormat === 'bibtex' || baseFormat === 'ris') {
      return [addField('base_citation')];
    }

    if (baseFormat === 'mla') {
      return [
        addField('authors'),
        addText('. "'),
        addField('title'),
        addText('." '),
        addField('container'),
        addText(', '),
        addField('volume_issue_pages'),
        addText(', '),
        addField('year'),
        addText('. '),
        addField('doi_url')
      ];
    }

    if (baseFormat === 'chicago') {
      return [
        addField('authors'),
        addText('. '),
        addField('year'),
        addText('. "'),
        addField('title'),
        addText('." '),
        addField('container'),
        addText(' '),
        addField('volume_issue_pages'),
        addText('. '),
        addField('doi_url')
      ];
    }

    if (baseFormat === 'ieee') {
      return [
        addField('authors'),
        addText(', "'),
        addField('title'),
        addText('," '),
        addField('container'),
        addText(', '),
        addField('volume_issue_pages'),
        addText(', '),
        addField('year'),
        addText('. '),
        addField('doi')
      ];
    }

    // APA default
    return [
      addField('authors'),
      addText(' ('),
      addField('year'),
      addText('). '),
      addField('title'),
      addText('. '),
      addField('container'),
      addText(', '),
      addField('volume_issue_pages'),
      addText('. '),
      addField('doi_url')
    ];
  }

  function onTemplateNameInput(event) {
    if (!editorState.draft) return;
    editorState.draft.name = String(event.target.value || '');
  }

  function onTemplateBaseChange(event) {
    if (!editorState.draft) return;
    const nextBase = String(event.target.value || '');
    if (!BUILTIN_FORMATS.includes(nextBase)) return;

    editorState.draft.baseFormat = nextBase;
    editorState.draft.tokens = buildBaseTokens(nextBase);
    renderTemplateEditor();
  }

  function onTemplateReset() {
    if (!editorState.draft) return;
    editorState.draft.tokens = buildBaseTokens(editorState.draft.baseFormat);
    renderTemplateEditor();
  }

  async function onTemplateSave() {
    if (!editorState.draft) return;

    const name = cleanText(editorState.draft.name);
    if (!name) {
      setStatus('Template name is required.', true);
      return;
    }

    if (!Array.isArray(editorState.draft.tokens) || !editorState.draft.tokens.length) {
      setStatus('Template layout cannot be empty.', true);
      return;
    }

    const normalized = normalizeTemplate({
      ...editorState.draft,
      name,
      updatedAt: Date.now()
    });

    if (!normalized) {
      setStatus('Template data is invalid.', true);
      return;
    }

    currentState.customTemplates.push(normalized);

    try {
      await storageSet(TEMPLATES_KEY, currentState.customTemplates);
      await rebuildCustomOutputs();
      renderTabs();
      currentState.active = `tpl:${normalized.id}`;
      renderOutput();
      setStatus(`Template "${normalized.name}" saved.`);
      closeTemplateEditor();
    } catch (err) {
      currentState.customTemplates = currentState.customTemplates.filter((tpl) => tpl.id !== normalized.id);
      setStatus(`Failed to save template: ${err.message}`, true);
    }
  }

  function renderTemplateEditor() {
    const editor = overlay.querySelector('.super-cite-template-editor');
    if (!editorState.draft) {
      editor.classList.remove('open');
      return;
    }

    const baseSelect = editor.querySelector('select[data-template="base"]');
    const nameInput = editor.querySelector('input[data-template="name"]');

    const availableBases = BUILTIN_FORMATS.filter((format) => currentState.formats[format]);
    baseSelect.innerHTML = availableBases.map((format) => `<option value="${format}">${escapeHtml(formatLabel(format))}</option>`).join('');

    if (!availableBases.includes(editorState.draft.baseFormat)) {
      editorState.draft.baseFormat = availableBases[0] || 'apa';
      editorState.draft.tokens = buildBaseTokens(editorState.draft.baseFormat);
    }

    baseSelect.value = editorState.draft.baseFormat;
    nameInput.value = editorState.draft.name;

    renderPalette();
    renderCanvas();
    renderPreview();
  }

  function renderPalette() {
    const palette = overlay.querySelector('.super-cite-template-palette');
    const catalog = buildFieldCatalog(editorState.draft?.baseFormat || firstAvailableBaseFormat());

    const fieldChips = catalog.map((field) => {
      const hasValue = Boolean(cleanText(field.value));
      const valuePreview = hasValue ? escapeHtml(truncate(field.value, 56)) : 'No value in this citation';
      return `
        <button type="button" class="super-cite-template-part ${hasValue ? '' : 'empty'}" draggable="true" data-part-type="field" data-field-key="${field.key}" title="${escapeHtml(field.label)}: ${valuePreview}">
          <span>${escapeHtml(field.label)}</span>
          <small>${valuePreview}</small>
        </button>
      `;
    }).join('');

    const textChip = `
      <button type="button" class="super-cite-template-part" draggable="true" data-part-type="text" data-field-key="__text__" title="Insert custom punctuation/text">
        <span>Custom Text</span>
        <small>Click to insert punctuation or words</small>
      </button>
    `;

    palette.innerHTML = `${fieldChips}${textChip}`;
  }

  function formatLabel(format) {
    return FORMAT_LABELS[format] || String(format || '').toUpperCase();
  }

  function renderCanvas() {
    const canvas = overlay.querySelector('.super-cite-template-canvas');
    const tokens = editorState.draft?.tokens || [];

    canvas.textContent = '';

    if (!tokens.length) {
      const empty = document.createElement('div');
      empty.className = 'super-cite-template-canvas-empty';
      empty.textContent = 'Drop parts here to build your format.';
      canvas.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    tokens.forEach((token) => {
      fragment.appendChild(renderTokenChip(token));
    });
    canvas.appendChild(fragment);
  }

  function renderTokenChip(token) {
    const chip = document.createElement('div');
    chip.className = 'super-cite-template-token';
    chip.draggable = true;
    chip.setAttribute('data-token-id', String(token?.id || ''));

    const labelEl = document.createElement('span');
    labelEl.className = 'super-cite-template-token-label';

    const valueEl = document.createElement('span');
    valueEl.className = 'super-cite-template-token-value';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'super-cite-template-token-remove';
    removeBtn.setAttribute('data-action', 'token-remove');
    removeBtn.setAttribute('data-token-id', String(token?.id || ''));
    removeBtn.setAttribute('aria-label', 'Remove token');
    removeBtn.textContent = '×';

    if (token.type === 'text') {
      const textPreview = token.text || '(empty text)';
      chip.setAttribute('data-token-type', 'text');
      chip.title = 'Click to edit text';
      labelEl.textContent = 'Text';
      valueEl.textContent = truncate(textPreview, 60);
      chip.append(labelEl, valueEl, removeBtn);
      return chip;
    }

    const value = resolveTokenValue(token);
    const tokenLabel = token.label || toFieldLabel(token.key);
    chip.setAttribute('data-token-type', 'field');
    chip.title = `${tokenLabel}: ${truncate(value || '(empty)', 80)}`;
    labelEl.textContent = tokenLabel;
    valueEl.textContent = truncate(value || '(empty)', 60);
    chip.append(labelEl, valueEl, removeBtn);
    return chip;
  }

  function resolveTokenValue(token) {
    if (!token) return '';
    if (token.type === 'text') return String(token.text || '');
    if (token.override) return token.override;
    const catalog = buildFieldCatalog(editorState.draft?.baseFormat || firstAvailableBaseFormat());
    const field = catalog.find((item) => item.key === token.key);
    return field?.value || '';
  }

  function renderPreview() {
    const preview = overlay.querySelector('.super-cite-template-preview');
    if (!editorState.draft) {
      preview.textContent = '';
      return;
    }

    const normalized = normalizeTemplate(editorState.draft);
    const output = normalized ? renderTemplateCitation(normalized) : '';
    preview.textContent = output || 'Preview will appear here as you build the template.';
  }

  function onPaletteClick(event) {
    const partBtn = event.target.closest('.super-cite-template-part');
    if (!partBtn) return;

    const partType = partBtn.getAttribute('data-part-type');
    const key = partBtn.getAttribute('data-field-key') || '';
    insertTokenFromPalette(partType, key);
  }

  function onPaletteDragStart(event) {
    const partBtn = event.target.closest('.super-cite-template-part');
    if (!partBtn) return;

    const partType = partBtn.getAttribute('data-part-type');
    const key = partBtn.getAttribute('data-field-key') || '';
    editorState.draggingPaletteKey = `${partType}:${key}`;
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', editorState.draggingPaletteKey);
  }

  function insertTokenFromPalette(partType, key, atIndex = null) {
    if (!editorState.draft) return;

    let token;
    if (partType === 'text') {
      const initial = prompt('Enter custom text/punctuation for this token:', ', ');
      if (initial === null) return;
      token = {
        id: createId(),
        type: 'text',
        text: String(initial)
      };
    } else {
      token = {
        id: createId(),
        type: 'field',
        key,
        label: toFieldLabel(key),
        override: ''
      };
    }

    if (Number.isInteger(atIndex) && atIndex >= 0 && atIndex <= editorState.draft.tokens.length) {
      editorState.draft.tokens.splice(atIndex, 0, token);
    } else {
      editorState.draft.tokens.push(token);
    }

    renderCanvas();
    renderPreview();
  }

  function onCanvasClick(event) {
    const removeBtn = event.target.closest('[data-action="token-remove"]');
    if (removeBtn) {
      const tokenId = removeBtn.getAttribute('data-token-id');
      removeToken(tokenId);
      return;
    }

    const tokenEl = event.target.closest('.super-cite-template-token');
    if (!tokenEl) return;
    const tokenId = tokenEl.getAttribute('data-token-id');
    editToken(tokenId);
  }

  function removeToken(tokenId) {
    if (!editorState.draft) return;
    editorState.draft.tokens = editorState.draft.tokens.filter((token) => token.id !== tokenId);
    renderCanvas();
    renderPreview();
  }

  function editToken(tokenId) {
    if (!editorState.draft) return;
    const token = editorState.draft.tokens.find((item) => item.id === tokenId);
    if (!token) return;

    if (token.type === 'text') {
      const next = prompt('Edit text token:', token.text || '');
      if (next === null) return;
      token.text = String(next);
      renderCanvas();
      renderPreview();
      return;
    }

    const autoValue = resolveTokenValue({ ...token, override: '' });
    const nextOverride = prompt(
      `Edit value for "${token.label || toFieldLabel(token.key)}".\nLeave empty to use automatic citation value:\n${autoValue || '(empty)'}`,
      token.override || ''
    );
    if (nextOverride === null) return;

    token.override = String(nextOverride);
    renderCanvas();
    renderPreview();
  }

  function onCanvasDragStart(event) {
    const tokenEl = event.target.closest('.super-cite-template-token');
    if (!tokenEl) return;

    editorState.draggingTokenId = tokenEl.getAttribute('data-token-id') || '';
    tokenEl.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', editorState.draggingTokenId);
  }

  function onCanvasDragEnd(event) {
    const tokenEl = event.target.closest('.super-cite-template-token');
    if (tokenEl) tokenEl.classList.remove('dragging');
    editorState.draggingTokenId = '';
    editorState.draggingPaletteKey = '';
  }

  function onCanvasDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = editorState.draggingPaletteKey ? 'copy' : 'move';
  }

  function onCanvasDrop(event) {
    event.preventDefault();
    if (!editorState.draft) return;

    const dropIndex = calculateDropIndex(event.clientX, event.clientY);

    if (editorState.draggingPaletteKey) {
      const [partType, key] = editorState.draggingPaletteKey.split(':');
      insertTokenFromPalette(partType, key, dropIndex);
      editorState.draggingPaletteKey = '';
      return;
    }

    if (!editorState.draggingTokenId) return;

    const fromIndex = editorState.draft.tokens.findIndex((token) => token.id === editorState.draggingTokenId);
    if (fromIndex < 0) return;

    const [moved] = editorState.draft.tokens.splice(fromIndex, 1);
    const normalizedIndex = dropIndex > fromIndex ? dropIndex - 1 : dropIndex;
    const safeIndex = Math.max(0, Math.min(normalizedIndex, editorState.draft.tokens.length));
    editorState.draft.tokens.splice(safeIndex, 0, moved);

    renderCanvas();
    renderPreview();
  }

  function calculateDropIndex(clientX, clientY) {
    const canvas = overlay.querySelector('.super-cite-template-canvas');
    const items = Array.from(canvas.querySelectorAll('.super-cite-template-token'));

    for (let i = 0; i < items.length; i += 1) {
      const rect = items[i].getBoundingClientRect();
      const beforeY = clientY < rect.top + rect.height / 2;
      const sameRow = clientY >= rect.top && clientY <= rect.bottom;
      const beforeX = clientX < rect.left + rect.width / 2;

      if (beforeY || (sameRow && beforeX)) {
        return i;
      }
    }

    return items.length;
  }

  function truncate(text, len) {
    const raw = String(text || '');
    if (raw.length <= len) return raw;
    return `${raw.slice(0, Math.max(0, len - 1))}…`;
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createId() {
    return `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function storageGet(key) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(key, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result || {});
      });
    });
  }

  function storageSet(key, value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  init();
})();

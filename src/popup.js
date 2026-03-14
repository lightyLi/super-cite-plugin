(() => {
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

  const state = {
    tabId: null,
    data: null,
    activeFormat: 'apa'
  };

  const els = {
    title: document.getElementById('title'),
    meta: document.getElementById('meta'),
    formatSelect: document.getElementById('formatSelect'),
    output: document.getElementById('output'),
    status: document.getElementById('status'),
    copyBtn: document.getElementById('copyBtn'),
    copyAndCloseBtn: document.getElementById('copyAndCloseBtn'),
    refreshBtn: document.getElementById('refreshBtn')
  };

  async function init() {
    bindEvents();
    await loadFromActiveTab();
  }

  function bindEvents() {
    els.refreshBtn.addEventListener('click', () => {
      loadFromActiveTab();
    });

    els.formatSelect.addEventListener('change', () => {
      state.activeFormat = String(els.formatSelect.value || '');
      renderOutput();
    });

    els.copyBtn.addEventListener('click', async () => {
      await copyCurrent(false);
    });

    els.copyAndCloseBtn.addEventListener('click', async () => {
      await copyCurrent(true);
    });
  }

  async function loadFromActiveTab() {
    try {
      setStatus('Reading page metadata...');
      setLoading(true);

      const tab = await getActiveTab();
      if (!tab?.id) throw new Error('No active tab found.');
      state.tabId = tab.id;

      if (shouldBlockCitationForPage(tab.url)) {
        state.data = null;
        els.title.textContent = tab.title || 'Search Results Page';
        els.meta.textContent = tab.url || '';
        els.output.value = '';
        els.formatSelect.innerHTML = '';
        setStatus('Please generate the citation on the article detail page.', true);
        return;
      }

      const response = await chrome.runtime.sendMessage({
        type: 'SUPER_CITE_FETCH_FROM_TAB',
        tabId: state.tabId
      });

      if (!response?.ok) {
        throw new Error(response?.error || 'Failed to cite current page.');
      }

      state.data = response.data || {};
      const record = state.data.record || {};

      els.title.textContent = record.title || tab.title || 'Untitled page';
      const metaParts = [record.container, record.year, record.url].filter(Boolean);
      els.meta.textContent = metaParts.join(' | ') || tab.url || '';

      renderFormats();
      renderOutput();
      setStatus('Citation ready.');
    } catch (error) {
      state.data = null;
      els.title.textContent = 'Cannot cite this page';
      els.meta.textContent = '';
      els.output.value = '';
      els.formatSelect.innerHTML = '';
      setStatus(error?.message || String(error), true);
    } finally {
      setLoading(false);
    }
  }

  function renderFormats() {
    const formats = state.data?.formats || {};
    const keys = Object.keys(formats).filter((key) => String(formats[key] || '').trim());

    if (!keys.length) {
      state.activeFormat = '';
      els.formatSelect.innerHTML = '';
      return;
    }

    if (!keys.includes(state.activeFormat)) {
      state.activeFormat = keys[0];
    }

    els.formatSelect.innerHTML = keys
      .map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(formatLabel(key))}</option>`)
      .join('');

    els.formatSelect.value = state.activeFormat;
  }

  function renderOutput() {
    const text = String(state.data?.formats?.[state.activeFormat] || '');
    els.output.value = text;
  }

  async function copyCurrent(shouldClose) {
    try {
      const text = String(els.output.value || '').trim();
      if (!text) throw new Error('No citation content to copy.');

      await navigator.clipboard.writeText(text);
      setStatus(`${formatLabel(state.activeFormat)} copied.`);

      if (shouldClose) {
        window.close();
      }
    } catch (error) {
      setStatus(error?.message || String(error), true);
    }
  }

  function setStatus(text, isError = false) {
    els.status.textContent = String(text || '');
    els.status.classList.toggle('error', Boolean(isError));
  }

  function setLoading(loading) {
    els.copyBtn.disabled = loading;
    els.copyAndCloseBtn.disabled = loading;
    els.refreshBtn.disabled = loading;
    els.formatSelect.disabled = loading;
  }

  function formatLabel(key) {
    return FORMAT_LABELS[key] || String(key || '').toUpperCase();
  }

  function getActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs?.[0] || null);
      });
    });
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function shouldBlockCitationForPage(url) {
    const raw = String(url || '').trim();
    if (!raw) return false;

    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_error) {
      return false;
    }

    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();

    // Common search results pages that are not article detail pages.
    if (host.includes('google.') && path === '/search') return true;
    if (host.includes('bing.com') && path === '/search') return true;
    if (host.includes('baidu.com') && (path === '/s' || path === '/from=844b/s')) return true;
    if (host.includes('duckduckgo.com') && path.startsWith('/')) {
      return parsed.searchParams.has('q');
    }

    return false;
  }

  init();
})();

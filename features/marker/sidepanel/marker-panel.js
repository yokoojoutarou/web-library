(() => {
  let activePageUrl = '';
  let activePageTitle = '';
  let currentMarkers = [];

  function isSupportedUrl(url) {
    return /^(https?:|file:)/.test(String(url || ''));
  }

  async function sendDbOp(operation, payload = {}) {
    return chrome.runtime.sendMessage({
      type: 'DB_OP',
      operation,
      payload,
    });
  }

  function setStatus(markersStatus, message, isError = false) {
    markersStatus.textContent = message || '';
    markersStatus.style.color = isError ? 'var(--error)' : 'var(--text-muted)';
  }

  function getColorLabel(color) {
    const normalized = String(color || '').toLowerCase();
    if (normalized === 'yellow') return 'Yellow';
    if (normalized === 'green') return 'Green';
    if (normalized === 'pink') return 'Pink';
    return normalized || 'Unknown';
  }

  function sortMarkersByPageOrder(markers) {
    return [...markers].sort((a, b) => {
      const aStart = Number(a?.rangeDescriptor?.start);
      const bStart = Number(b?.rangeDescriptor?.start);
      const aHasStart = Number.isFinite(aStart);
      const bHasStart = Number.isFinite(bStart);

      if (aHasStart && bHasStart && aStart !== bStart) {
        return aStart - bStart;
      }

      if (aHasStart !== bHasStart) {
        return aHasStart ? -1 : 1;
      }

      const aUpdated = String(a?.updatedAt || '');
      const bUpdated = String(b?.updatedAt || '');
      return aUpdated.localeCompare(bUpdated);
    });
  }

  async function getActivePageContext() {
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const activeTab = tabs?.[0];
      if (!activeTab?.id) {
        return null;
      }

      let selectedText = '';
      try {
        const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'REQUEST_PAGE_CONTEXT' });
        if (response?.success) {
          selectedText = String(response.data?.selectedText || '');
        }
      } catch {
        // ignore when content script is unavailable for this tab
      }

      return {
        tabId: activeTab.id,
        url: String(activeTab.url || ''),
        title: String(activeTab.title || ''),
        selectedText,
      };
    } catch {
      return null;
    }
  }

  function renderMarkerList(markersList, markers) {
    markersList.innerHTML = '';

    if (!Array.isArray(markers) || markers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'thread-item-meta';
      empty.textContent = 'このページのマーカーはまだありません。';
      markersList.appendChild(empty);
      return;
    }

    markers.forEach((marker) => {
      const item = document.createElement('div');
      item.className = 'marker-item';
      item.dataset.markerId = marker.markerId;
      item.dataset.action = 'jump';
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-label', 'ページ内でマーカーへ移動');

      const main = document.createElement('div');
      main.className = 'marker-item-main';

      const text = document.createElement('div');
      text.className = 'marker-item-text';
      const quote = String(marker.textQuote || '').replace(/\s+/g, ' ').trim();
      text.textContent = quote || '（引用テキストなし）';

      const meta = document.createElement('div');
      meta.className = 'marker-item-meta';
      meta.textContent = `${getColorLabel(marker.color)} ・ ${marker.updatedAt || ''}`;

      const actions = document.createElement('div');
      actions.className = 'marker-item-actions';

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'marker-action-btn';
      deleteBtn.title = 'マーカーを削除';
      deleteBtn.setAttribute('aria-label', 'マーカーを削除');
      deleteBtn.dataset.action = 'delete';
      deleteBtn.dataset.markerId = marker.markerId;
      deleteBtn.textContent = '🗑';

      main.appendChild(text);
      main.appendChild(meta);
      actions.appendChild(deleteBtn);
      item.appendChild(main);
      item.appendChild(actions);
      markersList.appendChild(item);
    });
  }

  async function notifyContent(action, markerId) {
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const activeTab = tabs?.[0];
      if (!activeTab?.id) return;
      await chrome.tabs.sendMessage(activeTab.id, {
        type: action,
        markerId,
      });
    } catch {
      // ignore for unsupported pages
    }
  }

  async function refreshMarkers({ markersList, markersStatus }) {
    const context = await getActivePageContext();
    activePageUrl = String(context?.url || '').trim();
    activePageTitle = String(context?.title || '').trim();

    if (!activePageUrl || !isSupportedUrl(activePageUrl)) {
      currentMarkers = [];
      renderMarkerList(markersList, currentMarkers);
      setStatus(markersStatus, 'このページではマーカーを利用できません。', true);
      return;
    }

    const response = await sendDbOp('marker.listBySite', { url: activePageUrl });
    currentMarkers = response?.success && Array.isArray(response.data)
      ? sortMarkersByPageOrder(response.data)
      : [];
    renderMarkerList(markersList, currentMarkers);
    setStatus(markersStatus, `Page: ${activePageTitle || activePageUrl}`);
  }

  function init() {
    const markersWorkspace = document.getElementById('markersWorkspace');
    const markersRefreshBtn = document.getElementById('markersRefreshBtn');
    const markersList = document.getElementById('markersList');
    const markersStatus = document.getElementById('markersStatus');

    if (!markersWorkspace || !markersRefreshBtn || !markersList || !markersStatus) {
      return;
    }

    markersRefreshBtn.addEventListener('click', () => {
      refreshMarkers({ markersList, markersStatus }).catch(() => {
        setStatus(markersStatus, 'マーカー一覧の取得に失敗しました。', true);
      });
    });

    markersList.addEventListener('click', async (event) => {
      const markerItem = event.target.closest('.marker-item[data-action="jump"]');
      const button = event.target.closest('button[data-action]');

      if (!button && markerItem) {
        const markerId = markerItem.dataset.markerId;
        if (!markerId) return;
        await notifyContent('MARKER_SCROLL_TO', markerId);
        setStatus(markersStatus, 'ページ上のマーカーへ移動しました。');
        return;
      }

      if (!button) return;

      const markerId = button.dataset.markerId;
      const action = button.dataset.action;
      if (!markerId || !action) return;

      if (action === 'jump') {
        await notifyContent('MARKER_SCROLL_TO', markerId);
        setStatus(markersStatus, 'ページ上のマーカーへ移動しました。');
        return;
      }

      if (action === 'delete') {
        const response = await sendDbOp('marker.delete', { markerId });
        if (!response?.success) {
          setStatus(markersStatus, response?.error || '削除に失敗しました。', true);
          return;
        }

        await notifyContent('MARKER_REMOVE', markerId);
        await refreshMarkers({ markersList, markersStatus });
        setStatus(markersStatus, 'マーカーを削除しました。');
      }
    });

    markersList.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest('button[data-action]')) return;

      const markerItem = event.target.closest('.marker-item[data-action="jump"]');
      if (!markerItem) return;

      event.preventDefault();
      const markerId = markerItem.dataset.markerId;
      if (!markerId) return;

      await notifyContent('MARKER_SCROLL_TO', markerId);
      setStatus(markersStatus, 'ページ上のマーカーへ移動しました。');
    });

    window.addEventListener('deepl:workspaceModeChanged', (event) => {
      if (event?.detail?.mode !== 'markers') return;
      refreshMarkers({ markersList, markersStatus }).catch(() => {
        setStatus(markersStatus, 'マーカー一覧の取得に失敗しました。', true);
      });
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== 'MARKER_UPDATED') return;
      refreshMarkers({ markersList, markersStatus }).catch(() => {
        setStatus(markersStatus, 'マーカー一覧の更新に失敗しました。', true);
      });
    });
  }

  window.MarkerFeature = { init };
})();

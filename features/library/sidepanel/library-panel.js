(() => {
  let searchQuery = '';
  let folderFlatList = [];
  let folderTree = [];
  const collapsedFolderIds = new Set();
  let hasInitializedCollapseState = false;
  let openMenuFolderId = null;
  let dragPayload = null;
  let refreshTimer = null;

  async function sendDbOp(operation, payload = {}) {
    return chrome.runtime.sendMessage({
      type: 'DB_OP',
      operation,
      payload,
    });
  }

  function setStatus(statusEl, message, isError = false) {
    statusEl.textContent = message || '';
    statusEl.style.color = isError ? 'var(--error)' : 'var(--text-muted)';
  }

  function normalizeFolderId(folderId) {
    return folderId ? String(folderId) : '';
  }

  function createSiteEntry({ site, depth }) {
    const row = document.createElement('div');
    row.className = 'library-entry library-entry-site';
    row.dataset.entryType = 'site';
    row.dataset.siteId = site.siteId;
    row.draggable = true;
    row.style.marginLeft = `${Math.max(0, depth) * 14}px`;

    const main = document.createElement('div');
    main.className = 'library-entry-main';

    const icon = document.createElement('span');
    icon.className = 'library-entry-sub';
    icon.textContent = '🌐';

    const name = document.createElement('div');
    name.className = 'library-entry-name';
    name.textContent = site.title || site.url || site.siteId;

    const sub = document.createElement('div');
    sub.className = 'library-entry-sub';
    sub.textContent = `メモ ${Number(site.noteCount || 0)} / マーカー ${Number(site.markerCount || 0)}`;

    main.appendChild(icon);
    main.appendChild(name);
    main.appendChild(sub);

    row.appendChild(main);
    return row;
  }

  function createFolderRow({ folderId, name, siteCount, depth, isRoot = false }) {
    const normalizedFolderId = normalizeFolderId(folderId);
    const isCollapsed = collapsedFolderIds.has(normalizedFolderId);
    const row = document.createElement('div');
    row.className = 'library-entry library-entry-folder';
    row.dataset.folderId = normalizedFolderId;
    row.dataset.entryType = 'folder';
    row.draggable = !isRoot;
    row.style.marginLeft = `${Math.max(0, depth) * 14}px`;

    const main = document.createElement('div');
    main.className = 'library-entry-main';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'library-icon-btn';
    toggleBtn.dataset.action = 'toggle-folder';
    toggleBtn.dataset.folderId = normalizedFolderId;
    toggleBtn.title = isCollapsed ? 'フォルダを開く' : 'フォルダを閉じる';
    toggleBtn.textContent = isCollapsed ? '▸' : '▾';
    main.appendChild(toggleBtn);

    const icon = document.createElement('span');
    icon.className = 'library-entry-sub';
    icon.textContent = isRoot ? '📂' : '📁';

    const label = document.createElement('div');
    label.className = 'library-entry-name';
    label.textContent = name;

    const count = document.createElement('div');
    count.className = 'library-entry-sub';
    count.textContent = `${Number(siteCount || 0)}件`;

    main.appendChild(icon);
    main.appendChild(label);
    main.appendChild(count);

    const actions = document.createElement('div');
    actions.className = 'library-entry-actions';

    const addWrap = document.createElement('div');
    addWrap.className = 'library-add-wrap';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'library-icon-btn';
    addBtn.dataset.action = 'toggle-add-menu';
    addBtn.dataset.folderId = normalizedFolderId;
    addBtn.title = '追加';
    addBtn.textContent = '＋';

    const menu = document.createElement('div');
    menu.className = `library-add-menu ${openMenuFolderId === normalizedFolderId ? 'open' : ''}`;
    menu.dataset.folderId = normalizedFolderId;

    const addSiteBtn = document.createElement('button');
    addSiteBtn.type = 'button';
    addSiteBtn.className = 'library-add-menu-btn';
    addSiteBtn.dataset.action = 'add-current-site';
    addSiteBtn.dataset.parentFolderId = normalizedFolderId;
    addSiteBtn.textContent = '現在のサイトを追加';

    const addFolderBtn = document.createElement('button');
    addFolderBtn.type = 'button';
    addFolderBtn.className = 'library-add-menu-btn';
    addFolderBtn.dataset.action = 'create-folder';
    addFolderBtn.dataset.parentFolderId = normalizedFolderId;
    addFolderBtn.textContent = 'フォルダを作成';

    menu.appendChild(addSiteBtn);
    menu.appendChild(addFolderBtn);
    addWrap.appendChild(addBtn);
    addWrap.appendChild(menu);
    actions.appendChild(addWrap);

    if (!isRoot) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'library-icon-btn';
      deleteBtn.dataset.action = 'delete-folder';
      deleteBtn.dataset.folderId = normalizedFolderId;
      deleteBtn.dataset.folderName = name;
      deleteBtn.title = 'フォルダを削除';
      deleteBtn.textContent = '🗑';
      actions.appendChild(deleteBtn);
    }

    row.appendChild(main);
    row.appendChild(actions);
    return row;
  }

  async function renderFolderWithChildren({ parentNode, depth, explorerElement }) {
    const folderId = normalizeFolderId(parentNode.folderId);
    const folderRow = createFolderRow({
      folderId,
      name: parentNode.name || 'Untitled Folder',
      siteCount: parentNode.siteCount || 0,
      depth,
      isRoot: false,
    });
    explorerElement.appendChild(folderRow);

    if (collapsedFolderIds.has(folderId)) {
      return;
    }

    const folderSitesResponse = await sendDbOp('library.listSites', {
      folderId,
      query: searchQuery,
      limit: 800,
    });

    const folderSites = folderSitesResponse?.success && Array.isArray(folderSitesResponse.data)
      ? folderSitesResponse.data
      : [];

    folderSites.forEach((site) => {
      explorerElement.appendChild(createSiteEntry({ site, depth: depth + 1 }));
    });

    const children = Array.isArray(parentNode.children) ? parentNode.children : [];
    for (const child of children) {
      await renderFolderWithChildren({ parentNode: child, depth: depth + 1, explorerElement });
    }
  }

  async function refreshLibraryData({ libraryExplorer, libraryStatus }) {
    const folderResponse = await sendDbOp('folder.list');
    if (!folderResponse?.success) {
      throw new Error(folderResponse?.error || 'フォルダ一覧の取得に失敗しました。');
    }

    folderFlatList = Array.isArray(folderResponse.data?.folders) ? folderResponse.data.folders : [];
    folderTree = Array.isArray(folderResponse.data?.tree) ? folderResponse.data.tree : [];

    if (!hasInitializedCollapseState) {
      collapsedFolderIds.add('');
      folderFlatList.forEach((folder) => {
        collapsedFolderIds.add(normalizeFolderId(folder.folderId));
      });
      hasInitializedCollapseState = true;
    }

    libraryExplorer.innerHTML = '';

    const rootSitesResponse = await sendDbOp('library.listSites', {
      folderId: null,
      query: searchQuery,
      limit: 800,
    });

    if (!rootSitesResponse?.success) {
      throw new Error(rootSitesResponse?.error || 'サイト一覧の取得に失敗しました。');
    }

    const rootSites = Array.isArray(rootSitesResponse.data) ? rootSitesResponse.data : [];
    const rootRow = createFolderRow({
      folderId: null,
      name: '未分類',
      siteCount: rootSites.length,
      depth: 0,
      isRoot: true,
    });

    libraryExplorer.appendChild(rootRow);
    if (!collapsedFolderIds.has('')) {
      rootSites.forEach((site) => {
        libraryExplorer.appendChild(createSiteEntry({ site, depth: 1 }));
      });
    }

    for (const folderNode of folderTree) {
      await renderFolderWithChildren({
        parentNode: folderNode,
        depth: 0,
        explorerElement: libraryExplorer,
      });
    }

    setStatus(libraryStatus, `${rootSites.length}件(未分類) / フォルダ${folderFlatList.length}件`);
  }

  function scheduleRefresh(elements) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshLibraryData(elements).catch((error) => {
        setStatus(elements.libraryStatus, error.message || '一覧更新に失敗しました。', true);
      });
    }, 220);
  }

  async function getActivePageContext() {
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const activeTab = tabs?.[0];
      if (!activeTab?.id) {
        return null;
      }

      return {
        url: String(activeTab.url || '').trim(),
        title: String(activeTab.title || '').trim(),
      };
    } catch {
      return null;
    }
  }

  function clearDropTargetHighlights(container) {
    container
      .querySelectorAll('.library-drop-target')
      .forEach((el) => el.classList.remove('library-drop-target'));
  }

  function closestFolderTarget(event) {
    return event.target.closest('.library-entry-folder');
  }

  async function handleDropOnFolderRow({ targetRow, libraryStatus, elements }) {
    if (!dragPayload || !targetRow) return;

    const targetFolderId = normalizeFolderId(targetRow.dataset.folderId) || null;

    if (dragPayload.type === 'site') {
      const response = await sendDbOp('library.moveSite', {
        siteId: dragPayload.siteId,
        targetFolderId,
      });

      if (!response?.success) {
        setStatus(libraryStatus, response?.error || 'サイト移動に失敗しました。', true);
        return;
      }

      await refreshLibraryData(elements);
      setStatus(libraryStatus, 'サイトを移動しました。');
      return;
    }

    if (dragPayload.type === 'folder') {
      if (!dragPayload.folderId) return;

      const response = await sendDbOp('folder.move', {
        folderId: dragPayload.folderId,
        targetParentFolderId: targetFolderId,
      });

      if (!response?.success) {
        setStatus(libraryStatus, response?.error || 'フォルダ移動に失敗しました。', true);
        return;
      }

      await refreshLibraryData(elements);
      setStatus(libraryStatus, 'フォルダを移動しました。');
    }
  }

  function init() {
    const libraryWorkspace = document.getElementById('libraryWorkspace');
    const libraryExplorer = document.getElementById('libraryExplorer');
    const librarySearchInput = document.getElementById('librarySearchInput');
    const libraryStatus = document.getElementById('libraryStatus');

    if (!libraryWorkspace || !libraryExplorer || !librarySearchInput || !libraryStatus) {
      return;
    }

    const elements = {
      libraryExplorer,
      libraryStatus,
    };

    libraryExplorer.addEventListener('dragstart', (event) => {
      const row = event.target.closest('.library-entry');
      if (!row || row.draggable !== true) {
        dragPayload = null;
        return;
      }

      const entryType = row.dataset.entryType;
      if (entryType === 'site') {
        dragPayload = {
          type: 'site',
          siteId: row.dataset.siteId,
        };
      } else if (entryType === 'folder') {
        const folderId = normalizeFolderId(row.dataset.folderId);
        if (!folderId) {
          dragPayload = null;
          return;
        }

        dragPayload = {
          type: 'folder',
          folderId,
        };
      } else {
        dragPayload = null;
      }

      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', JSON.stringify(dragPayload || {}));
      }
    });

    libraryExplorer.addEventListener('dragend', () => {
      dragPayload = null;
      clearDropTargetHighlights(libraryExplorer);
    });

    libraryExplorer.addEventListener('dragover', (event) => {
      const folderRow = closestFolderTarget(event);
      if (!folderRow || !dragPayload) return;
      event.preventDefault();
      clearDropTargetHighlights(libraryExplorer);
      folderRow.classList.add('library-drop-target');
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
    });

    libraryExplorer.addEventListener('dragleave', (event) => {
      const folderRow = closestFolderTarget(event);
      if (!folderRow) return;

      const nextTarget = event.relatedTarget;
      if (nextTarget && folderRow.contains(nextTarget)) {
        return;
      }

      folderRow.classList.remove('library-drop-target');
    });

    libraryExplorer.addEventListener('drop', async (event) => {
      const folderRow = closestFolderTarget(event);
      if (!folderRow || !dragPayload) return;
      event.preventDefault();
      clearDropTargetHighlights(libraryExplorer);

      await handleDropOnFolderRow({
        targetRow: folderRow,
        libraryStatus,
        elements,
      });
      dragPayload = null;
    });

    libraryExplorer.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (button) {
        const action = button.dataset.action;
        if (action === 'toggle-add-menu') {
          const folderId = normalizeFolderId(button.dataset.folderId);
          openMenuFolderId = openMenuFolderId === folderId ? null : folderId;
          await refreshLibraryData(elements);
          return;
        }

        if (action === 'toggle-folder') {
          const folderId = normalizeFolderId(button.dataset.folderId);
          if (collapsedFolderIds.has(folderId)) {
            collapsedFolderIds.delete(folderId);
          } else {
            collapsedFolderIds.add(folderId);
          }

          await refreshLibraryData(elements);
          return;
        }

        if (action === 'delete-folder') {
          const folderId = button.dataset.folderId;
          const folderName = button.dataset.folderName || 'フォルダ';
          const confirmed = window.confirm(`「${folderName}」を削除します。配下サイトは未分類へ移動されます。`);
          if (!confirmed) return;

          const response = await sendDbOp('folder.delete', { folderId });
          if (!response?.success) {
            setStatus(libraryStatus, response?.error || 'フォルダの削除に失敗しました。', true);
            return;
          }

          openMenuFolderId = null;
          if (response.data?.folder?.folderId) {
            collapsedFolderIds.add(normalizeFolderId(response.data.folder.folderId));
          }
          await refreshLibraryData(elements);
          setStatus(libraryStatus, 'フォルダを削除しました。');
          return;
        }

        if (action === 'add-current-site') {
          const page = await getActivePageContext();
          const siteUrl = String(page?.url || '').trim();
          const siteTitle = String(page?.title || '').trim();

          if (!siteUrl) {
            setStatus(libraryStatus, '現在のページ情報を取得できません。', true);
            return;
          }

          const response = await sendDbOp('library.createSiteFolder', {
            url: siteUrl,
            title: siteTitle,
            parentFolderId: button.dataset.parentFolderId || null,
          });

          if (!response?.success) {
            setStatus(libraryStatus, response?.error || 'サイトフォルダの作成に失敗しました。', true);
            return;
          }

          openMenuFolderId = null;
          await refreshLibraryData(elements);
          setStatus(
            libraryStatus,
            response.data?.created ? 'サイトフォルダを作成しました。' : '既存のサイトフォルダを利用しました。'
          );
          return;
        }

        if (action === 'create-folder') {
          const nextName = window.prompt('フォルダ名を入力してください');
          if (!String(nextName || '').trim()) return;

          const response = await sendDbOp('folder.create', {
            name: String(nextName || '').trim(),
            parentFolderId: button.dataset.parentFolderId || null,
          });

          if (!response?.success) {
            setStatus(libraryStatus, response?.error || 'フォルダの作成に失敗しました。', true);
            return;
          }

          openMenuFolderId = null;
          if (response.data?.folderId) {
            collapsedFolderIds.add(normalizeFolderId(response.data.folderId));
          }
          await refreshLibraryData(elements);
          setStatus(libraryStatus, 'フォルダを作成しました。');
        }
      }
    });

    document.addEventListener('click', (event) => {
      if (!libraryWorkspace.classList.contains('hidden') && !event.target.closest('.library-add-wrap')) {
        if (openMenuFolderId !== null) {
          openMenuFolderId = null;
          scheduleRefresh(elements);
        }
      }
    });

    librarySearchInput.addEventListener('input', () => {
      searchQuery = String(librarySearchInput.value || '').trim();
      scheduleRefresh(elements);
    });

    window.addEventListener('deepl:workspaceModeChanged', (event) => {
      if (event?.detail?.mode !== 'library') return;
      refreshLibraryData(elements).catch((error) => {
        setStatus(libraryStatus, error.message || 'ライブラリーの更新に失敗しました。', true);
      });
    });

    refreshLibraryData(elements).catch((error) => {
      setStatus(libraryStatus, error.message || 'ライブラリーの更新に失敗しました。', true);
    });
  }

  window.LibraryFeature = { init };
})();

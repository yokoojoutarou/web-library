(() => {
  let selectedFolderId = null;
  let searchQuery = '';
  let folderFlatList = [];
  let folderTree = [];
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

  function folderLabel(folderId) {
    if (!folderId) return '未分類';
    const folder = folderFlatList.find((item) => item.folderId === folderId);
    return folder?.name || '未分類';
  }

  function renderFolderTree({ libraryTree, currentFolderLabel }) {
    libraryTree.innerHTML = '';

    const uncategorizedRow = document.createElement('div');
    uncategorizedRow.className = `library-folder-row ${!selectedFolderId ? 'active' : ''}`;
    uncategorizedRow.dataset.folderId = '';

    const uncategorizedMain = document.createElement('div');
    uncategorizedMain.className = 'library-folder-main';

    const uncategorizedName = document.createElement('div');
    uncategorizedName.className = 'library-folder-name';
    uncategorizedName.textContent = '未分類';

    uncategorizedMain.appendChild(uncategorizedName);
    uncategorizedRow.appendChild(uncategorizedMain);
    libraryTree.appendChild(uncategorizedRow);

    const appendRows = (nodes, depth) => {
      nodes.forEach((node) => {
        const row = document.createElement('div');
        row.className = `library-folder-row ${selectedFolderId === node.folderId ? 'active' : ''}`;
        row.dataset.folderId = node.folderId;

        const main = document.createElement('div');
        main.className = 'library-folder-main';
        main.style.paddingLeft = `${Math.max(0, depth) * 12}px`;

        const name = document.createElement('div');
        name.className = 'library-folder-name';
        name.textContent = node.name || 'Untitled Folder';

        const count = document.createElement('div');
        count.className = 'library-folder-count';
        count.textContent = `${Number(node.siteCount || 0)}件`;

        main.appendChild(name);
        main.appendChild(count);

        const actions = document.createElement('div');
        actions.className = 'library-folder-actions';

        const renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'library-icon-btn';
        renameBtn.dataset.action = 'rename';
        renameBtn.dataset.folderId = node.folderId;
        renameBtn.dataset.folderName = node.name || '';
        renameBtn.title = 'フォルダ名を変更';
        renameBtn.textContent = '✎';

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'library-icon-btn';
        deleteBtn.dataset.action = 'delete';
        deleteBtn.dataset.folderId = node.folderId;
        deleteBtn.dataset.folderName = node.name || '';
        deleteBtn.title = 'フォルダを削除';
        deleteBtn.textContent = '🗑';

        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);

        row.appendChild(main);
        row.appendChild(actions);
        libraryTree.appendChild(row);

        if (Array.isArray(node.children) && node.children.length > 0) {
          appendRows(node.children, depth + 1);
        }
      });
    };

    appendRows(folderTree, 0);
    currentFolderLabel.textContent = folderLabel(selectedFolderId);
  }

  function renderSiteList({ librarySiteList, sites, libraryStatus }) {
    librarySiteList.innerHTML = '';

    if (!Array.isArray(sites) || sites.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'thread-item-meta';
      empty.textContent = '該当するサイトがありません。';
      librarySiteList.appendChild(empty);
      setStatus(libraryStatus, '一覧を更新しました。');
      return;
    }

    const sortedFolders = [...folderFlatList].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    sites.forEach((site) => {
      const item = document.createElement('div');
      item.className = 'library-site-item';
      item.dataset.siteId = site.siteId;

      const title = document.createElement('div');
      title.className = 'library-site-title';
      title.textContent = site.title || site.url || site.siteId;

      const url = document.createElement('div');
      url.className = 'library-site-url';
      url.textContent = site.url || '';

      const meta = document.createElement('div');
      meta.className = 'library-site-meta';

      const counts = document.createElement('div');
      counts.className = 'library-site-counts';
      counts.textContent = `メモ ${Number(site.noteCount || 0)} / マーカー ${Number(site.markerCount || 0)}`;

      const moveSelect = document.createElement('select');
      moveSelect.className = 'library-move-select';
      moveSelect.dataset.action = 'move-site';
      moveSelect.dataset.siteId = site.siteId;

      const unclassifiedOption = document.createElement('option');
      unclassifiedOption.value = '';
      unclassifiedOption.textContent = '未分類';
      moveSelect.appendChild(unclassifiedOption);

      sortedFolders.forEach((folder) => {
        const option = document.createElement('option');
        option.value = folder.folderId;
        option.textContent = folder.name;
        moveSelect.appendChild(option);
      });

      moveSelect.value = site.folderId || '';

      meta.appendChild(counts);
      meta.appendChild(moveSelect);

      item.appendChild(title);
      item.appendChild(url);
      item.appendChild(meta);
      librarySiteList.appendChild(item);
    });

    setStatus(libraryStatus, `${sites.length}件のサイトを表示`);
  }

  async function refreshLibraryData({ libraryTree, currentFolderLabel, librarySiteList, libraryStatus }) {
    const folderResponse = await sendDbOp('folder.list');
    if (!folderResponse?.success) {
      throw new Error(folderResponse?.error || 'フォルダ一覧の取得に失敗しました。');
    }

    folderFlatList = Array.isArray(folderResponse.data?.folders) ? folderResponse.data.folders : [];
    folderTree = Array.isArray(folderResponse.data?.tree) ? folderResponse.data.tree : [];

    const selectedExists = !selectedFolderId || folderFlatList.some((folder) => folder.folderId === selectedFolderId);
    if (!selectedExists) {
      selectedFolderId = null;
    }

    renderFolderTree({ libraryTree, currentFolderLabel });

    const sitesResponse = await sendDbOp('library.listSites', {
      folderId: selectedFolderId,
      query: searchQuery,
      limit: 800,
    });

    if (!sitesResponse?.success) {
      throw new Error(sitesResponse?.error || 'サイト一覧の取得に失敗しました。');
    }

    renderSiteList({
      librarySiteList,
      sites: Array.isArray(sitesResponse.data) ? sitesResponse.data : [],
      libraryStatus,
    });
  }

  function scheduleRefresh(elements) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshLibraryData(elements).catch((error) => {
        setStatus(elements.libraryStatus, error.message || '一覧更新に失敗しました。', true);
      });
    }, 220);
  }

  function init() {
    const libraryWorkspace = document.getElementById('libraryWorkspace');
    const libraryTree = document.getElementById('libraryTree');
    const libraryAddFolderBtn = document.getElementById('libraryAddFolderBtn');
    const librarySearchInput = document.getElementById('librarySearchInput');
    const librarySiteList = document.getElementById('librarySiteList');
    const libraryCurrentFolder = document.getElementById('libraryCurrentFolder');
    const libraryStatus = document.getElementById('libraryStatus');

    if (!libraryWorkspace || !libraryTree || !libraryAddFolderBtn || !librarySearchInput || !librarySiteList || !libraryCurrentFolder || !libraryStatus) {
      return;
    }

    const elements = {
      libraryTree,
      currentFolderLabel: libraryCurrentFolder,
      librarySiteList,
      libraryStatus,
    };

    libraryAddFolderBtn.addEventListener('click', async () => {
      const promptName = window.prompt('フォルダ名を入力してください');
      const name = String(promptName || '').trim();
      if (!name) return;

      const response = await sendDbOp('folder.create', {
        name,
        parentFolderId: selectedFolderId || null,
      });

      if (!response?.success) {
        setStatus(libraryStatus, response?.error || 'フォルダの作成に失敗しました。', true);
        return;
      }

      selectedFolderId = response.data?.folderId || selectedFolderId;
      await refreshLibraryData(elements);
      setStatus(libraryStatus, 'フォルダを作成しました。');
    });

    libraryTree.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (button) {
        const action = button.dataset.action;
        const folderId = button.dataset.folderId;
        const folderName = button.dataset.folderName || 'フォルダ';

        if (!folderId) return;

        if (action === 'rename') {
          const nextName = window.prompt('新しいフォルダ名を入力してください', folderName);
          if (!String(nextName || '').trim()) return;

          const response = await sendDbOp('folder.rename', {
            folderId,
            name: String(nextName || '').trim(),
          });

          if (!response?.success) {
            setStatus(libraryStatus, response?.error || 'フォルダ名の変更に失敗しました。', true);
            return;
          }

          await refreshLibraryData(elements);
          setStatus(libraryStatus, 'フォルダ名を変更しました。');
          return;
        }

        if (action === 'delete') {
          const confirmed = window.confirm(`「${folderName}」を削除します。配下サイトは未分類へ移動されます。`);
          if (!confirmed) return;

          const response = await sendDbOp('folder.delete', { folderId });
          if (!response?.success) {
            setStatus(libraryStatus, response?.error || 'フォルダの削除に失敗しました。', true);
            return;
          }

          if (selectedFolderId === folderId) {
            selectedFolderId = null;
          }

          await refreshLibraryData(elements);
          setStatus(libraryStatus, 'フォルダを削除しました。');
        }
        return;
      }

      const row = event.target.closest('.library-folder-row');
      if (!row) return;

      selectedFolderId = row.dataset.folderId || null;
      await refreshLibraryData(elements);
    });

    librarySiteList.addEventListener('change', async (event) => {
      const moveSelect = event.target.closest('select[data-action="move-site"]');
      if (!moveSelect) return;

      const siteId = moveSelect.dataset.siteId;
      if (!siteId) return;

      const response = await sendDbOp('library.moveSite', {
        siteId,
        targetFolderId: moveSelect.value || null,
      });

      if (!response?.success) {
        setStatus(libraryStatus, response?.error || 'サイト移動に失敗しました。', true);
        return;
      }

      await refreshLibraryData(elements);
      setStatus(libraryStatus, 'サイトを移動しました。');
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

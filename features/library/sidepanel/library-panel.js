(() => {
  let searchQuery = '';
  let folderFlatList = [];
  let folderTree = [];
  const collapsedFolderIds = new Set();
  let hasInitializedCollapseState = false;
  let openMenuFolderId = null;
  let dragPayload = null;
  let dragPreviewElement = null;
  let draggingElement = null;
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

  function isSystemFolderNode(folderLike) {
    return Boolean(folderLike?.isSystem) || String(folderLike?.systemType || '').length > 0;
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

  function createNoteEntry({ note, depth }) {
    const row = document.createElement('div');
    row.className = 'library-entry library-entry-note';
    row.dataset.entryType = 'note';
    row.dataset.noteId = note.noteId;
    row.dataset.siteId = note.siteId;
    row.draggable = true;
    row.style.marginLeft = `${Math.max(0, depth) * 14}px`;

    const main = document.createElement('div');
    main.className = 'library-entry-main';

    const icon = document.createElement('span');
    icon.className = 'library-entry-sub';
    icon.textContent = '📝';

    const name = document.createElement('div');
    name.className = 'library-entry-name';
    name.textContent = note.title || 'Untitled Note';

    const sub = document.createElement('div');
    sub.className = 'library-entry-sub';
    sub.textContent = note.siteTitle ? `Site: ${note.siteTitle}` : 'Site: -';

    main.appendChild(icon);
    main.appendChild(name);
    main.appendChild(sub);

    row.appendChild(main);
    return row;
  }

  function createFolderRow({ folderId, name, siteCount, depth, isRoot = false, isSystem = false }) {
    const normalizedFolderId = normalizeFolderId(folderId);
    const isCollapsed = collapsedFolderIds.has(normalizedFolderId);
    const row = document.createElement('div');
    row.className = 'library-entry library-entry-folder';
    row.dataset.folderId = normalizedFolderId;
    row.dataset.entryType = 'folder';
    row.dataset.isSystem = isSystem ? '1' : '0';
    row.draggable = !isRoot && !isSystem;
    row.style.marginLeft = `${Math.max(0, depth) * 14}px`;

    const main = document.createElement('div');
    main.className = 'library-entry-main';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'library-icon-btn';
    toggleBtn.dataset.action = 'toggle-folder';
    toggleBtn.dataset.folderId = normalizedFolderId;
    toggleBtn.title = isCollapsed ? 'フォルダを開く' : 'フォルダを閉じる';
    toggleBtn.setAttribute('aria-label', isCollapsed ? 'フォルダを開く' : 'フォルダを閉じる');
    toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
    toggleBtn.textContent = isCollapsed ? '▸' : '▾';
    main.appendChild(toggleBtn);

    const icon = document.createElement('span');
    icon.className = 'library-entry-sub';
    icon.textContent = isRoot || isSystem ? '📂' : '📁';

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

    if (!isRoot && !isSystem) {
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'library-icon-btn library-folder-action-btn';
      renameBtn.dataset.action = 'rename-folder';
      renameBtn.dataset.folderId = normalizedFolderId;
      renameBtn.dataset.folderName = name;
      renameBtn.title = 'フォルダ名を変更';
      renameBtn.setAttribute('aria-label', 'フォルダ名を変更');
      renameBtn.textContent = '✎';
      actions.appendChild(renameBtn);
    }

    if (!isSystem) {
      const addWrap = document.createElement('div');
      addWrap.className = 'library-add-wrap';

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'library-icon-btn library-folder-action-btn';
      addBtn.dataset.action = 'toggle-add-menu';
      addBtn.dataset.folderId = normalizedFolderId;
      addBtn.title = '追加';
      addBtn.setAttribute('aria-label', openMenuFolderId === normalizedFolderId ? '追加メニューを閉じる' : '追加メニューを開く');
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

      const addNoteBtn = document.createElement('button');
      addNoteBtn.type = 'button';
      addNoteBtn.className = 'library-add-menu-btn';
      addNoteBtn.dataset.action = 'add-note';
      addNoteBtn.dataset.parentFolderId = normalizedFolderId;
      addNoteBtn.textContent = 'メモを追加';

      menu.appendChild(addSiteBtn);
      menu.appendChild(addFolderBtn);
      menu.appendChild(addNoteBtn);
      addWrap.appendChild(addBtn);
      addWrap.appendChild(menu);
      actions.appendChild(addWrap);
    }

    row.appendChild(main);
    row.appendChild(actions);
    return row;
  }

  async function renderFolderWithChildren({ parentNode, depth, explorerElement, folderSitesByFolder, folderNotesByFolder }) {
    const folderId = normalizeFolderId(parentNode.folderId);
    const folderRow = createFolderRow({
      folderId,
      name: parentNode.name || 'Untitled Folder',
      siteCount: parentNode.siteCount || 0,
      depth,
      isRoot: false,
      isSystem: isSystemFolderNode(parentNode),
    });
    explorerElement.appendChild(folderRow);

    if (collapsedFolderIds.has(folderId)) {
      return;
    }

    const folderSites = Array.isArray(folderSitesByFolder?.[folderId])
      ? folderSitesByFolder[folderId]
      : [];

    const folderNotes = Array.isArray(folderNotesByFolder?.[folderId])
      ? folderNotesByFolder[folderId]
      : [];

    folderSites.forEach((site) => {
      explorerElement.appendChild(createSiteEntry({ site, depth: depth + 1 }));
    });

    folderNotes.forEach((note) => {
      explorerElement.appendChild(createNoteEntry({ note, depth: depth + 1 }));
    });

    const children = Array.isArray(parentNode.children) ? parentNode.children : [];
    for (const child of children) {
      await renderFolderWithChildren({
        parentNode: child,
        depth: depth + 1,
        explorerElement,
        folderSitesByFolder,
        folderNotesByFolder,
      });
    }
  }

  async function refreshLibraryData({ libraryExplorer, libraryStatus }) {
    const snapshotResponse = await sendDbOp('library.snapshot', {
      query: searchQuery,
      limitPerFolder: 800,
    });
    if (!snapshotResponse?.success) {
      throw new Error(snapshotResponse?.error || 'ライブラリースナップショットの取得に失敗しました。');
    }

    folderFlatList = Array.isArray(snapshotResponse.data?.folders) ? snapshotResponse.data.folders : [];
    folderTree = Array.isArray(snapshotResponse.data?.tree) ? snapshotResponse.data.tree : [];
    const folderSitesByFolder = snapshotResponse.data?.folderSites || {};
    const folderNotesByFolder = snapshotResponse.data?.folderNotes || {};

    if (!hasInitializedCollapseState) {
      folderFlatList.forEach((folder) => {
        if (!isSystemFolderNode(folder)) {
          collapsedFolderIds.add(normalizeFolderId(folder.folderId));
        }
      });
      hasInitializedCollapseState = true;
    }

    libraryExplorer.innerHTML = '';

    for (const folderNode of folderTree) {
      await renderFolderWithChildren({
        parentNode: folderNode,
        depth: 0,
        explorerElement: libraryExplorer,
        folderSitesByFolder,
        folderNotesByFolder,
      });
    }

    const totalSites = Number(snapshotResponse.data?.summary?.siteCount || 0);
    const totalNotes = Number(snapshotResponse.data?.summary?.noteCount || 0);
    setStatus(
      libraryStatus,
      `フォルダ${folderFlatList.length}件 / サイト${totalSites}件 / メモ${totalNotes}件`
    );
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
      .querySelectorAll('.library-drop-target, .library-trash-drop-target')
      .forEach((el) => {
        el.classList.remove('library-drop-target');
        el.classList.remove('library-trash-drop-target');
      });
  }

  function closestFolderTarget(event) {
    return event.target.closest('.library-entry-folder');
  }

  async function openSiteUrl(siteUrl) {
    const url = String(siteUrl || '').trim();
    if (!url) {
      throw new Error('URLが見つかりません。');
    }

    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTab = tabs?.[0];

    if (activeTab?.id) {
      await chrome.tabs.update(activeTab.id, { url });
      return;
    }

    await chrome.tabs.create({ url });
  }

  function clearDragPreview() {
    if (draggingElement) {
      draggingElement.classList.remove('library-dragging');
      draggingElement = null;
    }

    if (dragPreviewElement) {
      dragPreviewElement.remove();
      dragPreviewElement = null;
    }
  }

  function createDragPreview(row) {
    clearDragPreview();
    const rect = row.getBoundingClientRect();
    const clone = row.cloneNode(true);
    clone.style.position = 'fixed';
    clone.style.top = '-9999px';
    clone.style.left = '-9999px';
    clone.style.width = `${Math.ceil(rect.width)}px`;
    clone.style.marginLeft = '0';
    clone.style.pointerEvents = 'none';
    clone.style.opacity = '0.95';
    clone.style.zIndex = '99999';
    document.body.appendChild(clone);
    dragPreviewElement = clone;
    draggingElement = row;
    row.classList.add('library-dragging');
    return {
      x: Math.min(24, Math.max(8, Math.round(rect.width * 0.15))),
      y: Math.round(rect.height / 2),
    };
  }

  async function handleDropOnFolderRow({ targetRow, libraryStatus, elements }) {
    if (!dragPayload || !targetRow) return;

    const targetIsSystem = targetRow.dataset.isSystem === '1';
    if (targetIsSystem && dragPayload.type === 'folder') {
      setStatus(libraryStatus, 'システムフォルダ配下へフォルダは移動できません。', true);
      return;
    }

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

    if (dragPayload.type === 'note') {
      const siteId = String(dragPayload.siteId || '').trim();
      if (!siteId) return;

      const response = await sendDbOp('library.moveSite', {
        siteId,
        targetFolderId,
      });

      if (!response?.success) {
        setStatus(libraryStatus, response?.error || 'メモ移動に失敗しました。', true);
        return;
      }

      await refreshLibraryData(elements);
      setStatus(libraryStatus, 'メモを移動しました。');
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

  async function handleDropOnTrash({ libraryStatus, elements }) {
    if (!dragPayload) return;

    if (dragPayload.type === 'folder') {
      const folderId = String(dragPayload.folderId || '').trim();
      if (!folderId) return;
      const response = await sendDbOp('folder.delete', { folderId });
      if (!response?.success) {
        setStatus(libraryStatus, response?.error || 'フォルダ削除に失敗しました。', true);
        return;
      }

      await refreshLibraryData(elements);
      setStatus(libraryStatus, 'フォルダを削除しました。');
      return;
    }

    if (dragPayload.type === 'site') {
      const siteId = String(dragPayload.siteId || '').trim();
      if (!siteId) return;
      const response = await sendDbOp('site.delete', { siteId });
      if (!response?.success || response.data !== true) {
        setStatus(libraryStatus, response?.error || 'サイト削除に失敗しました。', true);
        return;
      }

      await refreshLibraryData(elements);
      setStatus(libraryStatus, 'サイトを削除しました。');
      return;
    }

    if (dragPayload.type === 'note') {
      const noteId = String(dragPayload.noteId || '').trim();
      if (!noteId) return;
      const response = await sendDbOp('note.delete', { noteId });
      if (!response?.success || response.data !== true) {
        setStatus(libraryStatus, response?.error || 'メモ削除に失敗しました。', true);
        return;
      }

      await refreshLibraryData(elements);
      setStatus(libraryStatus, 'メモを削除しました。');
    }
  }

  function init() {
    const libraryWorkspace = document.getElementById('libraryWorkspace');
    const libraryExplorer = document.getElementById('libraryExplorer');
    const libraryTrash = document.getElementById('libraryTrash');
    const librarySearchInput = document.getElementById('librarySearchInput');
    const libraryCreateFolderBtn = document.getElementById('libraryCreateFolderBtn');
    const libraryStatus = document.getElementById('libraryStatus');

    if (!libraryWorkspace || !libraryExplorer || !libraryTrash || !librarySearchInput || !libraryCreateFolderBtn || !libraryStatus) {
      return;
    }

    const elements = {
      libraryExplorer,
      libraryStatus,
    };

    libraryExplorer.addEventListener('dragstart', (event) => {
      const row = event.target.closest('.library-entry');
      if (!row || row.draggable !== true) {
        clearDragPreview();
        dragPayload = null;
        return;
      }

      const entryType = row.dataset.entryType;
      if (entryType === 'site') {
        dragPayload = {
          type: 'site',
          siteId: row.dataset.siteId,
        };
      } else if (entryType === 'note') {
        dragPayload = {
          type: 'note',
          noteId: row.dataset.noteId,
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
        clearDragPreview();
        dragPayload = null;
      }

      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', JSON.stringify(dragPayload || {}));
        if (dragPayload) {
          const dragImageOffset = createDragPreview(row);
          if (dragPreviewElement) {
            event.dataTransfer.setDragImage(dragPreviewElement, dragImageOffset.x, dragImageOffset.y);
          }
        }
      }
    });

    libraryExplorer.addEventListener('dragend', () => {
      dragPayload = null;
      clearDragPreview();
      clearDropTargetHighlights(libraryWorkspace);
    });

    libraryExplorer.addEventListener('dragover', (event) => {
      const folderRow = closestFolderTarget(event);
      if (!folderRow || !dragPayload) return;
      event.preventDefault();
      clearDropTargetHighlights(libraryWorkspace);
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
      clearDragPreview();
      clearDropTargetHighlights(libraryWorkspace);

      await handleDropOnFolderRow({
        targetRow: folderRow,
        libraryStatus,
        elements,
      });
      dragPayload = null;
    });

    libraryTrash.addEventListener('dragover', (event) => {
      if (!dragPayload) return;
      event.preventDefault();
      clearDropTargetHighlights(libraryWorkspace);
      libraryTrash.classList.add('library-trash-drop-target');
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
    });

    libraryTrash.addEventListener('dragleave', (event) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget && libraryTrash.contains(nextTarget)) {
        return;
      }
      libraryTrash.classList.remove('library-trash-drop-target');
    });

    libraryTrash.addEventListener('drop', async (event) => {
      if (!dragPayload) return;
      event.preventDefault();
      clearDragPreview();
      clearDropTargetHighlights(libraryWorkspace);
      await handleDropOnTrash({ libraryStatus, elements });
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

        if (action === 'add-note') {
          const page = await getActivePageContext();
          const siteUrl = String(page?.url || '').trim();
          const siteTitle = String(page?.title || '').trim();

          if (!siteUrl) {
            setStatus(libraryStatus, '現在のページ情報を取得できません。', true);
            return;
          }

          await sendDbOp('library.createSiteFolder', {
            url: siteUrl,
            title: siteTitle,
            parentFolderId: button.dataset.parentFolderId || null,
          });

          const noteResponse = await sendDbOp('note.upsert', {
            url: siteUrl,
            title: siteTitle,
            markdown: '',
          });

          if (!noteResponse?.success || !noteResponse.data?.noteId) {
            setStatus(libraryStatus, 'メモの作成に失敗しました。', true);
            return;
          }

          openMenuFolderId = null;

          const notesModeButton = document.getElementById('modeNotesBtn');
          if (notesModeButton) {
            notesModeButton.click();
          }

          window.dispatchEvent(new CustomEvent('deepl:openNoteFromLibrary', {
            detail: { noteId: noteResponse.data.noteId },
          }));
          setStatus(libraryStatus, 'メモを作成しました。');
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
          return;
        }

        if (action === 'rename-folder') {
          const folderId = normalizeFolderId(button.dataset.folderId);
          if (!folderId) return;

          const currentName = String(button.dataset.folderName || '').trim();
          const nextName = window.prompt('新しいフォルダ名を入力してください', currentName);
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

        return;
      }

      const row = event.target.closest('.library-entry');
      if (!row) return;

      const entryType = row.dataset.entryType;
      if (entryType === 'folder') {
        const folderId = normalizeFolderId(row.dataset.folderId);
        if (collapsedFolderIds.has(folderId)) {
          collapsedFolderIds.delete(folderId);
        } else {
          collapsedFolderIds.add(folderId);
        }

        await refreshLibraryData(elements);
        return;
      }

      if (entryType === 'site') {
        try {
          const siteId = String(row.dataset.siteId || '');
          const site = await sendDbOp('site.getByUrl', { url: siteId });
          const url = site?.success ? String(site.data?.url || '') : '';
          await openSiteUrl(url || siteId);
          setStatus(libraryStatus, 'サイトを開きました。');
        } catch (error) {
          setStatus(libraryStatus, error?.message || 'サイトを開けませんでした。', true);
        }
        return;
      }

      if (entryType === 'note') {
        const noteId = String(row.dataset.noteId || '').trim();
        if (!noteId) {
          setStatus(libraryStatus, 'メモIDが見つかりません。', true);
          return;
        }

        const notesModeButton = document.getElementById('modeNotesBtn');
        if (notesModeButton) {
          notesModeButton.click();
        }

        window.dispatchEvent(new CustomEvent('deepl:openNoteFromLibrary', {
          detail: { noteId },
        }));
        setStatus(libraryStatus, 'メモを開きました。');
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

    libraryCreateFolderBtn.addEventListener('click', async () => {
      const nextName = window.prompt('フォルダ名を入力してください');
      if (!String(nextName || '').trim()) return;

      const response = await sendDbOp('folder.create', {
        name: String(nextName || '').trim(),
        parentFolderId: null,
      });

      if (!response?.success) {
        setStatus(libraryStatus, response?.error || 'フォルダの作成に失敗しました。', true);
        return;
      }

      if (response.data?.folderId) {
        collapsedFolderIds.add(normalizeFolderId(response.data.folderId));
      }

      await refreshLibraryData(elements);
      setStatus(libraryStatus, 'フォルダを作成しました。');
    });

    window.addEventListener('deepl:workspaceModeChanged', (event) => {
      if (event?.detail?.mode !== 'library') return;
      refreshLibraryData(elements).catch((error) => {
        setStatus(libraryStatus, error.message || 'ライブラリーの更新に失敗しました。', true);
      });
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== 'LIBRARY_UPDATED') return;
      scheduleRefresh(elements);
    });

    refreshLibraryData(elements).catch((error) => {
      setStatus(libraryStatus, error.message || 'ライブラリーの更新に失敗しました。', true);
    });
  }

  window.LibraryFeature = { init };
})();

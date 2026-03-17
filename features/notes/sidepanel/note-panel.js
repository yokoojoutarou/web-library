(() => {
  let activePageUrl = '';
  let activePageTitle = '';
  let currentNoteId = null;
  let currentSourceLinks = [];
  let currentPageNotes = [];
  let allNotes = [];
  let latestSelectedText = '';
  let autoSaveTimer = null;
  let isSaving = false;

  const markdownRenderer = typeof window.markdownit === 'function'
    ? window.markdownit({
        html: false,
        linkify: true,
        breaks: true,
      })
    : null;

  if (markdownRenderer && typeof window.markdownitMultimdTable === 'function') {
    markdownRenderer.use(window.markdownitMultimdTable, {
      multiline: true,
      rowspan: true,
      headerless: true,
      multibody: true,
      autolabel: true,
    });
  }

  async function sendDbOp(operation, payload = {}) {
    return chrome.runtime.sendMessage({
      type: 'DB_OP',
      operation,
      payload,
    });
  }

  function parseTags(rawTags) {
    return String(rawTags || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .filter((item, index, arr) => arr.indexOf(item) === index);
  }

  function formatTags(tags) {
    return Array.isArray(tags) ? tags.join(', ') : '';
  }

  function deriveNoteTitle(markdown) {
    const text = String(markdown || '')
      .replace(/^#+\s*/gm, '')
      .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
      .replace(/[>*_`~\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) return 'Untitled Note';
    return text.length > 32 ? `${text.slice(0, 31)}…` : text;
  }

  function renderPreview(previewElement, markdown) {
    const text = String(markdown || '');
    if (!text.trim()) {
      previewElement.innerHTML = '<span class="placeholder-text">Preview will appear here...</span>';
      return;
    }

    previewElement.innerHTML = markdownRenderer
      ? markdownRenderer.render(text)
      : text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>');
  }

  function setSingleSheetMode({ notesSheetTitle, notesMarkdownInput, notesPreview, isEditing }) {
    if (isEditing) {
      notesSheetTitle.textContent = 'Editing';
      notesMarkdownInput.classList.remove('hidden');
      notesPreview.classList.add('hidden');
      return;
    }

    notesSheetTitle.textContent = 'Preview';
    notesMarkdownInput.classList.add('hidden');
    notesPreview.classList.remove('hidden');
  }

  function updateModeBySelection({ notesSheetTitle, notesMarkdownInput, notesPreview }) {
    const hasSelection = notesMarkdownInput.selectionStart !== notesMarkdownInput.selectionEnd;
    const isFocused = document.activeElement === notesMarkdownInput;
    setSingleSheetMode({
      notesSheetTitle,
      notesMarkdownInput,
      notesPreview,
      isEditing: isFocused || hasSelection,
    });
  }

  function setStatus(notesStatus, message, isError = false) {
    notesStatus.textContent = message || '';
    notesStatus.style.color = isError ? 'var(--error)' : 'var(--text-muted)';
  }

  function setNotesViewMode({ notesLayout, notesBackBtn, mode }) {
    if (!notesLayout) return;

    const isListMode = mode === 'list';
    const isEditingMode = mode === 'editing';

    notesLayout.classList.toggle('list-only', isListMode);
    notesLayout.classList.toggle('editing', isEditingMode);

    if (notesBackBtn) {
      notesBackBtn.classList.toggle('hidden', !isEditingMode);
    }
  }

  function toggleSection(toggleButton, sectionBody) {
    const isExpanded = toggleButton.getAttribute('aria-expanded') !== 'false';
    const nextExpanded = !isExpanded;
    toggleButton.setAttribute('aria-expanded', String(nextExpanded));
    sectionBody.classList.toggle('hidden', !nextExpanded);
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
        // ignore sendMessage failures for pages where content script is not available
      }

      return {
        url: String(activeTab.url || ''),
        title: String(activeTab.title || ''),
        selectedText,
      };
    } catch {
      return null;
    }
  }

  async function refreshActivePageContext({ notesStatus, notesPageList, notesAllList, reloadNotesOnUrlChange = false, updateStatus = false } = {}) {
    const previousUrl = activePageUrl;
    const context = await getActivePageContext();

    activePageUrl = String(context?.url || '').trim();
    activePageTitle = String(context?.title || '').trim();

    if (typeof context?.selectedText === 'string') {
      latestSelectedText = String(context.selectedText || '').trim();
    }

    if (updateStatus && notesStatus) {
      setStatus(notesStatus, activePageUrl ? `Page: ${activePageTitle || activePageUrl}` : 'ページ情報を取得できませんでした。', !activePageUrl);
    }

    const urlChanged = previousUrl !== activePageUrl;
    if (urlChanged && reloadNotesOnUrlChange && notesPageList && notesAllList) {
      await refreshNotes({ notesPageList, notesAllList });
    }

    return urlChanged;
  }

  function renderNotesList(notesListElement, notes, emptyText) {
    notesListElement.innerHTML = '';

    if (!Array.isArray(notes) || notes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'thread-item-meta';
      empty.textContent = emptyText;
      notesListElement.appendChild(empty);
      return;
    }

    notes.forEach((note) => {
      const item = document.createElement('div');
      item.className = `notes-item ${note.noteId === currentNoteId ? 'active' : ''}`;
      item.dataset.noteId = note.noteId;
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');

      const main = document.createElement('div');
      main.className = 'notes-item-main';

      const title = document.createElement('div');
      title.className = 'notes-item-title';
      title.textContent = deriveNoteTitle(note.markdown);

      const meta = document.createElement('div');
      meta.className = 'notes-item-meta';
      meta.textContent = note.updatedAt || '';

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'notes-item-delete';
      deleteBtn.title = 'メモを削除';
      deleteBtn.setAttribute('aria-label', 'メモを削除');
      deleteBtn.dataset.noteId = note.noteId;
      deleteBtn.textContent = '🗑';

      main.appendChild(title);
      main.appendChild(meta);
      item.appendChild(main);
      item.appendChild(deleteBtn);
      notesListElement.appendChild(item);
    });
  }

  function renderAllLists(notesPageList, notesAllList) {
    renderNotesList(notesPageList, currentPageNotes, 'このページのメモはまだありません。');
    renderNotesList(notesAllList, allNotes, 'メモはまだありません。');
  }

  function findNoteById(noteId) {
    return [...currentPageNotes, ...allNotes].find((note) => note.noteId === noteId) || null;
  }

  function clearEditor(markdownInput, tagsInput, notesPreview) {
    currentNoteId = null;
    currentSourceLinks = [];
    markdownInput.value = '';
    tagsInput.value = '';
    renderPreview(notesPreview, '');
  }

  function openNote(note, markdownInput, tagsInput, notesPreview) {
    currentNoteId = note.noteId;
    currentSourceLinks = Array.isArray(note.sourceLinks) ? note.sourceLinks : [];
    markdownInput.value = note.markdown || '';
    tagsInput.value = formatTags(note.tags);
    renderPreview(notesPreview, markdownInput.value);
  }

  async function refreshNotes({ notesPageList, notesAllList }) {
    const [pageResponse, allResponse] = await Promise.all([
      activePageUrl ? sendDbOp('note.listBySite', { url: activePageUrl }) : Promise.resolve({ success: true, data: [] }),
      sendDbOp('note.list', { limit: 400 }),
    ]);

    currentPageNotes = pageResponse?.success && Array.isArray(pageResponse.data) ? pageResponse.data : [];
    allNotes = allResponse?.success && Array.isArray(allResponse.data) ? allResponse.data : [];
    renderAllLists(notesPageList, notesAllList);
  }

  async function persistNote({ notesMarkdownInput, notesTagsInput, notesStatus, notesPageList, notesAllList, silent = false }) {
    const markdown = String(notesMarkdownInput.value || '').trim();
    if (!markdown || !activePageUrl || isSaving) {
      return false;
    }

    isSaving = true;

    try {
      const response = await sendDbOp('note.upsert', {
        noteId: currentNoteId,
        url: activePageUrl,
        markdown,
        sourceLinks: currentSourceLinks,
        tags: parseTags(notesTagsInput.value),
      });

      if (!response?.success || !response.data) {
        throw new Error(response?.error || 'Save failed.');
      }

      currentNoteId = response.data.noteId;
      currentSourceLinks = Array.isArray(response.data.sourceLinks) ? response.data.sourceLinks : [];

      if (!silent) {
        setStatus(notesStatus, 'メモを保存しました。');
      } else {
        setStatus(notesStatus, '自動保存しました。');
      }

      await refreshNotes({ notesPageList, notesAllList });
      return true;
    } catch (error) {
      setStatus(notesStatus, error?.message || '保存に失敗しました。', true);
      return false;
    } finally {
      isSaving = false;
    }
  }

  function scheduleAutoSave({ notesMarkdownInput, notesTagsInput, notesStatus, notesPageList, notesAllList }) {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
    }

    autoSaveTimer = setTimeout(() => {
      persistNote({
        notesMarkdownInput,
        notesTagsInput,
        notesStatus,
        notesPageList,
        notesAllList,
        silent: true,
      }).catch(() => {});
    }, 700);
  }

  async function deleteNoteById({ noteId, notesMarkdownInput, notesTagsInput, notesPreview, notesStatus, notesPageList, notesAllList }) {
    if (!noteId) return false;

    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }

    try {
      const response = await sendDbOp('note.delete', { noteId });
      if (!response?.success) {
        throw new Error(response?.error || 'Delete failed.');
      }

      if (currentNoteId === noteId) {
        clearEditor(notesMarkdownInput, notesTagsInput, notesPreview);
      }

      await refreshNotes({ notesPageList, notesAllList });
      setStatus(notesStatus, 'メモを削除しました。');
      return true;
    } catch (error) {
      setStatus(notesStatus, error?.message || '削除に失敗しました。', true);
      return false;
    }
  }

  function appendSelectionQuote(markdownInput, notesPreview, notesStatus) {
    const selected = String(latestSelectedText || '').trim();
    if (!selected) {
      setStatus(notesStatus, '引用する選択テキストがありません。', true);
      return;
    }

    const quoted = selected
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');

    const separator = markdownInput.value.trim() ? '\n\n' : '';
    markdownInput.value = `${markdownInput.value}${separator}${quoted}`;

    currentSourceLinks = [
      ...(Array.isArray(currentSourceLinks) ? currentSourceLinks : []),
      {
        type: 'selection',
        text: selected.slice(0, 600),
        url: activePageUrl,
        title: activePageTitle,
        createdAt: new Date().toISOString(),
      },
    ];

    renderPreview(notesPreview, markdownInput.value);
    setStatus(notesStatus, '選択テキストを引用しました。');
  }

  function init() {
    const notesLayout = document.getElementById('notesLayout');
    const notesBackBtn = document.getElementById('notesBackBtn');
    const notesPageSectionToggle = document.getElementById('notesPageSectionToggle');
    const notesPageSectionBody = document.getElementById('notesPageSectionBody');
    const notesAllSectionToggle = document.getElementById('notesAllSectionToggle');
    const notesAllSectionBody = document.getElementById('notesAllSectionBody');
    const notesPageList = document.getElementById('notesPageList');
    const notesAllList = document.getElementById('notesAllList');
    const notesEditorWrap = document.getElementById('notesEditorWrap');
    const notesMarkdownInput = document.getElementById('notesMarkdownInput');
    const notesPreview = document.getElementById('notesPreview');
    const notesSheetTitle = document.getElementById('notesSheetTitle');
    const notesTagsInput = document.getElementById('notesTagsInput');
    const notesStatus = document.getElementById('notesStatus');
    const notesNewBtn = document.getElementById('notesNewBtn');
    const notesInsertSelectionBtn = document.getElementById('notesInsertSelectionBtn');

    if (!notesLayout || !notesBackBtn || !notesPageSectionToggle || !notesPageSectionBody || !notesAllSectionToggle || !notesAllSectionBody || !notesPageList || !notesAllList || !notesEditorWrap || !notesMarkdownInput || !notesPreview || !notesSheetTitle || !notesTagsInput || !notesStatus || !notesNewBtn || !notesInsertSelectionBtn) {
      return;
    }

    setNotesViewMode({ notesLayout, notesBackBtn, mode: 'list' });

    setSingleSheetMode({
      notesSheetTitle,
      notesMarkdownInput,
      notesPreview,
      isEditing: false,
    });

    notesMarkdownInput.addEventListener('input', () => {
      renderPreview(notesPreview, notesMarkdownInput.value);
      setStatus(notesStatus, '編集中...');
      updateModeBySelection({ notesSheetTitle, notesMarkdownInput, notesPreview });
      scheduleAutoSave({
        notesMarkdownInput,
        notesTagsInput,
        notesStatus,
        notesPageList,
        notesAllList,
      });
    });

    notesMarkdownInput.addEventListener('focus', () => {
      updateModeBySelection({ notesSheetTitle, notesMarkdownInput, notesPreview });
    });

    notesMarkdownInput.addEventListener('select', () => {
      updateModeBySelection({ notesSheetTitle, notesMarkdownInput, notesPreview });
    });

    notesMarkdownInput.addEventListener('keyup', () => {
      updateModeBySelection({ notesSheetTitle, notesMarkdownInput, notesPreview });
    });

    notesMarkdownInput.addEventListener('mouseup', () => {
      updateModeBySelection({ notesSheetTitle, notesMarkdownInput, notesPreview });
    });

    notesMarkdownInput.addEventListener('blur', () => {
      setSingleSheetMode({
        notesSheetTitle,
        notesMarkdownInput,
        notesPreview,
        isEditing: false,
      });
    });

    notesPreview.setAttribute('role', 'button');
    notesPreview.setAttribute('tabindex', '0');
    notesPreview.setAttribute('aria-label', 'プレビューを編集モードで開く');

    notesPreview.addEventListener('click', () => {
      setSingleSheetMode({
        notesSheetTitle,
        notesMarkdownInput,
        notesPreview,
        isEditing: true,
      });
      notesMarkdownInput.focus();
      notesMarkdownInput.setSelectionRange(notesMarkdownInput.value.length, notesMarkdownInput.value.length);
    });

    notesPreview.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      notesPreview.click();
    });

    notesTagsInput.addEventListener('input', () => {
      setStatus(notesStatus, '編集中...');
      scheduleAutoSave({
        notesMarkdownInput,
        notesTagsInput,
        notesStatus,
        notesPageList,
        notesAllList,
      });
    });

    notesPageSectionToggle.addEventListener('click', () => {
      toggleSection(notesPageSectionToggle, notesPageSectionBody);
    });

    notesAllSectionToggle.addEventListener('click', () => {
      toggleSection(notesAllSectionToggle, notesAllSectionBody);
    });

    notesBackBtn.addEventListener('click', () => {
      setNotesViewMode({ notesLayout, notesBackBtn, mode: 'list' });
      setSingleSheetMode({
        notesSheetTitle,
        notesMarkdownInput,
        notesPreview,
        isEditing: false,
      });
    });

    notesNewBtn.addEventListener('click', () => {
      clearEditor(notesMarkdownInput, notesTagsInput, notesPreview);
      renderAllLists(notesPageList, notesAllList);
      setStatus(notesStatus, '新規メモを開始しました。');
      setNotesViewMode({ notesLayout, notesBackBtn, mode: 'editing' });
      setSingleSheetMode({
        notesSheetTitle,
        notesMarkdownInput,
        notesPreview,
        isEditing: true,
      });
      notesMarkdownInput.focus();
    });

    notesInsertSelectionBtn.addEventListener('click', () => {
      appendSelectionQuote(notesMarkdownInput, notesPreview, notesStatus);
      scheduleAutoSave({
        notesMarkdownInput,
        notesTagsInput,
        notesStatus,
        notesPageList,
        notesAllList,
      });
    });

    const handleNoteListClick = async (event) => {
      const deleteBtn = event.target.closest('.notes-item-delete');
      if (deleteBtn) {
        event.preventDefault();
        event.stopPropagation();
        const deleteId = deleteBtn.dataset.noteId;
        await deleteNoteById({
          noteId: deleteId,
          notesMarkdownInput,
          notesTagsInput,
          notesPreview,
          notesStatus,
          notesPageList,
          notesAllList,
        });
        return;
      }

      const target = event.target.closest('.notes-item');
      if (!target) return;

      const noteId = target.dataset.noteId;
      const note = findNoteById(noteId);
      if (!note) return;

      openNote(note, notesMarkdownInput, notesTagsInput, notesPreview);
      renderAllLists(notesPageList, notesAllList);
      setStatus(notesStatus, 'メモを読み込みました。');
      setNotesViewMode({ notesLayout, notesBackBtn, mode: 'editing' });
      setSingleSheetMode({
        notesSheetTitle,
        notesMarkdownInput,
        notesPreview,
        isEditing: true,
      });
      notesMarkdownInput.focus();
      notesMarkdownInput.setSelectionRange(notesMarkdownInput.value.length, notesMarkdownInput.value.length);
    };

    const handleNoteListKeydown = (event) => {
      const target = event.target.closest('.notes-item');
      if (!target) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      target.click();
    };

    notesPageList.addEventListener('click', handleNoteListClick);
    notesAllList.addEventListener('click', handleNoteListClick);
    notesPageList.addEventListener('keydown', handleNoteListKeydown);
    notesAllList.addEventListener('keydown', handleNoteListKeydown);

    window.addEventListener('deepl:selectedTextUpdated', (event) => {
      latestSelectedText = String(event.detail?.text || '').trim();
      refreshActivePageContext({
        notesStatus,
        notesPageList,
        notesAllList,
        reloadNotesOnUrlChange: true,
      }).catch(() => {});
    });

    window.addEventListener('deepl:workspaceModeChanged', async (event) => {
      if (event?.detail?.mode === 'notes') {
        setNotesViewMode({ notesLayout, notesBackBtn, mode: 'list' });
        setSingleSheetMode({
          notesSheetTitle,
          notesMarkdownInput,
          notesPreview,
          isEditing: false,
        });

        try {
          const urlChanged = await refreshActivePageContext({
            notesStatus,
            notesPageList,
            notesAllList,
            reloadNotesOnUrlChange: true,
            updateStatus: true,
          });
          if (!urlChanged) {
            await refreshNotes({ notesPageList, notesAllList });
          }
        } catch {
          refreshNotes({ notesPageList, notesAllList }).catch(() => {});
        }
      }
    });

    (async () => {
      await refreshActivePageContext({
        notesStatus,
        notesPageList,
        notesAllList,
        updateStatus: true,
      });

      renderPreview(notesPreview, '');
      setNotesViewMode({ notesLayout, notesBackBtn, mode: 'list' });
      setSingleSheetMode({
        notesSheetTitle,
        notesMarkdownInput,
        notesPreview,
        isEditing: false,
      });
      await refreshNotes({ notesPageList, notesAllList });
    })().catch(() => {
      renderPreview(notesPreview, '');
      setNotesViewMode({ notesLayout, notesBackBtn, mode: 'list' });
      setSingleSheetMode({
        notesSheetTitle,
        notesMarkdownInput,
        notesPreview,
        isEditing: false,
      });
      setStatus(notesStatus, '初期化に失敗しました。', true);
    });
  }

  window.NoteFeature = { init };
})();

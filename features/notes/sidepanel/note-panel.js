(() => {
  let activePageUrl = '';
  let activePageTitle = '';
  let currentNoteId = null;
  let currentSourceLinks = [];
  let currentNotes = [];
  let latestSelectedText = '';

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

  function setStatus(notesStatus, message, isError = false) {
    notesStatus.textContent = message || '';
    notesStatus.style.color = isError ? 'var(--error)' : 'var(--text-muted)';
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

  function renderNotesList(notesListElement) {
    notesListElement.innerHTML = '';

    if (!Array.isArray(currentNotes) || currentNotes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'thread-item-meta';
      empty.textContent = 'メモはまだありません。';
      notesListElement.appendChild(empty);
      return;
    }

    currentNotes.forEach((note) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `notes-item ${note.noteId === currentNoteId ? 'active' : ''}`;
      item.dataset.noteId = note.noteId;

      const title = document.createElement('div');
      title.className = 'notes-item-title';
      title.textContent = deriveNoteTitle(note.markdown);

      const meta = document.createElement('div');
      meta.className = 'notes-item-meta';
      meta.textContent = note.updatedAt || '';

      item.appendChild(title);
      item.appendChild(meta);
      notesListElement.appendChild(item);
    });
  }

  function clearEditor(markdownInput, tagsInput, notesPreview, notesDeleteBtn) {
    currentNoteId = null;
    currentSourceLinks = [];
    markdownInput.value = '';
    tagsInput.value = '';
    notesDeleteBtn.disabled = true;
    renderPreview(notesPreview, '');
  }

  function openNote(note, markdownInput, tagsInput, notesPreview, notesDeleteBtn) {
    currentNoteId = note.noteId;
    currentSourceLinks = Array.isArray(note.sourceLinks) ? note.sourceLinks : [];
    markdownInput.value = note.markdown || '';
    tagsInput.value = formatTags(note.tags);
    notesDeleteBtn.disabled = false;
    renderPreview(notesPreview, markdownInput.value);
  }

  async function refreshNotes(notesListElement) {
    if (!activePageUrl) {
      currentNotes = [];
      renderNotesList(notesListElement);
      return;
    }

    const response = await sendDbOp('note.listBySite', { url: activePageUrl });
    currentNotes = response?.success && Array.isArray(response.data) ? response.data : [];
    renderNotesList(notesListElement);
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
    const notesList = document.getElementById('notesList');
    const notesMarkdownInput = document.getElementById('notesMarkdownInput');
    const notesPreview = document.getElementById('notesPreview');
    const notesTagsInput = document.getElementById('notesTagsInput');
    const notesStatus = document.getElementById('notesStatus');
    const notesNewBtn = document.getElementById('notesNewBtn');
    const notesInsertSelectionBtn = document.getElementById('notesInsertSelectionBtn');
    const notesSaveBtn = document.getElementById('notesSaveBtn');
    const notesDeleteBtn = document.getElementById('notesDeleteBtn');

    if (!notesList || !notesMarkdownInput || !notesPreview || !notesTagsInput || !notesStatus || !notesNewBtn || !notesInsertSelectionBtn || !notesSaveBtn || !notesDeleteBtn) {
      return;
    }

    notesMarkdownInput.addEventListener('input', () => {
      renderPreview(notesPreview, notesMarkdownInput.value);
      setStatus(notesStatus, '編集中...');
    });

    notesNewBtn.addEventListener('click', () => {
      clearEditor(notesMarkdownInput, notesTagsInput, notesPreview, notesDeleteBtn);
      renderNotesList(notesList);
      setStatus(notesStatus, '新規メモを開始しました。');
    });

    notesInsertSelectionBtn.addEventListener('click', () => {
      appendSelectionQuote(notesMarkdownInput, notesPreview, notesStatus);
    });

    notesSaveBtn.addEventListener('click', async () => {
      const markdown = String(notesMarkdownInput.value || '').trim();
      if (!markdown) {
        setStatus(notesStatus, '空のメモは保存できません。', true);
        return;
      }

      if (!activePageUrl) {
        setStatus(notesStatus, 'ページURLが取得できません。', true);
        return;
      }

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
        notesDeleteBtn.disabled = false;
        setStatus(notesStatus, 'メモを保存しました。');
        await refreshNotes(notesList);
      } catch (error) {
        setStatus(notesStatus, error?.message || '保存に失敗しました。', true);
      }
    });

    notesDeleteBtn.addEventListener('click', async () => {
      if (!currentNoteId) return;

      try {
        const response = await sendDbOp('note.delete', { noteId: currentNoteId });
        if (!response?.success) {
          throw new Error(response?.error || 'Delete failed.');
        }

        clearEditor(notesMarkdownInput, notesTagsInput, notesPreview, notesDeleteBtn);
        await refreshNotes(notesList);
        setStatus(notesStatus, 'メモを削除しました。');
      } catch (error) {
        setStatus(notesStatus, error?.message || '削除に失敗しました。', true);
      }
    });

    notesList.addEventListener('click', (event) => {
      const target = event.target.closest('.notes-item');
      if (!target) return;

      const noteId = target.dataset.noteId;
      const note = currentNotes.find((item) => item.noteId === noteId);
      if (!note) return;

      openNote(note, notesMarkdownInput, notesTagsInput, notesPreview, notesDeleteBtn);
      renderNotesList(notesList);
      setStatus(notesStatus, 'メモを読み込みました。');
    });

    window.addEventListener('deepl:selectedTextUpdated', (event) => {
      latestSelectedText = String(event.detail?.text || '').trim();
    });

    (async () => {
      const context = await getActivePageContext();
      activePageUrl = String(context?.url || '').trim();
      activePageTitle = String(context?.title || '').trim();
      latestSelectedText = String(context?.selectedText || '').trim();

      renderPreview(notesPreview, '');
      await refreshNotes(notesList);
      setStatus(notesStatus, activePageUrl ? `Page: ${activePageTitle || activePageUrl}` : 'ページ情報を取得できませんでした。', !activePageUrl);
    })().catch(() => {
      renderPreview(notesPreview, '');
      setStatus(notesStatus, '初期化に失敗しました。', true);
    });
  }

  window.NoteFeature = { init };
})();

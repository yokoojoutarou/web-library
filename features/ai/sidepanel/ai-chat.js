(() => {
  const DEFAULT_GREETING = '質問を入力してください。新しいチャットを始めるか、履歴からスレッドを再開できます。';
  const ACTIVE_THREAD_STORAGE_KEY = 'aiActiveThreadId';

  let latestSelectedText = '';
  let activeThreadId = null;
  let currentThreadMessages = [];

  const hasMarkdownIt = typeof window.markdownit === 'function';
  const hasKatex = typeof window.katex?.renderToString === 'function';

  const markdownRenderer = hasMarkdownIt
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

  function setupMathPlugin(md) {
    if (!md || !hasKatex) return;

    const katexOptions = {
      throwOnError: false,
      strict: 'ignore',
    };

    const renderInline = (expression) => window.katex.renderToString(expression, {
      ...katexOptions,
      displayMode: false,
    });

    const renderBlock = (expression) => `<div class="katex-block">${window.katex.renderToString(expression, {
      ...katexOptions,
      displayMode: true,
    })}</div>`;

    md.inline.ruler.after('backticks', 'math_inline', (state, silent) => {
      const start = state.pos;
      const src = state.src;

      if (src[start] !== '$') return false;
      if (src[start + 1] === '$') return false;

      let end = start + 1;
      while ((end = src.indexOf('$', end)) !== -1) {
        if (src[end - 1] !== '\\') break;
        end += 1;
      }

      if (end === -1) return false;

      const content = src.slice(start + 1, end).trim();
      if (!content) return false;

      if (!silent) {
        const token = state.push('math_inline', 'math', 0);
        token.content = content;
      }

      state.pos = end + 1;
      return true;
    });

    md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      const firstLine = state.src.slice(start, max).trim();

      if (!firstLine.startsWith('$$')) return false;

      let nextLine = startLine;
      let content = '';

      if (firstLine.endsWith('$$') && firstLine.length > 4) {
        content = firstLine.slice(2, -2).trim();
      } else {
        content = firstLine.slice(2).trim();
        while (++nextLine < endLine) {
          const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
          const lineMax = state.eMarks[nextLine];
          const lineText = state.src.slice(lineStart, lineMax);

          if (lineText.trim().endsWith('$$')) {
            content += `\n${lineText.replace(/\$\$\s*$/, '').trimEnd()}`;
            break;
          }

          content += `\n${lineText}`;
        }
      }

      if (silent) return true;

      const token = state.push('math_block', 'math', 0);
      token.block = true;
      token.content = content.trim();
      token.map = [startLine, nextLine + 1];

      state.line = nextLine + 1;
      return true;
    }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

    md.renderer.rules.math_inline = (tokens, idx) => renderInline(tokens[idx].content);
    md.renderer.rules.math_block = (tokens, idx) => renderBlock(tokens[idx].content);
  }

  setupMathPlugin(markdownRenderer);

  if (markdownRenderer) {
    const defaultValidateLink = markdownRenderer.validateLink.bind(markdownRenderer);
    markdownRenderer.validateLink = (url) => {
      if (!/^https?:\/\//i.test(url || '')) return false;
      return defaultValidateLink(url);
    };
  }

  function createMessage(role, text) {
    const item = document.createElement('div');
    item.className = `ai-msg ${role === 'user' ? 'ai-msg-user' : 'ai-msg-assistant'}`;

    const body = document.createElement('div');
    body.className = 'ai-msg-body';
    if (role === 'assistant') {
      body.innerHTML = markdownRenderer
        ? markdownRenderer.render(text || '')
        : (text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
    } else {
      body.textContent = text;
    }

    item.appendChild(body);
    return item;
  }

  function scrollToBottom(container) {
    container.scrollTop = container.scrollHeight;
  }

  async function sendDbOp(operation, payload = {}) {
    return chrome.runtime.sendMessage({
      type: 'DB_OP',
      operation,
      payload,
    });
  }

  function createThreadItem(thread, isActive) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `thread-item ${isActive ? 'active' : ''}`;
    item.dataset.threadId = thread.threadId;

    const title = document.createElement('div');
    title.className = 'thread-item-title';
    title.textContent = thread.title || 'New Chat';

    const meta = document.createElement('div');
    meta.className = 'thread-item-meta';
    const count = Number(thread.messageCount || 0);
    meta.textContent = `${thread.updatedAt || ''} • ${count} messages`;

    item.appendChild(title);
    item.appendChild(meta);
    return item;
  }

  function renderThreadList(container, threads) {
    container.innerHTML = '';

    if (!Array.isArray(threads) || threads.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'thread-item-meta';
      empty.textContent = '履歴はまだありません。';
      container.appendChild(empty);
      return;
    }

    threads.forEach((thread) => {
      container.appendChild(createThreadItem(thread, thread.threadId === activeThreadId));
    });
  }

  function normalizePersistedMessages(messages) {
    if (!Array.isArray(messages)) return [];

    return messages
      .map((message) => {
        const role = message?.role;
        if (role !== 'user' && role !== 'assistant') {
          return null;
        }

        if (typeof message?.content !== 'string') {
          return null;
        }

        const content = message.content.trim();
        if (!content) {
          return null;
        }

        return {
          role,
          content,
        };
      })
      .filter(Boolean);
  }

  function renderConversation(aiMessages, messages) {
    aiMessages.innerHTML = '';

    const normalizedMessages = normalizePersistedMessages(messages);

    if (normalizedMessages.length === 0) {
      aiMessages.appendChild(createMessage('assistant', DEFAULT_GREETING));
      scrollToBottom(aiMessages);
      return;
    }

    normalizedMessages.forEach((message) => {
      aiMessages.appendChild(createMessage(message.role, message.content));
    });

    scrollToBottom(aiMessages);
  }

  async function setActiveThreadId(nextThreadId) {
    activeThreadId = nextThreadId || null;
    await chrome.storage.local.set({ [ACTIVE_THREAD_STORAGE_KEY]: activeThreadId });
  }

  function init() {
    const aiMessages = document.getElementById('aiMessages');
    const aiPromptInput = document.getElementById('aiPromptInput');
    const aiSendBtn = document.getElementById('aiSendBtn');
    const aiHistoryBtn = document.getElementById('aiHistoryBtn');
    const aiNewChatBtn = document.getElementById('aiNewChatBtn');
    const aiThreadPanel = document.getElementById('aiThreadPanel');
    const aiThreadList = document.getElementById('aiThreadList');

    if (!aiMessages || !aiPromptInput || !aiSendBtn || !aiHistoryBtn || !aiNewChatBtn || !aiThreadPanel || !aiThreadList) {
      return;
    }

    let isAsking = false;

    const refreshThreads = async () => {
      try {
        const response = await sendDbOp('thread.list', { limit: 50 });
        renderThreadList(aiThreadList, response?.success ? response.data : []);
      } catch {
        renderThreadList(aiThreadList, []);
      }
    };

    const openThread = async (threadId) => {
      if (!threadId) return;

      const response = await sendDbOp('thread.get', { threadId });
      if (!response?.success || !response.data) return;

      const thread = response.data;
      currentThreadMessages = normalizePersistedMessages(thread.messages);
      await setActiveThreadId(thread.threadId);
      renderConversation(aiMessages, currentThreadMessages);
      await refreshThreads();
    };

    const startNewChat = async () => {
      currentThreadMessages = [];
      await setActiveThreadId(null);
      renderConversation(aiMessages, currentThreadMessages);
      aiPromptInput.value = '';
      await refreshThreads();
    };

    const ask = async () => {
      const prompt = aiPromptInput.value.trim();
      if (!prompt || isAsking) return;

      const contextText = latestSelectedText;
      const userMessage = { role: 'user', content: prompt, timestamp: new Date().toISOString() };
      currentThreadMessages.push(userMessage);
      aiMessages.appendChild(createMessage('user', prompt));

      const pending = createMessage('assistant', 'Thinking...');
      aiMessages.appendChild(pending);
      scrollToBottom(aiMessages);

      aiPromptInput.value = '';
      isAsking = true;
      aiSendBtn.disabled = true;

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'AI_ASK',
          prompt,
          contextText,
          activeThreadId,
        });

        pending.remove();

        if (response?.success) {
          const assistantMessage = {
            role: 'assistant',
            content: response.data.answer,
            timestamp: new Date().toISOString(),
          };
          currentThreadMessages.push(assistantMessage);
          aiMessages.appendChild(createMessage('assistant', response.data.answer));

          if (response.data?.threadId) {
            await setActiveThreadId(response.data.threadId);
          }

          await refreshThreads();
        } else {
          currentThreadMessages.pop();
          aiMessages.appendChild(createMessage('assistant', response?.error || 'AI request failed.'));
        }
      } catch (error) {
        currentThreadMessages.pop();
        pending.remove();
        aiMessages.appendChild(createMessage('assistant', 'Connection error. Please try again.'));
      } finally {
        isAsking = false;
        aiSendBtn.disabled = false;
        scrollToBottom(aiMessages);
      }
    };

    aiSendBtn.addEventListener('click', ask);
    aiHistoryBtn.addEventListener('click', async () => {
      aiThreadPanel.classList.toggle('hidden');
      if (!aiThreadPanel.classList.contains('hidden')) {
        await refreshThreads();
      }
    });

    aiNewChatBtn.addEventListener('click', () => {
      startNewChat().catch(() => {});
    });

    aiThreadList.addEventListener('click', (event) => {
      const target = event.target.closest('.thread-item');
      if (!target) return;
      const threadId = target.dataset.threadId;
      openThread(threadId).catch(() => {});
    });

    aiPromptInput.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        ask();
      }
    });

    window.addEventListener('deepl:selectedTextUpdated', (event) => {
      latestSelectedText = event.detail?.text || '';
    });

    (async () => {
      const saved = await chrome.storage.local.get([ACTIVE_THREAD_STORAGE_KEY]);
      const savedThreadId = saved?.[ACTIVE_THREAD_STORAGE_KEY];
      if (savedThreadId) {
        await openThread(savedThreadId);
      } else {
        renderConversation(aiMessages, []);
      }
      await refreshThreads();
    })().catch(() => {
      renderConversation(aiMessages, []);
    });
  }

  window.AIChatFeature = { init };
})();

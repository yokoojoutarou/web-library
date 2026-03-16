// ==============================
// DeepL Translate — Background Service Worker
// ==============================

importScripts('../vendor/dexie.min.js', './db/repository.js');

const DB_OPERATION_HANDLERS = Object.freeze({
  'site.ensure': (repo, payload) => repo.ensureSite(payload),
  'site.getByUrl': (repo, payload) => repo.getSiteByUrl(payload.url),
  'site.setTags': (repo, payload) => repo.setSiteTags(payload),

  'chat.save': (repo, payload) => repo.saveChat(payload),
  'chat.listBySite': (repo, payload) => repo.getChatsBySite(payload),

  'thread.create': (repo, payload) => repo.createThread(payload),
  'thread.list': (repo, payload) => repo.listThreads(payload),
  'thread.get': (repo, payload) => repo.getThread(payload.threadId),
  'thread.append': (repo, payload) => repo.appendThreadMessages(payload),
  'thread.updateTitle': (repo, payload) => repo.updateThreadTitle(payload),

  'note.upsert': (repo, payload) => repo.upsertNote(payload),
  'note.list': (repo, payload) => repo.listNotes(payload),
  'note.listBySite': (repo, payload) => repo.getNotesBySite(payload),
  'note.delete': (repo, payload) => repo.deleteNote(payload.noteId),
  'note.setTags': (repo, payload) => repo.setNoteTags(payload),

  'marker.upsert': (repo, payload) => repo.upsertMarker(payload),
  'marker.listBySite': (repo, payload) => repo.getMarkersBySite(payload),
  'marker.delete': (repo, payload) => repo.deleteMarker(payload.markerId),

  'tag.rename': (repo, payload) => repo.renameTag(payload),
  'tag.search': (repo, payload) => repo.findByTag(payload),
});

// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Listen for messages from content script and side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TEXT_SELECTED') {
    // Forward selected text to the side panel
    chrome.runtime.sendMessage({
      type: 'UPDATE_SOURCE_TEXT',
      text: message.text
    }).catch(() => {
      // Side panel might not be open yet — ignore
    });
  }

  if (message.type === 'TRANSLATE') {
    handleTranslation(message.text, message.targetLang, message.sourceLang)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
  }

  if (message.type === 'AI_ASK') {
    handleAiAsk(message.prompt, message.contextText, message.activeThreadId)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'AI_FETCH_MODELS') {
    handleAiFetchModels(message.provider, message.apiKey)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'DB_OP') {
    handleDbOperation(message.operation, message.payload, sender)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

function validateDbSender(sender) {
  if (sender?.id !== chrome.runtime.id) {
    throw new Error('Unauthorized DB_OP sender.');
  }
}

async function handleDbOperation(operation, payload = {}, sender) {
  validateDbSender(sender);

  const repo = globalThis.ExtensionRepository;

  if (!repo) {
    throw new Error('Database repository is not initialized.');
  }

  const handler = DB_OPERATION_HANDLERS[operation];
  if (typeof handler !== 'function') {
    throw new Error(`Unsupported DB operation: ${operation}`);
  }

  return handler(repo, payload || {});
}

/**
 * Call the DeepL API to translate text
 */
async function handleTranslation(text, targetLang, sourceLang) {
  const settings = await chrome.storage.local.get(['apiKey', 'apiType']);
  const apiKey = settings.apiKey;

  if (!apiKey) {
    throw new Error('API key not set. Please configure your DeepL API key in settings.');
  }

  const baseUrl = settings.apiType === 'pro'
    ? 'https://api.deepl.com/v2/translate'
    : 'https://api-free.deepl.com/v2/translate';

  const params = new URLSearchParams();
  params.append('text', text);
  params.append('target_lang', targetLang);
  if (sourceLang && sourceLang !== 'auto') {
    params.append('source_lang', sourceLang);
  }

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 403) {
      throw new Error('Invalid API key. Please check your settings.');
    }
    if (response.status === 456) {
      throw new Error('Character limit exceeded for this billing period.');
    }
    throw new Error(`DeepL API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    translatedText: data.translations[0].text,
    detectedSourceLang: data.translations[0].detected_source_language,
  };
}

async function handleAiAsk(prompt, contextText, activeThreadId) {
  const trimmedPrompt = (prompt || '').trim();
  if (!trimmedPrompt) {
    throw new Error('Prompt is empty.');
  }

  const settings = await chrome.storage.local.get(['aiProvider', 'aiApiKeys', 'aiModels']);
  const provider = settings.aiProvider || 'openai';
  const apiKeys = settings.aiApiKeys || {};
  const aiModels = settings.aiModels || {};
  const apiKey = apiKeys[provider];

  if (!apiKey) {
    throw new Error(`API key is not set for provider: ${provider}`);
  }

  const model = aiModels[provider] || getDefaultAiModel(provider);
  const pageContext = await getActiveTabPageContext();
  const selectedText = ((contextText || '').trim() || (pageContext?.selectedText || '').trim()).slice(0, 4000);
  const threadResult = await resolveThreadForRequest({
    activeThreadId,
    pageContext,
    question: trimmedPrompt,
  });
  const thread = threadResult.thread;

  const userPrompt = buildAiPromptWithContext({
    question: trimmedPrompt,
    selectedText,
    pageContext,
    threadMessages: thread?.messages || [],
  });

  let result;

  if (provider === 'openai') {
    result = await askOpenAI(apiKey, model, userPrompt);
  } else if (provider === 'anthropic') {
    result = await askAnthropic(apiKey, model, userPrompt);
  } else if (provider === 'gemini') {
    result = await askGemini(apiKey, model, userPrompt);
  } else {
    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  const updatedThread = await saveAiExchange({
    threadId: thread.threadId,
    question: trimmedPrompt,
    answer: result?.answer || '',
    provider,
    apiKey,
    model,
  });

  return {
    ...result,
    threadId: updatedThread?.threadId || thread.threadId,
    threadTitle: updatedThread?.title || thread.title || 'New Chat',
  };
}

async function resolveThreadForRequest({ activeThreadId, pageContext, question }) {
  const repo = globalThis.ExtensionRepository;

  if (!repo) {
    throw new Error('Database repository is not initialized.');
  }

  if (activeThreadId) {
    const existing = await repo.getThread(activeThreadId);
    if (existing) {
      return { thread: existing, created: false };
    }
  }

  const created = await repo.createThread({
    url: (pageContext?.url || '').trim(),
    title: question || 'New Chat',
  });

  return { thread: created, created: true };
}

async function saveAiExchange({ threadId, question, answer, provider, apiKey, model }) {
  const repo = globalThis.ExtensionRepository;

  if (!repo || !threadId || !question || !answer) {
    return;
  }

  try {
    const updated = await repo.appendThreadMessages({
      threadId,
      messages: [
        { role: 'user', content: question, timestamp: new Date().toISOString() },
        { role: 'assistant', content: answer, timestamp: new Date().toISOString() },
      ],
    });

    const normalizedTitle = String(updated?.title || '').trim();
    if (!normalizedTitle || normalizedTitle === 'New Chat') {
      const generated = await generateThreadTitle({ provider, apiKey, model, question, answer });
      if (generated) {
        return await repo.updateThreadTitle({ threadId, title: generated });
      }
    }

    return updated;
  } catch {
    // DB write failures must not break AI response flow.
    return null;
  }
}

function buildAiPromptWithContext({ question, selectedText, pageContext, threadMessages = [] }) {
  const title = (pageContext?.title || '').trim();
  const url = (pageContext?.url || '').trim();
  const pageText = (pageContext?.pageText || '').trim();

  const parts = [
    'You are answering a question about the current website content.',
    'Continue the conversation naturally if previous messages are provided.',
    'Use the selected excerpt as highest-priority evidence when available.',
    'Use full page context as background/supporting context.',
  ];

  const trimmedThread = Array.isArray(threadMessages)
    ? threadMessages.slice(-20).map((item) => ({
        role: item?.role === 'assistant' ? 'assistant' : 'user',
        content: String(item?.content || '').trim(),
      })).filter((item) => item.content)
    : [];

  if (trimmedThread.length > 0) {
    parts.push('', 'Conversation so far:');
    trimmedThread.forEach((message) => {
      const speaker = message.role === 'assistant' ? 'Assistant' : 'User';
      parts.push(`${speaker}: ${message.content}`);
    });
  }

  if (selectedText) {
    parts.push('', 'PRIORITY CONTEXT (selected text, highest weight):', selectedText);
  }

  if (title || url) {
    parts.push('', 'Page metadata:');
    if (title) parts.push(`- Title: ${title}`);
    if (url) parts.push(`- URL: ${url}`);
  }

  if (pageText) {
    parts.push('', 'PAGE CONTEXT (full page content, lower weight):', pageText);
  }

  parts.push('', `Question:\n${question}`);

  return parts.join('\n');
}

async function generateThreadTitle({ provider, apiKey, model, question, answer }) {
  const titlePrompt = [
    'Create a concise chat thread title in 8 words or fewer.',
    'Return title text only. No quotes.',
    '',
    `User: ${question}`,
    `Assistant: ${answer}`,
  ].join('\n');

  try {
    let result;
    if (provider === 'openai') {
      result = await askOpenAI(apiKey, model, titlePrompt);
    } else if (provider === 'anthropic') {
      result = await askAnthropic(apiKey, model, titlePrompt);
    } else if (provider === 'gemini') {
      result = await askGemini(apiKey, model, titlePrompt);
    } else {
      return '';
    }

    const raw = String(result?.answer || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    return raw.length > 80 ? `${raw.slice(0, 79)}…` : raw;
  } catch {
    return '';
  }
}

async function getActiveTabPageContext() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTab = tabs?.[0];

    if (!activeTab?.id) {
      return null;
    }

    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: 'REQUEST_PAGE_CONTEXT',
    });

    if (!response?.success) {
      return null;
    }

    return response.data || null;
  } catch (error) {
    return null;
  }
}

function getDefaultAiModel(provider) {
  const defaults = {
    openai: 'gpt-4.1-mini',
    anthropic: 'claude-3-5-haiku-latest',
    gemini: 'gemini-2.0-flash',
  };

  return defaults[provider] || defaults.openai;
}

async function askOpenAI(apiKey, model, prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a concise helpful assistant.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const answer = data?.choices?.[0]?.message?.content?.trim();

  if (!answer) {
    throw new Error('OpenAI response was empty.');
  }

  return { answer };
}

async function askAnthropic(apiKey, model, prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      messages: [
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const answer = (data?.content || [])
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n')
    .trim();

  if (!answer) {
    throw new Error('Anthropic response was empty.');
  }

  return { answer };
}

async function askGemini(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const answer = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n').trim();

  if (!answer) {
    throw new Error('Gemini response was empty.');
  }

  return { answer };
}

async function handleAiFetchModels(provider, apiKey) {
  const normalizedProvider = (provider || '').trim();
  const trimmedKey = (apiKey || '').trim();

  if (!normalizedProvider) {
    throw new Error('Provider is required.');
  }

  if (!trimmedKey) {
    throw new Error('API key is required to fetch models.');
  }

  if (normalizedProvider === 'openai') {
    return await fetchOpenAiModels(trimmedKey);
  }

  if (normalizedProvider === 'anthropic') {
    return await fetchAnthropicModels(trimmedKey);
  }

  if (normalizedProvider === 'gemini') {
    return await fetchGeminiModels(trimmedKey);
  }

  throw new Error(`Unsupported AI provider: ${normalizedProvider}`);
}

async function fetchOpenAiModels(apiKey) {
  const response = await fetch('https://api.openai.com/v1/models', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI model fetch error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const models = (data?.data || [])
    .map(item => item?.id)
    .filter(id => typeof id === 'string' && /^gpt|^o[0-9]/i.test(id))
    .sort((a, b) => a.localeCompare(b));

  return { models };
}

async function fetchAnthropicModels(apiKey) {
  const response = await fetch('https://api.anthropic.com/v1/models', {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic model fetch error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const models = (data?.data || [])
    .map(item => item?.id)
    .filter(id => typeof id === 'string' && id.length > 0)
    .sort((a, b) => a.localeCompare(b));

  return { models };
}

async function fetchGeminiModels(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'GET',
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini model fetch error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const models = (data?.models || [])
    .filter(item => Array.isArray(item?.supportedGenerationMethods) && item.supportedGenerationMethods.includes('generateContent'))
    .map(item => (item?.name || '').replace(/^models\//, ''))
    .filter(name => name.length > 0)
    .sort((a, b) => a.localeCompare(b));

  return { models };
}

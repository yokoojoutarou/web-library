// ==============================
// Web Library Assistant — Side Panel Logic
// ==============================

(() => {
    // --- DOM Elements ---
    const sourceText = document.getElementById('sourceText');
    const resultText = document.getElementById('resultText');
    const translateBtn = document.getElementById('translateBtn');
    const clearBtn = document.getElementById('clearBtn');
    const copyBtn = document.getElementById('copyBtn');
    const charCount = document.getElementById('charCount');
    const sourceLang = document.getElementById('sourceLang');
    const targetLang = document.getElementById('targetLang');
    const swapLangsBtn = document.getElementById('swapLangsBtn');
    const autoTranslate = document.getElementById('autoTranslate');
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    const closeModalBtn = document.getElementById('closeModalBtn');
    const apiKeyInput = document.getElementById('apiKeyInput');
    const apiTypeSelect = document.getElementById('apiTypeSelect');
    const aiProviderSelect = document.getElementById('aiProviderSelect');
    const aiApiKeyInput = document.getElementById('aiApiKeyInput');
    const aiModelSelect = document.getElementById('aiModelSelect');
    const aiModelHelp = document.getElementById('aiModelHelp');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    const toggleKeyVisibility = document.getElementById('toggleKeyVisibility');
    const loadingIndicator = document.getElementById('loadingIndicator');
    const errorDisplay = document.getElementById('errorDisplay');
    const detectedLang = document.getElementById('detectedLang');
    const modeTranslateBtn = document.getElementById('modeTranslateBtn');
    const modeAiBtn = document.getElementById('modeAiBtn');
    const modeNotesBtn = document.getElementById('modeNotesBtn');
    const modeMarkersBtn = document.getElementById('modeMarkersBtn');
    const modeLibraryBtn = document.getElementById('modeLibraryBtn');
    const actionRail = document.getElementById('actionRail');
    const translateWorkspace = document.getElementById('translateWorkspace');
    const aiWorkspace = document.getElementById('aiWorkspace');
    const notesWorkspace = document.getElementById('notesWorkspace');
    const markersWorkspace = document.getElementById('markersWorkspace');
    const libraryWorkspace = document.getElementById('libraryWorkspace');

    let isTranslating = false;
    let translateDebounce = null;
    let aiModelFetchDebounce = null;
    let aiFetchRequestId = 0;
    let draggingActionId = null;
    let currentWorkspaceMode = 'translate';

    const ACTION_ORDER_KEY = 'workspaceActionOrder';
    const DEFAULT_ACTION_ORDER = ['settings', 'translate', 'ai', 'notes', 'markers', 'library'];

    const FALLBACK_AI_PROVIDER_MODELS = {
        openai: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'],
        anthropic: ['claude-3-5-haiku-latest', 'claude-3-7-sonnet-latest'],
        gemini: ['gemini-2.0-flash', 'gemini-1.5-pro']
    };

    // --- Initialize ---
    init();

    async function init() {
        // Load saved settings
        const settings = await chrome.storage.local.get([
            'apiKey', 'apiType', 'targetLang', 'sourceLang', 'autoTranslate', 'workspaceMode',
            'aiProvider', 'aiApiKeys', 'aiModels', ACTION_ORDER_KEY
        ]);

        if (settings.apiKey) apiKeyInput.value = settings.apiKey;
        if (settings.apiType) apiTypeSelect.value = settings.apiType;
        if (settings.targetLang) targetLang.value = settings.targetLang;
        if (settings.sourceLang) sourceLang.value = settings.sourceLang;
        if (settings.autoTranslate !== undefined) {
            autoTranslate.checked = settings.autoTranslate;
        }

        const aiProvider = settings.aiProvider || 'openai';
        aiProviderSelect.value = aiProvider;

        const aiApiKeys = settings.aiApiKeys || {};
        aiApiKeyInput.value = aiApiKeys[aiProvider] || '';
        const aiModels = settings.aiModels || {};

        await refreshAiModels({
            provider: aiProvider,
            apiKey: aiApiKeys[aiProvider] || '',
            selectedModel: aiModels[aiProvider],
        });

        const workspaceMode = settings.workspaceMode;
        if (workspaceMode === 'ai' || workspaceMode === 'notes' || workspaceMode === 'markers' || workspaceMode === 'library') {
            applyWorkspaceMode(workspaceMode);
        } else {
            applyWorkspaceMode('translate');
        }

        initializeActionRailOrder(settings[ACTION_ORDER_KEY]);
        setupActionRailDnD();

        if (window.AIChatFeature && typeof window.AIChatFeature.init === 'function') {
            window.AIChatFeature.init();
        }

        if (window.NoteFeature && typeof window.NoteFeature.init === 'function') {
            window.NoteFeature.init();
        }

        if (window.MarkerFeature && typeof window.MarkerFeature.init === 'function') {
            window.MarkerFeature.init();
        }

        if (window.LibraryFeature && typeof window.LibraryFeature.init === 'function') {
            window.LibraryFeature.init();
        }

        // Check if API key is set; if not, show settings modal
        if (!settings.apiKey) {
            settingsModal.classList.remove('hidden');
        }
    }

    // --- Message Listener (from background) ---
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'UPDATE_SOURCE_TEXT') {
            sourceText.value = message.text;
            updateCharCount();

            window.dispatchEvent(new CustomEvent('deepl:selectedTextUpdated', {
                detail: { text: message.text || '' }
            }));

            if (autoTranslate.checked && message.text.trim() && currentWorkspaceMode === 'translate') {
                debouncedTranslate();
            }
        }
    });

    // --- Translate ---
    translateBtn.addEventListener('click', () => {
        translate();
    });

    sourceText.addEventListener('input', () => {
        updateCharCount();
    });

    // Ctrl+Enter to translate
    sourceText.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            translate();
        }
    });

    function debouncedTranslate() {
        clearTimeout(translateDebounce);
        translateDebounce = setTimeout(() => translate(), 500);
    }

    async function translate() {
        const text = sourceText.value.trim();
        if (!text || isTranslating) return;

        isTranslating = true;
        translateBtn.disabled = true;
        showLoading();
        hideError();
        detectedLang.textContent = '';

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'TRANSLATE',
                text: text,
                targetLang: targetLang.value,
                sourceLang: sourceLang.value,
            });

            if (response.success) {
                resultText.innerHTML = '';
                resultText.textContent = response.data.translatedText;
                resultText.classList.remove('placeholder-text');

                // Show detected source language
                if (response.data.detectedSourceLang) {
                    const langName = getLangName(response.data.detectedSourceLang);
                    detectedLang.textContent = langName;
                }
            } else {
                showError(response.error);
            }
        } catch (err) {
            showError('Connection error. Please try again.');
        } finally {
            isTranslating = false;
            translateBtn.disabled = false;
            hideLoading();
        }
    }

    // --- Clear ---
    clearBtn.addEventListener('click', () => {
        sourceText.value = '';
        resultText.innerHTML = '<span class="placeholder-text">Translation will appear here...</span>';
        detectedLang.textContent = '';
        updateCharCount();
        hideError();
        sourceText.focus();
    });

    // --- Copy ---
    copyBtn.addEventListener('click', () => {
        const text = resultText.textContent;
        if (!text || resultText.querySelector('.placeholder-text')) return;

        navigator.clipboard.writeText(text).then(() => {
            showToast('Copied to clipboard');
        });
    });

    // --- Swap Languages ---
    swapLangsBtn.addEventListener('click', () => {
        const srcVal = sourceLang.value;
        const tgtVal = targetLang.value;

        // Can't swap if source is auto
        if (srcVal === 'auto') return;

        // Map target variants to source format
        const tgtToSrc = {
            'EN-US': 'EN', 'EN-GB': 'EN',
            'PT-BR': 'PT', 'PT-PT': 'PT',
            'ZH-HANS': 'ZH', 'ZH-HANT': 'ZH',
        };

        const newSrc = tgtToSrc[tgtVal] || tgtVal;

        // Set source to previous target
        if ([...sourceLang.options].some(o => o.value === newSrc)) {
            sourceLang.value = newSrc;
        }

        // Set target to previous source (try exact or variant)
        const srcToTgt = {
            'EN': 'EN-US',
            'PT': 'PT-BR',
            'ZH': 'ZH-HANS',
        };
        const newTgt = srcToTgt[srcVal] || srcVal;

        if ([...targetLang.options].some(o => o.value === newTgt)) {
            targetLang.value = newTgt;
        }

        saveLangPrefs();

        // If there's text, re-translate
        if (sourceText.value.trim()) {
            debouncedTranslate();
        }
    });

    // Save language prefs on change
    sourceLang.addEventListener('change', saveLangPrefs);
    targetLang.addEventListener('change', saveLangPrefs);

    modeTranslateBtn.addEventListener('click', () => {
        applyWorkspaceMode('translate');
    });

    modeAiBtn.addEventListener('click', () => {
        applyWorkspaceMode('ai');
    });

    modeNotesBtn.addEventListener('click', () => {
        applyWorkspaceMode('notes');
    });

    modeMarkersBtn.addEventListener('click', () => {
        applyWorkspaceMode('markers');
    });

    modeLibraryBtn.addEventListener('click', () => {
        applyWorkspaceMode('library');
    });

    function getActionButtonMap() {
        return {
            settings: settingsBtn,
            translate: modeTranslateBtn,
            ai: modeAiBtn,
            notes: modeNotesBtn,
            markers: modeMarkersBtn,
            library: modeLibraryBtn,
        };
    }

    function normalizeActionOrder(rawOrder) {
        const validSet = new Set(DEFAULT_ACTION_ORDER);
        const requested = Array.isArray(rawOrder) ? rawOrder.map((item) => String(item || '').trim()) : [];
        const unique = [];
        const seen = new Set();

        requested.forEach((id) => {
            if (!validSet.has(id) || seen.has(id)) return;
            unique.push(id);
            seen.add(id);
        });

        DEFAULT_ACTION_ORDER.forEach((id) => {
            if (!seen.has(id)) {
                unique.push(id);
                seen.add(id);
            }
        });

        return unique;
    }

    function isSameActionOrder(left, right) {
        if (!Array.isArray(left) || !Array.isArray(right)) return false;
        if (left.length !== right.length) return false;
        return left.every((id, index) => id === right[index]);
    }

    function getCurrentActionOrder() {
        if (!actionRail) return [...DEFAULT_ACTION_ORDER];
        return Array.from(actionRail.querySelectorAll('[data-action-id]'))
            .map((el) => String(el.dataset.actionId || '').trim())
            .filter(Boolean);
    }

    async function persistActionOrder(order) {
        await chrome.storage.local.set({ [ACTION_ORDER_KEY]: normalizeActionOrder(order) });
    }

    function applyActionOrder(order) {
        if (!actionRail) return;
        const buttonMap = getActionButtonMap();
        order.forEach((actionId) => {
            const button = buttonMap[actionId];
            if (button) {
                actionRail.appendChild(button);
            }
        });
    }

    function initializeActionRailOrder(storedOrder) {
        const normalizedOrder = normalizeActionOrder(storedOrder);
        applyActionOrder(normalizedOrder);

        if (!isSameActionOrder(storedOrder, normalizedOrder)) {
            persistActionOrder(normalizedOrder).catch(() => { });
        }
    }

    function setupActionRailDnD() {
        if (!actionRail) return;

        actionRail.addEventListener('dragstart', (event) => {
            const button = event.target.closest('[data-action-id]');
            if (!button || button.draggable !== true) {
                draggingActionId = null;
                return;
            }

            draggingActionId = String(button.dataset.actionId || '').trim();
            if (!draggingActionId) return;

            button.classList.add('rail-dragging');
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', draggingActionId);
            }
        });

        actionRail.addEventListener('dragover', (event) => {
            if (!draggingActionId) return;
            event.preventDefault();

            const target = event.target.closest('[data-action-id]');
            const draggingEl = actionRail.querySelector(`.rail-btn[data-action-id="${draggingActionId}"]`);

            actionRail.querySelectorAll('.rail-drop-target').forEach((el) => {
                el.classList.remove('rail-drop-target');
            });

            if (!target || !draggingEl || target === draggingEl) {
                return;
            }

            target.classList.add('rail-drop-target');
            const rect = target.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            if (before) {
                actionRail.insertBefore(draggingEl, target);
            } else {
                actionRail.insertBefore(draggingEl, target.nextSibling);
            }
        });

        actionRail.addEventListener('drop', (event) => {
            if (!draggingActionId) return;
            event.preventDefault();

            actionRail.querySelectorAll('.rail-drop-target').forEach((el) => {
                el.classList.remove('rail-drop-target');
            });
        });

        actionRail.addEventListener('dragend', () => {
            actionRail.querySelectorAll('.rail-dragging, .rail-drop-target').forEach((el) => {
                el.classList.remove('rail-dragging');
                el.classList.remove('rail-drop-target');
            });

            if (draggingActionId) {
                persistActionOrder(getCurrentActionOrder()).catch(() => { });
            }
            draggingActionId = null;
        });
    }

    autoTranslate.addEventListener('change', () => {
        chrome.storage.local.set({ autoTranslate: autoTranslate.checked });
    });

    aiProviderSelect.addEventListener('change', async () => {
        const selectedProvider = aiProviderSelect.value;
        const stored = await chrome.storage.local.get(['aiApiKeys', 'aiModels']);
        const aiApiKeys = stored.aiApiKeys || {};
        const aiModels = stored.aiModels || {};

        aiApiKeyInput.value = aiApiKeys[selectedProvider] || '';
        await refreshAiModels({
            provider: selectedProvider,
            apiKey: aiApiKeys[selectedProvider] || '',
            selectedModel: aiModels[selectedProvider],
        });
    });

    aiApiKeyInput.addEventListener('input', () => {
        clearTimeout(aiModelFetchDebounce);

        aiModelFetchDebounce = setTimeout(async () => {
            const provider = aiProviderSelect.value;
            const apiKey = aiApiKeyInput.value.trim();
            const selectedModel = aiModelSelect.value;

            await refreshAiModels({
                provider,
                apiKey,
                selectedModel,
            });
        }, 450);
    });

    function saveLangPrefs() {
        chrome.storage.local.set({
            sourceLang: sourceLang.value,
            targetLang: targetLang.value,
        });
    }

    function applyWorkspaceMode(mode) {
        const isAi = mode === 'ai';
        const isNotes = mode === 'notes';
        const isMarkers = mode === 'markers';
        const isLibrary = mode === 'library';
        const isTranslate = !isAi && !isNotes && !isMarkers && !isLibrary;
        const nextMode = isAi ? 'ai' : isNotes ? 'notes' : isMarkers ? 'markers' : isLibrary ? 'library' : 'translate';

        modeTranslateBtn.classList.toggle('active', isTranslate);
        modeAiBtn.classList.toggle('active', isAi);
        modeNotesBtn.classList.toggle('active', isNotes);
        modeMarkersBtn.classList.toggle('active', isMarkers);
        modeLibraryBtn.classList.toggle('active', isLibrary);
        modeTranslateBtn.setAttribute('aria-pressed', String(isTranslate));
        modeAiBtn.setAttribute('aria-pressed', String(isAi));
        modeNotesBtn.setAttribute('aria-pressed', String(isNotes));
        modeMarkersBtn.setAttribute('aria-pressed', String(isMarkers));
        modeLibraryBtn.setAttribute('aria-pressed', String(isLibrary));

        translateWorkspace.classList.toggle('hidden', !isTranslate);
        aiWorkspace.classList.toggle('hidden', !isAi);
        notesWorkspace.classList.toggle('hidden', !isNotes);
        markersWorkspace.classList.toggle('hidden', !isMarkers);
        libraryWorkspace.classList.toggle('hidden', !isLibrary);

        currentWorkspaceMode = nextMode;
        chrome.storage.local.set({ workspaceMode: nextMode });
        window.dispatchEvent(new CustomEvent('deepl:workspaceModeChanged', {
            detail: { mode: nextMode }
        }));
    }

    // --- Settings Modal ---
    settingsBtn.addEventListener('click', () => {
        settingsModal.classList.remove('hidden');
    });

    closeModalBtn.addEventListener('click', () => {
        settingsModal.classList.add('hidden');
    });

    document.querySelector('.modal-overlay').addEventListener('click', () => {
        settingsModal.classList.add('hidden');
    });

    toggleKeyVisibility.addEventListener('click', () => {
        const type = apiKeyInput.type === 'password' ? 'text' : 'password';
        apiKeyInput.type = type;
    });

    saveSettingsBtn.addEventListener('click', async () => {
        const apiKey = apiKeyInput.value.trim();
        const apiType = apiTypeSelect.value;
        const aiProvider = aiProviderSelect.value;
        const aiApiKey = aiApiKeyInput.value.trim();
        const aiModel = aiModelSelect.value;

        const stored = await chrome.storage.local.get(['aiApiKeys', 'aiModels']);
        const aiApiKeys = { ...(stored.aiApiKeys || {}) };
        const aiModels = { ...(stored.aiModels || {}) };

        if (aiApiKey) {
            aiApiKeys[aiProvider] = aiApiKey;
            aiModels[aiProvider] = aiModel;
        } else {
            delete aiApiKeys[aiProvider];
            delete aiModels[aiProvider];
        }

        await chrome.storage.local.set({
            apiKey,
            apiType,
            aiProvider,
            aiApiKeys,
            aiModels,
        });
        settingsModal.classList.add('hidden');

        // Show confirmation toast
        showToast('Settings saved');
    });

    function populateAiModelOptions(provider, models, selectedModel, providerApiKey) {
        aiModelSelect.innerHTML = '';

        models.forEach(model => {
            const option = document.createElement('option');
            option.value = model;
            option.textContent = model;
            aiModelSelect.appendChild(option);
        });

        if (selectedModel && models.includes(selectedModel)) {
            aiModelSelect.value = selectedModel;
        } else if (models.length > 0) {
            aiModelSelect.value = models[0];
        }

        const hasKey = Boolean((providerApiKey || '').trim());
        aiModelSelect.disabled = !hasKey;
        aiModelHelp.textContent = hasKey
            ? `Available models for ${provider}`
            : 'Set API key for this provider to enable model selection.';
    }

    async function refreshAiModels({ provider, apiKey, selectedModel }) {
        const hasKey = Boolean((apiKey || '').trim());
        const requestId = ++aiFetchRequestId;

        if (!hasKey) {
            const fallback = FALLBACK_AI_PROVIDER_MODELS[provider] || [];
            populateAiModelOptions(provider, fallback, selectedModel, apiKey);
            return;
        }

        aiModelSelect.disabled = true;
        aiModelHelp.textContent = 'Loading models...';

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'AI_FETCH_MODELS',
                provider,
                apiKey,
            });

            if (requestId !== aiFetchRequestId) {
                return;
            }

            if (!response?.success) {
                throw new Error(response?.error || 'Failed to fetch models.');
            }

            const models = Array.isArray(response.data?.models) ? response.data.models : [];

            if (models.length === 0) {
                throw new Error('No models available from this provider.');
            }

            populateAiModelOptions(provider, models, selectedModel, apiKey);
            aiModelHelp.textContent = `Fetched ${models.length} models from ${provider}.`;
        } catch (error) {
            const fallback = FALLBACK_AI_PROVIDER_MODELS[provider] || [];
            populateAiModelOptions(provider, fallback, selectedModel, apiKey);
            aiModelHelp.textContent = `Model auto-fetch failed. Using fallback list for ${provider}.`;
        }
    }

    // --- Helpers ---
    function updateCharCount() {
        const count = sourceText.value.length;
        charCount.textContent = `${count.toLocaleString()} chars`;
    }

    function showLoading() {
        loadingIndicator.classList.remove('hidden');
    }

    function hideLoading() {
        loadingIndicator.classList.add('hidden');
    }

    function showError(msg) {
        errorDisplay.textContent = msg;
        errorDisplay.classList.remove('hidden');
    }

    function hideError() {
        errorDisplay.classList.add('hidden');
        errorDisplay.textContent = '';
    }

    function showToast(msg) {
        const toast = document.createElement('div');
        toast.className = 'copy-success';
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    }

    function getLangName(code) {
        const names = {
            'EN': 'English',
            'JA': '日本語',
            'DE': 'Deutsch',
            'FR': 'Français',
            'ES': 'Español',
            'IT': 'Italiano',
            'NL': 'Nederlands',
            'PL': 'Polski',
            'PT': 'Português',
            'RU': 'Русский',
            'ZH': '中文',
            'KO': '한국어',
            'BG': 'Български',
            'CS': 'Čeština',
            'DA': 'Dansk',
            'EL': 'Ελληνικά',
            'ET': 'Eesti',
            'FI': 'Suomi',
            'HU': 'Magyar',
            'ID': 'Bahasa Indonesia',
            'LT': 'Lietuvių',
            'LV': 'Latviešu',
            'NB': 'Norsk Bokmål',
            'RO': 'Română',
            'SK': 'Slovenčina',
            'SL': 'Slovenščina',
            'SV': 'Svenska',
            'TR': 'Türkçe',
            'UK': 'Українська',
        };
        return names[code] || code;
    }
})();

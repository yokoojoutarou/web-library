// ==============================
// Web Library Assistant — Content Script
// ==============================

(() => {
    let debounceTimer = null;
    let isContextAlive = true;
    let selectionPaletteTimer = null;
    let activeMarkerId = null;
    const MAX_PAGE_CONTEXT_CHARS = 22000;
    const MAX_SELECTION_CHARS = 4000;
    const MAX_MARKERS_PER_PAGE = 300;
    const RESTORE_RETRY_COUNT = 5;
    const RESTORE_RETRY_DELAY_MS = 350;
    const MARKER_COLORS = ['yellow', 'green', 'pink'];
    const markerCache = new Map();
    let selectionPaletteElement = null;
    let markerActionMenuElement = null;
    const NOISE_SELECTORS = [
        'script', 'style', 'noscript', 'svg', 'canvas', 'iframe',
        'header', 'footer', 'nav', 'aside',
        '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
        '.sidebar', '.sidenav', '.drawer', '.menu', '.breadcrumb', '.breadcrumbs',
        '.ad', '.ads', '.advertisement', '.sponsored', '.promo', '.share', '.social', '.related',
        '.cookie', '.consent', '.newsletter', '.subscription', '.comments', '.comment',
        '[aria-hidden="true"]', '[hidden]'
    ];

    function isRuntimeAvailable() {
        return Boolean(chrome?.runtime?.id);
    }

    function markContextInvalidated(error, trigger) {
        const message = error?.message || String(error);
        if (message.includes('Extension context invalidated')) {
            isContextAlive = false;
            console.warn('[Web Library Assistant][content] extension_context_invalidated', {
                trigger,
                error: message
            });
            return true;
        }
        return false;
    }

    function sendSelectedText(text, trigger) {
        if (!text || !isContextAlive || !isRuntimeAvailable()) {
            return;
        }

        try {
            Promise.resolve(
                chrome.runtime.sendMessage({
                    type: 'TEXT_SELECTED',
                    text: text
                })
            ).catch((error) => {
                if (!markContextInvalidated(error, trigger)) {
                    console.warn('[Web Library Assistant][content] text_selected_send_failed', {
                        trigger,
                        error: error?.message || String(error)
                    });
                }
            });
        } catch (error) {
            if (!markContextInvalidated(error, trigger)) {
                console.warn('[Web Library Assistant][content] text_selected_send_failed_sync', {
                    trigger,
                    error: error?.message || String(error)
                });
            }
        }
    }

    function normalizeText(text) {
        return (text || '')
            .replace(/\r\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();
    }

    function escapeRegExp(value) {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function extractActiveElementSelection() {
        const active = document.activeElement;
        if (!active) return '';

        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
            const start = active.selectionStart;
            const end = active.selectionEnd;
            if (typeof start === 'number' && typeof end === 'number' && end > start) {
                return (active.value || '').slice(start, end);
            }
        }

        return '';
    }

    function getCurrentSelectionText() {
        const selection = window.getSelection();
        const windowSelectionText = selection ? selection.toString() : '';
        const elementSelectionText = extractActiveElementSelection();
        const merged = normalizeText(windowSelectionText || elementSelectionText);
        return merged.slice(0, MAX_SELECTION_CHARS);
    }

    function removeNoiseNodes(root) {
        NOISE_SELECTORS.forEach((selector) => {
            root.querySelectorAll(selector).forEach((node) => node.remove());
        });
    }

    function collectStructuredText(root) {
        const blockNodes = root.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, pre, td');
        if (blockNodes.length === 0) {
            return normalizeText(root.textContent || '');
        }

        const parts = [];
        blockNodes.forEach((node) => {
            const text = normalizeText(node.textContent || '');
            if (text) parts.push(text);
        });

        return normalizeText(parts.join('\n'));
    }

    function getCandidateContentRoots(root) {
        const selectors = [
            'article',
            'main',
            '[role="main"]',
            '.article',
            '.post',
            '.entry-content',
            '.content',
            '#content'
        ];

        const roots = selectors.flatMap((selector) => Array.from(root.querySelectorAll(selector)));
        return roots.length > 0 ? roots : [root];
    }

    function scoreContentText(text) {
        const punctuationCount = (text.match(/[。！？.!?]/g) || []).length;
        return text.length + punctuationCount * 30;
    }

    function filterNoisyLines(text) {
        const rawLines = normalizeText(text).split('\n').map((line) => line.trim()).filter(Boolean);
        const freq = new Map();

        rawLines.forEach((line) => {
            freq.set(line, (freq.get(line) || 0) + 1);
        });

        const noisePattern = /^(menu|home|search|login|log in|sign in|sign up|privacy|terms|cookie|share|next|previous|トップ|メニュー|ログイン|利用規約|プライバシー|関連記事)$/i;

        const filtered = rawLines.filter((line) => {
            if (freq.get(line) > 2) return false;
            if (noisePattern.test(line)) return false;

            const hasSentenceSignal = /[。！？.!?]/.test(line);
            const isLongEnough = line.length >= 22;
            return hasSentenceSignal || isLongEnough;
        });

        return normalizeText(filtered.join('\n'));
    }

    function extractPageTextWithoutNoise() {
        if (!document.body) return '';

        const clonedBody = document.body.cloneNode(true);
        removeNoiseNodes(clonedBody);

        const candidates = getCandidateContentRoots(clonedBody);
        let bestText = '';
        let bestScore = -1;

        candidates.forEach((candidate) => {
            const structured = collectStructuredText(candidate);
            const filtered = filterNoisyLines(structured);
            const score = scoreContentText(filtered);

            if (score > bestScore) {
                bestScore = score;
                bestText = filtered;
            }
        });

        if (!bestText) {
            bestText = filterNoisyLines(collectStructuredText(clonedBody));
        }

        return bestText.slice(0, MAX_PAGE_CONTEXT_CHARS);
    }

    function collectPageContext() {
        const pageText = extractPageTextWithoutNoise();
        return {
            title: document.title || '',
            url: location.href || '',
            pageText,
            selectedText: getCurrentSelectionText(),
        };
    }

    function ensureMarkerStyles() {
        if (document.getElementById('deepl-marker-style')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'deepl-marker-style';
        style.textContent = `
            .deepl-marker-highlight {
                cursor: pointer;
                border-radius: 2px;
                box-decoration-break: clone;
                -webkit-box-decoration-break: clone;
            }
            .deepl-marker-highlight[data-marker-color="yellow"] {
                background: rgba(255, 226, 79, 0.45);
            }
            .deepl-marker-highlight[data-marker-color="green"] {
                background: rgba(34, 197, 94, 0.35);
            }
            .deepl-marker-highlight[data-marker-color="pink"] {
                background: rgba(244, 114, 182, 0.35);
            }
            .deepl-marker-ui {
                position: fixed;
                z-index: 2147483645;
                display: none;
                background: rgba(17, 24, 39, 0.96);
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 8px;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
                padding: 6px;
                gap: 6px;
                align-items: center;
            }
            .deepl-marker-ui button {
                border: none;
                width: 24px;
                height: 24px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 13px;
            }
            .deepl-marker-ui .deepl-marker-color-yellow { background: #fde047; }
            .deepl-marker-ui .deepl-marker-color-green { background: #22c55e; }
            .deepl-marker-ui .deepl-marker-color-pink { background: #f472b6; }
            .deepl-marker-ui .deepl-marker-delete {
                background: rgba(255, 255, 255, 0.08);
                color: #ffffff;
            }
        `;

        document.documentElement.appendChild(style);
    }

    function ensureSelectionPalette() {
        if (selectionPaletteElement) return;

        selectionPaletteElement = document.createElement('div');
        selectionPaletteElement.className = 'deepl-marker-ui';
        selectionPaletteElement.id = 'deepl-marker-selection-palette';
        selectionPaletteElement.innerHTML = `
            <button type="button" class="deepl-marker-color-yellow" data-color="yellow" title="Yellow" aria-label="Yellow marker"></button>
            <button type="button" class="deepl-marker-color-green" data-color="green" title="Green" aria-label="Green marker"></button>
            <button type="button" class="deepl-marker-color-pink" data-color="pink" title="Pink" aria-label="Pink marker"></button>
        `;

        selectionPaletteElement.addEventListener('mousedown', (event) => {
            event.preventDefault();
        });

        selectionPaletteElement.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-color]');
            if (!button) return;
            const color = button.dataset.color;
            if (!MARKER_COLORS.includes(color)) return;
            createMarkerFromSelection(color).catch(() => {});
        });

        document.body.appendChild(selectionPaletteElement);
    }

    function ensureMarkerActionMenu() {
        if (markerActionMenuElement) return;

        markerActionMenuElement = document.createElement('div');
        markerActionMenuElement.className = 'deepl-marker-ui';
        markerActionMenuElement.id = 'deepl-marker-action-menu';
        markerActionMenuElement.innerHTML = `
            <button type="button" class="deepl-marker-color-yellow" data-action="color" data-color="yellow" title="Yellow" aria-label="Change to yellow"></button>
            <button type="button" class="deepl-marker-color-green" data-action="color" data-color="green" title="Green" aria-label="Change to green"></button>
            <button type="button" class="deepl-marker-color-pink" data-action="color" data-color="pink" title="Pink" aria-label="Change to pink"></button>
            <button type="button" class="deepl-marker-delete" data-action="delete" title="Delete" aria-label="Delete marker">🗑</button>
        `;

        markerActionMenuElement.addEventListener('mousedown', (event) => {
            event.preventDefault();
        });

        markerActionMenuElement.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-action]');
            if (!button || !activeMarkerId) return;

            const action = button.dataset.action;
            if (action === 'delete') {
                deleteMarker(activeMarkerId).catch(() => {});
                return;
            }

            if (action === 'color') {
                const color = button.dataset.color;
                if (!MARKER_COLORS.includes(color)) return;
                recolorMarker(activeMarkerId, color).catch(() => {});
            }
        });

        document.body.appendChild(markerActionMenuElement);
    }

    function showUiAt(uiElement, rect) {
        if (!uiElement || !rect) return;

        uiElement.style.visibility = 'hidden';
        uiElement.style.display = 'flex';

        const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0);
        const viewportHeight = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0);
        const uiWidth = uiElement.offsetWidth || 0;
        const uiHeight = uiElement.offsetHeight || 0;
        const margin = 8;

        const minLeft = margin;
        const maxLeft = Math.max(minLeft, viewportWidth - uiWidth - margin);
        const minTop = margin;
        const maxTop = Math.max(minTop, viewportHeight - uiHeight - margin);

        const top = Math.max(minTop, Math.min(maxTop, rect.top - 42));
        const left = Math.max(minLeft, Math.min(maxLeft, rect.left));

        uiElement.style.top = `${top}px`;
        uiElement.style.left = `${left}px`;
        uiElement.style.visibility = 'visible';
    }

    function hideSelectionPalette() {
        if (selectionPaletteElement) {
            selectionPaletteElement.style.display = 'none';
        }
    }

    function hideMarkerActionMenu() {
        if (markerActionMenuElement) {
            markerActionMenuElement.style.display = 'none';
        }
        activeMarkerId = null;
    }

    function getTextWalker() {
        return document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node || !node.nodeValue || !node.nodeValue.trim()) {
                    return NodeFilter.FILTER_REJECT;
                }

                const parent = node.parentElement;
                if (!parent) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (parent.closest('.deepl-marker-ui')) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (parent.closest('.deepl-marker-highlight,[contenteditable="true"]')) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (parent.closest('script,style,noscript,textarea,input')) {
                    return NodeFilter.FILTER_REJECT;
                }

                return NodeFilter.FILTER_ACCEPT;
            },
        });
    }

    function getGlobalTextOffset(targetNode, targetOffset) {
        const walker = getTextWalker();
        let current = walker.nextNode();
        let offset = 0;

        while (current) {
            const length = current.nodeValue.length;
            if (current === targetNode) {
                return offset + Math.min(targetOffset, length);
            }
            offset += length;
            current = walker.nextNode();
        }

        return -1;
    }

    function resolveTextPosition(globalOffset) {
        const safeOffset = Math.max(0, Number(globalOffset) || 0);
        const walker = getTextWalker();
        let current = walker.nextNode();
        let offset = 0;
        let lastTextNode = null;

        while (current) {
            const length = current.nodeValue.length;
            const nextOffset = offset + length;
            lastTextNode = current;

            if (safeOffset <= nextOffset) {
                return {
                    node: current,
                    offset: Math.max(0, Math.min(length, safeOffset - offset)),
                };
            }

            offset = nextOffset;
            current = walker.nextNode();
        }

        if (!lastTextNode) return null;
        return {
            node: lastTextNode,
            offset: lastTextNode.nodeValue.length,
        };
    }

    function buildRangeDescriptor(range) {
        const start = getGlobalTextOffset(range.startContainer, range.startOffset);
        const end = getGlobalTextOffset(range.endContainer, range.endOffset);

        if (start < 0 || end < 0 || end <= start) {
            return null;
        }

        return { start, end };
    }

    function buildRangeFromDescriptor(rangeDescriptor) {
        if (!rangeDescriptor || !Number.isFinite(rangeDescriptor.start) || !Number.isFinite(rangeDescriptor.end)) {
            return null;
        }

        const start = resolveTextPosition(rangeDescriptor.start);
        const end = resolveTextPosition(rangeDescriptor.end);

        if (!start || !end) {
            return null;
        }

        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);

        if (range.collapsed) {
            return null;
        }

        return range;
    }

    function collectTextSegmentsInRange(range) {
        const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
            ? range.commonAncestorContainer.parentNode
            : range.commonAncestorContainer;

        if (!root) return [];

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node || !node.nodeValue || !node.nodeValue.trim()) {
                    return NodeFilter.FILTER_REJECT;
                }

                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                if (parent.closest('.deepl-marker-ui')) return NodeFilter.FILTER_REJECT;
                if (parent.closest('.deepl-marker-highlight')) return NodeFilter.FILTER_REJECT;
                if (parent.closest('script,style,noscript,textarea,input,[contenteditable="true"]')) {
                    return NodeFilter.FILTER_REJECT;
                }

                if (!range.intersectsNode(node)) {
                    return NodeFilter.FILTER_REJECT;
                }

                return NodeFilter.FILTER_ACCEPT;
            },
        });

        const segments = [];
        let node = walker.nextNode();

        while (node) {
            const length = node.nodeValue.length;
            let start = 0;
            let end = length;

            if (node === range.startContainer) {
                start = range.startOffset;
            }

            if (node === range.endContainer) {
                end = range.endOffset;
            }

            if (end > start) {
                segments.push({ node, start, end });
            }

            node = walker.nextNode();
        }

        return segments;
    }

    function createMarkerSpan(markerId, color) {
        const span = document.createElement('span');
        span.className = 'deepl-marker-highlight';
        span.dataset.markerId = markerId;
        span.dataset.markerColor = color;
        return span;
    }

    function applyRangeMarker(range, markerId, color) {
        const segments = collectTextSegmentsInRange(range);
        if (segments.length === 0) {
            return false;
        }

        segments.reverse().forEach((segment) => {
            let { node, start, end } = segment;

            if (end < node.nodeValue.length) {
                node.splitText(end);
            }

            if (start > 0) {
                node = node.splitText(start);
            }

            const span = createMarkerSpan(markerId, color);
            const parent = node.parentNode;
            if (!parent) return;
            parent.replaceChild(span, node);
            span.appendChild(node);
        });

        return true;
    }

    function setMarkerColorInDom(markerId, color) {
        document.querySelectorAll('.deepl-marker-highlight').forEach((element) => {
            if (element.dataset.markerId === markerId) {
                element.dataset.markerColor = color;
            }
        });
    }

    function removeMarkerFromDom(markerId) {
        const targets = [];
        document.querySelectorAll('.deepl-marker-highlight').forEach((element) => {
            if (element.dataset.markerId === markerId) {
                targets.push(element);
            }
        });

        targets.forEach((element) => {
            const parent = element.parentNode;
            if (!parent) return;

            while (element.firstChild) {
                parent.insertBefore(element.firstChild, element);
            }

            parent.removeChild(element);
            parent.normalize();
        });
    }

    function findRangeByTextQuote(textQuote) {
        const quote = String(textQuote || '');
        if (!quote.trim()) {
            return null;
        }

        const normalizedQuote = normalizeText(quote);
        if (!normalizedQuote) {
            return null;
        }

        const walker = getTextWalker();
        let node = walker.nextNode();
        while (node) {
            const index = node.nodeValue.indexOf(quote);
            if (index >= 0) {
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + quote.length);
                return range;
            }
            node = walker.nextNode();
        }

        const nodeMeta = [];
        const textWalker = getTextWalker();
        let textNode = textWalker.nextNode();
        let mergedText = '';

        while (textNode) {
            const start = mergedText.length;
            mergedText += textNode.nodeValue;
            const end = mergedText.length;
            nodeMeta.push({ node: textNode, start, end });
            textNode = textWalker.nextNode();
        }

        const quoteTokens = normalizedQuote.split(/\s+/).filter(Boolean);
        if (quoteTokens.length === 0) {
            return null;
        }

        const whitespaceTolerantPattern = quoteTokens
            .map((token) => escapeRegExp(token))
            .join('\\s+');
        const regex = new RegExp(whitespaceTolerantPattern);
        const match = regex.exec(mergedText);
        if (!match) {
            return null;
        }

        const quoteRawIndex = match.index;
        const quoteRawEnd = Math.min(mergedText.length, quoteRawIndex + match[0].length);

        if (quoteRawIndex < 0) {
            return null;
        }

        let startPoint = null;
        let endPoint = null;

        nodeMeta.forEach((meta) => {
            if (!startPoint && quoteRawIndex >= meta.start && quoteRawIndex <= meta.end) {
                startPoint = {
                    node: meta.node,
                    offset: Math.max(0, Math.min(meta.node.nodeValue.length, quoteRawIndex - meta.start)),
                };
            }

            if (!endPoint && quoteRawEnd >= meta.start && quoteRawEnd <= meta.end) {
                endPoint = {
                    node: meta.node,
                    offset: Math.max(0, Math.min(meta.node.nodeValue.length, quoteRawEnd - meta.start)),
                };
            }
        });

        if (!startPoint || !endPoint) {
            return null;
        }

        const range = document.createRange();
        range.setStart(startPoint.node, startPoint.offset);
        range.setEnd(endPoint.node, endPoint.offset);

        if (range.collapsed) {
            return null;
        }

        return range;
    }

    function getValidSelectionRange() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return null;
        }

        const range = selection.getRangeAt(0);
        if (range.collapsed || !range.toString().trim()) {
            return null;
        }

        const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
        const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE
            ? range.endContainer
            : range.endContainer.parentElement;

        if (!startElement || !endElement) {
            return null;
        }

        if (startElement.closest('.deepl-marker-ui,.deepl-marker-highlight,[contenteditable="true"]') || endElement.closest('.deepl-marker-ui,.deepl-marker-highlight,[contenteditable="true"]')) {
            return null;
        }

        if (startElement.closest('script,style,noscript,textarea,input') || endElement.closest('script,style,noscript,textarea,input')) {
            return null;
        }

        return range;
    }

    function scheduleSelectionPalette() {
        clearTimeout(selectionPaletteTimer);
        selectionPaletteTimer = setTimeout(() => {
            const range = getValidSelectionRange();
            if (!range) {
                hideSelectionPalette();
                return;
            }

            ensureSelectionPalette();
            const rect = range.getBoundingClientRect();
            if (!rect || (rect.width === 0 && rect.height === 0)) {
                hideSelectionPalette();
                return;
            }

            showUiAt(selectionPaletteElement, rect);
        }, 140);
    }

    async function sendDbOp(operation, payload = {}) {
        return chrome.runtime.sendMessage({
            type: 'DB_OP',
            operation,
            payload,
        });
    }

    async function createMarkerFromSelection(color) {
        const range = getValidSelectionRange();
        if (!range) {
            hideSelectionPalette();
            return;
        }

        const rangeDescriptor = buildRangeDescriptor(range);
        if (!rangeDescriptor) {
            hideSelectionPalette();
            return;
        }

        const textQuote = normalizeText(range.toString()).slice(0, 600);
        const response = await sendDbOp('marker.upsert', {
            url: location.href,
            title: document.title,
            color,
            rangeDescriptor,
            domLocator: {
                href: location.href,
            },
            textQuote,
        });

        if (!response?.success || !response.data) {
            return;
        }

        const marker = response.data;
        markerCache.set(marker.markerId, marker);
        applyRangeMarker(range, marker.markerId, marker.color);

        const selection = window.getSelection();
        if (selection) selection.removeAllRanges();
        hideSelectionPalette();
    }

    async function recolorMarker(markerId, color) {
        const existing = markerCache.get(markerId);
        if (!existing) return;

        const response = await sendDbOp('marker.upsert', {
            markerId,
            url: location.href,
            title: document.title,
            color,
            rangeDescriptor: existing.rangeDescriptor,
            domLocator: existing.domLocator,
            textQuote: existing.textQuote,
            tags: existing.tags || [],
        });

        if (!response?.success || !response.data) {
            return;
        }

        markerCache.set(markerId, response.data);
        setMarkerColorInDom(markerId, color);
        hideMarkerActionMenu();
    }

    async function deleteMarker(markerId) {
        const response = await sendDbOp('marker.delete', { markerId });
        if (!response?.success) {
            return;
        }

        markerCache.delete(markerId);
        removeMarkerFromDom(markerId);
        hideMarkerActionMenu();
    }

    function showMarkerActionMenu(markerId, rect) {
        activeMarkerId = markerId;
        ensureMarkerActionMenu();
        showUiAt(markerActionMenuElement, rect);
    }

    function scrollToMarker(markerId) {
        let target = null;
        document.querySelectorAll('.deepl-marker-highlight').forEach((element) => {
            if (!target && element.dataset.markerId === markerId) {
                target = element;
            }
        });

        if (!target) return false;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return true;
    }

    function restoreMarker(marker) {
        if (!marker?.markerId || !marker?.color) return false;

        const range = buildRangeFromDescriptor(marker.rangeDescriptor) || findRangeByTextQuote(marker.textQuote);
        if (!range) return false;

        const applied = applyRangeMarker(range, marker.markerId, marker.color);
        if (applied) {
            markerCache.set(marker.markerId, marker);
        }

        return applied;
    }

    async function restoreMarkersForCurrentPage() {
        const response = await sendDbOp('marker.listBySite', { url: location.href });
        if (!response?.success || !Array.isArray(response.data)) {
            return { total: 0, restored: 0 };
        }

        const markers = response.data.slice(0, MAX_MARKERS_PER_PAGE);
        let restoredCount = 0;

        markers.forEach((marker) => {
            if (restoreMarker(marker)) {
                restoredCount += 1;
            }
        });

        return {
            total: markers.length,
            restored: restoredCount,
        };
    }

    function wait(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    async function restoreMarkersWithRetry() {
        let attempt = 0;
        let lastResult = { total: 0, restored: 0 };

        while (attempt <= RESTORE_RETRY_COUNT) {
            lastResult = await restoreMarkersForCurrentPage();
            if (lastResult.total === 0 || lastResult.restored >= lastResult.total) {
                return lastResult;
            }

            attempt += 1;
            if (attempt > RESTORE_RETRY_COUNT) {
                break;
            }

            await wait(RESTORE_RETRY_DELAY_MS);
        }

        return lastResult;
    }

    function handleDocumentClick(event) {
        const marker = event.target.closest('.deepl-marker-highlight');
        const inSelectionPalette = selectionPaletteElement && selectionPaletteElement.contains(event.target);
        const inActionMenu = markerActionMenuElement && markerActionMenuElement.contains(event.target);

        if (marker) {
            event.preventDefault();
            const markerId = marker.dataset.markerId;
            if (!markerId) return;
            showMarkerActionMenu(markerId, marker.getBoundingClientRect());
            hideSelectionPalette();
            return;
        }

        if (!inSelectionPalette) {
            hideSelectionPalette();
        }

        if (!inActionMenu) {
            hideMarkerActionMenu();
        }
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type === 'REQUEST_PAGE_CONTEXT') {
            try {
                sendResponse({ success: true, data: collectPageContext() });
            } catch (error) {
                sendResponse({ success: false, error: error?.message || String(error) });
            }
            return true;
        }

        if (message?.type === 'MARKER_SCROLL_TO') {
            const markerId = String(message.markerId || '');

            (async () => {
                let ok = scrollToMarker(markerId);
                if (!ok) {
                    await restoreMarkersWithRetry();
                    ok = scrollToMarker(markerId);
                }
                sendResponse({ success: ok });
            })().catch(() => {
                sendResponse({ success: false });
            });

            return true;
        }

        if (message?.type === 'MARKER_REMOVE') {
            const markerId = String(message.markerId || '');
            if (markerId) {
                markerCache.delete(markerId);
                removeMarkerFromDom(markerId);
            }
            sendResponse({ success: true });
            return true;
        }
    });

    // Listen for text selection via mouseup
    document.addEventListener('mouseup', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const selection = window.getSelection();
            const text = selection ? selection.toString().trim() : '';

            if (text.length > 0) {
                sendSelectedText(text, 'mouseup');
            }
        }, 250);

        scheduleSelectionPalette();
    });

    // Also handle keyboard-based selection (Shift+Arrow keys)
    document.addEventListener('keyup', (e) => {
        if (e.shiftKey) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const selection = window.getSelection();
                const text = selection ? selection.toString().trim() : '';

                if (text.length > 0) {
                    sendSelectedText(text, 'keyup_shift');
                }
            }, 400);
        }

        scheduleSelectionPalette();
    });

    document.addEventListener('selectionchange', () => {
        scheduleSelectionPalette();
    });

    document.addEventListener('click', handleDocumentClick, true);
    window.addEventListener('scroll', () => {
        hideSelectionPalette();
        hideMarkerActionMenu();
    }, true);

    window.addEventListener('resize', () => {
        hideSelectionPalette();
        hideMarkerActionMenu();
    });

    ensureMarkerStyles();
    ensureSelectionPalette();
    ensureMarkerActionMenu();
    restoreMarkersWithRetry().catch(() => {});
})();

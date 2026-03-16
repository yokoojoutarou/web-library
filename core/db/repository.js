/* global Dexie */

(function initExtensionDb(global) {
  const DB_NAME = 'deepl_translate_extension_db';
  const DB_VERSION = 3;

  class ExtensionDb extends Dexie {
    constructor() {
      super(DB_NAME);

      this.version(1).stores({
        sites: '&siteId,url,updatedAt,*tags',
        chats: '&chatId,siteId,createdAt,updatedAt,*tags',
        notes: '&noteId,siteId,createdAt,updatedAt,*tags',
        markers: '&markerId,siteId,createdAt,updatedAt,color,*tags',
      });

      this.version(DB_VERSION).stores({
        sites: '&siteId,url,updatedAt,*tags',
        // Deprecated: use chatThreads going forward.
        chats: '&chatId,siteId,createdAt,updatedAt,[siteId+updatedAt]',
        chatThreads: '&threadId,siteId,updatedAt,createdAt,[siteId+updatedAt]',
        notes: '&noteId,siteId,createdAt,updatedAt,*tags,[siteId+updatedAt]',
        markers: '&markerId,siteId,createdAt,updatedAt,color,*tags,[siteId+updatedAt]',
      });
    }
  }

  const db = new ExtensionDb();

  function nowIso() {
    return new Date().toISOString();
  }

  function normalizeUrl(url) {
    if (!url || typeof url !== 'string') return '';

    try {
      const parsed = new URL(url.trim());
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return url.trim();
    }
  }

  function siteIdFromUrl(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      throw new Error('URL is required to build siteId.');
    }
    return normalized;
  }

  function normalizeTag(tag) {
    return String(tag || '').trim().toLowerCase();
  }

  function normalizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    const set = new Set(tags.map(normalizeTag).filter(Boolean));
    return [...set];
  }

  async function ensureSite({ url, title = '', tags = [] }) {
    const siteId = siteIdFromUrl(url);
    const timestamp = nowIso();
    const existing = await db.sites.get(siteId);
    const normalizedTags = normalizeTags(tags);

    if (existing) {
      const mergedTags = normalizeTags([...(existing.tags || []), ...normalizedTags]);
      await db.sites.update(siteId, {
        url: normalizeUrl(url),
        title: title || existing.title || '',
        tags: mergedTags,
        updatedAt: timestamp,
      });
      return { ...(await db.sites.get(siteId)) };
    }

    const site = {
      siteId,
      url: normalizeUrl(url),
      title: title || '',
      tags: normalizedTags,
      createdAt: timestamp,
      updatedAt: timestamp,
      schemaVersion: 1,
    };

    await db.sites.put(site);
    return { ...site };
  }

  function rangeBySiteAndUpdatedAt(siteId) {
    return {
      lower: [siteId, Dexie.minKey],
      upper: [siteId, Dexie.maxKey],
    };
  }

  /** @deprecated Use thread APIs instead. */
  async function saveChat({ url, title = '', messages = [], tags = [] }) {
    if (!Array.isArray(messages)) {
      throw new Error('messages must be an array.');
    }

    const site = await ensureSite({ url, title, tags });
    const timestamp = nowIso();
    const chat = {
      chatId: global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      siteId: site.siteId,
      url: site.url,
      title: site.title,
      messages,
      createdAt: timestamp,
      updatedAt: timestamp,
      schemaVersion: 1,
    };

    await db.chats.put(chat);
    await db.sites.update(site.siteId, { updatedAt: timestamp });
    return { ...chat };
  }

  function createThreadTitleSeed(seed) {
    const text = String(seed || '').replace(/\s+/g, ' ').trim();
    if (!text) return 'New Chat';
    return text.length > 60 ? `${text.slice(0, 59)}…` : text;
  }

  async function createThread({ url = '', siteId = '', title = '' }) {
    const timestamp = nowIso();
    let resolvedSiteId = siteId || '';

    if (!resolvedSiteId && url) {
      const site = await ensureSite({ url, title: title || '' });
      resolvedSiteId = site.siteId;
    }

    const thread = {
      threadId: global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      siteId: resolvedSiteId || null,
      title: createThreadTitleSeed(title),
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 0,
      schemaVersion: 2,
    };

    await db.chatThreads.put(thread);
    return { ...thread };
  }

  async function getThread(threadId) {
    if (!threadId) return null;
    return db.chatThreads.get(threadId);
  }

  async function listThreads({ limit = 50 } = {}) {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
    const items = await db.chatThreads.orderBy('updatedAt').reverse().limit(safeLimit).toArray();
    return items.map((thread) => ({
      threadId: thread.threadId,
      siteId: thread.siteId || null,
      title: thread.title || 'New Chat',
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messageCount: Number(thread.messageCount || (Array.isArray(thread.messages) ? thread.messages.length : 0)),
      schemaVersion: thread.schemaVersion,
    }));
  }

  async function updateThreadTitle({ threadId, title }) {
    if (!threadId) throw new Error('threadId is required.');
    const normalizedTitle = createThreadTitleSeed(title);
    await db.chatThreads.update(threadId, {
      title: normalizedTitle,
      updatedAt: nowIso(),
    });
    return db.chatThreads.get(threadId);
  }

  async function appendThreadMessages({ threadId, messages = [] }) {
    if (!threadId) throw new Error('threadId is required.');
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('messages must be a non-empty array.');
    }

    const timestamp = nowIso();
    let threadExists = false;
    let affectedSiteId = null;

    await db.transaction('rw', db.chatThreads, db.sites, async () => {
      await db.chatThreads.where('threadId').equals(threadId).modify((thread) => {
        threadExists = true;
        const current = Array.isArray(thread.messages) ? thread.messages : [];
        const merged = [...current, ...messages];
        thread.messages = merged;
        thread.messageCount = merged.length;
        thread.updatedAt = timestamp;
        affectedSiteId = thread.siteId || null;
      });

      if (!threadExists) {
        throw new Error('Thread not found.');
      }

      if (affectedSiteId) {
        await db.sites.update(affectedSiteId, { updatedAt: timestamp });
      }
    });

    return db.chatThreads.get(threadId);
  }

  /** @deprecated Use thread APIs instead. */
  async function getChatsBySite({ siteId, url }) {
    const id = siteId || (url ? siteIdFromUrl(url) : '');
    if (!id) return [];
    const range = rangeBySiteAndUpdatedAt(id);
    return db.chats
      .where('[siteId+updatedAt]')
      .between(range.lower, range.upper, true, true)
      .reverse()
      .toArray();
  }

  async function upsertNote({ noteId, siteId, url, markdown = '', sourceLinks = [], tags = [] }) {
    const timestamp = nowIso();
    const id = siteId || (url ? siteIdFromUrl(url) : '');
    if (!id) throw new Error('siteId or url is required.');

    if (url) {
      await ensureSite({ url });
    }

    const resolvedNoteId = noteId || global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const existing = await db.notes.get(resolvedNoteId);
    const note = {
      noteId: resolvedNoteId,
      siteId: id,
      markdown,
      sourceLinks: Array.isArray(sourceLinks) ? sourceLinks : [],
      tags: normalizeTags(tags),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      schemaVersion: 1,
    };

    await db.notes.put(note);
    await db.sites.update(id, { updatedAt: timestamp });
    return { ...note };
  }

  async function getNotesBySite({ siteId, url }) {
    const id = siteId || (url ? siteIdFromUrl(url) : '');
    if (!id) return [];
    const range = rangeBySiteAndUpdatedAt(id);
    return db.notes
      .where('[siteId+updatedAt]')
      .between(range.lower, range.upper, true, true)
      .reverse()
      .toArray();
  }

  async function deleteNote(noteId) {
    if (!noteId) return false;
    await db.notes.delete(noteId);
    return true;
  }

  async function upsertMarker({ markerId, siteId, url, color, rangeDescriptor, domLocator, textQuote = '', tags = [] }) {
    const timestamp = nowIso();
    const id = siteId || (url ? siteIdFromUrl(url) : '');
    if (!id) throw new Error('siteId or url is required.');
    if (!color) throw new Error('color is required.');

    if (url) {
      await ensureSite({ url });
    }

    const resolvedMarkerId = markerId || global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const existing = await db.markers.get(resolvedMarkerId);
    const marker = {
      markerId: resolvedMarkerId,
      siteId: id,
      color,
      rangeDescriptor: rangeDescriptor || null,
      domLocator: domLocator || null,
      textQuote: String(textQuote || ''),
      tags: normalizeTags(tags),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      schemaVersion: 1,
    };

    await db.markers.put(marker);
    await db.sites.update(id, { updatedAt: timestamp });
    return { ...marker };
  }

  async function getMarkersBySite({ siteId, url }) {
    const id = siteId || (url ? siteIdFromUrl(url) : '');
    if (!id) return [];
    const range = rangeBySiteAndUpdatedAt(id);
    return db.markers
      .where('[siteId+updatedAt]')
      .between(range.lower, range.upper, true, true)
      .reverse()
      .toArray();
  }

  async function deleteMarker(markerId) {
    if (!markerId) return false;
    await db.markers.delete(markerId);
    return true;
  }

  async function setSiteTags({ siteId, tags }) {
    if (!siteId) throw new Error('siteId is required.');
    await db.sites.update(siteId, { tags: normalizeTags(tags), updatedAt: nowIso() });
    return db.sites.get(siteId);
  }

  async function setNoteTags({ noteId, tags }) {
    if (!noteId) throw new Error('noteId is required.');
    await db.notes.update(noteId, { tags: normalizeTags(tags), updatedAt: nowIso() });
    return db.notes.get(noteId);
  }

  async function renameTag({ from, to }) {
    const source = normalizeTag(from);
    const target = normalizeTag(to);

    if (!source || !target) {
      throw new Error('Both from and to tags are required.');
    }

    const updateTagArray = (tags) => {
      if (!Array.isArray(tags) || tags.length === 0) return tags || [];
      return normalizeTags(tags.map((tag) => (normalizeTag(tag) === source ? target : normalizeTag(tag))));
    };

    await db.transaction('rw', db.sites, db.markers, async () => {
      await db.sites.toCollection().modify((site) => {
        site.tags = updateTagArray(site.tags);
        site.updatedAt = nowIso();
      });

      await db.markers.toCollection().modify((marker) => {
        marker.tags = updateTagArray(marker.tags);
        marker.updatedAt = nowIso();
      });
    });

    return true;
  }

  async function findByTag({ entity, tag }) {
    const normalized = normalizeTag(tag);
    if (!normalized) return [];

    if (entity === 'sites') {
      return db.sites.where('tags').equals(normalized).toArray();
    }

    if (entity === 'markers') {
      return db.markers.where('tags').equals(normalized).toArray();
    }

    throw new Error('Unsupported entity. Use "sites" or "markers".');
  }

  async function getSiteByUrl(url) {
    const siteId = siteIdFromUrl(url);
    return db.sites.get(siteId);
  }

  global.ExtensionRepository = {
    db,
    normalizeTags,
    siteIdFromUrl,
    ensureSite,
    saveChat,
    getChatsBySite,
    upsertNote,
    getNotesBySite,
    deleteNote,
    upsertMarker,
    getMarkersBySite,
    deleteMarker,
    setSiteTags,
    setNoteTags,
    renameTag,
    findByTag,
    getSiteByUrl,
    createThread,
    getThread,
    listThreads,
    updateThreadTitle,
    appendThreadMessages,
  };
})(globalThis);

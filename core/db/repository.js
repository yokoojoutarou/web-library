/* global Dexie */

(function initExtensionDb(global) {
  const DB_NAME = 'deepl_translate_extension_db';
  const DB_VERSION = 4;

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
        folders: '&folderId,parentFolderId,updatedAt,[parentFolderId+updatedAt],nameLower',
        siteFolders: '&siteId,folderId,updatedAt,[folderId+updatedAt]',
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

  function normalizeFolderName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim();
  }

  function toFolderNameLower(name) {
    return normalizeFolderName(name).toLowerCase();
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

  function buildFolderTree(folders) {
    const byId = new Map();
    const roots = [];

    folders.forEach((folder) => {
      byId.set(folder.folderId, {
        ...folder,
        children: [],
      });
    });

    folders.forEach((folder) => {
      const node = byId.get(folder.folderId);
      if (!node) return;

      const parentId = folder.parentFolderId || null;
      const parent = parentId ? byId.get(parentId) : null;

      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    });

    const sortNodes = (nodes) => {
      nodes.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      nodes.forEach((node) => sortNodes(node.children));
    };

    sortNodes(roots);
    return roots;
  }

  async function createFolder({ name, parentFolderId = null }) {
    const normalizedName = normalizeFolderName(name);
    if (!normalizedName) {
      throw new Error('Folder name is required.');
    }

    const timestamp = nowIso();
    const resolvedParent = parentFolderId || null;
    if (resolvedParent) {
      const parent = await db.folders.get(resolvedParent);
      if (!parent) {
        throw new Error('Parent folder not found.');
      }
    }

    const folder = {
      folderId: global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      name: normalizedName,
      nameLower: toFolderNameLower(normalizedName),
      parentFolderId: resolvedParent,
      createdAt: timestamp,
      updatedAt: timestamp,
      schemaVersion: 1,
    };

    await db.folders.put(folder);
    return { ...folder };
  }

  async function renameFolder({ folderId, name }) {
    if (!folderId) {
      throw new Error('folderId is required.');
    }

    const normalizedName = normalizeFolderName(name);
    if (!normalizedName) {
      throw new Error('Folder name is required.');
    }

    await db.folders.update(folderId, {
      name: normalizedName,
      nameLower: toFolderNameLower(normalizedName),
      updatedAt: nowIso(),
    });

    return db.folders.get(folderId);
  }

  async function deleteFolder({ folderId }) {
    if (!folderId) {
      throw new Error('folderId is required.');
    }

    const folder = await db.folders.get(folderId);
    if (!folder) {
      return false;
    }

    const parentFolderId = folder.parentFolderId || null;
    const timestamp = nowIso();

    await db.transaction('rw', db.folders, db.siteFolders, async () => {
      await db.folders.where('parentFolderId').equals(folderId).modify((child) => {
        child.parentFolderId = parentFolderId;
        child.updatedAt = timestamp;
      });

      await db.siteFolders.where('folderId').equals(folderId).modify((link) => {
        link.folderId = null;
        link.updatedAt = timestamp;
      });

      await db.folders.delete(folderId);
    });

    return true;
  }

  async function listFolders() {
    const folders = await db.folders.toArray();
    const siteLinks = await db.siteFolders.toArray();
    const siteCountMap = siteLinks.reduce((map, link) => {
      const folderId = link.folderId || null;
      if (!folderId) return map;
      map.set(folderId, (map.get(folderId) || 0) + 1);
      return map;
    }, new Map());

    const normalizedFolders = folders
      .map((folder) => ({
        ...folder,
        parentFolderId: folder.parentFolderId || null,
        siteCount: siteCountMap.get(folder.folderId) || 0,
      }))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    const tree = buildFolderTree(normalizedFolders);
    return {
      folders: normalizedFolders,
      tree,
    };
  }

  async function moveFolder({ folderId, targetParentFolderId = null }) {
    if (!folderId) {
      throw new Error('folderId is required.');
    }

    const source = await db.folders.get(folderId);
    if (!source) {
      throw new Error('Folder not found.');
    }

    const nextParentId = targetParentFolderId || null;
    if (nextParentId === folderId) {
      throw new Error('A folder cannot be moved into itself.');
    }

    if (nextParentId) {
      const targetParent = await db.folders.get(nextParentId);
      if (!targetParent) {
        throw new Error('Target parent folder not found.');
      }

      let cursor = targetParent;
      while (cursor) {
        if (cursor.folderId === folderId) {
          throw new Error('A folder cannot be moved into its descendant.');
        }
        if (!cursor.parentFolderId) break;
        cursor = await db.folders.get(cursor.parentFolderId);
      }
    }

    const timestamp = nowIso();
    await db.folders.update(folderId, {
      parentFolderId: nextParentId,
      updatedAt: timestamp,
    });

    return db.folders.get(folderId);
  }

  async function moveSiteToFolder({ siteId, url, title = '', targetFolderId = null }) {
    const timestamp = nowIso();
    let resolvedSiteId = siteId || '';

    if (!resolvedSiteId) {
      if (!url) {
        throw new Error('siteId or url is required.');
      }
      const site = await ensureSite({ url, title });
      resolvedSiteId = site.siteId;
    }

    if (targetFolderId) {
      const target = await db.folders.get(targetFolderId);
      if (!target) {
        throw new Error('Target folder not found.');
      }
    }

    const existing = await db.siteFolders.get(resolvedSiteId);
    const link = {
      siteId: resolvedSiteId,
      folderId: targetFolderId || null,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      schemaVersion: 1,
    };

    await db.siteFolders.put(link);
    await db.sites.update(resolvedSiteId, { updatedAt: timestamp });
    return { ...link };
  }

  async function createSiteFolderFromSite({ siteId, url, title = '', parentFolderId = null }) {
    let resolvedSite = null;

    if (siteId) {
      resolvedSite = await db.sites.get(siteId);
      if (!resolvedSite) {
        throw new Error('Site not found.');
      }
    } else {
      if (!url) {
        throw new Error('siteId or url is required.');
      }
      resolvedSite = await ensureSite({ url, title });
    }

    const normalizedTitle = normalizeFolderName(title || resolvedSite.title || '');
    if (!normalizedTitle && url) {
      await ensureSite({ url, title: String(url || '') });
      resolvedSite = await db.sites.get(resolvedSite.siteId);
    }

    if (!resolvedSite?.siteId) {
      throw new Error('Failed to resolve site for folder creation.');
    }

    const existingLink = await db.siteFolders.get(resolvedSite.siteId);
    if (existingLink?.folderId) {
      const existingFolder = await db.folders.get(existingLink.folderId);
      if (existingFolder) {
        return {
          created: false,
          folder: { ...existingFolder },
          link: { ...existingLink },
          site: { ...resolvedSite },
        };
      }
    }

    const folderName = normalizeFolderName(
      resolvedSite.title || title || resolvedSite.url || 'Untitled Site'
    );
    const folder = await createFolder({
      name: folderName || 'Untitled Site',
      parentFolderId,
    });

    const link = await moveSiteToFolder({
      siteId: resolvedSite.siteId,
      targetFolderId: folder.folderId,
    });

    return {
      created: true,
      folder,
      link,
      site: { ...resolvedSite },
    };
  }

  async function listLibrarySites({ folderId = null, query = '', limit = 500 } = {}) {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 500;
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const targetFolderId = folderId || null;

    const [sites, siteLinks, notes, markers] = await Promise.all([
      db.sites.orderBy('updatedAt').reverse().toArray(),
      db.siteFolders.toArray(),
      db.notes.toArray(),
      db.markers.toArray(),
    ]);

    const folderBySite = siteLinks.reduce((map, link) => {
      map.set(link.siteId, link.folderId || null);
      return map;
    }, new Map());

    const notesBySite = notes.reduce((map, note) => {
      if (!note?.siteId) return map;
      const bucket = map.get(note.siteId) || [];
      bucket.push(note);
      map.set(note.siteId, bucket);
      return map;
    }, new Map());

    const markersBySiteCount = markers.reduce((map, marker) => {
      if (!marker?.siteId) return map;
      map.set(marker.siteId, (map.get(marker.siteId) || 0) + 1);
      return map;
    }, new Map());

    return sites
      .filter((site) => {
        const assignedFolderId = folderBySite.get(site.siteId) || null;
        if (assignedFolderId !== targetFolderId) {
          return false;
        }

        if (!normalizedQuery) {
          return true;
        }

        const url = String(site.url || '').toLowerCase();
        const title = String(site.title || '').toLowerCase();
        if (url.includes(normalizedQuery) || title.includes(normalizedQuery)) {
          return true;
        }

        const siteNotes = notesBySite.get(site.siteId) || [];
        return siteNotes.some((note) => String(note.markdown || '').toLowerCase().includes(normalizedQuery));
      })
      .map((site) => {
        const siteNotes = notesBySite.get(site.siteId) || [];
        return {
          siteId: site.siteId,
          url: site.url,
          title: site.title || site.url,
          folderId: folderBySite.get(site.siteId) || null,
          updatedAt: site.updatedAt,
          noteCount: siteNotes.length,
          markerCount: markersBySiteCount.get(site.siteId) || 0,
        };
      })
      .slice(0, safeLimit);
  }

  function deriveNoteTitle(markdown) {
    const text = String(markdown || '')
      .replace(/^#+\s*/gm, '')
      .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
      .replace(/[>*_`~\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) return 'Untitled Note';
    return text.length > 48 ? `${text.slice(0, 47)}…` : text;
  }

  async function listLibraryNotes({ folderId = null, query = '', limit = 500 } = {}) {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 500;
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const targetFolderId = folderId || null;

    const [notes, siteLinks, sites] = await Promise.all([
      db.notes.orderBy('updatedAt').reverse().toArray(),
      db.siteFolders.toArray(),
      db.sites.toArray(),
    ]);

    const folderBySite = siteLinks.reduce((map, link) => {
      map.set(link.siteId, link.folderId || null);
      return map;
    }, new Map());

    const siteById = sites.reduce((map, site) => {
      if (!site?.siteId) return map;
      map.set(site.siteId, site);
      return map;
    }, new Map());

    return notes
      .filter((note) => {
        const assignedFolderId = folderBySite.get(note.siteId) || null;
        if (assignedFolderId !== targetFolderId) {
          return false;
        }

        if (!normalizedQuery) {
          return true;
        }

        const markdown = String(note.markdown || '').toLowerCase();
        if (markdown.includes(normalizedQuery)) {
          return true;
        }

        const site = siteById.get(note.siteId);
        const siteUrl = String(site?.url || '').toLowerCase();
        const siteTitle = String(site?.title || '').toLowerCase();
        return siteUrl.includes(normalizedQuery) || siteTitle.includes(normalizedQuery);
      })
      .map((note) => {
        const site = siteById.get(note.siteId);
        return {
          noteId: note.noteId,
          siteId: note.siteId,
          folderId: folderBySite.get(note.siteId) || null,
          title: deriveNoteTitle(note.markdown),
          markdown: note.markdown || '',
          updatedAt: note.updatedAt,
          siteTitle: String(site?.title || site?.url || note.siteId || ''),
          siteUrl: String(site?.url || ''),
        };
      })
      .slice(0, safeLimit);
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

  async function listNotes({ limit = 200 } = {}) {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 200;
    return db.notes.orderBy('updatedAt').reverse().limit(safeLimit).toArray();
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
    listNotes,
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
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
    listFolders,
    moveSiteToFolder,
    createSiteFolderFromSite,
    listLibrarySites,
    listLibraryNotes,
  };
})(globalThis);

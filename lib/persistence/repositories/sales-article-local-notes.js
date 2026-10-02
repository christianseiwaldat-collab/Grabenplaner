'use strict';

const { assertPersistenceAccess } = require('../contract');
const { normalizeSalesArticleNumber } = require('../../sales-article-catalog');
const { loadManagedDataImportProtection } = require('../../data-import-managed-protection');
const { annotations } = require('./trade-annotations');
const N = require('../../sales-article-local-notes');

// App-owned shared business records, separate from source snapshots and UI preferences.
// Existing SQLite/PostgreSQL annotation storage provides encryption and atomic revisions.
function createSalesArticleLocalNotesRepository({ access, vault, scopeId = 'grabenplaner-main', clock = () => new Date().toISOString() }) {
  assertPersistenceAccess(access);
  const notesScope = scopeId + ':article-own-notes', kind = 'article-own-notes';
  const empty = articleNumber => ({ version: 1, articleNumber, items: [] });
  async function protectedWork(create, work) {
    let protection;
    try {
      protection = await loadManagedDataImportProtection({ access, vault, create });
      return await work(protection);
    } catch (error) {
      if (error?.code === 'IMPORT_CONCURRENT_CHANGE') throw new N.SalesArticleLocalNotesError('Die Notizen wurden zwischenzeitlich ergänzt. Bitte neu laden.', 'ARTICLE_NOTES_CONFLICT', 409);
      if (['IMPORT_PROTECTED_PAYLOAD_INVALID', 'IMPORT_PROTECTION_KEY_INVALID'].includes(error?.code)) {
        throw new N.SalesArticleLocalNotesError('Die gespeicherten Artikelnotizen konnten nicht geprüft werden.', 'ARTICLE_NOTES_INTEGRITY', 503);
      }
      if (error?.code === 'IMPORT_VAULT_UNAVAILABLE') throw new N.SalesArticleLocalNotesError('Die geschützte Notizablage ist derzeit nicht verfügbar.', 'ARTICLE_NOTES_UNAVAILABLE', 503);
      throw error;
    } finally { protection?.destroy(); }
  }
  return Object.freeze({
    async list(number) {
      const articleNumber = normalizeSalesArticleNumber(number);
      return protectedWork(false, async protection => {
        if (!protection) return N.view(articleNumber, 0, empty(articleNumber));
        return access.transaction(async tx => {
          const stored = await annotations({ protection, scopeId: notesScope }).read(tx, kind, articleNumber);
          const document = stored.value ? N.validateDocument(stored.value, articleNumber) : empty(articleNumber);
          return N.view(articleNumber, stored.revision, document);
        }, { isolation: 'serializable', readOnly: true });
      });
    },
    async add(value, { assertFresh = async () => {} } = {}) {
      const note = N.input(value);
      return protectedWork(true, async protection => {
        // Resolve current grants after loading the key and before opening the write transaction.
        // The callback stays outside the provider transaction so SQLite session reads do not
        // accidentally become legacy access within an application transaction.
        await assertFresh();
        return access.transaction(async tx => {
          const store = annotations({ protection, scopeId: notesScope }), stored = await store.read(tx, kind, note.articleNumber);
          const document = stored.value ? N.validateDocument(stored.value, note.articleNumber) : empty(note.articleNumber);
          const replay = document.items.find(item => item.id === note.mutationId);
          if (replay && replay.text === note.text && replay.author === note.actor) return N.view(note.articleNumber, stored.revision, document);
          if (replay || stored.revision !== note.expectedRevision) throw new N.SalesArticleLocalNotesError('Die Notizen wurden zwischenzeitlich ergänzt. Bitte neu laden.', 'ARTICLE_NOTES_CONFLICT', 409);
          const item = { id: note.mutationId, text: note.text, createdAt: clock(), author: note.actor };
          const updated = { ...document, items: [...document.items, item] };
          if (updated.items.length > N.MAX_NOTES || Buffer.byteLength(JSON.stringify(updated)) > N.MAX_DOCUMENT_BYTES) {
            throw new N.SalesArticleLocalNotesError('Die Notizablage dieses Artikels ist voll. Bitte die Verwaltung verständigen.', 'ARTICLE_NOTES_LIMIT', 413);
          }
          N.validateDocument(updated, note.articleNumber);
          const saved = await store.write(tx, kind, note.articleNumber, updated, stored.revision, note.actor);
          return N.view(note.articleNumber, saved.revision, updated);
        }, { isolation: 'serializable' });
      });
    },
  });
}
module.exports = { createSalesArticleLocalNotesRepository };

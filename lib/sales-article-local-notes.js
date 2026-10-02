'use strict';

const { normalizeSalesArticleNumber, normalizeSalesArticleActor } = require('./sales-article-catalog');
const MAX_TEXT_LENGTH = 4000;
const MAX_NOTES = 200;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

class SalesArticleLocalNotesError extends Error {
  constructor(message, code = 'ARTICLE_NOTES_INPUT', status = 400) {
    super(message); this.name = 'SalesArticleLocalNotesError'; this.code = code; this.status = status;
  }
}
const fail = (message, code, status) => { throw new SalesArticleLocalNotesError(message, code, status); };
function exact(value, fields) {
  if (!value || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !fields.includes(key))) fail('Die Notizangaben sind ungültig.');
}
function text(value) {
  if (typeof value !== 'string') fail('Bitte einen Text für die Notiz eingeben.');
  const result = value.replace(/\r\n?/g, '\n').trim();
  // Notes are plain text; newlines and tabs are intentional. No HTML is executed.
  if (!result || result.length > MAX_TEXT_LENGTH || Buffer.byteLength(result, 'utf8') > MAX_TEXT_LENGTH * 3
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) {
    fail(`Bitte eine Notiz mit höchstens ${MAX_TEXT_LENGTH} Zeichen eingeben.`);
  }
  return result;
}
function input(value) {
  exact(value, ['articleNumber', 'text', 'expectedRevision', 'mutationId', 'actor']);
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0
    || value.expectedRevision >= Number.MAX_SAFE_INTEGER) fail('Bitte die Notizen neu laden.', 'ARTICLE_NOTES_REVISION');
  if (typeof value.mutationId !== 'string' || !UUID.test(value.mutationId)) fail('Die Notizkennung ist ungültig.');
  return { articleNumber: normalizeSalesArticleNumber(value.articleNumber), text: text(value.text),
    expectedRevision: value.expectedRevision, mutationId: value.mutationId, actor: normalizeSalesArticleActor(value.actor) };
}
function validateDocument(value, articleNumber) {
  try {
    exact(value, ['version', 'articleNumber', 'items']);
    if (value.version !== 1 || value.articleNumber !== articleNumber || !Array.isArray(value.items)
      || value.items.length > MAX_NOTES || Buffer.byteLength(JSON.stringify(value)) > MAX_DOCUMENT_BYTES) throw new Error();
    const ids = new Set();
    for (const note of value.items) {
      exact(note, ['id', 'text', 'createdAt', 'author']);
      if (!UUID.test(note.id) || ids.has(note.id) || text(note.text) !== note.text
        || normalizeSalesArticleActor(note.author) !== note.author
        || typeof note.createdAt !== 'string' || new Date(note.createdAt).toISOString() !== note.createdAt) throw new Error();
      ids.add(note.id);
    }
    return value;
  } catch { fail('Die gespeicherten Artikelnotizen konnten nicht geprüft werden.', 'ARTICLE_NOTES_INTEGRITY', 503); }
}
function view(articleNumber, revision, document) {
  return { articleNumber, revision, items: [...document.items].reverse().map(note => ({ ...note })),
    maxTextLength: MAX_TEXT_LENGTH, maxNotes: MAX_NOTES };
}
module.exports = { SalesArticleLocalNotesError, MAX_TEXT_LENGTH, MAX_NOTES, MAX_DOCUMENT_BYTES,
  exact, text, input, validateDocument, view };

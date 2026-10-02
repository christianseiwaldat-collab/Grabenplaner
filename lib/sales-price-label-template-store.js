'use strict';

const crypto = require('node:crypto');
const C = require('./data-import-contract');
const Pdf = require('./sales-price-labels-pdf');
const Export = require('../public/trade-export-options');
const { branchSalesContext, BRANCH_ARTICLES_PERMISSION } = require('./branch-sales-access');
const { assertPersistenceAccess } = require('./persistence/contract');
const { loadManagedDataImportProtection } = require('./data-import-managed-protection');
const { annotations } = require('./persistence/repositories/trade-annotations');
const CONTEXTS = new WeakSet(), UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_TEMPLATES = 1000, MAX_OWNER_TEMPLATES = 50, MAX_RECIPIENTS = 50, MAX_BYTES = 1024 * 1024;
class SalesPriceLabelTemplateError extends Error {
  constructor(message, code = 'PRICE_LABEL_LIBRARY_INPUT', status = 400) { super(message); this.name = 'SalesPriceLabelTemplateError'; this.code = code; this.status = status; }
}
const fail = (message, code, status) => { throw new SalesPriceLabelTemplateError(message, code, status); };
const denied = () => fail('Diese Vorlage ist für dieses Konto nicht freigegeben.', 'PRICE_LABEL_LIBRARY_FORBIDDEN', 403);
const text = (value, max = 120) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('Die Vorlagenangaben sind ungültig.');
  return value.trim();
};
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
function sessionDerivedOwner(session) {
  if (!session || session.mustChangePassword) denied();
  if (session.sessionKind === 'organization' || session.isEmployee === false) {
    const branch = branchSalesContext(session, BRANCH_ARTICLES_PERMISSION);
    return { id: 'account:' + text(String(branch.accountId)), type: 'account', accountId: String(branch.accountId),
      label: text(String(session.fullName || session.loginName || branch.accountId), 160), branchId: branch.locationId };
  }
  const employeeNumber = text(session.employeeNumber, 80);
  return { id: 'employee:' + employeeNumber, type: 'employee', employeeNumber,
    label: text(String(session.fullName || session.nickname || employeeNumber), 160), branchId: null,
    localSystem: session.localSystem === true || session.sessionKind === 'local' };
}
function branchAccounts(rows) {
  if (!Array.isArray(rows)) fail('Die Filialkonten konnten nicht geprüft werden.', 'PRICE_LABEL_LIBRARY_UNAVAILABLE', 503);
  const result = [], seen = new Set();
  for (const row of rows) {
    if (!row || ![true, 1].includes(row.active) || (row.accountType || row.account_type) !== 'branch'
      || row.locationActive === false || row.locationActive === 0 || row.mustChangePassword || row.must_change_password) continue;
    const scopes = parse(row.scopes ?? row.scopes_json ?? row.access_scopes);
    if (!Array.isArray(scopes) || scopes.length !== 1 || !scopes[0]?.locationId || scopes[0].departmentId) continue;
    let id, locationId, label, locationLabel;
    try { id = text(String(row.id)); locationId = text(String(scopes[0].locationId));
      label = text(String(row.label || row.display_name || row.displayName || row.login_name || row.loginName || id), 160);
      locationLabel = text(String(row.locationLabel || row.locationName || row.branchName || locationId), 160); } catch { continue; }
    if (seen.has(id)) fail('Die Filialkonten sind nicht eindeutig.', 'PRICE_LABEL_LIBRARY_UNAVAILABLE', 503);
    seen.add(id); result.push({ id, label, locationId, locationLabel });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
async function resolveTemplateSessionContext(session, { listBranchAccounts, getEmployeeHomeLocation } = {}) {
  const owner = sessionDerivedOwner(session);
  if (typeof listBranchAccounts !== 'function') fail('Die Vorlagenbibliothek ist noch nicht verfügbar.', 'PRICE_LABEL_LIBRARY_UNAVAILABLE', 503);
  const accounts = branchAccounts(await listBranchAccounts());
  let ownBranch = null;
  if (owner.type === 'account') {
    const current = accounts.find(row => row.id === owner.accountId && row.locationId === owner.branchId);
    if (!current) denied();
    ownBranch = { id: current.locationId, label: current.locationLabel };
  } else {
    const home = getEmployeeHomeLocation ? await getEmployeeHomeLocation(owner.employeeNumber)
      : session.homeLocationId ? { id: String(session.homeLocationId), active: true } : null;
    if (home && home.active !== false && home.active !== 0 && home.id) {
      const id = text(String(home.id)), account = accounts.find(row => row.locationId === id);
      ownBranch = { id, label: text(String(home.label || home.name || account?.locationLabel || id), 160) };
    }
  }
  const context = C.freeze({ owner, ownBranch, accounts }); CONTEXTS.add(context); return context;
}
function trusted(context) { if (!CONTEXTS.has(context)) denied(); return context; }
const boundRecipient = (template, context) => template.recipients.some(recipient => recipient.accountId === context.owner.accountId
  && recipient.branchId === context.ownBranch?.id && context.accounts.some(account => account.id === recipient.accountId && account.locationId === recipient.branchId));
function canEdit(template, context) {
  return template.ownerId === context.owner.id || template.visibility === 'branch' && context.owner.type === 'account' && template.branchId === context.ownBranch?.id;
}
function canRead(template, context) {
  return template.ownerId === context.owner.id || template.visibility === 'branch' && template.branchId === context.ownBranch?.id
    || template.visibility === 'selected' && context.owner.type === 'account' && boundRecipient(template, context);
}
function visible(template, context) {
  const edit = canEdit(template, context), recipients = template.recipients.filter(recipient => context.accounts.some(account => account.id === recipient.accountId && account.locationId === recipient.branchId));
  return { id: template.id, version: template.version, title: template.title, options: JSON.parse(template.optionsJson),
    filenameOptions: JSON.parse(template.filenameOptionsJson), visibility: template.visibility,
    recipients: edit ? recipients.map(row => row.accountId) : [], unavailableRecipientCount: edit ? template.recipients.length - recipients.length : 0,
    creator: { id: template.ownerId, label: template.ownerLabel }, branchId: template.branchId,
    createdAt: template.createdAt, updatedAt: template.updatedAt, canEdit: edit, received: template.ownerId !== context.owner.id };
}
function selection(input, context, update = false) {
  C.exact(input, ['title', 'options', 'filenameOptions', 'visibility', 'recipients', ...(update ? ['version'] : [])]);
  const title = text(input.title, 80), options = Pdf.normalizeOptions(input.options), filenameOptions = Export.options(input.filenameOptions);
  if (!['private', 'branch', 'selected'].includes(input.visibility) || !Array.isArray(input.recipients)
    || input.recipients.length > MAX_RECIPIENTS || new Set(input.recipients).size !== input.recipients.length) fail('Bitte die Sichtbarkeit und Filialkonten prüfen.');
  if (input.visibility === 'branch' && !context.ownBranch) fail('Für dieses Konto ist keine aktive Stammfiliale zugeordnet.');
  if (input.visibility !== 'selected' && input.recipients.length || input.visibility === 'selected' && !input.recipients.length) fail('Bitte konkrete andere Filialkonten auswählen.');
  const recipients = input.recipients.map(id => {
    text(id); const account = context.accounts.find(row => row.id === id);
    if (!account || account.locationId === context.ownBranch?.id) fail('Eine gewählte Freigabe ist nicht mehr verfügbar. Bitte die Filialkonten neu laden.', 'PRICE_LABEL_LIBRARY_RECIPIENT');
    return { accountId: account.id, branchId: account.locationId };
  }).sort((a, b) => a.accountId.localeCompare(b.accountId));
  if (update && (!Number.isSafeInteger(input.version) || input.version < 1 || input.version >= Number.MAX_SAFE_INTEGER)) fail('Bitte die Vorlage neu laden.', 'PRICE_LABEL_LIBRARY_VERSION');
  return { title, optionsJson: JSON.stringify(options), filenameOptionsJson: JSON.stringify(filenameOptions), visibility: input.visibility,
    recipients, ...(update ? { version: input.version } : {}) };
}
function validateDocument(document) {
  try {
    C.exact(document, ['schemaVersion', 'templates', 'defaults']);
    if (document.schemaVersion !== 1 || !Array.isArray(document.templates) || document.templates.length > MAX_TEMPLATES
      || Buffer.byteLength(JSON.stringify(document)) > MAX_BYTES) throw new Error();
    const ids = new Set();
    if (document.defaults !== undefined) {
      if (!Array.isArray(document.defaults) || document.defaults.length > MAX_TEMPLATES) throw new Error();
      const owners = new Set();
      for (const saved of document.defaults) {
        C.exact(saved, ['ownerId', 'optionsJson', 'filenameOptionsJson']); text(saved.ownerId);
        if (!/^(?:account|employee):.+/.test(saved.ownerId) || owners.has(saved.ownerId) || typeof saved.optionsJson !== 'string' || saved.optionsJson.length > 20000
          || typeof saved.filenameOptionsJson !== 'string' || saved.filenameOptionsJson.length > 500) throw new Error();
        owners.add(saved.ownerId); Pdf.normalizeOptions(JSON.parse(saved.optionsJson)); Export.options(JSON.parse(saved.filenameOptionsJson));
      }
    }
    for (const template of document.templates) {
      C.exact(template, ['id', 'version', 'title', 'optionsJson', 'filenameOptionsJson', 'visibility', 'recipients', 'ownerId', 'ownerLabel', 'branchId', 'createdAt', 'updatedAt']);
      if (!UUID.test(template.id) || ids.has(template.id) || !Number.isSafeInteger(template.version) || template.version < 1) throw new Error();
      ids.add(template.id); text(template.title, 80); text(template.ownerId); text(template.ownerLabel, 160); C.utc(template.createdAt); C.utc(template.updatedAt);
      if (!/^(?:employee|account):.+/.test(template.ownerId) || !['private', 'branch', 'selected'].includes(template.visibility)
        || template.branchId !== null && text(template.branchId) !== template.branchId || template.visibility === 'branch' && !template.branchId) throw new Error();
      if (typeof template.optionsJson !== 'string' || template.optionsJson.length > 20000 || typeof template.filenameOptionsJson !== 'string' || template.filenameOptionsJson.length > 500) throw new Error();
      Pdf.normalizeOptions(JSON.parse(template.optionsJson)); Export.options(JSON.parse(template.filenameOptionsJson));
      if (!Array.isArray(template.recipients) || template.recipients.length > MAX_RECIPIENTS || new Set(template.recipients.map(row => row.accountId)).size !== template.recipients.length
        || template.visibility !== 'selected' && template.recipients.length || template.visibility === 'selected' && !template.recipients.length) throw new Error();
      for (const recipient of template.recipients) { C.exact(recipient, ['accountId', 'branchId']); text(recipient.accountId); text(recipient.branchId); }
    }
    return document;
  } catch { fail('Die gespeicherten Vorlagen konnten nicht sicher geprüft werden.', 'PRICE_LABEL_LIBRARY_INTEGRITY', 503); }
}
function createSalesPriceLabelTemplateStore({ access, vault, scopeId = 'grabenplaner-main', clock = () => new Date().toISOString() }) {
  assertPersistenceAccess(access);
  const scope = scopeId + ':price-label-library', kind = 'price-label-library', key = 'named-templates';
  async function work(write, context, operation, assertFresh = async () => {}) {
    trusted(context); let protection, initialAnnotationWrite = false;
    try {
      protection = await loadManagedDataImportProtection({ access, vault, create: write });
      await assertFresh();
      if (!protection) return operation({ schemaVersion: 1, templates: [] });
      return await access.transaction(async tx => {
        const store = annotations({ protection, scopeId: scope }), stored = await store.read(tx, kind, key);
        initialAnnotationWrite = write && stored.revision === 0;
        const document = stored.value ? validateDocument(stored.value) : { schemaVersion: 1, templates: [] };
        const result = operation(document);
        if (write) {
          validateDocument(document);
          await store.write(tx, kind, key, document, stored.revision, context.owner.id);
        }
        return result;
      }, { isolation: 'serializable', ...(write ? {} : { readOnly: true }) });
    } catch (error) {
      if (['IMPORT_CONCURRENT_CHANGE', 'PERSISTENCE_RETRYABLE_TRANSACTION', 'PERSISTENCE_BUSY'].includes(error.code)
        || initialAnnotationWrite && error.code === 'PERSISTENCE_UNIQUE_VIOLATION') fail('Die Vorlagen wurden zwischenzeitlich geändert. Bitte neu laden.', 'PRICE_LABEL_LIBRARY_CONFLICT', 409);
      if (['IMPORT_PROTECTED_PAYLOAD_INVALID', 'IMPORT_PROTECTION_KEY_INVALID'].includes(error.code)) fail('Die gespeicherten Vorlagen konnten nicht sicher geprüft werden.', 'PRICE_LABEL_LIBRARY_INTEGRITY', 503);
      if (error.code === 'IMPORT_VAULT_UNAVAILABLE') fail('Die geschützte Vorlagenablage ist derzeit nicht verfügbar.', 'PRICE_LABEL_LIBRARY_UNAVAILABLE', 503);
      throw error;
    } finally { protection?.destroy(); }
  }
  const find = (document, id, context) => { if (typeof id !== 'string' || !UUID.test(id)) fail('Die Vorlagenkennung ist ungültig.');
    const template = document.templates.find(row => row.id === id); if (!template || !canRead(template, context)) fail('Diese Vorlage ist nicht verfügbar.', 'PRICE_LABEL_LIBRARY_NOT_FOUND', 404); return template; };
  return Object.freeze({
    list(context) { return work(false, context, document => ({ templates: document.templates.filter(row => canRead(row, context)).map(row => visible(row, context))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)), ownBranch: context.ownBranch,
      recipients: context.accounts.filter(row => row.locationId !== context.ownBranch?.id), capabilities: { create: true, ownBranch: Boolean(context.ownBranch) } })); },
    get(context, id) { return work(false, context, document => visible(find(document, id, context), context)); },
    async create(context, input, { assertFresh } = {}) {
      trusted(context); const chosen = selection(input, context);
      return work(true, context, document => {
        if (document.templates.length >= MAX_TEMPLATES || document.templates.filter(row => row.ownerId === context.owner.id).length >= MAX_OWNER_TEMPLATES) fail('Die Vorlagenablage ist voll.', 'PRICE_LABEL_LIBRARY_LIMIT', 413);
        const timestamp = C.utc(clock()), template = { ...chosen, id: crypto.randomUUID(), version: 1, ownerId: context.owner.id,
          ownerLabel: context.owner.label, branchId: context.ownBranch?.id || null, createdAt: timestamp, updatedAt: timestamp };
        document.templates.push(template);
        if (Buffer.byteLength(JSON.stringify(document)) > MAX_BYTES) fail('Die Vorlagenablage ist voll.', 'PRICE_LABEL_LIBRARY_LIMIT', 413);
        return visible(template, context);
      }, assertFresh);
    },
    async update(context, id, input, { assertFresh } = {}) {
      trusted(context); const chosen = selection(input, context, true);
      return work(true, context, document => {
        const template = find(document, id, context); if (!canEdit(template, context)) denied();
        if (template.version !== chosen.version) fail('Diese Vorlage wurde zwischenzeitlich geändert. Bitte neu laden.', 'PRICE_LABEL_LIBRARY_CONFLICT', 409);
        const owner = template.ownerId === context.owner.id;
        if (!owner && chosen.visibility !== 'branch') denied();
        Object.assign(template, chosen, { version: template.version + 1, updatedAt: C.utc(clock()),
          branchId: owner ? context.ownBranch?.id || null : template.branchId });
        return visible(template, context);
      }, assertFresh);
    },
    getDefault(context) {
      trusted(context); if (context.owner.type !== 'account' && !context.owner.localSystem) denied();
      return work(false, context, document => {
        const saved = document.defaults?.find(row => row.ownerId === context.owner.id);
        return saved ? { options: JSON.parse(saved.optionsJson), filenameOptions: JSON.parse(saved.filenameOptionsJson) }
          : { options: Pdf.normalizeOptions({}), filenameOptions: { ...Export.defaults } };
      });
    },
    async setDefault(context, input, { assertFresh } = {}) {
      trusted(context); if (context.owner.type !== 'account' && !context.owner.localSystem) denied(); C.exact(input, ['options', 'filenameOptions']);
      const value = { options: Pdf.normalizeOptions(input.options), filenameOptions: Export.options(input.filenameOptions) };
      return work(true, context, document => {
        document.defaults ||= [];
        let saved = document.defaults.find(row => row.ownerId === context.owner.id);
        if (!saved) {
          if (document.defaults.length >= MAX_TEMPLATES) fail('Die Vorlagenablage ist voll.', 'PRICE_LABEL_LIBRARY_LIMIT', 413);
          document.defaults.push(saved = { ownerId: context.owner.id });
        }
        Object.assign(saved, { optionsJson: JSON.stringify(value.options), filenameOptionsJson: JSON.stringify(value.filenameOptions) });
        if (Buffer.byteLength(JSON.stringify(document)) > MAX_BYTES) fail('Die Vorlagenablage ist voll.', 'PRICE_LABEL_LIBRARY_LIMIT', 413);
        return value;
      }, assertFresh);
    },
  });
}
module.exports = { createSalesPriceLabelTemplateStore, resolveTemplateSessionContext, sessionDerivedOwner,
  SalesPriceLabelTemplateError, MAX_TEMPLATES, MAX_OWNER_TEMPLATES, MAX_RECIPIENTS };

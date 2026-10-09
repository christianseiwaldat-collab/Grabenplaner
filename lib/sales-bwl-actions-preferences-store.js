'use strict';

const C = require('./data-import-contract');
const Actions = require('./sales-bwl-actions-model');
const Model = {authority(session) {const auth = Actions.authority(session); return {...auth, projection: auth.caps};}, normalizePreferences: Actions.normalizePreferences};
const {assertPersistenceAccess} = require('./persistence/contract');
const {loadManagedDataImportProtection} = require('./data-import-managed-protection');
const {annotations} = require('./persistence/repositories/trade-annotations');
const {A} = require('./persistence/statements/trade-annotations');
const {CRM_CUSTOMER_STATEMENTS: Audit} = require('./persistence/statements/crm-customers');

const KIND = 'sales-bwl-actions-preferences';
const CONCURRENT_ERRORS = new Set(['IMPORT_CONCURRENT_CHANGE', 'PERSISTENCE_RETRYABLE_TRANSACTION',
  'PERSISTENCE_BUSY', 'PERSISTENCE_UNIQUE_VIOLATION']);
const INTEGRITY_ERRORS = new Set(['IMPORT_PROTECTED_PAYLOAD_INVALID', 'IMPORT_PROTECTION_KEY_INVALID',
  'IMPORT_VAULT_UNAVAILABLE', 'IMPORT_PROTECTION_UNAVAILABLE']);
const fail = (code, status) => C.fail(code, status);
const changed = () => fail('BWL_ACTIONS_PREFERENCES_CHANGED', 409);
const integrity = () => fail('BWL_ACTIONS_PREFERENCES_INTEGRITY', 503);

function createSalesBwlActionsPreferencesStore({access, vault, scopeId = 'grabenplaner-main'}) {
  assertPersistenceAccess(access);
  const scope = C.id(scopeId) + ':personal-bwl-actions-preferences';

  async function current(getSession, tx, expected) {
    if (typeof getSession !== 'function') fail('BWL_ACTIONS_FORBIDDEN', 403);
    const authority = Model.authority(await getSession(tx));
    // Copy the fingerprint before another await can observe a mutable session.
    const context = {projection: authority.projection, identity: C.canonical(authority.identity),
      ownerId: authority.ownerId, accountId: authority.accountId};
    if (expected && (context.identity !== expected.identity || context.ownerId !== expected.ownerId
      || context.accountId !== expected.accountId)) fail('BWL_ACTIONS_FORBIDDEN', 403);
    return context;
  }

  function preferencesFrom(prior, context) {
    if (!prior.revision && prior.value === null) return Model.normalizePreferences({}, context.projection);
    try {
      C.integer(prior.revision, 1, Number.MAX_SAFE_INTEGER);
      C.exact(prior.value, ['schemaVersion', 'ownerId', 'accountId', 'preferences']);
      if (Object.keys(prior.value).length !== 4 || prior.value.schemaVersion !== 1
        || prior.value.ownerId !== context.ownerId || prior.value.accountId !== context.accountId) integrity();
      C.exact(prior.value.preferences, ['columns', 'columnWidths', 'sort', 'direction']);
      if (Object.keys(prior.value.preferences).length !== 4) integrity();
      // Valid historical protected columns are removed after a grant withdrawal.
      return Model.normalizePreferences(prior.value.preferences, context.projection, {reduce: true});
    } catch { integrity(); }
  }

  async function work(getSession, input, write = false) {
    if (write) {
      try {input = JSON.parse(C.canonical(input));}
      catch {fail('BWL_ACTIONS_PREFERENCES_INVALID', 422);}
    }
    const context = await current(getSession);
    let preferences, version, protection;
    if (write) {
      try {
        C.exact(input, ['version', 'preferences']);
        if (Object.keys(input).length !== 2 || !C.plain(input.preferences)) throw new Error();
        C.integer(input.version, 0, Number.MAX_SAFE_INTEGER - 1);
      } catch { fail('BWL_ACTIONS_PREFERENCES_INVALID', 422); }
      version = input.version;
      preferences = JSON.parse(C.canonical(Model.normalizePreferences(input.preferences, context.projection)));
    }
    try {
      protection = await loadManagedDataImportProtection({access, vault, create: write});
      await current(getSession, undefined, context);
      return await access.transaction(async tx => {
        await current(getSession, tx, context);
        // An unambiguous tuple separates employee owners and legacy/new accounts.
        const key = C.canonical([context.ownerId, context.accountId]);
        const prior = protection
          ? await annotations({protection, scopeId: scope}).read(tx, KIND, key)
          : {revision: 0, value: null};
        const previous = preferencesFrom(prior, context);
        if (!write) {
          await current(getSession, tx, context);
          return {version: prior.revision, preferences: previous};
        }
        // A stale snapshot conflicts even if the requested values are identical.
        if (prior.revision !== version) changed();
        await current(getSession, tx, context);
        const row = {id: protection.digest(['trade-annotation-id', scope, KIND, key]),
          scopeId: scope, kind: KIND, revision: version + 1};
        const payload = protection.seal({schemaVersion: 1, ownerId: context.ownerId,
          accountId: context.accountId, preferences},
        ['trade-annotation-v1', row.scopeId, row.kind, row.id, row.revision]);
        const result = await tx.execute(version ? A.update : A.insert, {...row, payload,
          ...(version ? {expectedRevision: version} : {})});
        if (result.rowsAffected !== 1) changed();
        const audit = await tx.execute(Audit.insertAudit, {actor: context.ownerId,
          action: 'trade.' + KIND + '.update', entityType: 'trade_annotation', entityId: row.id,
          detail: JSON.stringify({revision: row.revision}), timestamp: new Date().toISOString()});
        if (audit.rowsAffected !== 1) integrity();
        await current(getSession, tx, context);
        return {version: row.revision, preferences};
      }, {isolation: 'serializable', readOnly: !write});
    } catch (error) {
      if (CONCURRENT_ERRORS.has(error.code)) changed();
      if (INTEGRITY_ERRORS.has(error.code)) integrity();
      throw error;
    } finally { protection?.destroy(); }
  }

  return Object.freeze({
    read(getSession) { return work(getSession); },
    write(getSession, input) { return work(getSession, input, true); },
  });
}

module.exports = {createSalesBwlActionsPreferencesStore};

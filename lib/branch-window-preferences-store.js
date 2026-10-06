'use strict';
const C = require('./data-import-contract');
const Model = require('./gp-window-preferences');
const {assertPersistenceAccess} = require('./persistence/contract');
const {loadManagedDataImportProtection} = require('./data-import-managed-protection');
const {annotations} = require('./persistence/repositories/trade-annotations');
const contexts = new WeakSet();
const fail = (code, status = 422) => C.fail(code, status);

// Geometry never grants access to employee preferences or to another account.
function branchWindowContext(session) {
  if (!session || session.sessionKind !== 'organization' || session.accountType !== 'branch'
    || session.isEmployee !== false || !session.accountId) fail('BRANCH_WINDOWS_FORBIDDEN', 403);
  if (session.mustChangePassword) fail('PORTAL_PASSWORD_CHANGE_REQUIRED', 428);
  const scopes = session.scopes;
  if (!Array.isArray(scopes) || scopes.length !== 1 || !scopes[0]?.locationId || scopes[0].departmentId) {
    fail('BRANCH_WINDOWS_FORBIDDEN', 403);
  }
  const context = Object.freeze({accountId:C.id(session.accountId), locationId:C.id(String(scopes[0].locationId)),
    identity:C.canonical([C.text(session.id), session.accountId, scopes, session.permissions || [], false])});
  contexts.add(context);
  return context;
}
function assertContext(context) {if (!contexts.has(context)) fail('BRANCH_WINDOWS_FORBIDDEN', 403);}
function validate(value) {
  try {return Model.validate(value);} catch {fail('BRANCH_WINDOWS_INVALID');}
}
function createBranchWindowPreferencesStore({access, vault, scopeId = 'grabenplaner-main'}) {
  assertPersistenceAccess(access);
  const scope = scopeId + ':branch-window-preferences', kind = 'branch-window-preferences';
  async function work(context, write, operation, assertFresh = async () => {}) {
    assertContext(context);
    let protection;
    try {
      protection = await loadManagedDataImportProtection({access, vault, create:write});
      await assertFresh();
      if (!protection) return {revision:0, gpWindows:Model.empty()};
      return await access.transaction(async tx => {
        await assertFresh(tx);
        const store = annotations({protection, scopeId:scope});
        const prior = await store.read(tx, kind, context.accountId);
        let gpWindows = Model.empty();
        if (prior.value) {
          try {
            C.exact(prior.value, ['schemaVersion','accountId','gpWindows']);
            if (prior.value.schemaVersion !== 1 || prior.value.accountId !== context.accountId) throw new Error();
            gpWindows = Model.validate(prior.value.gpWindows);
          } catch {fail('BRANCH_WINDOWS_INTEGRITY', 503);}
        }
        return operation({store, tx, prior, gpWindows});
      }, {isolation:'serializable', readOnly:!write});
    } catch (error) {
      if (['IMPORT_CONCURRENT_CHANGE','PERSISTENCE_RETRYABLE_TRANSACTION','PERSISTENCE_BUSY','PERSISTENCE_UNIQUE_VIOLATION'].includes(error.code)) {
        fail('BRANCH_WINDOWS_CONFLICT', 409);
      }
      if (['IMPORT_PROTECTED_PAYLOAD_INVALID','IMPORT_PROTECTION_KEY_INVALID','IMPORT_VAULT_UNAVAILABLE'].includes(error.code)) {
        fail('BRANCH_WINDOWS_INTEGRITY', 503);
      }
      throw error;
    } finally {protection?.destroy();}
  }
  return {
    get(context, {assertFresh} = {}) {
      return work(context, false, ({prior, gpWindows}) => ({revision:prior.revision, gpWindows}), assertFresh);
    },
    save(context, input, {assertFresh} = {}) {
      assertContext(context); C.exact(input, ['revision','gpWindows']);
      C.integer(input.revision, 0, Number.MAX_SAFE_INTEGER - 1);
      const gpWindows = validate(input.gpWindows);
      return work(context, true, async ({store, tx, prior, gpWindows:previous}) => {
        // A lost acknowledgement can safely retry the identical snapshot.
        if (prior.value && C.equal(previous, gpWindows)) return {revision:prior.revision, gpWindows:previous};
        if (prior.revision !== input.revision) fail('BRANCH_WINDOWS_CONFLICT', 409);
        const saved = await store.write(tx, kind, context.accountId,
          {schemaVersion:1, accountId:context.accountId, gpWindows}, prior.revision, 'organization:' + context.accountId);
        return {revision:saved.revision, gpWindows};
      }, assertFresh);
    },
  };
}
module.exports = {branchWindowContext, createBranchWindowPreferencesStore};

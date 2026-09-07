"use strict";
const crypto = require('node:crypto');
const C = require('./data-import-contract');
const { createDataImportProtection } = require('./data-import-protection');
const { DATA_IMPORT_RUNTIME_STATEMENTS: S } = require('./persistence/statements/data-import-runtime');
const KEY_ID = 'data-import-v1';
const CONTEXT = Object.freeze({ namespace: 'data-import', connectorId: KEY_ID, field: 'data-and-index-keys', purpose: 'source-archive-and-recovery' });
// The existing application vault wraps independent, stable import keys. No
// host key, environment setting or credential file is created or changed.
async function loadManagedDataImportProtection({ access, vault, create = false, clock = () => new Date().toISOString() }) {
  if (!vault || typeof vault.seal !== 'function' || typeof vault.useSecret !== 'function') C.fail('IMPORT_VAULT_UNAVAILABLE', 503);
  const record = await access.transaction(async tx => {
    let row = await tx.queryOne(S.key, { id: KEY_ID });
    if (!row && create) {
      const bytes = crypto.randomBytes(64);
      try {
        await tx.execute(S.insertKey, { id: KEY_ID, payload: vault.seal(bytes, CONTEXT), createdAt: C.utc(clock()) });
      } finally { bytes.fill(0); }
      row = await tx.queryOne(S.key, { id: KEY_ID });
    }
    return row;
  }, { isolation: 'serializable' });
  if (!record) return null;
  let protection;
  try {
    await vault.useSecret(record.payload, CONTEXT, bytes => {
      if (bytes.length !== 64) C.fail('IMPORT_PROTECTION_KEY_INVALID');
      protection = createDataImportProtection({ encryptionKey: bytes.subarray(0,32), indexKey: bytes.subarray(32), keyId: KEY_ID, compression: true });
    });
    return protection;
  } catch {
    protection?.destroy();
    C.fail('IMPORT_VAULT_UNAVAILABLE', 503);
  }
}
module.exports = { loadManagedDataImportProtection };

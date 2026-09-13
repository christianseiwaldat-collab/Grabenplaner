"use strict";

const fs = require('node:fs');
const path = require('node:path');

async function verifyProtection(client, { sourceRoot, workRoot }) {
  await require('./history').verifyInput(sourceRoot);
  require('../operations/paired-bundle').safeRoot(workRoot);
  if (fs.readdirSync(workRoot).length) throw new Error('PG_TRANSFER_PROTECTION_WORKSPACE');
  const environment = require('node:util').parseEnv(fs.readFileSync(sourceRoot + '/configuration.env', 'utf8'));
  const amu = require('../../../amu-storage');
  const id = environment.GRABENPLANER_AMU_KEY_ID;
  const options = { encryptionKeys: { [id]: environment.GRABENPLANER_AMU_KEY }, activeKeyId: id };
  const files = amu.validateEncryptionKeyForStorage({ ...options, sourceDirectory: sourceRoot + '/private/amu' });
  const storage = amu.createAmuStorage({ ...options, rootDirectory: workRoot + '/key-check' });
  await client.query('BEGIN READ ONLY');
  try {
    await client.query('SET LOCAL search_path=pg_catalog,gp');
    const references = await require('../application-operations/protected-storage').protectedStorageReferencesFromDatabase({
      prepare: sql => ({ all: async () => (await client.query(sql)).rows, get: async () => (await client.query(sql)).rows[0] }),
    });
    for (const key of references) {
      if (!/^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.amu$/.test(key)) throw new Error('PG_TRANSFER_PROTECTED_REFERENCE');
      const file = path.join(sourceRoot, 'private/amu/blobs', key);
      if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw new Error('PG_TRANSFER_PROTECTED_FILE');
    }
    const protectedRecords = await require('../operations/paired-restore').protectedRecords(client, storage);
    const vaultId = environment.GRABENPLANER_INTEGRATION_KEY_ID;
    const keys = environment.GRABENPLANER_INTEGRATION_KEYS ? JSON.parse(environment.GRABENPLANER_INTEGRATION_KEYS) : {};
    if (environment.GRABENPLANER_INTEGRATION_KEY) keys[vaultId] = environment.GRABENPLANER_INTEGRATION_KEY;
    const vault = require('../../../integration-secret-vault').createIntegrationSecretVault({ activeKeyId: vaultId, keys });
    let integrationCredentials = 0;
    for (const row of (await client.query("SELECT id,kind,protected_credentials FROM gp.integration_connections WHERE protected_credentials<>'' ORDER BY id")).rows) {
      await vault.useSecret(row.protected_credentials, { namespace: 'integration-connection', connectorId: String(row.id),
        field: 'credentials', purpose: String(row.kind || 'integration') }, async bytes => {
        const value = JSON.parse(bytes.toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PG_TRANSFER_INTEGRATION_KEY');
      });
      integrationCredentials++;
    }
    const archive = (await client.query("SELECT payload FROM gp.data_import_runtime_keys WHERE id='data-import-v1'")).rows;
    if (archive.length !== 1) throw new Error('PG_TRANSFER_ARCHIVE_KEY');
    await vault.useSecret(archive[0].payload, { namespace: 'data-import', connectorId: 'data-import-v1',
      field: 'data-and-index-keys', purpose: 'source-archive-and-recovery' }, async bytes => {
      if (bytes.length !== 64) throw new Error('PG_TRANSFER_ARCHIVE_KEY');
    });
    await client.query('COMMIT');
    return { verified: true, encryptedFiles: files.fileCount, fileReferences: references.length, protectedRecords,
      integrationCredentials, managedImportKey: true, checkedAt: new Date().toISOString() };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

module.exports = { verifyProtection };

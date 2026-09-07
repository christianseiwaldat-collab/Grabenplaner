"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIntegrationSecretVault } = require('../lib/integration-secret-vault');
test('synchronous backup consumers preserve vault context checks and always clear plaintext', async () => {
  const vault = createIntegrationSecretVault({ activeKeyId: 'fixture', keys: { fixture: Buffer.alloc(32, 1) } });
  const context = { namespace: 'local-backup', connectorId: 'fixture', field: 'repository', purpose: 'recovery' };
  const envelope = vault.seal('test-secret', context);
  let borrowed;
  assert.equal(vault.useSecretSync(envelope, context, bytes => { borrowed = bytes; assert.equal(bytes.toString(), 'test-secret'); }), undefined);
  assert.ok(borrowed.every(b => b === 0));
  assert.throws(() => vault.useSecretSync(envelope, { ...context, connectorId: 'foreign' }, () => {}), { code: 'INTEGRATION_SECRET_INTEGRITY_FAILED' });
  assert.throws(() => vault.useSecretSync(envelope, context, bytes => { borrowed = bytes; throw new Error('consumer'); }), /consumer/);
  assert.ok(borrowed.every(b => b === 0));
  assert.throws(() => vault.useSecretSync(envelope, context, async bytes => { borrowed = bytes; }), { code: 'INTEGRATION_SECRET_SYNC_CONSUMER_REQUIRED' });
  assert.ok(borrowed.every(b => b === 0));
  await vault.useSecret(envelope, context, async bytes => { await Promise.resolve(); assert.equal(bytes.toString(), 'test-secret'); });
});

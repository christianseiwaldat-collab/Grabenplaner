"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { canonical, LIMITS } = require('../lib/data-import-contract');
const { createDataImportProtection } = require('../lib/data-import-protection');
const keys = { encryptionKey: Buffer.alloc(32, 1), indexKey: Buffer.alloc(32, 2), keyId: 'test-compression' };
test('compressed import data and blocks retain exact values, existing keys and both format readers', () => {
  const old = createDataImportProtection(keys), next = createDataImportProtection({ ...keys, compression: true });
  const value = { amount: '0.0000001', identifier: '0000419', nullable: null, memo: 'ä\n\u0001'.repeat(2000) }, context = ['test', 'bound-row'];
  try {
    for (const [seal, open, prefix] of [['seal', 'open', 'gp-import-v2:'], ['sealBlock', 'openBlock', 'gp-import-block-v2:']]) {
      const packed = next[seal](value, context), legacy = old[seal](value, context);
      assert.ok(packed.startsWith(prefix)); assert.ok(packed.length < legacy.length / 3);
      assert.deepEqual(next[open](legacy, context), value);
      assert.deepEqual(old[open](packed, context), value); // dual reader, legacy write mode
      assert.notEqual(next[seal](value, context), packed); // independent AEAD nonce
      assert.throws(() => next[open](packed, ['wrong-context']));
      assert.throws(() => next[open](packed.replace('v2:', 'v1:'), context));
    }
    assert.equal(next.digest(value), old.digest(value));
    assert.ok(next.seal({ small: 1 }, context).startsWith('gp-import-v1:'));
  } finally { old.destroy(); next.destroy(); }
});
test('authenticated decompression is bounded before JSON parsing', () => {
  const protection = createDataImportProtection({ ...keys, compression: true }), context = ['synthetic-bomb'];
  try {
    const bytes = Buffer.alloc(LIMITS.rowBytes * 6 + 1, 32), packed = zlib.deflateRawSync(bytes);
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', keys.encryptionKey, iv);
    cipher.setAAD(Buffer.from(canonical(['gp-import-payload', 2, keys.keyId, context])));
    const ciphertext = Buffer.concat([cipher.update(packed), cipher.final()]);
    const envelope = ['gp-import-v2', keys.keyId, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
    assert.throws(() => protection.open(envelope, context), e => e.code === 'IMPORT_PROTECTED_PAYLOAD_INVALID');
  } finally { protection.destroy(); }
});

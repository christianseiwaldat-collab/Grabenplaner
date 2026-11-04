'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { createPersistenceProviderFacade } = require('../lib/persistence/contract');
const { POSTGRESQL_CAPABILITIES: capabilities } = require('../lib/persistence/postgresql/provider');
const { createPasskeysRepository, LIMITS } = require('../lib/persistence/repositories/passkeys');
const { S } = require('../lib/persistence/statements/passkeys');
const now = '2026-10-25T12:00:00.000Z', expiresAt = '2026-10-25T12:05:00.000Z', hash = 'a'.repeat(64);
const subjectId = crypto.randomUUID(), credentialId = crypto.randomUUID();
const subject = { id: subjectId, principalKind: 'employee', principalId: '434', userHandle: crypto.randomBytes(32), authRevision: 1, createdAt: now, updatedAt: now };
const credential = { id: credentialId, subjectId, authRevision: 1, credentialId: crypto.randomBytes(32).toString('base64url'), publicKey: crypto.randomBytes(40),
  counter: 0, authorityHash: hash, deviceType: 'multiDevice', backedUp: true, transports: ['internal'], label: 'Synthetic key', revision: 1, createdAt: now, lastUsedAt: null, revokedAt: null };
function fixture() {
  const calls = []; let next = null;
  const provider = createPersistenceProviderFacade({ providerId: 'postgresql', capabilities,
    query: async (statement, parameters) => { calls.push({ statement, parameters }); return next ? [next] : []; },
    execute: async (statement, parameters) => { calls.push({ statement, parameters }); return { rowsAffected: next ? 1 : 0, returnedRows: next ? [next] : [] }; },
    beginTransaction: async () => { throw new Error('No transaction expected in scalar DTO tests'); },
    close: async () => {},
  });
  return { repo: createPasskeysRepository(provider), calls, reply(value) { next = value; } };
}
const registration = () => ({ subjectId, expectedAuthRevision: 1, credentialId: credential.credentialId, publicKey: credential.publicKey,
  counter: 0, authorityHash: hash, deviceType: 'multiDevice', backedUp: true, transports: ['internal'], label: 'Synthetic key', now });
const challenge = () => ({ subjectId, expectedAuthRevision: 1, purpose: 'register', challenge: crypto.randomBytes(32).toString('base64url'), bindingHash: hash,
  sessionHash: hash, authorityHash: hash, rpId: 'gp.example.test', origin: 'https://gp.example.test', payload: { action: 'register', managed: false }, createdAt: now, expiresAt });

test('old-schema availability is explicit; typed subjects receive opaque handles without exposing personal identifiers', async () => {
  const f = fixture(); f.reply({ available: false }); assert.equal(await f.repo.available(), false);
  f.reply(subject);
  const result = await f.repo.ensureSubject({ kind: 'employee', id: '434', now });
  const input = f.calls.at(-1).parameters;
  assert.equal(input.kind, 'employee'); assert.equal(input.employeeNumber, '434'); assert.equal(input.accountId, null);
  assert.equal(input.userHandle.length, 32); assert.notEqual(input.userHandle.toString(), '434');
  assert.equal(result.userHandle, subject.userHandle.toString('base64url'));
  assert.equal((await f.repo.subjectById(subjectId)).id, subjectId);
  assert.equal((await f.repo.subjectForHandle(result.userHandle)).principalId, '434');
  await f.repo.ensureSubject({ kind: 'organization', id: '434', now });
  assert.equal(f.calls.at(-1).parameters.employeeNumber, null); assert.equal(f.calls.at(-1).parameters.accountId, '434');
});

test('credential DTOs carry base64url public material and every use/revocation is subject- and revision-bound', async () => {
  const f = fixture(); f.reply(credential);
  const created = await f.repo.registerCredential(registration());
  assert.equal(created.publicKey, credential.publicKey.toString('base64url'));
  assert.equal(f.calls.at(-1).statement, S.registerCredential);
  assert.equal(f.calls.at(-1).parameters.expectedAuthRevision, 1);
  await f.repo.updateCredentialUse({ id: credentialId, subjectId, expectedAuthRevision: 1, expectedRevision: 1, expectedCounter: 0,
    expectedAuthorityHash: hash, newCounter: 1, backedUp: true, now });
  assert.equal(f.calls.at(-1).statement, S.updateCredentialUse);
  assert.equal(f.calls.at(-1).parameters.expectedAuthorityHash, hash);
  f.reply(null);
  assert.equal(await f.repo.revokeCredential({ id: credentialId, subjectId, expectedRevision: 9, now }), null);
  assert.equal(f.calls.at(-1).parameters.subjectId, subjectId);
  assert.equal(await f.repo.updateCredentialUse({ id: credentialId, subjectId, expectedAuthRevision: 2, expectedRevision: 1, expectedCounter: 0,
    expectedAuthorityHash: hash, newCounter: 1, backedUp: true, now }), null);
});

test('registration rejects oversized or noncanonical key material, invalid counters and unverified transport/backup states before SQL', async () => {
  const f = fixture();
  for (const changes of [{ credentialId: 'bad=' }, { publicKey: 'a' }, { publicKey: Buffer.alloc(4097) }, { counter: -1 }, { counter: 4294967296 },
    { expectedAuthRevision: 0 }, { deviceType: 'unknown' }, { deviceType: 'singleDevice', backedUp: true }, { transports: ['unknown'] },
    { transports: ['usb', 'usb'] }, { authorityHash: 'public-personnel-number' }, { label: 'x'.repeat(101) }]) {
    await assert.rejects(f.repo.registerCredential({ ...registration(), ...changes }), e => e.code === 'PASSKEY_INPUT_INVALID');
  }
  assert.equal(f.calls.length, 0);
});

test('challenge enrollment binds account, session, authority, operation, RP and origin while anonymous authentication remains possible', async () => {
  const f = fixture(); f.reply(null);
  const input = challenge(); assert.equal(await f.repo.issueChallenge(input), null);
  assert.equal(f.calls.at(-1).statement, S.issueChallenge);
  assert.deepEqual(f.calls.at(-1).parameters.payload, input.payload);
  const auth = { ...challenge(), subjectId: null, expectedAuthRevision: null, purpose: 'authenticate', sessionHash: null, authorityHash: null };
  await f.repo.issueChallenge(auth); assert.equal(f.calls.at(-1).parameters.subjectId, null);
  await f.repo.consumeChallenge({ id: crypto.randomUUID(), purpose: 'authenticate', bindingHash: hash, now });
  assert.equal(f.calls.at(-1).statement, S.consumeChallenge);
  assert.deepEqual(Object.keys(f.calls.at(-1).parameters).sort(), ['bindingHash', 'id', 'now', 'purpose']);
});

test('challenge input bounds prevent unbound enrollment, unlimited TTL and attacker-shaped metadata before persistence', async () => {
  const f = fixture();
  const cyclic = {}; cyclic.self = cyclic;
  for (const changes of [{ subjectId: null, expectedAuthRevision: null }, { sessionHash: null }, { authorityHash: null },
    { expectedAuthRevision: null }, { purpose: 'delete' }, { challenge: 'abc' }, { bindingHash: '' },
    { expiresAt: now }, { expiresAt: '2026-10-25T12:05:00.001Z' }, { payload: [] }, { payload: { notes: 'x'.repeat(4096) } },
    { payload: cyclic }, { payload: { callback() {} } }, { payload: { value: undefined } }]) {
    await assert.rejects(f.repo.issueChallenge({ ...challenge(), ...changes }), e => e.code === 'PASSKEY_INPUT_INVALID');
  }
  assert.equal(f.calls.length, 0); assert.equal(LIMITS.credentials, 10); assert.equal(LIMITS.challenges, 100); assert.equal(LIMITS.challengeTtlMs, 300000);
});

test('principal revocation returns the new opaque epoch and affected credential count without deleting evidence', async () => {
  const f = fixture(); f.reply({ ...subject, authRevision: 2, revokedCredentials: 3 });
  const result = await f.repo.revokePrincipal({ kind: 'employee', id: '434', now });
  assert.equal(result.authRevision, 2); assert.equal(result.revokedCredentials, 3);
  assert.equal(f.calls.at(-1).statement, S.revokePrincipal);
  assert.deepEqual(Object.keys(f.calls.at(-1).parameters).sort(), ['kind', 'now', 'principalId']);
});

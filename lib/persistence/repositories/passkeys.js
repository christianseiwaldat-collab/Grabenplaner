'use strict';
const crypto = require('node:crypto');
const { assertPersistenceAccess } = require('../contract');
const { S } = require('../statements/passkeys');
const LIMITS = Object.freeze({ credentials: 10, challenges: 100, challengeTtlMs: 300000, payloadBytes: 4096 });
const invalid = () => { throw Object.assign(new TypeError('Invalid passkey persistence input'), { code: 'PASSKEY_INPUT_INVALID', status: 400 }); };
const uuid = value => { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) invalid(); return value; };
const sha = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); return value; };
const integer = (value, min = 1, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(value) || value < min || value > max) invalid(); return value; };
const bytes = (value, min, max) => { if (!(Buffer.isBuffer(value) || value instanceof Uint8Array) || value.byteLength < min || value.byteLength > max) invalid(); return Buffer.from(value); };
const stamp = value => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(); return value; };
const text = (value, max) => { if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid(); return value; };
const base64url = (value, min, max) => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) invalid(); const decoded = Buffer.from(value, 'base64url'); if (decoded.length < min || decoded.length > max || decoded.toString('base64url') !== value) invalid(); return value; };
const material = (value, min, max) => typeof value === 'string' ? Buffer.from(base64url(value, min, max), 'base64url') : bytes(value, min, max);
const subjectView = row => row ? { ...row, userHandle: Buffer.from(row.userHandle).toString('base64url') } : null;
const credentialView = row => row ? { ...row, publicKey: Buffer.from(row.publicKey).toString('base64url') } : null;
function principal(input) {
  if (!input || !['employee', 'organization'].includes(input.kind)) invalid();
  return { kind: input.kind, principalId: text(input.id ?? input.principalId, 160) };
}
function purpose(value) { if (!['register', 'authenticate', 'reauthenticate'].includes(value)) invalid(); return value; }
function payload(value) {
  const visit = (item, depth = 0) => {
    if (depth > 12) invalid();
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid();
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, visit(item[key], depth + 1)]));
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result = visit(value);
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.payloadBytes) invalid();
  return result;
}
const one = result => result.returnedRows[0] || null;
function createPasskeysRepository(access) {
  assertPersistenceAccess(access);
  const methods = {
    async available() { return (await access.queryOne(S.available, {}))?.available === true; },
    subjectForPrincipal(input) { return access.queryOne(S.subjectForPrincipal, principal(input)).then(subjectView); },
    subjectForHandle(userHandle) { return access.queryOne(S.subjectForHandle, { userHandle: material(userHandle, 32, 32) }).then(subjectView); },
    subjectById(id) { return access.queryOne(S.subjectById, { id: uuid(id) }).then(subjectView); },
    async ensureSubject(input) {
      const p = principal(input), handle = input.userHandle === undefined ? crypto.randomBytes(32) : material(input.userHandle, 32, 32);
      const result = await access.execute(S.ensureSubject, { id: input.subjectId ? uuid(input.subjectId) : crypto.randomUUID(), kind: p.kind,
        employeeNumber: p.kind === 'employee' ? p.principalId : null, accountId: p.kind === 'organization' ? p.principalId : null,
        userHandle: handle, now: stamp(input.now) });
      return subjectView(one(result) || await access.queryOne(S.subjectForPrincipal, p));
    },
    listCredentials(input) {
      const limit = integer(input.limit ?? 100, 1, 100), includeRevoked = input.includeRevoked ?? false;
      if (typeof includeRevoked !== 'boolean') invalid();
      return access.queryAll(S.listCredentials, { subjectId: uuid(input.subjectId), includeRevoked, limit }).then(rows => rows.map(credentialView));
    },
    credential(credentialId) { return access.queryOne(S.credential, { credentialId: base64url(credentialId, 1, 1024) }).then(credentialView); },
    credentialById(input) { return access.queryOne(S.credentialById, { id: uuid(input.id), subjectId: uuid(input.subjectId) }).then(credentialView); },
    async registerCredential(input) {
      if (!['singleDevice', 'multiDevice'].includes(input.deviceType) || typeof input.backedUp !== 'boolean'
        || input.backedUp && input.deviceType !== 'multiDevice') invalid();
      const transports = input.transports ?? [];
      if (!Array.isArray(transports) || transports.length > 8 || transports.some(value => !['usb', 'nfc', 'ble', 'internal', 'hybrid', 'cable', 'smart-card'].includes(value)) || new Set(transports).size !== transports.length) invalid();
      return credentialView(one(await access.execute(S.registerCredential, { id: input.id ? uuid(input.id) : crypto.randomUUID(), subjectId: uuid(input.subjectId),
        expectedAuthRevision: integer(input.expectedAuthRevision), credentialId: base64url(input.credentialId, 1, 1024), publicKey: material(input.publicKey, 1, 4096),
        counter: integer(input.counter, 0, 4294967295), authorityHash: sha(input.authorityHash), deviceType: input.deviceType, backedUp: input.backedUp,
        transports, label: text(input.label, 100), now: stamp(input.now) })));
    },
    async updateCredentialUse(input) {
      if (typeof input.backedUp !== 'boolean') invalid();
      return credentialView(one(await access.execute(S.updateCredentialUse, { id: uuid(input.id), subjectId: uuid(input.subjectId), expectedAuthRevision: integer(input.expectedAuthRevision),
        expectedRevision: integer(input.expectedRevision), expectedCounter: integer(input.expectedCounter, 0, 4294967295),
        expectedAuthorityHash: sha(input.expectedAuthorityHash), newCounter: integer(input.newCounter, 0, 4294967295), backedUp: input.backedUp, now: stamp(input.now) })));
    },
    async revokeCredential(input) { return credentialView(one(await access.execute(S.revokeCredential, { id: uuid(input.id), subjectId: uuid(input.subjectId), expectedRevision: integer(input.expectedRevision), now: stamp(input.now) }))); },
    async revokePrincipal(input) { return subjectView(one(await access.execute(S.revokePrincipal, { ...principal(input), now: stamp(input.now) }))); },
    async issueChallenge(input) {
      const kind = purpose(input.purpose), subjectId = input.subjectId == null ? null : uuid(input.subjectId);
      const expectedAuthRevision = input.expectedAuthRevision == null ? null : integer(input.expectedAuthRevision);
      const sessionHash = input.sessionHash == null ? null : sha(input.sessionHash), authorityHash = input.authorityHash == null ? null : sha(input.authorityHash);
      if ((subjectId === null) !== (expectedAuthRevision === null) || kind !== 'authenticate' && (!subjectId || !sessionHash || !authorityHash)) invalid();
      const createdAt = stamp(input.createdAt), expiresAt = stamp(input.expiresAt), ttl = Date.parse(expiresAt) - Date.parse(createdAt);
      if (ttl <= 0 || ttl > LIMITS.challengeTtlMs) invalid();
      return one(await access.execute(S.issueChallenge, { id: input.id ? uuid(input.id) : crypto.randomUUID(), subjectId, expectedAuthRevision, purpose: kind,
        challenge: base64url(input.challenge, 32, 32), bindingHash: sha(input.bindingHash), sessionHash, authorityHash,
        rpId: text(input.rpId, 253), origin: text(input.origin, 512), payload: payload(input.payload ?? {}), createdAt, expiresAt }));
    },
    async consumeChallenge(input) { return one(await access.execute(S.consumeChallenge, { id: uuid(input.id), purpose: purpose(input.purpose), bindingHash: sha(input.bindingHash), now: stamp(input.now) })); },
    purgeChallenges(input) { return access.execute(S.purgeChallenges, { now: stamp(input.now), limit: integer(input.limit ?? 200, 1, 500) }).then(result => result.rowsAffected); },
  };
  return Object.freeze({ ...methods, ...(typeof access.transaction === 'function' ? {
    transaction(work) { return access.transaction(tx => work(createPasskeysRepository(tx)), { isolation: 'serializable' }); },
  } : {}) });
}
module.exports = { createPasskeysRepository, LIMITS };

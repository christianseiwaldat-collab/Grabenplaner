'use strict';
const { definePersistenceStatement } = require('../contract');
const nullable = kind => ({ kind, nullable: true });
const SUBJECT = Object.freeze({ id: 'text', principalKind: 'text', principalId: 'text', userHandle: 'bytes',
  authRevision: 'safe_integer', createdAt: 'utc_timestamp', updatedAt: 'utc_timestamp' });
const CREDENTIAL = Object.freeze({ id: 'text', subjectId: 'text', authRevision: 'safe_integer', credentialId: 'text', publicKey: 'bytes', counter: 'safe_integer',
  authorityHash: 'text', deviceType: 'text', backedUp: 'boolean', transports: 'json', label: 'text', revision: 'safe_integer',
  createdAt: 'utc_timestamp', lastUsedAt: nullable('utc_timestamp'), revokedAt: nullable('utc_timestamp') });
const CHALLENGE = Object.freeze({ id: 'text', subjectId: nullable('text'), purpose: 'text', challenge: 'text', bindingHash: 'text',
  sessionHash: nullable('text'), authorityHash: nullable('text'), expectedAuthRevision: nullable('safe_integer'), rpId: 'text', origin: 'text', payload: 'json',
  createdAt: 'utc_timestamp', expiresAt: 'utc_timestamp', consumedAt: nullable('utc_timestamp') });
const def = (name, operation, parameters, columns = {}) => definePersistenceStatement({ id: 'passkeys.' + name, operation, parameters, columns });
const S = Object.freeze({
  available: def('available', 'queryOne', {}, { available: 'boolean' }),
  subjectForPrincipal: def('subject.principal', 'queryOne', { kind: 'text', principalId: 'text' }, SUBJECT),
  subjectForHandle: def('subject.handle', 'queryOne', { userHandle: 'bytes' }, SUBJECT),
  subjectById: def('subject.id', 'queryOne', { id: 'text' }, SUBJECT),
  ensureSubject: def('subject.ensure', 'execute', { id: 'text', kind: 'text', employeeNumber: nullable('text'), accountId: nullable('text'), userHandle: 'bytes', now: 'utc_timestamp' }, SUBJECT),
  listCredentials: def('credential.list', 'queryAll', { subjectId: 'text', includeRevoked: 'boolean', limit: 'safe_integer' }, CREDENTIAL),
  credential: def('credential.lookup', 'queryOne', { credentialId: 'text' }, CREDENTIAL),
  credentialById: def('credential.id', 'queryOne', { id: 'text', subjectId: 'text' }, CREDENTIAL),
  registerCredential: def('credential.register', 'execute', { id: 'text', subjectId: 'text', expectedAuthRevision: 'safe_integer', credentialId: 'text',
    publicKey: 'bytes', counter: 'safe_integer', authorityHash: 'text', deviceType: 'text', backedUp: 'boolean', transports: 'json', label: 'text', now: 'utc_timestamp' }, CREDENTIAL),
  updateCredentialUse: def('credential.use', 'execute', { id: 'text', subjectId: 'text', expectedAuthRevision: 'safe_integer', expectedRevision: 'safe_integer',
    expectedCounter: 'safe_integer', expectedAuthorityHash: 'text', newCounter: 'safe_integer', backedUp: 'boolean', now: 'utc_timestamp' }, CREDENTIAL),
  revokeCredential: def('credential.revoke', 'execute', { id: 'text', subjectId: 'text', expectedRevision: 'safe_integer', now: 'utc_timestamp' }, CREDENTIAL),
  revokePrincipal: def('subject.revoke', 'execute', { kind: 'text', principalId: 'text', now: 'utc_timestamp' }, { ...SUBJECT, revokedCredentials: 'safe_integer' }),
  issueChallenge: def('challenge.issue', 'execute', { ...Object.fromEntries(Object.entries(CHALLENGE).filter(([key]) => key !== 'consumedAt')) }, CHALLENGE),
  consumeChallenge: def('challenge.consume', 'execute', { id: 'text', purpose: 'text', bindingHash: 'text', now: 'utc_timestamp' }, CHALLENGE),
  purgeChallenges: def('challenge.purge', 'execute', { now: 'utc_timestamp', limit: 'safe_integer' }),
});
module.exports = { S, SUBJECT, CREDENTIAL, CHALLENGE };

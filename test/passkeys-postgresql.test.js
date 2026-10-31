'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const enabled = Boolean(process.env.GP_CORE_MIGRATOR_URL && process.env.GP_CORE_APP_URL);

test('native PostgreSQL passkeys: additive rollback, typed accounts, one-use races, credential CAS, revocation and database bounds', {
  skip: !enabled, timeout: 120000,
}, async () => {
  const { Client, Pool } = require('pg');
  const migration = require('../lib/persistence/postgresql/core/passkeys');
  const { assertPasskeysCatalog } = require('../lib/persistence/postgresql/core/passkeys-catalog');
  const { createPostgresqlPersistenceProvider } = require('../lib/persistence/postgresql/provider');
  const { createPasskeysRepository } = require('../lib/persistence/repositories/passkeys');
  for (const name of ['GP_CORE_MIGRATOR_URL', 'GP_CORE_APP_URL']) {
    const url = new URL(process.env[name]); assert(['127.0.0.1', 'localhost'].includes(url.hostname)); assert.equal(url.pathname, '/gp_migration_core');
  }
  const schema = 'passkeys_native_' + crypto.randomBytes(8).toString('hex'); assert.match(schema, /^passkeys_native_[a-f0-9]{16}$/);
  const translated = sql => sql.replace(/\bgp\./g, schema + '.');
  const owner = new Client({ connectionString: process.env.GP_CORE_MIGRATOR_URL });
  let owns = false, provider;
  const now = '2026-10-25T12:00:00.000Z', expiresAt = '2026-10-25T12:05:00.000Z', hash = 'a'.repeat(64);
  const bind = value => crypto.createHash('sha256').update(value).digest('hex');
  try {
    await owner.connect(); await require('../lib/persistence/postgresql/core/environment').verifyEnvironment(owner, { purpose: 'migrator' });
    await owner.query('BEGIN; SET LOCAL ROLE gp_core_owner');
    await owner.query('CREATE SCHEMA ' + schema); owns = true;
    await owner.query(`CREATE TABLE ${schema}.portal_users(employee_number TEXT PRIMARY KEY,password_hash TEXT NOT NULL);
      CREATE TABLE ${schema}.portal_organization_accounts(id TEXT PRIMARY KEY,password_hash TEXT NOT NULL);
      INSERT INTO ${schema}.portal_users VALUES('same-id','unchanged-personal-hash');
      INSERT INTO ${schema}.portal_organization_accounts VALUES('same-id','unchanged-organization-hash')`);
    await owner.query('SAVEPOINT before_passkeys');
    for (const sql of migration.statements.slice(0, 8)) await owner.query(translated(sql));
    await assert.rejects(owner.query('SELECT 1/0'), error => error.code === '22012');
    await owner.query('ROLLBACK TO SAVEPOINT before_passkeys');
    assert.equal((await owner.query(`SELECT to_regclass('${schema}.passkey_subjects') name`)).rows[0].name, null);
    for (const sql of migration.statements) await owner.query(translated(sql));
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO gp_core_app,gp_core_reader`);
    await owner.query('COMMIT');
    const pool = new Pool({ connectionString: process.env.GP_CORE_APP_URL, max: 4 });
    provider = createPostgresqlPersistenceProvider({ pool, poolOwnership: 'provider',
      prepareClient: client => require('../lib/persistence/postgresql/core/environment').verifyEnvironment(client, { purpose: 'app' }),
      catalog: assertPasskeysCatalog().map(entry => ({ ...entry, sql: translated(entry.sql) })) });
    const repo = createPasskeysRepository(provider);
    assert.equal(await repo.available(), true);
    const personal = await repo.ensureSubject({ kind: 'employee', id: 'same-id', now }), organization = await repo.ensureSubject({ kind: 'organization', id: 'same-id', now });
    assert.notEqual(personal.id, organization.id); assert.notEqual(personal.userHandle, organization.userHandle);
    assert.equal(Buffer.from(personal.userHandle, 'base64url').length, 32);
    assert.equal((await repo.ensureSubject({ kind: 'employee', id: 'same-id', now })).userHandle, personal.userHandle);
    await assert.rejects(repo.ensureSubject({ kind: 'employee', id: 'missing', now }));
    const registration = subject => ({ subjectId: subject.id, expectedAuthRevision: subject.authRevision, credentialId: crypto.randomBytes(32).toString('base64url'),
      publicKey: crypto.randomBytes(48).toString('base64url'), counter: 0, authorityHash: hash, deviceType: 'multiDevice', backedUp: true, transports: ['internal'], label: 'Synthetic passkey', now });
    const keyInput = registration(personal), key = await repo.registerCredential(keyInput);
    await assert.rejects(repo.registerCredential({ ...registration(organization), credentialId: keyInput.credentialId }), 'credential IDs are globally unique across account kinds');
    const use = (row, overrides = {}) => ({ id: row.id, subjectId: row.subjectId, expectedAuthRevision: row.authRevision, expectedRevision: row.revision,
      expectedCounter: row.counter, expectedAuthorityHash: hash, newCounter: row.counter, backedUp: true, now, ...overrides });
    const counterless = await Promise.all([repo.updateCredentialUse(use(key)), repo.updateCredentialUse(use(key))]);
    assert.equal(counterless.filter(Boolean).length, 1, 'even a counterless authenticator has exactly one revision winner');
    const fresh = counterless.find(Boolean), used = await repo.updateCredentialUse(use(fresh, { newCounter: 1 })); assert.equal(used.counter, 1);
    assert.equal(await repo.updateCredentialUse(use(used, { newCounter: 1 })), null, 'a nonzero counter cannot be reused');
    assert.equal(await repo.updateCredentialUse(use(used, { newCounter: 2, expectedAuthorityHash: 'b'.repeat(64) })), null);
    const issue = (overrides = {}) => repo.issueChallenge({ subjectId: personal.id, expectedAuthRevision: personal.authRevision, purpose: 'register', challenge: crypto.randomBytes(32).toString('base64url'),
      bindingHash: hash, sessionHash: hash, authorityHash: hash, rpId: 'gp.example.test', origin: 'https://gp.example.test', payload: { action: 'register' }, createdAt: now, expiresAt, ...overrides });
    const one = await issue(), consume = overrides => repo.consumeChallenge({ id: one.id, purpose: 'register', bindingHash: hash, now, ...overrides });
    assert.equal(await consume({ bindingHash: 'b'.repeat(64) }), null); assert.equal(await consume({ purpose: 'authenticate' }), null);
    const consumers = await Promise.all([consume(), consume()]); assert.equal(consumers.filter(Boolean).length, 1);
    const expired = await issue(); assert.equal(await repo.consumeChallenge({ id: expired.id, purpose: 'register', bindingHash: hash, now: expiresAt }), null);
    const pending = await issue();
    const revoked = await repo.revokePrincipal({ kind: 'employee', id: 'same-id', now });
    assert.equal(revoked.authRevision, 2); assert.equal(revoked.revokedCredentials, 1);
    assert.equal(await repo.consumeChallenge({ id: pending.id, purpose: 'register', bindingHash: hash, now }), null);
    assert.equal(await repo.updateCredentialUse(use(used, { newCounter: 2 })), null); assert.equal((await repo.listCredentials({ subjectId: personal.id })).length, 0);
    assert.equal((await repo.listCredentials({ subjectId: personal.id, includeRevoked: true })).length, 1);

    for (let i = 0; i < 9; i++) assert(await repo.registerCredential(registration(organization)));
    const cap = await Promise.allSettled([repo.registerCredential(registration(organization)), repo.registerCredential(registration(organization))]);
    assert.equal(cap.filter(item => item.status === 'fulfilled' && item.value).length, 1);
    assert.equal((await repo.listCredentials({ subjectId: organization.id })).length, 10, 'database enrollment guard enforces capacity under a real parallel last-slot race');
    const bindingHash = bind('synthetic-capacity-browser');
    for (let i = 0; i < 99; i++) assert(await issue({ subjectId: null, expectedAuthRevision: null, purpose: 'authenticate', sessionHash: null, authorityHash: null, bindingHash }));
    const challengeCap = await Promise.allSettled([issue({ subjectId: null, expectedAuthRevision: null, purpose: 'authenticate', sessionHash: null, authorityHash: null, bindingHash }),
      issue({ subjectId: null, expectedAuthRevision: null, purpose: 'authenticate', sessionHash: null, authorityHash: null, bindingHash })]);
    assert.equal(challengeCap.filter(item => item.status === 'fulfilled' && item.value).length, 1);
    assert.equal(Number((await owner.query(`SELECT count(*) n FROM ${schema}.passkey_challenges WHERE binding_hash=$1 AND consumed_at IS NULL`, [bindingHash])).rows[0].n), 100);
    const privileges = (await owner.query(`SELECT has_table_privilege('gp_core_reader',$1,'SELECT') reader,
      has_table_privilege('gp_core_app',$1,'DELETE') app_delete`, [schema + '.passkey_credentials'])).rows[0];
    assert.deepEqual(privileges, { reader: false, app_delete: false });
    await owner.query('BEGIN; SET LOCAL ROLE gp_core_owner');
    await owner.query(`DELETE FROM ${schema}.portal_users WHERE employee_number='same-id'`); await owner.query('COMMIT');
    assert.equal(await repo.subjectById(personal.id), null); assert.equal(await repo.credential(keyInput.credentialId), null);
    assert.equal((await repo.subjectById(organization.id)).principalKind, 'organization');
    assert.equal((await owner.query(`SELECT password_hash FROM ${schema}.portal_organization_accounts`)).rows[0].password_hash, 'unchanged-organization-hash');
  } finally {
    await provider?.close(); await owner.query('ROLLBACK').catch(() => {});
    if (owns) {
      const rows = (await owner.query('SELECT nspname,pg_get_userbyid(nspowner) owner FROM pg_namespace WHERE nspname=$1', [schema])).rows;
      if (rows.length) { assert.deepEqual(rows, [{ nspname: schema, owner: 'gp_core_owner' }]); await owner.query('SET ROLE gp_core_owner'); await owner.query('DROP SCHEMA ' + schema + ' CASCADE'); }
    }
    await owner.end();
  }
});

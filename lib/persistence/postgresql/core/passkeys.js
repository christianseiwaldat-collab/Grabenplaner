'use strict';
const { createHash } = require('node:crypto');
const { schemaFingerprint } = require('./fingerprint');
const HISTORY_TABLE = 'passkeys_migration_history', LOCK_KEY = 9261281;
const time = name => `${name} TEXT COLLATE "C" NOT NULL CHECK(${name} ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$')`;
const statements = Object.freeze([
  `CREATE TABLE gp.passkey_subjects(
    id TEXT COLLATE "C" PRIMARY KEY,
    principal_kind TEXT COLLATE "C" NOT NULL CHECK(principal_kind IN('employee','organization')),
    employee_number TEXT COLLATE "C" REFERENCES gp.portal_users(employee_number) ON UPDATE RESTRICT ON DELETE CASCADE,
    account_id TEXT COLLATE "C" REFERENCES gp.portal_organization_accounts(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    principal_id TEXT COLLATE "C" GENERATED ALWAYS AS (COALESCE(employee_number,account_id)) STORED,
    user_handle BYTEA NOT NULL UNIQUE CHECK(octet_length(user_handle)=32),
    auth_revision BIGINT NOT NULL DEFAULT 1 CHECK(auth_revision BETWEEN 1 AND 9007199254740991),
    ${time('created_at')},${time('updated_at')},
    CHECK((principal_kind='employee' AND employee_number IS NOT NULL AND account_id IS NULL)
      OR(principal_kind='organization' AND employee_number IS NULL AND account_id IS NOT NULL)),
    UNIQUE(principal_kind,principal_id))`,
  `CREATE TABLE gp.passkey_credentials(
    id TEXT COLLATE "C" PRIMARY KEY,
    subject_id TEXT COLLATE "C" NOT NULL REFERENCES gp.passkey_subjects(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    auth_revision BIGINT NOT NULL CHECK(auth_revision BETWEEN 1 AND 9007199254740991),
    credential_id TEXT COLLATE "C" NOT NULL UNIQUE CHECK(length(credential_id) BETWEEN 2 AND 1366 AND credential_id ~ '^[A-Za-z0-9_-]+$'),
    public_key BYTEA NOT NULL CHECK(octet_length(public_key) BETWEEN 1 AND 4096),
    counter BIGINT NOT NULL CHECK(counter BETWEEN 0 AND 4294967295),
    authority_hash TEXT COLLATE "C" NOT NULL CHECK(authority_hash ~ '^[a-f0-9]{64}$'),
    device_type TEXT COLLATE "C" NOT NULL CHECK(device_type IN('singleDevice','multiDevice')),
    backed_up BOOLEAN NOT NULL,transports JSONB NOT NULL CHECK(jsonb_typeof(transports)='array' AND jsonb_array_length(transports)<=8),
    label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 100),revision BIGINT NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
    ${time('created_at')},last_used_at TEXT COLLATE "C",revoked_at TEXT COLLATE "C",
    CHECK(NOT backed_up OR device_type='multiDevice'))`,
  'CREATE INDEX passkey_credentials_subject ON gp.passkey_credentials(subject_id,created_at,id)',
  `CREATE TABLE gp.passkey_challenges(
    id TEXT COLLATE "C" PRIMARY KEY,
    subject_id TEXT COLLATE "C" REFERENCES gp.passkey_subjects(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    purpose TEXT COLLATE "C" NOT NULL CHECK(purpose IN('register','authenticate','reauthenticate')),
    challenge TEXT COLLATE "C" NOT NULL UNIQUE CHECK(length(challenge)=43 AND challenge ~ '^[A-Za-z0-9_-]+$'),
    binding_hash TEXT COLLATE "C" NOT NULL CHECK(binding_hash ~ '^[a-f0-9]{64}$'),
    session_hash TEXT COLLATE "C" CHECK(session_hash ~ '^[a-f0-9]{64}$'),
    authority_hash TEXT COLLATE "C" CHECK(authority_hash ~ '^[a-f0-9]{64}$'),
    expected_auth_revision BIGINT CHECK(expected_auth_revision BETWEEN 1 AND 9007199254740991),
    rp_id TEXT COLLATE "C" NOT NULL CHECK(length(rp_id) BETWEEN 1 AND 253),
    origin TEXT COLLATE "C" NOT NULL CHECK(length(origin) BETWEEN 1 AND 512),
    payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=8192),
    ${time('created_at')},${time('expires_at')},consumed_at TEXT COLLATE "C",
    CHECK(expires_at>created_at AND expires_at::timestamptz<=created_at::timestamptz+interval '5 minutes'),
    CHECK((subject_id IS NULL)=(expected_auth_revision IS NULL)),
    CHECK(purpose='authenticate' OR(subject_id IS NOT NULL AND session_hash IS NOT NULL AND authority_hash IS NOT NULL)))`,
  'CREATE INDEX passkey_challenges_pending ON gp.passkey_challenges(binding_hash,expires_at) WHERE consumed_at IS NULL',
  'CREATE INDEX passkey_challenges_expiry ON gp.passkey_challenges(expires_at,id)',
  `CREATE FUNCTION gp.passkeys_guard_subject() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,gp AS $$ BEGIN
    IF ROW(NEW.id,NEW.principal_kind,NEW.employee_number,NEW.account_id,NEW.user_handle,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.principal_kind,OLD.employee_number,OLD.account_id,OLD.user_handle,OLD.created_at)
      OR NEW.auth_revision<>OLD.auth_revision+1 THEN RAISE EXCEPTION 'PASSKEY_SUBJECT_IMMUTABLE' USING ERRCODE='23514'; END IF;
    RETURN NEW; END $$`,
  `CREATE FUNCTION gp.passkeys_guard_credential() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,gp AS $$ BEGIN
    IF OLD.revoked_at IS NOT NULL OR ROW(NEW.id,NEW.subject_id,NEW.auth_revision,NEW.credential_id,NEW.public_key,NEW.authority_hash,NEW.device_type,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.subject_id,OLD.auth_revision,OLD.credential_id,OLD.public_key,OLD.authority_hash,OLD.device_type,OLD.created_at)
      OR NEW.revision<>OLD.revision+1 OR NEW.counter<OLD.counter THEN RAISE EXCEPTION 'PASSKEY_CREDENTIAL_IMMUTABLE' USING ERRCODE='23514'; END IF;
    RETURN NEW; END $$`,
  `CREATE FUNCTION gp.passkeys_guard_enrollment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,gp AS $$ DECLARE current_epoch BIGINT; BEGIN
    SELECT auth_revision INTO current_epoch FROM gp.passkey_subjects WHERE id=NEW.subject_id FOR UPDATE;
    IF current_epoch IS DISTINCT FROM NEW.auth_revision OR
      (SELECT count(*) FROM gp.passkey_credentials WHERE subject_id=NEW.subject_id AND auth_revision=current_epoch AND revoked_at IS NULL)>=10
      THEN RAISE EXCEPTION 'PASSKEY_ENROLLMENT_CHANGED_OR_FULL' USING ERRCODE='23514'; END IF;
    RETURN NEW; END $$`,
  `CREATE FUNCTION gp.passkeys_guard_challenge() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,gp AS $$ BEGIN
    IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL OR (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at')
      THEN RAISE EXCEPTION 'PASSKEY_CHALLENGE_IMMUTABLE' USING ERRCODE='23514'; END IF;
    RETURN NEW; END $$`,
  `CREATE FUNCTION gp.passkeys_guard_challenge_issue() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,gp AS $$ DECLARE current_epoch BIGINT; BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.binding_hash,9261282));
    IF (SELECT count(*) FROM gp.passkey_challenges WHERE binding_hash=NEW.binding_hash AND consumed_at IS NULL AND expires_at>NEW.created_at)>=100
      THEN RAISE EXCEPTION 'PASSKEY_CHALLENGE_LIMIT' USING ERRCODE='23514'; END IF;
    IF NEW.subject_id IS NOT NULL THEN
      SELECT auth_revision INTO current_epoch FROM gp.passkey_subjects WHERE id=NEW.subject_id FOR SHARE;
      IF current_epoch IS DISTINCT FROM NEW.expected_auth_revision THEN RAISE EXCEPTION 'PASSKEY_CHALLENGE_EPOCH' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW; END $$`,
  'CREATE TRIGGER passkeys_subject_immutable BEFORE UPDATE ON gp.passkey_subjects FOR EACH ROW EXECUTE FUNCTION gp.passkeys_guard_subject()',
  'CREATE TRIGGER passkeys_credential_immutable BEFORE UPDATE ON gp.passkey_credentials FOR EACH ROW EXECUTE FUNCTION gp.passkeys_guard_credential()',
  'CREATE TRIGGER passkeys_enrollment_bound BEFORE INSERT ON gp.passkey_credentials FOR EACH ROW EXECUTE FUNCTION gp.passkeys_guard_enrollment()',
  'CREATE TRIGGER passkeys_challenge_immutable BEFORE UPDATE ON gp.passkey_challenges FOR EACH ROW EXECUTE FUNCTION gp.passkeys_guard_challenge()',
  'CREATE TRIGGER passkeys_challenge_issue_bound BEFORE INSERT ON gp.passkey_challenges FOR EACH ROW EXECUTE FUNCTION gp.passkeys_guard_challenge_issue()',
  'REVOKE ALL ON FUNCTION gp.passkeys_guard_subject(),gp.passkeys_guard_credential(),gp.passkeys_guard_enrollment(),gp.passkeys_guard_challenge(),gp.passkeys_guard_challenge_issue() FROM PUBLIC,gp_core_app,gp_core_reader',
  'GRANT EXECUTE ON FUNCTION gp.passkeys_guard_subject(),gp.passkeys_guard_credential(),gp.passkeys_guard_enrollment(),gp.passkeys_guard_challenge(),gp.passkeys_guard_challenge_issue() TO gp_core_app',
  'REVOKE ALL ON gp.passkey_subjects,gp.passkey_credentials,gp.passkey_challenges FROM PUBLIC,gp_core_app,gp_core_reader',
  'GRANT SELECT,INSERT,UPDATE ON gp.passkey_subjects,gp.passkey_credentials TO gp_core_app',
  'GRANT SELECT,INSERT,UPDATE,DELETE ON gp.passkey_challenges TO gp_core_app',
  'CREATE TABLE gp.passkeys_migration_history(version INTEGER PRIMARY KEY CHECK(version=1),plan_sha256 TEXT NOT NULL,base_target_sha256 TEXT NOT NULL,target_sha256 TEXT NOT NULL)',
  'REVOKE ALL ON gp.passkeys_migration_history FROM PUBLIC,gp_core_app,gp_core_reader',
  'GRANT SELECT ON gp.passkeys_migration_history TO gp_core_app,gp_core_reader',
]);
const digest = createHash('sha256').update(JSON.stringify(statements)).digest('hex');
const hash = /^[a-f0-9]{64}$/;
async function readLedger(client) {
  if (!(await client.query("SELECT to_regclass('gp.passkeys_migration_history') name")).rows[0].name) return null;
  const rows = (await client.query('SELECT version,plan_sha256,base_target_sha256,target_sha256 FROM gp.passkeys_migration_history')).rows;
  if (rows.length !== 1 || rows[0].version !== 1 || rows[0].plan_sha256 !== digest
    || !hash.test(rows[0].base_target_sha256 || '') || !hash.test(rows[0].target_sha256 || '')) throw new Error('PG_PASSKEYS_MIGRATION_CONTRACT');
  return rows[0];
}
async function target(client, base, { required = false } = {}) {
  const ledger = await readLedger(client);
  if (!ledger) { if (required) throw new Error('PG_PASSKEYS_MIGRATION_REQUIRED'); return base; }
  if (ledger.base_target_sha256 !== base) throw new Error('PG_PASSKEYS_MIGRATION_CONTRACT');
  return ledger.target_sha256;
}
async function migrate(client, { binding } = {}) {
  require('./passkeys-catalog').assertPasskeysCatalog();
  await require('./environment').verifyEnvironment(client, { purpose: 'migrator', binding });
  await client.query(`SELECT pg_advisory_lock(${LOCK_KEY})`); let started = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL ROLE gp_core_owner; SET LOCAL search_path=pg_catalog,gp'); started = true;
    await require('../boundary/migrate').verifyCoreSchema(client, { requireVocationalSchool: true, requireSessionSecurity: true });
    if (await readLedger(client)) { await client.query('COMMIT'); started = false; return { applied: false, digest }; }
    const base = await schemaFingerprint(client);
    for (const sql of statements) await client.query(sql);
    const after = await schemaFingerprint(client);
    await client.query('INSERT INTO gp.passkeys_migration_history VALUES(1,$1,$2,$3)', [digest, base, after]);
    await client.query('COMMIT'); started = false;
    return { applied: true, digest, target: after, legacyDataChanged: false };
  } catch (error) { if (started) await client.query('ROLLBACK'); throw error; }
  finally { await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`); }
}
module.exports = { HISTORY_TABLE, LOCK_KEY, statements, digest, readLedger, target, migrate };

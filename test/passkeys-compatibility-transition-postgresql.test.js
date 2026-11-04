"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
if (process.env.GP_PASSKEYS_UPGRADE_FIXTURE !== undefined
  && process.env.GP_PASSKEYS_COMPATIBILITY_NATIVE !== "isolated-clone-v1") {
  throw Error("PASSKEY_COMPATIBILITY_NATIVE_PHASE_REQUIRED");
}
const fixture = require("../test-support/postgresql-migration/passkeys-compatibility-transition-fixture.cjs");
const original = require("../test-support/postgresql-migration/f0d-core-inspector.json");

test("explicit upgrade qualification rejects a missing or wrong native compatibility opt-in before any SQL", () => {
  const { spawnSync } = require("node:child_process");
  for (const phase of ["1", "required"]) for (const optIn of [undefined, "wrong"]) {
    const environment = { ...process.env, GP_PASSKEYS_UPGRADE_FIXTURE: phase };
    delete environment.GP_PASSKEYS_COMPATIBILITY_NATIVE;
    delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
    if (optIn !== undefined) environment.GP_PASSKEYS_COMPATIBILITY_NATIVE = optIn;
    const child = spawnSync(process.execPath, ["--no-global-search-paths", __filename], {
      env: environment, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
    });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 1);
    assert.match(child.stderr, /PASSKEY_COMPATIBILITY_NATIVE_PHASE_REQUIRED/);
    assert.doesNotMatch(child.stdout, /fresh-pre-passkeys-schema-ready|isolated-passkeys-transition-v1/);
  }
});

test("the original installed f0d schema inspector and every reused dependency are separately bound", () => {
  assert.equal(typeof fixture.originalInspector().verifyCoreSchema, "function");
  for (const change of [
    value => { value.inspector.sourceBase64 = Buffer.from("module.exports={}").toString("base64"); },
    value => { value.sharedDependencies[1] = value.sharedDependencies[0]; },
    value => { value.sharedDependencies[0].gitLfSha256 = "0".repeat(64); },
    value => { value.sharedDependencies[0].path = "lib/../package.json"; },
    value => { value.sourceCommit = "0".repeat(40); },
  ]) {
    const mutated = structuredClone(original); change(mutated);
    assert.throws(() => fixture.originalInspector(mutated), /PASSKEY_TRANSITION_OLD_(?:SOURCE|DEPENDENCY)/);
  }
});

test("a native isolated old-to-Passkeys schema transition is atomic and retains repository writes across compatible reopen", {
  skip: process.env.GP_PASSKEYS_COMPATIBILITY_NATIVE !== "isolated-clone-v1"
    ? "requires the explicit, separate native compatibility qualification phase" : false,
  timeout: 420000,
}, async t => fixture.withIsolatedCore(async ({ owner, admin, connect, assertOwned, phase, originalInspector }) => {
  const migrate = require("../lib/persistence/postgresql/core/passkeys");
  const { verifyCoreSchema } = require("../lib/persistence/postgresql/boundary/migrate");
  const { schemaFingerprint } = require("../lib/persistence/postgresql/core/fingerprint");
  const old = originalInspector(), before = await schemaFingerprint(owner), principal = "syn-transition-" + crypto.randomBytes(8).toString("hex");
  const password = "Synthetic transition meadow lantern 2026!", salt = crypto.randomBytes(16);
  const passwordHash = "scrypt-v1$" + salt.toString("base64url") + "$" + crypto.scryptSync(password, salt, 64).toString("base64url");
  await assertOwned();
  await owner.query("BEGIN;SET LOCAL ROLE gp_core_owner");
  for (const command of require("../test-support/postgresql-migration/passkeys-fixture-seed").seed({ principal, organizationId: crypto.randomUUID(), passwordHash })) {
    await owner.query(command.sql, command.values);
  }
  await owner.query("COMMIT");
  async function legacyDigest() {
    const names = (await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='gp' AND tablename NOT LIKE 'passkey%' ORDER BY tablename")).rows.map(row => row.tablename);
    assert(names.length > 100 && names.every(name => /^[a-z][a-z0-9_]+$/.test(name)));
    const digest = crypto.createHash("sha256");
    for (const name of names) {
      const rows = (await owner.query('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\'::jsonb)::text value FROM gp."' + name + '" t')).rows;
      digest.update(name + "\n" + rows[0].value + "\n");
    }
    return digest.digest("hex");
  }
  const unchanged = await legacyDigest();
  await t.test("the real old inspector accepts the baseline; required Passkeys and wrong roles fail before DDL", async () => {
    await old.verifyCoreSchema(owner, { requireVocationalSchool: true, requireSessionSecurity: true });
    await verifyCoreSchema(owner, { requireVocationalSchool: true, requireSessionSecurity: true });
    await assert.rejects(verifyCoreSchema(owner, { requirePasskeys: true }), /PG_PASSKEYS_MIGRATION_REQUIRED/);
    const app = await connect("gp_core_app");
    await assert.rejects(migrate.migrate(app), /Isolated environment verification failed/);
    assert.equal(await migrate.readLedger(owner), null); assert.equal(await schemaFingerprint(owner), before);
  });
  await t.test("a real PostgreSQL error after additive DDL rolls back all relations, the ledger and every legacy row", async () => {
    await assertOwned();
    await admin.query("CREATE SCHEMA transition_fault AUTHORIZATION postgres");
    await admin.query(`CREATE FUNCTION transition_fault.reject_passkeys() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE object_type='table' AND object_identity='gp.passkey_credentials')
      THEN RAISE EXCEPTION 'SYNTHETIC_TRANSITION_DDL_FAILURE' USING ERRCODE='P0001'; END IF;
      END $$`);
    await admin.query("CREATE EVENT TRIGGER transition_reject_passkeys ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION transition_fault.reject_passkeys()");
    try {
      await assert.rejects(migrate.migrate(owner), error => error.code === "P0001" && /SYNTHETIC_TRANSITION_DDL_FAILURE/.test(error.message));
      assert.deepEqual((await owner.query("SELECT to_regclass('gp.passkey_subjects') subject,to_regclass('gp.passkey_credentials') credential,to_regclass('gp.passkeys_migration_history') ledger")).rows, [{ subject: null, credential: null, ledger: null }]);
      assert.equal(await schemaFingerprint(owner), before); assert.equal(await legacyDigest(), unchanged);
      await old.verifyCoreSchema(owner, { requireVocationalSchool: true, requireSessionSecurity: true });
    } finally {
      await assertOwned(); await admin.query("DROP EVENT TRIGGER transition_reject_passkeys;DROP SCHEMA transition_fault CASCADE");
    }
    phase("actual-sql-failure-rolled-back");
  });
  await t.test("failed strict verification after the real ledger insert remains inside the same SQL transaction", async () => {
    await assertOwned();
    await admin.query("CREATE SCHEMA transition_fault AUTHORIZATION postgres");
    await admin.query(`CREATE FUNCTION transition_fault.corrupt_passkeys_ledger() RETURNS event_trigger LANGUAGE plpgsql AS $fixture$
      BEGIN
        IF EXISTS(SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE object_type='table' AND object_identity='gp.passkeys_migration_history') THEN
          EXECUTE $ddl$CREATE FUNCTION gp.transition_corrupt_ledger() RETURNS trigger LANGUAGE plpgsql AS $corrupt$
            BEGIN NEW.plan_sha256:=repeat('0',64); RETURN NEW; END; $corrupt$$ddl$;
          EXECUTE 'CREATE TRIGGER transition_corrupt_ledger BEFORE INSERT ON gp.passkeys_migration_history FOR EACH ROW EXECUTE FUNCTION gp.transition_corrupt_ledger()';
        END IF;
      END; $fixture$`);
    await admin.query("CREATE EVENT TRIGGER transition_corrupt_passkeys ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION transition_fault.corrupt_passkeys_ledger()");
    try {
      await assert.rejects(migrate.migrate(owner), /PG_PASSKEYS_MIGRATION_CONTRACT/);
      assert.equal(await migrate.readLedger(owner), null);
      assert.equal((await owner.query("SELECT to_regclass('gp.passkey_subjects') name")).rows[0].name, null);
      assert.equal((await owner.query("SELECT to_regprocedure('gp.transition_corrupt_ledger()') name")).rows[0].name, null);
      assert.equal(await schemaFingerprint(owner), before); assert.equal(await legacyDigest(), unchanged);
      await old.verifyCoreSchema(owner, { requireVocationalSchool: true, requireSessionSecurity: true });
    } finally {
      await assertOwned(); await admin.query("DROP EVENT TRIGGER transition_corrupt_passkeys;DROP SCHEMA transition_fault CASCADE");
    }
    phase("actual-post-ledger-verification-failure-rolled-back");
  });
  await t.test("activation validates the complete migrated schema before commit and leaves legacy data unchanged", async () => {
    assert.equal((await migrate.migrate(owner)).applied, true);
    await verifyCoreSchema(owner, { requireVocationalSchool: true, requireSessionSecurity: true, requirePasskeys: true });
    assert.notEqual(await schemaFingerprint(owner), before); assert.equal(await legacyDigest(), unchanged);
    await assert.rejects(old.verifyCoreSchema(owner), /Core development schema contract mismatch/);
    await owner.query("BEGIN;SET LOCAL ROLE gp_core_owner");
    try {
      await owner.query("UPDATE gp.passkeys_migration_history SET base_target_sha256=$1", ["0".repeat(64)]);
      await assert.rejects(verifyCoreSchema(owner, { requirePasskeys: true }), /PG_PASSKEYS_MIGRATION_CONTRACT/);
    } finally { await owner.query("ROLLBACK"); }
    phase("actual-schema-activated-old-inspector-incompatible");
  });
  await t.test("strict required and compatible reopen retain actual credential counters, revocations and business writes", async () => {
    const { Pool } = require("pg"), { createPostgresqlPersistenceProvider } = require("../lib/persistence/postgresql/provider");
    const { createPasskeysRepository } = require("../lib/persistence/repositories/passkeys");
    const { coreRepositories } = require("../lib/persistence/postgresql/core/application");
    const activeFingerprint = await schemaFingerprint(owner);
    const create = required => {
      const pool = new Pool({ ...owner.connectionParameters, user: "gp_core_app", max: 2 });
      const provider = createPostgresqlPersistenceProvider({ pool, poolOwnership: "provider", catalog: [
        ...require("../lib/persistence/postgresql/core/catalog").createCoreCatalog().entries,
        ...require("../lib/persistence/postgresql/core/session-security-catalog").CATALOG,
        ...require("../lib/persistence/postgresql/core/passkeys-catalog").assertPasskeysCatalog(),
      ], prepareClient: async client => {
        await require("../lib/persistence/postgresql/core/environment").verifyEnvironment(client, { purpose: "app" });
        await client.query("SET search_path=pg_catalog,gp");
        await verifyCoreSchema(client, { requireVocationalSchool: true, requireSessionSecurity: true, requirePasskeys: required });
      } });
      return { provider, passkeys: createPasskeysRepository(provider), access: coreRepositories(provider).portalAccess };
    };
    const active = create(true); let key, revoked, subject;
    try {
      const user = await active.access.getEmployeeLogin({ loginName: principal }); assert.equal(user.password_hash, passwordHash);
      assert(crypto.timingSafeEqual(crypto.scryptSync(password, salt, 64), Buffer.from(passwordHash.split("$")[2], "base64url")));
      assert.equal(await active.passkeys.available(), true);
      const now = new Date().toISOString(); subject = await active.passkeys.ensureSubject({ kind: "employee", id: principal, now });
      const ec = crypto.createECDH("prime256v1"), point = ec.generateKeys();
      const publicKey = Buffer.concat([Buffer.from("a5010203262001215820", "hex"), point.subarray(1, 33), Buffer.from("225820", "hex"), point.subarray(33)]);
      const register = label => active.passkeys.registerCredential({ subjectId: subject.id, expectedAuthRevision: subject.authRevision,
        credentialId: crypto.randomBytes(32).toString("base64url"), publicKey, counter: 1,
        authorityHash: require("../lib/passkey-protocol").subjectBinding(subject), deviceType: "singleDevice", backedUp: false, label, now });
      key = await register("Synthetic retained repository key"); revoked = await register("Synthetic revoked repository key");
      key = await active.passkeys.updateCredentialUse({ id: key.id, subjectId: subject.id, expectedAuthRevision: subject.authRevision,
        expectedRevision: key.revision, expectedCounter: 1, expectedAuthorityHash: key.authorityHash, newCounter: 4, backedUp: false, now });
      assert(key); revoked = await active.passkeys.revokeCredential({ id: revoked.id, subjectId: subject.id, expectedRevision: revoked.revision, now });
      assert(revoked.revokedAt);
      await owner.query("BEGIN;SET LOCAL ROLE gp_core_owner");
      await owner.query("INSERT INTO gp.settings(key,value) VALUES('transition-business-write',$1)", [principal]); await owner.query("COMMIT");
    } finally { await active.provider.close(); }
    assert.equal((await migrate.migrate(owner)).applied, false);
    assert.equal(await schemaFingerprint(owner), activeFingerprint);
    const compatible = create(false);
    try {
      assert.equal((await compatible.passkeys.credential(key.credentialId)).counter, 4);
      assert.equal((await compatible.passkeys.credentialById({ id: revoked.id, subjectId: subject.id })).revokedAt, revoked.revokedAt);
      assert.deepEqual((await compatible.passkeys.listCredentials({ subjectId: subject.id })).map(item => item.id), [key.id]);
      assert.equal((await compatible.access.getEmployeeLogin({ loginName: principal })).password_hash, passwordHash);
      assert.equal((await owner.query("SELECT value FROM gp.settings WHERE key='transition-business-write'")).rows[0].value, principal);
    } finally { await compatible.provider.close(); }
    const reader = await connect("gp_core_reader");
    await assert.rejects(reader.query("SELECT public_key FROM gp.passkey_credentials"), error => error.code === "42501");
    await assertOwned();
    phase("strict-and-compatible-reopen-retained-repository-state");
    // This is intentionally not a WebAuthn ceremony or updater availability
    // claim. Those require the separately bound HTTP/systemd transition fixture.
  });
}));

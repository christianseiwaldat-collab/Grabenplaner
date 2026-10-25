"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawn } = require("node:child_process");
const enabled = process.env.GP_PASSKEYS_UPGRADE_FIXTURE === "before-passkeys-v1";

test("native old-checkpoint upgrade, transactional rollback, repeat chain and restored lost-key invalidation", {
  // The complete native backup/restore plus both full migration repeat chains
  // exceeded 180s in the owned TCG rehearsal after successful invalidation.
  // Individual SQL/lock/tool limits remain unchanged; no assertion is skipped.
  skip: !enabled, timeout: 420000,
}, async () => {
  const started = performance.now();
  const phase = name => console.log(JSON.stringify({ fixture: "synthetic-passkey-upgrade", phase: name,
    elapsedMilliseconds: Math.round(performance.now() - started) }));
  phase("start");
  assert.equal(process.platform, "linux"); assert.notEqual(process.getuid(), 0);
  const { Client, Pool } = require("pg"), E = require("../lib/persistence/postgresql/core/environment");
  const { assertSyntheticEndpoint } = require("../test-support/postgresql-migration/ci-endpoint");
  const urls = Object.fromEntries(["migrator", "app", "reader"].map(purpose => {
    const url = assertSyntheticEndpoint(process.env[`GP_CORE_${purpose.toUpperCase()}_URL`], "core", ["55482", "55483"]);
    assert.equal(url.username, `gp_core_${purpose}`); return [purpose, url];
  }));
  const M = require("../lib/persistence/postgresql/core/passkeys"), { verifyCoreSchema } = require("../lib/persistence/postgresql/boundary/migrate");
  const { schemaFingerprint } = require("../lib/persistence/postgresql/core/fingerprint");
  const { createPostgresqlPersistenceProvider } = require("../lib/persistence/postgresql/provider");
  const { createPasskeysRepository } = require("../lib/persistence/repositories/passkeys");
  const RESTORE = require("../lib/persistence/postgresql/operations/restore-authentication");
  const owner = new Client({ connectionString: urls.migrator.href, connectionTimeoutMillis: 5000, query_timeout: 35000 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-passkey-restore-native-")); fs.chmodSync(root, 0o700);
  const socket = path.join(root, "socket"), data = path.join(root, "cluster"), dump = path.join(root, "checkpoint.dump");
  fs.mkdirSync(socket, { mode: 0o700 });
  const cloneGuard = require("../test-support/postgresql-migration/passkeys-private-restore-clone").privateRestoreClone(root);
  // Node's outer test deadline can skip async finally. These hooks stop only
  // the PID/start-time/UID/CWD-bound private clone; SIGKILL cannot be intercepted.
  const emergencyStop = () => {
    try { console.log(JSON.stringify({ fixture: "synthetic-passkey-upgrade", emergencyCleanup: cloneGuard.stopAndVerify() })); }
    catch (error) { console.error("PRIVATE_RESTORE_CLONE_CLEANUP_FAILED:" + error.message); process.exitCode = 1; }
  };
  const terminated = () => { emergencyStop(); process.removeListener("exit", emergencyStop); process.exit(143); };
  process.once("exit", emergencyStop); process.once("SIGTERM", terminated);
  const binaryRoot = "/usr/lib/postgresql/18/bin", domain = "gp_migration_core", port = 55489;
  const principal = "syn-passkey-upgrade-" + crypto.randomBytes(8).toString("hex"), orgId = crypto.randomUUID();
  const fixtureSeed = require("../test-support/postgresql-migration/passkeys-fixture-seed");
  // The same historical application-data ownership boundary as withCoreFixture.
  // Infrastructure ledgers are deliberately absent and survive fixture cleanup.
  const inventory = require("../test-support/postgresql-migration-doc-fixtures/block-1-inventory.json");
  const ownedTables = [...inventory.tables.filter(table => table.database === "core" && table.name !== "schema_migrations").map(table => table.name), "article_reference_snapshots"];
  const hash = value => crypto.createHash("sha256").update(value).digest("hex"), now = new Date().toISOString();
  const password = "Synthetic upgrade lantern meadow 2026!", salt = Buffer.alloc(16, 91);
  const passwordHash = `scrypt-v1$${salt.toString("base64url")}$${crypto.scryptSync(password, salt, 64).toString("base64url")}`;
  let sourceApplication, provider, cloneProvider, cloneAdmin, cloneMigrator, ownsData = false, primaryError;
  const ownedChallengeIds = [];
  async function tool(name, args, environment = {}) {
    const label = name === "pg_ctl" ? name + (args.includes("start") ? "-start" : "-stop") : name;
    phase(label + "-begin");
    assert(["initdb", "pg_ctl", "pg_dump", "pg_restore"].includes(name));
    const binary = path.join(binaryRoot, name), stat = fs.lstatSync(binary);
    assert(stat.isFile() && stat.uid === 0 && !(stat.mode & 0o022)); assert.equal(fs.realpathSync(binary), binary);
    const errorFile = path.join(root, crypto.randomUUID() + ".error"), fd = fs.openSync(errorFile, "wx", 0o600);
    try {
      const child = spawn(binary, args, { cwd: root, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...environment }, stdio: ["ignore", "ignore", fd] });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error("SYNTHETIC_PASSKEY_RESTORE_TOOL_TIMEOUT")); }, 60000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(Object.assign(Error("SYNTHETIC_PASSKEY_RESTORE_TOOL_FAILED"), { nativeTool: name })); });
      });
    } finally { fs.closeSync(fd); phase(label + "-end"); }
  }
  const sourceEnvironment = { PGHOST: urls.migrator.hostname, PGPORT: urls.migrator.port, PGDATABASE: domain,
    PGUSER: decodeURIComponent(urls.migrator.username), PGPASSWORD: decodeURIComponent(urls.migrator.password), PGCONNECT_TIMEOUT: "5" };
  const cloneOptions = purpose => ({ host: socket, port, database: domain, user: `gp_core_${purpose}`, password: decodeURIComponent(urls[purpose].password), connectionTimeoutMillis: 5000 });
  const makeProvider = (pool, options) => createPostgresqlPersistenceProvider({ pool, poolOwnership: "provider",
    prepareClient: client => E.verifyEnvironment(client, { purpose: "app" }), catalog: [
      ...require("../lib/persistence/postgresql/core/catalog").createCoreCatalog().entries,
      ...require("../lib/persistence/postgresql/core/session-security-catalog").CATALOG,
      ...require("../lib/persistence/postgresql/core/passkeys-catalog").assertPasskeysCatalog()], ...options });
  async function passwordAccepted(repositories) {
    const user = await repositories.portalAccess.getEmployeeLogin({ loginName: principal }); assert.equal(user.password_hash, passwordHash);
    const [, encodedSalt, encodedKey] = user.password_hash.split("$");
    assert(crypto.timingSafeEqual(crypto.scryptSync(password, Buffer.from(encodedSalt, "base64url"), 64), Buffer.from(encodedKey, "base64url")));
    assert.equal(await require("../lib/portal-login-security").acceptVerifiedLogin(repositories.portalAccess, { user }), "accepted");
  }
  const state = async client => (await client.query(`SELECT jsonb_build_object(
    'subjects',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM gp.passkey_subjects s),
    'credentials',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM gp.passkey_credentials c),
    'challenges',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM gp.passkey_challenges c),
    'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM gp.portal_sessions s),
    'organizationSessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM gp.portal_organization_sessions s),
    'mobile',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM gp.mobile_sessions s),
    'reset',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM gp.portal_password_reset_tokens s),
    'passwords',(SELECT jsonb_agg(jsonb_build_array(employee_number,password_hash) ORDER BY employee_number) FROM gp.portal_users)) value`)).rows[0].value;
  try {
    await owner.connect(); await E.verifyEnvironment(owner, { purpose: "migrator" });
    phase("source-connected");
    await owner.query("SET search_path=pg_catalog,gp; SET lock_timeout='5s'; SET statement_timeout='30s'");
    assert.equal(await M.readLedger(owner), null, "run only on a fresh explicit --bootstrap-before-passkeys fixture");
    const oldFingerprint = await schemaFingerprint(owner); await verifyCoreSchema(owner, { requireVocationalSchool: true, requireSessionSecurity: true });
    if ((await owner.query("SELECT to_regclass('gp.boundary_migration_history') name")).rows[0].name) ownedTables.push("import_master_bindings", "import_master_events", "import_master_holds", "trade_source_references", "trade_source_reference_versions", "sales_audit_inbox");
    if ((await owner.query("SELECT to_regclass('gp.trade_annotations') name")).rows[0].name) ownedTables.push("trade_annotations");
    assert(ownedTables.every(name => /^[a-z][a-z0-9_]+$/.test(name)));
    await owner.query("BEGIN; SET LOCAL ROLE gp_core_owner");
    const occupied = (await owner.query(ownedTables.map(name => `SELECT EXISTS(SELECT 1 FROM gp."${name}") occupied`).join(" UNION ALL "))).rows;
    assert(occupied.every(row => !row.occupied), "the explicit old fixture requires entirely empty application data");
    for (const { sql, values } of fixtureSeed.seed({ principal, organizationId: orgId, passwordHash })) await owner.query(sql, values);
    await owner.query("SELECT setval(pg_get_serial_sequence('gp.departments','id'),1,true)");
    await owner.query("COMMIT"); ownsData = true;
    phase("seed-committed");
    sourceApplication = await require("../lib/persistence/postgresql/core/application").openCoreDevelopmentApplication({ profile: E.PROFILE, databaseUrl: urls.app.href, tlsMode: "disable-local-only" });
    phase("old-application-opened");
    assert.equal(await sourceApplication.repositories.passkeys.available(), false);
    await passwordAccepted(sourceApplication.repositories);
    await sourceApplication.close(); sourceApplication = null;
    phase("old-password-accepted-and-closed");
    let interrupted = false;
    await assert.rejects(M.migrate({ query: async (sql, values) => {
      const result = await owner.query(sql, values);
      if (!interrupted && sql === M.statements[0]) { interrupted = true; await owner.query("SELECT 1/0"); }
      return result;
    } }), error => error.code === "22012");
    assert(interrupted); assert.equal((await owner.query("SELECT to_regclass('gp.passkey_subjects') name")).rows[0].name, null);
    assert.equal(await M.readLedger(owner), null); assert.equal(await schemaFingerprint(owner), oldFingerprint);
    phase("migration-failure-rolled-back");
    const applied = await M.migrate(owner); assert.equal(applied.applied, true); assert.equal(applied.legacyDataChanged, false);
    phase("passkeys-migration-applied");
    await verifyCoreSchema(owner, { requireVocationalSchool: true, requireSessionSecurity: true, requirePasskeys: true });
    const newFingerprint = await schemaFingerprint(owner); assert.notEqual(newFingerprint, oldFingerprint);
    for (const module of ["xoffi-snapshots", "vocational-school", "session-security", "passkeys"]) assert.equal((await require("../lib/persistence/postgresql/core/" + module).migrate(owner)).applied, false);
    phase("source-repeat-chain-verified");
    assert.equal(await schemaFingerprint(owner), newFingerprint);
    await owner.query("BEGIN; SET LOCAL ROLE gp_core_owner");
    await owner.query("UPDATE gp.passkeys_migration_history SET base_target_sha256=$1", ["0".repeat(64)]);
    await assert.rejects(verifyCoreSchema(owner, { requirePasskeys: true }), /PG_PASSKEYS_MIGRATION_CONTRACT/);
    await owner.query("ROLLBACK"); await verifyCoreSchema(owner, { requirePasskeys: true });
    provider = makeProvider(new Pool({ connectionString: urls.app.href, max: 2 })); const repo = createPasskeysRepository(provider);
    const personal = await repo.ensureSubject({ kind: "employee", id: principal, now });
    const organization = await repo.ensureSubject({ kind: "organization", id: orgId, now });
    const register = subject => repo.registerCredential({ subjectId: subject.id, expectedAuthRevision: subject.authRevision,
      credentialId: crypto.randomBytes(32).toString("base64url"), publicKey: crypto.randomBytes(48).toString("base64url"), counter: 0,
      authorityHash: require("../lib/passkey-protocol").subjectBinding(subject), deviceType: "multiDevice", backedUp: true, label: "Synthetic restored key", now });
    const key = await register(personal); await register(organization);
    phase("both-credentials-registered");
    const authenticationNow = new Date().toISOString(), expires = new Date(Date.now() + 120000).toISOString();
    const challengeInput = { purpose: "reauthenticate", subjectId: personal.id, expectedAuthRevision: personal.authRevision,
      challenge: crypto.randomBytes(32).toString("base64url"), bindingHash: hash("synthetic browser"), sessionHash: hash("synthetic session"), authorityHash: hash("authority"),
      rpId: "gp.example.test", origin: "https://gp.example.test", payload: { operation: "password-change" }, createdAt: authenticationNow, expiresAt: expires };
    const bound = await repo.issueChallenge(challengeInput), anonymous = await repo.issueChallenge({ ...challengeInput, challenge: crypto.randomBytes(32).toString("base64url"),
      purpose: "authenticate", subjectId: null, expectedAuthRevision: null, sessionHash: null, authorityHash: null });
    ownedChallengeIds.push(bound.id, anonymous.id);
    await owner.query("BEGIN; SET LOCAL ROLE gp_core_owner");
    await owner.query("INSERT INTO gp.portal_sessions(id,employee_number,token_hash,expires_at,authenticated_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$4)", [crypto.randomUUID(), principal, hash("browser"), expires, authenticationNow]);
    await owner.query("INSERT INTO gp.portal_organization_sessions(id,account_id,token_hash,expires_at,authenticated_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$4)", [crypto.randomUUID(), orgId, hash("organization-browser"), expires, authenticationNow]);
    await owner.query("INSERT INTO gp.portal_password_reset_tokens(id,employee_number,token_hash,email_fingerprint,expires_at) VALUES($1,$2,$3,$3,$4)", [crypto.randomUUID(), principal, hash("reset"), expires]);
    await owner.query("INSERT INTO gp.mobile_sessions(id,employee_number,access_token_hash,access_expires_at,refresh_token_hash,refresh_expires_at,installation_id_hash,platform) VALUES($1,$2,$3,$4,$5,$4,$6,'android')", [crypto.randomUUID(), principal, hash("access"), expires, hash("refresh"), hash("installation")]);
    await owner.query("COMMIT");
    phase("authentication-state-seeded");
    assert.equal((await owner.query("SELECT count(*)::integer active FROM gp.passkey_challenges WHERE id=ANY($1::text[]) AND consumed_at IS NULL AND expires_at::timestamptz>clock_timestamp()", [ownedChallengeIds])).rows[0].active, 2,
      "both freshly issued challenges must still be active when the native backup begins");
    // Take an actual native backup while the soon-to-be-lost key is active.
    await tool("pg_dump", ["--format=custom", "--schema=gp", "--extension=pgcrypto", "--file=" + dump], sourceEnvironment); fs.chmodSync(dump, 0o600);
    const dumpHash = hash(fs.readFileSync(dump)); await repo.revokePrincipal({ kind: "employee", id: principal, now: new Date().toISOString() });
    const originalState = await state(owner);
    phase("source-key-revoked-after-backup");
    await tool("initdb", ["-D", data, "-U", "postgres", "--auth-local=trust", "--auth-host=reject", "--encoding=UTF8", "--locale=C.UTF-8"]);
    fs.appendFileSync(path.join(data, "postgresql.conf"), `\nlisten_addresses=''\nport=${port}\nunix_socket_directories='${socket}'\nmax_connections=20\nmax_locks_per_transaction=256\nshared_buffers='32MB'\nlog_min_error_statement=panic\n`);
    await tool("pg_ctl", ["-D", data, "-l", path.join(root, "postgresql.log"), "-w", "start"]); cloneGuard.bind();
    cloneAdmin = new Client({ host: socket, port, user: "postgres", database: "postgres" }); await cloneAdmin.connect();
    await cloneAdmin.query("CREATE ROLE gp_core_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    for (const purpose of ["migrator", "app", "reader"]) {
      const role = `gp_core_${purpose}`;
      const sql = (await cloneAdmin.query("SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', $1::text,$2::text) sql", [role, decodeURIComponent(urls[purpose].password)])).rows[0].sql;
      await cloneAdmin.query(sql);
    }
    await cloneAdmin.query("GRANT gp_core_owner TO gp_core_migrator"); await cloneAdmin.query("CREATE DATABASE gp_migration_core OWNER gp_core_owner TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C.UTF-8'");
    await cloneAdmin.query("REVOKE ALL ON DATABASE gp_migration_core FROM PUBLIC; GRANT CONNECT ON DATABASE gp_migration_core TO gp_core_migrator,gp_core_app,gp_core_reader");
    phase("private-clone-roles-ready");
    await tool("pg_restore", ["--exit-on-error", "--single-transaction", "--dbname=" + domain, dump], { PGHOST: socket, PGPORT: String(port), PGUSER: "postgres" });
    const cloneOwner = new Client({ host: socket, port, user: "postgres", database: domain }); await cloneOwner.connect();
    try { await require("../lib/persistence/postgresql/operations/restore-privileges").materializeDefaultPrivileges(cloneOwner, ["gp"]); }
    finally { await cloneOwner.end(); }
    phase("private-clone-privileges-materialized");
    cloneMigrator = new Client(cloneOptions("migrator")); await cloneMigrator.connect(); await cloneMigrator.query("SET search_path=pg_catalog,gp; SET lock_timeout='5s'; SET statement_timeout='30s'");
    await verifyCoreSchema(cloneMigrator, { requirePasskeys: true }); assert.equal(await schemaFingerprint(cloneMigrator), newFingerprint);
    phase("private-clone-schema-verified");
    cloneProvider = makeProvider(new Pool({ ...cloneOptions("app"), max: 2 })); const cloneRepo = createPasskeysRepository(cloneProvider);
    assert.equal((await cloneRepo.credential(key.credentialId)).revokedAt, null, "the old native backup really resurrects the lost key before the explicit boundary");
    const poisonId = crypto.randomUUID(), overflowPrincipal = principal + "-overflow";
    await cloneMigrator.query("BEGIN; SET LOCAL ROLE gp_core_owner");
    const overflowEmployee = fixtureSeed.employee(overflowPrincipal, "Synthetic overflow actor");
    await cloneMigrator.query(overflowEmployee.sql, overflowEmployee.values);
    await cloneMigrator.query("INSERT INTO gp.portal_users(employee_number,password_hash,role,active,password_policy_version) VALUES($1,$2,$3,1,1)", [overflowPrincipal, passwordHash, principal]);
    await cloneMigrator.query("INSERT INTO gp.passkey_subjects(id,principal_kind,employee_number,user_handle,auth_revision,created_at,updated_at) VALUES($1,'employee',$2,$3,9007199254740991,$4,$4)", [poisonId, overflowPrincipal, crypto.randomBytes(32), now]);
    await cloneMigrator.query("COMMIT");
    const beforeFailure = await state(cloneMigrator);
    phase("restore-failure-injection-seeded");
    await assert.rejects(RESTORE.invalidateRestoredAuthentication(cloneMigrator, { scope: RESTORE.SCOPE }), error => error.code === "23514");
    assert.deepEqual(await state(cloneMigrator), beforeFailure, "native CHECK failure rolls back sessions, tokens and every prior update");
    phase("restore-failure-atomic-rollback-verified");
    await cloneMigrator.query("BEGIN; SET LOCAL ROLE gp_core_owner"); await cloneMigrator.query("DELETE FROM gp.portal_users WHERE employee_number=$1", [overflowPrincipal]);
    await cloneMigrator.query("DELETE FROM gp.employees WHERE personnel_number=$1", [overflowPrincipal]); await cloneMigrator.query("COMMIT");
    const result = await RESTORE.invalidateRestoredAuthentication(cloneMigrator, { scope: RESTORE.SCOPE });
    phase("restored-authentication-invalidated");
    assert.equal(result.passwordsChanged, false); assert.equal(result.revoked.passkeyCredentials, 2); assert.equal(result.revoked.passkeyChallenges, 2);
    assert.equal(result.revoked.employeeSessions, 1); assert.equal(result.revoked.organizationSessions, 1); assert.equal(result.revoked.mobileSessions, 1); assert.equal(result.revoked.passwordResetTokens, 1);
    assert((await cloneRepo.credential(key.credentialId)).revokedAt); assert.equal((await cloneRepo.listCredentials({ subjectId: personal.id })).length, 0);
    for (const challenge of [bound, anonymous]) assert.equal(await cloneRepo.consumeChallenge({ id: challenge.id, purpose: challenge.purpose, bindingHash: challenge.bindingHash, now: new Date().toISOString() }), null);
    for (const module of ["xoffi-snapshots", "vocational-school", "session-security", "passkeys"]) assert.equal((await require("../lib/persistence/postgresql/core/" + module).migrate(cloneMigrator)).applied, false);
    phase("clone-repeat-chain-verified");
    assert.equal((await cloneRepo.subjectById(personal.id)).authRevision, 2, "idempotent migration must not advance restore epochs a second time");
    assert.equal((await cloneMigrator.query("SELECT password_hash FROM gp.portal_users WHERE employee_number=$1", [principal])).rows[0].password_hash, passwordHash);
    await passwordAccepted(require("../lib/persistence/application-repositories").createApplicationRepositories(cloneProvider));
    phase("restored-password-accepted");
    assert.deepEqual(await state(owner), originalState); assert.equal(hash(fs.readFileSync(dump)), dumpHash);
  } catch (error) { primaryError = error; throw error; }
  finally {
    phase("cleanup-begin");
    const cleanupErrors = [];
    async function cleanupStep(label, work, timeout = 10000) {
      let timer;
      try { await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("PASSKEY_CLEANUP_DEADLINE:" + label)), timeout);
      })]); }
      catch (error) { cleanupErrors.push(error); console.error("PRIVATE_RESTORE_CLEANUP_STEP_FAILED:" + label); }
      finally { clearTimeout(timer); }
    }
    await Promise.all([
      ["source-application", () => sourceApplication?.close()], ["clone-provider", () => cloneProvider?.close()],
      ["source-provider", () => provider?.close()], ["clone-migrator", () => cloneMigrator?.end()], ["clone-admin", () => cloneAdmin?.end()],
    ].map(([label, work]) => cleanupStep(label, work)));
    let cloneStopped = false;
    await cleanupStep("private-clone-stop", () => { cloneGuard.stopAndVerify(); cloneStopped = true; }, 65000);
    await cleanupStep("source-rollback", () => owner.query("ROLLBACK; RESET ROLE"), 35000);
    if (ownsData) await cleanupStep("owned-source-data", async () => {
      await E.verifyEnvironment(owner, { purpose: "migrator" }); await owner.query("BEGIN; SET LOCAL ROLE gp_core_owner");
      assert.deepEqual((await owner.query("SELECT value FROM gp.settings WHERE key='migration-test-owner'")).rows, [{ value: principal }], "fixture ownership must remain intact before cleanup");
      await owner.query("DELETE FROM gp.passkey_challenges WHERE id=ANY($1::text[])", [ownedChallengeIds]);
      // Same exclusively owned, originally empty boundary as withCoreFixture.
      await owner.query("TRUNCATE " + ownedTables.map(name => `gp."${name}"`).join(",") + " RESTART IDENTITY CASCADE");
      await owner.query("COMMIT");
    }, 35000);
    await cleanupStep("source-connection", () => owner.end());
    if (cloneStopped) await cleanupStep("private-directory", () => {
      cloneGuard.assertStopped();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      process.removeListener("exit", emergencyStop); process.removeListener("SIGTERM", terminated);
    });
    if (cleanupErrors.length) {
      const cleanupFailure = new AggregateError(cleanupErrors, "PRIVATE_RESTORE_CLEANUP_FAILED");
      if (primaryError) primaryError.cleanupFailure = cleanupFailure;
      else throw cleanupFailure;
    }
    phase("cleanup-complete");
  }
});

test("a terminated native-test child stops only its bound private clone before directory removal", {
  skip: !enabled, timeout: 150000,
}, async () => {
  assert.equal(process.platform, "linux"); assert.notEqual(process.getuid(), 0);
  const { privateRestoreClone } = require("../test-support/postgresql-migration/passkeys-private-restore-clone");
  assert.throws(() => privateRestoreClone(os.tmpdir()), /PASSKEY_CLONE_TEST_SCOPE/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-passkey-restore-native-")); fs.chmodSync(root, 0o700);
  const guard = privateRestoreClone(root), helper = require.resolve("../test-support/postgresql-migration/passkeys-private-restore-clone");
  const childSource = `
    const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
    const root=process.argv[1],helper=process.argv[2],data=path.join(root,'cluster'),socket=path.join(root,'socket');
    fs.mkdirSync(socket,{mode:0o700});const guard=require(helper).privateRestoreClone(root);
    const stop=()=>{try{console.log(JSON.stringify({signalCleanup:guard.stopAndVerify()}));process.exit(143);}
      catch(error){console.error(error.message);process.exit(1);}};
    process.once('SIGTERM',stop);
    function tool(name,args){const result=spawnSync('/usr/lib/postgresql/18/bin/'+name,args,
      {cwd:root,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},timeout:60000,encoding:'utf8'});
      fs.writeFileSync(path.join(root,name+'.stdout'),result.stdout||'');fs.writeFileSync(path.join(root,name+'.stderr'),result.stderr||'');
      if(result.error||result.status!==0)throw Error('PRIVATE_CLONE_CHILD_TOOL_FAILED:'+name);}
    tool('initdb',['-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--encoding=UTF8','--locale=C.UTF-8']);
    fs.appendFileSync(path.join(data,'postgresql.conf'),"\\nlisten_addresses=''\\nport=55490\\nunix_socket_directories='"+socket+"'\\nshared_buffers='16MB'\\nmax_connections=10\\n");
    tool('pg_ctl',['-D',data,'-l',path.join(root,'postgresql.log'),'-w','start']);guard.bind();
    console.log('PRIVATE_CLONE_READY');setInterval(()=>{},1000);
  `;
  let child, closed, transcript = "", primaryError;
  try {
    child = spawn(process.execPath, ["-e", childSource, root, helper], { cwd: root,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    let closeResolve, closeReject;
    closed = new Promise((resolve, reject) => { closeResolve = resolve; closeReject = reject; });
    child.once("close", (code, signal) => closeResolve({ code, signal })); child.once("error", closeReject);
    child.stderr.on("data", chunk => { transcript += chunk.toString(); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("PRIVATE_CLONE_CHILD_START_DEADLINE")), 70000);
      child.stdout.on("data", chunk => { transcript += chunk.toString(); if (transcript.includes("PRIVATE_CLONE_READY")) { clearTimeout(timer); resolve(); } });
      closed.then(() => { clearTimeout(timer); reject(Error("PRIVATE_CLONE_CHILD_EXITED_BEFORE_READY")); }, error => { clearTimeout(timer); reject(error); });
    });
    const bound = guard.bind(); assert(bound && Number.isSafeInteger(bound.pid));
    assert.equal(child.kill("SIGTERM"), true);
    const outcome = await Promise.race([closed, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error("PRIVATE_CLONE_CHILD_STOP_DEADLINE")), 65000); timer.unref();
    })]);
    assert.equal(outcome.code, 143); assert.equal(outcome.signal, null);
    assert(transcript.includes('"controlState":"shut down"'));
    assert.deepEqual(guard.assertStopped(), { started: true, stopped: true, pidBound: true, statusExitCode: 3, controlState: "shut down" });
    console.log(JSON.stringify({ fixture: "synthetic-passkey-upgrade", terminatedChildCleanupVerified: true,
      pidStartTimeUidAndCwdBound: true, nativeControlState: "shut down", hardSigkillCleanupGuaranteed: false }));
  } catch (error) { primaryError = error; throw error; }
  finally {
    let cleanupError;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      try {
        await Promise.race([closed, new Promise((_, reject) => {
          const timer = setTimeout(() => reject(Error("PRIVATE_CLONE_CHILD_CLEANUP_DEADLINE")), 65000); timer.unref();
        })]);
      } catch (error) { cleanupError = error; }
    }
    // Never race the child's own signal cleanup with a parent stop/remove.
    // An unproven child exit leaves the exclusively private directory intact.
    if (!cleanupError) try {
      guard.stopAndVerify(); guard.assertStopped();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) { cleanupError = error; }
    if (cleanupError) {
      if (primaryError) primaryError.cleanupFailure = cleanupError;
      else throw cleanupError;
    }
  }
});

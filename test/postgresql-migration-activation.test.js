"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { resolvePersistenceConfiguration } = require("../lib/persistence/configuration");
const product = require("../lib/persistence/postgresql/productive-configuration");
const runtime = require("../lib/persistence/postgresql/runtime-binding");
const environment = require("../lib/persistence/postgresql/core/environment");
const control = require("../lib/persistence/postgresql/lifecycle-control");

test("Legacy SQLite recovery cannot overwrite files of an activated PostgreSQL pair", t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { assertSqliteRecoveryTarget } = require('../server-tools/linux/recovery/lib/recovery-apply');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-recovery-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => assertSqliteRecoveryTarget(root, {}, {}), { code: 'RECOVERY_LEGACY_OFFLINE_REQUIRED' });
  assert.throws(() => assertSqliteRecoveryTarget(root, { providerId: 'postgresql-pair' }, {}), /PostgreSQL/);
  assert.throws(() => assertSqliteRecoveryTarget(root, {}, { providerId: 'postgresql-pair' }), /PostgreSQL/);
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'postgresql-pair.json'), 'synthetic existing pair');
  assert.throws(() => assertSqliteRecoveryTarget(root, {}, {}), /PostgreSQL/);
  assert.equal(fs.readFileSync(path.join(root, 'data', 'postgresql-pair.json'), 'utf8'), 'synthetic existing pair');
});

test("Every relative dependency of the installed PostgreSQL command entrypoints resolves", () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { createRequire } = require('node:module');
  const directory = path.resolve(__dirname, '../server-tools/linux/postgresql');
  let dependencies = 0;
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.js'))) {
    const file = path.join(directory, name);
    const resolver = createRequire(file);
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      assert.doesNotThrow(() => resolver.resolve(match[1]), `${name}: ${match[1]}`);
      dependencies++;
    }
  }
  assert.ok(dependencies > 0);
});

function fixture() {
  const binding = { format: runtime.FORMAT, profile: runtime.PROFILE, clusterId: "7665279562437779717",
    environmentId: "grabenplaner-pair-" + crypto.randomUUID() };
  const document = { format: product.FORMAT, productActivation: true, host: "127.0.0.1", port: 55486,
    sourceSha256: "a".repeat(64), applicationSha256: "b".repeat(64), activatedAt: new Date().toISOString(), binding,
    accounts: Object.fromEntries(["core", "sales"].flatMap(domain => ["app", "reader"].map(purpose =>
      [`gp_${domain}_${purpose}`, "synthetic-password-with-sufficient-length"]))) };
  const anchor = { format: "grabenplaner-postgresql-pair-v1", environmentId: binding.environmentId,
    clusterId: binding.clusterId, sourceSha256: document.sourceSha256, applicationSha256: document.applicationSha256 };
  return { binding, document, anchor };
}

test("Production application configuration needs a matching two-database activation and only business accounts", () => {
  const { document, anchor } = fixture();
  const resolved = product.resolveDocument(document, anchor);
  assert.equal(new URL(resolved.coreUrl).pathname, "/grabenplaner_core");
  assert.equal(new URL(resolved.readers.salesUrl).username, "gp_sales_reader");
  assert.equal(resolved.databasePath, product.ANCHOR);
  assert.equal(resolved.binding, resolved.readers.binding);
  assert.throws(() => product.resolveDocument({ ...document, productActivation: false }, anchor));
  assert.throws(() => product.resolveDocument(document, { ...anchor, sourceSha256: "c".repeat(64) }));
  assert.throws(() => product.resolveDocument(document, { ...anchor, environmentId: fixture().binding.environmentId }));
  assert.throws(() => product.resolveDocument({ ...document, port: 5432 }, anchor));
  assert.throws(() => product.resolveDocument({ ...document, accounts: { ...document.accounts, gp_migration_admin: "forbidden" } }, anchor));
});

test("The managed PostgreSQL pair admits only explicit server mode before reading configuration or starting persistence", () => {
  // Run the exact production module with a synthetic Linux service identity.
  // This keeps the admission proof executable on development hosts without
  // changing the real process identity, protected files or database state.
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const filename = path.resolve(__dirname, "../lib/persistence/postgresql/productive-configuration.js");
  const { document, anchor } = fixture();
  const reads = [];
  const protectedFiles = new Map([[product.FILE, document], [product.ANCHOR, anchor]]);
  const subject = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module: subject, URL,
    process: { platform: "linux", getuid: () => 61001, getgid: () => 61001 },
    require(name) {
      if (name === "./runtime-binding") return runtime;
      if (name === "node:os") return { userInfo: () => ({ username: "grabenplaner" }) };
      if (name === "node:fs") return {
        lstatSync(file) {
          assert.ok(protectedFiles.has(file));
          reads.push(["lstatSync", file]);
          return { isFile: () => true, isSymbolicLink: () => false,
            nlink: 1, uid: 0, gid: 61001, mode: 0o100640, size: 4096 };
        },
        realpathSync(file) { reads.push(["realpathSync", file]); return file; },
        readFileSync(file) { reads.push(["readFileSync", file]); return JSON.stringify(protectedFiles.get(file)); },
      };
      throw new Error("Unexpected managed configuration dependency");
    },
  }, { filename });
  const valid = {
    NODE_ENV: "production", GRABENPLANER_DEPLOYMENT_KIND: "production",
    GRABENPLANER_POSTGRESQL_APPLICATION_CONFIG: product.FILE,
    GRABENPLANER_DATA_DIR: "/var/lib/grabenplaner", DB_PATH: product.ANCHOR,
    INVOCATION_ID: "a".repeat(32), GRABENPLANER_OPERATION_MODE: "server",
  };
  for (const mode of [undefined, "", " ", "local", " LOCAL ", "lan", " LAN ", "other", "server\nlocal"]) {
    reads.length = 0;
    assert.throws(() => subject.exports.configuration({ ...valid, GRABENPLANER_OPERATION_MODE: mode }),
      /PG_APPLICATION_MANAGED_RUNTIME_REQUIRED/, `mode ${JSON.stringify(mode)}`);
    assert.equal(reads.length, 0, "rejection precedes every protected file read");
  }
  for (const mode of ["server", " SeRvEr "]) {
    reads.length = 0;
    const resolved = subject.exports.configuration({ ...valid, GRABENPLANER_OPERATION_MODE: mode });
    assert.equal(resolved.productActivation, true);
    assert.equal(new URL(resolved.coreUrl).username, "gp_core_app");
    assert.deepEqual(reads, [product.FILE, product.ANCHOR].flatMap(file =>
      ["lstatSync", "realpathSync", "readFileSync"].map(operation => [operation, file])));
  }
});

test("An environment flag alone cannot open PostgreSQL or reuse development and restore exceptions in production", () => {
  for (const environment of [
    { DB_PROVIDER: "postgresql" },
    { DB_PROVIDER: "postgresql", NODE_ENV: "production", GRABENPLANER_POSTGRESQL_REHEARSAL: "activation-12" },
    { DB_PROVIDER: "postgresql", NODE_ENV: "production", GRABENPLANER_POSTGRESQL_APPLICATION_CONFIG: "untrusted.json" },
  ]) assert.throws(() => resolvePersistenceConfiguration({ environment }));
});

test("Runtime database and environment identities cannot be mixed with another pair or a development marker", async () => {
  const { binding } = fixture();
  const options = { profile: runtime.PROFILE, binding, tlsMode: "disable-local-only",
    databaseUrl: "postgresql://gp_core_app:synthetic@127.0.0.1:55486/grabenplaner_core" };
  assert.equal(environment.configuration(options).max, 3);
  assert.throws(() => environment.configuration({ ...options, binding: undefined }));
  assert.throws(() => environment.configuration({ ...options, profile: environment.PROFILE }));
  assert.throws(() => environment.configuration({ ...options, databaseUrl: options.databaseUrl.replace("grabenplaner_core", "gp_migration_core") }));
  const row = { database: "grabenplaner_core", username: "gp_core_app", domain: "core", profile: binding.profile,
    environment_id: binding.environmentId, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false };
  assert.equal((await environment.verifyEnvironment({ query: async () => ({ rows: [row] }) }, { binding })).productActivation, true);
  await assert.rejects(environment.verifyEnvironment({ query: async () => ({ rows: [{ ...row, environment_id: "another-pair" }] }) }, { binding }));
  await assert.rejects(environment.verifyEnvironment({ query: async () => ({ rows: [{ ...row, rolsuper: true }] }) }, { binding }));
  await assert.rejects(environment.verifyEnvironment({ query: async () => ({ rows: [row] }) }));
});

test("The maintenance socket accepts four fixed operations without command, path or account payloads", () => {
  const request = { format: control.FORMAT, action: "restart", requestId: crypto.randomUUID() };
  assert.equal(control.validateRequest(request), request);
  for (const extra of [{ command: "arbitrary" }, { backupDirectory: "/tmp/other" }, { actor: "developer" }]) {
    assert.throws(() => control.validateRequest({ ...request, ...extra }));
  }
  assert.throws(() => control.validateRequest({ ...request, action: "restart-other-service" }));
  assert.throws(() => control.validateRequest({ ...request, requestId: "../escape" }));
});

test("Activation documents bind source, package, cluster and database roles to the same verified promotion", () => {
  const { binding } = fixture();
  const staging = require('../lib/persistence/postgresql/transfer/staging');
  const activation = require('../lib/persistence/postgresql/transfer/activation');
  const configuration = { format: staging.FORMAT, host: '127.0.0.1', port: 55486, clusterId: binding.clusterId,
    accounts: Object.fromEntries(staging.ACCOUNTS.map((name, index) => [name, (index + 1).toString(16).repeat(64)])) };
  const transfer = { verified: true, tables: Array(248).fill({}), sourceSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64) };
  const promotion = { promoted: true, binding, sourceSha256: transfer.sourceSha256, contentSha256: transfer.contentSha256 };
  const input = { configuration, promotion, transfer, applicationSha256: 'c'.repeat(64) };
  const docs = activation.documents(input);
  assert.equal(Object.keys(docs.application.accounts).length, 4);
  assert.equal(Object.keys(docs.operations.recoveryAccounts).length, 8);
  assert.deepEqual(docs.operations.domains.map(domain => domain.database), ['grabenplaner_core', 'grabenplaner_sales']);
  assert.equal(docs.operations.binding, docs.application.binding);
  assert.equal(product.resolveDocument(docs.application, docs.anchor).productActivation, true);
  assert.throws(() => activation.documents({ ...input, transfer: { ...transfer, verified: false } }));
  assert.throws(() => activation.documents({ ...input, promotion: { ...promotion, sourceSha256: 'd'.repeat(64) } }));
  assert.throws(() => activation.documents({ ...input, applicationSha256: 'unverified' }));
  assert.throws(() => activation.documents({ ...input, configuration: { ...configuration, clusterId: '7665279562437779718' } }));
});

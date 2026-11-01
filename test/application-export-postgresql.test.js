"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { Module } = require("node:module"), { spawn } = require("node:child_process");

const native = process.env.GP_EXPORT_NATIVE === "isolated-clone-v1";
if (process.env.GP_EXPORT_NATIVE_CONFIG && !native) throw Error("EXPORT_NATIVE_OPT_IN_REQUIRED");
const REPO = path.resolve(__dirname, ".."), ENTRY = path.join(REPO, "lib/persistence/postgresql/operations/application-export.js");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const quote = value => {
  assert.match(value, /^[a-z][a-z0-9_]{0,62}$/);
  return '"' + value + '"';
};
function privateDirectory(directory) {
  assert.equal(path.resolve(directory), directory);
  assert.equal(fs.realpathSync(directory), directory);
  const info = fs.lstatSync(directory);
  assert(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o077, 0);
}

test("native application database export retains restricted defaults, verifies real contents and rejects invalid sources", {
  skip: !native && "explicit isolated Linux/PostgreSQL fixture required",
  concurrency: false,
}, async t => {
  assert.equal(process.platform, "linux");
  assert.notEqual(process.getuid(), 0, "export runs under an unprivileged account");
  assert(Object.values(os.networkInterfaces()).flat().every(address => address.internal), "use a private network namespace");
  const file = process.env.GP_EXPORT_NATIVE_CONFIG;
  assert.equal(fs.realpathSync(file), file);
  const info = fs.lstatSync(file);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 32768);
  assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o077, 0);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.scope, "isolated-export-test-v1");
  assert.match(config.clusterId, /^[1-9][0-9]{15,24}$/);
  assert.equal(config.expectedEnvironmentId, config.binding.environmentId);
  assert(["absent", "present"].includes(config.passkeysState));
  privateDirectory(config.root);
  const { Client } = require("pg"), environment = require("../lib/persistence/postgresql/core/environment");
  const { captureCheckpoint } = require("../lib/persistence/postgresql/operations/paired-checkpoint");
  const subject = require(ENTRY), options = { coreUrl: config.coreUrl, salesUrl: config.salesUrl,
    profile: config.profile, binding: config.binding, directory: path.join(config.root, "exports") };
  const urls = { core: new URL(config.coreUrl), sales: new URL(config.salesUrl) };
  assert.equal(config.admin.host, "127.0.0.1"); assert.equal(config.admin.database, "postgres");
  assert.equal(config.admin.user, "gp_migration_admin"); assert(Number.isInteger(config.admin.port));
  for (const domain of ["core", "sales"]) {
    assert.equal(urls[domain].hostname, config.admin.host);
    assert.equal(Number(urls[domain].port), config.admin.port);
    assert.equal(decodeURIComponent(urls[domain].username), "gp_" + domain + "_app");
    assert.equal(urls[domain].pathname, "/grabenplaner_" + domain);
  }
  const admin = new Client(config.admin), core = new Client({ ...config.admin, database: "grabenplaner_core" });
  const created = [], toolLogs = path.join(config.root, "tool-logs"); fs.mkdirSync(toolLogs, { mode: 0o700 });
  let toolNumber = 0, completed = false;
  async function command(name, args, { nativeEnvironment = {}, output = false } = {}) {
    const binary = name === "tar" ? "/usr/bin/tar" : "/usr/lib/postgresql/18/bin/" + name;
    assert(["tar", "pg_restore"].includes(name));
    const stat = fs.lstatSync(binary);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022));
    const stem = path.join(toolLogs, String(++toolNumber)), stderr = fs.openSync(stem + ".stderr", "wx", 0o600);
    const stdout = output ? "pipe" : fs.openSync(stem + ".stdout", "wx", 0o600);
    try {
      const child = spawn(binary, args, { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...nativeEnvironment }, stdio: ["ignore", stdout, stderr] });
      const chunks = []; if (output) child.stdout.on("data", data => { chunks.push(data); assert(Buffer.concat(chunks).length < 65536); });
      await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(Error("EXPORT_NATIVE_TOOL_FAILED: " + name))); });
      return Buffer.concat(chunks).toString("utf8");
    } finally { fs.closeSync(stderr); if (!output) fs.closeSync(stdout); }
  }
  async function defaults() {
    for (const domain of ["core", "sales"]) {
      const client = new Client(environment.configuration({ profile: config.profile, binding: config.binding,
        databaseUrl: config[domain + "Url"], domain, tlsMode: "disable-local-only" }));
      await client.connect();
      try { assert.equal((await client.query("SHOW search_path")).rows[0].search_path, "pg_catalog"); }
      finally { await client.end(); }
    }
  }
  async function released() {
    const probe = new Client({ ...config.admin, database: "grabenplaner_core" }); await probe.connect();
    try {
      assert.equal((await probe.query("SELECT pg_try_advisory_lock(9261207) AS held")).rows[0].held, true);
      await probe.query("SELECT pg_advisory_unlock(9261207)");
      assert.equal((await probe.query("SELECT count(*)::integer n FROM pg_stat_activity WHERE application_name IN ('gp-migration-core-app','gp-migration-sales-app') AND state LIKE 'idle in transaction%'")).rows[0].n, 0);
    } finally { await probe.end(); }
    assert.deepEqual(fs.readdirSync(options.directory), [], "failed/cleaned exports leave no temporary archive");
    await defaults();
  }
  async function contents(client, tables) {
    const result = [];
    for (const table of tables) {
      const digest = crypto.createHash("sha256"); let rows = 0;
      const name = quote(table.schema) + "." + quote(table.table);
      await client.query('DECLARE export_content NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS value FROM ' + name + ' t ORDER BY to_jsonb(t)::text COLLATE "C"');
      try {
        for (;;) {
          const batch = (await client.query("FETCH FORWARD 1000 FROM export_content")).rows;
          if (!batch.length) break;
          for (const { value } of batch) { digest.update(String(Buffer.byteLength(value))).update(":").update(value); rows++; }
        }
      } finally { await client.query("CLOSE export_content"); }
      result.push({ schema: table.schema, table: table.table, rows: String(rows), contentSha256: digest.digest("hex") });
    }
    return result;
  }
  async function capture(database, domain, { filter = false } = {}) {
    const client = new Client({ ...config.admin, database }); await client.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const checkpoint = await captureCheckpoint(client, domain);
      const tables = filter ? checkpoint.tables.filter(row => ![...subject.OPERATIONS_ONLY_TABLES[domain], ...subject.OBSOLETE_SALES_TABLES].includes(row.schema + "." + row.table)) : checkpoint.tables;
      const values = await contents(client, tables); await client.query("COMMIT");
      return { tables, values, sequences: filter ? checkpoint.sequences.filter(row => !subject.OBSOLETE_SALES_TABLES.some(name => row.schema + "." + row.name === name + "_id_seq")) : checkpoint.sequences };
    } finally { await client.end(); }
  }
  async function exportAndRestore() {
    const expected = {};
    for (const domain of ["core", "sales"]) expected[domain] = await capture("grabenplaner_" + domain, domain, { filter: true });
    assert(Object.values(expected).some(domain => domain.tables.some(row => BigInt(row.rows) > 0n)), "use populated synthetic source data");
    const exported = await subject.createApplicationDatabaseExport(options); const summary = [];
    try {
      assert.equal(exported.extension, "tar"); assert(exported.size > 0);
      assert.deepEqual(await subject.hashFile(exported.path), { bytes: exported.size, sha256: exported.sha256 });
      await assert.rejects(subject.createApplicationDatabaseExport(options), { code: "BACKUP_WORKSPACE_BUSY" });
      const names = (await command("tar", ["--list", "--file=" + exported.path], { output: true })).trim().split("\n").sort();
      assert.deepEqual(names, ["core.dump", "manifest.json", "sales.dump"]);
      const extraction = path.join(exported.temporaryRoot, "readback"); fs.mkdirSync(extraction, { mode: 0o700 });
      await command("tar", ["--extract", "--file=" + exported.path, "--directory=" + extraction, "--"]);
      assert.deepEqual(fs.readdirSync(extraction).sort(), names);
      const manifest = JSON.parse(fs.readFileSync(path.join(extraction, "manifest.json"), "utf8"));
      assert.equal(manifest.format, "grabenplaner-postgresql-database-export"); assert.equal(manifest.version, 1);
      assert.equal(manifest.consistency, "coordinated-repeatable-read");
      for (const field of ["serverRecoveryBackup", "encryptionKeysIncluded", "protectedDocumentsIncluded"]) assert.equal(manifest[field], false);
      assert.equal(manifest.files.length, 2);
      assert.equal(Boolean(manifest.schemaExtensions.core.passkeys), config.passkeysState === "present");
      for (const domain of ["core", "sales"]) {
        const component = manifest.files.find(row => row.domain === domain); assert.equal(component.file, domain + ".dump");
        assert.deepEqual(await subject.hashFile(path.join(extraction, component.file)), { bytes: component.bytes, sha256: component.sha256 });
        const database = "gp_exportcheck_" + domain + "_" + crypto.randomBytes(6).toString("hex");
        assert.equal((await admin.query("SELECT count(*)::integer n FROM pg_database WHERE datname=$1", [database])).rows[0].n, 0);
        await admin.query("CREATE DATABASE " + quote(database) + " TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C.UTF-8'"); created.push(database);
        await command("pg_restore", ["--exit-on-error", "--single-transaction", "--dbname=" + database, path.join(extraction, component.file)], {
          nativeEnvironment: { PGHOST: config.admin.host, PGPORT: String(config.admin.port), PGUSER: config.admin.user, PGPASSWORD: config.admin.password },
        });
        const actual = await capture(database, domain);
        assert.deepEqual(actual.tables, expected[domain].tables); assert.deepEqual(actual.sequences, expected[domain].sequences);
        assert.deepEqual(actual.values, expected[domain].values, "restored values, not merely row counts, must match");
        summary.push({ domain, tables: actual.tables.length, rows: actual.tables.reduce((sum, row) => sum + BigInt(row.rows), 0n).toString(), sequences: actual.sequences.length, contentDigestsMatched: true });
        await admin.query("DROP DATABASE " + quote(database)); created.splice(created.indexOf(database), 1);
      }
      return summary;
    } finally { exported.cleanup(); assert.equal(fs.existsSync(exported.temporaryRoot), false); }
  }
  try {
    await admin.connect(); await core.connect();
    assert.equal((await admin.query("SELECT system_identifier::text id FROM pg_control_system()")).rows[0].id, config.clusterId);
    assert.equal((await admin.query("SELECT count(*)::integer n FROM pg_database WHERE NOT datistemplate AND datname<>ALL($1::text[])", [["postgres", "grabenplaner_core", "grabenplaner_sales"]])).rows[0].n, 0);
    for (const domain of ["core", "sales"]) {
      const client = new Client({ ...config.admin, database: "grabenplaner_" + domain }); await client.connect();
      try { assert.deepEqual((await client.query("SELECT environment_id,domain,profile FROM gp.environment_contract")).rows,
        [{ environment_id: config.expectedEnvironmentId, domain, profile: config.profile }]); }
      finally { await client.end(); }
    }
    await defaults();
    await t.test("the pinned original source reproduces the canonical-schema failure", async () => {
      const baseline = process.env.GP_EXPORT_BASELINE_SOURCE, pin = process.env.GP_EXPORT_BASELINE_SHA256;
      assert(baseline && /^[a-f0-9]{64}$/.test(pin || ""), "supply the pinned original source for before/after regression");
      const bytes = fs.readFileSync(baseline); assert.equal(hash(bytes), pin); assert.notEqual(hash(bytes), hash(fs.readFileSync(ENTRY)));
      const instance = new Module(ENTRY, module); instance.filename = ENTRY; instance.paths = Module._nodeModulePaths(path.dirname(ENTRY));
      instance._compile(bytes.toString("utf8"), ENTRY);
      await assert.rejects(instance.exports.createApplicationDatabaseExport(options), /Core development schema contract mismatch/);
      await released();
    });
    await t.test("exports both databases with restricted connection defaults and restores exact contents", async () => {
      const summary = await exportAndRestore(); await released(); t.diagnostic(JSON.stringify({ passkeysState: config.passkeysState, restored: summary }));
    });
    await t.test("a real extra Core object is rejected and failure cleanup releases the workspace", async () => {
      const name = "export_drift_" + crypto.randomBytes(6).toString("hex");
      assert.equal((await core.query("SELECT to_regclass($1) name", ["gp." + name])).rows[0].name, null);
      await core.query("CREATE TABLE gp." + quote(name) + "(id integer PRIMARY KEY)");
      const oid = (await core.query("SELECT to_regclass($1)::oid::text id", ["gp." + name])).rows[0].id;
      try { await assert.rejects(subject.createApplicationDatabaseExport(options), /Core development schema contract mismatch/); }
      finally {
        assert.equal((await core.query("SELECT to_regclass($1)::oid::text id", ["gp." + name])).rows[0].id, oid);
        await core.query("DROP TABLE gp." + quote(name));
      }
      await released();
    });
    await t.test("a real environment-contract mismatch is rejected and restored", async () => {
      const changed = "grabenplaner-pair-" + crypto.randomUUID();
      assert.equal((await core.query("UPDATE gp.environment_contract SET environment_id=$1 WHERE environment_id=$2", [changed, config.expectedEnvironmentId])).rowCount, 1);
      try { await assert.rejects(subject.createApplicationDatabaseExport(options), /Isolated environment verification failed/); }
      finally { assert.equal((await core.query("UPDATE gp.environment_contract SET environment_id=$1 WHERE environment_id=$2", [config.expectedEnvironmentId, changed])).rowCount, 1); }
      await released();
    });
    await t.test("a Sales environment mismatch releases the already-held Core snapshot and coordination lease", async () => {
      const sales = new Client({ ...config.admin, database: "grabenplaner_sales" }); await sales.connect();
      try {
        const changed = "grabenplaner-pair-" + crypto.randomUUID();
        assert.equal((await sales.query("UPDATE gp.environment_contract SET environment_id=$1 WHERE environment_id=$2", [changed, config.expectedEnvironmentId])).rowCount, 1);
        try { await assert.rejects(subject.createApplicationDatabaseExport(options), /Isolated environment verification failed/); }
        finally { assert.equal((await sales.query("UPDATE gp.environment_contract SET environment_id=$1 WHERE environment_id=$2", [config.expectedEnvironmentId, changed])).rowCount, 1); }
        await released();
      } finally { await sales.end(); }
    });
    await t.test("a fresh complete export succeeds after the real failures", async () => { await exportAndRestore(); await released(); });
    completed = true;
  } finally {
    for (const name of created) { assert.match(name, /^gp_exportcheck_(core|sales)_[a-f0-9]{12}$/); await admin.query("DROP DATABASE " + quote(name)); }
    await core.end(); await admin.end();
  }
  assert(completed);
});

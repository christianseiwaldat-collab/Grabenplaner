"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const policy = require("../server-tools/linux/lib/deploy-policy");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const enabled = process.env.GP_ACCELERATION_NATIVE === "private-postgresql-v1";
if (process.env.GP_ACCELERATION_NATIVE_CONFIG && !enabled) throw Error("ACCELERATION_NATIVE_OPT_IN_REQUIRED");
test("native PostgreSQL shortpath retains schema/data separation and real paired rollback restores", {
  skip: !enabled && "owned private Linux/PostgreSQL fixture required",
}, async t => {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 1000);
  assert(Object.values(os.networkInterfaces()).flat().every(value => value.internal));
  const file = process.env.GP_ACCELERATION_NATIVE_CONFIG, info = fs.lstatSync(file);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid() && !(info.mode & 0o077));
  const config = JSON.parse(fs.readFileSync(file));
  assert.equal(config.scope, "private-postgresql-shortpath-v1"); assert.equal(config.host, "127.0.0.1"); assert.equal(config.port, 55485);
  assert.equal(config.user, "fixtureadmin"); assert.equal(fs.realpathSync(config.root), config.root);
  const { Client } = require("pg"), { schemaFingerprint } = require("../lib/persistence/postgresql/core/fingerprint");
  const admin = new Client({ host: config.host, port: config.port, user: config.user, database: "postgres" });
  await admin.connect(); const clients = {};
  try {
    const clusterId = (await admin.query("SELECT system_identifier::text id FROM pg_control_system()")).rows[0].id;
    for (const domain of ["core", "sales"]) {
      await admin.query('CREATE DATABASE "accel_' + domain + '"');
      const client = clients[domain] = new Client({ host: config.host, port: config.port, user: config.user, database: "accel_" + domain });
      await client.connect(); await client.query("CREATE SCHEMA gp; CREATE TABLE gp.probe(id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO gp.probe VALUES(1,7)");
    }
    async function identity() {
      const domains = {};
      for (const domain of ["core", "sales"]) {
        const client = clients[domain]; await client.query("SET search_path=pg_catalog,gp");
        domains[domain] = { clusterId, database: "accel_" + domain, environmentId: config.environmentId,
          schemaSha256: await schemaFingerprint(client, ["gp"]) };
      }
      return policy.postgresqlPairIdentity(domains);
    }
    const original = await identity(), fingerprint = hash("reviewed installed public-only contract");
    const verifiedAt = new Date().toISOString(), contract = { fingerprint, policyVersion: policy.POLICY_VERSION, policyId: policy.POLICY_ID,
      inventoryPathsSha256: hash("same inventory"), manifestSha256: hash("sealed manifest") };
    const proof = { format: policy.FORMAT, schemaVersion: 3, ...original, contractSha256: fingerprint,
      policyVersion: policy.POLICY_VERSION, policyId: policy.POLICY_ID, inventoryPathsSha256: contract.inventoryPathsSha256,
      configurationSha256: hash("synthetic configuration"), verifiedAt, runId: crypto.randomUUID(), sequence: 1,
      eventHash: hash("test signature binding"), receiptSha256: hash("synthetic signed full-run fixture") };
    const value = { installed: contract, candidate: contract, proof, identity: original, configurationSha256: proof.configurationSha256,
      timerActive: true, scheduledForMs: Date.parse(verifiedAt) + 3600000, history: { ok: true, events: [{ sequence: 1, eventHash: proof.eventHash,
        payload: { eventType: "full-assurance-passed", runId: proof.runId, occurredAt: verifiedAt, evidence: { receiptSha256: proof.receiptSha256 } } }] } };
    await t.test("ordinary writes keep the recovery contract; altered schemas, pairs and configuration require full checks", async () => {
      assert.equal(policy.evaluateDeploy(value).mode, "short");
      await clients.core.query("BEGIN; UPDATE gp.probe SET value=8 WHERE id=1");
      assert.deepEqual(await identity(), original); assert.equal(policy.evaluateDeploy({ ...value, identity: await identity() }).mode, "short");
      await clients.core.query("ALTER TABLE gp.probe ADD COLUMN changed text");
      assert.equal(policy.evaluateDeploy({ ...value, identity: await identity() }).mode, "full");
      await clients.core.query("ROLLBACK"); assert.deepEqual(await identity(), original);
      assert.equal(policy.evaluateDeploy({ ...value, identity: { ...original, databaseIdentitySha256: hash("different pair") } }).mode, "full");
      assert.equal(policy.evaluateDeploy({ ...value, configurationSha256: hash("different config") }).mode, "full");
    });
    await t.test("both fresh snapshot archives restore exactly and corrupted input is rejected", async () => {
      const execute = (tool, args, expected = 0) => {
        assert(["pg_dump", "pg_restore"].includes(tool));
        const result = spawnSync("/usr/lib/postgresql/18/bin/" + tool, args, { encoding: "utf8", timeout: 30000,
          env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PGHOST: config.host, PGPORT: String(config.port), PGUSER: config.user }, maxBuffer: 65536 });
        assert.equal(result.status === 0, expected === 0, tool + ": " + result.stderr); return result;
      };
      for (const domain of ["core", "sales"]) {
        const archive = path.join(config.root, domain + ".dump"), client = clients[domain];
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const snapshot = (await client.query("SELECT pg_export_snapshot() snapshot")).rows[0].snapshot;
        execute("pg_dump", ["--format=custom", "--snapshot=" + snapshot, "--file=" + archive, "accel_" + domain]);
        await client.query("COMMIT"); const archiveHash = hash(fs.readFileSync(archive));
        await admin.query('CREATE DATABASE "restored_' + domain + '"');
        execute("pg_restore", ["--exit-on-error", "--dbname=restored_" + domain, archive]);
        const restored = new Client({ host: config.host, port: config.port, user: config.user, database: "restored_" + domain }); await restored.connect();
        try { await restored.query("SET search_path=pg_catalog,gp");
          assert.deepEqual((await restored.query("SELECT * FROM gp.probe")).rows, [{ id: 1, value: 7 }]);
          assert.equal(await schemaFingerprint(restored, ["gp"]), await schemaFingerprint(client, ["gp"]));
        } finally { await restored.end(); }
        assert.equal(hash(fs.readFileSync(archive)), archiveHash);
        const corrupt = path.join(config.root, domain + ".corrupt.dump"); fs.writeFileSync(corrupt, "invalid PostgreSQL archive");
        execute("pg_restore", ["--list", corrupt], 1); assert.equal(hash(fs.readFileSync(archive)), archiveHash);
      }
    });
  } finally {
    for (const client of Object.values(clients)) { try { await client.query("ROLLBACK"); } finally { await client.end(); } }
    await admin.end();
  }
});

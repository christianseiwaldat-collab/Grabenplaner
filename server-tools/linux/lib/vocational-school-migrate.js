"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const R = require("../../../lib/persistence/postgresql/operations/runtime");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

async function main(args = process.argv.slice(2)) {
  const [expectedManifest, lease] = args, app = "/opt/grabenplaner/app";
  if (process.platform !== "linux" || process.getuid() !== 0 || args.length !== 2
    || !/^[a-f0-9]{64}$/.test(expectedManifest || "") || lease !== "--maintenance-lock-held"
    || fs.realpathSync(path.resolve(__dirname, "../../..")) !== app) {
    throw new Error("PG_VOCATIONAL_SCHOOL_MIGRATION_INSTALLED_SCOPE");
  }
  if (fs.realpathSync("/proc/self/fd/9") !== "/run/grabenplaner/maintenance.lock"
    || require("node:child_process").spawnSync("/usr/bin/flock", ["--nonblock", "9"], {
      stdio: Array.from({ length: 10 }, (_, index) => index === 9 ? 9 : "ignore"),
    }).status !== 0) throw new Error("PG_VOCATIONAL_SCHOOL_MIGRATION_LEASE");

  // Explicit release operation after the installed package swap, while its
  // existing lease is held, before starting the app. App startup performs no DDL.
  const manifestBytes = fs.readFileSync(app + "/grabenplaner-server-manifest.json");
  if (hash(manifestBytes) !== expectedManifest) throw new Error("PG_VOCATIONAL_SCHOOL_MIGRATION_MANIFEST");
  const manifest = JSON.parse(manifestBytes);
  require("./deploy-policy").applicationContract(app);
  for (const relative of [
    "server-tools/linux/lib/vocational-school-migrate.js",
    "lib/persistence/postgresql/core/vocational-school.js",
    "lib/persistence/postgresql/core/catalog.js",
    "lib/persistence/postgresql/boundary/migrate.js",
    "lib/persistence/sqlite/planning-settings-catalog.js",
    "lib/persistence/statements/planning-settings.js",
  ]) {
    const entry = manifest.files.find(file => file.path === relative);
    if (!entry || hash(fs.readFileSync(app + "/" + relative)) !== entry.sha256) {
      throw new Error("PG_VOCATIONAL_SCHOOL_MIGRATION_SOURCE");
    }
  }
  // The Core catalog pins the frozen baseline plus exactly reviewed statement
  // revisions. Reject any other SQL/contract drift before opening a connection.
  require("../../../lib/persistence/postgresql/core/catalog").createCoreCatalog();

  const config = R.loadConfiguration("/etc/grabenplaner/postgresql-operations.json");
  const backup = await R.latestBackup(config, { short: true, maximumAgeHours: 1 });
  const before = await R.inspectPair(config), domain = config.domains.find(item => item.domain === "core");
  const client = new (require("pg").Client)(R.url(config, domain));
  let result;
  try {
    await client.connect();
    await client.query("SET lock_timeout='5s';SET statement_timeout='30s'");
    result = await require("../../../lib/persistence/postgresql/core/vocational-school").migrate(client, { binding: config.binding });
  } finally { await client.end(); }
  const after = await R.inspectPair(config);
  if (before.sales.schemaSha256 !== after.sales.schemaSha256 || before.core.database !== after.core.database) {
    throw new Error("PG_VOCATIONAL_SCHOOL_MIGRATION_DOMAIN_DRIFT");
  }
  return { verified: true, appVersion: manifest.appVersion, sourceCommit: manifest.sourceCommit,
    ...result, backup, coreBefore: before.core.schemaSha256, coreAfter: after.core.schemaSha256, salesUnchanged: true };
}

if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + "\n"))
  .catch(error => { process.stderr.write(JSON.stringify({ failed: true,
    code: /^PG_/.test(error.message) ? error.message : error.code || "PG_VOCATIONAL_SCHOOL_MIGRATION_FAILED" }) + "\n"); process.exitCode = 1; });
module.exports = { main };

"use strict";

// Administrative CLI only. SQL text and parameter values are never returned,
// and the application accounts cannot connect to the maintenance database.
const APP = "/opt/grabenplaner/app";
const CONFIG = "/etc/grabenplaner/postgresql-operations.json";

async function main() {
  const action = process.argv[2];
  if (process.platform !== "linux" || process.getuid() !== 0 || process.argv.length !== 3
      || !["inspect", "install", "capture"].includes(action)) throw new Error("PG_SQL_STATS_ROOT_REQUIRED");
  const R = require(APP + "/lib/persistence/postgresql/operations/runtime");
  const S = require(APP + "/lib/persistence/postgresql/operations/sql-runtime-statistics");
  const { Client } = require(APP + "/node_modules/pg");
  const config = R.loadConfiguration(CONFIG);
  require(APP + "/server-tools/linux/postgresql/managed-contract").verifyInstalled(APP);
  const purpose = action === "capture" ? "monitor" : "administrator";
  const client = new Client({ ...R.url(config, null, purpose), application_name: "gp-protected-sql-runtime-statistics" });
  try {
    await client.connect();
    await client.query("SET statement_timeout='5s'; SET lock_timeout='500ms'; SET idle_in_transaction_session_timeout='15s'");
    const identity = (await client.query("SELECT system_identifier::text AS id FROM pg_control_system()")).rows[0];
    if (identity?.id !== config.clusterId) throw new Error("PG_SQL_STATS_CLUSTER_IDENTITY");
    const endpoint = (await client.query("SELECT current_database() AS database,current_setting('port') AS port,current_setting('data_directory') AS directory")).rows[0];
    if (endpoint?.database !== "postgres" || endpoint.port !== "55486"
        || endpoint.directory !== "/var/lib/grabenplaner-postgresql/data/cluster") throw new Error("PG_SQL_STATS_ENDPOINT");
    if (action === "install") return await S.install(client);
    await client.query("BEGIN READ ONLY");
    const result = action === "inspect" ? await S.inspect(client)
      : await S.capture(client, { databases: config.domains.map(domain => domain.database) });
    await client.query("ROLLBACK");
    return result;
  } finally { await client.end(); }
}

if (require.main === module) main().then(value => process.stdout.write(JSON.stringify(value) + "\n")).catch(() => {
  // Native error messages may contain SQL or protected configuration details.
  process.stderr.write("PG_SQL_STATS_OPERATION_FAILED\n");
  process.exitCode = 1;
});

module.exports = { main };

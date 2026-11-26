"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { Client, Pool } = require("pg");

// Recovery operations require their private Unix socket. Never use test or
// production connection URLs for these fixtures.
function recoveryCluster(test) {
  const enabled = process.env.GP_DEPLOY_OWNED_NATIVE_TEST === "1";
  const options = { skip: !enabled };
  if (!enabled) return { options };

  const port = 55484;
  const user = "gp_fixture_admin";
  let root, data, admin, nextDatabase = 0;
  const connection = database => ({
    host: root, port, user, database, password: "", ssl: false,
    connectionTimeoutMillis: 3000, statement_timeout: 15000,
  });
  function tool(name, args, expectedStatus = 0) {
    const binary = "/usr/lib/postgresql/18/bin/" + name;
    const stat = fs.lstatSync(binary);
    assert.ok(stat.isFile() && stat.uid === 0 && !(stat.mode & 0o022));
    const run = spawnSync(binary, args, {
      cwd: root, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC" },
      encoding: "utf8", timeout: 60000,
    });
    if (run.error) throw run.error;
    assert.equal(run.status, expectedStatus, name + "\n" + run.stdout + run.stderr);
  }

  test.before(async () => {
    assert.equal(process.platform, "linux");
    assert.ok(process.getuid() > 0);
    root = fs.mkdtempSync("/tmp/gp-pg-recovery-");
    fs.chmodSync(root, 0o700);
    data = path.join(root, "data");
    tool("initdb", ["-D", data, "-U", user, "--auth-local=trust", "--auth-host=reject", "--encoding=UTF8", "--locale=C.UTF-8"]);
    fs.appendFileSync(path.join(data, "postgresql.conf"),
      "\nlisten_addresses=''\nport=55484\nunix_socket_directories='" + root + "'\nshared_buffers='16MB'\n");
    tool("pg_ctl", ["-D", data, "-l", path.join(root, "postgresql.log"), "-w", "-t", "30", "start"]);
    admin = new Client(connection("postgres"));
    await admin.connect();
    assert.deepEqual((await admin.query("SELECT current_setting('unix_socket_directories') AS socket,current_setting('listen_addresses') AS listen,current_setting('data_directory') AS data")).rows,
      [{ socket: root, listen: "", data }]);
    await admin.query("CREATE ROLE gp_sales_owner; CREATE ROLE gp_sales_app; CREATE ROLE gp_sales_reader");
  });

  test.after(async () => {
    if (!root) return;
    try { await admin?.end(); }
    finally {
      if (fs.existsSync(path.join(data, "postmaster.pid"))) {
        tool("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"]);
        tool("pg_ctl", ["-D", data, "status"], 3);
      }
      assert.equal(fs.realpathSync(root), root);
      assert.equal(path.dirname(root), "/tmp");
      assert.match(path.basename(root), /^gp-pg-recovery-[A-Za-z0-9]+$/);
      assert.equal(fs.statSync(root).uid, process.getuid());
      fs.rmSync(root, { recursive: true });
    }
  });

  async function database(t) {
    const name = "synthetic_" + ++nextDatabase;
    await admin.query("CREATE DATABASE " + name);
    const client = new Client(connection(name));
    const pools = [];
    t.after(async () => {
      try {
        await Promise.all(pools.map(pool => pool.end()));
        await client.end();
      } finally { await admin.query("DROP DATABASE " + name + " WITH (FORCE)"); }
    });
    await client.connect();
    return { client, pool() {
      const pool = new Pool({ ...connection(name), max: 2 });
      pools.push(pool);
      return pool;
    } };
  }

  async function sales(t) {
    const { createSalesSchemaPlan } = require("../lib/persistence/postgresql/sales/schema");
    const { createSalesCatalog } = require("../lib/persistence/postgresql/sales/catalog");
    const { createPostgresqlPersistenceProvider } = require("../lib/persistence/postgresql/provider");
    const { client, pool } = await database(t);
    await client.query("GRANT CREATE ON DATABASE " + client.database + " TO gp_sales_owner");
    await client.query("CREATE SCHEMA gp AUTHORIZATION gp_sales_owner; SET ROLE gp_sales_owner; SET search_path=pg_catalog,gp,kassa");
    for (const statement of createSalesSchemaPlan(5).statements) await client.query(statement.sql);
    await client.query("RESET ROLE");
    const access = createPostgresqlPersistenceProvider({
      pool: pool(), catalog: createSalesCatalog(5).entries,
      prepareClient: connection => connection.query("SET search_path=pg_catalog,gp,kassa,integration,trade,reporting"),
    });
    return { client, access };
  }

  return { database, options, sales };
}

module.exports = { recoveryCluster };

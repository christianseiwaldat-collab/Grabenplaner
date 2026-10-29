"use strict";

// A fresh socket-only cluster for schema/repository qualification. This does
// not exercise the production updater, systemd, HTTP, or a code rollback.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const crypto = require("node:crypto"), { Module } = require("node:module");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");
const REPO = path.resolve(__dirname, "../.."), BIN = "/usr/lib/postgresql/18/bin";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const INSPECTOR_SHA = "f89627774a3580fea93a22a30910d3034296251da30c1b92728029aee5054064";
const DEPENDENCIES_SHA = "2afd6587681740d340039db0e128dadf52b2886d9359b6585980a7d7d7e9a70b";
const FROZEN_DEPENDENCIES_SHA = "08bbee3052f95192586063b527e25d9817bd9d47162d2c8d24d3344c5f05042c";

function originalInspector(document = require("./f0d-core-inspector.json"),
  frozen = require("./f0d-core-inspector-frozen-dependencies.json")) {
  if (document.format !== "gp-f0d-core-schema-inspector-original-v1"
    || document.sourceCommit !== "f0d71104bbe4926930662a20bf0660744fbcc0e5"
    || document.installedManifestSha256 !== "61fc69f3fd40257674d01dfe277531895e7cac94503f430167c320b94bc79682"
    || document.inspector?.path !== "lib/persistence/postgresql/boundary/migrate.js"
    || document.inspector.sha256 !== INSPECTOR_SHA || document.sharedDependencies?.length !== 163) {
    throw Error("PASSKEY_TRANSITION_OLD_SOURCE");
  }
  const source = Buffer.from(document.inspector.sourceBase64, "base64"), names = new Set();
  if (hash(source) !== INSPECTOR_SHA || source.length !== document.inspector.bytes) throw Error("PASSKEY_TRANSITION_OLD_SOURCE");
  if (hash(JSON.stringify(document.sharedDependencies)) !== DEPENDENCIES_SHA) throw Error("PASSKEY_TRANSITION_OLD_DEPENDENCY");
  // These five genuine f0d blobs diverged when the current CAS extension was
  // added. Never relabel the current bytes as historical dependencies.
  if (hash(JSON.stringify(frozen)) !== FROZEN_DEPENDENCIES_SHA
    || frozen.format !== "gp-f0d-core-inspector-frozen-dependencies-v1"
    || frozen.sourceCommit !== document.sourceCommit || frozen.sharedDependenciesSha256 !== DEPENDENCIES_SHA
    || !Array.isArray(frozen.files) || frozen.files.length !== 5
    || !Array.isArray(frozen.readOnlyData) || frozen.readOnlyData.length !== 1) throw Error("PASSKEY_TRANSITION_OLD_DEPENDENCY");
  const retained = new Map(), originals = new Map();
  for (const item of frozen.files) {
    const pinned = document.sharedDependencies.find(entry => entry.path === item.path);
    const bytes = Buffer.from(item.sourceBase64, "base64");
    if (!pinned || retained.has(item.path) || item.gitLfSha256 !== pinned.gitLfSha256
      || !/^[a-f0-9]{40}$/.test(item.gitBlob || "") || bytes.length !== item.bytes
      || bytes.toString("base64") !== item.sourceBase64 || hash(bytes) !== pinned.gitLfSha256) {
      throw Error("PASSKEY_TRANSITION_OLD_DEPENDENCY");
    }
    retained.set(item.path, bytes);
  }
  for (const item of document.sharedDependencies) {
    if (typeof item.path !== "string" || !/^(?:lib|public)\/[a-zA-Z0-9_./-]+$/.test(item.path)
      || item.path.split("/").some(part => ["", ".", ".."].includes(part)) || names.has(item.path)
      || !/^[a-f0-9]{64}$/.test(item.gitLfSha256 || "")) throw Error("PASSKEY_TRANSITION_OLD_DEPENDENCY");
    names.add(item.path);
    // Snapshot unchanged shared sources only after their full original hash
    // matches. An independent loader below cannot reuse a current module cache.
    const bytes = retained.get(item.path)
      || Buffer.from(fs.readFileSync(path.join(REPO, item.path), "utf8").replace(/\r\n/g, "\n"));
    if (hash(bytes) !== item.gitLfSha256) {
      throw Error("PASSKEY_TRANSITION_OLD_DEPENDENCY");
    }
    originals.set(item.path, bytes);
  }
  // The original schema plan also reads this SQL file directly through fs.
  // Preserve that exact historical data input, without opening an FS fallback.
  const data = frozen.readOnlyData[0];
  if (data.path !== "lib/persistence/postgresql/core/compatibility.sql"
    || !/^[a-f0-9]{64}$/.test(data.gitLfSha256 || "") || !/^[a-f0-9]{40}$/.test(data.gitBlob || "")) {
    throw Error("PASSKEY_TRANSITION_OLD_DEPENDENCY");
  }
  const dataBytes = Buffer.from(fs.readFileSync(path.join(REPO, data.path), "utf8").replace(/\r\n/g, "\n"));
  if (dataBytes.length !== data.bytes || hash(dataBytes) !== data.gitLfSha256) throw Error("PASSKEY_TRANSITION_OLD_DEPENDENCY");
  originals.set(data.path, dataBytes);
  originals.set(document.inspector.path, source);
  const cache = new Map(), builtins = new Set(["node:async_hooks", "node:crypto", "node:path"]);
  const relative = filename => path.relative(REPO, path.resolve(filename)).replaceAll("\\", "/");
  const frozenFs = Object.freeze({ readFileSync(filename, encoding) {
    const bytes = originals.get(relative(filename));
    if (!bytes || ![undefined, "utf8", "utf-8"].includes(encoding)) throw Error("PASSKEY_TRANSITION_OLD_DEPENDENCY");
    return encoding ? bytes.toString("utf8") : Buffer.from(bytes);
  } });
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const bytes = originals.get(name);
    if (!bytes) throw Error("PASSKEY_TRANSITION_OLD_DEPENDENCY");
    const filename = path.join(REPO, name), instance = new Module(filename, module);
    instance.filename = filename; instance.paths = [];
    cache.set(name, instance);
    if (name.endsWith(".json")) instance.exports = JSON.parse(bytes.toString("utf8"));
    else if (name.endsWith(".js")) {
      instance.require = request => {
        if (request === "node:fs") return frozenFs;
        if (builtins.has(request)) return require(request);
        if (typeof request !== "string" || !request.startsWith(".")) throw Error("PASSKEY_TRANSITION_OLD_DEPENDENCY");
        const target = relative(path.resolve(path.dirname(filename), request));
        const dependency = [target, target + ".js", target + ".json", target + "/index.js"].find(item => originals.has(item));
        if (!dependency) throw Error("PASSKEY_TRANSITION_OLD_DEPENDENCY");
        return load(dependency);
      };
      instance._compile(bytes.toString("utf8"), filename);
    } else throw Error("PASSKEY_TRANSITION_OLD_DEPENDENCY");
    return instance.exports;
  }
  return load(document.inspector.path);
}

async function withIsolatedCore(work) {
  if (process.env.GP_PASSKEYS_COMPATIBILITY_NATIVE !== "isolated-clone-v1"
    || process.platform !== "linux" || process.getuid() === 0) throw Error("PASSKEY_TRANSITION_NATIVE_SCOPE");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gp-passkey-restore-native-"));
  fs.chmodSync(root, 0o700);
  const guard = require("./passkeys-private-restore-clone").privateRestoreClone(root);
  const data = path.join(root, "cluster"), socket = path.join(root, "socket");
  fs.mkdirSync(socket, { mode: 0o700 });
  const marker = crypto.randomUUID(), markerFile = path.join(root, "transition-owner.json");
  fs.writeFileSync(markerFile, JSON.stringify({ marker, pid: process.pid, purpose: "isolated-passkeys-transition-v1" }), { flag: "wx", mode: 0o600 });
  const clients = new Set(), phase = name => console.log(JSON.stringify({ fixture: "isolated-passkeys-transition-v1", phase: name }));
  let clusterId, connected, primaryError;
  function tool(name, args) {
    if (!["initdb", "pg_ctl"].includes(name)) throw Error("PASSKEY_TRANSITION_TOOL");
    const executable = path.join(BIN, name), info = fs.lstatSync(executable);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)
      || fs.realpathSync(executable) !== executable) throw Error("PASSKEY_TRANSITION_TOOL");
    const result = spawnSync(executable, args, { cwd: root, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      encoding: "utf8", timeout: 60000, maxBuffer: 256 * 1024 });
    fs.writeFileSync(path.join(root, name + "-" + crypto.randomUUID() + ".log"), String(result.stdout || "") + String(result.stderr || ""), { flag: "wx", mode: 0o600 });
    if (result.error || result.signal || result.status !== 0) throw Error("PASSKEY_TRANSITION_NATIVE_TOOL_FAILED:" + name);
  }
  async function connect(user, database = "gp_migration_core") {
    // There is no TCP listener and no URL/environment fallback to any existing
    // service. Every connection uses this exact private socket directory.
    const client = new Client({ host: socket, port: 55491, database, user, connectionTimeoutMillis: 5000, query_timeout: 35000 });
    await client.connect(); clients.add(client); return client;
  }
  async function assertOwned(expectedDatabases = ["gp_migration_core", "postgres"]) {
    const stamp = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    if (stamp.marker !== marker || stamp.pid !== process.pid || !guard.bind()) throw Error("PASSKEY_TRANSITION_OWNER");
    const rows = (await connected.query("SELECT system_identifier::text AS id FROM pg_control_system()")).rows;
    if (rows.length !== 1 || rows[0].id !== clusterId
      || (await connected.query("SHOW port")).rows[0].port !== "55491"
      || (await connected.query("SHOW data_directory")).rows[0].data_directory !== data
      || (await connected.query("SHOW listen_addresses")).rows[0].listen_addresses !== ""
      || (await connected.query("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname")).rows.map(row => row.datname).join(",") !== expectedDatabases.join(",")) {
      throw Error("PASSKEY_TRANSITION_CLUSTER");
    }
  }
  function emergencyStop() {
    try { console.log(JSON.stringify({ fixture: "isolated-passkeys-transition-v1", emergencyCleanup: guard.stopAndVerify() })); }
    catch (error) { console.error("PASSKEY_TRANSITION_CLEANUP_FAILED:" + error.message); process.exitCode = 1; }
  }
  const terminated = () => { emergencyStop(); process.removeListener("exit", emergencyStop); process.exit(143); };
  process.once("exit", emergencyStop); process.once("SIGTERM", terminated);
  try {
    originalInspector();
    tool("initdb", ["-D", data, "-U", "postgres", "--auth-local=trust", "--auth-host=reject", "--encoding=UTF8", "--locale=C.UTF-8"]);
    fs.appendFileSync(path.join(data, "postgresql.conf"), "\nlisten_addresses=''\nport=55491\nunix_socket_directories='" + socket + "'\nmax_connections=20\nmax_locks_per_transaction=256\nshared_buffers='32MB'\nlog_statement='none'\nlog_min_error_statement=panic\n");
    tool("pg_ctl", ["-D", data, "-l", path.join(root, "postgresql.log"), "-w", "start"]); guard.bind();
    connected = await connect("postgres", "postgres");
    clusterId = (await connected.query("SELECT system_identifier::text AS id FROM pg_control_system()")).rows[0].id;
    if (!/^[1-9][0-9]{15,24}$/.test(clusterId)) throw Error("PASSKEY_TRANSITION_CLUSTER");
    await assertOwned(["postgres"]);
    if ((await connected.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'gp_%'")).rowCount) throw Error("PASSKEY_TRANSITION_CLUSTER");
    await connected.query("CREATE ROLE gp_core_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    for (const purpose of ["migrator", "app", "reader"]) {
      await connected.query("CREATE ROLE gp_core_" + purpose + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    }
    await connected.query("GRANT gp_core_owner TO gp_core_migrator");
    // CREATE DATABASE cannot share an implicit transaction with another query.
    await connected.query("CREATE DATABASE gp_migration_core OWNER gp_core_owner TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C.UTF-8'");
    await assertOwned();
    const admin = await connect("postgres");
    await admin.query("REVOKE ALL ON DATABASE gp_migration_core FROM PUBLIC;GRANT CONNECT ON DATABASE gp_migration_core TO gp_core_migrator,gp_core_app,gp_core_reader;REVOKE CREATE ON SCHEMA public FROM PUBLIC;CREATE SCHEMA gp AUTHORIZATION gp_core_owner");
    const owner = await connect("gp_core_migrator");
    await owner.query("SET ROLE gp_core_owner;CREATE TABLE gp.environment_contract(environment_id text PRIMARY KEY,domain text NOT NULL,profile text NOT NULL)");
    await owner.query("INSERT INTO gp.environment_contract VALUES($1,'core',$2)", [require("../../lib/persistence/postgresql/core/environment").ENVIRONMENT_ID, require("../../lib/persistence/postgresql/core/environment").PROFILE]);
    await owner.query("GRANT USAGE ON SCHEMA gp TO gp_core_app,gp_core_reader;GRANT SELECT ON gp.environment_contract TO gp_core_app,gp_core_reader;RESET ROLE;SET search_path=pg_catalog,gp;SET statement_timeout='30s';SET lock_timeout='5s'");
    await assertOwned();
    await require("../../lib/persistence/postgresql/core/migrate").migrateCoreDevelopment(owner);
    await require("../../lib/persistence/postgresql/boundary/migrate").migrateBoundaryCore(owner);
    for (const name of ["trade-annotations", "personnel-learning-runs", "xoffi-snapshots", "vocational-school", "session-security"]) {
      await require("../../lib/persistence/postgresql/core/" + name).migrate(owner);
    }
    phase("fresh-pre-passkeys-schema-ready");
    return await work({ root, socket, data, clusterId, owner, admin, connect, assertOwned, phase, originalInspector });
  } catch (error) { primaryError = error; throw error; }
  finally {
    const ended = await Promise.allSettled([...clients].map(client => client.end()));
    let cleanup;
    try { cleanup = guard.stopAndVerify(); }
    finally { process.removeListener("exit", emergencyStop); process.removeListener("SIGTERM", terminated); }
    console.log(JSON.stringify({ fixture: "isolated-passkeys-transition-v1", clusterId, cleanup }));
    if (!primaryError && ended.some(result => result.status === "rejected")) throw Error("PASSKEY_TRANSITION_CLIENT_CLEANUP");
    // Preserve this synthetic directory for failure diagnostics; CI/its owned
    // disposable VM retires the surrounding workspace after evidence capture.
  }
}

module.exports = { originalInspector, withIsolatedCore };

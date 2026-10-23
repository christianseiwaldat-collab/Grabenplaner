"use strict";

// Loaded only by the explicit Linux test command. This adapter changes fixture
// setup/assertion access, never the application's repositories or transactions.
const path = require("node:path"), Module = require("node:module");
const { isMainThread, Worker, MessageChannel, receiveMessageOnPort } = require("node:worker_threads");
const { assertSyntheticEnvironment } = require("./guard");
const root = path.resolve(__dirname, "../..");
const manifest = require("./manifest.json");

function install() {
  if (process.env.GP_PG_API_FIXTURE_BRIDGE !== "1") return;
  // The outer --test launcher is not a fixture owner. Node's test subprocess
  // has NODE_TEST_CONTEXT; explicitly spawned application children have the
  // separately verified paired owner marker instead.
  if (!process.env.NODE_TEST_CONTEXT && !process.env.GP_PG_API_FIXTURE_CHILD_OWNER) return;
  const file = process.argv.find(value => value.endsWith(".test.js"));
  const relative = file ? path.relative(root, path.resolve(file)).replaceAll("\\", "/") : process.env.GP_PG_API_FIXTURE_TEST_FILE || "";
  if (!manifest.files.includes(relative)) return;
  assertSyntheticEnvironment();
  if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";
  let worker, port, signal, serial = 0, subject, opened = false, fixturePath, ownerMarker;
  const applicationHandles = new Set();

  function rpc(operation, options = {}) {
    Atomics.store(signal, 0, 0);
    const id = ++serial; port.postMessage({ id, operation, ...options });
    const state = Atomics.wait(signal, 0, 0, 120000);
    if (state === "timed-out") throw new Error("PG_API_FIXTURE_WORKER_TIMEOUT: " + operation);
    const message = receiveMessageOnPort(port)?.message;
    if (!message || message.id !== id) throw new Error("PG_API_FIXTURE_WORKER_PROTOCOL");
    if (message.error) throw Object.assign(new Error(message.error.message), { code: message.error.code, fixtureStack: message.error.stack });
    return message.result;
  }

  function open() {
    if (opened) return;
    assertSyntheticEnvironment();
    const channel = new MessageChannel(); port = channel.port1;
    signal = new Int32Array(new SharedArrayBuffer(4));
    worker = new Worker(path.join(__dirname, "worker.js"), { workerData: { port: channel.port2, signal: signal.buffer }, transferList: [channel.port2] });
    worker.unref(); port.unref();
    let ownership;
    try { ownership = rpc("initialize", { expectedMarker: process.env.GP_PG_API_FIXTURE_CHILD_OWNER || undefined }); }
    catch (error) { void worker.terminate(); throw error; }
    ownerMarker = ownership.marker; opened = true;
    fixturePath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : "";
    const configuration = require("../../lib/persistence/configuration");
    configuration.resolvePersistenceConfiguration = () => Object.freeze({
      providerId: "postgresql", databasePath: fixturePath || path.join(process.env.GRABENPLANER_DATA_DIR, "core.postgresql"),
      databaseUrlConfigured: true, coreUrl: process.env.GP_CORE_APP_URL, salesUrl: process.env.GP_SALES_APP_URL,
      readers: Object.freeze({ coreUrl: process.env.GP_CORE_READER_URL, salesUrl: process.env.GP_SALES_READER_URL }),
      rehearsal: true, productActivation: false,
    });
    process.env.DB_PROVIDER = "postgresql";
    // Match the historical synthetic demo, using PostgreSQL writes. No schema
    // creation, driver substitution or SQLite application execution occurs.
    if (!ownership.adopted) require("../../lib/persistence/sqlite/operations/application-seeding")
      .createSqliteApplicationSeedingOperations(database(false)).seedDemoIfRequested({
        enabled: process.env.GRABENPLANER_SEED_DEMO === "1", demoProfile: process.env.GRABENPLANER_DEMO_PROFILE || "",
        appVersion: require("../../package.json").version,
        planningDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map(day => [day, day]),
        sporthandelProfilePath: path.join(root, "demo-profiles/sporthandel.json"),
      });
  }

  function restoreBuffers(value) {
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (Array.isArray(value)) return value.map(restoreBuffers);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restoreBuffers(entry)]));
    return value;
  }

  function database(primary, { readOnly = false } = {}) {
    return Object.freeze({
      postgresqlTestFixture: true,
      exec(sql) { if (readOnly) throw new Error("PG_API_FIXTURE_READ_ONLY"); open(); return rpc("exec", { sql }); },
      prepare(sql) {
        const statement = {
          all(...values) { open(); return restoreBuffers(rpc("all", { sql, values, readOnly }).rows); },
          get(...values) { return statement.all(...values)[0]; },
          run(...values) { if (readOnly) throw new Error("PG_API_FIXTURE_READ_ONLY"); open(); const result = rpc("run", { sql, values }); return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }; },
          setAllowBareNamedParameters() { return statement; },
          setReadBigInts() { return statement; },
        };
        return statement;
      },
      close() {
        if (!primary || !opened) return;
        void subject?.closePersistenceForTests();
        for (const handle of applicationHandles) void handle.provider.close();
        rpc("close"); opened = false; void worker.terminate();
      },
    });
  }

  const raw = database(true), load = Module._load;
  module.exports.databaseForCurrentTest = (filename, options = {}) => {
    open();
    if (filename && path.resolve(filename) !== fixturePath) throw new Error("PG_API_FIXTURE_INDEPENDENT_DATABASE_REQUIRED");
    return database(false, options);
  };
  module.exports.closeCurrentTestFixture = () => {
    if (subject) throw new Error("PG_API_FIXTURE_CLOSE_CURRENT_APPLICATION_FIRST");
    raw.close();
  };
  // Node children launched by a whitelisted integration test keep its explicit
  // synthetic ownership. Other commands and unrelated tests are unaffected.
  const childProcess = require("node:child_process");
  const preloadOption = "--require=" + JSON.stringify(__filename);
  for (const name of ["spawn", "spawnSync"]) {
    const original = childProcess[name];
    childProcess[name] = function(command, args = [], options = {}) {
      if (path.resolve(String(command)) !== path.resolve(process.execPath)) return original.call(this, command, args, options);
      open();
      const environment = { ...process.env, ...(options.env || {}), GP_PG_API_FIXTURE_TEST_FILE: relative,
        GP_PG_API_FIXTURE_CHILD_OWNER: ownerMarker };
      if (!args.includes("--test")) delete environment.NODE_TEST_CONTEXT;
      environment.NODE_OPTIONS = (environment.NODE_OPTIONS || "") + " " + preloadOption;
      return original.call(this, command, args, { ...options, env: environment });
    };
  }
  if (file) require("node:test").before(async () => { if (subject) await subject.initializeApplicationPersistence(); });
  let providerPatched = false;
  let sqliteModule;
  Module._load = function(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved === path.join(root, "server.js")) {
      open();
      const exported = load.call(this, request, parent, isMain);
      exported.db = raw; subject = exported;
      return exported;
    }
    const exported = load.call(this, request, parent, isMain);
    if (request === "node:sqlite") {
      if (!sqliteModule) sqliteModule = { ...exported, DatabaseSync: class DatabaseSync {
        constructor(filename, options) {
          if (filename && filename !== ":memory:" && process.env.DB_PATH && path.resolve(filename) === path.resolve(process.env.DB_PATH)) {
            open(); return database(false, options);
          }
          return new exported.DatabaseSync(filename, options);
        }
      } };
      return sqliteModule;
    }
    if (resolved === path.join(root, "lib/persistence/sqlite/provider.js") && !providerPatched) {
      providerPatched = true;
      const originalOpen = exported.openSqliteApplicationPersistence, originalLegacy = exported.openSqliteLegacyDatabase;
      const originalCreate = exported.createSqlitePersistenceProvider;
      const matching = filename => filename && filename !== ":memory:" && process.env.DB_PATH
        && path.resolve(filename) === path.resolve(process.env.DB_PATH);
      function application(options = {}) {
        open();
        const app = require("../../lib/persistence/postgresql/application").openDeferredPostgresqlApplication({
          coreUrl: process.env.GP_CORE_APP_URL, salesUrl: process.env.GP_SALES_APP_URL,
          readers: { coreUrl: process.env.GP_CORE_READER_URL, salesUrl: process.env.GP_SALES_READER_URL }, authorize: async () => true,
        });
        applicationHandles.add(app); return { database: database(false), provider: app.provider, close: () => app.provider.close() };
      }
      exported.openSqliteApplicationPersistence = options => matching(options?.databasePath) ? application(options) : originalOpen(options);
      exported.openSqliteLegacyDatabase = (filename, ...args) => matching(filename) ? (open(), database(false)) : originalLegacy(filename, ...args);
      exported.createSqlitePersistenceProvider = options => options?.database?.postgresqlTestFixture ? application(options).provider : originalCreate(options);
    }
    return exported;
  };
  process.on("exit", () => { if (opened) { rpc("close"); opened = false; } });
}

if (isMainThread) install();

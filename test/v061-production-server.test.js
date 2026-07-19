"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  createBoundedRateLimitStore,
  parseBackupKeep,
  parseServerPort,
  runtimeValidationErrors,
} = require("../lib/server-runtime");

function productionConfiguration(overrides = {}) {
  return {
    operationMode: "server",
    host: "127.0.0.1",
    port: 3000,
    trustProxy: "loopback",
    deploymentKind: "production",
    nodeEnvironment: "production",
    backupKeep: 30,
    databasePath: path.resolve("test-runtime", "dienstplan.db"),
    dataRoot: path.resolve("test-runtime"),
    seedDemo: "",
    demoProfile: "",
    forcePortal: "",
    allowUnscannedAmu: "",
    testAmuScanner: "",
    bootstrapToken: "",
    ...overrides,
  };
}

test("v0.61: produktive Serverkonfiguration ist strikt und testbare Sondermodi bleiben begrenzt", () => {
  assert.deepEqual(runtimeValidationErrors(productionConfiguration()), []);
  assert.deepEqual(runtimeValidationErrors(productionConfiguration({
    deploymentKind: "codespaces-test",
    nodeEnvironment: "test",
    seedDemo: "1",
    demoProfile: "sporthandel",
  })), []);
  assert.deepEqual(runtimeValidationErrors(productionConfiguration({
    deploymentKind: "local",
    nodeEnvironment: "test",
  })), []);

  const invalidConfigurations = [
    [{ host: "0.0.0.0" }, /HOST.*127\.0\.0\.1/i],
    [{ trustProxy: "true" }, /TRUST_PROXY.*loopback/i],
    [{ port: Number.NaN }, /PORT.*1.*65535/i],
    [{ backupKeep: 0 }, /BACKUP_KEEP.*1.*1000/i],
    [{ nodeEnvironment: "test" }, /NODE_ENV.*production/i],
    [{ deploymentKind: "local" }, /DEPLOYMENT_KIND.*production/i],
    [{ deploymentKind: "codespaces-test" }, /Codespaces-Testbetrieb.*NODE_ENV=test/i],
    [{ seedDemo: "1" }, /Demo-Daten/i],
    [{ demoProfile: "sporthandel" }, /Demo-Profile/i],
    [{ forcePortal: "1" }, /FORCE_PORTAL/i],
    [{ allowUnscannedAmu: "1" }, /Ungeprüfte AUM-Uploads/i],
    [{ testAmuScanner: "clean" }, /AUM-Testscanner/i],
    [{ databasePath: ":memory:" }, /DB_PATH.*lokale absolute SQLite-Datei/i],
    [{ databasePath: "\\\\server\\share\\dienstplan.db" }, /DB_PATH.*Netzwerkpfade/i],
    [{ dataRoot: "\\\\server\\share\\grabenplaner" }, /DATA_DIR.*Netzwerkpfade/i],
  ];
  for (const [override, expected] of invalidConfigurations) {
    assert.match(runtimeValidationErrors(productionConfiguration(override)).join(" "), expected);
  }
});

test("v0.72: produktiver Loopback-Bootstrap verlangt einen einmaligen Schluessel", () => {
  assert.deepEqual(runtimeValidationErrors(productionConfiguration({
    operationMode: "local",
    bootstrapToken: "b".repeat(48),
  })), []);
  assert.match(runtimeValidationErrors(productionConfiguration({
    operationMode: "local",
    bootstrapToken: "zu-kurz",
  })).join(" "), /BOOTSTRAP_TOKEN.*32 Zeichen/i);
});

test("v0.61: Port und Backup-Aufbewahrung werden ohne stille Teilwerte gelesen", () => {
  assert.equal(parseServerPort("443"), 443);
  assert.equal(Number.isNaN(parseServerPort("3000abc")), true);
  assert.equal(Number.isNaN(parseServerPort("0")), true);
  assert.equal(parseBackupKeep(undefined), 30);
  assert.equal(parseBackupKeep("45"), 45);
  assert.equal(Number.isNaN(parseBackupKeep("30.5")), true);
  assert.equal(Number.isNaN(parseBackupKeep("1001")), true);
});

test("v0.61: Login-Ratenzähler verwerfen abgelaufene Einträge und bleiben größenbegrenzt", () => {
  const store = createBoundedRateLimitStore({ windowMs: 1000, maxKeys: 3, maxEventsPerKey: 2 });
  store.record("a", 1000);
  store.record("a", 1100);
  store.record("a", 1200);
  assert.deepEqual(store.get("a", 1200), [1100, 1200]);

  store.record("b", 1200);
  store.record("c", 1200);
  store.record("d", 1200);
  assert.equal(store.size, 3);
  assert.deepEqual(store.get("a", 1200), []);

  store.prune(2301);
  assert.equal(store.size, 0);
});

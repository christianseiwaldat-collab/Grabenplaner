"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { assertCompatibility, compareSemver, readEnvironment } = require("../server-tools/linux/recovery/lib/recovery-verify.js");

test("v0.74 compares stable and prerelease app versions without allowing a newer recovery source", () => {
  assert.equal(compareSemver("0.74.0-beta", "0.74.0-beta"), 0);
  assert.equal(compareSemver("0.73.9", "0.74.0-beta"), -1);
  assert.equal(compareSemver("0.74.0-beta", "0.74.0"), -1);
  assert.equal(compareSemver("0.75.0-beta", "0.74.0"), 1);
  assert.throws(() => compareSemver("latest", "0.74.0"));
});

test("v0.74 compatibility rejects newer runtime schemas and newer database migrations", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, app_version TEXT NOT NULL)");
    database.prepare("INSERT INTO schema_migrations (id, app_version) VALUES (?, ?)").run("old", "0.73.0-beta");
    const runtime = { format: "grabenplaner-linux-runtime-contract", schemaVersion: 1, deploymentSchemaVersion: 1 };
    const compatible = assertCompatibility(database, { version: "0.73.0-beta" }, { version: "0.74.0-beta" }, runtime, runtime);
    assert.equal(compatible.targetVersion, "0.74.0-beta");
    assert.throws(() => assertCompatibility(database, { version: "0.75.0-beta" }, { version: "0.74.0-beta" }, runtime, runtime));
    assert.throws(() => assertCompatibility(database, { version: "0.73.0-beta" }, { version: "0.74.0-beta" }, { ...runtime, deploymentSchemaVersion: 2 }, runtime));
    database.prepare("INSERT INTO schema_migrations (id, app_version) VALUES (?, ?)").run("future", "0.80.0-beta");
    assert.throws(() => assertCompatibility(database, { version: "0.73.0-beta" }, { version: "0.74.0-beta" }, runtime, runtime));
  } finally { database.close(); }
});

test("v0.74 reads recovery keys without evaluating shell content and rejects duplicate values", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-recovery-env-"));
  const environment = path.join(temporary, "grabenplaner.env");
  try {
    fs.writeFileSync(environment, "GRABENPLANER_AMU_KEY_ID=server-v1\nGRABENPLANER_AMU_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nUNRELATED=$(touch /tmp/must-not-run)\n");
    const values = readEnvironment(environment);
    assert.equal(values.get("UNRELATED"), "$(touch /tmp/must-not-run)");
    fs.writeFileSync(environment, "GRABENPLANER_AMU_KEY_ID=a\nGRABENPLANER_AMU_KEY_ID=b\n");
    assert.throws(() => readEnvironment(environment), /doppelte/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

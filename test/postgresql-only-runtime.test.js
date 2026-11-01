"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const root = path.resolve(__dirname, "..");

function startup(environment, expectedMessageKey) {
  const script = `
    const Module = require('node:module'), load = Module._load;
    Module._load = function(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent, isMain);
      if (request === 'node:sqlite' || /[/\\\\]persistence[/\\\\]sqlite[/\\\\]/.test(resolved)) {
        throw new Error('FORBIDDEN_SQLITE_RUNTIME_IMPORT');
      }
      return load.call(this, request, parent, isMain);
    };
    try { require('./server'); process.exitCode = 1; }
    catch (error) {
      if (error.code !== 'PERSISTENCE_CONFIGURATION_INVALID'
          || error.messageKey !== ${JSON.stringify(expectedMessageKey)}) {
        console.error(error.code || error.message); process.exitCode = 2;
      } else process.stdout.write('CONFIGURATION_REJECTED_WITHOUT_SQLITE');
    }
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: root, encoding: "utf8", timeout: 60000,
    env: { ...process.env, DB_PROVIDER: "", DB_PATH: "", DATABASE_URL: "",
      GRABENPLANER_POSTGRESQL_APPLICATION_CONFIG: "", GRABENPLANER_POSTGRESQL_REHEARSAL: "",
      ...environment },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "CONFIGURATION_REJECTED_WITHOUT_SQLITE");
}

test("unconfigured PostgreSQL-only startup loads no SQLite module and writes no data", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-pg-only-startup-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  startup({ GRABENPLANER_DATA_DIR: directory }, "postgresql-configuration-required");
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("explicit SQLite startup cannot modify an old backup or create fallback files", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gp-pg-only-legacy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = path.join(directory, "old.db");
  const bytes = Buffer.concat([Buffer.from("SQLite format 3\0"), crypto.randomBytes(4096)]);
  fs.writeFileSync(database, bytes, { mode: 0o600 });
  startup({ DB_PROVIDER: "sqlite", DB_PATH: database, GRABENPLANER_DATA_DIR: directory }, "provider-id-invalid");
  assert.deepEqual(fs.readFileSync(database), bytes);
  assert.deepEqual(fs.readdirSync(directory), ["old.db"]);
});

test("document receipts remain byte compatible after extracting the engine-neutral hash", () => {
  const current = require("../lib/personnel-document-event-receipt");
  const historical = require("../lib/persistence/sqlite/operations/personnel-document-history-schema");
  for (const row of [
    {}, { id: "event", document_id: "document", sequence_number: 2, event_type: "version_added",
      previous_receipt_sha256: "a".repeat(64), actor_employee_number: "synthetic", created_at: "2026-10-23T12:00:00Z" },
    { id: "event", documentId: "document", sequenceNumber: 2, eventType: "version_added",
      previousReceiptSha256: "a".repeat(64), actorEmployeeNumber: "synthetic", createdAt: "2026-10-23T12:00:00Z" },
  ]) assert.equal(current.eventReceiptSha256(row), historical.eventReceiptSha256(row));
});

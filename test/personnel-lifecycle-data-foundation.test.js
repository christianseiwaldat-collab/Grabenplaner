"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAmuStorage } = require("../lib/amu-storage");
const {
  createPersonnelLifecycleRepository,
} = require("../lib/persistence/repositories/personnel-lifecycle");
const {
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/contract");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  PERSONNEL_LIFECYCLE_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_PROFILE_PHOTO_CATEGORY_MIGRATION_ID,
  PERSONNEL_LIFECYCLE_TABLE_DEFINITIONS,
  PERSONNEL_LIFECYCLE_TABLE_NAMES,
  PERSONNEL_LIFECYCLE_TRIGGER_DEFINITIONS,
  PERSONNEL_LIFECYCLE_TRIGGER_NAMES,
  inspectSqlitePersonnelLifecycleSchema,
} = require("../lib/persistence/sqlite/operations/personnel-lifecycle-schema");
const {
  SQLITE_PERSONNEL_LIFECYCLE_CATALOG,
} = require("../lib/persistence/sqlite/personnel-lifecycle-catalog");
const {
  PERSONNEL_LIFECYCLE_STATEMENTS,
} = require("../lib/persistence/statements/personnel-lifecycle");
const {
  createPersonnelLifecycleService,
  normalizeApplication,
} = require("../lib/personnel-lifecycle");
const { canonicalSha256 } = require("../lib/work-rules/receipt");


function normalizeTriggerSql(sql) {
  return String(sql || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .replace(/^create trigger if not exists /i, "create trigger ")
    .toLowerCase();
}

function normalizeTableSql(sql) {
  return String(sql || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .replace(/^create table if not exists /i, "create table ")
    .toLowerCase();
}


test("Personalmodul-Datenfundament: Dokumentmutationen lesen ihr Ergebnis vor dem Commit", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "lib", "personnel-lifecycle.js"),
    "utf8",
  );
  const registerDocument = source.slice(
    source.indexOf("  async function registerDocument("),
    source.indexOf("  async function candidatePhotoFile("),
  );
  const addDocumentVersion = source.slice(
    source.indexOf("  async function addDocumentVersion("),
    source.indexOf("  async function listCandidates("),
  );

  assert.match(registerDocument, /registeredDocument = await serializeDocument\([\s\S]*transactionRepository\.getDocument/);
  assert.match(registerDocument, /\}, \{ isolation: "serializable" \}\);\s*return registeredDocument;/);
  assert.match(addDocumentVersion, /versionedDocument = await serializeDocument\([\s\S]*transactionRepository\.getDocument/);
  assert.match(addDocumentVersion, /\}, \{ isolation: "serializable" \}\);\s*return versionedDocument;/);
  assert.doesNotMatch(registerDocument, /return await repository\.getDocument/);
  assert.doesNotMatch(addDocumentVersion, /return await repository\.getDocument/);
});

test("Personalmodul-Datenfundament: jedes typisierte Statement besitzt genau eine SQLite-Bindung", () => {
  const statements = Object.values(PERSONNEL_LIFECYCLE_STATEMENTS);
  assert.equal(statements.length, 23);
  assert.equal(SQLITE_PERSONNEL_LIFECYCLE_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_PERSONNEL_LIFECYCLE_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_PERSONNEL_LIFECYCLE_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

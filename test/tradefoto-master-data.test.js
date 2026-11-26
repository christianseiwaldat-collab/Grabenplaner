"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../lib/data-import-contract");
const M = require("../lib/tradefoto-master-profiles");
const { createDataImportEngine } = require("../lib/data-import-engine");
const { createDataImportProtection } = require("../lib/data-import-protection");
const { createDataImportRepository } = require("../lib/persistence/repositories/data-import");
const { createImportMasterWriters, createImportMasterService } = require("../lib/persistence/repositories/import-master-data");
const { ensureSqliteDataImportSchema } = require("../lib/persistence/sqlite/operations/data-import-schema");
const { ensureSqliteImportMasterSchema, IMPORT_MASTER_SCHEMA_SQL } = require("../lib/persistence/sqlite/operations/import-master-schema");
const { ensureSqliteCrmSchema } = require("../lib/persistence/sqlite/operations/crm-schema");
const { ensureSqliteSalesArticleCatalogSchema } = require("../lib/persistence/sqlite/operations/sales-article-catalog-schema");
const { SQLITE_DATA_IMPORT_CATALOG } = require("../lib/persistence/sqlite/data-import-catalog");
const { SQLITE_IMPORT_MASTER_CATALOG } = require("../lib/persistence/sqlite/import-master-catalog");
const { SQLITE_CRM_CUSTOMERS_CATALOG } = require("../lib/persistence/sqlite/crm-customers-catalog");
const { SQLITE_SALES_ARTICLE_CATALOG } = require("../lib/persistence/sqlite/sales-article-catalog-catalog");
const { IMPORT_MASTER_STATEMENTS: S } = require("../lib/persistence/statements/import-master-data");
const { CRM_CUSTOMER_STATEMENTS: CS } = require("../lib/persistence/statements/crm-customers");
const { compilePostgresqlDialectEntry } = require("../lib/persistence/postgresql/dialect-compiler");
const { createSalesArticleCatalogRepository } = require("../lib/persistence/repositories/sales-article-catalog");
const { salesArticleImportContentSha256 } = require("../lib/sales-article-catalog");
const { TRADEFOTO_ARTICLE_SOURCE_SYSTEM } = require("../lib/tradefoto-article-source-profile");
const SHA = "a".repeat(64), TIME = "2026-09-05T11:00:00.000Z";
const errorCode = code => error => error?.code === code;
const raw = (name, extra = {}) => Object.assign(Object.fromEntries(M.tableFor(name).columns.map(field => [field.name, null])), extra);
const customer = (extra = {}) => raw("KUNDEN", { KUND_NR: "000419", VORNAME: "Synthetisch", NACHNAME: "Testkunde", EMail: "synthetic@example.test", ...extra });
const decision = { customerType: "private" };

test("Block 3: complete pinned master profiles cover 66 tables / 761 fields and exclude both credential fields", () => {
  const metadata = M.TRADEFOTO_MASTER_METADATA;
  assert.equal(metadata.coverage.tables, 66); assert.equal(metadata.coverage.fields, 761);
  assert.equal(M.TRADEFOTO_MASTER_PROFILES.length, 66);
  assert.equal(M.TRADEFOTO_MASTER_PROFILES.reduce((n, p) => n + p.excludedFields.length, 0), 2);
  for (const table of metadata.tables) {
    const profile = M.profileFor(table.name);
    assert.equal(profile.fields.filter(f => !f.source.startsWith("_source_")).length + profile.excludedFields.length, table.columns.length);
    assert.ok(Object.isFrozen(profile));
  }
  assert.deepEqual(M.profileFor("LIEFERANTEN").keyFields, ["Suchname"]);
  assert.deepEqual(M.profileFor("Kunden_Bemerkungen").keyFields, ["_source_snapshot_sha256", "_source_row"]);
});

test("Block 3: reader boundary keeps civil components / zeros / exact decimals and never copies passwords", () => {
  const row = M.prepareTradeFotoMasterRow("KUNDEN", customer({ Kennwort: "NEVER", Geburtstag: new Date("2000-02-29T00:00:00.000Z"), Punkte: 1e-7 }));
  assert.equal(row.Geburtstag, "2000-02-29T00:00:00.000"); assert.equal(row.KUND_NR, "000419"); assert.equal(row.Punkte, "0.0000001");
  assert.ok(!JSON.stringify(row).includes("NEVER"));
  const normalized = C.normalizeDataImportRow(M.profileFor("KUNDEN"), row); assert.ok(normalized.key.includes("000419"));
  assert.throws(() => M.prepareTradeFotoMasterRow("KUNDEN", customer({ KUND_NR: Number.MAX_SAFE_INTEGER + 1 })), errorCode("IMPORT_IDENTIFIER_PRECISION"));
  assert.throws(() => M.prepareTradeFotoMasterRow("KUNDEN", { ...customer(), extra: 1 }), errorCode("IMPORT_SHAPE_INVALID"));
  assert.throws(() => C.normalizeDataImportRow(M.profileFor("KUNDEN"), { ...row, Geburtstag: "2000-02-30T00:00:00.000" }));
  assert.throws(() => C.normalizeDataImportRow(M.profileFor("KUNDEN"), { ...row, Geburtstag: "2000-02-29T00:00:00.000Z" }));
});

test("Master statements compile portably; central source apply is explicit and Core mapping stays disabled", () => {
  assert.equal(SQLITE_IMPORT_MASTER_CATALOG.length, Object.keys(S).length);
  for (const entry of SQLITE_IMPORT_MASTER_CATALOG) assert.equal(compilePostgresqlDialectEntry(entry).strategy, "portable-generated", entry.statement.id);
  assert.ok(!/AUTOINCREMENT|PRAGMA|GLOB|json_|rowid|RAISE\(/iu.test(IMPORT_MASTER_SCHEMA_SQL));
  const catalog=require('../lib/persistence/sqlite/application-catalog').SQLITE_APPLICATION_CATALOG;
  assert.ok(SQLITE_IMPORT_MASTER_CATALOG.every(e=>catalog.some(c=>c.statement===e.statement)));
  const serverSource=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  assert.match(serverSource,/createDataImportRuntime\(\{[^}]*allowApply: true[^}]*sharedPayloads: true/);
  assert.match(serverSource,/createDataImportMappingRuntime\(\{[^}]*allowMapping: false/);
});

"use strict";
const { exact, integer, sha, text, fail, fingerprint } = require("./data-import-contract");

// Diagnostic only: an aggregate catalog is not an authenticated source upload.
// Actual business adapters must independently read/hash/validate original bytes.
function inspectTradeFotoImportInventory(catalog) {
  if (!catalog || catalog.format !== "grabenplaner.tradefoto.full-inventory.v1" || !Array.isArray(catalog.sources) || catalog.sources.length !== 2) fail("IMPORT_INVENTORY_INVALID");
  const roles = new Set(), sources = [], gates = new Set(["BUSINESS_ADAPTERS_PENDING"]);
  if (catalog.sourceHashesVerifiedAfterRead !== true) gates.add("SOURCE_HASH_CHECK_MISSING");
  for (const source of catalog.sources) {
    if (!["trade", "cash"].includes(source.id) || roles.has(source.id)) fail("IMPORT_INVENTORY_INVALID");
    roles.add(source.id); sha(source.sha256); sha(source.schemaSha256); integer(source.bytes, 1, 1024 * 1024 * 1024);
    if (!Array.isArray(source.tables) || !source.tables.length || source.tables.length > 256 || !Array.isArray(source.linkedTables)) fail("IMPORT_INVENTORY_INVALID");
    const names = new Set(), tables = [];
    for (const table of source.tables) {
      text(table.name); if (names.has(table.name)) fail("IMPORT_INVENTORY_INVALID"); names.add(table.name);
      integer(table.declaredRows); integer(table.scannedRows);
      if (!Array.isArray(table.columns) || !table.columns.length || table.columns.length > 256) fail("IMPORT_INVENTORY_INVALID");
      const columns = new Set();
      for (const column of table.columns) {
        text(column.name); text(column.type); if (columns.has(column.name)) fail("IMPORT_INVENTORY_INVALID"); columns.add(column.name);
        if (!column.destination?.handling || !column.destination?.target) gates.add("SOURCE_FIELD_UNCLASSIFIED");
      }
      if (table.scannedRows !== table.declaredRows) gates.add("SOURCE_ROW_COUNT_MISMATCH");
      tables.push({ name: table.name, declaredRows: table.declaredRows, scannedRows: table.scannedRows, fields: table.columns.length, rowCountMatches: table.scannedRows === table.declaredRows });
    }
    const schema = source.tables.map(table => ({ name: table.name, columns: table.columns.map(({ destination, profile, ...definition }) => definition) }));
    // Inventory v1 uses ordinary JSON order, not the canonical import-profile hash.
    const crypto = require("node:crypto");
    if (crypto.createHash("sha256").update(JSON.stringify(schema)).digest("hex") !== source.schemaSha256) gates.add("SOURCE_SCHEMA_FINGERPRINT_MISMATCH");
    for (const linked of source.linkedTables) if (!(source.id === "cash" && linked === "ARTIKEL_STAMM")) gates.add("UNRESOLVED_LINKED_SOURCE");
    sources.push({ id: source.id, fileSha256: source.sha256, schemaSha256: source.schemaSha256, bytes: source.bytes, tables, linkedTables: [...source.linkedTables] });
  }
  exact(catalog.coverage, ["tables", "fields", "rowsScanned", "unclassifiedFields"]);
  const coverage = { tables: sources.reduce((n, source) => n + source.tables.length, 0), fields: sources.reduce((n, source) => n + source.tables.reduce((m, table) => m + table.fields, 0), 0), rowsScanned: sources.reduce((n, source) => n + source.tables.reduce((m, table) => m + table.scannedRows, 0), 0) };
  for (const [key, value] of Object.entries(coverage)) if (catalog.coverage[key] !== value) gates.add("SOURCE_COVERAGE_MISMATCH");
  if (catalog.coverage.unclassifiedFields !== 0) gates.add("SOURCE_FIELD_UNCLASSIFIED");
  return { contractVersion: 1, mode: "inventory_diagnostic_only", canImport: false, catalogFingerprint: fingerprint(sources), sources, coverage, gates: [...gates].sort() };
}
module.exports = { inspectTradeFotoImportInventory };

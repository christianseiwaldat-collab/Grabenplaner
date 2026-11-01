"use strict";

// Current-server schema assertions read PostgreSQL's own catalogs. Historical
// SQLite migration programs are tested separately against the immutable source.
const assert = require("node:assert/strict");
const { createSchemaPlan } = require("../../lib/persistence/postgresql/core/schema");
const layout = require("../../lib/persistence/postgresql/sales/layout");
const salesTables = new Map(layout.stageTables(8).map(table => [table.name, table]));
function physicalTable(name) {
  if (salesTables.has(name)) return { ...salesTables.get(name), domain: "sales" };
  return { name: name === "sales_article_revisions" ? "article_reference_snapshots" : name, schema: "gp", domain: "core" };
}
function catalog(db, domain = "core") {
  assert.equal(db.postgresqlTestFixture, true, "schema assertions require the current PostgreSQL fixture");
  return { prepare(sql) { return {
    all(...values) { return db.postgresqlCatalogQuery(domain, sql, values); },
    get(...values) { return db.postgresqlCatalogQuery(domain, sql, values)[0]; },
  }; } };
}

function tableNames(db) {
  return ["core", "sales"].flatMap(domain => catalog(db, domain).prepare(
    "SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname IN ('gp','kassa','integration','trade','reporting') ORDER BY schemaname,tablename",
  ).all());
}
function tableExists(db, name) {
  const physical = physicalTable(name);
  return Boolean(catalog(db, physical.domain).prepare("SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = ? AND tablename = ?").get(physical.schema, physical.name));
}
function columns(db, table) {
  const physical = physicalTable(table);
  return catalog(db, physical.domain).prepare(`SELECT column_name AS name, data_type AS type,
    CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull,
    column_default AS dflt_value, ordinal_position - 1 AS cid
    FROM information_schema.columns
    WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`).all(physical.schema, physical.name);
}
function indexes(db, table) {
  const physical = physicalTable(table);
  return catalog(db, physical.domain).prepare(`SELECT indexname AS name, indexdef AS sql
    FROM pg_catalog.pg_indexes WHERE schemaname = ? AND tablename = ?
    ORDER BY indexname`).all(physical.schema, physical.name);
}
function triggers(db, table) {
  const physical = physicalTable(table);
  return catalog(db, physical.domain).prepare(`SELECT t.tgname AS name, n.nspname AS schema, r.relname AS "table", pg_catalog.pg_get_functiondef(t.tgfoid) AS sql,
    pg_catalog.pg_get_triggerdef(t.oid) AS definition
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class r ON r.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = ? AND r.relname = ? AND NOT t.tgisinternal
    ORDER BY t.tgname`).all(physical.schema, physical.name);
}
function triggerByName(db, name, { domain = "core" } = {}) {
  return catalog(db, domain).prepare(`SELECT t.tgname AS name, n.nspname AS schema, r.relname AS "table", pg_catalog.pg_get_functiondef(t.tgfoid) AS sql,
    pg_catalog.pg_get_triggerdef(t.oid) AS definition
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class r ON r.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname IN ('gp','kassa','integration','trade','reporting') AND t.tgname = ? AND NOT t.tgisinternal`).get(name);
}
function foreignKeys(db, table) {
  const physical = physicalTable(table);
  return catalog(db, physical.domain).prepare(`SELECT c.conname AS name, target.relname AS "table",
    origin_column.attname AS "from", target_column.attname AS "to",
    CASE c.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
      WHEN 'r' THEN 'RESTRICT' WHEN 'd' THEN 'SET DEFAULT' ELSE 'NO ACTION' END AS on_delete,
    CASE c.confupdtype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
      WHEN 'r' THEN 'RESTRICT' WHEN 'd' THEN 'SET DEFAULT' ELSE 'NO ACTION' END AS on_update
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class origin ON origin.oid = c.conrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = origin.relnamespace
    JOIN pg_catalog.pg_class target ON target.oid = c.confrelid
    JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY key_columns(origin_id, target_id, position) ON true
    JOIN pg_catalog.pg_attribute origin_column ON origin_column.attrelid = origin.oid AND origin_column.attnum = key_columns.origin_id
    JOIN pg_catalog.pg_attribute target_column ON target_column.attrelid = target.oid AND target_column.attnum = key_columns.target_id
    WHERE c.contype = 'f' AND ns.nspname = ? AND origin.relname = ?
    ORDER BY c.conname, key_columns.position`).all(physical.schema, physical.name);
}
function assertCoreSchemaLedger(db) {
  const plan = createSchemaPlan();
  const rows = catalog(db).prepare("SELECT version,source_sha256,plan_sha256,target_sha256 FROM gp.core_migration_history").all();
  assert.equal(rows.length, 1, "exactly one canonical PostgreSQL core-schema receipt");
  assert.equal(rows[0].version, 1);
  assert.equal(rows[0].source_sha256, plan.sourceSchemaSha256);
  assert.equal(rows[0].plan_sha256, plan.digest);
  assert.match(rows[0].target_sha256, /^[a-f0-9]{64}$/);
  return rows[0];
}

function foreignKeyViolations(db) {
  const constraints = catalog(db).prepare(`SELECT c.conname AS name, c.convalidated AS validated,
    source.relname AS source_table, target.relname AS target_table,
    array_agg(source_column.attname::text ORDER BY keys.position) AS source_columns,
    array_agg(target_column.attname::text ORDER BY keys.position) AS target_columns
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class source ON source.oid = c.conrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = source.relnamespace
    JOIN pg_catalog.pg_class target ON target.oid = c.confrelid
    JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target.relnamespace
    JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY keys(source_id, target_id, position) ON true
    JOIN pg_catalog.pg_attribute source_column ON source_column.attrelid = source.oid AND source_column.attnum = keys.source_id
    JOIN pg_catalog.pg_attribute target_column ON target_column.attrelid = target.oid AND target_column.attnum = keys.target_id
    WHERE c.contype = 'f' AND ns.nspname = 'gp' AND target_ns.nspname = 'gp'
    GROUP BY c.conname, c.convalidated, source.relname, target.relname ORDER BY c.conname`).all();
  const quote = value => '"' + value.replaceAll('"', '""') + '"';
  const violations = [];
  for (const c of constraints) {
    if (!c.validated) violations.push({ constraint: c.name, reason: "unvalidated" });
    const present = c.source_columns.map(name => `source.${quote(name)} IS NOT NULL`).join(" AND ");
    const equal = c.source_columns.map((name, index) => `target.${quote(c.target_columns[index])} = source.${quote(name)}`).join(" AND ");
    const { count } = catalog(db).prepare(`SELECT COUNT(*) AS count FROM gp.${quote(c.source_table)} source
      WHERE ${present} AND NOT EXISTS (SELECT 1 FROM gp.${quote(c.target_table)} target WHERE ${equal})`).get();
    if (count) violations.push({ constraint: c.name, rows: count });
  }
  return violations;
}

module.exports = { assertCoreSchemaLedger, columns, foreignKeys, foreignKeyViolations, indexes, tableExists, tableNames, triggerByName, triggers };

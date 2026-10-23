"use strict";

const { workerData } = require("node:worker_threads");
const crypto = require("node:crypto");
const { Client } = require("pg");
const { assertSyntheticEnvironment } = require("./guard");
const { splitStatements, translate } = require("./sql");
const { isTechnicalRelation } = require("./ownership");
const { verifyEnvironment } = require("../../lib/persistence/postgresql/core/environment");

const port = workerData.port, signal = new Int32Array(workerData.signal);
const clients = {}, catalogClients = {}, dataTables = {};
const connected = new Set();
let marker = "synthetic-api-" + crypto.randomUUID();
let initialized = false, closed = false, ownsData = false;
const q = name => '"' + name.replaceAll('"', '""') + '"';
const owner = domain => "gp_" + domain + "_owner";

async function initialize(expectedMarker) {
  assertSyntheticEnvironment();
  try {
    if (process.env.GP_CI_POSTGRESQL_FIXTURE === "owned-local-service-v1") {
      const expected = require("../postgresql-migration/owned-local-fixture").readOwnedLocalFixtureMarker();
      const admin = new Client({ connectionString: process.env.TEST_POSTGRESQL_URL });
      await admin.connect();
      try {
        if ((await admin.query("SELECT system_identifier::text AS id FROM pg_control_system()")).rows[0].id !== expected.clusterId) {
          throw new Error("PG_API_FIXTURE_CLUSTER_IDENTITY_CHANGED");
        }
      } finally { await admin.end(); }
    }
    for (const domain of ["core", "sales"]) {
      const client = new Client({ connectionString: process.env[`GP_${domain.toUpperCase()}_MIGRATOR_URL`] });
      clients[domain] = client; await client.connect(); connected.add(domain); await verifyEnvironment(client, { domain, purpose: "migrator" });
      if (!expectedMarker) await client.query("SELECT pg_advisory_lock(9261261)");
      const tables = (await client.query("SELECT schemaname,tablename FROM pg_tables WHERE tableowner=$1 AND schemaname IN ('gp','kassa','integration','trade','reporting') ORDER BY schemaname,tablename", [owner(domain)])).rows;
      dataTables[domain] = tables.filter(t => !isTechnicalRelation(domain, t.schemaname, t.tablename))
        .map(t => q(t.schemaname) + "." + q(t.tablename));
      if (!dataTables[domain].length) throw new Error("PG_API_FIXTURE_SCHEMA_REQUIRED");
      if (!expectedMarker) {
        const occupied = (await client.query(dataTables[domain].map(table => "SELECT EXISTS(SELECT 1 FROM " + table + ") occupied").join(" UNION ALL "))).rows;
        if (occupied.some(row => row.occupied)) throw new Error("PG_API_FIXTURE_REFUSES_EXISTING_BUSINESS_DATA: " + domain);
      }
      await client.query("SET ROLE " + owner(domain));
      await client.query("SET search_path=pg_catalog,gp,kassa,integration,trade,reporting");
      if (domain === "sales") {
        const ledger = (await client.query("SELECT version,plan_sha256,base_target_sha256,target_sha256 FROM gp.import_delete_performance_history")).rows;
        if (ledger.length !== 1 || ledger[0].version !== 1
          || ledger[0].plan_sha256 !== require("../../lib/persistence/postgresql/sales/import-delete-performance").digest
          || !/^[a-f0-9]{64}$/.test(ledger[0].base_target_sha256) || !/^[a-f0-9]{64}$/.test(ledger[0].target_sha256)) {
          throw new Error("PG_API_FIXTURE_TECHNICAL_LEDGER_MISMATCH");
        }
      }
    }
    const salesOwner = (await clients.sales.query("SELECT id FROM gp.migration_fixture_owner")).rows;
    if (expectedMarker) {
      const coreOwner = (await clients.core.query("SELECT value AS id FROM gp.settings WHERE key='migration-test-owner'")).rows;
      if (!/^synthetic-api-[a-f0-9-]{36}$/.test(expectedMarker) || salesOwner.length !== 1 || coreOwner.length !== 1
        || salesOwner[0].id !== expectedMarker || coreOwner[0].id !== expectedMarker) throw new Error("PG_API_FIXTURE_CHILD_OWNERSHIP_REQUIRED");
      marker = expectedMarker; initialized = true;
      return { marker, adopted: true };
    }
    if (salesOwner.length) throw new Error("PG_API_FIXTURE_ALREADY_OWNED");
    await clients.sales.query("INSERT INTO gp.migration_fixture_owner(id) VALUES($1)", [marker]);
    await clients.core.query("INSERT INTO gp.settings(key,value) VALUES('migration-test-owner',$1)", [marker]);
    initialized = true; ownsData = true;
    await clients.core.query("INSERT INTO gp.cost_center_types(id,code,name,is_branch,builtin,sort_order,created_by,updated_by) VALUES('branch','branch','Filiale',1,1,10,'migration','migration'),('administration','administration','Verwaltung',0,1,20,'migration','migration'),('production','production','Produktion',0,1,30,'migration','migration'),('other','other','Sonstiges',0,1,90,'migration','migration')");
    await clients.core.query("INSERT INTO gp.positions(id,name,builtin,active,is_default,employment_classification,sort_order) VALUES('teamleitung','Teamleitung',0,1,0,'standard',1),('abteilungsleitung','Abteilungsleitung',0,1,0,'standard',2),('verkaufsmitarbeiter','Verkaufsmitarbeiter',0,1,1,'standard',3),('lehrling','Lehrling',0,1,0,'apprentice',4)");
    await clients.core.query("INSERT INTO gp.cost_center_type_positions(cost_center_type_id,position_id,sort_order) SELECT c.id,p.id,p.sort_order FROM gp.cost_center_types c CROSS JOIN gp.positions p");
    // Same deterministic administrative seed as the frozen pre-PostgreSQL
    // organization migration. Location-less synthetic actors must never fall
    // back to a branch cost center, whose real constraint requires a location.
    await clients.core.query("INSERT INTO gp.cost_centers(id,code,name,type,cost_center_type_id,active,sort_order,created_by,updated_by) VALUES('cc-administration','VERW','Verwaltung','administration','administration',1,10,'migration','migration')");
    await clients.core.query("INSERT INTO gp.cost_centers(id,code,name,type,cost_center_type_id,active,sort_order,created_by,updated_by) VALUES('cc-location-01','FIL01','Hauptstandort','branch','branch',1,100,'trigger','trigger')");
    // Exact six-day state produced by b2's defaultSettings and
    // legacyDaySettingsSnapshot before its organization migration creates 01.
    const defaultDays = Object.fromEntries([
      ["monday", "09:00", "18:00"], ["tuesday", "09:00", "18:00"],
      ["wednesday", "09:00", "18:00"], ["thursday", "09:00", "18:00"],
      ["friday", "09:00", "18:00"], ["saturday", "10:00", "17:00"],
    ].map(([day, start, end]) => [day, { open: true, start, end, lunchEnabled: false,
      lunchStart: "13:00", lunchEnd: "14:00", minStaff: 0, minFrom: start, minTo: end }]));
    await clients.core.query("INSERT INTO gp.locations(id,name,cost_center_id,day_settings_json,active) VALUES('01','Hauptstandort','cc-location-01',$1,1)", [JSON.stringify(defaultDays)]);
    return { marker };
  } catch (error) {
    await close().catch(() => {}); throw error;
  }
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  // SQLite raw fixture reads expose safe integers as JS numbers. Application
  // decoding is untouched and continues enforcing its explicit result contracts.
  if (typeof value === "string" && /^-?(?:0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  return value;
}

async function executeOne(sql, values, mode, catalogDomain, { readOnly = false } = {}) {
  if (catalogDomain !== undefined && !["core", "sales"].includes(catalogDomain)) throw new Error("PG_API_FIXTURE_CATALOG_DOMAIN");
  const translated = translate(sql, values, { postgresqlDomain: catalogDomain });
  let text = translated.sql;
  if (/^PRAGMA\b/i.test(text)) {
    if (/^PRAGMA\s+(?:foreign_keys|journal_mode|busy_timeout|wal_checkpoint|optimize|integrity_check|quick_check)\b/i.test(text)) return { rows: [], changes: 0 };
    throw new Error("PG_API_FIXTURE_SQLITE_PRAGMA_REQUIRES_MIGRATION");
  }
  if (/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(text)) {
    for (const client of Object.values(clients)) await client.query(text);
    return { rows: [], changes: 0 };
  }
  const client = (readOnly ? catalogClients : clients)[catalogDomain || translated.domain];
  let returning = false;
  if (mode === "run" && /^INSERT\b/i.test(text) && !/\bRETURNING\b/i.test(text) && translated.relations.length === 1) {
    const table = translated.relations[0];
    const columns = (await client.query("SELECT column_name,column_default,is_identity FROM information_schema.columns WHERE table_name=$1 AND table_schema IN ('gp','kassa','integration','trade','reporting') AND column_name='id'", [table])).rows;
    if (columns.length === 1 && (columns[0].is_identity === "YES" || /nextval/.test(columns[0].column_default || ""))) { text += " RETURNING id"; returning = true; }
  }
  const result = await client.query(text, translated.values.map(value => ArrayBuffer.isView(value) && !Buffer.isBuffer(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value));
  const aliases = new Map([...String(sql).matchAll(/\bAS\s+([A-Za-z_][A-Za-z_0-9]*)/gi)].map(match => [match[1].toLowerCase(), match[1]]));
  const rows = result.rows.map(row => Object.fromEntries(result.fields.map(field => {
    let value = row[field.name];
    if ([20, 21, 23, 26].includes(field.dataTypeID) && typeof value === "string" && Number.isSafeInteger(Number(value))) value = Number(value);
    if (field.dataTypeID === 16 && translated.legacyBusinessSql && typeof value === "boolean") value = value ? 1 : 0;
    return [aliases.get(field.name) || field.name, value];
  })));
  return { rows, changes: result.rowCount || 0, lastInsertRowid: returning ? normalize(rows[0]?.id) || 0 : 0 };
}

async function ensureCatalogClients() {
  // Catalog/assertion reads must not BEGIN/ROLLBACK on a seed transaction.
  // Separate connections enforce PostgreSQL READ ONLY without disturbing it.
  for (const domain of ["core", "sales"]) if (!catalogClients[domain]) {
    const client = new Client({ connectionString: process.env[`GP_${domain.toUpperCase()}_MIGRATOR_URL`] });
    await client.connect();
    try {
      await verifyEnvironment(client, { domain, purpose: "migrator" });
      await client.query("SET ROLE " + owner(domain));
      await client.query("SET search_path=pg_catalog,gp,kassa,integration,trade,reporting");
      catalogClients[domain] = client;
    } catch (error) { await client.end(); throw error; }
  }
}

async function close() {
  if (closed) return; closed = true;
  try {
    for (const client of Object.values(catalogClients)) await client.end();
    if (initialized && ownsData) {
      for (const domain of ["core", "sales"]) {
        const client = clients[domain]; await client.query("ROLLBACK");
        const rows = domain === "core"
          ? (await client.query("SELECT value AS id FROM gp.settings WHERE key='migration-test-owner'")).rows
          : (await client.query("SELECT id FROM gp.migration_fixture_owner")).rows;
        if (rows.length !== 1 || rows[0].id !== marker) throw new Error("PG_API_FIXTURE_CLEANUP_OWNERSHIP_LOST");
        await client.query("TRUNCATE " + dataTables[domain].join(",") + " RESTART IDENTITY CASCADE");
        if (domain === "sales") await client.query("DELETE FROM gp.migration_fixture_owner WHERE id=$1", [marker]);
      }
    }
  } finally {
    for (const [domain, client] of Object.entries(clients)) {
      if (connected.has(domain)) await client.query("SELECT pg_advisory_unlock(9261261)").catch(() => {});
      await client.end().catch(() => {});
    }
  }
}

port.on("message", async message => {
  try {
    let result;
    if (message.operation === "initialize") result = await initialize(message.expectedMarker);
    else if (message.operation === "close") result = await close();
    else if (!initialized || closed) throw new Error("PG_API_FIXTURE_NOT_OPEN");
    else if (message.operation === "exec") {
      for (const sql of splitStatements(message.sql)) result = await executeOne(sql, [], "run");
    } else if (message.readOnly) {
      await ensureCatalogClients();
      for (const client of Object.values(catalogClients)) await client.query("BEGIN READ ONLY");
      try { result = await executeOne(message.sql, message.values || [], message.operation, message.catalogDomain, { readOnly: true }); }
      finally { for (const client of Object.values(catalogClients)) await client.query("ROLLBACK"); }
    } else if (message.fixtureDdl) {
      const tokens = require("../../lib/persistence/postgresql/core/sql").tokens(message.sql);
      const fixtureSequence = /^(?:CREATE|DROP) SEQUENCE gp \. "test_attempt_[a-f0-9]{16}"$/.test(tokens.join(" "));
      if ((!/^(?:CREATE|DROP) (?:FUNCTION|TRIGGER)\b/i.test(tokens.join(" ")) && !fixtureSequence) || tokens.includes(";")) {
        throw new Error("PG_API_FIXTURE_DDL_KIND");
      }
      result = await executeOne(message.sql, [], "run", message.catalogDomain);
    } else result = await executeOne(message.sql, message.values || [], message.operation);
    port.postMessage({ id: message.id, result });
  } catch (error) {
    port.postMessage({ id: message.id, error: { message: error.message, code: error.code, stack: error.stack } });
  } finally { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); }
});

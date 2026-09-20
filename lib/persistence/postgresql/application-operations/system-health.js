"use strict";

// Catalog reads only: never scan or modify business rows for the system cards.
const CATALOG_SQL = `SELECT pg_database_size(current_database())::text AS bytes,
 (SELECT count(*)::integer FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
  WHERE n.nspname='gp' AND c.contype='f') AS foreign_keys,
 (SELECT count(*)::integer FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
  WHERE n.nspname='gp' AND c.contype='f' AND (NOT c.convalidated OR NOT EXISTS
   (SELECT 1 FROM pg_trigger t WHERE t.tgconstraint=c.oid AND t.tgisinternal) OR EXISTS
   (SELECT 1 FROM pg_trigger t WHERE t.tgconstraint=c.oid AND t.tgenabled NOT IN ('O','A')))) AS invalid_foreign_keys`;

async function readPostgresqlSystemHealth(configuration, dependencies = {}) {
  const { configuration: poolConfiguration, verifyEnvironment } = dependencies.environment || require('../core/environment');
  const Pool = dependencies.Pool || require('pg').Pool;
  const databases = {};
  for (const domain of ['core', 'sales']) {
    const options = { profile: configuration.profile, binding: configuration.binding,
      databaseUrl: configuration.readers[`${domain}Url`], domain, purpose: 'reader', tlsMode: 'disable-local-only' };
    const pool = new Pool(poolConfiguration(options));
    try {
      await verifyEnvironment(pool, options);
      const row = (await pool.query(CATALOG_SQL)).rows[0];
      const bytes = Number(row?.bytes);
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isInteger(row?.foreign_keys)
          || !Number.isInteger(row?.invalid_foreign_keys) || row.foreign_keys < 0
          || row.invalid_foreign_keys < 0 || row.invalid_foreign_keys > row.foreign_keys) throw new Error('PG_SYSTEM_HEALTH_INVALID');
      databases[domain] = { bytes, foreignKeys: row.foreign_keys,
        invalidForeignKeys: row.invalid_foreign_keys };
    } finally { await pool.end(); }
  }
  const databaseBytes = databases.core.bytes + databases.sales.bytes;
  if (!Number.isSafeInteger(databaseBytes)) throw new Error('PG_SYSTEM_HEALTH_INVALID');
  return { databaseBytes, databases, foreignKeys: databases.core.foreignKeys + databases.sales.foreignKeys === 0
    ? null : databases.core.invalidForeignKeys + databases.sales.invalidForeignKeys === 0 };
}

module.exports = { readPostgresqlSystemHealth, CATALOG_SQL };

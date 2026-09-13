"use strict";

const fs = require("node:fs");
const { Client } = require("pg");
const { PROFILE, ENVIRONMENT_ID } = require("../core/environment");
const runtimeBinding = require("../runtime-binding");
const FORMAT = "grabenplaner-postgresql-staging-v1";
const quote = value => '"' + value.replace(/"/g, '""') + '"';
const literal = value => "'" + value.replace(/'/g, "''") + "'";
const ACCOUNTS = ['gp_migration_admin', 'gp_operations_monitor',
  ...['core', 'sales'].flatMap(domain => ['app', 'reader', 'migrator'].map(purpose => `gp_${domain}_${purpose}`))];

function connection(config, domain, purpose = 'migrator', productive = false) {
  const name = domain ? `gp_${domain}_${purpose}` : 'gp_migration_admin';
  return { host: '127.0.0.1', port: 55486, database: domain
    ? `${productive ? 'grabenplaner' : 'gp_migration'}_${domain}` : 'postgres',
  user: name, password: config.accounts[name], connectionTimeoutMillis: 5000 };
}

function validateConfiguration(config) {
  if (config?.format !== FORMAT || config.host !== '127.0.0.1' || config.port !== 55486
      || !/^[1-9][0-9]{15,24}$/.test(config.clusterId || '')
      || Object.keys(config.accounts || {}).sort().join(',') !== [...ACCOUNTS].sort().join(',')
      || ACCOUNTS.some(name => !/^[a-f0-9]{64}$/.test(config.accounts[name]))) throw new Error('PG_STAGING_CONFIG');
  return config;
}

function assertOutputPath(outputPath) {
  const path = require('node:path');
  const directory = path.dirname(outputPath);
  const allowed = directory === '/home/gpadmin/grabenplaner-pg-migration-20260912/activation-12'
    || /^\/var\/lib\/grabenplaner-postgresql\/migration\/[a-f0-9-]{36}$/.test(directory);
  if (!allowed || path.basename(outputPath) !== 'transfer-verification.json'
      || fs.realpathSync(directory) !== directory || (fs.statSync(directory).mode & 0o077)
      || fs.readFileSync(directory + '/ownership-marker', 'utf8').trim() !== FORMAT) {
    throw new Error('PG_STAGING_OUTPUT_SCOPE');
  }
}

async function assertCluster(client, config, expectedDatabases) {
  const id = (await client.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
  if (id !== config.clusterId || (await client.query('SHOW port')).rows[0].port !== '55486') throw new Error('PG_STAGING_CLUSTER');
  const databases = (await client.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows.map(row => row.datname);
  if (databases.join(',') !== [...expectedDatabases].sort().join(',')) throw new Error('PG_STAGING_DATABASE_SET');
}

async function bootstrapPair(config) {
  validateConfiguration(config);
  const admin = new Client(connection(config));
  try {
    await admin.connect();
    await assertCluster(admin, config, ['postgres']);
    if ((await admin.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'gp_%' AND rolname<>'gp_migration_admin'")).rowCount) {
      throw new Error('PG_STAGING_EXISTING_ROLES');
    }
    await admin.query('REVOKE CONNECT ON DATABASE postgres,template1 FROM PUBLIC');
    await admin.query(`CREATE ROLE gp_operations_monitor LOGIN PASSWORD ${literal(config.accounts.gp_operations_monitor)}
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2`);
    await admin.query('GRANT pg_monitor TO gp_operations_monitor');
    for (const domain of ['core', 'sales']) {
      const owner = `gp_${domain}_owner`, database = `gp_migration_${domain}`;
      await admin.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      for (const purpose of ['migrator', 'app', 'reader']) {
        const role = `gp_${domain}_${purpose}`;
        const limit = purpose === 'migrator' ? 2 : purpose === 'reader' ? 8 : domain === 'core' ? 10 : 8;
        await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD ${literal(config.accounts[role])}
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${limit}`);
        await admin.query(`ALTER ROLE ${role} SET search_path TO pg_catalog`);
      }
      await admin.query(`GRANT ${owner} TO gp_${domain}_migrator`);
      await admin.query(`CREATE DATABASE ${database} OWNER ${owner}`);
      await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${database} TO gp_${domain}_app,gp_${domain}_reader,gp_${domain}_migrator,gp_operations_monitor`);
      const client = new Client(connection(config, domain));
      try {
        await client.connect();
        await client.query(`SET ROLE ${owner};REVOKE CREATE ON SCHEMA public FROM PUBLIC;CREATE SCHEMA gp AUTHORIZATION ${owner}`);
        await client.query('CREATE TABLE gp.environment_contract(environment_id text PRIMARY KEY,domain text NOT NULL,profile text NOT NULL)');
        await client.query('INSERT INTO gp.environment_contract VALUES($1,$2,$3)', [ENVIRONMENT_ID, domain, PROFILE]);
        await client.query(`GRANT USAGE ON SCHEMA gp TO gp_${domain}_app,gp_${domain}_reader`);
        await client.query(`GRANT SELECT ON gp.environment_contract TO gp_${domain}_app,gp_${domain}_reader`);
        await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA gp GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO gp_${domain}_app`);
        await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA gp GRANT SELECT ON TABLES TO gp_${domain}_reader`);
        await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA gp GRANT USAGE,SELECT ON SEQUENCES TO gp_${domain}_app`);
        await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA gp REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
        await client.query('RESET ROLE');
        if (domain === 'core') await require('../core/migrate').migrateCoreDevelopment(client);
        else for (const stage of [5, 6]) await require('../sales/migrate').migrateSalesDevelopment(client, stage);
      } finally { await client.end(); }
    }
    const core = new Client(connection(config, 'core')), sales = new Client(connection(config, 'sales'));
    try {
      await core.connect(); await sales.connect();
      await require('../boundary/migrate').migrateBoundaryCore(core);
      for (const stage of [7, 8]) await require('../sales/migrate').migrateSalesDevelopment(sales, stage);
    } finally { await core.end(); await sales.end(); }
    return { prepared: true, clusterId: config.clusterId, databaseCount: 2, productActivation: false };
  } finally { await admin.end(); }
}

async function assertTransferTarget(client, config, domain) {
  validateConfiguration(config);
  if ((await client.query('SELECT current_database() AS name')).rows[0].name !== `gp_migration_${domain}`) {
    throw new Error('PG_STAGING_TRANSFER_DATABASE');
  }
  // Only the bootstrap account can read system identity. The independent
  // privileged probe also rejects unrelated databases in this dedicated cluster.
  const admin = new Client(connection(config));
  try { await admin.connect(); await assertCluster(admin, config, ['postgres', 'gp_migration_core', 'gp_migration_sales']); }
  finally { await admin.end(); }
}

async function promotePair(config, { transferProof, binding }) {
  validateConfiguration(config); runtimeBinding.validateBinding(binding);
  if (binding.clusterId !== config.clusterId || transferProof?.verified !== true
      || transferProof.tables?.length !== 248 || !/^[a-f0-9]{64}$/.test(transferProof.contentSha256 || '')) {
    throw new Error('PG_STAGING_TRANSFER_PROOF');
  }
  const admin = new Client(connection(config));
  try {
    await admin.connect(); await assertCluster(admin, config, ['postgres', 'gp_migration_core', 'gp_migration_sales']);
    if ((await admin.query("SELECT pid FROM pg_stat_activity WHERE datname IN ('gp_migration_core','gp_migration_sales')")).rowCount) {
      throw new Error('PG_STAGING_ACTIVE_CLIENTS');
    }
    for (const domain of ['core', 'sales']) {
      const client = new Client(connection(config, domain));
      try {
        await client.connect();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const history = require('./history');
        for (const table of history.ownership.filter(table => table.database === domain)) {
          const expected = transferProof.tables.find(item => item.name === table.name && item.database === domain);
          if (!expected) throw new Error('PG_STAGING_INCOMPLETE_TRANSFER');
          await history.verifyTable(client, table, expected);
        }
        await client.query('COMMIT');
      } finally { await client.end(); }
    }
    for (const domain of ['core', 'sales']) {
      await admin.query(`ALTER DATABASE gp_migration_${domain} RENAME TO grabenplaner_${domain}`);
      const client = new Client(connection(config, domain, 'migrator', true));
      try {
        await client.connect();
        await client.query('BEGIN');
        const result = await client.query('UPDATE gp.environment_contract SET environment_id=$1,profile=$2 WHERE environment_id=$3 AND domain=$4 AND profile=$5',
          [binding.environmentId, binding.profile, ENVIRONMENT_ID, domain, PROFILE]);
        if (result.rowCount !== 1) throw new Error('PG_STAGING_ENVIRONMENT_CHANGED');
        await client.query('COMMIT');
      } finally { await client.end(); }
    }
    return { promoted: true, binding, sourceSha256: transferProof.sourceSha256, contentSha256: transferProof.contentSha256 };
  } finally { await admin.end(); }
}

module.exports = { FORMAT, ACCOUNTS, validateConfiguration, connection, assertCluster, bootstrapPair, assertTransferTarget, promotePair, assertOutputPath };

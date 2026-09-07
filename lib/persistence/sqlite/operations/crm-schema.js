"use strict";

function assertSqliteOperationsDatabase(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benoetigt.");
  }
  return database;
}

function customerTableSql(name) {
  if (!['crm_customers', 'crm_customers_next'].includes(name)) throw new TypeError('Unbekannte CRM-Tabelle.');
  return `CREATE TABLE IF NOT EXISTS ${name} (
      id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 80),
      account_number TEXT COLLATE NOCASE UNIQUE
        CHECK(account_number IS NULL OR length(trim(account_number)) BETWEEN 1 AND 80),
      customer_number TEXT COLLATE NOCASE UNIQUE
        CHECK(customer_number IS NULL OR length(trim(customer_number)) BETWEEN 1 AND 80),
      customer_type TEXT NOT NULL DEFAULT 'unknown' CHECK(customer_type IN ('private', 'business', 'unknown')),
      company_name TEXT NOT NULL DEFAULT '' CHECK(length(company_name) <= 200),
      first_name TEXT NOT NULL DEFAULT '' CHECK(length(first_name) <= 120),
      last_name TEXT NOT NULL DEFAULT '' CHECK(length(last_name) <= 120),
      street TEXT NOT NULL DEFAULT '' CHECK(length(street) <= 240),
      address_supplement TEXT NOT NULL DEFAULT '' CHECK(length(address_supplement) <= 160),
      postal_code TEXT NOT NULL DEFAULT '' CHECK(length(postal_code) <= 32),
      city TEXT NOT NULL DEFAULT '' CHECK(length(city) <= 120),
      country TEXT NOT NULL DEFAULT '' CHECK(length(country) <= 120),
      phone TEXT NOT NULL DEFAULT '' CHECK(length(phone) <= 80),
      email TEXT NOT NULL DEFAULT '' CHECK(length(email) <= 254),
      website TEXT NOT NULL DEFAULT '' CHECK(length(website) <= 500),
      vat_id TEXT NOT NULL DEFAULT '' CHECK(length(vat_id) <= 32),
      birth_date TEXT CHECK(birth_date IS NULL OR length(birth_date) = 10),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      updated_by TEXT NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 120),
      updated_at TEXT NOT NULL CHECK(length(updated_at) = 24),
      CHECK(account_number IS NOT NULL OR length(trim(company_name)) > 0 OR length(trim(first_name)) > 0 OR length(trim(last_name)) > 0)
    );`;
}

function migrateCustomerIdentity(database) {
  const columns = database.prepare('PRAGMA table_info(crm_customers)').all().map(c => c.name);
  if (!columns.length || columns.includes('account_number')) return;
  const expected = ['id', 'customer_number', 'customer_type', 'company_name', 'first_name', 'last_name', 'street', 'address_supplement',
    'postal_code', 'city', 'country', 'phone', 'email', 'website', 'vat_id', 'birth_date', 'revision', 'created_by', 'created_at', 'updated_by', 'updated_at'];
  if (columns.length !== expected.length || expected.some(c => !columns.includes(c))) throw new Error('Unbekanntes CRM-Schema; Kundenmigration abgebrochen.');
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='crm_customers_next'").get()) throw new Error('Unvollständige CRM-Migration erkannt.');
  const dependentSql = database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='crm_customers' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all();
  const foreignKeys = Number(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys) === 1;
  let started = false;
  try {
    if (foreignKeys) database.exec('PRAGMA foreign_keys = OFF');
    if (Number(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys) === 1) throw new Error('CRM-Migration benötigt eine eigene Starttransaktion.');
    database.exec('BEGIN IMMEDIATE'); started = true;
    database.exec(customerTableSql('crm_customers_next'));
    database.exec(`INSERT INTO crm_customers_next (${expected.join(', ')}) SELECT ${expected.join(', ')} FROM crm_customers`);
    database.exec('DROP TABLE crm_customers; ALTER TABLE crm_customers_next RENAME TO crm_customers');
    for (const entry of dependentSql) database.exec(entry.sql);
    for (const table of ['crm_customer_custom_fields', 'crm_customer_photos']) {
      if (database.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table) && database.prepare(`PRAGMA foreign_key_check(${table})`).get()) throw new Error('Kundenmigration verletzt bestehende Verknüpfungen.');
    }
    database.exec('COMMIT'); started = false;
  } catch (error) {
    if (started) database.exec('ROLLBACK');
    throw error;
  } finally { if (foreignKeys) database.exec('PRAGMA foreign_keys = ON'); }
}

function ensureSqliteCrmSchema(database) {
  const target = assertSqliteOperationsDatabase(database);
  migrateCustomerIdentity(target);
  target.exec(`
    ${customerTableSql('crm_customers')}

    CREATE INDEX IF NOT EXISTS idx_crm_customers_name
      ON crm_customers(last_name COLLATE NOCASE, first_name COLLATE NOCASE, company_name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_crm_customers_type_city
      ON crm_customers(customer_type, city COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_crm_customers_email
      ON crm_customers(email COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS crm_customer_custom_fields (
      id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 80),
      customer_id TEXT NOT NULL,
      title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
      value TEXT NOT NULL DEFAULT '' CHECK(length(value) <= 10000),
      sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0 AND sort_order < 50),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      updated_by TEXT NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 120),
      updated_at TEXT NOT NULL CHECK(length(updated_at) = 24),
      UNIQUE(customer_id, sort_order),
      FOREIGN KEY (customer_id) REFERENCES crm_customers(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_crm_customer_custom_fields_customer
      ON crm_customer_custom_fields(customer_id, sort_order);

    CREATE TABLE IF NOT EXISTS crm_customer_photos (
      customer_id TEXT PRIMARY KEY,
      storage_key TEXT NOT NULL UNIQUE
        CHECK(length(storage_key) = 43 AND storage_key GLOB '[0-9a-f][0-9a-f]/*-*-*-*-*.amu'),
      content_sha256 TEXT NOT NULL
        CHECK(length(content_sha256) = 64
          AND content_sha256 = lower(content_sha256)
          AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
      byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 524288),
      media_type TEXT NOT NULL CHECK(media_type = 'image/jpeg'),
      original_filename TEXT NOT NULL CHECK(length(original_filename) BETWEEN 1 AND 160),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(length(created_at) = 24),
      updated_by TEXT NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 120),
      updated_at TEXT NOT NULL CHECK(length(updated_at) = 24),
      FOREIGN KEY (customer_id) REFERENCES crm_customers(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );
  `);
}

module.exports = {
  ensureSqliteCrmSchema,
};

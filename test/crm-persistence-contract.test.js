"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  PERSISTENCE_ERROR_CODES,
} = require("../lib/persistence/contract");
const {
  createCrmCustomersRepository,
} = require("../lib/persistence/repositories/crm-customers");
const {
  ensureSqliteCrmSchema,
} = require("../lib/persistence/sqlite/operations/crm-schema");
const {
  CRM_CUSTOMER_STATEMENTS,
} = require("../lib/persistence/statements/crm-customers");
const {
  SQLITE_CRM_CUSTOMERS_CATALOG,
} = require("../lib/persistence/sqlite/crm-customers-catalog");

const root = path.resolve(__dirname, "..");


function insertCustomer(database, {
  id,
  customerNumber = null,
  firstName = "Ada",
  lastName = "Lovelace",
} = {}) {
  const timestamp = "2026-09-02T08:00:00.000Z";
  database.prepare(`
    INSERT INTO crm_customers (
      id, customer_number, customer_type, company_name, first_name, last_name,
      street, address_supplement, postal_code, city, country, phone, email,
      website, vat_id, birth_date, revision, created_by, created_at, updated_by, updated_at
    ) VALUES (?, ?, 'private', '', ?, ?, '', '', '', '', '', '', '', '', '', NULL, 1, 'tester', ?, 'tester', ?)
  `).run(id, customerNumber, firstName, lastName, timestamp, timestamp);
}

function repositoryCustomer(overrides = {}) {
  return {
    customerNumber: null,
    customerType: "private",
    companyName: "",
    firstName: "Ada",
    lastName: "Lovelace",
    street: "Testgasse 1",
    addressSupplement: "",
    postalCode: "6020",
    city: "Innsbruck",
    country: "Österreich",
    phone: "+43 512 123",
    email: "ada@example.test",
    website: "https://example.test",
    vatId: "",
    birthDate: "1815-12-10",
    customFields: [{ id: null, title: "Ausrüstung", value: "Mittelformat" }],
    ...overrides,
  };
}

test("SQL-Katalog bindet Suche, Sortierung und Pagination ohne SQL-Interpolation", () => {
  const ids = SQLITE_CRM_CUSTOMERS_CATALOG.map((entry) => entry.statement.id);
  assert.equal(ids.length, new Set(ids).size);
  for (const statement of Object.values(CRM_CUSTOMER_STATEMENTS)) {
    assert.ok(ids.includes(statement.id), `SQLite-Statement fehlt: ${statement.id}`);
  }

  const search = SQLITE_CRM_CUSTOMERS_CATALOG.find(
    (entry) => entry.statement === CRM_CUSTOMER_STATEMENTS.search,
  );
  assert.ok(search);
  assert.match(search.sql, /CASE \$sort/);
  assert.match(search.sql, /CASE WHEN \$direction = 'asc'/);
  assert.match(search.sql, /CASE WHEN \$direction = 'desc'/);
  assert.match(search.sql, /LIMIT \$limit OFFSET \$offset/);
  assert.match(search.sql, /customer\.id\s*$/m);
  assert.doesNotMatch(search.sql, /\$\{[^}]+\}/);
  assert.equal(Object.hasOwn(CRM_CUSTOMER_STATEMENTS.search.columns, "storageKey"), false);
  assert.equal(Object.hasOwn(CRM_CUSTOMER_STATEMENTS.search.columns, "contentSha256"), false);
  assert.equal(Object.hasOwn(CRM_CUSTOMER_STATEMENTS.search.columns, "customFields"), false);
  assert.equal(Object.hasOwn(CRM_CUSTOMER_STATEMENTS.get.columns, "customFields"), true);
});

test("CRM-Repository ist als eigene Persistence-Scheibe in Anwendung und SQLite registriert", () => {
  const repositories = fs.readFileSync(
    path.join(root, "lib", "persistence", "application-repositories.js"),
    "utf8",
  );
  const applicationCatalog = fs.readFileSync(
    path.join(root, "lib", "persistence", "catalogs", "application-catalog.js"),
    "utf8",
  );
  const applicationSchema = fs.readFileSync(
    path.join(root, "lib", "persistence", "sqlite", "operations", "application-schema.js"),
    "utf8",
  );
  assert.match(repositories, /createCrmCustomersRepository/);
  assert.match(repositories, /crmCustomers:\s*createCrmCustomersRepository\(access\)/);
  assert.match(applicationCatalog, /SQLITE_CRM_CUSTOMERS_CATALOG/);
  assert.match(applicationSchema, /ensureSqliteCrmSchema\(sqliteDatabase\)/);
});

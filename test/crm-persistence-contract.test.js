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
  openSqliteApplicationPersistence,
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");
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

function fixture() {
  const database = openSqliteLegacyDatabase(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  ensureSqliteCrmSchema(database);
  return database;
}

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

function repositoryFixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_CRM_CUSTOMERS_CATALOG,
  });
  application.database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureSqliteCrmSchema(application.database);
  return {
    ...application,
    repository: createCrmCustomersRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

test("CRM-Schema ist idempotent und trennt Kunden, freie Textfelder und Fotometadaten", () => {
  const database = fixture();
  try {
    ensureSqliteCrmSchema(database);
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'crm_%'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(tables, [
      "crm_customer_custom_fields",
      "crm_customer_photos",
      "crm_customers",
    ]);

    const customerColumns = database.prepare("PRAGMA table_info(crm_customers)").all()
      .map((column) => column.name);
    for (const column of [
      "customer_number", "customer_type", "company_name", "first_name", "last_name",
      "street", "address_supplement", "postal_code", "city", "country", "phone",
      "email", "website", "vat_id", "birth_date", "revision", "created_by", "created_at",
      "updated_by", "updated_at",
    ]) {
      assert.ok(customerColumns.includes(column), `CRM-Spalte fehlt: ${column}`);
    }
  } finally {
    database.close();
  }
});

test("Kundennummer ist mehrfach NULL, aber als vorhandener Wert eindeutig", () => {
  const database = fixture();
  try {
    insertCustomer(database, { id: "customer-null-1" });
    insertCustomer(database, { id: "customer-null-2", firstName: "Grace", lastName: "Hopper" });
    insertCustomer(database, { id: "customer-number-1", customerNumber: "K-00419" });
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM crm_customers WHERE customer_number IS NULL").get().count,
      2,
    );
    assert.throws(
      () => insertCustomer(database, { id: "customer-number-duplicate", customerNumber: "k-00419" }),
      /UNIQUE constraint failed: crm_customers\.customer_number/,
    );
    assert.throws(
      () => insertCustomer(database, { id: "customer-number-blank", customerNumber: "" }),
      /CHECK constraint failed/,
    );
  } finally {
    database.close();
  }
});

test("Revision verhindert stilles Überschreiben und freie Felder bleiben geordnet", () => {
  const database = fixture();
  try {
    insertCustomer(database, { id: "customer-revision" });
    const firstUpdate = database.prepare(`
      UPDATE crm_customers
      SET city = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run("Wien", "2026-09-02T09:00:00.000Z", "customer-revision", 1);
    assert.equal(firstUpdate.changes, 1);
    const staleUpdate = database.prepare(`
      UPDATE crm_customers
      SET city = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run("Graz", "2026-09-02T10:00:00.000Z", "customer-revision", 1);
    assert.equal(staleUpdate.changes, 0);
    assert.deepEqual(
      { ...database.prepare("SELECT city, revision FROM crm_customers WHERE id = ?").get("customer-revision") },
      { city: "Wien", revision: 2 },
    );

    const insertField = database.prepare(`
      INSERT INTO crm_customer_custom_fields (
        id, customer_id, title, value, sort_order, revision,
        created_by, created_at, updated_by, updated_at
      ) VALUES (?, 'customer-revision', ?, ?, ?, 1, 'tester', ?, 'tester', ?)
    `);
    const timestamp = "2026-09-02T09:00:00.000Z";
    insertField.run("field-2", "Problem", "Blitzanlage", 1, timestamp, timestamp);
    insertField.run("field-1", "Ausrüstung", "Mittelformat", 0, timestamp, timestamp);
    assert.deepEqual(
      database.prepare(`
        SELECT title, value, sort_order AS sortOrder
        FROM crm_customer_custom_fields
        WHERE customer_id = ?
        ORDER BY sort_order, id
      `).all("customer-revision").map((row) => ({ ...row })),
      [
        { title: "Ausrüstung", value: "Mittelformat", sortOrder: 0 },
        { title: "Problem", value: "Blitzanlage", sortOrder: 1 },
      ],
    );
    assert.throws(
      () => insertField.run("field-duplicate-order", "Hinweis", "Wert", 1, timestamp, timestamp),
      /UNIQUE constraint failed/,
    );
  } finally {
    database.close();
  }
});

test("Fototabelle speichert nur begrenzte Metadaten und nie Bildbytes", () => {
  const database = fixture();
  try {
    const columns = database.prepare("PRAGMA table_info(crm_customer_photos)").all()
      .map((column) => column.name);
    assert.deepEqual(columns, [
      "customer_id", "storage_key", "content_sha256", "byte_size", "media_type",
      "original_filename", "revision", "created_by", "created_at", "updated_by", "updated_at",
    ]);
    for (const forbidden of ["data", "content", "blob", "buffer", "bytes", "base64"] ) {
      assert.equal(columns.includes(forbidden), false);
    }

    insertCustomer(database, { id: "customer-photo" });
    const timestamp = "2026-09-02T09:00:00.000Z";
    database.prepare(`
      INSERT INTO crm_customer_photos (
        customer_id, storage_key, content_sha256, byte_size, media_type,
        original_filename, revision, created_by, created_at, updated_by, updated_at
      ) VALUES (?, ?, ?, ?, 'image/jpeg', ?, 1, 'tester', ?, 'tester', ?)
    `).run(
      "customer-photo",
      "ab/12345678-1234-1234-1234-123456789abc.amu",
      "a".repeat(64),
      524288,
      "portrait.jpg",
      timestamp,
      timestamp,
    );
    assert.throws(
      () => database.prepare("UPDATE crm_customer_photos SET byte_size = 524289 WHERE customer_id = ?")
        .run("customer-photo"),
      /CHECK constraint failed/,
    );
  } finally {
    database.close();
  }
});

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
    path.join(root, "lib", "persistence", "sqlite", "application-catalog.js"),
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

test("CRM-Repository trennt datensparsame Suche vom vollständigen Kundendetail", async () => {
  const context = repositoryFixture();
  try {
    const created = await context.repository.create({
      customer: repositoryCustomer(),
      actor: "manager-1",
      timestamp: "2026-09-02T08:00:00.000Z",
    });
    assert.equal(created.revision, 1);
    assert.equal(created.customerNumber, null);
    assert.deepEqual(created.customFields.map(({ title, value }) => ({ title, value })), [
      { title: "Ausrüstung", value: "Mittelformat" },
    ]);

    const results = await context.repository.search({
      query: "Ada",
      customerType: "",
      sort: "lastName",
      direction: "asc",
      limit: 25,
      offset: 0,
    });
    assert.equal(results.total, 1);
    assert.equal(results.items.length, 1);
    assert.equal(results.items[0].id, created.id);
    assert.equal(Object.hasOwn(results.items[0], "customFields"), false);
    assert.equal(Object.hasOwn(results.items[0], "storageKey"), false);

    const detail = await context.repository.get(created.id);
    assert.deepEqual(detail.customFields.map(({ title, value }) => ({ title, value })), [
      { title: "Ausrüstung", value: "Mittelformat" },
    ]);
    assert.deepEqual(
      context.database.prepare("SELECT action FROM audit_log ORDER BY id").all().map((row) => row.action),
      ["crm.customer.create"],
    );
  } finally {
    await context.close();
  }
});

test("CRM-Repository erzwingt optimistische Revision und auditierte Änderungen", async () => {
  const context = repositoryFixture();
  try {
    const created = await context.repository.create({
      customer: repositoryCustomer(),
      actor: "manager-1",
      timestamp: "2026-09-02T08:00:00.000Z",
    });
    const updated = await context.repository.update({
      id: created.id,
      customer: repositoryCustomer({ city: "Wien", customFields: [] }),
      expectedRevision: 1,
      actor: "manager-2",
      timestamp: "2026-09-02T09:00:00.000Z",
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.city, "Wien");
    assert.deepEqual(updated.customFields, []);

    await assert.rejects(
      context.repository.update({
        id: created.id,
        customer: repositoryCustomer({ city: "Graz" }),
        expectedRevision: 1,
        actor: "manager-3",
        timestamp: "2026-09-02T10:00:00.000Z",
      }),
      (error) => error?.code === PERSISTENCE_ERROR_CODES.RETRYABLE_TRANSACTION,
    );
    assert.deepEqual(
      context.database.prepare("SELECT action FROM audit_log ORDER BY id").all().map((row) => row.action),
      ["crm.customer.create", "crm.customer.update"],
    );
  } finally {
    await context.close();
  }
});

test("CRM-Repository speichert bei Fotos nur geprüfte Referenzmetadaten", async () => {
  const context = repositoryFixture();
  try {
    const created = await context.repository.create({
      customer: repositoryCustomer(),
      actor: "manager-1",
      timestamp: "2026-09-02T08:00:00.000Z",
    });
    const photo = {
      storageKey: "ab/12345678-1234-1234-1234-123456789abc.amu",
      contentSha256: "a".repeat(64),
      byteSize: 12345,
      mediaType: "image/jpeg",
      originalFilename: "portrait.jpg",
    };
    const stored = await context.repository.replacePhoto({
      customerId: created.id,
      photo,
      actor: "manager-1",
      timestamp: "2026-09-02T09:00:00.000Z",
    });
    assert.equal(stored.photo.storageKey, photo.storageKey);
    assert.equal(stored.photo.contentSha256, photo.contentSha256);
    assert.equal(Object.hasOwn(stored.photo, "buffer"), false);

    await assert.rejects(
      context.repository.replacePhoto({
        customerId: created.id,
        photo: { ...photo, buffer: Buffer.from("not-allowed") },
        actor: "manager-1",
        timestamp: "2026-09-02T10:00:00.000Z",
      }),
      (error) => error?.code === PERSISTENCE_ERROR_CODES.STATEMENT_INVALID,
    );
    assert.deepEqual(
      context.database.prepare("SELECT action FROM audit_log ORDER BY id").all().map((row) => row.action),
      ["crm.customer.create", "crm.customer.photo.create"],
    );
  } finally {
    await context.close();
  }
});

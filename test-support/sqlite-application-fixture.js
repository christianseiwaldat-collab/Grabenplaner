"use strict";

const {
  createApplicationRepositories,
} = require("../lib/persistence/application-repositories");
const {
  SQLITE_APPLICATION_CATALOG,
} = require("../lib/persistence/sqlite/application-catalog");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");

function invalidFixtureInput() {
  return new TypeError("Die SQLite-Anwendungsfixture ist ungültig.");
}

function normalizedEmployeeNumbers(employeeNumbers) {
  if (!Array.isArray(employeeNumbers)) throw invalidFixtureInput();
  const normalized = employeeNumbers.map((value) => {
    if (typeof value !== "string") throw invalidFixtureInput();
    const employeeNumber = value.trim();
    if (!employeeNumber || employeeNumber.length > 255 || employeeNumber.includes("\0")) {
      throw invalidFixtureInput();
    }
    return employeeNumber;
  });
  if (new Set(normalized).size !== normalized.length) throw invalidFixtureInput();
  return Object.freeze(normalized);
}

function sqliteStringLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const createSqliteApplicationFixture = Object.freeze(async function createSqliteApplicationFixture(
  options = {},
) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => key !== "employeeNumbers")) {
    throw invalidFixtureInput();
  }
  const employeeNumbers = normalizedEmployeeNumbers(options.employeeNumbers ?? ["E1"]);
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_APPLICATION_CATALOG,
  });
  const { database, provider } = application;

  try {
    database.exec(`
      CREATE TABLE portal_users (
        employee_number TEXT PRIMARY KEY
      );
      CREATE TABLE portal_user_preferences (
        employee_number TEXT NOT NULL,
        preference_key TEXT NOT NULL CHECK(preference_key <> 'reject'),
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (employee_number, preference_key),
        FOREIGN KEY (employee_number) REFERENCES portal_users(employee_number)
          ON UPDATE CASCADE ON DELETE CASCADE
      );
    `);
    if (employeeNumbers.length) {
      database.exec(`
        INSERT INTO portal_users (employee_number)
        VALUES ${employeeNumbers.map((value) => `(${sqliteStringLiteral(value)})`).join(", ")};
      `);
    }
  } catch (error) {
    await provider.close();
    database.close();
    throw error;
  }

  const repositories = createApplicationRepositories(provider);
  let closed = false;
  const fixture = Object.freeze({
    provider,
    repositories,
    transaction(work, transactionOptions) {
      if (typeof work !== "function") throw invalidFixtureInput();
      return provider.transaction((executor) => (
        work(createApplicationRepositories(executor))
      ), transactionOptions);
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await provider.close();
      } finally {
        database.close();
      }
    },
  });
  return fixture;
});

module.exports = {
  createSqliteApplicationFixture,
};

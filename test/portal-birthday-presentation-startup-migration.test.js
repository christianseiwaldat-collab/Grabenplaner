"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  PORTAL_BIRTHDAY_PRESENTATION_MIGRATION_ID,
  PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_NAMES,
  inspectSqlitePortalBirthdayPresentationRows,
  inspectSqlitePortalBirthdayPresentationSchema,
} = require("../lib/persistence/sqlite/operations/portal-birthday-presentation-schema");
const {
  runSqliteStartupSchemaMigrations,
} = require("../lib/persistence/sqlite/operations/startup-schema-migrations");
const {
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");
const { canonicalSha256 } = require("../lib/work-rules/receipt");

function migrate(database, { databaseExistedBeforeOpen = false, onBackup = () => {} } = {}) {
  return runSqliteStartupSchemaMigrations({
    database,
    databaseExistedBeforeOpen,
    appVersion: "0.92.10-birthday-presentation-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

function dropPresentationTriggers(database) {
  for (const name of PORTAL_BIRTHDAY_PRESENTATION_TRIGGER_NAMES) {
    database.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  }
}

function dropPresentationSchema(database) {
  dropPresentationTriggers(database);
  database.exec(`
    DROP TABLE portal_birthday_presentation_assignments;
    DROP TABLE portal_birthday_presentation_policy;
  `);
  database.prepare("DELETE FROM schema_migrations WHERE id = ?")
    .run(PORTAL_BIRTHDAY_PRESENTATION_MIGRATION_ID);
}

test("Block 8: Fehlendes historisches Schema wird einmal gesichert, erstellt und markiert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  let backups = 0;
  try {
    migrate(database);
    dropPresentationSchema(database);

    const first = migrate(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => { backups += 1; },
    });
    assert.equal(first.portalBirthdayPresentationMigrationRequired, true);
    assert.equal(backups, 1);
    assert.equal(inspectSqlitePortalBirthdayPresentationSchema(database).valid, true);
    assert.equal(inspectSqlitePortalBirthdayPresentationRows(database).valid, true);
    assert.deepEqual({ ...database.prepare(`
      SELECT enabled, revision
      FROM portal_birthday_presentation_policy
      WHERE singleton_id = 1
    `).get() }, { enabled: 0, revision: 1 });
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
      FROM schema_migrations
      WHERE id = ?
    `).get(PORTAL_BIRTHDAY_PRESENTATION_MIGRATION_ID).count, 1);

    const second = migrate(database);
    assert.equal(second.portalBirthdayPresentationMigrationRequired, false);
    assert.equal(backups, 1);
  } finally {
    database.close();
  }
});

test("Block 8: Leeres unvollständiges Schema wird sicher vervollständigt", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  let backups = 0;
  try {
    migrate(database);
    dropPresentationTriggers(database);
    database.exec(`
      DELETE FROM portal_birthday_presentation_assignments;
      DELETE FROM portal_birthday_presentation_policy;
    `);

    const result = migrate(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => { backups += 1; },
    });
    assert.equal(result.portalBirthdayPresentationMigrationRequired, true);
    assert.equal(backups, 1);
    assert.equal(inspectSqlitePortalBirthdayPresentationSchema(database).valid, true);
    assert.equal(inspectSqlitePortalBirthdayPresentationRows(database).valid, true);
    assert.equal(database.prepare(`
      SELECT revision
      FROM portal_birthday_presentation_policy
      WHERE singleton_id = 1
    `).get().revision, 1);
  } finally {
    database.close();
  }
});

test("Block 8: Definitionsdrift mit Konfigurationsdaten bleibt nach Sicherung fail-closed", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  let backups = 0;
  try {
    migrate(database);
    database.prepare(`
      UPDATE portal_birthday_presentation_policy
      SET enabled = 1, revision = 2, updated_at = ?
      WHERE singleton_id = 1
    `).run("2026-08-20T15:00:00.000Z");
    database.exec("DROP TRIGGER trg_portal_birthday_presentation_policy_no_delete");

    assert.throws(
      () => migrate(database, {
        databaseExistedBeforeOpen: true,
        onBackup: () => { backups += 1; },
      }),
      (error) => error.code === "PORTAL_BIRTHDAY_PRESENTATION_SCHEMA_DATA_PRESENT",
    );
    assert.equal(backups, 1);
    assert.deepEqual({ ...database.prepare(`
      SELECT enabled, revision, updated_at AS updatedAt
      FROM portal_birthday_presentation_policy
      WHERE singleton_id = 1
    `).get() }, {
      enabled: 1,
      revision: 2,
      updatedAt: "2026-08-20T15:00:00.000Z",
    });
    assert.equal(inspectSqlitePortalBirthdayPresentationSchema(database).valid, false);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count
      FROM schema_migrations
      WHERE id = ?
    `).get(PORTAL_BIRTHDAY_PRESENTATION_MIGRATION_ID).count, 1);
  } finally {
    database.close();
  }
});

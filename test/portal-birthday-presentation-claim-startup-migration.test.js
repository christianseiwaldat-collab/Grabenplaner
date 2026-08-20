"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  PORTAL_BIRTHDAY_PRESENTATION_CLAIM_MIGRATION_ID,
  PORTAL_BIRTHDAY_PRESENTATION_CLAIM_TRIGGER_DEFINITIONS,
  inspectSqlitePortalBirthdayPresentationClaimRows,
  inspectSqlitePortalBirthdayPresentationClaimSchema,
} = require("../lib/persistence/sqlite/operations/portal-birthday-presentation-claim-schema");
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
    appVersion: "0.92.10-birthday-claim-test",
    ensureApplicationSchema: () => ensureSqliteApplicationSchema(database),
    createPreMigrationBackup: onBackup,
    workRuleSha256: canonicalSha256,
  });
}

test("Block 10: fehlendes Claim-Schema wird nach Sicherung erstellt und markiert", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  let backups = 0;
  try {
    migrate(database);
    for (const { name } of PORTAL_BIRTHDAY_PRESENTATION_CLAIM_TRIGGER_DEFINITIONS) {
      database.exec(`DROP TRIGGER IF EXISTS "${name}"`);
    }
    database.exec("DROP TABLE portal_birthday_presentation_claims");
    database.prepare("DELETE FROM schema_migrations WHERE id = ?")
      .run(PORTAL_BIRTHDAY_PRESENTATION_CLAIM_MIGRATION_ID);

    const first = migrate(database, {
      databaseExistedBeforeOpen: true,
      onBackup: () => { backups += 1; },
    });
    assert.equal(first.portalBirthdayPresentationClaimMigrationRequired, true);
    assert.equal(backups, 1);
    assert.equal(inspectSqlitePortalBirthdayPresentationClaimSchema(database).valid, true);
    assert.equal(inspectSqlitePortalBirthdayPresentationClaimRows(database).valid, true);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?
    `).get(PORTAL_BIRTHDAY_PRESENTATION_CLAIM_MIGRATION_ID).count, 1);

    const second = migrate(database);
    assert.equal(second.portalBirthdayPresentationClaimMigrationRequired, false);
    assert.equal(backups, 1);
  } finally {
    database.close();
  }
});

test("Block 10: Definitionsdrift mit Claims bleibt nach Sicherung fail-closed", () => {
  const database = openSqliteLegacyDatabase(":memory:");
  let backups = 0;
  try {
    migrate(database);
    const employeeNumber = "birthday-claim-migration-252";
    database.prepare(`
      INSERT INTO employees (personnel_number, full_name, nickname)
      VALUES (?, 'Claim Migration', 'Claim Migration')
    `).run(employeeNumber);
    database.prepare(`
      INSERT INTO portal_birthday_presentation_claims (
        employee_number, event_year, presentation_id, policy_revision,
        assignment_revision, receipt_sha256, revision
      ) VALUES (?, 2026, 'standard', 1, 1, ?, 1)
    `).run(employeeNumber, "a".repeat(64));
    database.exec("DROP TRIGGER trg_portal_birthday_presentation_claim_immutable_update");

    assert.throws(
      () => migrate(database, {
        databaseExistedBeforeOpen: true,
        onBackup: () => { backups += 1; },
      }),
      (error) => error.code === "PORTAL_BIRTHDAY_PRESENTATION_CLAIM_SCHEMA_DATA_PRESENT",
    );
    assert.equal(backups, 1);
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM portal_birthday_presentation_claims
    `).get().count, 1);
    assert.equal(inspectSqlitePortalBirthdayPresentationClaimSchema(database).valid, false);
  } finally {
    database.close();
  }
});

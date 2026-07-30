"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createSicknessAmuManagementRepository,
} = require("../lib/persistence/repositories/sickness-amu-management");
const {
  SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG,
} = require("../lib/persistence/sqlite/sickness-amu-management-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  SICKNESS_AMU_MANAGEMENT_STATEMENTS,
} = require("../lib/persistence/statements/sickness-amu-management");

function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`
    INSERT INTO locations (id, name, active)
      VALUES ('18', 'Filiale 18', 1);
    INSERT INTO departments (id, location_id, name, active)
      VALUES (18, '18', 'Verkauf', 1);
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      preferred_department_id, time_confirmation_level, active
    ) VALUES ('E18', 'Erika Beispiel', 'Erika', '18', 18, 'B', 1);
  `);
  return {
    ...application,
    repository: createSicknessAmuManagementRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

test("Block 3/7: Krankheits-, AUM- und Personalakt-Katalog ist vollstaendig", () => {
  const statements = Object.values(SICKNESS_AMU_MANAGEMENT_STATEMENTS);
  assert.equal(SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

test("Block 3/7: Geschuetzte Krankheits-, AUM- und Dokumentdaten laufen ueber den Provider", async () => {
  const context = fixture();
  try {
    const sicknessInsert = await context.repository.insertSicknessCase({
      employeeLookup: "employee-lookup-e18",
      statusLookup: "status-reported",
      protectedPayload: "cipher:sickness:initial",
      purgeAfter: "2027-07-29",
    });
    const sicknessCaseId = Number(sicknessInsert.returnedRows?.[0]?.data?.id);
    assert.ok(Number.isSafeInteger(sicknessCaseId));

    await context.repository.updateSicknessCasePayloadInitial({
      id: sicknessCaseId,
      protectedPayload: "cipher:sickness:complete",
    });
    await context.repository.insertSicknessAlert({
      id: "alert-1",
      caseId: sicknessCaseId,
      statusLookup: "warning",
      protectedPayload: "cipher:alert",
      purgeAfter: "2027-07-29",
      dedupeLookup: "dedupe-alert-1",
    });
    await context.repository.insertProtectedCaseEvent({
      id: "event-1",
      entityKind: "sickness",
      entityId: sicknessCaseId,
      actionLookup: "reported",
      actorLookup: "employee-lookup-e18",
      protectedPayload: "cipher:event",
    });

    const amuInsert = await context.repository.insertAmuReport({
      sicknessCaseId,
      employeeNumber: "E18",
      locationId: "18",
      departmentId: 18,
      status: "submitted",
    });
    const reportId = Number(amuInsert.returnedRows?.[0]?.data?.id);
    assert.ok(Number.isSafeInteger(reportId));
    await context.repository.updateAmuReportPayload({
      id: reportId,
      protectedPayload: "cipher:amu",
    });
    await context.repository.insertAmuDocument({
      id: "amu-document-1",
      reportId,
      storageKey: "amu/storage-1",
      scanStatus: "clean",
      encryptionKeyId: "key-1",
      protectedPayload: "cipher:amu-document",
    });
    await context.repository.insertPersonnelDocument({
      id: "personnel-document-1",
      employeeNumber: "E18",
      storageKey: "personnel/storage-1",
      protectedPayload: "cipher:personnel-document",
    });
    await context.repository.upsertPersonnelSensitiveRecord({
      employeeNumber: "E18",
      socialSecurityLookup: "lookup:sv-e18",
      protectedPayload: "cipher:personnel-profile",
      actor: "HR18",
    });

    const sicknessCase = await context.repository.getSicknessCase({ id: sicknessCaseId });
    assert.equal(sicknessCase.protected_payload, "cipher:sickness:complete");
    assert.equal(sicknessCase.revision, 2);
    assert.equal(
      (await context.repository.listSicknessAlertsByCase({ caseId: sicknessCaseId }))[0]
        .protected_payload,
      "cipher:alert",
    );
    assert.equal(
      (await context.repository.listProtectedCaseEvents({
        entityKind: "sickness",
        entityId: sicknessCaseId,
      }))[0].protected_payload,
      "cipher:event",
    );

    const report = await context.repository.getAmuReport({ id: reportId });
    assert.equal(report.employee_number, "E18");
    assert.equal(report.protected_payload, "cipher:amu");
    assert.equal(
      (await context.repository.getAmuDocument({
        reportId,
        documentId: "amu-document-1",
        activeOnly: 1,
      })).protected_payload,
      "cipher:amu-document",
    );
    assert.equal(
      (await context.repository.getPersonnelDocument({
        employeeNumber: "E18",
        documentId: "personnel-document-1",
        activeOnly: true,
      })).protected_payload,
      "cipher:personnel-document",
    );
    assert.deepEqual(
      { ...context.database.prepare(`
        SELECT social_security_lookup, protected_payload, updated_by
        FROM personnel_sensitive_records
        WHERE employee_number = 'E18'
      `).get() },
      {
        social_security_lookup: "lookup:sv-e18",
        protected_payload: "cipher:personnel-profile",
        updated_by: "HR18",
      },
    );
  } finally {
    await context.close();
  }
});

test("Block 3/7: Gebundene Fachtransaktion rollt AUM und Dokument gemeinsam zurueck", async () => {
  const context = fixture();
  try {
    let rollbackReportId = null;
    await assert.rejects(
      context.repository.transaction(async (repository) => {
        const inserted = await repository.insertAmuReport({
          sicknessCaseId: null,
          employeeNumber: "E18",
          locationId: "18",
          departmentId: 18,
          status: "submitted",
        });
        const reportId = Number(inserted.returnedRows?.[0]?.data?.id);
        rollbackReportId = reportId;
        await repository.insertAmuDocument({
          id: "rollback-document",
          reportId,
          storageKey: "amu/rollback",
          scanStatus: "clean",
          encryptionKeyId: "key-1",
          protectedPayload: "cipher:rollback",
        });
        throw new Error("rollback");
      }),
      /rollback/,
    );

    assert.deepEqual(await context.repository.listOwnAmuReports({ employeeNumber: "E18" }), []);
    assert.equal(await context.repository.getAmuDocument({
      reportId: rollbackReportId,
      documentId: "rollback-document",
      activeOnly: 0,
    }), null);
  } finally {
    await context.close();
  }
});

test("Block 3/7: Serverpfad enthaelt keine rohen Tabellenzugriffe des Fachbereichs", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.doesNotMatch(
    source,
    /\b(?:sickness_cases|sickness_alerts|protected_case_events|sickness_notification_preferences|sickness_notification_verifications|outbound_notification_jobs|amu_reports|amu_documents|personnel_record_documents)\b/,
  );
  assert.match(source, /sicknessAmuManagementRepository/);
});

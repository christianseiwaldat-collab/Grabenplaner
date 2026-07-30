"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createIntegrationRuntimeRepository,
} = require("../lib/persistence/repositories/integration-runtime");
const {
  SQLITE_INTEGRATION_RUNTIME_CATALOG,
} = require("../lib/persistence/sqlite/integration-runtime-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  INTEGRATION_RUNTIME_STATEMENTS,
} = require("../lib/persistence/statements/integration-runtime");

function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_INTEGRATION_RUNTIME_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  return {
    ...application,
    repository: createIntegrationRuntimeRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

test("Block 3/7: Integrationskatalog deckt jedes typisierte Statement genau einmal ab", () => {
  const statements = Object.values(INTEGRATION_RUNTIME_STATEMENTS);
  assert.equal(SQLITE_INTEGRATION_RUNTIME_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_INTEGRATION_RUNTIME_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_INTEGRATION_RUNTIME_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

test("Block 3/7: Verbindung, Profil, Lauf und Zustellung bleiben providerneutral lesbar", async () => {
  const context = fixture();
  try {
    await context.repository.insertConnection({
      id: "connection-1",
      kind: "payroll_https_target",
      name: "Lohnziel",
      provider: "https_json",
      configurationJson: "{}",
      protectedCredentials: "",
      credentialKeyId: "",
      active: 1,
      actor: "admin",
    });
    await context.repository.insertProfile({
      id: "profile-1",
      direction: "export",
      kind: "payroll",
      name: "Lohnprofil",
      format: "csv",
      configurationJson: "{}",
      active: 1,
      actor: "admin",
    });
    await context.repository.insertRun({
      id: "run-1",
      profileId: "profile-1",
      direction: "export",
      kind: "payroll",
      format: "csv",
      contentSha256: "a".repeat(64),
      status: "completed",
      totalCount: 2,
      createdCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      actor: "admin",
      optionsJson: "{}",
      resultJson: "{}",
      errorCode: "",
    });
    await context.repository.insertDelivery({
      id: "delivery-1",
      connectionId: "connection-1",
      profileId: "profile-1",
      idempotencyKey: "delivery-key",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      locationId: "18",
      departmentId: "",
      connectionRevision: 1,
      connectionFingerprint: "b".repeat(64),
      payloadSha256: "c".repeat(64),
      rowCount: 2,
      actor: "admin",
      startedAt: "2026-07-29T10:00:00.000Z",
    });

    assert.equal((await context.repository.listConnections({ kind: "" }))[0].id, "connection-1");
    assert.equal((await context.repository.listProfiles({ direction: "export", kind: "payroll" }))[0].id, "profile-1");
    assert.equal((await context.repository.listRuns({ actorEmployeeNumber: "", limit: 10 }))[0].id, "run-1");
    assert.equal((await context.repository.getDeliveryByIdempotencyKey({ idempotencyKey: "delivery-key" })).id, "delivery-1");

    assert.equal((await context.repository.claimDelivery({ id: "delivery-1" })).rowsAffected, 1);
    assert.equal((await context.repository.getDeliveryStatus({ id: "delivery-1" })).status, "sending");
    await context.repository.completeDelivery({
      id: "delivery-1",
      status: "delivered",
      httpStatus: 201,
      errorCode: "",
    });
    assert.equal((await context.repository.getDelivery({ id: "delivery-1" })).status, "delivered");
  } finally {
    await context.close();
  }
});

test("Block 3/7: Personalimport und Laufprotokoll teilen eine gebundene Transaktion", async () => {
  const context = fixture();
  try {
    context.database.exec(`
      INSERT INTO cost_center_types (id, code, name, is_branch, active)
        VALUES ('branch', 'FIL', 'Filiale', 1, 1);
      INSERT INTO cost_centers (id, code, name, type, cost_center_type_id, active)
        VALUES ('cc-18', '18', 'Filiale 18', 'branch', 'branch', 1);
      INSERT INTO locations (id, name, cost_center_id, active)
        VALUES ('18', 'Filiale 18', 'cc-18', 1);
    `);
    const employee = {
      personnelNumber: "E100",
      fullName: "Erika Beispiel",
      nickname: "Erika",
      color: "#0b84c6",
      contractedHours: 38.5,
      targetWorkdaysPerWeek: 5,
      preferredDayOff: "",
      fixedWorkdays: "",
      positionId: "verkaufsmitarbeiter",
      timeConfirmationLevel: "C",
      sicknessWithoutAumEnabled: 0,
      homeLocationId: "18",
      preferredDepartmentId: "",
      costCenterId: "cc-18",
      active: 1,
    };

    await assert.rejects(
      context.repository.transaction(async (repository) => {
        await repository.insertEmployee(employee);
        await repository.insertRun({
          id: "rollback-run",
          profileId: null,
          direction: "import",
          kind: "personnel",
          format: "csv",
          contentSha256: "",
          status: "completed",
          totalCount: 1,
          createdCount: 1,
          updatedCount: 0,
          skippedCount: 0,
          errorCount: 0,
          actor: "admin",
          optionsJson: "{}",
          resultJson: "{}",
          errorCode: "",
        });
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal(await context.repository.getEmployeeImportRow({ personnelNumber: "E100" }), null);
    assert.equal((await context.repository.listRuns({ actorEmployeeNumber: "", limit: 10 })).length, 0);

    await context.repository.transaction(async (repository) => {
      await repository.insertEmployee(employee);
      await repository.insertRun({
        id: "commit-run",
        profileId: null,
        direction: "import",
        kind: "personnel",
        format: "csv",
        contentSha256: "",
        status: "completed",
        totalCount: 1,
        createdCount: 1,
        updatedCount: 0,
        skippedCount: 0,
        errorCount: 0,
        actor: "admin",
        optionsJson: "{}",
        resultJson: "{}",
        errorCode: "",
      });
    });
    assert.equal(
      (await context.repository.getEmployeeImportRow({ personnelNumber: "E100" })).full_name,
      "Erika Beispiel",
    );
    assert.equal((await context.repository.listRuns({ actorEmployeeNumber: "", limit: 10 }))[0].id, "commit-run");
  } finally {
    await context.close();
  }
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createCustomProcessManagementRepository,
} = require("../lib/persistence/repositories/custom-process-management");
const {
  SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
} = require("../lib/persistence/sqlite/custom-process-management-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  CUSTOM_PROCESS_MANAGEMENT_STATEMENTS,
} = require("../lib/persistence/statements/custom-process-management");

function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`
    INSERT INTO employees (personnel_number, full_name, nickname)
      VALUES ('E1', 'Erika Beispiel', 'Erika');
  `);
  return {
    ...application,
    repository: createCustomProcessManagementRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

async function insertProcessRunSlice(repository, suffix) {
  const processId = `process-${suffix}`;
  const stepId = `step-${suffix}`;
  const runId = `run-${suffix}`;
  await repository.insertProcess({
    id: processId,
    title: "Providerneutraler Prozess",
    symbol: "P",
    description: "Transaktionstest",
    category: "other",
    scopeType: "company",
    locationId: null,
    departmentId: null,
    triggerType: "manual",
    triggerMinimumShortfall: 1,
    status: "active",
    actor: "admin",
  });
  await repository.insertProcessStep({
    id: stepId,
    processId,
    sortOrder: 1,
    type: "actor",
    title: "Aufgabe erledigen",
    description: "",
    responsibilityType: "employee",
    responsibilityReference: "E1",
    responsibilityLabel: "Erika",
    conditionType: "always",
    conditionText: "",
    notificationChannels: JSON.stringify(["internal"]),
  });
  await repository.insertProcessRevision({
    processId,
    revision: 1,
    snapshotJson: JSON.stringify({ id: processId, revision: 1 }),
    actor: "admin",
  });
  await repository.insertRun({
    id: runId,
    processId,
    processRevision: 1,
    triggerType: "manual",
    triggerKey: `manual:${suffix}`,
    locationId: null,
    departmentId: null,
    triggeredBy: "admin",
  });
  await repository.insertRunStep({ runId, stepId, sortOrder: 1 });
  await repository.insertPortalNotification({
    id: `notification-${suffix}`,
    recipient: "E1",
    eventType: "custom_process.task",
    title: "Neue Prozessaufgabe",
    message: "",
    target: "/?view=process-tasks",
    entityType: "custom_process_run",
    entityId: runId,
    dedupeKey: `custom-process:${runId}:1:${stepId}`,
  });
  await repository.insertOutboundJob({
    id: `job-${suffix}`,
    recipientLookup: `recipient-${suffix}`,
    channel: "email",
    entityLookup: `entity-${suffix}`,
    protectedPayload: "{}",
    notBefore: "2026-07-29T10:00:00.000Z",
    purgeAfter: "2026-08-29",
    dedupeLookup: `dedupe-${suffix}`,
  });
  await repository.insertAudit({
    actor: "admin",
    action: "custom-process.run.create",
    entityType: "custom_process_run",
    entityId: runId,
    detail: JSON.stringify({ processId }),
  });
  return { processId, stepId, runId };
}

test("Block 3/7: Eigene-Prozesse-Katalog deckt jedes typisierte Statement genau einmal ab", () => {
  const statements = Object.values(CUSTOM_PROCESS_MANAGEMENT_STATEMENTS);
  assert.equal(SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

test("Block 3/7: Definition, Lauf, Hinweise und Audit teilen exakt eine Providertransaktion", async () => {
  const context = fixture();
  const tables = [
    "custom_processes",
    "custom_process_steps",
    "custom_process_revisions",
    "custom_process_runs",
    "custom_process_run_steps",
    "portal_notifications",
    "outbound_notification_jobs",
    "audit_log",
  ];
  try {
    await assert.rejects(
      context.repository.transaction(async (repository) => {
        await insertProcessRunSlice(repository, "rollback");
        throw new Error("rollback");
      }),
      /rollback/,
    );
    for (const table of tables) {
      assert.equal(
        context.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
        0,
        `${table} wurde nicht zurückgerollt`,
      );
    }

    let committed;
    await context.repository.transaction(async (repository) => {
      committed = await insertProcessRunSlice(repository, "commit");
    });
    assert.equal(
      (await context.repository.processById({
        id: committed.processId,
        includeArchived: 0,
      })).title,
      "Providerneutraler Prozess",
    );
    assert.equal(
      (await context.repository.listProcessSteps({ processId: committed.processId }))[0].id,
      committed.stepId,
    );
    assert.equal(
      (await context.repository.runById({ id: committed.runId })).process_id,
      committed.processId,
    );
    assert.equal(
      (await context.repository.outboundJobByDedupe({ dedupeLookup: "dedupe-commit" })).id,
      "job-commit",
    );
    for (const table of tables) {
      assert.equal(
        context.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
        1,
        `${table} wurde nicht gemeinsam committed`,
      );
    }
  } finally {
    await context.close();
  }
});

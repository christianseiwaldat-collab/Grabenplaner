"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createApplicationRepositories,
} = require("../lib/persistence/application-repositories");
const {
  SQLITE_APPLICATION_CATALOG,
} = require("../lib/persistence/sqlite/application-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  moduleEventReceiptSha256,
  moduleReceiptSha256,
  moduleVersionReceiptSha256,
  sha256Text,
} = require("../lib/persistence/sqlite/operations/personnel-learning-schema");
const {
  createSqlitePersistenceProvider,
  openSqliteLegacyDatabase,
} = require("../lib/persistence/sqlite/provider");

function fixtureRows() {
  const module = {
    id: "learning-module:persistence",
    moduleCode: "persistence.test",
    moduleType: "knowledge",
    receiptSha256: "",
    createdBy: "TEST",
    createdAt: "2026-08-18T12:00:00.000Z",
  };
  module.receiptSha256 = moduleReceiptSha256(module);
  const content = {
    schemaVersion: 1,
    summary: "Persistenztest",
    objective: "Die Repository-Verträge prüfen.",
    estimatedMinutes: 15,
    verificationMode: "knowledge_check",
    tags: ["Test"],
    steps: [{
      stepId: "test",
      title: "Repository prüfen",
      instruction: "",
      completionCriteria: "",
      required: true,
    }],
    versionNote: "Erstfassung",
  };
  const scopeSnapshot = { type: "location", locationId: "learning-persistence" };
  const version = {
    moduleId: module.id,
    versionNumber: 1,
    title: "Persistenzvertrag",
    content,
    contentSha256: sha256Text(JSON.stringify(content)),
    scopeType: "location",
    scopeLocationId: "learning-persistence",
    scopeDepartmentId: null,
    scopeSnapshot,
    scopeSnapshotSha256: sha256Text(JSON.stringify(scopeSnapshot)),
    previousReceiptSha256: "",
    receiptSha256: "",
    createdBy: "TEST",
    createdAt: module.createdAt,
  };
  version.receiptSha256 = moduleVersionReceiptSha256(version);
  const createdEvent = {
    id: "learning-event:persistence:1",
    moduleId: module.id,
    sequenceNumber: 1,
    eventType: "created",
    moduleVersionNumber: null,
    eventPayload: { schemaVersion: 1 },
    eventPayloadSha256: sha256Text(JSON.stringify({ schemaVersion: 1 })),
    previousReceiptSha256: "",
    receiptSha256: "",
    actorId: "TEST",
    occurredAt: module.createdAt,
  };
  createdEvent.receiptSha256 = moduleEventReceiptSha256(createdEvent);
  const versionEventPayload = { schemaVersion: 1, versionReceiptSha256: version.receiptSha256 };
  const versionEvent = {
    id: "learning-event:persistence:2",
    moduleId: module.id,
    sequenceNumber: 2,
    eventType: "version_added",
    moduleVersionNumber: 1,
    eventPayload: versionEventPayload,
    eventPayloadSha256: sha256Text(JSON.stringify(versionEventPayload)),
    previousReceiptSha256: createdEvent.receiptSha256,
    receiptSha256: "",
    actorId: "TEST",
    occurredAt: module.createdAt,
  };
  versionEvent.receiptSha256 = moduleEventReceiptSha256(versionEvent);
  return { module, version, createdEvent, versionEvent };
}

test("Learning-Katalog-Repository schreibt und liest Modul, Version und Ereigniskette typisiert", async () => {
  const database = openSqliteLegacyDatabase(":memory:");
  ensureSqliteApplicationSchema(database);
  database.prepare(`
    INSERT INTO locations (id, name, min_staff, active)
    VALUES ('learning-persistence', 'Learning Persistenz', 0, 1)
  `).run();
  const provider = createSqlitePersistenceProvider({ database, catalog: SQLITE_APPLICATION_CATALOG });
  const repositories = createApplicationRepositories(provider);
  const rows = fixtureRows();
  try {
    await repositories.personnelLearning.insertModule(rows.module);
    await repositories.personnelLearning.insertVersion(rows.version);
    await repositories.personnelLearning.insertEvent(rows.createdEvent);
    await repositories.personnelLearning.insertEvent(rows.versionEvent);

    assert.deepEqual((await repositories.personnelLearning.listModules()).map((row) => row.id), [
      rows.module.id,
    ]);
    assert.deepEqual(await repositories.personnelLearning.getLatestVersion(rows.module.id), rows.version);
    assert.deepEqual(await repositories.personnelLearning.listEvents(rows.module.id), [
      rows.createdEvent,
      rows.versionEvent,
    ]);
    assert.equal(Object.isFrozen(await repositories.personnelLearning.getModule(rows.module.id)), true);
  } finally {
    await provider.close();
    database.close();
  }
});

test("Learning-Katalog-Repository rollt eine unvollständige Modulanlage atomar zurück", async () => {
  const database = openSqliteLegacyDatabase(":memory:");
  ensureSqliteApplicationSchema(database);
  database.prepare(`
    INSERT INTO locations (id, name, min_staff, active)
    VALUES ('learning-persistence', 'Learning Persistenz', 0, 1)
  `).run();
  const provider = createSqlitePersistenceProvider({ database, catalog: SQLITE_APPLICATION_CATALOG });
  const repositories = createApplicationRepositories(provider);
  const rows = fixtureRows();
  try {
    await assert.rejects(repositories.personnelLearning.transaction(async (repository) => {
      await repository.insertModule({ ...rows.module, id: "learning-module:rollback", moduleCode: "rollback" });
      throw new Error("rollback-test");
    }, { isolation: "serializable" }), /rollback-test/);
    assert.equal(await repositories.personnelLearning.getModule("learning-module:rollback"), null);
  } finally {
    await provider.close();
    database.close();
  }
});

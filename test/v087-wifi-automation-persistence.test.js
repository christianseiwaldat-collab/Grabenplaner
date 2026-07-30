"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createWifiAutomationRepository,
} = require("../lib/persistence/repositories/wifi-automation");
const {
  SQLITE_WIFI_AUTOMATION_CATALOG,
} = require("../lib/persistence/sqlite/wifi-automation-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  WIFI_AUTOMATION_STATEMENTS,
} = require("../lib/persistence/statements/wifi-automation");

function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_WIFI_AUTOMATION_CATALOG,
  });
  ensureSqliteApplicationSchema(application.database);
  application.database.exec(`
    INSERT INTO locations (id, name, active, time_tracking_enabled)
      VALUES ('18', 'Filiale 18', 1, 1);
    INSERT INTO employees (
      personnel_number, full_name, nickname, home_location_id,
      time_confirmation_level, active
    ) VALUES ('E18', 'Erika Beispiel', 'Erika', '18', 'A', 1);
    INSERT INTO portal_users (
      employee_number, role, active, password_hash
    ) VALUES ('E18', 'employee', 1, 'test');
  `);
  return {
    ...application,
    repository: createWifiAutomationRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

test("Block 3/7: WLAN-Katalog deckt jedes typisierte Statement genau einmal ab", () => {
  const statements = Object.values(WIFI_AUTOMATION_STATEMENTS);
  assert.equal(SQLITE_WIFI_AUTOMATION_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_WIFI_AUTOMATION_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_WIFI_AUTOMATION_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

test("Block 3/7: WLAN-Zuordnung und Opt-in bleiben providerneutral lesbar", async () => {
  const context = fixture();
  try {
    await context.repository.upsertLocationMapping({
      providerId: "radius",
      locationId: "18",
      externalLocationHash: "a".repeat(64),
      updatedBy: "admin",
    });
    await context.repository.upsertPreference({
      employeeNumber: "E18",
      enabled: 1,
      providerId: "radius",
      externalSubjectHash: "b".repeat(64),
    });

    assert.deepEqual(
      (await context.repository.listLocationMappings({ providerId: "radius" }))[0].location_id,
      "18",
    );
    assert.equal((await context.repository.getPreference({ employeeNumber: "E18" })).enabled, 1);
    assert.equal(
      (await context.repository.findActivePreference({
        providerId: "radius",
        externalSubjectHash: "b".repeat(64),
      })).employee_number,
      "E18",
    );
  } finally {
    await context.close();
  }
});

test("Block 3/7: WLAN-Inbox und Präsenzänderung rollen gemeinsam zurück", async () => {
  const context = fixture();
  try {
    await assert.rejects(
      context.repository.transaction(async (repository) => {
        await repository.insertInboxEvent({
          id: "inbox-rollback",
          providerId: "radius",
          externalEventHash: "c".repeat(64),
          eventType: "connected",
          externalSubjectHash: "d".repeat(64),
          externalLocationHash: "e".repeat(64),
          occurredAt: "2026-07-29T08:00:00.000Z",
          payloadFingerprint: "f".repeat(64),
        });
        await repository.insertPresenceSession({
          id: "presence-rollback",
          employeeNumber: "E18",
          locationId: "18",
          providerId: "radius",
          correlationHash: "1".repeat(64),
          occurredAt: "2026-07-29T08:00:00.000Z",
        });
        throw new Error("rollback");
      }),
      /rollback/,
    );

    assert.equal(
      context.database.prepare("SELECT COUNT(*) AS count FROM wifi_event_inbox").get().count,
      0,
    );
    assert.equal(
      context.database.prepare("SELECT COUNT(*) AS count FROM wifi_presence_sessions").get().count,
      0,
    );

    await context.repository.transaction(async (repository) => {
      await repository.insertPresenceSession({
        id: "presence-commit",
        employeeNumber: "E18",
        locationId: "18",
        providerId: "radius",
        correlationHash: "2".repeat(64),
        occurredAt: "2026-07-29T08:00:00.000Z",
      });
      await repository.closePresenceSession({
        id: "presence-commit",
        endAt: "2026-07-29T16:00:00.000Z",
        state: "closed",
      });
      await repository.insertSuggestion({
        id: "suggestion-commit",
        presenceSessionId: "presence-commit",
        employeeNumber: "E18",
        locationId: "18",
        workDate: "2026-07-29",
        suggestedStartAt: "2026-07-29T08:00:00.000Z",
        suggestedEndAt: "2026-07-29T16:00:00.000Z",
        confirmationLevel: "A",
        minimumPresenceMinutes: 5,
        absenceGraceMinutes: 30,
        confirmationDueAt: "2026-08-02T21:00:00.000Z",
      });
    });

    assert.equal(
      (await context.repository.getSuggestionForEmployee({
        id: "suggestion-commit",
        employeeNumber: "E18",
      })).status,
      "pending",
    );
  } finally {
    await context.close();
  }
});

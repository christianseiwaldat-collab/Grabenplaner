"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  createBusinessUnit,
  createCollectiveAgreement,
  listBusinessUnits,
  listCollectiveAgreementAssignments,
  listCollectiveAgreements,
  prepareCollectiveAgreementAssignment,
} = require("../lib/collective-agreements");
const {
  createCollectiveAgreementsRepository,
} = require("../lib/persistence/repositories/collective-agreements");
const {
  SQLITE_COLLECTIVE_AGREEMENTS_CATALOG,
} = require("../lib/persistence/sqlite/collective-agreements-catalog");
const {
  ensureSqliteCollectiveAgreementsSchema,
} = require("../lib/persistence/sqlite/operations/collective-agreements-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");

function documentedVersion(marker = "V1") {
  return {
    versionLabel: "2026",
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    externalPublishedOn: "2025-12-15",
    sourceTitle: `${marker} official source`,
    sourceUrl: `https://example.invalid/${marker.toLowerCase()}.pdf`,
    sourceRetrievedOn: "2026-07-29",
    sourceSha256: crypto.createHash("sha256").update(marker).digest("hex"),
    sourceNote: "Documented source fixture.",
    contractingParties: ["Employer side", "Employee side"],
    territorialScope: "Austria",
    functionalScope: "Retail",
    personalScope: "Employees",
    employeeGroups: ["Employees"],
    workTimeParametersNote: "No automatic legal assessment.",
    classificationNote: "Manual classification remains required.",
    apprenticeRelevance: "unknown",
    apprenticeNote: "",
  };
}

async function fixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_COLLECTIVE_AGREEMENTS_CATALOG,
  });
  application.database.exec(`
    CREATE TABLE work_rule_profile_versions (
      id TEXT PRIMARY KEY,
      layer TEXT NOT NULL
    );
    CREATE TABLE cost_centers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY,
      location_id TEXT NOT NULL,
      name TEXT NOT NULL
    );
    INSERT INTO locations (id, name) VALUES ('01', 'Hauptstandort');
    INSERT INTO departments (id, location_id, name)
      VALUES (10, '01', 'Verkauf');
  `);
  ensureSqliteCollectiveAgreementsSchema(application.database);
  application.database.exec(`
    CREATE TABLE collective_agreement_assignment_events (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      effective_on TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
  `);
  return {
    ...application,
    repository: createCollectiveAgreementsRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

test("Block 3/7: Kollektivvertragsregister nutzt nur Repository und Provider", async () => {
  const context = await fixture();
  try {
    const agreement = await createCollectiveAgreement(context.repository, {
      code: "KV-RETAIL",
      title: "Collective agreement retail",
      shortTitle: "Retail",
      jurisdiction: "AT",
      note: "Provider regression fixture.",
      version: documentedVersion(),
    }, "E1");
    const businessUnit = await createBusinessUnit(context.repository, {
      code: "BU-RETAIL",
      name: "Retail unit",
      legalEntityName: "Example GmbH",
      description: "Provider regression fixture.",
      scopes: [{
        scopeType: "department",
        scopeKey: "10",
      }],
    }, "E1");
    const assignment = await prepareCollectiveAgreementAssignment(context.repository, {
      agreementVersionId: agreement.currentVersionId,
      businessUnitId: businessUnit.id,
      validFrom: "2026-01-01",
      validTo: "2026-12-31",
      rationale: "The documented scope requires a manual applicability review.",
      referenceNote: "Provider regression fixture.",
    }, "E1");

    assert.equal(agreement.code, "KV-RETAIL");
    assert.equal(agreement.versions.length, 1);
    assert.equal(agreement.versions[0].contentSha256.length, 64);
    assert.equal(businessUnit.scopes[0].scopeType, "department");
    assert.match(businessUnit.scopes[0].label, /Verkauf/);
    assert.equal(assignment.reviewState, "review_pending");
    context.database.prepare(`
      INSERT INTO collective_agreement_assignment_events (
        id, assignment_id, event_type, effective_on, occurred_at
      ) VALUES (?, ?, 'approved', '2026-01-01', '2026-07-29T12:00:00.000Z')
    `).run("event-1", assignment.id);
    assert.deepEqual(await context.repository.listAssignmentGovernanceEvents(), [{
      assignment_id: assignment.id,
      event_type: "approved",
      effective_on: "2026-01-01",
      occurred_at: "2026-07-29T12:00:00.000Z",
      id: "event-1",
    }]);
    assert.equal((await listCollectiveAgreements(context.repository)).length, 1);
    assert.equal((await listBusinessUnits(context.repository)).length, 1);
    assert.equal((await listCollectiveAgreementAssignments(context.repository)).length, 1);
  } finally {
    await context.close();
  }
});

test("Block 3/7: fachliche Fehler rollen Providertransaktionen vollständig zurück", async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      createBusinessUnit(context.repository, {
        code: "BU-ROLLBACK",
        name: "Invalid unit",
        legalEntityName: "Example GmbH",
        scopes: [{
          scopeType: "department",
          scopeKey: "999",
        }],
      }, "E1"),
      /nicht gefunden/,
    );
    assert.deepEqual(await listBusinessUnits(context.repository), []);
  } finally {
    await context.close();
  }
});

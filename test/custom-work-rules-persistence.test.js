"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createCustomWorkRulesRepository,
} = require("../lib/persistence/repositories/custom-work-rules");
const {
  SQLITE_CUSTOM_WORK_RULES_CATALOG,
} = require("../lib/persistence/sqlite/custom-work-rules-catalog");
const {
  ensureSqliteWorkRuleStoreSchema,
} = require("../lib/persistence/sqlite/operations/work-rule-store-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  addCustomWorkRuleDraftRevision,
  createCustomWorkRuleDraft,
  getCustomWorkRuleDraft,
  listCustomWorkRuleDrafts,
  publishCustomWorkRuleDraft,
  restoreCustomWorkRuleVersionAsDraft,
  simulateCustomWorkRuleDraft,
} = require("../lib/work-rules/custom-rules");

function createFixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_CUSTOM_WORK_RULES_CATALOG,
  });
  ensureSqliteWorkRuleStoreSchema(application.database);
  application.database.exec(`
    CREATE TABLE collective_agreement_business_units (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE locations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY,
      location_id TEXT NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (location_id) REFERENCES locations(id)
    );
    CREATE TABLE work_rule_publications (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      source_profile_version_id TEXT NOT NULL UNIQUE,
      released_profile_version_id TEXT NOT NULL UNIQUE,
      published_at TEXT NOT NULL
    );
    INSERT INTO collective_agreement_business_units (id, code, name)
    VALUES ('unit-1', 'BU-01', 'Zentrale');
    INSERT INTO locations (id, name) VALUES ('18', 'Nordpark');
    INSERT INTO departments (id, location_id, name)
    VALUES (7, '18', 'Verkauf');
  `);
  return {
    database: application.database,
    repository: createCustomWorkRulesRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

function draftPayload(overrides = {}) {
  return {
    code: "LOCAL-DAILY-LIMIT",
    title: "Tägliche Planungsgrenze",
    description: "Dokumentierte betriebliche Planungsgrenze für den Testbetrieb.",
    ruleType: "company_rule",
    topic: "working_time",
    scopeType: "department",
    scopeKey: "7",
    validFrom: "2026-08-01",
    validTo: "",
    metric: "maximum_planned_daily_minutes",
    threshold: 480,
    severity: "warning",
    reaction: "advisory",
    message: "Die dokumentierte tägliche Planungsgrenze wurde überschritten.",
    responsibleUnit: "Personalverwaltung",
    sourceTitle: "Interne Arbeitszeitregel",
    sourceReference: "BV-AZ-2026, Abschnitt 3",
    sourceUrl: "",
    sourceNote: "Freigabe erfolgt ausschließlich über den Governance-Workflow.",
    testCases: {
      positiveValue: 480,
      negativeValue: 481,
    },
    ...overrides,
  };
}

test("Eigene Arbeitszeitregeln: Fachmodul enthält keinen Datenbankzugriff oder SQL", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "lib", "work-rules", "custom-rules.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /\bdb\b|\.prepare\s*\(|\.exec\s*\(/);
  assert.doesNotMatch(source, /\b(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/i);
});

test("Eigene Arbeitszeitregeln: Entwurf, Revision, Publikation und Wiederherstellung laufen über das Repository", async () => {
  const fixture = createFixture();
  const { repository } = fixture;
  try {
    const simulation = await simulateCustomWorkRuleDraft(repository, draftPayload());
    assert.equal(simulation.valid, true);
    assert.deepEqual(
      simulation.testCases.map(({ actual }) => actual),
      ["pass", "fail", "unknown"],
    );

    const draft = await createCustomWorkRuleDraft(repository, draftPayload(), "E-1");
    assert.equal(draft.id, "custom:LOCAL-DAILY-LIMIT");
    assert.equal(draft.currentVersion.versionLabel, "draft-1");
    assert.equal(draft.currentVersion.definition.scopeLabel, "18 · Nordpark · Verkauf");

    const revised = await addCustomWorkRuleDraftRevision(
      repository,
      draft.id,
      draftPayload({
        title: "Tägliche Planungsgrenze, Fassung 2",
        threshold: 450,
        testCases: {
          positiveValue: 450,
          negativeValue: 451,
        },
      }),
      "E-2",
    );
    assert.equal(revised.currentVersion.versionLabel, "draft-2");

    const release = await publishCustomWorkRuleDraft(
      repository,
      revised.currentVersionId,
      "E-3",
    );
    assert.equal(release.releaseVersion, "release-1");
    assert.match(release.contentSha256, /^[a-f0-9]{64}$/);

    const restored = await restoreCustomWorkRuleVersionAsDraft(
      repository,
      release.releasedVersionId,
      "E-4",
    );
    assert.equal(restored.currentVersion.versionLabel, "draft-3");
    assert.equal(restored.hasUnreleasedDraft, true);

    const listed = await listCustomWorkRuleDrafts(repository);
    assert.equal(listed.length, 1);
    assert.equal(
      (await getCustomWorkRuleDraft(repository, draft.id)).currentVersion.id,
      restored.currentVersion.id,
    );
  } finally {
    await fixture.close();
  }
});

test("Eigene Arbeitszeitregeln: gebundene Repository-Transaktion rollt den gesamten Entwurf zurück", async () => {
  const fixture = createFixture();
  const { database, repository } = fixture;
  try {
    await assert.rejects(
      repository.transaction(async (transaction) => {
        await createCustomWorkRuleDraft(
          transaction,
          draftPayload({ code: "ROLLBACK-RULE" }),
          "E-5",
        );
        throw new Error("rollback requested");
      }),
      /rollback requested/,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM work_rule_profiles").get().count,
      0,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM work_rule_profile_versions").get().count,
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("Eigene Arbeitszeitregeln: fehlende aktive Scope-Zuordnung hinterlässt keine Teil-Daten", async () => {
  const fixture = createFixture();
  const { database, repository } = fixture;
  try {
    await assert.rejects(
      createCustomWorkRuleDraft(
        repository,
        draftPayload({ code: "INVALID-SCOPE", scopeKey: "999" }),
        "E-6",
      ),
      /aktive Abteilung wurde nicht gefunden/i,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM work_rule_profiles").get().count,
      0,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM work_rule_profile_versions").get().count,
      0,
    );
  } finally {
    await fixture.close();
  }
});

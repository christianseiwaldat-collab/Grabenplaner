"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BUILTIN_WORK_RULE_PROFILES,
  SOURCE_CATALOG,
  canonicalSha256,
} = require("../lib/work-rules");
const {
  SQLITE_WORK_RULE_STORE_CATALOG,
} = require("../lib/persistence/sqlite/work-rule-store-catalog");
const {
  dropSqliteWorkRuleEvaluationReceiptTriggers,
  ensureSqliteWorkRuleEvaluationReceiptTriggers,
  ensureSqliteWorkRuleStoreSchema,
} = require("../lib/persistence/sqlite/operations/work-rule-store-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  createWorkRuleStoreRepository,
} = require("../lib/persistence/repositories/work-rule-store");
const {
  getWorkRuleEvaluation,
  getWorkRuleProfileVersion,
  listWorkRuleAssignments,
  listWorkRuleEvaluations,
  listWorkRuleProfiles,
  profileVersionId,
  recordWorkRuleEvaluation,
  resolveWorkRuleAssignment,
  saveWorkRuleAssignment,
  seedBuiltinWorkRuleProfiles,
  versionSnapshot,
} = require("../lib/work-rules/store");

function createFixture() {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_WORK_RULE_STORE_CATALOG,
  });
  ensureSqliteWorkRuleStoreSchema(application.database);
  application.database.exec(`
    CREATE TABLE shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_number TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_id INTEGER,
      shift_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      area TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE time_day_reviews (
      employee_number TEXT NOT NULL,
      work_date TEXT NOT NULL,
      location_id TEXT NOT NULL,
      department_key INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE work_rule_exceptions (
      id TEXT PRIMARY KEY,
      evaluation_id TEXT NOT NULL,
      finding_fingerprint TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      profile_version_id TEXT NOT NULL,
      exception_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'active',
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_by TEXT,
      revoked_at TEXT
    );
  `);
  return {
    database: application.database,
    repository: createWorkRuleStoreRepository(application.provider),
    async close() {
      await application.provider.close();
      application.database.close();
    },
  };
}

function seed(repository) {
  return seedBuiltinWorkRuleProfiles(
    repository,
    BUILTIN_WORK_RULE_PROFILES,
    SOURCE_CATALOG,
    { actor: "test-system" },
  );
}

test("Arbeitszeitregel-Store: Seed verarbeitet Profil-Bundles vollständig und idempotent", async () => {
  const fixture = createFixture();
  const { database, repository } = fixture;
  try {
    await seed(repository);
    await seed(repository);

    const profiles = await listWorkRuleProfiles(repository);
    assert.equal(profiles.length, 4);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM work_rule_profile_versions").get().count, 4);
    const profileHashes = Object.fromEntries(database.prepare(`
      SELECT id, content_sha256 FROM work_rule_profile_versions ORDER BY id
    `).all().map((row) => [row.id, row.content_sha256]));
    assert.deepEqual({
      "at-general-adult@2026.1": profileHashes["at-general-adult@2026.1"],
      "at-retail-adult-monitor@2026.1": profileHashes["at-retail-adult-monitor@2026.1"],
      "at-retail-kv-2026-draft@2026.1-draft": profileHashes["at-retail-kv-2026-draft@2026.1-draft"],
    }, {
      "at-general-adult@2026.1": "2d0b128182fe737940f3d855ee2eee9b92f06a2be25df0c557d2080a885b121c",
      "at-retail-adult-monitor@2026.1": "26372bbd513f1eb81771441acd2f20a8aab3fa942c2b656ea6d38017d100db04",
      "at-retail-kv-2026-draft@2026.1-draft": "0bc5875a8d18cdb3ea6f04b54bbb59e24cc689dd33eb810e8308b77615cb7474",
    });
    assert.equal(
      profileHashes["at-retail-youth-monitor@2026.2"],
      "50019077b97f4050e65c24bbdd4481317aad09bfea3035b5a6fb5f60125fc4aa",
    );
    const retail = profiles.find(({ id }) => id === "at-retail-adult-monitor");
    assert.equal(retail.status, "active");
    assert.equal(retail.versionStatus, "published");
    assert.equal(retail.currentVersionId, "at-retail-adult-monitor@2026.1");
    assert.ok(retail.rules.rules.some(({ id }) => id === "at.azg.maximum.daily"));
    assert.ok(retail.sources.some(({ id }) => id === "ris.azg.9"));
    const legacyVersion = await getWorkRuleProfileVersion(
      repository,
      "at-retail-adult-monitor@2026.1",
    );
    assert.equal(legacyVersion.schemaVersion, 1);
    assert.equal(legacyVersion.profile.assignable, true);
    assert.equal(legacyVersion.rules.find(({ id }) => id === "at.azg.maximum.daily").severity, "critical");

    const youthVersion = await getWorkRuleProfileVersion(
      repository,
      "at-retail-youth-monitor@2026.2",
    );
    assert.equal(youthVersion.schemaVersion, 2);
    assert.equal(youthVersion.profile.assignable, false);
    assert.equal(youthVersion.profile.applicability.automaticByBirthDate, true);
    assert.ok(youthVersion.rules.some(({ id }) => id === "at.kjbg.retail.saturday-monday"));

    const draft = profiles.find(({ id }) => id === "at-retail-kv-2026-draft");
    assert.equal(draft.status, "draft");
    assert.equal(draft.currentVersionId, null);

    const assignments = await listWorkRuleAssignments(repository);
    assert.equal(assignments.length, 1);
    assert.deepEqual({
      id: assignments[0].id,
      scopeType: assignments[0].scopeType,
      scopeKey: assignments[0].scopeKey,
      enforcementMode: assignments[0].enforcementMode,
      applicabilityConfirmed: assignments[0].applicabilityConfirmed,
    }, {
      id: "builtin:at-retail-adult-monitor:installation",
      scopeType: "installation",
      scopeKey: "",
      enforcementMode: "monitor",
      applicabilityConfirmed: false,
    });
  } finally {
    await fixture.close();
  }
});

test("Arbeitszeitregel-Store: Planungsmutation und Prüfbeleg teilen Commit oder Rollback", async () => {
  const fixture = createFixture();
  const { database, repository } = fixture;
  try {
    await seed(repository);
    const result = {
      engineVersion: "at-planned-work-evaluator-v1",
      basis: "planned_schedule",
      profile: { id: "at-retail-adult-monitor", version: "2026.1" },
      summary: { state: "pass", counts: { pass: 1, fail: 0, unknown: 0 } },
      findings: [],
    };
    const evaluation = {
      targetType: "planned_schedule",
      scopeType: "location",
      scopeKey: "01",
      periodFrom: "2026-07-20",
      periodTo: "2026-07-26",
      profileVersionIds: ["at-retail-adult-monitor@2026.1"],
      inputSha256: canonicalSha256({ week: "2026-07-20", locationId: "01" }),
      result,
      outcome: "pass",
      actor: "test-system",
    };
    const shift = {
      employeeNumber: "419",
      locationId: "01",
      departmentId: null,
      shiftDate: "2026-07-20",
      startTime: "09:00",
      endTime: "17:00",
      area: "Verkauf",
      note: "",
    };

    await assert.rejects(repository.transaction(async (transaction) => {
      await transaction.insertPlanningShift(shift);
      await recordWorkRuleEvaluation(transaction, {
        ...evaluation,
        id: "rollback-evaluation",
      });
      throw new Error("rollback requested");
    }), /rollback requested/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shifts").get().count, 0);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM work_rule_evaluation_runs").get().count,
      0,
    );

    await repository.transaction(async (transaction) => {
      await transaction.insertPlanningShift(shift);
      await recordWorkRuleEvaluation(transaction, {
        ...evaluation,
        id: "committed-evaluation",
      });
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shifts").get().count, 1);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM work_rule_evaluation_runs").get().count,
      1,
    );
    assert.equal(
      (await getWorkRuleEvaluation(repository, "committed-evaluation")).receiptHashValid,
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("Arbeitszeitregel-Store: Versionssnapshot, Hash und SQLite-Trigger schützen unveränderliche Fassungen", async () => {
  const fixture = createFixture();
  const { database, repository } = fixture;
  try {
    await seed(repository);
    const bundle = BUILTIN_WORK_RULE_PROFILES["at-retail-adult-monitor"];
    const expected = canonicalSha256(versionSnapshot(bundle.profile, bundle.rules, bundle.sources));
    const stored = database.prepare(`
      SELECT content_sha256 FROM work_rule_profile_versions WHERE id = ?
    `).get(profileVersionId(bundle.profile));
    assert.equal(stored.content_sha256, expected);
    assert.equal(stored.content_sha256, "26372bbd513f1eb81771441acd2f20a8aab3fa942c2b656ea6d38017d100db04");

    assert.throws(
      () => database.prepare("UPDATE work_rule_profile_versions SET status = 'retired' WHERE id = ?")
        .run(profileVersionId(bundle.profile)),
      /immutable/i,
    );
    assert.throws(
      () => database.prepare("DELETE FROM work_rule_profile_versions WHERE id = ?")
        .run(profileVersionId(bundle.profile)),
      /immutable/i,
    );

    const changed = JSON.parse(JSON.stringify(BUILTIN_WORK_RULE_PROFILES));
    changed["at-retail-adult-monitor"].profile.limits.maximumDailyMinutes = 999;
    await assert.rejects(
      seedBuiltinWorkRuleProfiles(repository, changed, SOURCE_CATALOG, { actor: "changed-build" }),
      /stimmt nicht mit dem eingebauten Katalog/i,
    );
    assert.equal(
      database.prepare("SELECT content_sha256 FROM work_rule_profile_versions WHERE id = ?")
        .get(profileVersionId(bundle.profile)).content_sha256,
      expected,
    );
  } finally {
    await fixture.close();
  }
});

test("Arbeitszeitregel-Store: Zuordnungen beachten Gültigkeit und employee > department > location > installation", async () => {
  const fixture = createFixture();
  const { repository } = fixture;
  try {
    await seed(repository);
    const profileVersion = "at-retail-adult-monitor@2026.1";
    await saveWorkRuleAssignment(repository, {
      id: "location-18",
      profileVersionId: profileVersion,
      scopeType: "location",
      scopeKey: "18",
      validFrom: "2026-01-01",
      enforcementMode: "monitor",
      applicabilityConfirmed: false,
    }, "252");
    await saveWorkRuleAssignment(repository, {
      id: "department-hardware",
      profileVersionId: profileVersion,
      scopeType: "department",
      scopeKey: "hardware",
      validFrom: "2026-03-01",
      enforcementMode: "enforced",
      applicabilityConfirmed: true,
    }, "252");
    await saveWorkRuleAssignment(repository, {
      id: "employee-419-old",
      profileVersionId: profileVersion,
      scopeType: "employee",
      scopeKey: "419",
      validFrom: "2026-04-01",
      enforcementMode: "monitor",
      applicabilityConfirmed: true,
    }, "252");
    await saveWorkRuleAssignment(repository, {
      id: "employee-419-new",
      profileVersionId: profileVersion,
      scopeType: "employee",
      scopeKey: "419",
      validFrom: "2026-07-01",
      validTo: "2026-12-31",
      enforcementMode: "enforced",
      applicabilityConfirmed: true,
    }, "252");

    assert.equal((await resolveWorkRuleAssignment(repository, {
      date: "2026-07-23",
      locationId: "18",
      departmentId: "hardware",
      employeeNumber: "419",
    })).id, "employee-419-new");
    assert.equal((await resolveWorkRuleAssignment(repository, {
      date: "2027-01-01",
      locationId: "18",
      departmentId: "hardware",
      employeeNumber: "999",
    })).id, "department-hardware");
    assert.equal((await resolveWorkRuleAssignment(repository, {
      date: "2026-02-01",
      locationId: "18",
      departmentId: "fotowelt",
      employeeNumber: "999",
    })).id, "location-18");
    assert.equal((await resolveWorkRuleAssignment(repository, {
      date: "2026-02-01",
      locationId: "05",
      departmentId: "fotowelt",
      employeeNumber: "999",
    })).id, "builtin:at-retail-adult-monitor:installation");

    await assert.rejects(saveWorkRuleAssignment(repository, {
      profileVersionId: profileVersion,
      scopeType: "location",
      scopeKey: "18",
      validFrom: "2026-10-01",
      validTo: "2026-09-30",
    }, "252"), /darf nicht vor/i);
    await assert.rejects(saveWorkRuleAssignment(repository, {
      profileVersionId: profileVersion,
      scopeType: "location",
      scopeKey: "18",
      validFrom: "2026-07-01",
      enforcementMode: "enforced",
      applicabilityConfirmed: false,
    }, "252"), /nicht bestätigtes Regelprofil/i);
    await assert.rejects(saveWorkRuleAssignment(repository, {
      profileVersionId: "at-retail-youth-monitor@2026.2",
      scopeType: "employee",
      scopeKey: "420",
      validFrom: "2026-07-01",
      enforcementMode: "monitor",
      applicabilityConfirmed: true,
    }, "252"), /ausschließlich automatisch/i);
    await assert.rejects(
      resolveWorkRuleAssignment(repository, { date: "23.07.2026" }),
      /YYYY-MM-DD/i,
    );
  } finally {
    await fixture.close();
  }
});

test("Arbeitszeitregel-Store: dokumentierte Ausnahmen bleiben providergebunden", async () => {
  const fixture = createFixture();
  const { repository } = fixture;
  try {
    await seed(repository);
    assert.equal(await repository.profileVersionExists("at-retail-adult-monitor@2026.1"), true);
    await repository.insertException({
      id: "exception-1",
      evaluationId: "evaluation-1",
      findingFingerprint: "a".repeat(64),
      ruleId: "at.azg.maximum.daily",
      profileVersionId: "at-retail-adult-monitor@2026.1",
      exceptionType: "documented_exception",
      reason: "Nachvollziehbare Testbegründung",
      evidence: "Testnachweis",
      validFrom: "2026-07-29",
      validTo: null,
      actor: "E1",
    });
    assert.equal((await repository.listExceptions("active"))[0].id, "exception-1");
    assert.equal((await repository.revokeException({
      id: "exception-1",
      actor: "E1",
      evidence: "Widerruf: Testbegründung",
    })).rowsAffected, 1);
    assert.equal((await repository.getException("exception-1")).state, "revoked");
  } finally {
    await fixture.close();
  }
});

test("Arbeitszeitregel-Store: kanonischer Evaluation-Receipt erkennt Manipulationen am gesamten Prüfbeleg", async () => {
  const fixture = createFixture();
  const { database, repository } = fixture;
  try {
    await seed(repository);
    const result = {
      engineVersion: "at-planned-work-evaluator-v1",
      basis: "planned_schedule",
      profile: { id: "at-retail-adult-monitor", version: "2026.1" },
      summary: { state: "fail", counts: { pass: 8, fail: 1, unknown: 0 } },
      findings: [{ ruleId: "at.azg.maximum.daily", state: "fail", fingerprint: "finding-1" }],
    };
    const inputSha256 = canonicalSha256({
      employeeNumber: "419",
      periodFrom: "2026-07-20",
      periodTo: "2026-07-25",
    });
    const receipt = await recordWorkRuleEvaluation(repository, {
      id: "evaluation-1",
      targetType: "planned_schedule",
      scopeType: "employee",
      scopeKey: "419",
      periodFrom: "2026-07-20",
      periodTo: "2026-07-25",
      profileVersionIds: ["at-retail-adult-monitor@2026.1"],
      inputSha256,
      result,
      outcome: "attention",
      actor: "252",
    });

    assert.equal(receipt.id, "evaluation-1");
    assert.equal(receipt.resultHashValid, true);
    assert.equal(receipt.receiptHashValid, true);
    assert.equal(receipt.resultSha256, canonicalSha256(result));
    assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.receiptSha256, canonicalSha256({
      schemaVersion: 1,
      id: "evaluation-1",
      targetType: "planned_schedule",
      scopeType: "employee",
      scopeKey: "419",
      periodFrom: "2026-07-20",
      periodTo: "2026-07-25",
      profileVersionIds: ["at-retail-adult-monitor@2026.1"],
      inputSha256,
      resultSha256: canonicalSha256(result),
      outcome: "attention",
      result,
      createdBy: "252",
      createdAt: receipt.createdAt,
    }));
    assert.deepEqual((await getWorkRuleEvaluation(repository, "evaluation-1")).result, result);
    const listedEvaluation = (await listWorkRuleEvaluations(repository))[0];
    assert.deepEqual({
      resultSha256: listedEvaluation.resultSha256,
      receiptSha256: listedEvaluation.receiptSha256,
      receiptHashValid: listedEvaluation.receiptHashValid,
    }, {
      resultSha256: receipt.resultSha256,
      receiptSha256: receipt.receiptSha256,
      receiptHashValid: true,
    });

    ensureSqliteWorkRuleEvaluationReceiptTriggers(database);
    assert.throws(
      () => database.prepare(`
        UPDATE work_rule_evaluation_runs
        SET outcome = 'pass'
        WHERE id = ?
      `).run("evaluation-1"),
      /immutable/i,
    );
    dropSqliteWorkRuleEvaluationReceiptTriggers(database);

    const original = database.prepare(`
      SELECT * FROM work_rule_evaluation_runs WHERE id = ?
    `).get("evaluation-1");
    const mutations = [
      ["target_type", "actual_time"],
      ["scope_type", "location"],
      ["scope_key", "18"],
      ["period_from", "2026-07-19"],
      ["period_to", "2026-07-26"],
      ["profile_version_ids_json", JSON.stringify(["at-general-adult@2026.1"])],
      ["input_sha256", "a".repeat(64)],
      ["result_sha256", "b".repeat(64)],
      ["outcome", "pass"],
      ["result_json", JSON.stringify({
        ...result,
        findings: [{ ...result.findings[0], state: "pass" }],
      })],
      ["created_by", "999"],
      ["created_at", "1999-01-01T00:00:00.000Z"],
    ];
    for (const [column, changedValue] of mutations) {
      database.prepare(`UPDATE work_rule_evaluation_runs SET ${column} = ? WHERE id = ?`)
        .run(changedValue, "evaluation-1");
      await assert.rejects(
        getWorkRuleEvaluation(repository, "evaluation-1"),
        /Prüfbeleg-Prüfsumme/i,
        `Manipulation an ${column} muss erkannt werden`,
      );
      const unverified = await getWorkRuleEvaluation(
        repository,
        "evaluation-1",
        { verify: false },
      );
      assert.equal(unverified.receiptHashValid, false, column);
      assert.equal(
        unverified.resultHashValid,
        !["result_json", "result_sha256"].includes(column),
        column,
      );
      assert.equal(
        (await listWorkRuleEvaluations(repository))[0].receiptHashValid,
        false,
        column,
      );
      database.prepare(`UPDATE work_rule_evaluation_runs SET ${column} = ? WHERE id = ?`)
        .run(original[column], "evaluation-1");
      assert.equal(
        (await getWorkRuleEvaluation(repository, "evaluation-1")).receiptHashValid,
        true,
        column,
      );
    }

    await assert.rejects(recordWorkRuleEvaluation(repository, {
      targetType: "planned_schedule",
      periodFrom: "2026-07-20",
      periodTo: "2026-07-25",
      profileVersionIds: ["unknown@1"],
      inputSha256,
      result,
      outcome: "pass",
    }), /unbekannte Regelprofil-Version/i);
    await assert.rejects(recordWorkRuleEvaluation(repository, {
      targetType: "planned_schedule",
      periodFrom: "2026-07-20",
      periodTo: "2026-07-25",
      profileVersionIds: ["at-retail-adult-monitor@2026.1"],
      inputSha256: "not-a-hash",
      result,
      outcome: "pass",
    }), /SHA-256/i);
  } finally {
    await fixture.close();
  }
});

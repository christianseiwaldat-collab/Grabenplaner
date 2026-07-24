"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const {
  BUILTIN_WORK_RULE_PROFILES,
  SOURCE_CATALOG,
  canonicalSha256,
} = require("../lib/work-rules");
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

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE work_rule_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      jurisdiction TEXT NOT NULL DEFAULT 'AT',
      sector TEXT NOT NULL DEFAULT 'general',
      builtin INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','active','retired')),
      current_version_id TEXT,
      created_by TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE work_rule_profile_versions (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      version TEXT NOT NULL,
      layer TEXT NOT NULL
        CHECK(layer IN ('law','sector','collective_agreement','company','contract')),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','published','retired')),
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      rules_json TEXT NOT NULL,
      sources_json TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      published_at TEXT,
      UNIQUE(profile_id, version),
      FOREIGN KEY (profile_id) REFERENCES work_rule_profiles(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE work_rule_assignments (
      id TEXT PRIMARY KEY,
      profile_version_id TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'installation'
        CHECK(scope_type IN ('installation','location','department','employee')),
      scope_key TEXT NOT NULL DEFAULT '',
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      enforcement_mode TEXT NOT NULL DEFAULT 'monitor'
        CHECK(enforcement_mode IN ('monitor','enforced')),
      applicability_confirmed INTEGER NOT NULL DEFAULT 0,
      confirmed_by TEXT NOT NULL DEFAULT '',
      confirmed_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_version_id) REFERENCES work_rule_profile_versions(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE work_rule_evaluation_runs (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL
        CHECK(target_type IN ('planned_schedule','actual_time')),
      scope_type TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      period_from TEXT NOT NULL,
      period_to TEXT NOT NULL,
      profile_version_ids_json TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      result_sha256 TEXT NOT NULL,
      result_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      outcome TEXT NOT NULL
        CHECK(outcome IN ('pass','attention','manual_review','blocked')),
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TRIGGER trg_work_rule_profile_versions_immutable_update
    BEFORE UPDATE ON work_rule_profile_versions
    BEGIN
      SELECT RAISE(ABORT, 'work rule profile versions are immutable');
    END;

    CREATE TRIGGER trg_work_rule_profile_versions_immutable_delete
    BEFORE DELETE ON work_rule_profile_versions
    BEGIN
      SELECT RAISE(ABORT, 'work rule profile versions are immutable');
    END;
  `);
  return database;
}

function seed(database) {
  seedBuiltinWorkRuleProfiles(
    database,
    BUILTIN_WORK_RULE_PROFILES,
    SOURCE_CATALOG,
    { actor: "test-system" },
  );
}

test("Arbeitszeitregel-Store: Seed verarbeitet Profil-Bundles vollständig und idempotent", () => {
  const database = createDatabase();
  try {
    seed(database);
    seed(database);

    const profiles = listWorkRuleProfiles(database);
    assert.equal(profiles.length, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM work_rule_profile_versions").get().count, 3);
    assert.deepEqual(Object.fromEntries(database.prepare(`
      SELECT id, content_sha256 FROM work_rule_profile_versions ORDER BY id
    `).all().map((row) => [row.id, row.content_sha256])), {
      "at-general-adult@2026.1": "2d0b128182fe737940f3d855ee2eee9b92f06a2be25df0c557d2080a885b121c",
      "at-retail-adult-monitor@2026.1": "26372bbd513f1eb81771441acd2f20a8aab3fa942c2b656ea6d38017d100db04",
      "at-retail-kv-2026-draft@2026.1-draft": "0bc5875a8d18cdb3ea6f04b54bbb59e24cc689dd33eb810e8308b77615cb7474",
    });
    const retail = profiles.find(({ id }) => id === "at-retail-adult-monitor");
    assert.equal(retail.status, "active");
    assert.equal(retail.versionStatus, "published");
    assert.equal(retail.currentVersionId, "at-retail-adult-monitor@2026.1");
    assert.ok(retail.rules.rules.some(({ id }) => id === "at.azg.maximum.daily"));
    assert.ok(retail.sources.some(({ id }) => id === "ris.azg.9"));
    const legacyVersion = getWorkRuleProfileVersion(database, "at-retail-adult-monitor@2026.1");
    assert.equal(legacyVersion.schemaVersion, 1);
    assert.equal(legacyVersion.profile.assignable, true);
    assert.equal(legacyVersion.rules.find(({ id }) => id === "at.azg.maximum.daily").severity, "critical");

    const draft = profiles.find(({ id }) => id === "at-retail-kv-2026-draft");
    assert.equal(draft.status, "draft");
    assert.equal(draft.currentVersionId, null);

    const assignments = listWorkRuleAssignments(database);
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
    database.close();
  }
});

test("Arbeitszeitregel-Store: Versionssnapshot, Hash und SQLite-Trigger schützen unveränderliche Fassungen", () => {
  const database = createDatabase();
  try {
    seed(database);
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
    assert.throws(
      () => seedBuiltinWorkRuleProfiles(database, changed, SOURCE_CATALOG, { actor: "changed-build" }),
      /stimmt nicht mit dem eingebauten Katalog/i,
    );
    assert.equal(
      database.prepare("SELECT content_sha256 FROM work_rule_profile_versions WHERE id = ?")
        .get(profileVersionId(bundle.profile)).content_sha256,
      expected,
    );
  } finally {
    database.close();
  }
});

test("Arbeitszeitregel-Store: Zuordnungen beachten Gültigkeit und employee > department > location > installation", () => {
  const database = createDatabase();
  try {
    seed(database);
    const profileVersion = "at-retail-adult-monitor@2026.1";
    saveWorkRuleAssignment(database, {
      id: "location-18",
      profileVersionId: profileVersion,
      scopeType: "location",
      scopeKey: "18",
      validFrom: "2026-01-01",
      enforcementMode: "monitor",
      applicabilityConfirmed: false,
    }, "252");
    saveWorkRuleAssignment(database, {
      id: "department-hardware",
      profileVersionId: profileVersion,
      scopeType: "department",
      scopeKey: "hardware",
      validFrom: "2026-03-01",
      enforcementMode: "enforced",
      applicabilityConfirmed: true,
    }, "252");
    saveWorkRuleAssignment(database, {
      id: "employee-419-old",
      profileVersionId: profileVersion,
      scopeType: "employee",
      scopeKey: "419",
      validFrom: "2026-04-01",
      enforcementMode: "monitor",
      applicabilityConfirmed: true,
    }, "252");
    saveWorkRuleAssignment(database, {
      id: "employee-419-new",
      profileVersionId: profileVersion,
      scopeType: "employee",
      scopeKey: "419",
      validFrom: "2026-07-01",
      validTo: "2026-12-31",
      enforcementMode: "enforced",
      applicabilityConfirmed: true,
    }, "252");

    assert.equal(resolveWorkRuleAssignment(database, {
      date: "2026-07-23",
      locationId: "18",
      departmentId: "hardware",
      employeeNumber: "419",
    }).id, "employee-419-new");
    assert.equal(resolveWorkRuleAssignment(database, {
      date: "2027-01-01",
      locationId: "18",
      departmentId: "hardware",
      employeeNumber: "999",
    }).id, "department-hardware");
    assert.equal(resolveWorkRuleAssignment(database, {
      date: "2026-02-01",
      locationId: "18",
      departmentId: "fotowelt",
      employeeNumber: "999",
    }).id, "location-18");
    assert.equal(resolveWorkRuleAssignment(database, {
      date: "2026-02-01",
      locationId: "05",
      departmentId: "fotowelt",
      employeeNumber: "999",
    }).id, "builtin:at-retail-adult-monitor:installation");

    assert.throws(() => saveWorkRuleAssignment(database, {
      profileVersionId: profileVersion,
      scopeType: "location",
      scopeKey: "18",
      validFrom: "2026-10-01",
      validTo: "2026-09-30",
    }, "252"), /darf nicht vor/i);
    assert.throws(() => saveWorkRuleAssignment(database, {
      profileVersionId: profileVersion,
      scopeType: "location",
      scopeKey: "18",
      validFrom: "2026-07-01",
      enforcementMode: "enforced",
      applicabilityConfirmed: false,
    }, "252"), /nicht bestätigtes Regelprofil/i);
    assert.throws(
      () => resolveWorkRuleAssignment(database, { date: "23.07.2026" }),
      /YYYY-MM-DD/i,
    );
  } finally {
    database.close();
  }
});

test("Arbeitszeitregel-Store: kanonischer Evaluation-Receipt erkennt Manipulationen am gesamten Prüfbeleg", () => {
  const database = createDatabase();
  try {
    seed(database);
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
    const receipt = recordWorkRuleEvaluation(database, {
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
    assert.deepEqual(getWorkRuleEvaluation(database, "evaluation-1").result, result);
    assert.deepEqual({
      resultSha256: listWorkRuleEvaluations(database)[0].resultSha256,
      receiptSha256: listWorkRuleEvaluations(database)[0].receiptSha256,
      receiptHashValid: listWorkRuleEvaluations(database)[0].receiptHashValid,
    }, {
      resultSha256: receipt.resultSha256,
      receiptSha256: receipt.receiptSha256,
      receiptHashValid: true,
    });

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
      assert.throws(
        () => getWorkRuleEvaluation(database, "evaluation-1"),
        /Prüfbeleg-Prüfsumme/i,
        `Manipulation an ${column} muss erkannt werden`,
      );
      const unverified = getWorkRuleEvaluation(database, "evaluation-1", { verify: false });
      assert.equal(unverified.receiptHashValid, false, column);
      assert.equal(
        unverified.resultHashValid,
        !["result_json", "result_sha256"].includes(column),
        column,
      );
      assert.equal(listWorkRuleEvaluations(database)[0].receiptHashValid, false, column);
      database.prepare(`UPDATE work_rule_evaluation_runs SET ${column} = ? WHERE id = ?`)
        .run(original[column], "evaluation-1");
      assert.equal(getWorkRuleEvaluation(database, "evaluation-1").receiptHashValid, true, column);
    }

    assert.throws(() => recordWorkRuleEvaluation(database, {
      targetType: "planned_schedule",
      periodFrom: "2026-07-20",
      periodTo: "2026-07-25",
      profileVersionIds: ["unknown@1"],
      inputSha256,
      result,
      outcome: "pass",
    }), /unbekannte Regelprofil-Version/i);
    assert.throws(() => recordWorkRuleEvaluation(database, {
      targetType: "planned_schedule",
      periodFrom: "2026-07-20",
      periodTo: "2026-07-25",
      profileVersionIds: ["at-retail-adult-monitor@2026.1"],
      inputSha256: "not-a-hash",
      result,
      outcome: "pass",
    }), /SHA-256/i);
  } finally {
    database.close();
  }
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BUILTIN_WORK_RULE_PROFILES,
  SOURCE_CATALOG,
  evaluateCustomPlannedSchedule,
} = require("../lib/work-rules");
const {
  createWorkRuleStoreRepository,
} = require("../lib/persistence/repositories/work-rule-store");
const {
  ensureSqliteWorkRuleStoreSchema,
} = require("../lib/persistence/sqlite/operations/work-rule-store-schema");
const {
  openSqliteApplicationPersistence,
} = require("../lib/persistence/sqlite/provider");
const {
  SQLITE_WORK_RULE_STORE_CATALOG,
} = require("../lib/persistence/sqlite/work-rule-store-catalog");
const {
  resolveWorkRuleAssignmentsFromList,
  saveWorkRuleAssignment,
  seedBuiltinWorkRuleProfiles,
} = require("../lib/work-rules/store");

function customProfileVersion(metric, operator, threshold, unit) {
  const profileId = `custom:${metric}`;
  const ruleId = `${profileId}:rule`;
  return {
    id: `${profileId}@release-1`,
    profile: {
      id: profileId,
      version: "release-1",
      catalogVersion: "custom-work-rule-draft-v1",
      validFrom: "2026-01-01",
      validTo: null,
      defaultEnforcementMode: "monitor",
      limits: { metric, operator, threshold, unit },
      ruleIds: [ruleId],
    },
    rules: [{
      id: ruleId,
      condition: { metric, operator, threshold, unit },
      severity: "critical",
      enforcement: "block",
      message: `Testregel ${metric} verletzt.`,
      sourceRefs: [],
    }],
    sources: [],
  };
}

function assignment() {
  return {
    id: "assignment-1",
    enforcementMode: "enforced",
    applicabilityConfirmed: true,
    validFrom: "2026-01-01",
    validTo: null,
    scopeType: "location",
    scopeKey: "18",
  };
}

function shift(id, date, startTime, endTime, breakMinutes = 0) {
  return {
    id,
    employeeId: "420",
    locationId: "18",
    departmentId: "5",
    date,
    startTime,
    endTime,
    breakMinutes,
  };
}

function evaluate({
  metric,
  operator,
  threshold,
  unit,
  shifts,
  rangeStart = "2026-07-01",
  rangeEnd = "2026-07-31",
}) {
  return evaluateCustomPlannedSchedule({
    profile: customProfileVersion(metric, operator, threshold, unit),
    assignment: assignment(),
    shifts,
    rangeStart,
    rangeEnd,
    employee: {
      id: "420",
      birthDate: "2010-05-12",
      isApprentice: true,
    },
    employeeNumber: "420",
    locationId: "18",
    departmentId: "5",
    now: "2026-07-26T12:00:00+02:00",
  });
}

const supportedMetricCases = [
  {
    metric: "maximum_planned_daily_minutes",
    operator: "lte",
    threshold: 480,
    unit: "minutes",
    shifts: [shift("daily", "2026-07-01", "08:00", "17:00")],
  },
  {
    metric: "maximum_planned_weekly_minutes",
    operator: "lte",
    threshold: 600,
    unit: "minutes",
    shifts: [
      shift("weekly-1", "2026-07-01", "08:00", "14:00"),
      shift("weekly-2", "2026-07-02", "08:00", "14:00"),
    ],
  },
  {
    metric: "minimum_planned_rest_minutes",
    operator: "gte",
    threshold: 660,
    unit: "minutes",
    shifts: [
      shift("rest-1", "2026-07-01", "10:00", "18:00"),
      shift("rest-2", "2026-07-02", "04:00", "12:00"),
    ],
  },
  {
    metric: "maximum_consecutive_workdays",
    operator: "lte",
    threshold: 3,
    unit: "days",
    shifts: [1, 2, 3, 4].map((day) => (
      shift(`consecutive-${day}`, `2026-07-0${day}`, "08:00", "12:00")
    )),
  },
  {
    metric: "maximum_saturdays_per_month",
    operator: "lte",
    threshold: 2,
    unit: "days",
    shifts: ["2026-07-04", "2026-07-11", "2026-07-18"].map((date, index) => (
      shift(`saturday-${index + 1}`, date, "08:00", "12:00")
    )),
  },
  {
    metric: "earliest_shift_start_time",
    operator: "gte",
    threshold: "06:00",
    unit: "time",
    shifts: [shift("early", "2026-07-01", "05:00", "12:00")],
  },
  {
    metric: "latest_shift_end_time",
    operator: "lte",
    threshold: "22:00",
    unit: "time",
    shifts: [shift("late", "2026-07-01", "14:00", "23:00")],
  },
];

test("Block 6: alle sieben unterstützten eigenen Planmetriken erzeugen echte Befunde", async (t) => {
  for (const metricCase of supportedMetricCases) {
    await t.test(metricCase.metric, () => {
      const result = evaluate(metricCase);
      assert.equal(result.supported, true);
      assert.equal(result.applicable, true);
      assert.equal(result.profile.id, `custom:${metricCase.metric}`);
      assert.equal(result.summary.state, "fail");
      assert.ok(result.findings.some((finding) => (
        finding.state === "fail"
        && finding.evidence.metric === metricCase.metric
      )));
      assert.ok(result.findings
        .filter((finding) => finding.state === "fail")
        .every((finding) => finding.effectiveEnforcement === "block"));
      assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
    });
  }
});

test("Block 6: eine nicht unterstützte Metrik erhält kein Scheinergebnis", () => {
  const result = evaluate({
    metric: "minimum_vacation_request_lead_days",
    operator: "gte",
    threshold: 14,
    unit: "days",
    shifts: [],
  });
  assert.equal(result.supported, false);
  assert.equal(result.unsupportedMetric, "minimum_vacation_request_lead_days");
  assert.equal(result.reason, "unsupported_metric");
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.state, "unknown");
  assert.equal(result.summary.requiresManualReview, true);
});

test("Block 6: Basis-, Custom- und U18-Profil werden additiv aufgelöst", () => {
  const assignments = [
    {
      id: "adult-base",
      profileId: "at-retail-adult-monitor",
      profileVersionId: "at-retail-adult-monitor@2026.1",
      scopeType: "installation",
      scopeKey: "",
      validFrom: "2026-01-01",
      active: true,
    },
    {
      id: "youth-base",
      profileId: "at-retail-youth-monitor",
      profileVersionId: "at-retail-youth-monitor@2026.2",
      scopeType: "employee",
      scopeKey: "420",
      validFrom: "2026-01-01",
      active: true,
    },
    {
      id: "custom-wide",
      profileId: "custom:SAMSTAG",
      profileVersionId: "custom:SAMSTAG@release-1",
      scopeType: "installation",
      scopeKey: "",
      validFrom: "2026-01-01",
      active: true,
    },
    {
      id: "custom-narrow",
      profileId: "custom:SAMSTAG",
      profileVersionId: "custom:SAMSTAG@release-2",
      scopeType: "business_unit",
      scopeKey: "retail",
      expandedScopes: [
        { type: "location", key: "18" },
        { scopeType: "department", scopeKey: "5" },
      ],
      validFrom: "2026-06-01",
      active: true,
    },
    {
      id: "inactive-custom",
      profileId: "custom:INACTIVE",
      profileVersionId: "custom:INACTIVE@release-1",
      scopeType: "location",
      scopeKey: "18",
      validFrom: "2026-01-01",
      active: false,
    },
    {
      id: "unexpanded-group",
      profileId: "custom:UNEXPANDED",
      profileVersionId: "custom:UNEXPANDED@release-1",
      scopeType: "employee_group",
      scopeKey: "420",
      validFrom: "2026-01-01",
      active: true,
    },
  ];

  const resolved = resolveWorkRuleAssignmentsFromList(assignments, {
    date: "2026-07-26",
    employeeNumber: "420",
    locationId: "18",
    departmentId: "5",
  });

  assert.deepEqual(
    resolved.map((entry) => entry.id),
    ["adult-base", "youth-base", "custom-narrow"],
  );
});

test("Block 6: eine bestehende Assignment-ID wird nicht per UPSERT überschrieben", async () => {
  const application = openSqliteApplicationPersistence({
    databasePath: ":memory:",
    catalog: SQLITE_WORK_RULE_STORE_CATALOG,
  });
  const { database, provider } = application;
  ensureSqliteWorkRuleStoreSchema(database);
  const repository = createWorkRuleStoreRepository(provider);
  try {
    await seedBuiltinWorkRuleProfiles(
      repository,
      BUILTIN_WORK_RULE_PROFILES,
      SOURCE_CATALOG,
      { actor: "test-system" },
    );
    const assignmentId = "builtin:at-retail-adult-monitor:installation";
    const original = database.prepare(`
      SELECT id, profile_version_id, valid_from, created_by
      FROM work_rule_assignments
      WHERE id = ?
    `).get(assignmentId);
    await assert.rejects(
      saveWorkRuleAssignment(repository, {
        id: assignmentId,
        profileVersionId: "custom:SAMSTAG@release-2",
        scopeType: "location",
        scopeKey: "18",
        validFrom: "2026-07-01",
      }, "252"),
      /bestehende Regelprofil-Zuordnung/i,
    );
    const stored = database.prepare(`
      SELECT id, profile_version_id, valid_from, created_by
      FROM work_rule_assignments
      WHERE id = ?
    `).get(assignmentId);
    assert.deepEqual(stored, original);
  } finally {
    await provider.close();
    database.close();
  }
});

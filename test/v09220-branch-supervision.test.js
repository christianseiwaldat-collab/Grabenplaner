"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  assessBranchSupervision,
  branchSupervisionSettingsValuesFromInput,
  normalizeBranchSupervisionSettings,
} = require("../lib/branch-supervision");
const { FUNCTION_SEARCH_CATALOG } = require("../public/function-search-catalog");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

const employees = [
  { personnel_number: "FL1", position_id: "teamleitung" },
  { personnel_number: "STV1", position_id: "fl-stellvertretung" },
  { personnel_number: "AL1", position_id: "abteilungsleitung" },
  { personnel_number: "MA1", position_id: "verkaufsmitarbeiter" },
];

function mondaySettings(overrides = {}) {
  return {
    branch_supervision_mode: "yellow",
    branch_supervision_intensity: "standard",
    branch_supervision_min_primary_coverage_percent: "60",
    branch_supervision_max_department_gap_minutes: "180",
    monday_open: "1",
    monday_start_time: "09:00",
    monday_end_time: "18:00",
    tuesday_open: "0",
    wednesday_open: "0",
    thursday_open: "0",
    friday_open: "0",
    saturday_open: "0",
    ...overrides,
  };
}

function shift(employeeNumber, startTime, endTime) {
  return {
    employee_number: employeeNumber,
    location_id: "01",
    shift_date: "2099-01-05",
    start_time: startTime,
    end_time: endTime,
  };
}

test("v0.92.20 Filialaufsicht akzeptiert stundenweise AL-Randlücken bei ausreichender FL-Abdeckung", () => {
  const assessment = assessBranchSupervision({
    weekStart: "2099-01-05",
    locationId: "01",
    settings: mondaySettings(),
    employees,
    shifts: [
      shift("FL1", "10:00", "16:00"),
      shift("AL1", "09:00", "10:00"),
      shift("AL1", "16:00", "18:00"),
    ],
  });
  assert.equal(assessment.outcome, "pass");
  assert.equal(assessment.issueCount, 0);
  assert.equal(assessment.days[0].primaryCoveragePercent, 66.7);
  assert.equal(assessment.days[0].departmentCoverageMinutes, 180);
  assert.equal(assessment.days[0].uncoveredMinutes, 0);
});

test("v0.92.20 Abteilungsleitung allein gilt nie als ganztägige Filialaufsicht", () => {
  const assessment = assessBranchSupervision({
    weekStart: "2099-01-05",
    locationId: "01",
    settings: mondaySettings({ branch_supervision_mode: "red" }),
    employees,
    shifts: [shift("AL1", "09:00", "18:00")],
  });
  assert.equal(assessment.outcome, "red");
  assert.equal(assessment.issueCount, 1);
  assert.equal(assessment.issues[0].uncoveredMinutes, 0);
  assert.equal(assessment.issues[0].primaryCoveragePercent, 0);
  assert.ok(assessment.issues[0].primaryDeficitMinutes > 0);
  assert.ok(assessment.issues[0].excessiveDepartmentGapMinutes > 0);
});

test("v0.92.20 echte Aufsichtslücken bleiben auch bei ausreichendem FL-Anteil sichtbar", () => {
  const assessment = assessBranchSupervision({
    weekStart: "2099-01-05",
    locationId: "01",
    settings: mondaySettings({ branch_supervision_mode: "block" }),
    employees,
    shifts: [shift("FL1", "09:00", "12:00"), shift("STV1", "13:00", "18:00")],
  });
  assert.equal(assessment.outcome, "blocked");
  assert.equal(assessment.blocking, true);
  assert.deepEqual(assessment.issues[0].uncoveredSegments, [
    { startTime: "12:00", endTime: "13:00", minutes: 60 },
  ]);
});

test("v0.92.20 Intensitätsprofile setzen feste Schwellen und individuelle Werte werden streng validiert", () => {
  assert.deepEqual(normalizeBranchSupervisionSettings({
    branch_supervision_mode: "yellow",
    branch_supervision_intensity: "strict",
    branch_supervision_min_primary_coverage_percent: "10",
    branch_supervision_max_department_gap_minutes: "480",
  }), {
    mode: "yellow",
    intensity: "strict",
    minimumPrimaryCoveragePercent: 75,
    maximumDepartmentGapMinutes: 120,
  });
  assert.deepEqual(branchSupervisionSettingsValuesFromInput({
    mode: "block",
    intensity: "custom",
    minimumPrimaryCoveragePercent: 70,
    maximumDepartmentGapMinutes: 90,
  }), {
    branch_supervision_mode: "block",
    branch_supervision_intensity: "custom",
    branch_supervision_min_primary_coverage_percent: "70",
    branch_supervision_max_department_gap_minutes: "90",
  });
  assert.throws(() => branchSupervisionSettingsValuesFromInput({
    mode: "block",
    intensity: "custom",
    minimumPrimaryCoveragePercent: 0,
    maximumDepartmentGapMinutes: 90,
  }), /zwischen 10 und 100 Prozent/);
});

test("v0.92.20 Filialaufsicht ist in Dienstplan, Einstellungen, Serversperre und Funktionssuche verdrahtet", () => {
  for (const id of [
    "branchSupervisionAssessmentPanel",
    "branchSupervisionSettingsCard",
    "branchSupervisionMode",
    "branchSupervisionIntensity",
    "branchSupervisionPrimaryCoveragePercent",
    "branchSupervisionDepartmentGapMinutes",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<option value="off">Prüfung aus<\/option>/);
  assert.match(html, /<option value="yellow">Gelber Hinweis<\/option>/);
  assert.match(html, /<option value="red">Roter Hinweis<\/option>/);
  assert.match(html, /<option value="block">Planung blockieren<\/option>/);
  assert.match(app, /function renderBranchSupervisionAssessment\(\)/);
  assert.match(app, /branchSupervision:\s*\{/);
  assert.match(server, /BRANCH_SUPERVISION_BLOCKED/);
  assert.match(server, /schedule\.branch-supervision\.settings\.update/);
  assert.match(server, /prepareApprovedTimeOffMutation[\s\S]*evaluateBranchSupervisionChanges/);
  assert.match(server, /assertBranchSupervisionComplete\(branchSupervision\)/);
  const searchEntry = FUNCTION_SEARCH_CATALOG.find((entry) => entry.id === "settings.branch-supervision");
  assert.ok(searchEntry);
  assert.deepEqual(searchEntry.path, ["Einstellungen", "Dienstplan", "Filialaufsicht"]);
  assert.deepEqual(searchEntry.access.gateIds, ["settingsScheduleTab", "branchSupervisionSettingsCard"]);
});

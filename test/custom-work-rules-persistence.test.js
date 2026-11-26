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
  addCustomWorkRuleDraftRevision,
  createCustomWorkRuleDraft,
  getCustomWorkRuleDraft,
  listCustomWorkRuleDrafts,
  publishCustomWorkRuleDraft,
  restoreCustomWorkRuleVersionAsDraft,
  simulateCustomWorkRuleDraft,
} = require("../lib/work-rules/custom-rules");


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

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  OFFICIAL_RETENTION_SOURCES,
} = require("../lib/retention-policy");
const {
  createGovernanceStore,
} = require("../lib/governance-store");
const {
  createGovernanceStoreRepository,
} = require("../lib/persistence/repositories/governance-store");
const {
  SQLITE_GOVERNANCE_STORE_CATALOG,
} = require("../lib/persistence/sqlite/governance-store-catalog");


function retentionRule() {
  return {
    schemaVersion: 1,
    id: "retention-provider-test-v1",
    version: "1",
    category: "provider_test_records",
    title: "Provider-Testdaten nach Ende des Zwecks",
    status: "active",
    validFrom: "2026-01-01",
    validTo: null,
    sources: [OFFICIAL_RETENTION_SOURCES.eu_gdpr],
    startTrigger: "purpose_ended",
    retention: { value: 30, unit: "days" },
    disposition: "manual_review",
    legalHold: { behavior: "exclude_while_active" },
  };
}

test("Governance-Fachmodul enthält weder SQL noch SQLite-Handles", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "lib", "governance-store.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /\bdb\s*\.(?:prepare|exec)\s*\(/);
  assert.doesNotMatch(source, /\b(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/i);
});

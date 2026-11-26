"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { recordPlanningProtectionChange: record } = require("../lib/work-rules/planning-protection-mutation");
const { normalizeProtectionStatus } = require("../lib/personnel-protection-status");
const { canonicalSha256 } = require("../lib/work-rules/receipt");
const { mondayOfWeek } = require("../lib/work-rules/calendar");
const { seedBuiltinWorkRuleProfiles } = require("../lib/work-rules/store");
const { PLANNING_PROTECTION_PROFILE, PLANNING_PROTECTION_SOURCES,
  PLANNING_PROTECTION_RULE_DEFINITIONS } = require("../lib/work-rules/planning-protection");
const { SQLITE_APPLICATION_CATALOG } = require("../lib/persistence/sqlite/application-catalog");
const { createApplicationRepositories } = require("../lib/persistence/application-repositories");
const { ensureSqliteWorkRuleStoreSchema } = require("../lib/persistence/sqlite/operations/work-rule-store-schema");
const baseline = require("../lib/persistence/postgresql/contracts/source-schema-v09237.json");
const EMPLOYEE = "00002", WEEK = "2032-01-05";

function protectedStatus(overrides = {}) {
  return normalizeProtectionStatus({ version: 1, planningEnabled: true, periods: [{
    id: "private-period-opaque", phase: "pregnancy", confirmed: true,
    validFrom: WEEK, validTo: "2033-12-31", referenceId: "HR:PRIVATE_REFERENCE", normalDailyMinutes: 480,
  }], ...overrides });
}

// Real randomized AES-GCM envelope in the existing enc:v2 format; no stored
// credentials or personal data are used or read by this fixture.
function encryptSynthetic(status) {
  const keyId = Buffer.from("synthetic"), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", crypto.randomBytes(32), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ employment: { protectionStatus: status } })), cipher.final()]);
  return "enc:v2:" + Buffer.concat([Buffer.from([keyId.length]), keyId, iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

test("planning protection mutation: identical and wholly disabled statuses skip all receipt reads and writes", async () => {
  const disabled = protectedStatus({ planningEnabled: false }), enabled = protectedStatus();
  for (const [previousStatus, status] of [[null, null], [null, disabled], [enabled, enabled], [disabled, disabled]]) {
    assert.deepEqual(await record({}, { employeeNumber: EMPLOYEE, previousStatus, status }), []);
  }
});

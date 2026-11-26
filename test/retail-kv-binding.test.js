"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { canonicalSha256 } = require("../lib/work-rules/receipt");
const { RETAIL_KV_SOURCE } = require("../lib/personnel-retail-kv");
const { ensureSqliteApplicationSchema } = require("../lib/persistence/sqlite/operations/application-schema");
const { SQLITE_WORK_RULE_STORE_CATALOG } = require("../lib/persistence/sqlite/work-rule-store-catalog");
const { SQLITE_CUSTOM_WORK_RULES_CATALOG } = require("../lib/persistence/sqlite/custom-work-rules-catalog");
const { SQLITE_WORK_RULE_GOVERNANCE_CATALOG } = require("../lib/persistence/sqlite/work-rule-governance-catalog");
const { SQLITE_COLLECTIVE_AGREEMENTS_CATALOG } = require("../lib/persistence/sqlite/collective-agreements-catalog");
const { createWorkRuleStoreRepository } = require("../lib/persistence/repositories/work-rule-store");
const { createCollectiveAgreementsRepository } = require("../lib/persistence/repositories/collective-agreements");
const { createWorkRuleGovernanceRepository } = require("../lib/persistence/repositories/work-rule-governance");
const { seedBuiltinWorkRuleProfiles, versionSnapshot } = require("../lib/work-rules/store");
const { createCollectiveAgreement, addCollectiveAgreementVersion,
  createBusinessUnit, addBusinessUnitScopes, prepareCollectiveAgreementAssignment } = require("../lib/collective-agreements");
const { previewWorkRuleGovernance, createWorkRuleReviewRequest, recordWorkRuleReviewDecision,
  finalizeWorkRuleReviewRequest } = require("../lib/work-rules/governance");
const { loadRetailKvBindingSnapshot, resolveRetailKvApproval } = require("../lib/work-rules/retail-kv-binding");

const PROFILE = Object.freeze({ id: "at-retail-kv-angestellte-2026", version: "2026.5", title: "KV fixture",
  status: "active", assignable: false, snapshotSchemaVersion: 2, validFrom: "2026-01-01", validTo: "2026-12-31",
  catalogVersion: "fixture", defaultEnforcementMode: "monitor", sourceRefs: [RETAIL_KV_SOURCE.id],
  applicability: { jurisdiction: "AT", sector: "retail" }, limits: {}, ruleIds: [] });
const PROFILE_ID = `${PROFILE.id}@${PROFILE.version}`;
const OPTIONS = { expectedProfileVersionId: PROFILE_ID,
  expectedProfileContentSha256: canonicalSha256(versionSnapshot(PROFILE, [], [RETAIL_KV_SOURCE])) };
const DATE = "2026-10-05";
const CONTEXT = [{ locationId: "L1", departmentId: "1" }];
const actor = (id, extras = {}) => ({ employeeNumber: id, role: "hr", qualification: "fachlich",
  permissionUsed: "collective_agreements:approve", now: "2026-10-03T08:00:00.000Z", ...extras });

async function resolve(value, period = value.period, date = DATE, context = CONTEXT, repositories = value.repositories,
  options = OPTIONS) {
  return resolveRetailKvApproval(await loadRetailKvBindingSnapshot(repositories, options), period, date, context);
}


test("a fabricated snapshot or approver array cannot establish applicability", async () => {
  assert.equal(resolveRetailKvApproval({ schemaVersion: 1, approvals: ["a", "b"] },
    { confirmed: true }, DATE, CONTEXT).verified, false);
});

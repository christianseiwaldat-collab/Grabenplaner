"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createPrivacyOrganizationStore } = require("../lib/privacy-organization-store");
const { createPrivacyLedger, applyPrivacyCommand, verifyPrivacyLedger } = require("../lib/privacy-organization");
const { PRIVACY_ORGANIZATION_SETTING_KEY: KEY, PRIVACY_ORGANIZATION_SETTING_PREFIX: PREFIX,
  isPrivacyOrganizationSettingKey, publicSettingsRows, publicSettingsObject } = require("../lib/privacy-organization-settings");
const { createAmuStorage } = require("../lib/amu-storage");
const { SQLITE_APPLICATION_CATALOG } = require("../lib/persistence/sqlite/application-catalog");
const { ensureSqliteApplicationSchema } = require("../lib/persistence/sqlite/operations/application-schema");
const { createPersistenceProviderFacade, PERSISTENCE_ERROR_CODES, PersistenceError } = require("../lib/persistence/contract");

const NOW = "2026-10-03T08:00:00.000Z";
const CONTEXT = { namespace: "privacy-organization", recordId: "ledger-v1", field: "ledger", employeeNumber: "system" };
const ACTOR = { employeeNumber: "SYNTHETIC-HR", role: "hr", personal: true,
  permissions: ["privacy_organization:read", "privacy_organization:manage", "privacy_organization:approve"] };
const create = (expectedRevision = 0, title = "PRIVATE synthetic process") => ({
  action: "create", kind: "activity", payload: { title }, expectedRevision,
});
const updateOrganization = (expectedRevision, controllerName = "PRIVATE controller") => ({
  action: "update", id: "organization", payload: { controllerName }, expectedRevision,
});

function protectedFixture(t) {
  const tempRoot = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, "gp-privacy-store-test-"));
  const storage = createAmuStorage({ rootDirectory: root, encryptionKeys: { synthetic: crypto.randomBytes(32).toString("hex") }, activeKeyId: "synthetic" });
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), tempRoot);
    assert.ok(path.basename(root).startsWith("gp-privacy-store-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    storage,
    protectJson: (value, context) => storage.protectRecord(JSON.stringify(value), context),
    parseProtectedJson: (value, context) => JSON.parse(storage.unprotectRecord(value, context)),
  };
}


test("privacy settings: every reserved key is hidden from public rows/objects without mutating public settings", () => {
  const rows = [{ key: "opening_time", value: "08:00" }, { key: KEY, value: "enc:v2:SECRET" },
    { key: `${PREFIX}future_source`, value: "PRIVATE" }, { key: "not_privacy_organization_value", value: "public" }];
  const original = JSON.stringify(rows);
  assert.equal(isPrivacyOrganizationSettingKey(KEY), true);
  assert.equal(isPrivacyOrganizationSettingKey(`${PREFIX}future_source`), true);
  assert.equal(isPrivacyOrganizationSettingKey(undefined), false);
  assert.equal(isPrivacyOrganizationSettingKey("opening_time"), false);
  assert.deepEqual(publicSettingsRows(rows), [rows[0], rows[3]]);
  assert.deepEqual(publicSettingsObject(Object.fromEntries(rows.map(row => [row.key, row.value]))),
    { opening_time: "08:00", not_privacy_organization_value: "public" });
  assert.equal(JSON.stringify(rows), original);
});

// Contract-level fault injection, separate from the real SQLite tests above.
// A facade is genuine, but this adapter makes no native PostgreSQL claim.

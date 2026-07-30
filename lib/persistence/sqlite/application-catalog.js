"use strict";

const {
  SQLITE_ABSENCE_MANAGEMENT_CATALOG,
} = require("./absence-management-catalog");
const {
  SQLITE_UI_PREFERENCES_CATALOG,
} = require("./ui-preferences-catalog");
const {
  SQLITE_WORK_RULE_STORE_CATALOG,
} = require("./work-rule-store-catalog");
const {
  SQLITE_WORK_RULE_GOVERNANCE_CATALOG,
} = require("./work-rule-governance-catalog");
const {
  SQLITE_BRANDING_SNAPSHOT_CATALOG,
} = require("./branding-snapshot-catalog");
const {
  SQLITE_COLLECTIVE_AGREEMENTS_CATALOG,
} = require("./collective-agreements-catalog");
const {
  SQLITE_CUSTOM_WORK_RULES_CATALOG,
} = require("./custom-work-rules-catalog");
const {
  SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
} = require("./custom-process-management-catalog");
const {
  SQLITE_GOVERNANCE_STORE_CATALOG,
} = require("./governance-store-catalog");
const {
  SQLITE_INTEGRATION_RUNTIME_CATALOG,
} = require("./integration-runtime-catalog");
const {
  SQLITE_ORGANIZATION_PERSONNEL_CATALOG,
} = require("./organization-personnel-catalog");
const {
  SQLITE_PLANNING_SETTINGS_CATALOG,
} = require("./planning-settings-catalog");
const {
  SQLITE_LOAN_MODULE_CATALOG,
} = require("./loan-module-catalog");
const {
  SQLITE_MOBILE_AUTH_CATALOG,
} = require("./mobile-auth-catalog");
const {
  SQLITE_PORTAL_ACCESS_CATALOG,
} = require("./portal-access-catalog");
const {
  SQLITE_SYSTEM_CENTER_METRICS_CATALOG,
} = require("./system-center-metrics-catalog");
const {
  SQLITE_RUNTIME_RECOVERY_CATALOG,
} = require("./runtime-recovery-catalog");
const {
  SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG,
} = require("./sickness-amu-management-catalog");
const {
  SQLITE_TIME_TRACKING_CATALOG,
} = require("./time-tracking-catalog");
const {
  SQLITE_WIFI_AUTOMATION_CATALOG,
} = require("./wifi-automation-catalog");

function isDeepFrozen(value, visited = new Set()) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return true;
  if (visited.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  visited.add(value);
  return Reflect.ownKeys(value)
    .every((key) => isDeepFrozen(value[key], visited));
}

function invalidCatalog() {
  return new TypeError("Der SQLite-Anwendungskatalog ist ungültig.");
}

const createSqliteApplicationCatalog = Object.freeze(function createSqliteApplicationCatalog(
  ...domainCatalogs
) {
  const statementIds = new Set();
  const statements = new Set();
  const entries = [];

  for (const catalog of domainCatalogs) {
    if (!Array.isArray(catalog)) throw invalidCatalog();
    for (const entry of catalog) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || Object.keys(entry).some((key) => !["statement", "sql", "returning"].includes(key))
        || !entry.statement || typeof entry.statement !== "object"
        || typeof entry.statement.id !== "string" || !entry.statement.id
        || typeof entry.sql !== "string" || !entry.sql.trim()
        || typeof entry.returning !== "boolean"
        || !isDeepFrozen(entry.statement)
        || statements.has(entry.statement)
        || statementIds.has(entry.statement.id)) {
        throw invalidCatalog();
      }
      statements.add(entry.statement);
      statementIds.add(entry.statement.id);
      entries.push(Object.freeze({
        statement: entry.statement,
        sql: entry.sql,
        returning: entry.returning,
      }));
    }
  }

  return Object.freeze(entries);
});

const SQLITE_APPLICATION_CATALOG = createSqliteApplicationCatalog(
  SQLITE_ABSENCE_MANAGEMENT_CATALOG,
  SQLITE_BRANDING_SNAPSHOT_CATALOG,
  SQLITE_COLLECTIVE_AGREEMENTS_CATALOG,
  SQLITE_CUSTOM_PROCESS_MANAGEMENT_CATALOG,
  SQLITE_CUSTOM_WORK_RULES_CATALOG,
  SQLITE_GOVERNANCE_STORE_CATALOG,
  SQLITE_INTEGRATION_RUNTIME_CATALOG,
  SQLITE_LOAN_MODULE_CATALOG,
  SQLITE_MOBILE_AUTH_CATALOG,
  SQLITE_ORGANIZATION_PERSONNEL_CATALOG,
  SQLITE_PLANNING_SETTINGS_CATALOG,
  SQLITE_PORTAL_ACCESS_CATALOG,
  SQLITE_RUNTIME_RECOVERY_CATALOG,
  SQLITE_SICKNESS_AMU_MANAGEMENT_CATALOG,
  SQLITE_SYSTEM_CENTER_METRICS_CATALOG,
  SQLITE_TIME_TRACKING_CATALOG,
  SQLITE_UI_PREFERENCES_CATALOG,
  SQLITE_WIFI_AUTOMATION_CATALOG,
  SQLITE_WORK_RULE_GOVERNANCE_CATALOG,
  SQLITE_WORK_RULE_STORE_CATALOG,
);

module.exports = {
  SQLITE_APPLICATION_CATALOG,
  createSqliteApplicationCatalog,
};

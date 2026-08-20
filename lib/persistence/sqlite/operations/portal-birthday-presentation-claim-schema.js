"use strict";

const PORTAL_BIRTHDAY_PRESENTATION_CLAIM_MIGRATION_ID =
  "v0.92.10-portal-birthday-presentation-claims";
function definition(name, sql) {
  return Object.freeze({ name, sql: String(sql || "").trim() });
}

const PORTAL_BIRTHDAY_PRESENTATION_CLAIM_TABLE_DEFINITION = definition(
  "portal_birthday_presentation_claims",
  `
    CREATE TABLE IF NOT EXISTS portal_birthday_presentation_claims (
      employee_number TEXT NOT NULL
        CHECK(length(TRIM(employee_number)) BETWEEN 1 AND 120),
      event_year INTEGER NOT NULL CHECK(event_year BETWEEN 2000 AND 9999),
      presentation_id TEXT NOT NULL
        CHECK(presentation_id IN ('standard', 'elegant', 'farbenfroh', 'fotowelt', 'technik')),
      policy_revision INTEGER NOT NULL CHECK(policy_revision >= 1),
      assignment_revision INTEGER NOT NULL CHECK(assignment_revision >= 1),
      receipt_sha256 TEXT NOT NULL
        CHECK(length(receipt_sha256) = 64
          AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision = 1),
      PRIMARY KEY (employee_number, event_year),
      FOREIGN KEY (employee_number) REFERENCES employees(personnel_number)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    )
  `,
);

const PORTAL_BIRTHDAY_PRESENTATION_CLAIM_TRIGGER_DEFINITIONS = Object.freeze([
  definition("trg_portal_birthday_presentation_claim_immutable_update", `
    CREATE TRIGGER IF NOT EXISTS trg_portal_birthday_presentation_claim_immutable_update
    BEFORE UPDATE ON portal_birthday_presentation_claims
    BEGIN
      SELECT RAISE(ABORT, 'portal birthday presentation claim is immutable');
    END
  `),
  definition("trg_portal_birthday_presentation_claim_no_delete", `
    CREATE TRIGGER IF NOT EXISTS trg_portal_birthday_presentation_claim_no_delete
    BEFORE DELETE ON portal_birthday_presentation_claims
    BEGIN
      SELECT RAISE(ABORT, 'portal birthday presentation claim cannot be deleted');
    END
  `),
]);

function normalizeDefinitionSql(sql, type) {
  let normalized = String(sql || "").trim().replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "").toLowerCase();
  if (type === "table") normalized = normalized.replace(/^create table if not exists /, "create table ");
  if (type === "trigger") normalized = normalized.replace(/^create trigger if not exists /, "create trigger ");
  return normalized;
}

function inspectDefinition(database, type, item) {
  const stored = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
  ).get(type, item.name);
  if (!stored?.sql) return "missing";
  return normalizeDefinitionSql(stored.sql, type) === normalizeDefinitionSql(item.sql, type)
    ? "valid" : "invalid";
}

function inspectSqlitePortalBirthdayPresentationClaimSchema(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Inspektionsdatenbank wird benötigt.");
  }
  const tableState = inspectDefinition(
    database,
    "table",
    PORTAL_BIRTHDAY_PRESENTATION_CLAIM_TABLE_DEFINITION,
  );
  const triggerStates = PORTAL_BIRTHDAY_PRESENTATION_CLAIM_TRIGGER_DEFINITIONS.map((item) => ({
    name: item.name,
    state: inspectDefinition(database, "trigger", item),
  }));
  const issues = [
    ...(tableState === "valid" ? [] : [`table-${tableState}:${PORTAL_BIRTHDAY_PRESENTATION_CLAIM_TABLE_DEFINITION.name}`]),
    ...triggerStates.filter(({ state }) => state !== "valid")
      .map(({ name, state }) => `trigger-${state}:${name}`),
  ];
  return Object.freeze({
    valid: issues.length === 0,
    absent: tableState === "missing" && triggerStates.every(({ state }) => state === "missing"),
    issues: Object.freeze(issues),
  });
}

function inspectSqlitePortalBirthdayPresentationClaimRows(database) {
  const schema = inspectSqlitePortalBirthdayPresentationClaimSchema(database);
  if (schema.absent) return Object.freeze({ valid: true, absent: true, issues: Object.freeze([]) });
  if (!schema.valid) return Object.freeze({ valid: false, absent: false, issues: Object.freeze(["schema-invalid"]) });
  const issues = [];
  for (const violation of database.prepare(
    'PRAGMA foreign_key_check("portal_birthday_presentation_claims")',
  ).all()) issues.push(`foreign-key:${violation.rowid ?? "unknown"}`);
  for (const row of database.prepare(`
    SELECT employee_number, event_year, presentation_id, policy_revision,
           assignment_revision, receipt_sha256, revision
    FROM portal_birthday_presentation_claims
    ORDER BY employee_number
  `).all()) {
    const employee = String(row.employee_number || "");
    if (!employee.trim() || employee !== employee.trim() || employee.length > 120
      || !Number.isSafeInteger(Number(row.event_year))
      || Number(row.event_year) < 2000 || Number(row.event_year) > 9999
      || !["standard", "elegant", "farbenfroh", "fotowelt", "technik"].includes(row.presentation_id)
      || !Number.isSafeInteger(Number(row.policy_revision)) || Number(row.policy_revision) < 1
      || !Number.isSafeInteger(Number(row.assignment_revision)) || Number(row.assignment_revision) < 1
      || !/^[0-9a-f]{64}$/.test(String(row.receipt_sha256 || ""))
      || Number(row.revision) !== 1) {
      issues.push(`claim-row-invalid:${employee || "missing"}`);
    }
  }
  return Object.freeze({
    valid: issues.length === 0,
    absent: false,
    issues: Object.freeze([...new Set(issues)]),
  });
}

function ensureSqlitePortalBirthdayPresentationClaimSchema(database) {
  if (!database || typeof database.exec !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benötigt.");
  }
  database.exec(PORTAL_BIRTHDAY_PRESENTATION_CLAIM_TABLE_DEFINITION.sql);
  for (const item of PORTAL_BIRTHDAY_PRESENTATION_CLAIM_TRIGGER_DEFINITIONS) database.exec(item.sql);
}

module.exports = {
  PORTAL_BIRTHDAY_PRESENTATION_CLAIM_MIGRATION_ID,
  PORTAL_BIRTHDAY_PRESENTATION_CLAIM_TABLE_DEFINITION,
  PORTAL_BIRTHDAY_PRESENTATION_CLAIM_TRIGGER_DEFINITIONS,
  ensureSqlitePortalBirthdayPresentationClaimSchema,
  inspectSqlitePortalBirthdayPresentationClaimRows,
  inspectSqlitePortalBirthdayPresentationClaimSchema,
};

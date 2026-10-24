"use strict";

// Provider-neutral checks used by both current PostgreSQL recovery and archived readers.
const {
  normalizePersonalEmailAddress,
} = require("../../../../lib/personal-email-address.js");
const {
  candidateApplicationProtectionContext,
  candidateConversionProtectionContext,
  candidateDocumentProtectionContext,
  candidateDocumentVersionProtectionContext,
  candidateEventProtectionContext,
  candidateProtectionContext,
} = require("../../../../lib/personnel-lifecycle.js");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
function fail(message) { throw new Error(message); }

function parseSemver(value) {
  const match = String(value || "").match(SEMVER);
  if (!match) fail("Eine App-Version im Recovery-Sicherungspunkt ist nicht vergleichbar.");
  return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split(".") : null };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    if (left.pre[index] === undefined) return -1;
    if (right.pre[index] === undefined) return 1;
    const compared = compareIdentifiers(left.pre[index], right.pre[index]);
    if (compared) return compared;
  }
  return 0;
}

function encryptionConfiguration(environment) {
  const amuKeyId = String(environment.get("GRABENPLANER_AMU_KEY_ID") || "");
  const amuKey = String(environment.get("GRABENPLANER_AMU_KEY") || "");
  const integrationKeyId = String(environment.get("GRABENPLANER_INTEGRATION_KEY_ID") || "");
  const integrationKey = String(environment.get("GRABENPLANER_INTEGRATION_KEY") || "");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(amuKeyId) || !/^[A-Za-z0-9+/_=-]{32,256}$/.test(amuKey)) {
    fail("Der AMU-Wiederherstellungsschluessel fehlt oder ist ungueltig.");
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(integrationKeyId) || !/^[A-Za-z0-9+/_=-]{32,256}$/.test(integrationKey)) {
    fail("Der Integrations-Wiederherstellungsschluessel fehlt oder ist ungueltig.");
  }
  const integrationKeys = { [integrationKeyId]: integrationKey };
  const keyRing = String(environment.get("GRABENPLANER_INTEGRATION_KEYS") || "");
  if (keyRing) {
    const parsed = JSON.parse(keyRing);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("Der Integrationsschluesselring ist ungueltig.");
    for (const [keyId, key] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || typeof key !== "string") fail("Der Integrationsschluesselring ist ungueltig.");
      integrationKeys[keyId] = key;
    }
  }
  return { amuKeyId, amuKey, integrationKeyId, integrationKeys };
}

function protectedJson(storage, value, context, { allowLegacy = true } = {}) {
  const text = storage.unprotectRecord(value, context, { allowLegacy });
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("Ein geschuetzter Datensatz ist ungueltig.");
  return parsed;
}

function* protectedRecordChecks(storage) {
  let verified = 0;
  const personalNotificationContactsSchema = (yield {kind: "notification-schema"});
  if (personalNotificationContactsSchema.exists && !personalNotificationContactsSchema.valid) {
    fail("Die geschuetzte Tabelle fuer persoenliche Benachrichtigungskontakte ist nicht kompatibel.");
  }
  if (personalNotificationContactsSchema.exists) {
    const personalNotificationContactRows = (yield {kind: "notification-rows"});
    if (!personalNotificationContactRows.valid) {
      fail("Die Tabelle fuer persoenliche Benachrichtigungseinstellungen ist inhaltlich ungueltig.");
    }
  }
  for (const row of (yield {kind: "rows", args: ["candidates", ["id", "protected_payload"],
    "SELECT id, protected_payload FROM candidates ORDER BY id"]})) {
    protectedJson(storage, row.protected_payload, candidateProtectionContext(row), { allowLegacy: false });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["candidate_applications", ["id", "candidate_id", "protected_payload"],
    "SELECT id, candidate_id, protected_payload FROM candidate_applications ORDER BY candidate_id, id"]})) {
    protectedJson(storage, row.protected_payload, candidateApplicationProtectionContext(row), { allowLegacy: false });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["candidate_documents", ["id", "candidate_id", "protected_payload"],
    "SELECT id, candidate_id, protected_payload FROM candidate_documents ORDER BY candidate_id, id"]})) {
    protectedJson(storage, row.protected_payload, candidateDocumentProtectionContext(row), { allowLegacy: false });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["candidate_document_versions",
    ["document_id", "version_number", "protected_payload"], `
      SELECT version.document_id, version.version_number, version.protected_payload,
             document.candidate_id
      FROM candidate_document_versions version
      LEFT JOIN candidate_documents document ON document.id = version.document_id
      ORDER BY document.candidate_id, version.document_id, version.version_number
    `]})) {
    protectedJson(storage, row.protected_payload, candidateDocumentVersionProtectionContext(row), { allowLegacy: false });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["candidate_events", ["id", "candidate_id", "protected_payload"],
    "SELECT id, candidate_id, protected_payload FROM candidate_events ORDER BY candidate_id, id"]})) {
    protectedJson(storage, row.protected_payload, candidateEventProtectionContext(row), { allowLegacy: false });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["candidate_conversions", ["id", "candidate_id", "protected_payload"],
    "SELECT id, candidate_id, protected_payload FROM candidate_conversions ORDER BY candidate_id, id"]})) {
    protectedJson(storage, row.protected_payload, candidateConversionProtectionContext(row), { allowLegacy: false });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["personnel_sensitive_records", ["employee_number", "protected_payload"],
    "SELECT employee_number, protected_payload FROM personnel_sensitive_records ORDER BY employee_number"]})) {
    const profile = protectedJson(storage, row.protected_payload, { namespace: "personnel-sensitive-record", recordId: String(row.employee_number), field: "payload", employeeNumber: String(row.employee_number) }, { allowLegacy: false });
    if (profile.privateEmail && !normalizePersonalEmailAddress(profile.privateEmail)) {
      fail("Eine geschuetzte private E-Mail-Adresse ist ungueltig.");
    }
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["personnel_record_documents", ["id", "employee_number", "protected_payload"],
    "SELECT id, employee_number, protected_payload FROM personnel_record_documents ORDER BY employee_number, id"]})) {
    protectedJson(storage, row.protected_payload, { namespace: "personnel-record-attachment", recordId: String(row.id), field: "payload", employeeNumber: String(row.employee_number) }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["amu_reports", ["id", "employee_number", "protected_payload", "employee_note", "review_note"],
    "SELECT id, employee_number, protected_payload, employee_note, review_note FROM amu_reports ORDER BY id"]})) {
    if (row.protected_payload) {
      protectedJson(storage, row.protected_payload, { namespace: "personnel-record", recordId: String(row.id), field: "payload", employeeNumber: String(row.employee_number) });
      verified += 1;
    }
    for (const legacy of [row.employee_note, row.review_note]) if (String(legacy || "").startsWith("enc:v1:")) { storage.unprotectText(legacy); verified += 1; }
  }
  for (const row of (yield {kind: "rows", args: ["amu_documents", ["id", "report_id", "protected_payload", "original_filename"], `
    SELECT d.id, d.protected_payload, d.original_filename, r.employee_number
    FROM amu_documents d JOIN amu_reports r ON r.id = d.report_id
    WHERE d.status <> 'purged' ORDER BY d.id`]})) {
    if (row.protected_payload) {
      protectedJson(storage, row.protected_payload, { namespace: "personnel-record-document", recordId: String(row.id), field: "payload", employeeNumber: String(row.employee_number) });
      verified += 1;
    }
    if (String(row.original_filename || "").startsWith("enc:v1:")) { storage.unprotectText(row.original_filename); verified += 1; }
  }
  for (const row of (yield {kind: "rows", args: ["sickness_cases", ["id", "employee_lookup", "protected_payload"],
    "SELECT id, employee_lookup, protected_payload FROM sickness_cases ORDER BY id"]})) {
    protectedJson(storage, row.protected_payload, { namespace: "sickness-case", recordId: String(row.id), field: "payload", employeeNumber: String(row.employee_lookup) });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["sickness_alerts", ["id", "sickness_case_id", "protected_payload"],
    "SELECT id, sickness_case_id, protected_payload FROM sickness_alerts ORDER BY id"]})) {
    protectedJson(storage, row.protected_payload, { namespace: "sickness-alert", recordId: String(row.id), field: "payload", employeeNumber: String(row.sickness_case_id) });
    verified += 1;
  }
  const legacySicknessDestinations = (yield {kind: "rows", args: ["sickness_notification_preferences", ["protected_destination"],
    "SELECT 1 AS present FROM sickness_notification_preferences WHERE TRIM(COALESCE(protected_destination, '')) <> '' LIMIT 1"]});
  if (legacySicknessDestinations.length) {
    fail("Eine alte duplizierte Benachrichtigungsadresse ist noch gespeichert.");
  }
  for (const row of (yield {kind: "rows", args: ["outbound_notification_jobs", ["id", "recipient_lookup", "protected_payload"],
    "SELECT id, recipient_lookup, protected_payload FROM outbound_notification_jobs ORDER BY id"]})) {
    const payload = protectedJson(storage, row.protected_payload, { namespace: "outbound-notification-job", recordId: String(row.id), field: "payload", employeeNumber: String(row.recipient_lookup) });
    if (Object.hasOwn(payload, "destination")) {
      fail("Ein alter Benachrichtigungsauftrag enthaelt noch eine duplizierte Zieladresse.");
    }
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["privacy_requests", ["id", "employee_number", "protected_payload"],
    "SELECT id, employee_number, protected_payload FROM privacy_requests ORDER BY id"]})) {
    protectedJson(storage, row.protected_payload, {
      namespace: "privacy-request",
      recordId: String(row.id),
      field: "state",
      employeeNumber: String(row.employee_number),
    }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["privacy_request_events", ["id", "request_id", "protected_payload"], `
    SELECT e.id, e.protected_payload, r.employee_number
    FROM privacy_request_events e
    JOIN privacy_requests r ON r.id = e.request_id
    ORDER BY e.id`]})) {
    protectedJson(storage, row.protected_payload, {
      namespace: "privacy-request-event",
      recordId: String(row.id),
      field: "payload",
      employeeNumber: String(row.employee_number),
    }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["vacation_account_revisions", ["id", "employee_number", "calculation_json"],
    "SELECT id, employee_number, calculation_json FROM vacation_account_revisions ORDER BY id"]})) {
    protectedJson(storage, row.calculation_json, {
      namespace: "vacation-account",
      recordId: String(row.id),
      field: "payload",
      employeeNumber: String(row.employee_number),
    }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["vacation_history_events", ["id", "employee_number", "snapshot_json"],
    "SELECT id, employee_number, snapshot_json FROM vacation_history_events ORDER BY id"]})) {
    protectedJson(storage, row.snapshot_json, {
      namespace: "vacation-history-event",
      recordId: String(row.id),
      field: "snapshot",
      employeeNumber: String(row.employee_number),
    }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["time_record_statements", ["id", "employee_number", "snapshot_json"],
    "SELECT id, employee_number, snapshot_json FROM time_record_statements ORDER BY id"]})) {
    protectedJson(storage, row.snapshot_json, {
      namespace: "time-record-statement",
      recordId: String(row.id),
      field: "payload",
      employeeNumber: String(row.employee_number),
    }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["payroll_handoffs", ["id", "payload_json"],
    "SELECT id, payload_json FROM payroll_handoffs ORDER BY id"]})) {
    protectedJson(storage, row.payload_json, {
      namespace: "payroll-handoff",
      recordId: String(row.id),
      field: "payload",
      employeeNumber: "system",
    }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["payroll_handoff_events", ["id", "payload_json"],
    "SELECT id, payload_json FROM payroll_handoff_events ORDER BY id"]})) {
    protectedJson(storage, row.payload_json, {
      namespace: "payroll-handoff-event",
      recordId: String(row.id),
      field: "payload",
      employeeNumber: "system",
    }, { allowLegacy: false });
    verified += 1;
  }
  for (const row of (yield {kind: "rows", args: ["retention_preview_runs", ["id", "result_json"],
    "SELECT id, result_json FROM retention_preview_runs ORDER BY id"]})) {
    protectedJson(storage, row.result_json, {
      namespace: "retention-preview",
      recordId: String(row.id),
      field: "payload",
      employeeNumber: "system",
    }, { allowLegacy: false });
    verified += 1;
  }
  return verified;
}


module.exports = { compareSemver, encryptionConfiguration, protectedRecordChecks };

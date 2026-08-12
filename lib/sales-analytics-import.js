"use strict";

const crypto = require("node:crypto");
const {
  SALES_ANALYTICS_MODEL_VERSION,
  SALES_ANALYTICS_DECISION_GATES,
  salesAnalyticsEntity,
} = require("./sales-analytics-model");

const SALES_IMPORT_CONTRACT_VERSION = 1;
const SALES_IMPORT_PREVIEW_ROW_LIMIT = 1000;
const SALES_IMPORT_PROFILES = new WeakSet();
const SALES_IMPORT_PREVIEWS = new WeakSet();

function deepFreeze(value, visited = new Set()) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  if (visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  return Object.freeze(value);
}

const SALES_SOURCE_ADAPTERS = deepFreeze({
  structured_rows: {
    id: "structured_rows",
    status: "foundation_ready",
    readsExternalSource: false,
    proposalOnly: false,
    humanConfirmationRequired: false,
  },
  access_snapshot: {
    id: "access_snapshot",
    status: "adapter_pending",
    readsExternalSource: true,
    proposalOnly: false,
    humanConfirmationRequired: false,
  },
  csv_file: {
    id: "csv_file",
    status: "adapter_pending",
    readsExternalSource: true,
    proposalOnly: false,
    humanConfirmationRequired: false,
  },
  xlsx_file: {
    id: "xlsx_file",
    status: "adapter_pending",
    readsExternalSource: true,
    proposalOnly: false,
    humanConfirmationRequired: false,
  },
  sql_view: {
    id: "sql_view",
    status: "adapter_pending",
    readsExternalSource: true,
    proposalOnly: false,
    humanConfirmationRequired: false,
  },
  https_api: {
    id: "https_api",
    status: "adapter_pending",
    readsExternalSource: true,
    proposalOnly: false,
    humanConfirmationRequired: false,
  },
  report_ocr: {
    id: "report_ocr",
    status: "local_review_ready",
    readsExternalSource: true,
    proposalOnly: true,
    humanConfirmationRequired: true,
  },
  tradefoto_pdf_report: {
    id: "tradefoto_pdf_report",
    status: "text_and_local_ocr_ready",
    readsExternalSource: true,
    proposalOnly: true,
    humanConfirmationRequired: true,
  },
});

const TRANSFORMS = deepFreeze({
  trim_text: { sourceCount: 1, outputKinds: ["text"] },
  identifier_text: { sourceCount: 1, outputKinds: ["identifier"] },
  sha256_key: { minimumSourceCount: 1, outputKinds: ["sha256"] },
  date_iso: { sourceCount: 1, outputKinds: ["date"] },
  date_dmy: { sourceCount: 1, outputKinds: ["date"] },
  time_hms: { sourceCount: 1, outputKinds: ["time"] },
  utc_timestamp: { sourceCount: 1, outputKinds: ["utc_timestamp"] },
  decimal4_canonical: { sourceCount: 1, outputKinds: ["decimal4"] },
  decimal4_de: { sourceCount: 1, outputKinds: ["decimal4"] },
  safe_integer: { sourceCount: 1, outputKinds: ["safe_integer"] },
  boolean_de: { sourceCount: 1, outputKinds: ["boolean"] },
  branch_map: { sourceCount: 1, outputKinds: ["identifier"] },
  constant: {
    sourceCount: 0,
    outputKinds: ["text", "identifier", "date", "time", "utc_timestamp", "decimal4", "safe_integer", "boolean"],
  },
});

class SalesImportContractError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "SalesImportContractError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

class SalesImportReviewSignal extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "SalesImportReviewSignal";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function contractError(code, details = {}) {
  return new SalesImportContractError(code, details);
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isPlainRecord(value)) throw contractError("SALES_IMPORT_CANONICAL_JSON_INVALID");
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

function canonicalJsonString(value) {
  return JSON.stringify(canonicalJsonValue(value));
}

function exactKeys(value, allowedKeys, code) {
  if (!isPlainRecord(value)) throw contractError(code);
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw contractError(code);
}

function normalizedSourceField(value) {
  const result = String(value ?? "").trim();
  if (!result || result.length > 128 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw contractError("SALES_IMPORT_SOURCE_FIELD_INVALID");
  }
  if (["__proto__", "prototype", "constructor"].includes(result.toLowerCase())) {
    throw contractError("SALES_IMPORT_SOURCE_FIELD_INVALID");
  }
  return result;
}

function normalizedHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isProhibitedSourceField(value) {
  const header = normalizedHeader(value);
  return /^(?:kund|customer)/.test(header)
    || /^(?:verkaufer|verkaeufer)(?:id|nummer|nr|kenn)/.test(header)
    || /^(?:personal|mitarbeiter|employee)/.test(header)
    || /^(?:provision|beratung)/.test(header)
    || /^(?:iban|bic|sepa|bankkonto)/.test(header)
    || /^(?:passwort|password|kennwort|login|benutzer)/.test(header)
    || /^(?:email|mailadresse|telefon|mobilnummer|adresse|kplz)/.test(header);
}

function salesSourceSchemaSha256(sourceFields) {
  if (!Array.isArray(sourceFields) || !sourceFields.length) {
    throw contractError("SALES_IMPORT_SOURCE_SCHEMA_INVALID");
  }
  const normalized = sourceFields.map(normalizedSourceField);
  if (new Set(normalized).size !== normalized.length) {
    throw contractError("SALES_IMPORT_SOURCE_SCHEMA_INVALID");
  }
  return crypto.createHash("sha256")
    .update(JSON.stringify([...normalized].sort()))
    .digest("hex");
}

function normalizedIdentifier(value, code = "SALES_IMPORT_IDENTIFIER_INVALID", maximumLength = 80) {
  const result = String(value ?? "").trim();
  if (!result || result.length > maximumLength || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) {
    throw contractError(code);
  }
  return result;
}

function normalizedSha256(value, code) {
  const result = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw contractError(code);
  return result;
}

function normalizeMappingDefinition(targetField, value, fieldDefinition) {
  exactKeys(value, ["sources", "transform", "constant"], "SALES_IMPORT_MAPPING_INVALID");
  const transformId = String(value.transform || "");
  const transform = Object.hasOwn(TRANSFORMS, transformId) ? TRANSFORMS[transformId] : null;
  if (!transform || !transform.outputKinds.includes(fieldDefinition.kind)) {
    throw contractError("SALES_IMPORT_TRANSFORM_INVALID", { targetField });
  }
  const sources = Array.isArray(value.sources) ? value.sources.map(normalizedSourceField) : [];
  if (new Set(sources).size !== sources.length) {
    throw contractError("SALES_IMPORT_MAPPING_INVALID", { targetField });
  }
  if (transform.sourceCount !== undefined && sources.length !== transform.sourceCount) {
    throw contractError("SALES_IMPORT_MAPPING_INVALID", { targetField });
  }
  if (transform.minimumSourceCount !== undefined && sources.length < transform.minimumSourceCount) {
    throw contractError("SALES_IMPORT_MAPPING_INVALID", { targetField });
  }
  if (sources.some(isProhibitedSourceField)) {
    throw contractError("SALES_IMPORT_PROHIBITED_SOURCE_FIELD", { targetField });
  }
  if (transformId === "constant" && !Object.hasOwn(value, "constant")) {
    throw contractError("SALES_IMPORT_MAPPING_INVALID", { targetField });
  }
  if (transformId === "constant"
    && value.constant !== null
    && typeof value.constant !== "string"
    && typeof value.constant !== "boolean"
    && !Number.isSafeInteger(value.constant)) {
    throw contractError("SALES_IMPORT_MAPPING_INVALID", { targetField });
  }
  if (transformId !== "constant" && Object.hasOwn(value, "constant")) {
    throw contractError("SALES_IMPORT_MAPPING_INVALID", { targetField });
  }
  return {
    sources,
    transform: transformId,
    ...(transformId === "constant" ? { constant: value.constant } : {}),
  };
}

function normalizeBranchMappings(value = {}) {
  if (!isPlainRecord(value)) throw contractError("SALES_IMPORT_BRANCH_MAPPINGS_INVALID");
  const normalized = Object.create(null);
  for (const [externalIdValue, locationIdValue] of Object.entries(value)) {
    const externalId = String(externalIdValue).trim();
    if (!externalId || externalId.length > 80 || /[\u0000-\u001f\u007f]/.test(externalId)) {
      throw contractError("SALES_IMPORT_BRANCH_MAPPINGS_INVALID");
    }
    normalized[externalId] = normalizedIdentifier(
      locationIdValue,
      "SALES_IMPORT_BRANCH_MAPPINGS_INVALID",
      80,
    );
  }
  return normalized;
}

function normalizeResolvedDecisions(value = []) {
  if (!Array.isArray(value)) throw contractError("SALES_IMPORT_DECISIONS_INVALID");
  const normalized = [];
  const seen = new Set();
  for (const decision of value) {
    exactKeys(decision, ["id", "evidenceId"], "SALES_IMPORT_DECISIONS_INVALID");
    const id = String(decision.id || "");
    if (!Object.hasOwn(SALES_ANALYTICS_DECISION_GATES, id) || seen.has(id)) {
      throw contractError("SALES_IMPORT_DECISIONS_INVALID");
    }
    const evidenceId = normalizedIdentifier(
      decision.evidenceId,
      "SALES_IMPORT_DECISIONS_INVALID",
      120,
    );
    seen.add(id);
    normalized.push({ id, evidenceId });
  }
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeSalesImportProfile(value) {
  exactKeys(value, [
    "contractVersion",
    "id",
    "name",
    "entityId",
    "sourceSchemaSha256",
    "sourceFields",
    "mapping",
    "branchMappings",
    "resolvedDecisions",
  ], "SALES_IMPORT_PROFILE_INVALID");
  if (value.contractVersion !== SALES_IMPORT_CONTRACT_VERSION) {
    throw contractError("SALES_IMPORT_CONTRACT_VERSION_UNSUPPORTED");
  }
  const id = normalizedIdentifier(value.id, "SALES_IMPORT_PROFILE_INVALID", 80);
  const name = String(value.name || "").trim();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw contractError("SALES_IMPORT_PROFILE_INVALID");
  }
  const entityId = String(value.entityId || "");
  const entity = salesAnalyticsEntity(entityId);
  if (!entity?.importable) throw contractError("SALES_IMPORT_ENTITY_INVALID");
  if (!isPlainRecord(value.mapping)) throw contractError("SALES_IMPORT_MAPPING_INVALID");

  const mapping = Object.create(null);
  for (const [targetField, definition] of Object.entries(value.mapping)) {
    const fieldDefinition = Object.hasOwn(entity.fields, targetField) ? entity.fields[targetField] : null;
    if (!fieldDefinition) {
      throw contractError("SALES_IMPORT_TARGET_FIELD_INVALID", { targetField });
    }
    mapping[targetField] = normalizeMappingDefinition(targetField, definition, fieldDefinition);
  }
  for (const [fieldId, definition] of Object.entries(entity.fields)) {
    if (definition.required && !mapping[fieldId]) {
      throw contractError("SALES_IMPORT_REQUIRED_MAPPING_MISSING", { targetField: fieldId });
    }
  }

  const sourceFields = [...new Set(
    Object.values(mapping).flatMap((definition) => definition.sources),
  )].sort();
  const expectedSchemaSha256 = salesSourceSchemaSha256(sourceFields);
  const sourceSchemaSha256 = normalizedSha256(
    value.sourceSchemaSha256,
    "SALES_IMPORT_SOURCE_SCHEMA_INVALID",
  );
  if (sourceSchemaSha256 !== expectedSchemaSha256) {
    throw contractError("SALES_IMPORT_SOURCE_SCHEMA_MISMATCH");
  }
  if (value.sourceFields !== undefined
    && (!Array.isArray(value.sourceFields)
      || JSON.stringify(value.sourceFields) !== JSON.stringify(sourceFields))) {
    throw contractError("SALES_IMPORT_SOURCE_SCHEMA_MISMATCH");
  }

  const profile = deepFreeze({
    contractVersion: SALES_IMPORT_CONTRACT_VERSION,
    id,
    name,
    entityId,
    sourceSchemaSha256,
    sourceFields,
    mapping,
    branchMappings: normalizeBranchMappings(value.branchMappings),
    resolvedDecisions: normalizeResolvedDecisions(value.resolvedDecisions),
  });
  SALES_IMPORT_PROFILES.add(profile);
  return profile;
}

function normalizedProfileFingerprint(profile) {
  return crypto.createHash("sha256")
    .update(canonicalJsonString(profile))
    .digest("hex");
}

function salesImportProfileFingerprint(value) {
  return normalizedProfileFingerprint(
    SALES_IMPORT_PROFILES.has(value) ? value : normalizeSalesImportProfile(value),
  );
}

function normalizeSalesImportSource(value) {
  exactKeys(value, [
    "adapterId",
    "contentSha256",
    "sourceSchemaSha256",
    "snapshotAt",
    "timeZone",
    "proposalConfirmed",
  ], "SALES_IMPORT_SOURCE_INVALID");
  const adapterId = String(value.adapterId || "");
  const adapter = Object.hasOwn(SALES_SOURCE_ADAPTERS, adapterId) ? SALES_SOURCE_ADAPTERS[adapterId] : null;
  if (!adapter) throw contractError("SALES_IMPORT_ADAPTER_UNKNOWN");
  const snapshotAt = String(value.snapshotAt || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshotAt)
    || new Date(snapshotAt).toISOString() !== snapshotAt) {
    throw contractError("SALES_IMPORT_SNAPSHOT_TIME_INVALID");
  }
  if (value.timeZone !== "Europe/Vienna") throw contractError("SALES_IMPORT_TIME_ZONE_INVALID");
  if (value.proposalConfirmed !== undefined && typeof value.proposalConfirmed !== "boolean") {
    throw contractError("SALES_IMPORT_SOURCE_INVALID");
  }
  return deepFreeze({
    adapterId,
    contentSha256: normalizedSha256(value.contentSha256, "SALES_IMPORT_CONTENT_FINGERPRINT_INVALID"),
    sourceSchemaSha256: normalizedSha256(value.sourceSchemaSha256, "SALES_IMPORT_SOURCE_SCHEMA_INVALID"),
    snapshotAt,
    timeZone: "Europe/Vienna",
    proposalConfirmed: value.proposalConfirmed === true,
  });
}

function canonicalScalar(value) {
  if (typeof value === "string" || typeof value === "boolean" || Number.isSafeInteger(value)) {
    return String(value).trim();
  }
  throw contractError("SALES_IMPORT_SOURCE_VALUE_INVALID");
}

function validDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function normalizeDateDmy(value) {
  const match = canonicalScalar(value).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) throw contractError("SALES_IMPORT_DATE_INVALID");
  const result = `${match[3]}-${match[2]}-${match[1]}`;
  if (!validDate(result)) throw contractError("SALES_IMPORT_DATE_INVALID");
  return result;
}

function normalizeTime(value) {
  const match = canonicalScalar(value).match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] || 0) > 59) {
    throw contractError("SALES_IMPORT_TIME_INVALID");
  }
  return `${match[1]}:${match[2]}:${match[3] || "00"}`;
}

function normalizeDecimal4(value, decimalSeparator) {
  if (typeof value === "number") throw contractError("SALES_IMPORT_BINARY_FLOAT_FORBIDDEN");
  const source = String(value ?? "").trim();
  const escapedSeparator = decimalSeparator === "," ? "," : "\.";
  const match = source.match(new RegExp(`^(-?)(0|[1-9]\\d*)(?:${escapedSeparator}(\\d{1,4}))?$`));
  if (!match) throw contractError("SALES_IMPORT_DECIMAL4_INVALID");
  const negative = match[1] === "-" && (match[2] !== "0" || /[1-9]/.test(match[3] || ""));
  return `${negative ? "-" : ""}${match[2]}.${String(match[3] || "").padEnd(4, "0")}`;
}

function normalizeBooleanDe(value) {
  if (typeof value === "boolean") return value;
  const normalized = normalizedHeader(value);
  if (["1", "ja", "true", "aktiv"].includes(normalized)) return true;
  if (["0", "nein", "false", "inaktiv"].includes(normalized)) return false;
  throw contractError("SALES_IMPORT_BOOLEAN_INVALID");
}

function normalizeSafeInteger(value) {
  if (Number.isSafeInteger(value)) return value;
  const text = String(value ?? "").trim();
  if (!/^-?(?:0|[1-9]\d*)$/.test(text)) throw contractError("SALES_IMPORT_INTEGER_INVALID");
  const result = Number(text);
  if (!Number.isSafeInteger(result)) throw contractError("SALES_IMPORT_INTEGER_INVALID");
  return result;
}

function normalizeUtcTimestamp(value) {
  const source = canonicalScalar(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(source)) {
    throw contractError("SALES_IMPORT_UTC_TIMESTAMP_INVALID");
  }
  try {
    if (new Date(source).toISOString() !== source) throw new Error("invalid");
  } catch {
    throw contractError("SALES_IMPORT_UTC_TIMESTAMP_INVALID");
  }
  return source;
}

function normalizeText(value, fieldDefinition, identifier = false) {
  const result = canonicalScalar(value);
  if (fieldDefinition.maxLength && result.length > fieldDefinition.maxLength) {
    throw contractError("SALES_IMPORT_TEXT_TOO_LONG");
  }
  if (identifier && (!result || /[\u0000-\u001f\u007f]/.test(result))) {
    throw contractError("SALES_IMPORT_IDENTIFIER_INVALID");
  }
  return result;
}

function normalizeConstant(value, fieldDefinition) {
  switch (fieldDefinition.kind) {
    case "text": return normalizeText(value, fieldDefinition, false);
    case "identifier": return normalizeText(value, fieldDefinition, true);
    case "date": {
      const result = canonicalScalar(value);
      if (!validDate(result)) throw contractError("SALES_IMPORT_DATE_INVALID");
      return result;
    }
    case "time": return normalizeTime(value);
    case "utc_timestamp": return normalizeUtcTimestamp(value);
    case "decimal4": return normalizeDecimal4(value, ".");
    case "safe_integer": return normalizeSafeInteger(value);
    case "boolean": return normalizeBooleanDe(value);
    default: throw contractError("SALES_IMPORT_TRANSFORM_INVALID");
  }
}

function mappedValue(row, definition, fieldDefinition, profile) {
  const values = definition.sources.map((source) => row[source]);
  const first = values[0];
  if (definition.transform !== "constant"
    && values.every((value) => value === undefined || value === null || String(value).trim() === "")) {
    return null;
  }
  switch (definition.transform) {
    case "trim_text": return normalizeText(first, fieldDefinition, false);
    case "identifier_text": return normalizeText(first, fieldDefinition, true);
    case "sha256_key": {
      const parts = values.map(canonicalScalar);
      if (parts.some((part) => !part)) throw contractError("SALES_IMPORT_SOURCE_KEY_INVALID");
      return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
    }
    case "date_iso": {
      const result = canonicalScalar(first);
      if (!validDate(result)) throw contractError("SALES_IMPORT_DATE_INVALID");
      return result;
    }
    case "date_dmy": return normalizeDateDmy(first);
    case "time_hms": return normalizeTime(first);
    case "utc_timestamp": return normalizeUtcTimestamp(first);
    case "decimal4_canonical": return normalizeDecimal4(first, ".");
    case "decimal4_de": return normalizeDecimal4(first, ",");
    case "safe_integer": return normalizeSafeInteger(first);
    case "boolean_de": return normalizeBooleanDe(first);
    case "branch_map": {
      const externalId = canonicalScalar(first);
      const locationId = profile.branchMappings[externalId];
      if (!locationId) throw new SalesImportReviewSignal("SALES_IMPORT_BRANCH_MAPPING_REQUIRED");
      return locationId;
    }
    case "constant": return normalizeConstant(definition.constant, fieldDefinition);
    default: throw contractError("SALES_IMPORT_TRANSFORM_INVALID");
  }
}

function unresolvedDecisionIds(profile) {
  const entity = salesAnalyticsEntity(profile.entityId);
  const required = new Set(entity.decisionGates || []);
  for (const definition of Object.values(entity.fields)) {
    for (const decisionId of definition.decisionGates || []) required.add(decisionId);
  }
  for (const decision of profile.resolvedDecisions) required.delete(decision.id);
  return [...required].sort();
}

function sanitizedIssue(rowNumber, code, targetField = "") {
  return Object.freeze({ rowNumber, code, targetField });
}

function normalizeRow(row, rowNumber, profile, entity) {
  if (!isPlainRecord(row)) throw contractError("SALES_IMPORT_ROW_INVALID", { rowNumber });
  const actualFields = Object.keys(row).sort();
  if (JSON.stringify(actualFields) !== JSON.stringify(profile.sourceFields)) {
    throw contractError("SALES_IMPORT_ROW_SCHEMA_MISMATCH", { rowNumber });
  }
  const data = {};
  const issues = [];
  let rejected = false;
  for (const [targetField, definition] of Object.entries(profile.mapping)) {
    const fieldDefinition = entity.fields[targetField];
    try {
      const value = mappedValue(row, definition, fieldDefinition, profile);
      if (fieldDefinition.required && (value === null || value === "")) {
        throw contractError("SALES_IMPORT_REQUIRED_VALUE_MISSING");
      }
      data[targetField] = value;
      if (value !== null && fieldDefinition.persistence === "staging_only") {
        issues.push(sanitizedIssue(rowNumber, "SALES_IMPORT_STAGING_FIELD_PRESENT", targetField));
      }
    } catch (error) {
      if (error instanceof SalesImportReviewSignal) {
        data[targetField] = null;
        issues.push(sanitizedIssue(rowNumber, error.code, targetField));
      } else if (error instanceof SalesImportContractError) {
        data[targetField] = null;
        issues.push(sanitizedIssue(rowNumber, error.code, targetField));
        rejected = true;
      } else {
        throw error;
      }
    }
  }
  const fingerprint = crypto.createHash("sha256")
    .update(canonicalJsonString(data))
    .digest("hex");
  return {
    rowNumber,
    status: rejected ? "rejected" : (issues.length ? "needs_review" : "accepted"),
    fingerprint,
    data,
    issues,
  };
}

function createSalesImportPreview({ profile: profileInput, source: sourceInput, rows } = {}) {
  const profile = normalizeSalesImportProfile(profileInput);
  const profileFingerprintSha256 = normalizedProfileFingerprint(profile);
  const source = normalizeSalesImportSource(sourceInput);
  const adapter = SALES_SOURCE_ADAPTERS[source.adapterId];
  if (adapter.status !== "foundation_ready") {
    throw contractError("SALES_IMPORT_ADAPTER_NOT_READY", { adapterId: adapter.id });
  }
  if (source.sourceSchemaSha256 !== profile.sourceSchemaSha256) {
    throw contractError("SALES_IMPORT_SOURCE_SCHEMA_MISMATCH");
  }
  if (!Array.isArray(rows) || rows.length > SALES_IMPORT_PREVIEW_ROW_LIMIT) {
    throw contractError("SALES_IMPORT_PREVIEW_ROW_LIMIT");
  }

  const entity = salesAnalyticsEntity(profile.entityId);
  const records = [];
  const issues = [];
  const seenKeys = new Set();
  const summary = { total: rows.length, accepted: 0, needsReview: 0, rejected: 0, duplicate: 0 };

  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = index + 1;
    let record;
    try {
      record = normalizeRow(rows[index], rowNumber, profile, entity);
    } catch (error) {
      if (!(error instanceof SalesImportContractError)) throw error;
      const issue = sanitizedIssue(rowNumber, error.code, error.details.targetField || "");
      records.push(deepFreeze({ rowNumber, status: "rejected", fingerprint: "", data: {}, issues: [issue] }));
      issues.push(issue);
      summary.rejected += 1;
      continue;
    }

    const recordKey = record.data[entity.recordKey];
    if (record.status !== "rejected" && recordKey && seenKeys.has(recordKey)) {
      const issue = sanitizedIssue(rowNumber, "SALES_IMPORT_DUPLICATE_RECORD", entity.recordKey);
      record.status = "duplicate";
      record.issues.push(issue);
    } else if (record.status !== "rejected" && recordKey) {
      seenKeys.add(recordKey);
    }

    if (record.status === "accepted") summary.accepted += 1;
    else if (record.status === "needs_review") summary.needsReview += 1;
    else if (record.status === "duplicate") summary.duplicate += 1;
    else summary.rejected += 1;
    issues.push(...record.issues);
    records.push(deepFreeze(record));
  }

  const idempotencyKey = crypto.createHash("sha256").update(canonicalJsonString({
    contractVersion: SALES_IMPORT_CONTRACT_VERSION,
    modelVersion: SALES_ANALYTICS_MODEL_VERSION,
    profileId: profile.id,
    entityId: profile.entityId,
    profileFingerprintSha256,
    contentSha256: source.contentSha256,
    sourceSchemaSha256: source.sourceSchemaSha256,
  })).digest("hex");

  const preview = deepFreeze({
    contractVersion: SALES_IMPORT_CONTRACT_VERSION,
    modelVersion: SALES_ANALYTICS_MODEL_VERSION,
    mode: "dry_run",
    persistence: "none",
    canCommit: false,
    idempotencyKey,
    profile: {
      id: profile.id,
      entityId: profile.entityId,
      fingerprintSha256: profileFingerprintSha256,
    },
    source,
    unresolvedDecisionIds: unresolvedDecisionIds(profile),
    summary,
    records,
    issues,
  });
  SALES_IMPORT_PREVIEWS.add(preview);
  return preview;
}

function assertSalesImportPreview(value) {
  if (!SALES_IMPORT_PREVIEWS.has(value)) throw contractError("SALES_IMPORT_PREVIEW_INVALID");
  return value;
}

module.exports = {
  SALES_IMPORT_CONTRACT_VERSION,
  SALES_IMPORT_PREVIEW_ROW_LIMIT,
  SALES_SOURCE_ADAPTERS,
  SALES_IMPORT_TRANSFORMS: TRANSFORMS,
  SalesImportContractError,
  isProhibitedSourceField,
  salesSourceSchemaSha256,
  salesImportProfileFingerprint,
  normalizeSalesImportProfile,
  normalizeSalesImportSource,
  createSalesImportPreview,
  assertSalesImportPreview,
};

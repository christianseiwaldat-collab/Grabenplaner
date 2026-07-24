"use strict";

const { canonicalSha256 } = require("./work-rules/receipt");

const RETENTION_GOVERNANCE_NOTICE = [
  "Dieses Modul unterstützt eine dokumentierte Aufbewahrungs-Governance.",
  "Es bewertet ausschließlich Vorschaukandidaten und führt keine Löschung,",
  "Anonymisierung oder Archivierung aus. Konkrete Fristen und Rechtsgrundlagen",
  "müssen vor Aktivierung fachlich und rechtlich geprüft werden.",
].join(" ");

const OFFICIAL_RETENTION_SOURCES = Object.freeze({
  eu_gdpr: Object.freeze({
    id: "eu-gdpr",
    authority: "Europäische Union",
    title: "Verordnung (EU) 2016/679 (Datenschutz-Grundverordnung)",
    url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
    jurisdiction: "EU",
    reference: "insbesondere Art. 5, 6, 17 und 30",
  }),
  at_dsg: Object.freeze({
    id: "at-dsg",
    authority: "Republik Österreich",
    title: "Datenschutzgesetz (DSG)",
    url: "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10001597",
    jurisdiction: "AT",
    reference: "geltende Fassung im RIS",
  }),
});

const RETENTION_RULE_STATUSES = Object.freeze(["draft", "active", "retired"]);
const RETENTION_START_TRIGGERS = Object.freeze([
  "record_created",
  "record_closed",
  "case_resolved",
  "employment_ended",
  "contract_ended",
  "purpose_ended",
  "custom_event",
]);
const RETENTION_DISPOSITIONS = Object.freeze(["manual_review", "delete", "anonymize", "archive"]);
const RETENTION_DURATION_UNITS = Object.freeze(["days", "months", "years"]);
const LEGAL_HOLD_BEHAVIORS = Object.freeze(["exclude_while_active"]);
const LEGAL_HOLD_STATUSES = Object.freeze(["active", "released"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;

class RetentionPolicyError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = "RetentionPolicyError";
    this.code = code;
  }
}

function policyError(message, code) {
  return new RetentionPolicyError(message, code);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label, code = "RETENTION_OBJECT_INVALID") {
  if (!isPlainObject(value)) throw policyError(`${label} muss ein Objekt sein.`, code);
  return value;
}

function assertExactKeys(value, allowed, label, code = "RETENTION_FIELDS_INVALID") {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw policyError(`${label} enthält nicht unterstützte Felder: ${unexpected.sort().join(", ")}.`, code);
  }
}

function requiredString(value, label, { maximum = 500, identifier = false } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || (identifier && !IDENTIFIER_PATTERN.test(normalized))) {
    throw policyError(`${label} ist ungültig.`, "RETENTION_STRING_INVALID");
  }
  return normalized;
}

function optionalString(value, label, options = {}) {
  if (value === undefined || value === null || value === "") return "";
  return requiredString(value, label, options);
}

function isoDate(value, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return null;
  const normalized = String(value || "").trim();
  const match = DATE_PATTERN.exec(normalized);
  if (!match) throw policyError(`${label} muss im Format YYYY-MM-DD angegeben werden.`, "RETENTION_DATE_INVALID");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw policyError(`${label} ist kein gültiges Kalenderdatum.`, "RETENTION_DATE_INVALID");
  }
  return normalized;
}

function compareDate(left, right) {
  return String(left).localeCompare(String(right));
}

function integer(value, label, { minimum = 1, maximum = 100000 } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw policyError(`${label} muss eine ganze Zahl zwischen ${minimum} und ${maximum} sein.`, "RETENTION_INTEGER_INVALID");
  }
  return normalized;
}

function enumValue(value, allowed, label, code = "RETENTION_ENUM_INVALID") {
  const normalized = String(value || "").trim();
  if (!allowed.includes(normalized)) {
    throw policyError(`${label} ist nicht unterstützt.`, code);
  }
  return normalized;
}

function normalizeGovernanceSource(input) {
  const source = assertPlainObject(input, "Eine Quelle", "RETENTION_SOURCE_INVALID");
  assertExactKeys(
    source,
    new Set(["id", "authority", "title", "url", "jurisdiction", "reference"]),
    "Die Quelle",
    "RETENTION_SOURCE_FIELDS_INVALID",
  );
  const url = requiredString(source.url, "Die Quellen-URL", { maximum: 1000 });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw policyError("Die Quellen-URL ist ungültig.", "RETENTION_SOURCE_URL_INVALID");
  }
  if (parsed.protocol !== "https:") {
    throw policyError("Die Quellen-URL muss HTTPS verwenden.", "RETENTION_SOURCE_URL_INVALID");
  }
  return {
    id: requiredString(source.id, "Die Quellen-ID", { maximum: 128, identifier: true }),
    authority: requiredString(source.authority, "Die herausgebende Stelle", { maximum: 300 }),
    title: requiredString(source.title, "Der Quellentitel", { maximum: 500 }),
    url: parsed.toString(),
    jurisdiction: requiredString(source.jurisdiction, "Der Geltungsbereich", { maximum: 32, identifier: true }),
    reference: optionalString(source.reference, "Die Fundstelle", { maximum: 500 }),
  };
}

function normalizeRetentionDuration(input) {
  const duration = assertPlainObject(input, "Die Aufbewahrungsdauer", "RETENTION_DURATION_INVALID");
  assertExactKeys(duration, new Set(["value", "unit"]), "Die Aufbewahrungsdauer", "RETENTION_DURATION_FIELDS_INVALID");
  const unit = enumValue(duration.unit, RETENTION_DURATION_UNITS, "Die Einheit der Aufbewahrungsdauer");
  const maximum = unit === "days" ? 36500 : unit === "months" ? 1200 : 100;
  return {
    value: integer(duration.value, "Die Aufbewahrungsdauer", { minimum: 1, maximum }),
    unit,
  };
}

function normalizeRuleLegalHold(input) {
  const legalHold = assertPlainObject(input, "Die Legal-Hold-Regel", "RETENTION_LEGAL_HOLD_INVALID");
  assertExactKeys(legalHold, new Set(["behavior"]), "Die Legal-Hold-Regel", "RETENTION_LEGAL_HOLD_FIELDS_INVALID");
  return {
    behavior: enumValue(legalHold.behavior, LEGAL_HOLD_BEHAVIORS, "Das Legal-Hold-Verhalten"),
  };
}

function normalizeRetentionRuleVersion(input) {
  const rule = assertPlainObject(input, "Die Aufbewahrungsregel", "RETENTION_RULE_INVALID");
  assertExactKeys(
    rule,
    new Set([
      "schemaVersion", "id", "version", "category", "title", "status", "validFrom", "validTo",
      "sources", "startTrigger", "retention", "disposition", "legalHold", "contentSha256",
    ]),
    "Die Aufbewahrungsregel",
    "RETENTION_RULE_FIELDS_INVALID",
  );
  const schemaVersion = rule.schemaVersion === undefined
    ? 1
    : integer(rule.schemaVersion, "Die Schema-Version", { minimum: 1, maximum: 1 });
  const validFrom = isoDate(rule.validFrom, "Gültig ab");
  const validTo = isoDate(rule.validTo, "Gültig bis", { optional: true });
  if (validTo && compareDate(validTo, validFrom) < 0) {
    throw policyError("Das Gültigkeitsende darf nicht vor dem Gültigkeitsbeginn liegen.", "RETENTION_VALIDITY_INVALID");
  }
  if (!Array.isArray(rule.sources) || rule.sources.length === 0 || rule.sources.length > 20) {
    throw policyError("Eine Regel benötigt mindestens eine und höchstens 20 dokumentierte Quellen.", "RETENTION_SOURCES_INVALID");
  }
  const sources = rule.sources.map(normalizeGovernanceSource);
  if (new Set(sources.map((source) => source.id)).size !== sources.length) {
    throw policyError("Quellen-IDs dürfen innerhalb einer Regel nicht doppelt vorkommen.", "RETENTION_SOURCE_DUPLICATE");
  }
  return {
    schemaVersion,
    id: requiredString(rule.id, "Die Regel-ID", { maximum: 128, identifier: true }),
    version: requiredString(rule.version, "Die Regel-Version", { maximum: 64, identifier: true }),
    category: requiredString(rule.category, "Die Datenkategorie", { maximum: 128, identifier: true }),
    title: requiredString(rule.title, "Der Regeltitel", { maximum: 300 }),
    status: enumValue(rule.status, RETENTION_RULE_STATUSES, "Der Regelstatus"),
    validFrom,
    validTo,
    sources,
    startTrigger: enumValue(rule.startTrigger, RETENTION_START_TRIGGERS, "Der Fristbeginn"),
    retention: normalizeRetentionDuration(rule.retention),
    disposition: enumValue(rule.disposition, RETENTION_DISPOSITIONS, "Die vorgesehene Folgemaßnahme"),
    legalHold: normalizeRuleLegalHold(rule.legalHold),
  };
}

function retentionRuleVersionReceipt(input) {
  const rule = normalizeRetentionRuleVersion(input);
  return canonicalSha256({
    schemaVersion: 1,
    kind: "retention_rule_version",
    rule,
  });
}

function createRetentionRuleVersion(input) {
  const rule = normalizeRetentionRuleVersion(input);
  return {
    ...rule,
    contentSha256: retentionRuleVersionReceipt(rule),
  };
}

function verifyRetentionRuleVersion(input) {
  try {
    const value = assertPlainObject(input, "Die Aufbewahrungsregel", "RETENTION_RULE_INVALID");
    const supplied = String(value.contentSha256 || "").toLowerCase();
    return SHA256_PATTERN.test(supplied) && supplied === retentionRuleVersionReceipt(value);
  } catch {
    return false;
  }
}

function normalizePreviewRecord(input) {
  const record = assertPlainObject(input, "Ein Aufbewahrungsdatensatz", "RETENTION_RECORD_INVALID");
  assertExactKeys(
    record,
    new Set(["id", "category", "subjectId", "startTrigger", "startAt"]),
    "Der Aufbewahrungsdatensatz",
    "RETENTION_RECORD_FIELDS_INVALID",
  );
  return {
    id: requiredString(record.id, "Die Datensatz-ID", { maximum: 128, identifier: true }),
    category: requiredString(record.category, "Die Datenkategorie", { maximum: 128, identifier: true }),
    subjectId: optionalString(record.subjectId, "Die Betroffenen-ID", { maximum: 128, identifier: true }),
    startTrigger: enumValue(record.startTrigger, RETENTION_START_TRIGGERS, "Der Fristbeginn"),
    startAt: isoDate(record.startAt, "Das Datum des Fristbeginns"),
  };
}

function normalizeLegalHold(input) {
  const hold = assertPlainObject(input, "Ein Legal Hold", "RETENTION_HOLD_INVALID");
  assertExactKeys(
    hold,
    new Set(["id", "status", "recordId", "subjectId", "category", "validFrom", "validTo", "reasonCode"]),
    "Der Legal Hold",
    "RETENTION_HOLD_FIELDS_INVALID",
  );
  const validFrom = isoDate(hold.validFrom, "Legal Hold gültig ab");
  const validTo = isoDate(hold.validTo, "Legal Hold gültig bis", { optional: true });
  if (validTo && compareDate(validTo, validFrom) < 0) {
    throw policyError("Das Ende eines Legal Holds darf nicht vor seinem Beginn liegen.", "RETENTION_HOLD_VALIDITY_INVALID");
  }
  const normalized = {
    id: requiredString(hold.id, "Die Legal-Hold-ID", { maximum: 128, identifier: true }),
    status: enumValue(hold.status, LEGAL_HOLD_STATUSES, "Der Legal-Hold-Status"),
    recordId: optionalString(hold.recordId, "Die Datensatz-ID", { maximum: 128, identifier: true }),
    subjectId: optionalString(hold.subjectId, "Die Betroffenen-ID", { maximum: 128, identifier: true }),
    category: optionalString(hold.category, "Die Datenkategorie", { maximum: 128, identifier: true }),
    validFrom,
    validTo,
    reasonCode: requiredString(hold.reasonCode, "Der Legal-Hold-Grundcode", { maximum: 128, identifier: true }),
  };
  if (!normalized.recordId && !normalized.subjectId && !normalized.category) {
    throw policyError("Ein Legal Hold benötigt mindestens einen Datensatz-, Betroffenen- oder Kategoriebezug.", "RETENTION_HOLD_SCOPE_INVALID");
  }
  return normalized;
}

function dateParts(value) {
  const match = DATE_PATTERN.exec(value);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function daysInUtcMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addDuration(startAt, duration) {
  const parts = dateParts(startAt);
  if (duration.unit === "days") {
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + duration.value));
    return date.toISOString().slice(0, 10);
  }
  const addedMonths = duration.unit === "years" ? duration.value * 12 : duration.value;
  const absoluteMonth = (parts.year * 12) + (parts.month - 1) + addedMonths;
  const year = Math.floor(absoluteMonth / 12);
  const monthIndex = absoluteMonth % 12;
  const day = Math.min(parts.day, daysInUtcMonth(year, monthIndex));
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function dateWithin(value, validFrom, validTo) {
  return compareDate(value, validFrom) >= 0 && (!validTo || compareDate(value, validTo) <= 0);
}

function holdMatchesRecord(hold, record, asOf) {
  if (hold.status !== "active" || !dateWithin(asOf, hold.validFrom, hold.validTo)) return false;
  if (hold.recordId && hold.recordId !== record.id) return false;
  if (hold.subjectId && hold.subjectId !== record.subjectId) return false;
  if (hold.category && hold.category !== record.category) return false;
  return true;
}

function assessmentReceipt(assessment) {
  return canonicalSha256({
    schemaVersion: 1,
    kind: "retention_preview_assessment",
    assessment,
  });
}

function createAssessment(value) {
  const assessment = {
    recordId: value.recordId,
    category: value.category,
    subjectId: value.subjectId,
    state: value.state,
    reasonCode: value.reasonCode,
    ruleVersionId: value.ruleVersionId || null,
    retentionStartAt: value.retentionStartAt,
    dueAt: value.dueAt || null,
    disposition: value.disposition || null,
    legalHoldIds: value.legalHoldIds || [],
    approvalRequired: true,
    automaticExecution: false,
  };
  return { ...assessment, receiptSha256: assessmentReceipt(assessment) };
}

function assertNoActiveRuleOverlap(rules) {
  const groups = new Map();
  for (const rule of rules.filter((candidate) => candidate.status === "active")) {
    const key = `${rule.category}\u0000${rule.startTrigger}`;
    const existing = groups.get(key) || [];
    for (const other of existing) {
      const overlaps = (!other.validTo || compareDate(rule.validFrom, other.validTo) <= 0)
        && (!rule.validTo || compareDate(other.validFrom, rule.validTo) <= 0);
      if (overlaps) {
        throw policyError(
          `Aktive Regelversionen für ${rule.category}/${rule.startTrigger} überschneiden sich.`,
          "RETENTION_RULE_OVERLAP",
        );
      }
    }
    existing.push(rule);
    groups.set(key, existing);
  }
}

function previewRetentionCandidates(input = {}) {
  const options = assertPlainObject(input, "Die Vorschauparameter", "RETENTION_PREVIEW_INVALID");
  assertExactKeys(
    options,
    new Set(["ruleVersions", "records", "legalHolds", "asOf"]),
    "Die Vorschauparameter",
    "RETENTION_PREVIEW_FIELDS_INVALID",
  );
  if (!Array.isArray(options.ruleVersions) || !Array.isArray(options.records)) {
    throw policyError("Regelversionen und Datensätze müssen Listen sein.", "RETENTION_PREVIEW_LIST_INVALID");
  }
  if (options.ruleVersions.length > 10000 || options.records.length > 100000) {
    throw policyError("Die Vorschau überschreitet die zulässige Stapelgröße.", "RETENTION_PREVIEW_LIMIT");
  }
  const asOf = isoDate(options.asOf, "Der Vorschaustichtag");
  const rules = options.ruleVersions.map((rule) => {
    if (Object.prototype.hasOwnProperty.call(rule || {}, "contentSha256") && !verifyRetentionRuleVersion(rule)) {
      throw policyError("Eine Regelversion besitzt keinen gültigen unveränderlichen Beleg.", "RETENTION_RULE_RECEIPT_INVALID");
    }
    return normalizeRetentionRuleVersion(rule);
  });
  assertNoActiveRuleOverlap(rules);
  const records = options.records.map(normalizePreviewRecord);
  const legalHolds = (options.legalHolds || []).map(normalizeLegalHold);
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw policyError("Datensatz-IDs dürfen in einer Vorschau nicht doppelt vorkommen.", "RETENTION_RECORD_DUPLICATE");
  }
  if (new Set(legalHolds.map((hold) => hold.id)).size !== legalHolds.length) {
    throw policyError("Legal-Hold-IDs dürfen in einer Vorschau nicht doppelt vorkommen.", "RETENTION_HOLD_DUPLICATE");
  }

  const assessments = records.map((record) => {
    const applicable = rules.filter((rule) => (
      rule.status === "active"
      && rule.category === record.category
      && rule.startTrigger === record.startTrigger
      && dateWithin(record.startAt, rule.validFrom, rule.validTo)
    ));
    if (applicable.length === 0) {
      return createAssessment({
        ...record,
        recordId: record.id,
        retentionStartAt: record.startAt,
        state: "manual_review",
        reasonCode: "NO_APPLICABLE_RULE",
      });
    }
    if (applicable.length > 1) {
      throw policyError("Für einen Datensatz wurden mehrere aktive Regelversionen gefunden.", "RETENTION_RULE_AMBIGUOUS");
    }
    const rule = applicable[0];
    const ruleVersionId = `${rule.id}@${rule.version}`;
    const dueAt = addDuration(record.startAt, rule.retention);
    const matchingHolds = legalHolds.filter((hold) => holdMatchesRecord(hold, record, asOf));
    if (matchingHolds.length) {
      return createAssessment({
        ...record,
        recordId: record.id,
        retentionStartAt: record.startAt,
        state: "legal_hold",
        reasonCode: "ACTIVE_LEGAL_HOLD",
        ruleVersionId,
        dueAt,
        disposition: rule.disposition,
        legalHoldIds: matchingHolds.map((hold) => hold.id).sort(),
      });
    }
    const due = compareDate(dueAt, asOf) <= 0;
    return createAssessment({
      ...record,
      recordId: record.id,
      retentionStartAt: record.startAt,
      state: due ? "candidate" : "not_due",
      reasonCode: due ? "RETENTION_PERIOD_REACHED" : "RETENTION_PERIOD_RUNNING",
      ruleVersionId,
      dueAt,
      disposition: rule.disposition,
    });
  });

  const candidates = assessments.filter((assessment) => assessment.state === "candidate");
  const preview = {
    schemaVersion: 1,
    mode: "preview_only",
    asOf,
    automaticExecution: false,
    counts: {
      records: assessments.length,
      candidates: candidates.length,
      legalHold: assessments.filter((item) => item.state === "legal_hold").length,
      manualReview: assessments.filter((item) => item.state === "manual_review").length,
    },
    assessments,
    candidates,
  };
  return {
    ...preview,
    receiptSha256: canonicalSha256({
      schemaVersion: 1,
      kind: "retention_preview",
      preview,
    }),
  };
}

module.exports = {
  LEGAL_HOLD_BEHAVIORS,
  LEGAL_HOLD_STATUSES,
  OFFICIAL_RETENTION_SOURCES,
  RETENTION_DISPOSITIONS,
  RETENTION_DURATION_UNITS,
  RETENTION_GOVERNANCE_NOTICE,
  RETENTION_RULE_STATUSES,
  RETENTION_START_TRIGGERS,
  RetentionPolicyError,
  createRetentionRuleVersion,
  normalizeGovernanceSource,
  normalizeLegalHold,
  normalizeRetentionRuleVersion,
  previewRetentionCandidates,
  retentionRuleVersionReceipt,
  verifyRetentionRuleVersion,
};

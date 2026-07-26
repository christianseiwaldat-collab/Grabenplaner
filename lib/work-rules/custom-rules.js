"use strict";

const { canonicalSha256 } = require("./receipt");
const { getWorkRuleProfileVersion } = require("./store");

const CUSTOM_WORK_RULE_CATALOG_VERSION = "custom-work-rule-draft-v1";
const CUSTOM_WORK_RULE_NOTICE = [
  "Der Regelbaukasten speichert unveränderliche Fassungen eigener fachlicher Regeln.",
  "Entwürfe haben keine Auswirkung auf Dienstplan, Personalakt oder Regelprüfung.",
  "Veröffentlichung und Geltungszuordnung sind getrennte, prüfsummenbelegte Freigabevorgänge.",
].join(" ");

const CUSTOM_WORK_RULE_TYPES = Object.freeze([
  { id: "works_agreement", label: "Betriebsvereinbarung" },
  { id: "company_rule", label: "Unternehmensregel" },
  { id: "location_rule", label: "Standort- oder Abteilungsregel" },
]);

const CUSTOM_WORK_RULE_TOPICS = Object.freeze([
  { id: "working_time", label: "Arbeitszeit" },
  { id: "rest_time", label: "Arbeitsruhe" },
  { id: "scheduling", label: "Dienstplanung" },
  { id: "vacation", label: "Urlaub" },
  { id: "time_off", label: "Zeitausgleich" },
  { id: "absence", label: "Sonstige Abwesenheit" },
  { id: "youth_apprentice", label: "Jugendliche und Lehrlinge" },
  { id: "other", label: "Sonstige Personalregel" },
]);

const CUSTOM_WORK_RULE_SCOPES = Object.freeze([
  { id: "installation", label: "Gesamtes Unternehmen" },
  { id: "business_unit", label: "Betriebsteil" },
  { id: "location", label: "Filiale" },
  { id: "department", label: "Abteilung" },
  { id: "employee_group", label: "Beschäftigtengruppe" },
]);

const CUSTOM_WORK_RULE_REACTIONS = Object.freeze([
  { id: "advisory", label: "Hinweis anzeigen" },
  { id: "acknowledge", label: "Kenntnisnahme verlangen" },
  { id: "exception_required", label: "Begründete Ausnahme verlangen" },
  { id: "block", label: "Speichern blockieren" },
]);

const CUSTOM_WORK_RULE_SEVERITIES = Object.freeze([
  { id: "info", label: "Information" },
  { id: "warning", label: "Warnung" },
  { id: "critical", label: "Kritisch" },
]);

const CUSTOM_WORK_RULE_METRICS = Object.freeze([
  {
    id: "maximum_planned_daily_minutes",
    label: "Maximale geplante Arbeitszeit pro Tag",
    operator: "lte",
    operatorLabel: "höchstens",
    valueType: "integer",
    unit: "minutes",
    unitLabel: "Minuten",
    min: 1,
    max: 1440,
    step: 1,
    help: "Vergleicht die geplante Arbeitszeit eines Diensttags mit dem Grenzwert.",
  },
  {
    id: "maximum_planned_weekly_minutes",
    label: "Maximale geplante Arbeitszeit pro Woche",
    operator: "lte",
    operatorLabel: "höchstens",
    valueType: "integer",
    unit: "minutes",
    unitLabel: "Minuten",
    min: 1,
    max: 10080,
    step: 1,
    help: "Vergleicht die geplante Wochenarbeitszeit mit dem Grenzwert.",
  },
  {
    id: "minimum_planned_rest_minutes",
    label: "Mindestruhezeit zwischen zwei Diensten",
    operator: "gte",
    operatorLabel: "mindestens",
    valueType: "integer",
    unit: "minutes",
    unitLabel: "Minuten",
    min: 0,
    max: 10080,
    step: 1,
    help: "Vergleicht die geplante Ruhezeit zwischen zwei Diensten.",
  },
  {
    id: "maximum_consecutive_workdays",
    label: "Maximale aufeinanderfolgende Arbeitstage",
    operator: "lte",
    operatorLabel: "höchstens",
    valueType: "integer",
    unit: "days",
    unitLabel: "Tage",
    min: 1,
    max: 31,
    step: 1,
    help: "Zählt aufeinanderfolgende geplante Arbeitstage.",
  },
  {
    id: "maximum_saturdays_per_month",
    label: "Maximale Samstagsdienste pro Kalendermonat",
    operator: "lte",
    operatorLabel: "höchstens",
    valueType: "integer",
    unit: "days",
    unitLabel: "Samstage",
    min: 0,
    max: 5,
    step: 1,
    help: "Zählt geplante Samstagsdienste im jeweiligen Kalendermonat.",
  },
  {
    id: "earliest_shift_start_time",
    label: "Frühester geplanter Dienstbeginn",
    operator: "gte",
    operatorLabel: "nicht vor",
    valueType: "time",
    unit: "time",
    unitLabel: "Uhr",
    help: "Vergleicht den geplanten Dienstbeginn mit einer Uhrzeit.",
  },
  {
    id: "latest_shift_end_time",
    label: "Spätestes geplantes Dienstende",
    operator: "lte",
    operatorLabel: "nicht nach",
    valueType: "time",
    unit: "time",
    unitLabel: "Uhr",
    help: "Vergleicht das geplante Dienstende mit einer Uhrzeit.",
  },
  {
    id: "minimum_vacation_request_lead_days",
    label: "Mindestvorlauf für Urlaubsanträge",
    operator: "gte",
    operatorLabel: "mindestens",
    valueType: "integer",
    unit: "days",
    unitLabel: "Kalendertage",
    min: 0,
    max: 365,
    step: 1,
    help: "Vergleicht den Abstand zwischen Antrag und gewünschtem Urlaubsbeginn.",
  },
  {
    id: "minimum_time_off_request_lead_days",
    label: "Mindestvorlauf für Zeitausgleichsanträge",
    operator: "gte",
    operatorLabel: "mindestens",
    valueType: "integer",
    unit: "days",
    unitLabel: "Kalendertage",
    min: 0,
    max: 365,
    step: 1,
    help: "Vergleicht den Abstand zwischen Antrag und gewünschtem Zeitausgleich.",
  },
  {
    id: "maximum_vacation_days_per_request",
    label: "Maximale Urlaubstage je Antrag",
    operator: "lte",
    operatorLabel: "höchstens",
    valueType: "integer",
    unit: "days",
    unitLabel: "Urlaubstage",
    min: 1,
    max: 366,
    step: 1,
    help: "Vergleicht die anrechenbaren Urlaubstage eines einzelnen Antrags.",
  },
]);

const TYPE_IDS = new Set(CUSTOM_WORK_RULE_TYPES.map((entry) => entry.id));
const TOPIC_IDS = new Set(CUSTOM_WORK_RULE_TOPICS.map((entry) => entry.id));
const SCOPE_IDS = new Set(CUSTOM_WORK_RULE_SCOPES.map((entry) => entry.id));
const REACTION_IDS = new Set(CUSTOM_WORK_RULE_REACTIONS.map((entry) => entry.id));
const SEVERITY_IDS = new Set(CUSTOM_WORK_RULE_SEVERITIES.map((entry) => entry.id));
const METRIC_BY_ID = new Map(CUSTOM_WORK_RULE_METRICS.map((entry) => [entry.id, entry]));

function text(value, label, maximum, { required = false, minimum = 0 } = {}) {
  const normalized = String(value || "").trim();
  if (required && !normalized) throw new TypeError(`${label} fehlt.`);
  if (normalized.length < minimum) throw new TypeError(`${label} ist zu kurz.`);
  if (normalized.length > maximum) throw new TypeError(`${label} ist zu lang.`);
  return normalized;
}

function isoDate(value, label, { required = false } = {}) {
  const normalized = text(value, label, 10, { required });
  if (!normalized) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new TypeError(`${label} muss ein Datum im Format YYYY-MM-DD sein.`);
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new TypeError(`${label} ist kein gültiges Datum.`);
  }
  return normalized;
}

function httpsUrl(value, label) {
  const normalized = text(value, label, 1200);
  if (!normalized) return "";
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError(`${label} ist keine gültige Internetadresse.`);
  }
  if (parsed.protocol !== "https:") throw new TypeError(`${label} muss eine HTTPS-Adresse sein.`);
  return parsed.toString();
}

function normalizeCode(value) {
  const code = text(value, "Regelkürzel", 60, { required: true }).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(code)) {
    throw new TypeError("Das Regelkürzel darf nur Buchstaben, Zahlen, Punkt, Unterstrich und Bindestrich enthalten.");
  }
  return code;
}

function normalizeTime(value, label) {
  const normalized = text(value, label, 5, { required: true });
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(normalized);
  if (!match) throw new TypeError(`${label} muss eine Uhrzeit im Format HH:MM sein.`);
  return {
    stored: normalized,
    comparable: Number(match[1]) * 60 + Number(match[2]),
  };
}

function normalizeMetricValue(metric, value, label) {
  if (metric.valueType === "time") return normalizeTime(value, label);
  const submitted = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(submitted) || !Number.isInteger(submitted)) {
    throw new TypeError(`${label} muss eine ganze Zahl sein.`);
  }
  if (submitted < metric.min || submitted > metric.max) {
    throw new TypeError(`${label} muss zwischen ${metric.min} und ${metric.max} liegen.`);
  }
  return { stored: submitted, comparable: submitted };
}

function comparisonOutcome(operator, input, threshold) {
  if (input === null || input === undefined) return "unknown";
  if (operator === "lte") return input <= threshold ? "pass" : "fail";
  if (operator === "gte") return input >= threshold ? "pass" : "fail";
  throw new TypeError("Die Vergleichsart des Regelbausteins ist ungültig.");
}

function normalizeTestCases(metric, threshold, value = {}) {
  const positive = normalizeMetricValue(metric, value.positiveValue, "Positiver Testwert");
  const negative = normalizeMetricValue(metric, value.negativeValue, "Negativer Testwert");
  const positiveOutcome = comparisonOutcome(metric.operator, positive.comparable, threshold.comparable);
  const negativeOutcome = comparisonOutcome(metric.operator, negative.comparable, threshold.comparable);
  if (positiveOutcome !== "pass") {
    throw new TypeError("Der positive Testfall hält den gewählten Grenzwert nicht ein.");
  }
  if (negativeOutcome !== "fail") {
    throw new TypeError("Der negative Testfall verletzt den gewählten Grenzwert nicht.");
  }
  return [
    {
      id: "positive",
      label: "Regel eingehalten",
      input: positive.stored,
      expected: "pass",
      actual: positiveOutcome,
    },
    {
      id: "negative",
      label: "Regel verletzt",
      input: negative.stored,
      expected: "fail",
      actual: negativeOutcome,
    },
    {
      id: "unknown",
      label: "Prüfwert fehlt",
      input: null,
      expected: "unknown",
      actual: comparisonOutcome(metric.operator, null, threshold.comparable),
    },
  ];
}

function normalizeScope(db, scopeTypeValue, scopeKeyValue, ruleType) {
  const scopeType = text(scopeTypeValue, "Geltungsbereich", 30, { required: true });
  if (!SCOPE_IDS.has(scopeType)) throw new TypeError("Der Geltungsbereich ist ungültig.");
  if (ruleType === "location_rule" && !["location", "department"].includes(scopeType)) {
    throw new TypeError("Eine Standort- oder Abteilungsregel benötigt eine Filiale oder Abteilung als Geltungsbereich.");
  }
  if (scopeType === "installation") {
    return { type: scopeType, key: "", label: "Gesamtes Unternehmen" };
  }
  const scopeKey = text(scopeKeyValue, "Zuordnung des Geltungsbereichs", 160, { required: true });
  if (scopeType === "business_unit") {
    const row = db.prepare(`
      SELECT id, code, name
      FROM collective_agreement_business_units
      WHERE id = ? AND active = 1
    `).get(scopeKey);
    if (!row) throw new TypeError("Der ausgewählte aktive Betriebsteil wurde nicht gefunden.");
    return { type: scopeType, key: String(row.id), label: `${row.code} · ${row.name}` };
  }
  if (scopeType === "location") {
    const row = db.prepare("SELECT id, name FROM locations WHERE CAST(id AS TEXT) = ? AND active = 1").get(scopeKey);
    if (!row) throw new TypeError("Die ausgewählte aktive Filiale wurde nicht gefunden.");
    return { type: scopeType, key: String(row.id), label: `${row.id} · ${row.name}` };
  }
  if (scopeType === "department") {
    const row = db.prepare(`
      SELECT d.id, d.name, l.id AS location_id, l.name AS location_name
      FROM departments d
      JOIN locations l ON l.id = d.location_id
      WHERE CAST(d.id AS TEXT) = ? AND d.active = 1 AND l.active = 1
    `).get(scopeKey);
    if (!row) throw new TypeError("Die ausgewählte aktive Abteilung wurde nicht gefunden.");
    return {
      type: scopeType,
      key: String(row.id),
      label: `${row.location_id} · ${row.location_name} · ${row.name}`,
    };
  }
  return { type: scopeType, key: scopeKey, label: `Beschäftigtengruppe · ${scopeKey}` };
}

function assertDraftBoundary(value) {
  if (value.status && value.status !== "draft") {
    throw new TypeError("Über den Entwurfsweg können ausschließlich nicht wirksame Entwürfe gespeichert werden.");
  }
  if (value.reviewState && value.reviewState !== "draft") {
    throw new TypeError("Prüfung und Freigabe müssen über den gesonderten Governance-Workflow erfolgen.");
  }
  if (value.active === true || value.published === true || value.approved === true || value.assignable === true) {
    throw new TypeError("Freigabe, Veröffentlichung, Aktivierung und Zuordnung sind im Entwurfsweg nicht zulässig.");
  }
  if (value.enforcementMode && value.enforcementMode !== "monitor") {
    throw new TypeError("Ein Entwurf darf keinen aktiven Durchsetzungsmodus erhalten.");
  }
}

function normalizeDefinition(db, value = {}) {
  assertDraftBoundary(value);
  const ruleType = text(value.ruleType, "Regelart", 40, { required: true });
  if (!TYPE_IDS.has(ruleType)) throw new TypeError("Die Regelart ist ungültig.");
  const topic = text(value.topic, "Themenbereich", 40, { required: true });
  if (!TOPIC_IDS.has(topic)) throw new TypeError("Der Themenbereich ist ungültig.");
  const metric = METRIC_BY_ID.get(text(value.metric, "Regelbaustein", 80, { required: true }));
  if (!metric) throw new TypeError("Der Regelbaustein ist ungültig.");
  const threshold = normalizeMetricValue(metric, value.threshold, "Grenzwert");
  const reaction = text(value.reaction, "Vorgesehene Reaktion", 40, { required: true });
  if (!REACTION_IDS.has(reaction)) throw new TypeError("Die vorgesehene Reaktion ist ungültig.");
  const severity = text(value.severity, "Schweregrad", 20, { required: true });
  if (!SEVERITY_IDS.has(severity)) throw new TypeError("Der Schweregrad ist ungültig.");
  if (reaction === "block" && severity !== "critical") {
    throw new TypeError("Eine vorgesehene Blockierwirkung muss als kritisch gekennzeichnet werden.");
  }
  const validFrom = isoDate(value.validFrom, "Gültig ab", { required: true });
  const validTo = isoDate(value.validTo, "Gültig bis");
  if (validTo && validTo < validFrom) throw new TypeError("Gültig bis darf nicht vor Gültig ab liegen.");
  const scope = normalizeScope(db, value.scopeType, value.scopeKey, ruleType);
  return {
    title: text(value.title, "Regelbezeichnung", 180, { required: true }),
    description: text(value.description, "Fachliche Beschreibung", 1600, { required: true, minimum: 10 }),
    ruleType,
    topic,
    scope,
    validFrom,
    validTo,
    metric: metric.id,
    operator: metric.operator,
    threshold: threshold.stored,
    unit: metric.unit,
    severity,
    reaction,
    message: text(value.message, "Hinweistext", 1000, { required: true, minimum: 10 }),
    responsibleUnit: text(value.responsibleUnit, "Verantwortliche Stelle", 160, { required: true }),
    source: {
      title: text(value.sourceTitle, "Quellenbezeichnung", 240, { required: true }),
      reference: text(value.sourceReference, "Fundstelle oder Dokumentreferenz", 500, { required: true }),
      url: httpsUrl(value.sourceUrl, "Quellenadresse"),
      note: text(value.sourceNote, "Quellenhinweis", 1200),
    },
    testCases: normalizeTestCases(metric, threshold, value.testCases),
  };
}

function customRuleSnapshot(profileId, code, version, definition, {
  status = "draft",
  assignable = false,
} = {}) {
  const ruleId = `${profileId}:rule`;
  const definitionSource = definition.source || {
    title: definition.sourceTitle,
    reference: definition.sourceReference,
    url: definition.sourceUrl,
    note: definition.sourceNote,
  };
  const definitionScope = definition.scope || {
    type: definition.scopeType,
    key: definition.scopeKey || "",
    label: definition.scopeLabel || "",
  };
  const source = {
    id: `${profileId}:source:${version}`,
    title: definitionSource.title,
    jurisdiction: "AT",
    url: definitionSource.url,
    reference: definitionSource.reference,
    note: definitionSource.note,
  };
  const applicability = {
    jurisdiction: "AT",
    sector: "custom",
    sourceLayer: definition.ruleType,
    scopeType: definitionScope.type,
    scopeKey: definitionScope.key,
    scopeLabel: definitionScope.label,
    confirmationRequired: true,
    note: definition.description,
  };
  const limits = {
    metric: definition.metric,
    operator: definition.operator,
    threshold: definition.threshold,
    unit: definition.unit,
  };
  const rules = [{
    id: ruleId,
    title: definition.title,
    sourceLayer: definition.ruleType,
    topic: definition.topic,
    scope: definitionScope,
    condition: { ...limits },
    severity: definition.severity,
    enforcement: definition.reaction,
    message: definition.message,
    responsibleUnit: definition.responsibleUnit,
    testCases: definition.testCases,
    sourceRefs: [source.id],
  }];
  const sources = [source];
  const snapshot = {
    schemaVersion: 2,
    catalogVersion: CUSTOM_WORK_RULE_CATALOG_VERSION,
    profileId,
    version,
    applicability,
    limits,
    ruleIds: [ruleId],
    rules,
    sources,
    title: definition.title,
    status,
    assignable,
    validFrom: definition.validFrom,
    validTo: definition.validTo,
    defaultEnforcementMode: "monitor",
  };
  return {
    code,
    version,
    layer: "company",
    snapshot,
    storedRules: {
      schemaVersion: snapshot.schemaVersion,
      catalogVersion: snapshot.catalogVersion,
      title: snapshot.title,
      status: snapshot.status,
      assignable: snapshot.assignable,
      validFrom: snapshot.validFrom,
      validTo: snapshot.validTo,
      defaultEnforcementMode: snapshot.defaultEnforcementMode,
      applicability,
      limits,
      ruleIds: snapshot.ruleIds,
      rules,
    },
    sources,
    contentSha256: canonicalSha256(snapshot),
  };
}

function draftSnapshot(profileId, code, revisionNumber, definition) {
  return customRuleSnapshot(profileId, code, `draft-${revisionNumber}`, definition);
}

function withImmediateTransaction(db, callback) {
  if (db.isTransaction === true || db.inTransaction === true) return callback();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function insertDraftVersion(db, profile, revisionNumber, value, actor) {
  const definition = normalizeDefinition(db, value);
  const prepared = draftSnapshot(profile.id, profile.code, revisionNumber, definition);
  const versionId = `${profile.id}@${prepared.version}`;
  db.prepare(`
    INSERT INTO work_rule_profile_versions
      (id, profile_id, version, layer, status, valid_from, valid_to,
       rules_json, sources_json, content_sha256, created_by, published_at)
    VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    versionId,
    profile.id,
    prepared.version,
    prepared.layer,
    definition.validFrom,
    definition.validTo,
    JSON.stringify(prepared.storedRules),
    JSON.stringify(prepared.sources),
    prepared.contentSha256,
    String(actor || ""),
  );
  const profileStatus = db.prepare("SELECT status FROM work_rule_profiles WHERE id = ?")
    .get(profile.id)?.status;
  if (profileStatus === "active") {
    db.prepare(`
      UPDATE work_rule_profiles
      SET updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND builtin = 0
    `).run(String(actor || ""), profile.id);
  } else {
    db.prepare(`
      UPDATE work_rule_profiles
      SET name = ?, description = ?, jurisdiction = 'AT', sector = ?,
          status = 'draft', current_version_id = ?, updated_by = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND builtin = 0
    `).run(
      definition.title,
      definition.description,
      definition.topic,
      versionId,
      String(actor || ""),
      profile.id,
    );
  }
  const verified = getWorkRuleProfileVersion(db, versionId);
  if (!verified || verified.contentSha256 !== prepared.contentSha256) {
    throw new Error("Die neue Entwurfsfassung konnte nach dem Speichern nicht verifiziert werden.");
  }
  return versionId;
}

function createCustomWorkRuleDraft(db, value, actor = "") {
  const code = normalizeCode(value.code);
  const profileId = `custom:${code}`;
  return withImmediateTransaction(db, () => {
    if (db.prepare("SELECT 1 FROM work_rule_profiles WHERE id = ?").get(profileId)) {
      throw new TypeError("Dieses Regelkürzel wird bereits verwendet.");
    }
    db.prepare(`
      INSERT INTO work_rule_profiles
        (id, name, description, jurisdiction, sector, builtin, status,
         current_version_id, created_by, updated_by)
      VALUES (?, ?, ?, 'AT', 'custom', 0, 'draft', NULL, ?, ?)
    `).run(
      profileId,
      text(value.title, "Regelbezeichnung", 180, { required: true }),
      text(value.description, "Fachliche Beschreibung", 1600, { required: true, minimum: 10 }),
      String(actor || ""),
      String(actor || ""),
    );
    insertDraftVersion(db, { id: profileId, code }, 1, value, actor);
    return getCustomWorkRuleDraft(db, profileId);
  });
}

function addCustomWorkRuleDraftRevision(db, profileIdValue, value, actor = "") {
  const profileId = text(profileIdValue, "Regel-ID", 180, { required: true });
  return withImmediateTransaction(db, () => {
    const profile = db.prepare(`
      SELECT id, status, builtin
      FROM work_rule_profiles
      WHERE id = ?
    `).get(profileId);
    if (!profile || profile.builtin || !profile.id.startsWith("custom:")) {
      throw new TypeError("Der eigene Regelentwurf wurde nicht gefunden.");
    }
    if (!["draft", "active"].includes(profile.status)) {
      throw new TypeError("Nur ein eigener Entwurf oder eine aktive eigene Regel kann als neue Entwurfsfassung fortgeschrieben werden.");
    }
    const code = profile.id.slice("custom:".length);
    if (value.code && normalizeCode(value.code) !== code) {
      throw new TypeError("Das Regelkürzel bleibt über alle Entwurfsfassungen unverändert.");
    }
    const revisionNumber = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM work_rule_profile_versions
      WHERE profile_id = ? AND version LIKE 'draft-%'
    `).get(profile.id).count || 0) + 1;
    insertDraftVersion(db, { id: profile.id, code }, revisionNumber, value, actor);
    return getCustomWorkRuleDraft(db, profile.id);
  });
}

function serializeDraftVersion(db, row) {
  const version = getWorkRuleProfileVersion(db, row.id);
  const rule = version.rules[0];
  const source = version.sources[0] || {};
  const testCases = Array.isArray(rule?.testCases) ? rule.testCases : [];
  return {
    id: version.id,
    versionLabel: version.version,
    versionKind: String(version.version).startsWith("release-") ? "release" : "draft",
    revisionNumber: Number(String(version.version).replace(/^(?:draft|release)-/, "")) || 0,
    status: version.status,
    layer: version.layer,
    validFrom: version.validFrom,
    validTo: version.validTo,
    contentSha256: version.contentSha256,
    createdBy: row.created_by,
    createdAt: row.created_at,
    definition: {
      title: version.profile.title,
      description: version.profile.applicability.note || "",
      ruleType: rule.sourceLayer,
      topic: rule.topic,
      scopeType: rule.scope?.type || version.profile.applicability.scopeType,
      scopeKey: rule.scope?.key || version.profile.applicability.scopeKey || "",
      scopeLabel: rule.scope?.label || version.profile.applicability.scopeLabel || "",
      validFrom: version.validFrom,
      validTo: version.validTo,
      metric: rule.condition?.metric,
      operator: rule.condition?.operator,
      threshold: rule.condition?.threshold,
      unit: rule.condition?.unit,
      severity: rule.severity,
      reaction: rule.enforcement,
      message: rule.message,
      responsibleUnit: rule.responsibleUnit,
      sourceTitle: source.title || "",
      sourceReference: source.reference || "",
      sourceUrl: source.url || "",
      sourceNote: source.note || "",
      testCases,
      positiveTestValue: testCases.find((entry) => entry.id === "positive")?.input ?? "",
      negativeTestValue: testCases.find((entry) => entry.id === "negative")?.input ?? "",
    },
  };
}

function tableExists(db, name) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(String(name || "")));
}

function getCustomWorkRuleDraft(db, profileIdValue) {
  const profile = db.prepare(`
    SELECT id, name, description, status, current_version_id,
           created_by, updated_by, created_at, updated_at
    FROM work_rule_profiles
    WHERE id = ? AND builtin = 0 AND id LIKE 'custom:%'
  `).get(String(profileIdValue || ""));
  if (!profile) return null;
  const versions = db.prepare(`
    SELECT id, created_by, created_at
    FROM work_rule_profile_versions
    WHERE profile_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(profile.id).map((row) => serializeDraftVersion(db, row))
    .sort((left, right) => (
      String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
      || right.revisionNumber - left.revisionNumber
      || right.id.localeCompare(left.id)
    ));
  const publicationByDraftVersionId = tableExists(db, "work_rule_publications")
    ? new Map(db.prepare(`
      SELECT source_profile_version_id, released_profile_version_id, id, published_at
      FROM work_rule_publications
      WHERE profile_id = ?
    `).all(profile.id).map((publication) => [publication.source_profile_version_id, publication]))
    : new Map();
  for (const version of versions) {
    const publication = publicationByDraftVersionId.get(version.id);
    version.releasedAsVersionId = publication?.released_profile_version_id || null;
    version.publicationId = publication?.id || null;
    version.publishedAt = publication?.published_at || null;
  }
  const latestUnreleasedDraft = versions.find((version) => (
    version.versionKind === "draft" && !version.releasedAsVersionId
  )) || null;
  const publishedVersion = versions.find((version) => (
    version.id === profile.current_version_id && version.status === "published"
  )) || versions.find((version) => version.status === "published") || null;
  const workingVersion = latestUnreleasedDraft || publishedVersion || versions[0] || null;
  return {
    id: profile.id,
    code: profile.id.slice("custom:".length),
    title: profile.name,
    description: profile.description,
    status: profile.status,
    currentVersionId: workingVersion?.id || null,
    currentVersion: workingVersion,
    effectiveVersionId: profile.current_version_id,
    publishedVersion,
    hasUnreleasedDraft: Boolean(latestUnreleasedDraft),
    lifecycleStatus: latestUnreleasedDraft
      ? "draft"
      : (publishedVersion ? "published" : profile.status),
    createdBy: profile.created_by,
    updatedBy: profile.updated_by,
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
    versions,
  };
}

function customWorkRuleDefinitionFromVersion(db, versionIdValue) {
  const row = db.prepare(`
    SELECT id, created_by, created_at
    FROM work_rule_profile_versions
    WHERE id = ?
  `).get(String(versionIdValue || ""));
  if (!row) throw new TypeError("Die ausgewählte eigene Regelfassung wurde nicht gefunden.");
  const version = serializeDraftVersion(db, row);
  if (!version.id.startsWith("custom:")) {
    throw new TypeError("Die ausgewählte Fassung ist keine eigene Regel.");
  }
  return version;
}

function customWorkRuleSemanticSha256(profileId, definition) {
  return canonicalSha256({
    schemaVersion: 1,
    profileId: String(profileId || ""),
    definition,
  });
}

function publishCustomWorkRuleDraft(db, versionIdValue, actor = "") {
  const source = customWorkRuleDefinitionFromVersion(db, versionIdValue);
  if (source.status !== "draft" || source.versionKind !== "draft") {
    throw new TypeError("Nur eine unveröffentlichte Entwurfsfassung kann veröffentlicht werden.");
  }
  const profileId = source.id.split("@")[0];
  const releaseNumber = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM work_rule_profile_versions
    WHERE profile_id = ? AND version LIKE 'release-%'
  `).get(profileId).count || 0) + 1;
  const releaseVersion = `release-${releaseNumber}`;
  const prepared = customRuleSnapshot(
    profileId,
    profileId.slice("custom:".length),
    releaseVersion,
    source.definition,
    { status: "active", assignable: true },
  );
  const releaseVersionId = `${profileId}@${releaseVersion}`;
  const publishedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO work_rule_profile_versions
      (id, profile_id, version, layer, status, valid_from, valid_to,
       rules_json, sources_json, content_sha256, created_by, published_at)
    VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    releaseVersionId,
    profileId,
    releaseVersion,
    prepared.layer,
    source.definition.validFrom,
    source.definition.validTo,
    JSON.stringify(prepared.storedRules),
    JSON.stringify(prepared.sources),
    prepared.contentSha256,
    String(actor || ""),
    publishedAt,
  );
  db.prepare(`
    UPDATE work_rule_profiles
    SET name = ?, description = ?, jurisdiction = 'AT', sector = ?,
        status = 'active', current_version_id = ?, updated_by = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND builtin = 0
  `).run(
    source.definition.title,
    source.definition.description,
    source.definition.topic,
    releaseVersionId,
    String(actor || ""),
    profileId,
  );
  const verified = getWorkRuleProfileVersion(db, releaseVersionId);
  if (!verified || verified.contentSha256 !== prepared.contentSha256) {
    throw new Error("Die veröffentlichte Regelfassung konnte nach dem Speichern nicht verifiziert werden.");
  }
  return {
    profileId,
    sourceDraftVersionId: source.id,
    releasedVersionId: releaseVersionId,
    releaseVersion,
    contentSha256: prepared.contentSha256,
    semanticSha256: customWorkRuleSemanticSha256(profileId, source.definition),
    publishedAt,
    definition: source.definition,
  };
}

function restoreCustomWorkRuleVersionAsDraft(db, versionIdValue, actor = "") {
  const source = customWorkRuleDefinitionFromVersion(db, versionIdValue);
  if (source.status !== "published" || source.versionKind !== "release") {
    throw new TypeError("Nur eine veröffentlichte eigene Regelfassung kann als Nachfolgeentwurf übernommen werden.");
  }
  const profileId = source.id.split("@")[0];
  return withImmediateTransaction(db, () => {
    const revisionNumber = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM work_rule_profile_versions
      WHERE profile_id = ? AND version LIKE 'draft-%'
    `).get(profileId).count || 0) + 1;
    insertDraftVersion(db, {
      id: profileId,
      code: profileId.slice("custom:".length),
    }, revisionNumber, {
      code: profileId.slice("custom:".length),
      ...source.definition,
      testCases: {
        positiveValue: source.definition.positiveTestValue,
        negativeValue: source.definition.negativeTestValue,
      },
      status: "draft",
      enforcementMode: "monitor",
    }, actor);
    return getCustomWorkRuleDraft(db, profileId);
  });
}

function listCustomWorkRuleDrafts(db) {
  return db.prepare(`
    SELECT id
    FROM work_rule_profiles
    WHERE builtin = 0 AND id LIKE 'custom:%'
    ORDER BY name COLLATE NOCASE, id
  `).all().map((row) => getCustomWorkRuleDraft(db, row.id));
}

function simulateCustomWorkRuleDraft(db, value) {
  const definition = normalizeDefinition(db, value);
  return {
    metric: definition.metric,
    operator: definition.operator,
    threshold: definition.threshold,
    unit: definition.unit,
    testCases: definition.testCases,
    valid: definition.testCases.every((entry) => entry.expected === entry.actual),
  };
}

module.exports = {
  CUSTOM_WORK_RULE_CATALOG_VERSION,
  CUSTOM_WORK_RULE_METRICS,
  CUSTOM_WORK_RULE_NOTICE,
  CUSTOM_WORK_RULE_REACTIONS,
  CUSTOM_WORK_RULE_SCOPES,
  CUSTOM_WORK_RULE_SEVERITIES,
  CUSTOM_WORK_RULE_TOPICS,
  CUSTOM_WORK_RULE_TYPES,
  addCustomWorkRuleDraftRevision,
  createCustomWorkRuleDraft,
  customWorkRuleDefinitionFromVersion,
  customWorkRuleSemanticSha256,
  getCustomWorkRuleDraft,
  listCustomWorkRuleDrafts,
  publishCustomWorkRuleDraft,
  restoreCustomWorkRuleVersionAsDraft,
  simulateCustomWorkRuleDraft,
};

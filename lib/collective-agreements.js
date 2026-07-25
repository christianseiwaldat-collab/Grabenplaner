"use strict";

const { randomUUID } = require("node:crypto");
const { canonicalSha256 } = require("./work-rules/receipt");

const COLLECTIVE_AGREEMENT_NOTICE = [
  "Das Register dokumentiert externe Kollektivverträge, deren Quellenstände und interne Zuordnungsvorschläge.",
  "Es erzeugt keinen Kollektivvertrag und bestätigt keine rechtliche Anwendbarkeit.",
  "Zuordnungen aus Block 4 bleiben bis zur gesonderten Freigabe in Block 6 im Status „Prüfung offen“.",
].join(" ");

const BUSINESS_UNIT_SCOPE_TYPES = Object.freeze(["cost_center", "location", "department"]);

function text(value, label, maximum, { required = false } = {}) {
  const normalized = String(value || "").trim();
  if (required && !normalized) throw new TypeError(`${label} fehlt.`);
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

function httpsUrl(value, label, { required = false } = {}) {
  const normalized = text(value, label, 1200, { required });
  if (!normalized) return "";
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError(`${label} ist keine gültige Internetadresse.`);
  }
  if (parsed.protocol !== "https:") {
    throw new TypeError(`${label} muss eine HTTPS-Adresse sein.`);
  }
  return parsed.toString();
}

function sha256(value, label) {
  const normalized = text(value, label, 64).toLowerCase();
  if (normalized && !/^[a-f0-9]{64}$/.test(normalized)) {
    throw new TypeError(`${label} muss eine SHA-256-Prüfsumme sein.`);
  }
  return normalized;
}

function stringList(value, label, { maximumItems = 30, maximumItemLength = 240 } = {}) {
  const submitted = Array.isArray(value)
    ? value
    : String(value || "").split(/\r?\n|;/);
  const normalized = [...new Set(submitted
    .map((entry) => String(entry || "").trim())
    .filter(Boolean))];
  if (normalized.length > maximumItems) throw new TypeError(`${label} enthält zu viele Einträge.`);
  if (normalized.some((entry) => entry.length > maximumItemLength)) {
    throw new TypeError(`Ein Eintrag in ${label} ist zu lang.`);
  }
  return normalized;
}

function normalizeAgreement(value = {}) {
  const code = text(value.code, "Registerkürzel", 40, { required: true }).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(code)) {
    throw new TypeError("Das Registerkürzel darf nur Buchstaben, Zahlen, Punkt, Unterstrich, Schrägstrich und Bindestrich enthalten.");
  }
  const jurisdiction = text(value.jurisdiction || "AT", "Rechtsraum", 2, { required: true }).toUpperCase();
  if (!/^[A-Z]{2}$/.test(jurisdiction)) throw new TypeError("Der Rechtsraum muss als zweistelliger Ländercode angegeben werden.");
  return {
    code,
    title: text(value.title, "Bezeichnung", 180, { required: true }),
    shortTitle: text(value.shortTitle, "Kurzbezeichnung", 80),
    jurisdiction,
    note: text(value.note, "Interner Registerhinweis", 1200),
  };
}

function normalizeVersion(value = {}) {
  const validFrom = isoDate(value.validFrom, "Gültig ab", { required: true });
  const validTo = isoDate(value.validTo, "Gültig bis");
  if (validTo && validTo < validFrom) throw new TypeError("Gültig bis darf nicht vor Gültig ab liegen.");
  const externalPublishedOn = isoDate(value.externalPublishedOn, "Extern veröffentlicht am");
  const sourceRetrievedOn = isoDate(value.sourceRetrievedOn, "Quelle abgerufen am", { required: true });
  const apprenticeRelevance = String(value.apprenticeRelevance || "unknown");
  if (!["yes", "no", "unknown"].includes(apprenticeRelevance)) {
    throw new TypeError("Die Lehrlingsrelevanz ist ungültig.");
  }
  return {
    versionLabel: text(value.versionLabel, "Fassungsbezeichnung", 80, { required: true }),
    validFrom,
    validTo,
    externalPublishedOn,
    sourceTitle: text(value.sourceTitle, "Quellenbezeichnung", 240, { required: true }),
    sourceUrl: httpsUrl(value.sourceUrl, "Quellenadresse", { required: true }),
    sourceRetrievedOn,
    sourceSha256: sha256(value.sourceSha256, "Quellen-SHA-256"),
    sourceNote: text(value.sourceNote, "Quellenhinweis", 1600),
    contractingParties: stringList(value.contractingParties, "Vertragsparteien"),
    territorialScope: text(value.territorialScope, "Räumlicher Geltungsbereich", 600),
    functionalScope: text(value.functionalScope, "Fachlicher Geltungsbereich", 1200),
    personalScope: text(value.personalScope, "Persönlicher Geltungsbereich", 1200),
    employeeGroups: stringList(value.employeeGroups, "Beschäftigtengruppen"),
    workTimeParametersNote: text(value.workTimeParametersNote, "Arbeitszeitparameter", 2000),
    classificationNote: text(value.classificationNote, "Einstufungshinweis", 1600),
    apprenticeRelevance,
    apprenticeNote: text(value.apprenticeNote, "Lehrlingshinweis", 1600),
    successorNote: text(value.successorNote, "Nachfolgehinweis", 1000),
    linkedProfileVersionId: text(value.linkedProfileVersionId, "Verknüpfte Regelprofil-Version", 160),
  };
}

function versionSnapshot(agreementId, version) {
  return {
    schemaVersion: 1,
    agreementId,
    versionLabel: version.versionLabel,
    validFrom: version.validFrom,
    validTo: version.validTo,
    externalPublishedOn: version.externalPublishedOn,
    source: {
      title: version.sourceTitle,
      url: version.sourceUrl,
      retrievedOn: version.sourceRetrievedOn,
      sha256: version.sourceSha256,
      note: version.sourceNote,
    },
    applicability: {
      contractingParties: version.contractingParties,
      territorialScope: version.territorialScope,
      functionalScope: version.functionalScope,
      personalScope: version.personalScope,
      employeeGroups: version.employeeGroups,
      apprenticeRelevance: version.apprenticeRelevance,
      apprenticeNote: version.apprenticeNote,
    },
    derivedParameters: {
      workTimeNote: version.workTimeParametersNote,
      classificationNote: version.classificationNote,
    },
    successorNote: version.successorNote,
    linkedProfileVersionId: version.linkedProfileVersionId || null,
  };
}

function assertLinkedProfileVersion(db, linkedProfileVersionId) {
  if (!linkedProfileVersionId) return;
  const profile = db.prepare(`
    SELECT id, layer
    FROM work_rule_profile_versions
    WHERE id = ?
  `).get(linkedProfileVersionId);
  if (!profile) throw new TypeError("Die verknüpfte Regelprofil-Version wurde nicht gefunden.");
  if (profile.layer !== "collective_agreement") {
    throw new TypeError("Nur eine Regelprofil-Version der Ebene Kollektivvertrag darf verknüpft werden.");
  }
}

function insertVersion(db, agreementId, submitted, actor) {
  const agreement = db.prepare("SELECT id FROM collective_agreements WHERE id = ?").get(agreementId);
  if (!agreement) throw new TypeError("Der Registereintrag wurde nicht gefunden.");
  const version = normalizeVersion(submitted);
  assertLinkedProfileVersion(db, version.linkedProfileVersionId);
  const duplicate = db.prepare(`
    SELECT 1 FROM collective_agreement_versions
    WHERE agreement_id = ? AND version_label = ?
  `).get(agreementId, version.versionLabel);
  if (duplicate) throw new TypeError("Diese Fassungsbezeichnung ist für den Registereintrag bereits vorhanden.");

  const id = randomUUID();
  const snapshot = versionSnapshot(agreementId, version);
  const contentSha256 = canonicalSha256(snapshot);
  db.prepare(`
    INSERT INTO collective_agreement_versions
      (id, agreement_id, version_label, source_state, valid_from, valid_to,
       external_published_on, source_title, source_url, source_retrieved_on,
       source_sha256, source_note, contracting_parties_json, territorial_scope,
       functional_scope, personal_scope, employee_groups_json,
       work_time_parameters_note, classification_note, apprentice_relevance,
       apprentice_note, successor_note, linked_profile_version_id,
       snapshot_json, content_sha256, created_by)
    VALUES (?, ?, ?, 'documented', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    agreementId,
    version.versionLabel,
    version.validFrom,
    version.validTo,
    version.externalPublishedOn,
    version.sourceTitle,
    version.sourceUrl,
    version.sourceRetrievedOn,
    version.sourceSha256,
    version.sourceNote,
    JSON.stringify(version.contractingParties),
    version.territorialScope,
    version.functionalScope,
    version.personalScope,
    JSON.stringify(version.employeeGroups),
    version.workTimeParametersNote,
    version.classificationNote,
    version.apprenticeRelevance,
    version.apprenticeNote,
    version.successorNote,
    version.linkedProfileVersionId || null,
    JSON.stringify(snapshot),
    contentSha256,
    String(actor || ""),
  );
  db.prepare(`
    UPDATE collective_agreements
    SET current_version_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id, String(actor || ""), agreementId);
  return id;
}

function withImmediateTransaction(db, callback) {
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

function createCollectiveAgreement(db, value, actor = "") {
  const agreement = normalizeAgreement(value);
  const duplicate = db.prepare("SELECT 1 FROM collective_agreements WHERE code = ?").get(agreement.code);
  if (duplicate) throw new TypeError("Dieses Registerkürzel wird bereits verwendet.");
  const id = randomUUID();
  return withImmediateTransaction(db, () => {
    db.prepare(`
      INSERT INTO collective_agreements
        (id, code, title, short_title, jurisdiction, review_state, note, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, 'review_pending', ?, ?, ?)
    `).run(
      id,
      agreement.code,
      agreement.title,
      agreement.shortTitle,
      agreement.jurisdiction,
      agreement.note,
      String(actor || ""),
      String(actor || ""),
    );
    const versionId = insertVersion(db, id, value.version || value, actor);
    return getCollectiveAgreement(db, id, { expectedVersionId: versionId });
  });
}

function addCollectiveAgreementVersion(db, agreementId, value, actor = "") {
  return withImmediateTransaction(db, () => {
    const versionId = insertVersion(db, String(agreementId || ""), value, actor);
    return getCollectiveAgreement(db, agreementId, { expectedVersionId: versionId });
  });
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function serializeVersion(row) {
  const snapshot = parseJson(row.snapshot_json, null);
  if (!snapshot || canonicalSha256(snapshot) !== row.content_sha256) {
    throw new Error(`Die Prüfsumme der KV-Fassung ${row.id} stimmt nicht.`);
  }
  return {
    id: row.id,
    agreementId: row.agreement_id,
    versionLabel: row.version_label,
    sourceState: row.source_state,
    validFrom: row.valid_from,
    validTo: row.valid_to || null,
    externalPublishedOn: row.external_published_on || null,
    source: {
      title: row.source_title,
      url: row.source_url,
      retrievedOn: row.source_retrieved_on,
      sha256: row.source_sha256 || "",
      note: row.source_note || "",
    },
    contractingParties: parseJson(row.contracting_parties_json, []),
    territorialScope: row.territorial_scope || "",
    functionalScope: row.functional_scope || "",
    personalScope: row.personal_scope || "",
    employeeGroups: parseJson(row.employee_groups_json, []),
    workTimeParametersNote: row.work_time_parameters_note || "",
    classificationNote: row.classification_note || "",
    apprenticeRelevance: row.apprentice_relevance,
    apprenticeNote: row.apprentice_note || "",
    successorNote: row.successor_note || "",
    linkedProfileVersionId: row.linked_profile_version_id || null,
    contentSha256: row.content_sha256,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function listCollectiveAgreementVersions(db, agreementId = "") {
  const rows = db.prepare(`
    SELECT *
    FROM collective_agreement_versions
    ${agreementId ? "WHERE agreement_id = ?" : ""}
    ORDER BY valid_from DESC, created_at DESC, id DESC
  `).all(...(agreementId ? [String(agreementId)] : []));
  return rows.map(serializeVersion);
}

function getCollectiveAgreement(db, id, { expectedVersionId = "" } = {}) {
  const row = db.prepare(`
    SELECT id, code, title, short_title, jurisdiction, review_state, current_version_id,
           note, created_by, updated_by, created_at, updated_at
    FROM collective_agreements
    WHERE id = ?
  `).get(String(id || ""));
  if (!row) return null;
  const versions = listCollectiveAgreementVersions(db, row.id);
  if (expectedVersionId && !versions.some((version) => version.id === expectedVersionId)) {
    throw new Error("Die neue KV-Fassung konnte nach dem Speichern nicht verifiziert werden.");
  }
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    shortTitle: row.short_title || "",
    jurisdiction: row.jurisdiction,
    reviewState: row.review_state,
    currentVersionId: row.current_version_id || null,
    note: row.note || "",
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    versions,
  };
}

function listCollectiveAgreements(db) {
  return db.prepare(`
    SELECT id
    FROM collective_agreements
    ORDER BY title COLLATE NOCASE, code
  `).all().map((row) => getCollectiveAgreement(db, row.id));
}

function normalizeBusinessUnitScope(scope = {}) {
  const scopeType = text(scope.scopeType, "Bereichsart", 30, { required: true });
  if (!BUSINESS_UNIT_SCOPE_TYPES.includes(scopeType)) throw new TypeError("Die Bereichsart des Betriebsteils ist ungültig.");
  return {
    scopeType,
    scopeKey: text(scope.scopeKey, "Bereich", 80, { required: true }),
  };
}

function assertBusinessUnitScopeExists(db, scope) {
  const queries = {
    cost_center: "SELECT id FROM cost_centers WHERE CAST(id AS TEXT) = ?",
    location: "SELECT id FROM locations WHERE CAST(id AS TEXT) = ?",
    department: "SELECT id FROM departments WHERE CAST(id AS TEXT) = ?",
  };
  if (!db.prepare(queries[scope.scopeType]).get(scope.scopeKey)) {
    throw new TypeError("Der ausgewählte organisatorische Bereich wurde nicht gefunden.");
  }
  const occupied = db.prepare(`
    SELECT u.name
    FROM collective_agreement_business_unit_scopes s
    JOIN collective_agreement_business_units u ON u.id = s.business_unit_id
    WHERE s.scope_type = ? AND s.scope_key = ? AND u.active = 1
  `).get(scope.scopeType, scope.scopeKey);
  if (occupied) throw new TypeError(`Der organisatorische Bereich ist bereits dem Betriebsteil „${occupied.name}“ zugeordnet.`);
}

function insertBusinessUnitScopes(db, businessUnitId, scopes, actor) {
  const normalized = [...new Map((Array.isArray(scopes) ? scopes : [])
    .map(normalizeBusinessUnitScope)
    .map((scope) => [`${scope.scopeType}:${scope.scopeKey}`, scope])).values()];
  const insert = db.prepare(`
    INSERT INTO collective_agreement_business_unit_scopes
      (id, business_unit_id, scope_type, scope_key, created_by)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const scope of normalized) {
    assertBusinessUnitScopeExists(db, scope);
    insert.run(randomUUID(), businessUnitId, scope.scopeType, scope.scopeKey, String(actor || ""));
  }
}

function createBusinessUnit(db, value, actor = "") {
  const code = text(value.code, "Betriebsteil-Kürzel", 40, { required: true }).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(code)) throw new TypeError("Das Betriebsteil-Kürzel enthält ungültige Zeichen.");
  const name = text(value.name, "Betriebsteil", 160, { required: true });
  const legalEntityName = text(value.legalEntityName, "Rechtsträger", 200, { required: true });
  const description = text(value.description, "Beschreibung", 1200);
  if (db.prepare("SELECT 1 FROM collective_agreement_business_units WHERE code = ?").get(code)) {
    throw new TypeError("Dieses Betriebsteil-Kürzel wird bereits verwendet.");
  }
  const id = randomUUID();
  return withImmediateTransaction(db, () => {
    db.prepare(`
      INSERT INTO collective_agreement_business_units
        (id, code, name, legal_entity_name, description, active, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, code, name, legalEntityName, description, String(actor || ""), String(actor || ""));
    insertBusinessUnitScopes(db, id, value.scopes, actor);
    return getBusinessUnit(db, id);
  });
}

function addBusinessUnitScopes(db, businessUnitId, scopes, actor = "") {
  const id = String(businessUnitId || "");
  const unit = db.prepare(`
    SELECT id FROM collective_agreement_business_units WHERE id = ? AND active = 1
  `).get(id);
  if (!unit) throw new TypeError("Der aktive Betriebsteil wurde nicht gefunden.");
  return withImmediateTransaction(db, () => {
    insertBusinessUnitScopes(db, id, scopes, actor);
    db.prepare(`
      UPDATE collective_agreement_business_units
      SET updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(String(actor || ""), id);
    return getBusinessUnit(db, id);
  });
}

function scopeLabel(db, scopeType, scopeKey) {
  if (scopeType === "cost_center") {
    const row = db.prepare("SELECT code, name FROM cost_centers WHERE CAST(id AS TEXT) = ?").get(scopeKey);
    return row ? `Kostenstelle ${row.code} · ${row.name}` : "Unbekannte Kostenstelle";
  }
  if (scopeType === "location") {
    const row = db.prepare("SELECT id, name FROM locations WHERE CAST(id AS TEXT) = ?").get(scopeKey);
    return row ? `Filiale ${row.id} · ${row.name}` : "Unbekannte Filiale";
  }
  const row = db.prepare(`
    SELECT d.id, d.name, l.id AS location_id, l.name AS location_name
    FROM departments d
    JOIN locations l ON l.id = d.location_id
    WHERE CAST(d.id AS TEXT) = ?
  `).get(scopeKey);
  return row
    ? `Abteilung ${row.location_id} · ${row.location_name} · ${row.name}`
    : "Unbekannte Abteilung";
}

function getBusinessUnit(db, id) {
  const row = db.prepare(`
    SELECT id, code, name, legal_entity_name, description, active,
           created_by, updated_by, created_at, updated_at
    FROM collective_agreement_business_units
    WHERE id = ?
  `).get(String(id || ""));
  if (!row) return null;
  const scopes = db.prepare(`
    SELECT id, scope_type, scope_key, created_by, created_at
    FROM collective_agreement_business_unit_scopes
    WHERE business_unit_id = ?
    ORDER BY scope_type, scope_key
  `).all(row.id).map((scope) => ({
    id: scope.id,
    scopeType: scope.scope_type,
    scopeKey: scope.scope_key,
    label: scopeLabel(db, scope.scope_type, scope.scope_key),
    createdBy: scope.created_by,
    createdAt: scope.created_at,
  }));
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    legalEntityName: row.legal_entity_name,
    description: row.description || "",
    active: Boolean(row.active),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scopes,
  };
}

function listBusinessUnits(db, { includeInactive = false } = {}) {
  return db.prepare(`
    SELECT id
    FROM collective_agreement_business_units
    ${includeInactive ? "" : "WHERE active = 1"}
    ORDER BY name COLLATE NOCASE, code
  `).all().map((row) => getBusinessUnit(db, row.id));
}

function prepareCollectiveAgreementAssignment(db, value, actor = "") {
  if (value.reviewState && value.reviewState !== "review_pending") {
    throw new TypeError("Eine KV-Zuordnung kann erst im Freigabeblock bestätigt oder aktiviert werden.");
  }
  const versionId = text(value.agreementVersionId, "KV-Fassung", 80, { required: true });
  const businessUnitId = text(value.businessUnitId, "Betriebsteil", 80, { required: true });
  const version = db.prepare(`
    SELECT id, valid_from, valid_to
    FROM collective_agreement_versions
    WHERE id = ?
  `).get(versionId);
  if (!version) throw new TypeError("Die ausgewählte KV-Fassung wurde nicht gefunden.");
  const unit = db.prepare(`
    SELECT id FROM collective_agreement_business_units WHERE id = ? AND active = 1
  `).get(businessUnitId);
  if (!unit) throw new TypeError("Der ausgewählte aktive Betriebsteil wurde nicht gefunden.");
  const validFrom = isoDate(value.validFrom, "Vorgeschlagen gültig ab", { required: true });
  const validTo = isoDate(value.validTo, "Vorgeschlagen gültig bis");
  if (validTo && validTo < validFrom) throw new TypeError("Vorgeschlagen gültig bis darf nicht vor gültig ab liegen.");
  if (validFrom < version.valid_from || (version.valid_to && (!validTo || validTo > version.valid_to))) {
    throw new TypeError("Der Zuordnungsvorschlag liegt außerhalb der dokumentierten KV-Fassung.");
  }
  const rationale = text(value.rationale, "Prüfbegründung", 2000, { required: true });
  if (rationale.length < 10) throw new TypeError("Bitte den Zuordnungsvorschlag nachvollziehbar begründen.");
  const referenceNote = text(value.referenceNote, "Prüfnachweis", 1600);
  const duplicate = db.prepare(`
    SELECT 1
    FROM collective_agreement_assignments
    WHERE agreement_version_id = ? AND business_unit_id = ?
      AND valid_from = ? AND COALESCE(valid_to, '') = COALESCE(?, '')
      AND review_state = 'review_pending'
  `).get(versionId, businessUnitId, validFrom, validTo);
  if (duplicate) throw new TypeError("Dieser offene Zuordnungsvorschlag ist bereits vorhanden.");
  const id = randomUUID();
  db.prepare(`
    INSERT INTO collective_agreement_assignments
      (id, agreement_version_id, business_unit_id, valid_from, valid_to,
       review_state, rationale, reference_note, created_by)
    VALUES (?, ?, ?, ?, ?, 'review_pending', ?, ?, ?)
  `).run(
    id,
    versionId,
    businessUnitId,
    validFrom,
    validTo,
    rationale,
    referenceNote,
    String(actor || ""),
  );
  return getCollectiveAgreementAssignment(db, id);
}

function getCollectiveAgreementAssignment(db, id) {
  const row = db.prepare(`
    SELECT a.id, a.agreement_version_id, a.business_unit_id, a.valid_from, a.valid_to,
           a.review_state, a.rationale, a.reference_note, a.created_by, a.created_at,
           v.version_label, v.agreement_id, c.code AS agreement_code, c.title AS agreement_title,
           u.code AS business_unit_code, u.name AS business_unit_name
    FROM collective_agreement_assignments a
    JOIN collective_agreement_versions v ON v.id = a.agreement_version_id
    JOIN collective_agreements c ON c.id = v.agreement_id
    JOIN collective_agreement_business_units u ON u.id = a.business_unit_id
    WHERE a.id = ?
  `).get(String(id || ""));
  if (!row) return null;
  return {
    id: row.id,
    agreementId: row.agreement_id,
    agreementCode: row.agreement_code,
    agreementTitle: row.agreement_title,
    agreementVersionId: row.agreement_version_id,
    versionLabel: row.version_label,
    businessUnitId: row.business_unit_id,
    businessUnitCode: row.business_unit_code,
    businessUnitName: row.business_unit_name,
    validFrom: row.valid_from,
    validTo: row.valid_to || null,
    reviewState: row.review_state,
    rationale: row.rationale,
    referenceNote: row.reference_note || "",
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function listCollectiveAgreementAssignments(db) {
  return db.prepare(`
    SELECT id
    FROM collective_agreement_assignments
    ORDER BY created_at DESC, id DESC
  `).all().map((row) => getCollectiveAgreementAssignment(db, row.id));
}

module.exports = {
  BUSINESS_UNIT_SCOPE_TYPES,
  COLLECTIVE_AGREEMENT_NOTICE,
  addBusinessUnitScopes,
  addCollectiveAgreementVersion,
  createBusinessUnit,
  createCollectiveAgreement,
  getBusinessUnit,
  getCollectiveAgreement,
  getCollectiveAgreementAssignment,
  listBusinessUnits,
  listCollectiveAgreementAssignments,
  listCollectiveAgreements,
  listCollectiveAgreementVersions,
  prepareCollectiveAgreementAssignment,
};

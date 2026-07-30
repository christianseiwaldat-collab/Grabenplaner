"use strict";

const { randomUUID } = require("node:crypto");
const { canonicalSha256 } = require("./work-rules/receipt");
const {
  assertCollectiveAgreementsRepository,
} = require("./persistence/repositories/collective-agreements");

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

async function assertLinkedProfileVersion(repository, linkedProfileVersionId) {
  if (!linkedProfileVersionId) return;
  const profile = await repository.getLinkedProfileVersion(linkedProfileVersionId);
  if (!profile) throw new TypeError("Die verknüpfte Regelprofil-Version wurde nicht gefunden.");
  if (profile.layer !== "collective_agreement") {
    throw new TypeError("Nur eine Regelprofil-Version der Ebene Kollektivvertrag darf verknüpft werden.");
  }
}

async function insertVersion(repository, agreementId, submitted, actor) {
  const agreement = await repository.getAgreement(agreementId);
  if (!agreement) throw new TypeError("Der Registereintrag wurde nicht gefunden.");
  const version = normalizeVersion(submitted);
  await assertLinkedProfileVersion(repository, version.linkedProfileVersionId);
  const duplicate = await repository.findVersionByLabel(agreementId, version.versionLabel);
  if (duplicate) throw new TypeError("Diese Fassungsbezeichnung ist für den Registereintrag bereits vorhanden.");

  const id = randomUUID();
  const snapshot = versionSnapshot(agreementId, version);
  const contentSha256 = canonicalSha256(snapshot);
  await repository.insertVersion({
    id,
    agreementId,
    versionLabel: version.versionLabel,
    validFrom: version.validFrom,
    validTo: version.validTo,
    externalPublishedOn: version.externalPublishedOn,
    sourceTitle: version.sourceTitle,
    sourceUrl: version.sourceUrl,
    sourceRetrievedOn: version.sourceRetrievedOn,
    sourceSha256: version.sourceSha256,
    sourceNote: version.sourceNote,
    contractingParties: version.contractingParties,
    territorialScope: version.territorialScope,
    functionalScope: version.functionalScope,
    personalScope: version.personalScope,
    employeeGroups: version.employeeGroups,
    workTimeParametersNote: version.workTimeParametersNote,
    classificationNote: version.classificationNote,
    apprenticeRelevance: version.apprenticeRelevance,
    apprenticeNote: version.apprenticeNote,
    successorNote: version.successorNote,
    linkedProfileVersionId: version.linkedProfileVersionId || null,
    snapshot,
    contentSha256,
    actor: String(actor || ""),
  });
  await repository.setCurrentVersion(agreementId, id, String(actor || ""));
  return id;
}

async function createCollectiveAgreement(repository, value, actor = "") {
  assertCollectiveAgreementsRepository(repository);
  const agreement = normalizeAgreement(value);
  const id = randomUUID();
  return repository.transaction(async (transactionRepository) => {
    const duplicate = await transactionRepository.findAgreementByCode(agreement.code);
    if (duplicate) throw new TypeError("Dieses Registerkürzel wird bereits verwendet.");
    await transactionRepository.insertAgreement({
      id,
      code: agreement.code,
      title: agreement.title,
      shortTitle: agreement.shortTitle,
      jurisdiction: agreement.jurisdiction,
      note: agreement.note,
      actor: String(actor || ""),
    });
    const versionId = await insertVersion(
      transactionRepository,
      id,
      value.version || value,
      actor,
    );
    return getCollectiveAgreement(
      transactionRepository,
      id,
      { expectedVersionId: versionId },
    );
  });
}

async function addCollectiveAgreementVersion(repository, agreementId, value, actor = "") {
  assertCollectiveAgreementsRepository(repository);
  return repository.transaction(async (transactionRepository) => {
    const normalizedAgreementId = String(agreementId || "");
    const versionId = await insertVersion(
      transactionRepository,
      normalizedAgreementId,
      value,
      actor,
    );
    return getCollectiveAgreement(
      transactionRepository,
      normalizedAgreementId,
      { expectedVersionId: versionId },
    );
  });
}

function serializeVersion(row) {
  if (!row.snapshot || canonicalSha256(row.snapshot) !== row.contentSha256) {
    throw new Error(`Die Prüfsumme der KV-Fassung ${row.id} stimmt nicht.`);
  }
  return {
    id: row.id,
    agreementId: row.agreementId,
    versionLabel: row.versionLabel,
    sourceState: row.sourceState,
    validFrom: row.validFrom,
    validTo: row.validTo || null,
    externalPublishedOn: row.externalPublishedOn || null,
    source: {
      title: row.sourceTitle,
      url: row.sourceUrl,
      retrievedOn: row.sourceRetrievedOn,
      sha256: row.sourceSha256 || "",
      note: row.sourceNote || "",
    },
    contractingParties: row.contractingParties,
    territorialScope: row.territorialScope || "",
    functionalScope: row.functionalScope || "",
    personalScope: row.personalScope || "",
    employeeGroups: row.employeeGroups,
    workTimeParametersNote: row.workTimeParametersNote || "",
    classificationNote: row.classificationNote || "",
    apprenticeRelevance: row.apprenticeRelevance,
    apprenticeNote: row.apprenticeNote || "",
    successorNote: row.successorNote || "",
    linkedProfileVersionId: row.linkedProfileVersionId || null,
    contentSha256: row.contentSha256,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

async function listCollectiveAgreementVersions(repository, agreementId = "") {
  assertCollectiveAgreementsRepository(repository);
  const rows = await repository.listVersions(agreementId ? String(agreementId) : "");
  return rows.map(serializeVersion);
}

function serializeAgreement(row, versions, { expectedVersionId = "" } = {}) {
  if (expectedVersionId && !versions.some((version) => version.id === expectedVersionId)) {
    throw new Error("Die neue KV-Fassung konnte nach dem Speichern nicht verifiziert werden.");
  }
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    shortTitle: row.shortTitle || "",
    jurisdiction: row.jurisdiction,
    reviewState: row.reviewState,
    currentVersionId: row.currentVersionId || null,
    note: row.note || "",
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    versions,
  };
}

async function getCollectiveAgreement(repository, id, { expectedVersionId = "" } = {}) {
  assertCollectiveAgreementsRepository(repository);
  const row = await repository.getAgreement(String(id || ""));
  if (!row) return null;
  const versions = await listCollectiveAgreementVersions(repository, row.id);
  return serializeAgreement(row, versions, { expectedVersionId });
}

async function listCollectiveAgreements(repository) {
  assertCollectiveAgreementsRepository(repository);
  const [agreements, versionRows] = await Promise.all([
    repository.listAgreements(),
    repository.listVersions(),
  ]);
  const versionsByAgreementId = new Map();
  for (const row of versionRows) {
    const versions = versionsByAgreementId.get(row.agreementId) || [];
    versions.push(serializeVersion(row));
    versionsByAgreementId.set(row.agreementId, versions);
  }
  return agreements.map((agreement) => (
    serializeAgreement(agreement, versionsByAgreementId.get(agreement.id) || [])
  ));
}

function normalizeBusinessUnitScope(scope = {}) {
  const scopeType = text(scope.scopeType, "Bereichsart", 30, { required: true });
  if (!BUSINESS_UNIT_SCOPE_TYPES.includes(scopeType)) throw new TypeError("Die Bereichsart des Betriebsteils ist ungültig.");
  return {
    scopeType,
    scopeKey: text(scope.scopeKey, "Bereich", 80, { required: true }),
  };
}

async function assertBusinessUnitScopeExists(repository, scope) {
  const target = await repository.getScopeTarget(scope.scopeType, scope.scopeKey);
  if (!target) {
    throw new TypeError("Der ausgewählte organisatorische Bereich wurde nicht gefunden.");
  }
  const occupied = await repository.findActiveScopeOwner(scope.scopeType, scope.scopeKey);
  if (occupied) {
    throw new TypeError(`Der organisatorische Bereich ist bereits dem Betriebsteil „${occupied.name}“ zugeordnet.`);
  }
}

async function insertBusinessUnitScopes(repository, businessUnitId, scopes, actor) {
  const normalized = [...new Map((Array.isArray(scopes) ? scopes : [])
    .map(normalizeBusinessUnitScope)
    .map((scope) => [`${scope.scopeType}:${scope.scopeKey}`, scope])).values()];
  for (const scope of normalized) {
    await assertBusinessUnitScopeExists(repository, scope);
    await repository.insertBusinessUnitScope({
      id: randomUUID(),
      businessUnitId,
      scopeType: scope.scopeType,
      scopeKey: scope.scopeKey,
      actor: String(actor || ""),
    });
  }
}

async function createBusinessUnit(repository, value, actor = "") {
  assertCollectiveAgreementsRepository(repository);
  const code = text(value.code, "Betriebsteil-Kürzel", 40, { required: true }).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(code)) throw new TypeError("Das Betriebsteil-Kürzel enthält ungültige Zeichen.");
  const name = text(value.name, "Betriebsteil", 160, { required: true });
  const legalEntityName = text(value.legalEntityName, "Rechtsträger", 200, { required: true });
  const description = text(value.description, "Beschreibung", 1200);
  const id = randomUUID();
  return repository.transaction(async (transactionRepository) => {
    const duplicate = await transactionRepository.findBusinessUnitByCode(code);
    if (duplicate) throw new TypeError("Dieses Betriebsteil-Kürzel wird bereits verwendet.");
    await transactionRepository.insertBusinessUnit({
      id,
      code,
      name,
      legalEntityName,
      description,
      actor: String(actor || ""),
    });
    await insertBusinessUnitScopes(transactionRepository, id, value.scopes, actor);
    return getBusinessUnit(transactionRepository, id);
  });
}

async function addBusinessUnitScopes(repository, businessUnitId, scopes, actor = "") {
  assertCollectiveAgreementsRepository(repository);
  const id = String(businessUnitId || "");
  return repository.transaction(async (transactionRepository) => {
    const unit = await transactionRepository.getActiveBusinessUnit(id);
    if (!unit) throw new TypeError("Der aktive Betriebsteil wurde nicht gefunden.");
    await insertBusinessUnitScopes(transactionRepository, id, scopes, actor);
    await transactionRepository.touchBusinessUnit(id, String(actor || ""));
    return getBusinessUnit(transactionRepository, id);
  });
}

async function scopeLabel(repository, scopeType, scopeKey) {
  const row = await repository.getScopeTarget(scopeType, scopeKey);
  if (scopeType === "cost_center") {
    return row ? `Kostenstelle ${row.code} · ${row.name}` : "Unbekannte Kostenstelle";
  }
  if (scopeType === "location") {
    return row ? `Filiale ${row.scopeKey} · ${row.name}` : "Unbekannte Filiale";
  }
  return row
    ? `Abteilung ${row.locationId} · ${row.locationName} · ${row.name}`
    : "Unbekannte Abteilung";
}

async function serializeBusinessUnit(repository, row, scopeRows) {
  const scopes = await Promise.all(scopeRows.map(async (scope) => ({
    id: scope.id,
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    label: await scopeLabel(repository, scope.scopeType, scope.scopeKey),
    createdBy: scope.createdBy,
    createdAt: scope.createdAt,
  })));
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    legalEntityName: row.legalEntityName,
    description: row.description || "",
    active: row.active,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    scopes,
  };
}

async function getBusinessUnit(repository, id) {
  assertCollectiveAgreementsRepository(repository);
  const row = await repository.getBusinessUnit(String(id || ""));
  if (!row) return null;
  const scopes = await repository.listBusinessUnitScopes(row.id);
  return serializeBusinessUnit(repository, row, scopes);
}

async function listBusinessUnits(repository, { includeInactive = false } = {}) {
  assertCollectiveAgreementsRepository(repository);
  const [units, scopes] = await Promise.all([
    repository.listBusinessUnits(Boolean(includeInactive)),
    repository.listBusinessUnitScopes(),
  ]);
  const scopesByBusinessUnitId = new Map();
  for (const scope of scopes) {
    const entries = scopesByBusinessUnitId.get(scope.businessUnitId) || [];
    entries.push(scope);
    scopesByBusinessUnitId.set(scope.businessUnitId, entries);
  }
  return Promise.all(units.map((unit) => (
    serializeBusinessUnit(
      repository,
      unit,
      scopesByBusinessUnitId.get(unit.id) || [],
    )
  )));
}

async function prepareCollectiveAgreementAssignment(repository, value, actor = "") {
  assertCollectiveAgreementsRepository(repository);
  if (value.reviewState && value.reviewState !== "review_pending") {
    throw new TypeError("Eine KV-Zuordnung kann erst im Freigabeblock bestätigt oder aktiviert werden.");
  }
  const versionId = text(value.agreementVersionId, "KV-Fassung", 80, { required: true });
  const businessUnitId = text(value.businessUnitId, "Betriebsteil", 80, { required: true });
  const version = await repository.getVersionRange(versionId);
  if (!version) throw new TypeError("Die ausgewählte KV-Fassung wurde nicht gefunden.");
  const unit = await repository.getActiveBusinessUnit(businessUnitId);
  if (!unit) throw new TypeError("Der ausgewählte aktive Betriebsteil wurde nicht gefunden.");
  const validFrom = isoDate(value.validFrom, "Vorgeschlagen gültig ab", { required: true });
  const validTo = isoDate(value.validTo, "Vorgeschlagen gültig bis");
  if (validTo && validTo < validFrom) throw new TypeError("Vorgeschlagen gültig bis darf nicht vor gültig ab liegen.");
  if (validFrom < version.validFrom || (version.validTo && (!validTo || validTo > version.validTo))) {
    throw new TypeError("Der Zuordnungsvorschlag liegt außerhalb der dokumentierten KV-Fassung.");
  }
  const rationale = text(value.rationale, "Prüfbegründung", 2000, { required: true });
  if (rationale.length < 10) throw new TypeError("Bitte den Zuordnungsvorschlag nachvollziehbar begründen.");
  const referenceNote = text(value.referenceNote, "Prüfnachweis", 1600);
  return repository.transaction(async (transactionRepository) => {
    const duplicate = await transactionRepository.findPendingAssignment({
      agreementVersionId: versionId,
      businessUnitId,
      validFrom,
      validTo,
    });
    if (duplicate) throw new TypeError("Dieser offene Zuordnungsvorschlag ist bereits vorhanden.");
    const id = randomUUID();
    await transactionRepository.insertAssignment({
      id,
      agreementVersionId: versionId,
      businessUnitId,
      validFrom,
      validTo,
      rationale,
      referenceNote,
      actor: String(actor || ""),
    });
    return getCollectiveAgreementAssignment(transactionRepository, id);
  });
}

function serializeAssignment(row) {
  if (!row) return null;
  return {
    id: row.id,
    agreementId: row.agreementId,
    agreementCode: row.agreementCode,
    agreementTitle: row.agreementTitle,
    agreementVersionId: row.agreementVersionId,
    versionLabel: row.versionLabel,
    businessUnitId: row.businessUnitId,
    businessUnitCode: row.businessUnitCode,
    businessUnitName: row.businessUnitName,
    validFrom: row.validFrom,
    validTo: row.validTo || null,
    reviewState: row.reviewState,
    rationale: row.rationale,
    referenceNote: row.referenceNote || "",
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

async function getCollectiveAgreementAssignment(repository, id) {
  assertCollectiveAgreementsRepository(repository);
  const row = await repository.getAssignment(String(id || ""));
  if (!row) return null;
  return serializeAssignment(row);
}

async function listCollectiveAgreementAssignments(repository) {
  assertCollectiveAgreementsRepository(repository);
  return (await repository.listAssignments()).map(serializeAssignment);
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

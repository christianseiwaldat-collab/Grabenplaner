"use strict";

const { randomUUID } = require("node:crypto");
const {
  assertWorkRuleStoreRepository,
} = require("../persistence/repositories/work-rule-store");
const { canonicalSha256 } = require("./receipt");

const SCOPE_PRIORITY = Object.freeze({
  installation: 0,
  location: 10,
  department: 20,
  employee: 30,
});
const ASSIGNMENT_ENFORCEMENT_MODES = Object.freeze(["monitor", "enforced"]);
const EVALUATION_OUTCOMES = Object.freeze(["pass", "attention", "manual_review", "blocked"]);
const EVALUATION_TARGET_TYPES = Object.freeze(["planned_schedule", "actual_time"]);
const EMPTY_OBJECT = Object.freeze({});
const EMPTY_ARRAY = Object.freeze([]);

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function assertIsoDate(value, field) {
  if (!isIsoDate(value)) throw new TypeError(`${field} muss ein Datum im Format YYYY-MM-DD sein.`);
  return String(value);
}

function assertSha256(value, field) {
  const normalized = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new TypeError(`${field} muss eine SHA-256-Prüfsumme sein.`);
  return normalized;
}

function profileVersionId(profile) {
  return `${profile.id}@${profile.version}`;
}

function profileLayer(profile) {
  if (profile.id.includes("-kv-")) return "collective_agreement";
  if (profile.applicability?.sector) return "sector";
  return "law";
}

function profileSources(profile, sourceCatalog = {}) {
  return (profile.sourceRefs || []).map((sourceId) => sourceCatalog[sourceId]).filter(Boolean);
}

function normalizeBuiltinBundles(profileCatalog, sourceCatalog = {}) {
  const submitted = Array.isArray(profileCatalog) ? profileCatalog : Object.values(profileCatalog || {});
  return submitted.map((raw) => {
    const profile = raw?.profile && typeof raw.profile === "object" ? raw.profile : raw;
    if (!profile || typeof profile !== "object" || !profile.id || !profile.version) {
      throw new TypeError("Ein eingebautes Arbeitszeit-Regelprofil ist unvollständig.");
    }
    const rules = Array.isArray(raw?.rules)
      ? raw.rules.filter(Boolean)
      : (profile.ruleIds || []).map((ruleId) => ({ id: ruleId }));
    const sources = Array.isArray(raw?.sources)
      ? raw.sources.filter(Boolean)
      : profileSources(profile, sourceCatalog);
    return { profile, rules, sources };
  });
}

function snapshotSchemaVersion(profile) {
  const explicit = Number(profile?.snapshotSchemaVersion);
  if ([1, 2].includes(explicit)) return explicit;
  // The first published catalog was already written to user databases with
  // schemaVersion 1. Its immutable version IDs and hashes must never be
  // reinterpreted when the application learns a richer snapshot format.
  return /^2026\.1(?:$|-draft$)/.test(String(profile?.version || "")) ? 1 : 2;
}

function versionSnapshot(profile, rules, sources, schemaVersion = snapshotSchemaVersion(profile)) {
  const legacy = {
    schemaVersion: 1,
    catalogVersion: profile.catalogVersion,
    profileId: profile.id,
    version: profile.version,
    applicability: profile.applicability,
    limits: profile.limits,
    ruleIds: profile.ruleIds,
    rules,
    sources,
  };
  if (schemaVersion === 1) return legacy;
  return {
    ...legacy,
    schemaVersion: 2,
    title: profile.title,
    status: profile.status,
    assignable: profile.assignable === true,
    validFrom: profile.validFrom,
    validTo: profile.validTo || null,
    defaultEnforcementMode: profile.defaultEnforcementMode || "monitor",
  };
}

function storedRulesPayload(snapshot) {
  const payload = {
    schemaVersion: snapshot.schemaVersion,
    catalogVersion: snapshot.catalogVersion,
  };
  if (snapshot.schemaVersion >= 2) {
    Object.assign(payload, {
      title: snapshot.title,
      status: snapshot.status,
      assignable: snapshot.assignable,
      validFrom: snapshot.validFrom,
      validTo: snapshot.validTo,
      defaultEnforcementMode: snapshot.defaultEnforcementMode,
    });
  }
  return {
    ...payload,
    applicability: snapshot.applicability,
    limits: snapshot.limits,
    ruleIds: snapshot.ruleIds,
    rules: snapshot.rules,
  };
}

async function runAtomically(repository, work) {
  if (typeof repository.transaction === "function") return repository.transaction(work);
  return work(repository);
}

async function seedBuiltinProfilesWithRepository(
  repository,
  profileCatalog,
  sourceCatalog,
  options = {},
) {
  const actor = String(options.actor || "system");
  const bundles = normalizeBuiltinBundles(profileCatalog, sourceCatalog);

  await runAtomically(repository, async (transaction) => {
    for (const { profile, rules, sources } of bundles) {
      const id = profileVersionId(profile);
      const snapshot = versionSnapshot(profile, rules, sources);
      const contentSha256 = canonicalSha256(snapshot);
      const versionStatus = profile.status === "active" ? "published" : "draft";
      await transaction.upsertBuiltinProfile({
        id: profile.id,
        name: profile.title,
        description: profile.applicability?.note || "",
        jurisdiction: profile.applicability?.jurisdiction || "AT",
        sector: profile.applicability?.sector || "general",
        status: profile.status === "active" ? "active" : "draft",
        currentVersionId: profile.status === "active" ? id : null,
        createdBy: actor,
        updatedBy: actor,
      });
      await transaction.insertBuiltinProfileVersion({
        id,
        profileId: profile.id,
        version: profile.version,
        layer: profileLayer(profile),
        status: versionStatus,
        validFrom: profile.validFrom,
        validTo: profile.validTo || null,
        rules: storedRulesPayload(snapshot),
        sources: snapshot.sources,
        contentSha256,
        createdBy: actor,
      });
      const stored = await transaction.getProfileVersionHash(id);
      if (!stored || stored.contentSha256 !== contentSha256) {
        throw new Error(`Das unveränderliche Arbeitszeit-Regelprofil ${id} stimmt nicht mit dem eingebauten Katalog überein.`);
      }
    }

    const retail = bundles.find(({ profile }) => profile.id === "at-retail-adult-monitor")?.profile;
    if (retail) {
      await transaction.insertBuiltinAssignment({
        id: "builtin:at-retail-adult-monitor:installation",
        profileVersionId: profileVersionId(retail),
        validFrom: retail.validFrom,
        createdBy: actor,
      });
    }
  });
}

function serializeProfileRow(row) {
  return Object.freeze({
    id: row.id,
    name: row.name,
    description: row.description,
    jurisdiction: row.jurisdiction,
    sector: row.sector,
    builtin: row.builtin,
    status: row.status,
    currentVersionId: row.currentVersionId || null,
    version: row.version || null,
    layer: row.layer || null,
    versionStatus: row.versionStatus || null,
    validFrom: row.validFrom || null,
    validTo: row.validTo || null,
    contentSha256: row.contentSha256 || null,
    rules: row.rules || EMPTY_OBJECT,
    sources: row.sources || EMPTY_ARRAY,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

async function listProfilesWithRepository(repository) {
  const rows = await repository.listProfiles();
  return Object.freeze(rows.map(serializeProfileRow));
}

function profileVersionFromRow(row) {
  const stored = row.rules;
  const sources = row.sources;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)
    || !Array.isArray(stored.ruleIds) || !stored.limits || !stored.applicability
    || !Array.isArray(stored.rules) || !Array.isArray(sources)) {
    throw new Error(`Die Regelprofil-Version ${row.id} enthält keinen vollständigen Versionssnapshot.`);
  }
  const schemaVersion = Number(stored.schemaVersion || 1);
  if (![1, 2].includes(schemaVersion)) {
    throw new Error(`Die Regelprofil-Version ${row.id} verwendet ein unbekanntes Snapshot-Schema.`);
  }
  const profile = Object.freeze({
    id: row.profileId,
    title: stored.title || row.profileName || row.profileId,
    version: row.version,
    status: stored.status || (row.status === "published" ? "active" : "draft"),
    assignable: schemaVersion === 1 ? row.status === "published" : stored.assignable === true,
    validFrom: stored.validFrom || row.validFrom,
    validTo: stored.validTo || row.validTo || null,
    catalogVersion: stored.catalogVersion,
    defaultEnforcementMode: stored.defaultEnforcementMode
      || (row.profileId === "at-general-adult" ? "enforced" : "monitor"),
    applicability: stored.applicability,
    limits: stored.limits,
    ruleIds: stored.ruleIds,
    sourceRefs: Object.freeze(sources.map((source) => source?.id).filter(Boolean)),
  });
  const snapshot = versionSnapshot(profile, stored.rules, sources, schemaVersion);
  if (canonicalSha256(snapshot) !== row.contentSha256) {
    throw new Error(`Die unveränderliche Regelprofil-Version ${row.id} stimmt nicht mit ihrer Prüfsumme überein.`);
  }
  return Object.freeze({
    id: row.id,
    profileId: row.profileId,
    version: row.version,
    layer: row.layer,
    status: row.status,
    validFrom: row.validFrom,
    validTo: row.validTo || null,
    contentSha256: row.contentSha256,
    schemaVersion,
    profile,
    rules: stored.rules,
    sources,
  });
}

function hydrateWorkRuleProfileVersionRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new TypeError("Eine persistierte Regelprofil-Version wird benötigt.");
  }
  return profileVersionFromRow(row);
}

async function getProfileVersionWithRepository(repository, versionId) {
  const row = await repository.getProfileVersion(String(versionId || ""));
  return row ? profileVersionFromRow(row) : null;
}

function serializeAssignmentRow(row) {
  return Object.freeze({
    id: row.id,
    profileVersionId: row.profileVersionId,
    profileId: row.profileId,
    profileName: row.profileName,
    profileVersion: row.profileVersion,
    scopeType: row.scopeType,
    scopeKey: row.scopeKey,
    validFrom: row.validFrom,
    validTo: row.validTo || null,
    enforcementMode: row.enforcementMode,
    applicabilityConfirmed: row.applicabilityConfirmed,
    confirmedBy: row.confirmedBy || "",
    confirmedAt: row.confirmedAt || null,
    active: row.active,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  });
}

async function listAssignmentsWithRepository(repository, { includeInactive = false } = {}) {
  const rows = await repository.listAssignments(Boolean(includeInactive));
  return Object.freeze(rows.map(serializeAssignmentRow));
}

function assignmentMatchesScope(assignment, context) {
  if (assignment.scopeType === "installation") return true;
  if (assignment.scopeType === "location") {
    return assignment.scopeKey === String(context.locationId || "");
  }
  if (assignment.scopeType === "department") {
    return assignment.scopeKey === String(context.departmentId || "");
  }
  return assignment.scopeKey === String(context.employeeNumber || "");
}

function resolveWorkRuleAssignmentFromList(assignments, context) {
  const date = assertIsoDate(context.date, "Gültigkeitsdatum");
  const candidates = (Array.isArray(assignments) ? assignments : []).filter((assignment) => (
    assignmentMatchesScope(assignment, context)
    && assignment.validFrom <= date
    && (!assignment.validTo || assignment.validTo >= date)
  ));
  return candidates.sort((left, right) => (
    (SCOPE_PRIORITY[right.scopeType] || 0) - (SCOPE_PRIORITY[left.scopeType] || 0)
    || right.validFrom.localeCompare(left.validFrom)
    || right.id.localeCompare(left.id)
  ))[0] || null;
}

function assignmentProfileId(assignment) {
  const explicit = String(assignment?.profileId || assignment?.profile_id || "").trim();
  if (explicit) return explicit;
  const versionId = String(
    assignment?.profileVersionId || assignment?.profile_version_id || "",
  ).trim();
  if (versionId.includes("@")) return versionId.slice(0, versionId.lastIndexOf("@"));
  return versionId || String(assignment?.id || "");
}

function assignmentMatchesResolvedScope(assignment, context) {
  const expandedScopes = Array.isArray(assignment?.expandedScopes)
    ? assignment.expandedScopes
    : (Array.isArray(assignment?.expanded_scopes) ? assignment.expanded_scopes : []);
  if (!expandedScopes.length) {
    return Object.hasOwn(SCOPE_PRIORITY, assignment?.scopeType)
      && assignmentMatchesScope(assignment, context);
  }
  return expandedScopes.some((scope) => {
    const normalized = {
      scopeType: String(scope?.scopeType || scope?.type || ""),
      scopeKey: String(scope?.scopeKey ?? scope?.key ?? ""),
    };
    return Object.hasOwn(SCOPE_PRIORITY, normalized.scopeType)
      && assignmentMatchesScope(normalized, context);
  });
}

function assignmentResolvedScopePriority(assignment, context) {
  const expandedScopes = Array.isArray(assignment?.expandedScopes)
    ? assignment.expandedScopes
    : (Array.isArray(assignment?.expanded_scopes) ? assignment.expanded_scopes : []);
  const scopes = expandedScopes.length
    ? expandedScopes.map((scope) => ({
      scopeType: String(scope?.scopeType || scope?.type || ""),
      scopeKey: String(scope?.scopeKey ?? scope?.key ?? ""),
    }))
    : [assignment];
  return Math.max(0, ...scopes
    .filter((scope) => (
      Object.hasOwn(SCOPE_PRIORITY, scope.scopeType)
      && assignmentMatchesScope(scope, context)
    ))
    .map((scope) => SCOPE_PRIORITY[scope.scopeType] || 0));
}

function resolveWorkRuleAssignmentsFromList(assignments, context) {
  const date = assertIsoDate(context.date, "Gültigkeitsdatum");
  const candidates = (Array.isArray(assignments) ? assignments : []).filter((assignment) => (
    assignment?.active !== false
    && assignment?.active !== 0
    && assignmentMatchesResolvedScope(assignment, context)
    && assignment.validFrom <= date
    && (!assignment.validTo || assignment.validTo >= date)
  ));
  const selectedByProfile = new Map();
  for (const candidate of candidates.sort((left, right) => (
    assignmentResolvedScopePriority(right, context) - assignmentResolvedScopePriority(left, context)
    || right.validFrom.localeCompare(left.validFrom)
    || String(right.id || "").localeCompare(String(left.id || ""))
  ))) {
    const profileId = assignmentProfileId(candidate);
    if (!selectedByProfile.has(profileId)) selectedByProfile.set(profileId, candidate);
  }
  return [...selectedByProfile.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, assignment]) => assignment);
}

async function resolveAssignmentWithRepository(repository, context) {
  return resolveWorkRuleAssignmentFromList(
    await listAssignmentsWithRepository(repository),
    context,
  );
}

async function saveAssignmentWithRepository(repository, value, actor) {
  const id = String(value.id || randomUUID());
  return runAtomically(repository, async (transaction) => {
    const existing = await transaction.getAssignment(id);
    if (existing) {
      throw new TypeError("Eine bestehende Regelprofil-Zuordnung darf nicht überschrieben werden.");
    }
    const scopeType = String(value.scopeType || "installation");
    if (!Object.hasOwn(SCOPE_PRIORITY, scopeType)) {
      throw new TypeError("Ungültiger Geltungsbereich des Regelprofils.");
    }
    const scopeKey = scopeType === "installation" ? "" : String(value.scopeKey || "").trim();
    if (scopeType !== "installation" && !scopeKey) {
      throw new TypeError("Für diesen Geltungsbereich fehlt die Zuordnung.");
    }
    const profileVersionIdValue = String(value.profileVersionId || "");
    const version = await transaction.getAssignableProfileVersion(profileVersionIdValue);
    if (!version || version.status !== "published" || version.profileStatus !== "active") {
      throw new TypeError("Nur veröffentlichte, aktive Regelprofil-Versionen dürfen zugewiesen werden.");
    }
    const storedProfile = version.rules;
    if (Number(storedProfile?.schemaVersion || 1) >= 2 && storedProfile?.assignable !== true) {
      throw new TypeError("Dieses Regelprofil wird ausschließlich automatisch angewendet und darf nicht manuell zugewiesen werden.");
    }
    const validFrom = assertIsoDate(value.validFrom, "Gültig ab");
    const validTo = value.validTo ? assertIsoDate(value.validTo, "Gültig bis") : null;
    if (validTo && validTo < validFrom) {
      throw new TypeError("Gültig bis darf nicht vor Gültig ab liegen.");
    }
    if (validFrom < version.validFrom || (version.validTo && (!validTo || validTo > version.validTo))) {
      throw new TypeError("Die Zuordnung liegt außerhalb der Gültigkeit der Regelprofil-Version.");
    }
    const enforcementMode = String(value.enforcementMode || "monitor");
    if (!ASSIGNMENT_ENFORCEMENT_MODES.includes(enforcementMode)) {
      throw new TypeError("Ungültiger Durchsetzungsmodus.");
    }
    const applicabilityConfirmed = value.applicabilityConfirmed === true;
    if (enforcementMode === "enforced" && !applicabilityConfirmed) {
      throw new TypeError("Ein nicht bestätigtes Regelprofil darf nur im Monitorbetrieb verwendet werden.");
    }
    await transaction.insertAssignment({
      id,
      profileVersionId: profileVersionIdValue,
      scopeType,
      scopeKey,
      validFrom,
      validTo,
      enforcementMode,
      applicabilityConfirmed,
      confirmedBy: applicabilityConfirmed ? String(actor || "") : "",
      createdBy: String(actor || ""),
    });
    const stored = await transaction.getAssignment(id);
    if (!stored) throw new Error("Die gespeicherte Regelprofil-Zuordnung konnte nicht gelesen werden.");
    return serializeAssignmentRow(stored);
  });
}

function evaluationReceipt(row, result) {
  const core = {
    id: row.id,
    targetType: row.targetType,
    scopeType: row.scopeType,
    scopeKey: row.scopeKey,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    profileVersionIds: row.profileVersionIds,
    inputSha256: row.inputSha256,
    resultSha256: row.resultSha256,
    outcome: row.outcome,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
  const computedResultSha256 = canonicalSha256(result);
  const receiptSha256 = row.receiptSha256;
  const receiptHashValid = canonicalSha256({
    schemaVersion: 1,
    ...core,
    result,
  }) === receiptSha256;
  return Object.freeze({
    ...core,
    result,
    receiptSha256,
    receiptHashValid,
    // Kompatibilitätsalias: Die Prüfung umfasst nun den gesamten Beleg
    // und schützt damit insbesondere auch das strukturierte Ergebnis.
    resultHashValid: computedResultSha256 === core.resultSha256,
  });
}

function evaluationFromRow(row, { verify = true } = {}) {
  const result = row.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`Der Prüfbeleg ${row.id} enthält kein lesbares Ergebnis.`);
  }
  const receipt = evaluationReceipt(row, result);
  if (verify && (!receipt.receiptHashValid || !receipt.resultHashValid)) {
    throw new Error(`Die Prüfbeleg-Prüfsumme des Prüfbelegs ${row.id} stimmt nicht.`);
  }
  return receipt;
}

async function getEvaluationWithRepository(repository, id, options = {}) {
  const row = await repository.getEvaluation(String(id || ""));
  return row ? evaluationFromRow(row, options) : null;
}

async function recordEvaluationWithRepository(repository, value) {
  if (!value?.result || typeof value.result !== "object" || Array.isArray(value.result)) {
    throw new TypeError("Für den Prüfbeleg fehlt das strukturierte Ergebnis.");
  }
  const targetType = String(value.targetType || "planned_schedule");
  if (!EVALUATION_TARGET_TYPES.includes(targetType)) {
    throw new TypeError("Ungültige Bewertungsgrundlage.");
  }
  const periodFrom = assertIsoDate(value.periodFrom, "Zeitraum von");
  const periodTo = assertIsoDate(value.periodTo, "Zeitraum bis");
  if (periodTo < periodFrom) {
    throw new TypeError("Zeitraum bis darf nicht vor Zeitraum von liegen.");
  }
  const inputSha256 = assertSha256(value.inputSha256, "Input-SHA-256");
  const outcome = String(value.outcome || "");
  if (!EVALUATION_OUTCOMES.includes(outcome)) {
    throw new TypeError("Ungültiger Bewertungsausgang.");
  }
  const profileVersionIds = [...new Set(
    (Array.isArray(value.profileVersionIds) ? value.profileVersionIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  )];
  if (!profileVersionIds.length) {
    throw new TypeError("Für den Prüfbeleg fehlt die verwendete Regelprofil-Version.");
  }

  return runAtomically(repository, async (transaction) => {
    for (const id of profileVersionIds) {
      const stored = await transaction.getProfileVersionHash(id);
      if (!stored) {
        throw new TypeError("Der Prüfbeleg verweist auf eine unbekannte Regelprofil-Version.");
      }
    }

    const result = JSON.parse(JSON.stringify(value.result));
    const resultSha256 = canonicalSha256(result);
    const id = String(value.id || randomUUID());
    const scopeType = String(value.scopeType || "location");
    const scopeKey = String(value.scopeKey || "");
    const createdBy = String(value.actor || "");
    const createdAt = new Date().toISOString();
    const receiptSha256 = canonicalSha256({
      schemaVersion: 1,
      id,
      targetType,
      scopeType,
      scopeKey,
      periodFrom,
      periodTo,
      profileVersionIds,
      inputSha256,
      resultSha256,
      outcome,
      result,
      createdBy,
      createdAt,
    });
    await transaction.insertEvaluation({
      id,
      targetType,
      scopeType,
      scopeKey,
      periodFrom,
      periodTo,
      profileVersionIds,
      inputSha256,
      resultSha256,
      result,
      receiptSha256,
      outcome,
      createdBy,
      createdAt,
    });
    return getEvaluationWithRepository(transaction, id);
  });
}

function normalizedEvaluationLimit(value) {
  const submitted = Number(value);
  if (!Number.isFinite(submitted)) return 50;
  return Math.min(200, Math.max(1, Math.trunc(submitted) || 50));
}

async function listEvaluationsWithRepository(repository, { limit = 50 } = {}) {
  const rows = await repository.listEvaluations(normalizedEvaluationLimit(limit));
  return Object.freeze(rows.map((row) => {
    const receipt = evaluationFromRow(row, { verify: false });
    return Object.freeze({
      id: receipt.id,
      targetType: receipt.targetType,
      scopeType: receipt.scopeType,
      scopeKey: receipt.scopeKey,
      periodFrom: receipt.periodFrom,
      periodTo: receipt.periodTo,
      profileVersionIds: receipt.profileVersionIds,
      inputSha256: receipt.inputSha256,
      resultSha256: receipt.resultSha256,
      receiptSha256: receipt.receiptSha256,
      receiptHashValid: receipt.receiptHashValid,
      resultHashValid: receipt.resultHashValid,
      outcome: receipt.outcome,
      createdBy: receipt.createdBy,
      createdAt: receipt.createdAt,
    });
  }));
}

function seedBuiltinWorkRuleProfiles(repository, profileCatalog, sourceCatalog, options) {
  return seedBuiltinProfilesWithRepository(
    assertWorkRuleStoreRepository(repository),
    profileCatalog,
    sourceCatalog,
    options,
  );
}

function listWorkRuleProfiles(repository) {
  return listProfilesWithRepository(assertWorkRuleStoreRepository(repository));
}

function getWorkRuleProfileVersion(repository, versionId) {
  return getProfileVersionWithRepository(assertWorkRuleStoreRepository(repository), versionId);
}

function listWorkRuleAssignments(repository, options) {
  return listAssignmentsWithRepository(assertWorkRuleStoreRepository(repository), options);
}

function resolveWorkRuleAssignment(repository, context) {
  return resolveAssignmentWithRepository(assertWorkRuleStoreRepository(repository), context);
}

function saveWorkRuleAssignment(repository, value, actor) {
  return saveAssignmentWithRepository(assertWorkRuleStoreRepository(repository), value, actor);
}

function recordWorkRuleEvaluation(repository, value) {
  return recordEvaluationWithRepository(assertWorkRuleStoreRepository(repository), value);
}

function getWorkRuleEvaluation(repository, id, options) {
  return getEvaluationWithRepository(assertWorkRuleStoreRepository(repository), id, options);
}

function listWorkRuleEvaluations(repository, options) {
  return listEvaluationsWithRepository(assertWorkRuleStoreRepository(repository), options);
}

module.exports = {
  ASSIGNMENT_ENFORCEMENT_MODES,
  EVALUATION_OUTCOMES,
  EVALUATION_TARGET_TYPES,
  SCOPE_PRIORITY,
  getWorkRuleProfileVersion,
  getWorkRuleEvaluation,
  hydrateWorkRuleProfileVersionRow,
  listWorkRuleAssignments,
  listWorkRuleEvaluations,
  listWorkRuleProfiles,
  profileVersionId,
  recordWorkRuleEvaluation,
  resolveWorkRuleAssignment,
  resolveWorkRuleAssignmentFromList,
  resolveWorkRuleAssignmentsFromList,
  saveWorkRuleAssignment,
  seedBuiltinWorkRuleProfiles,
  versionSnapshot,
};

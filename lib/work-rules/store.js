"use strict";

const { randomUUID } = require("node:crypto");
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

function seedBuiltinWorkRuleProfiles(db, profileCatalog, sourceCatalog, options = {}) {
  const insertProfile = db.prepare(`
    INSERT INTO work_rule_profiles
      (id, name, description, jurisdiction, sector, builtin, status,
       current_version_id, created_by, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      jurisdiction = excluded.jurisdiction,
      sector = excluded.sector,
      builtin = 1,
      status = excluded.status,
      current_version_id = excluded.current_version_id,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `);
  const insertVersion = db.prepare(`
    INSERT OR IGNORE INTO work_rule_profile_versions
      (id, profile_id, version, layer, status, valid_from, valid_to,
       rules_json, sources_json, content_sha256, created_by, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      CASE WHEN ? = 'published' THEN CURRENT_TIMESTAMP ELSE NULL END)
  `);
  const versionById = db.prepare(`
    SELECT content_sha256 FROM work_rule_profile_versions WHERE id = ?
  `);
  const actor = String(options.actor || "system");
  const bundles = normalizeBuiltinBundles(profileCatalog, sourceCatalog);

  db.exec("BEGIN");
  try {
    for (const { profile, rules, sources } of bundles) {
      const versionId = profileVersionId(profile);
      const snapshot = versionSnapshot(profile, rules, sources);
      const contentSha256 = canonicalSha256(snapshot);
      const versionStatus = profile.status === "active" ? "published" : "draft";
      insertProfile.run(
        profile.id,
        profile.title,
        profile.applicability?.note || "",
        profile.applicability?.jurisdiction || "AT",
        profile.applicability?.sector || "general",
        profile.status === "active" ? "active" : "draft",
        profile.status === "active" ? versionId : null,
        actor,
        actor,
      );
      insertVersion.run(
        versionId,
        profile.id,
        profile.version,
        profileLayer(profile),
        versionStatus,
        profile.validFrom,
        profile.validTo || null,
        JSON.stringify(storedRulesPayload(snapshot)),
        JSON.stringify(snapshot.sources),
        contentSha256,
        actor,
        versionStatus,
      );
      const stored = versionById.get(versionId);
      if (!stored || stored.content_sha256 !== contentSha256) {
        throw new Error(`Das unveränderliche Arbeitszeit-Regelprofil ${versionId} stimmt nicht mit dem eingebauten Katalog überein.`);
      }
    }

    const retail = bundles.find(({ profile }) => profile.id === "at-retail-adult-monitor")?.profile;
    if (retail) {
      db.prepare(`
        INSERT OR IGNORE INTO work_rule_assignments
          (id, profile_version_id, scope_type, scope_key, valid_from, valid_to,
           enforcement_mode, applicability_confirmed, active, created_by)
        VALUES (?, ?, 'installation', '', ?, NULL, 'monitor', 0, 1, ?)
      `).run(
        "builtin:at-retail-adult-monitor:installation",
        profileVersionId(retail),
        retail.validFrom,
        actor,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function serializeProfileRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    jurisdiction: row.jurisdiction,
    sector: row.sector,
    builtin: Boolean(row.builtin),
    status: row.status,
    currentVersionId: row.current_version_id || null,
    version: row.version || null,
    layer: row.layer || null,
    versionStatus: row.version_status || null,
    validFrom: row.valid_from || null,
    validTo: row.valid_to || null,
    contentSha256: row.content_sha256 || null,
    rules: parseJson(row.rules_json, {}),
    sources: parseJson(row.sources_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listWorkRuleProfiles(db) {
  return db.prepare(`
    SELECT p.*, v.version, v.layer, v.status AS version_status, v.valid_from,
           v.valid_to, v.rules_json, v.sources_json, v.content_sha256
    FROM work_rule_profiles p
    LEFT JOIN work_rule_profile_versions v ON v.id = p.current_version_id
    ORDER BY p.builtin DESC, p.name, p.id
  `).all().map(serializeProfileRow);
}

function getWorkRuleProfileVersion(db, versionId) {
  const row = db.prepare(`
    SELECT v.*, p.name AS profile_name
    FROM work_rule_profile_versions v
    JOIN work_rule_profiles p ON p.id = v.profile_id
    WHERE v.id = ?
  `).get(String(versionId || ""));
  if (!row) return null;
  const stored = parseJson(row.rules_json, null);
  const sources = parseJson(row.sources_json, []);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)
    || !Array.isArray(stored.ruleIds) || !stored.limits || !stored.applicability
    || !Array.isArray(stored.rules) || !Array.isArray(sources)) {
    throw new Error(`Die Regelprofil-Version ${row.id} enthält keinen vollständigen Versionssnapshot.`);
  }
  const schemaVersion = Number(stored.schemaVersion || 1);
  if (![1, 2].includes(schemaVersion)) {
    throw new Error(`Die Regelprofil-Version ${row.id} verwendet ein unbekanntes Snapshot-Schema.`);
  }
  const profile = {
    id: row.profile_id,
    title: stored.title || row.profile_name || row.profile_id,
    version: row.version,
    status: stored.status || (row.status === "published" ? "active" : "draft"),
    assignable: schemaVersion === 1 ? row.status === "published" : stored.assignable === true,
    validFrom: stored.validFrom || row.valid_from,
    validTo: stored.validTo || row.valid_to || null,
    catalogVersion: stored.catalogVersion,
    defaultEnforcementMode: stored.defaultEnforcementMode
      || (row.profile_id === "at-general-adult" ? "enforced" : "monitor"),
    applicability: stored.applicability,
    limits: stored.limits,
    ruleIds: stored.ruleIds,
    sourceRefs: sources.map((source) => source?.id).filter(Boolean),
  };
  const snapshot = versionSnapshot(profile, stored.rules, sources, schemaVersion);
  if (canonicalSha256(snapshot) !== row.content_sha256) {
    throw new Error(`Die unveränderliche Regelprofil-Version ${row.id} stimmt nicht mit ihrer Prüfsumme überein.`);
  }
  return {
    id: row.id,
    profileId: row.profile_id,
    version: row.version,
    layer: row.layer,
    status: row.status,
    validFrom: row.valid_from,
    validTo: row.valid_to || null,
    contentSha256: row.content_sha256,
    schemaVersion,
    profile,
    rules: stored.rules,
    sources,
  };
}

function serializeAssignmentRow(row) {
  return {
    id: row.id,
    profileVersionId: row.profile_version_id,
    profileId: row.profile_id,
    profileName: row.profile_name,
    profileVersion: row.profile_version,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    validFrom: row.valid_from,
    validTo: row.valid_to || null,
    enforcementMode: row.enforcement_mode,
    applicabilityConfirmed: Boolean(row.applicability_confirmed),
    confirmedBy: row.confirmed_by || "",
    confirmedAt: row.confirmed_at || null,
    active: Boolean(row.active),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function listWorkRuleAssignments(db, { includeInactive = false } = {}) {
  return db.prepare(`
    SELECT a.*, v.profile_id, v.version AS profile_version, p.name AS profile_name
    FROM work_rule_assignments a
    JOIN work_rule_profile_versions v ON v.id = a.profile_version_id
    JOIN work_rule_profiles p ON p.id = v.profile_id
    ${includeInactive ? "" : "WHERE a.active = 1"}
    ORDER BY a.active DESC, a.scope_type, a.scope_key, a.valid_from, a.id
  `).all().map(serializeAssignmentRow);
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

function resolveWorkRuleAssignment(db, context) {
  return resolveWorkRuleAssignmentFromList(listWorkRuleAssignments(db), context);
}

function saveWorkRuleAssignment(db, value, actor) {
  const id = String(value.id || randomUUID());
  const scopeType = String(value.scopeType || "installation");
  if (!Object.hasOwn(SCOPE_PRIORITY, scopeType)) throw new TypeError("Ungültiger Geltungsbereich des Regelprofils.");
  const scopeKey = scopeType === "installation" ? "" : String(value.scopeKey || "").trim();
  if (scopeType !== "installation" && !scopeKey) throw new TypeError("Für diesen Geltungsbereich fehlt die Zuordnung.");
  const profileVersionIdValue = String(value.profileVersionId || "");
  const version = db.prepare(`
    SELECT v.id, v.status, v.valid_from, v.valid_to, v.rules_json, p.status AS profile_status
    FROM work_rule_profile_versions v
    JOIN work_rule_profiles p ON p.id = v.profile_id
    WHERE v.id = ?
  `).get(profileVersionIdValue);
  if (!version || version.status !== "published" || version.profile_status !== "active") {
    throw new TypeError("Nur veröffentlichte, aktive Regelprofil-Versionen dürfen zugewiesen werden.");
  }
  const storedProfile = parseJson(version.rules_json, {});
  if (Number(storedProfile.schemaVersion || 1) >= 2 && storedProfile.assignable !== true) {
    throw new TypeError("Dieses Regelprofil wird ausschließlich automatisch angewendet und darf nicht manuell zugewiesen werden.");
  }
  const validFrom = assertIsoDate(value.validFrom, "Gültig ab");
  const validTo = value.validTo ? assertIsoDate(value.validTo, "Gültig bis") : null;
  if (validTo && validTo < validFrom) throw new TypeError("Gültig bis darf nicht vor Gültig ab liegen.");
  if (validFrom < version.valid_from || (version.valid_to && (!validTo || validTo > version.valid_to))) {
    throw new TypeError("Die Zuordnung liegt außerhalb der Gültigkeit der Regelprofil-Version.");
  }
  const enforcementMode = String(value.enforcementMode || "monitor");
  if (!ASSIGNMENT_ENFORCEMENT_MODES.includes(enforcementMode)) throw new TypeError("Ungültiger Durchsetzungsmodus.");
  const confirmed = value.applicabilityConfirmed === true;
  if (enforcementMode === "enforced" && !confirmed) {
    throw new TypeError("Ein nicht bestätigtes Regelprofil darf nur im Monitorbetrieb verwendet werden.");
  }
  db.prepare(`
    INSERT INTO work_rule_assignments
      (id, profile_version_id, scope_type, scope_key, valid_from, valid_to,
       enforcement_mode, applicability_confirmed, confirmed_by, confirmed_at,
       active, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, 1, ?)
    ON CONFLICT(id) DO UPDATE SET
      profile_version_id = excluded.profile_version_id,
      scope_type = excluded.scope_type,
      scope_key = excluded.scope_key,
      valid_from = excluded.valid_from,
      valid_to = excluded.valid_to,
      enforcement_mode = excluded.enforcement_mode,
      applicability_confirmed = excluded.applicability_confirmed,
      confirmed_by = excluded.confirmed_by,
      confirmed_at = excluded.confirmed_at,
      active = 1
  `).run(
    id,
    profileVersionIdValue,
    scopeType,
    scopeKey,
    validFrom,
    validTo,
    enforcementMode,
    confirmed ? 1 : 0,
    confirmed ? String(actor || "") : "",
    confirmed ? 1 : 0,
    String(actor || ""),
  );
  return listWorkRuleAssignments(db, { includeInactive: true }).find((assignment) => assignment.id === id);
}

function recordWorkRuleEvaluation(db, value) {
  if (!value?.result || typeof value.result !== "object" || Array.isArray(value.result)) {
    throw new TypeError("Für den Prüfbeleg fehlt das strukturierte Ergebnis.");
  }
  const targetType = String(value.targetType || "planned_schedule");
  if (!EVALUATION_TARGET_TYPES.includes(targetType)) throw new TypeError("Ungültige Bewertungsgrundlage.");
  const periodFrom = assertIsoDate(value.periodFrom, "Zeitraum von");
  const periodTo = assertIsoDate(value.periodTo, "Zeitraum bis");
  if (periodTo < periodFrom) throw new TypeError("Zeitraum bis darf nicht vor Zeitraum von liegen.");
  const inputSha256 = assertSha256(value.inputSha256, "Input-SHA-256");
  const outcome = String(value.outcome || "");
  if (!EVALUATION_OUTCOMES.includes(outcome)) throw new TypeError("Ungültiger Bewertungsausgang.");
  const profileVersionIds = [...new Set(
    (Array.isArray(value.profileVersionIds) ? value.profileVersionIds : [])
      .map((profileVersionIdValue) => String(profileVersionIdValue || "").trim())
      .filter(Boolean),
  )];
  if (!profileVersionIds.length) throw new TypeError("Für den Prüfbeleg fehlt die verwendete Regelprofil-Version.");
  const placeholders = profileVersionIds.map(() => "?").join(",");
  const existingVersions = new Set(db.prepare(`
    SELECT id FROM work_rule_profile_versions WHERE id IN (${placeholders})
  `).all(...profileVersionIds).map((row) => row.id));
  if (profileVersionIds.some((profileVersionIdValue) => !existingVersions.has(profileVersionIdValue))) {
    throw new TypeError("Der Prüfbeleg verweist auf eine unbekannte Regelprofil-Version.");
  }
  const resultJson = JSON.stringify(value.result);
  const storedResult = JSON.parse(resultJson);
  const resultSha256 = canonicalSha256(storedResult);
  const id = String(value.id || randomUUID());
  const targetScopeType = String(value.scopeType || "location");
  const targetScopeKey = String(value.scopeKey || "");
  const createdBy = String(value.actor || "");
  const createdAt = new Date().toISOString();
  const receiptSha256 = canonicalSha256({
    schemaVersion: 1,
    id,
    targetType,
    scopeType: targetScopeType,
    scopeKey: targetScopeKey,
    periodFrom,
    periodTo,
    profileVersionIds,
    inputSha256,
    resultSha256,
    outcome,
    result: storedResult,
    createdBy,
    createdAt,
  });
  db.prepare(`
    INSERT INTO work_rule_evaluation_runs
      (id, target_type, scope_type, scope_key, period_from, period_to,
       profile_version_ids_json, input_sha256, result_sha256, result_json,
       receipt_sha256, outcome, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    targetType,
    targetScopeType,
    targetScopeKey,
    periodFrom,
    periodTo,
    JSON.stringify(profileVersionIds),
    inputSha256,
    resultSha256,
    resultJson,
    receiptSha256,
    outcome,
    createdBy,
    createdAt,
  );
  return getWorkRuleEvaluation(db, id);
}

function evaluationReceipt(row, result) {
  const core = {
    id: row.id,
    targetType: row.target_type,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    profileVersionIds: parseJson(row.profile_version_ids_json, []),
    inputSha256: row.input_sha256,
    resultSha256: row.result_sha256,
    outcome: row.outcome,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
  const computedResultSha256 = canonicalSha256(result);
  const receiptSha256 = row.receipt_sha256;
  const receiptHashValid = canonicalSha256({
    schemaVersion: 1,
    ...core,
    result,
  }) === receiptSha256;
  return {
    ...core,
    result,
    receiptSha256,
    receiptHashValid,
    // Kompatibilitätsalias: Die Prüfung umfasst nun den gesamten Beleg
    // und schützt damit insbesondere auch das strukturierte Ergebnis.
    resultHashValid: computedResultSha256 === core.resultSha256,
  };
}

function getWorkRuleEvaluation(db, id, { verify = true } = {}) {
  const row = db.prepare(`
    SELECT * FROM work_rule_evaluation_runs WHERE id = ?
  `).get(String(id || ""));
  if (!row) return null;
  const result = parseJson(row.result_json, null);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`Der Prüfbeleg ${row.id} enthält kein lesbares Ergebnis.`);
  }
  const receipt = evaluationReceipt(row, result);
  if (verify && (!receipt.receiptHashValid || !receipt.resultHashValid)) {
    throw new Error(`Die Prüfbeleg-Prüfsumme des Prüfbelegs ${row.id} stimmt nicht.`);
  }
  return receipt;
}

function listWorkRuleEvaluations(db, { limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  return db.prepare(`
    SELECT id, target_type, scope_type, scope_key, period_from, period_to,
           profile_version_ids_json, input_sha256, result_sha256, result_json, receipt_sha256,
           outcome, created_by, created_at
    FROM work_rule_evaluation_runs
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(safeLimit).map((row) => {
    const result = parseJson(row.result_json, null);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error(`Der Prüfbeleg ${row.id} enthält kein lesbares Ergebnis.`);
    }
    const receipt = evaluationReceipt(row, result);
    return {
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
    };
  });
}

module.exports = {
  ASSIGNMENT_ENFORCEMENT_MODES,
  EVALUATION_OUTCOMES,
  EVALUATION_TARGET_TYPES,
  SCOPE_PRIORITY,
  getWorkRuleProfileVersion,
  getWorkRuleEvaluation,
  listWorkRuleAssignments,
  listWorkRuleEvaluations,
  listWorkRuleProfiles,
  profileVersionId,
  recordWorkRuleEvaluation,
  resolveWorkRuleAssignment,
  resolveWorkRuleAssignmentFromList,
  saveWorkRuleAssignment,
  seedBuiltinWorkRuleProfiles,
  versionSnapshot,
};

"use strict";

const { createHash, randomUUID } = require("node:crypto");
const {
  assertCustomProcessManagementRepository,
} = require("./persistence/repositories/custom-process-management");
const {
  personnelWorkflowPublicationReceiptBody,
} = require("./personnel-workflow-publication-receipt");

const PERSONNEL_WORKFLOW_TYPES = Object.freeze([
  "application",
  "preboarding",
  "onboarding",
  "training",
  "position_change",
  "department_change",
  "location_change",
  "return_from_absence",
  "offboarding",
  "custom_personnel",
]);
const WORKFLOW_TYPE_SET = new Set(PERSONNEL_WORKFLOW_TYPES);
const REQUIREMENT_KIND_SET = new Set(["mandatory", "supplemental"]);
const CONCURRENT_PERSISTENCE_ERROR_CODES = new Set([
  "PERSISTENCE_UNIQUE_VIOLATION",
  "PERSISTENCE_BUSY",
  "PERSISTENCE_RETRYABLE_TRANSACTION",
]);

const PERSONNEL_WORKFLOW_ERROR_KINDS = Object.freeze({
  INPUT: "input",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  INTEGRITY: "integrity",
});

class PersonnelWorkflowError extends Error {
  constructor(message, code, kind = PERSONNEL_WORKFLOW_ERROR_KINDS.INPUT) {
    super(message);
    this.name = "PersonnelWorkflowError";
    this.code = code;
    this.kind = kind;
  }
}

function workflowError(message, code, kind) {
  return new PersonnelWorkflowError(message, code, kind);
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw workflowError(`${label} ist ungueltig.`, "PERSONNEL_WORKFLOW_INPUT_INVALID");
  }
  return value;
}

function exactKeys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw workflowError(`${label} enthaelt unbekannte Felder.`, "PERSONNEL_WORKFLOW_INPUT_INVALID");
  }
}

function normalizedWorkflowCode(value) {
  const code = String(value || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{1,79}$/.test(code)) {
    throw workflowError(
      "Der Workflow-Code muss mit einem Buchstaben beginnen und 2 bis 80 technische Zeichen enthalten.",
      "PERSONNEL_WORKFLOW_CODE_INVALID",
    );
  }
  return code;
}

function normalizedScope(value) {
  const scope = plainObject(value, "Der Workflow-Geltungsbereich");
  const type = String(scope.type || "").trim();
  const locationId = String(scope.locationId || "").trim() || null;
  const departmentId = Number(scope.departmentId || 0) || null;
  if (type === "company" && !locationId && !departmentId) {
    return Object.freeze({ type, locationId: null, departmentId: null });
  }
  if (type === "location" && locationId && !departmentId) {
    return Object.freeze({ type, locationId, departmentId: null });
  }
  if (type === "department" && locationId && Number.isSafeInteger(departmentId)
    && departmentId > 0) {
    return Object.freeze({ type, locationId, departmentId });
  }
  throw workflowError(
    "Der eingefrorene Workflow-Geltungsbereich ist ungueltig.",
    "PERSONNEL_WORKFLOW_SCOPE_INVALID",
    PERSONNEL_WORKFLOW_ERROR_KINDS.INTEGRITY,
  );
}

function parseSnapshot(row) {
  let snapshot;
  try { snapshot = JSON.parse(String(row?.snapshot_json || "")); } catch { snapshot = null; }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || snapshot.id !== String(row?.process_id || "")
    || Number(snapshot.revision) !== Number(row?.revision || row?.source_revision || 0)
    || !Array.isArray(snapshot.steps)) {
    throw workflowError(
      "Eine Prozessrevision besitzt keinen gueltigen unveraenderlichen Snapshot.",
      "PERSONNEL_WORKFLOW_SNAPSHOT_INTEGRITY_FAILED",
      PERSONNEL_WORKFLOW_ERROR_KINDS.INTEGRITY,
    );
  }
  return snapshot;
}

function publicationRowReceipt(row) {
  return sha256(JSON.stringify(personnelWorkflowPublicationReceiptBody(row)));
}

function verifiedPublication(row) {
  if (!row) return null;
  if (sha256(row.snapshot_json) !== String(row.snapshot_sha256 || "")
    || publicationRowReceipt(row) !== String(row.receipt_sha256 || "")) {
    throw workflowError(
      "Eine veroeffentlichte Workflow-Version besitzt keinen gueltigen Integritaetsbeleg.",
      "PERSONNEL_WORKFLOW_PUBLICATION_INTEGRITY_FAILED",
      PERSONNEL_WORKFLOW_ERROR_KINDS.INTEGRITY,
    );
  }
  const snapshot = parseSnapshot(row);
  const scope = normalizedScope(snapshot.scope || {});
  if (scope.type !== row.scope_type
    || String(scope.locationId || "") !== String(row.location_id || "")
    || Number(scope.departmentId || 0) !== Number(row.department_id || 0)
    || !WORKFLOW_TYPE_SET.has(row.workflow_type)
    || !REQUIREMENT_KIND_SET.has(row.requirement_kind)
    || row.data_classification !== "standard") {
    throw workflowError(
      "Eine veroeffentlichte Workflow-Version ist widerspruechlich.",
      "PERSONNEL_WORKFLOW_PUBLICATION_INTEGRITY_FAILED",
      PERSONNEL_WORKFLOW_ERROR_KINDS.INTEGRITY,
    );
  }
  return Object.freeze({ row, snapshot, scope });
}

function publicPublication(value) {
  const { row, snapshot, scope } = value;
  return Object.freeze({
    id: row.id,
    processId: row.process_id,
    sourceRevision: Number(row.source_revision),
    versionNumber: Number(row.version_number),
    workflowCode: row.workflow_code,
    workflowType: row.workflow_type,
    authorityLevel: row.authority_level,
    requirementKind: row.requirement_kind,
    dataClassification: row.data_classification,
    scope,
    title: String(snapshot.title || ""),
    archived: Boolean(row.archived_at),
    publishedAt: row.published_at,
    archivedAt: row.archived_at || null,
  });
}

function definitionScope(row) {
  return normalizedScope({
    type: row.scope_type,
    locationId: row.location_id,
    departmentId: row.department_id,
  });
}

function publicDefinition(row, publicationCount) {
  return Object.freeze({
    id: row.id,
    title: row.title,
    status: row.status,
    revision: Number(row.revision || 1),
    scope: definitionScope(row),
    publicationCount,
    hasPublications: publicationCount > 0,
    legacyClassificationRequired: row.status === "active" && publicationCount === 0,
    updatedAt: row.updated_at,
  });
}

function publicationAppliesTo(publication, target) {
  if (publication.scope.type === "company") return true;
  if (publication.scope.locationId !== target.locationId) return false;
  if (publication.scope.type === "location") return true;
  return publication.scope.departmentId === target.departmentId;
}

function conflictSummary(publications) {
  const grouped = new Map();
  const add = (kind, value, publication) => {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return;
    const key = `${kind}\0${normalized}`;
    const current = grouped.get(key) || [];
    current.push(publication);
    grouped.set(key, current);
  };
  for (const publication of publications) {
    add("code", publication.workflowCode, publication);
    add("title", publication.title, publication);
  }
  return Object.freeze([...grouped.entries()]
    .filter(([, values]) => new Set(values.map(({ processId }) => processId)).size > 1)
    .map(([key, values]) => Object.freeze({
      kind: key.split("\0")[0],
      value: key.split("\0")[1],
      publicationIds: Object.freeze(values.map(({ id }) => id).sort()),
    })));
}

function createPersonnelWorkflowPublicationService(repositoryValue, {
  clock = () => new Date(),
  createId = randomUUID,
} = {}) {
  const repository = assertCustomProcessManagementRepository(repositoryValue);

  async function publicationValues(currentRepository = repository, { includeArchived = true } = {}) {
    const rows = await currentRepository.listWorkflowPublications({
      includeArchived: includeArchived ? 1 : 0,
    });
    const values = rows.map(verifiedPublication);
    const workflowCodeByProcess = new Map();
    for (const value of values) {
      const expected = workflowCodeByProcess.get(value.row.process_id);
      if (expected && expected !== value.row.workflow_code) {
        throw workflowError(
          "Die veröffentlichte Workflow-Versionsfolge besitzt keinen stabilen Workflow-Code.",
          "PERSONNEL_WORKFLOW_PUBLICATION_INTEGRITY_FAILED",
          PERSONNEL_WORKFLOW_ERROR_KINDS.INTEGRITY,
        );
      }
      workflowCodeByProcess.set(value.row.process_id, value.row.workflow_code);
    }
    return values;
  }

  async function list({ includeArchived = false, access } = {}) {
    if (!access?.canRead) {
      throw workflowError(
        "Fuer das Workflow-Center fehlt das Leserecht.",
        "PERSONNEL_WORKFLOW_PERMISSION_REQUIRED",
        PERSONNEL_WORKFLOW_ERROR_KINDS.FORBIDDEN,
      );
    }
    const [rows, publications] = await Promise.all([
      repository.listProcesses({ includeArchived: includeArchived ? 1 : 0 }),
      publicationValues(repository, { includeArchived }),
    ]);
    const visiblePublications = publications
      .map(publicPublication)
      .filter((publication) => (
        access.global || access.canReadScope(publication.scope)
      ));
    const countByProcess = new Map();
    for (const publication of visiblePublications) {
      countByProcess.set(publication.processId, (countByProcess.get(publication.processId) || 0) + 1);
    }
    const definitions = rows
      .filter((row) => access.global || access.canReadScope(definitionScope(row)))
      .map((row) => publicDefinition(row, countByProcess.get(row.id) || 0));
    return Object.freeze({
      definitions: Object.freeze(definitions),
      publications: Object.freeze(visiblePublications),
    });
  }

  async function publish(processIdValue, inputValue, { access, actorId } = {}) {
    const processId = String(processIdValue || "").trim();
    const input = plainObject(inputValue, "Die Workflow-Veroeffentlichung");
    exactKeys(input, new Set([
      "workflowCode", "workflowType", "requirementKind",
      "dataClassification", "containsConfidentialSteps",
    ]), "Die Workflow-Veroeffentlichung");
    const workflowCode = normalizedWorkflowCode(input.workflowCode);
    const workflowType = String(input.workflowType || "").trim();
    const requirementKind = String(input.requirementKind || "").trim();
    if (!WORKFLOW_TYPE_SET.has(workflowType) || !REQUIREMENT_KIND_SET.has(requirementKind)) {
      throw workflowError(
        "Workflow-Typ oder Pflichtart ist ungueltig.",
        "PERSONNEL_WORKFLOW_INPUT_INVALID",
      );
    }
    if (input.dataClassification !== "standard"
      || input.containsConfidentialSteps !== false
      || workflowType === "offboarding") {
      throw workflowError(
        "Vertrauliche beziehungsweise Offboarding-Schritte bleiben bis zum eigenen Schutzvertrag gesperrt.",
        "PERSONNEL_WORKFLOW_CONFIDENTIAL_DEFERRED",
        PERSONNEL_WORKFLOW_ERROR_KINDS.CONFLICT,
      );
    }
    const actor = String(actorId || "").trim();
    if (!actor || !access?.canPublish) {
      throw workflowError(
        "Fuer die Workflow-Veroeffentlichung fehlt die fachliche Freigabe.",
        "PERSONNEL_WORKFLOW_PERMISSION_REQUIRED",
        PERSONNEL_WORKFLOW_ERROR_KINDS.FORBIDDEN,
      );
    }
    try {
      return await repository.transaction(async (transactionRepository) => {
        const process = await transactionRepository.processById({
          id: processId,
          includeArchived: 0,
        });
        if (!process) {
          throw workflowError(
            "Die Workflow-Vorlage wurde nicht gefunden.",
            "PERSONNEL_WORKFLOW_DEFINITION_NOT_FOUND",
            PERSONNEL_WORKFLOW_ERROR_KINDS.NOT_FOUND,
          );
        }
        const currentDefinitionScope = definitionScope(process);
        if (!access.global && !access.canReadScope(currentDefinitionScope)) {
          throw workflowError(
            "Die Workflow-Vorlage wurde nicht gefunden.",
            "PERSONNEL_WORKFLOW_DEFINITION_NOT_FOUND",
            PERSONNEL_WORKFLOW_ERROR_KINDS.NOT_FOUND,
          );
        }
        const sourceRevision = Number(process.revision || 0);
        const revision = await transactionRepository.processRevision({
          processId,
          revision: sourceRevision,
        });
        if (!revision) {
          throw workflowError(
            "Die aktuelle Entwurfsrevision ist nicht vollstaendig gespeichert.",
            "PERSONNEL_WORKFLOW_SNAPSHOT_INTEGRITY_FAILED",
            PERSONNEL_WORKFLOW_ERROR_KINDS.INTEGRITY,
          );
        }
        const snapshot = parseSnapshot(revision);
        const snapshotJson = String(revision.snapshot_json || "");
        if (Buffer.byteLength(snapshotJson, "utf8") > 1024 * 1024) {
          throw workflowError(
            "Die Workflow-Version ist fuer eine sichere Veroeffentlichung zu gross.",
            "PERSONNEL_WORKFLOW_SNAPSHOT_TOO_LARGE",
          );
        }
        const scope = normalizedScope(snapshot.scope || {});
        if (scope.type !== currentDefinitionScope.type
          || String(scope.locationId || "") !== String(currentDefinitionScope.locationId || "")
          || Number(scope.departmentId || 0) !== Number(currentDefinitionScope.departmentId || 0)) {
          throw workflowError(
            "Die aktuelle Entwurfsrevision besitzt einen widersprüchlichen Geltungsbereich.",
            "PERSONNEL_WORKFLOW_SNAPSHOT_INTEGRITY_FAILED",
            PERSONNEL_WORKFLOW_ERROR_KINDS.INTEGRITY,
          );
        }
        const activeScope = await transactionRepository.scopeIsActive(scope);
        if (!activeScope?.active) {
          throw workflowError(
            "Der Geltungsbereich der Workflow-Vorlage ist nicht mehr aktiv.",
            "PERSONNEL_WORKFLOW_SCOPE_INACTIVE",
            PERSONNEL_WORKFLOW_ERROR_KINDS.CONFLICT,
          );
        }
        if (requirementKind === "mandatory" && scope.type !== "company") {
          throw workflowError(
            "Ein Pflichtprozess muss unternehmensweit gelten.",
            "PERSONNEL_WORKFLOW_MANDATORY_SCOPE_INVALID",
          );
        }
        if (!access.canPublishScope(scope, requirementKind)) {
          throw workflowError(
            "Die Workflow-Vorlage liegt ausserhalb des freigegebenen Fachbereichs.",
            "PERSONNEL_WORKFLOW_SCOPE_DENIED",
            PERSONNEL_WORKFLOW_ERROR_KINDS.FORBIDDEN,
          );
        }
        const existing = await publicationValues(transactionRepository, { includeArchived: true });
        const processPublications = existing.filter(({ row }) => row.process_id === processId);
        if (processPublications.some(({ row }) => Number(row.source_revision) === sourceRevision)) {
          throw workflowError(
            "Diese Entwurfsrevision wurde bereits veroeffentlicht.",
            "PERSONNEL_WORKFLOW_REVISION_ALREADY_PUBLISHED",
            PERSONNEL_WORKFLOW_ERROR_KINDS.CONFLICT,
          );
        }
        if (processPublications.some(({ row }) => row.workflow_code !== workflowCode)) {
          throw workflowError(
            "Der stabile Workflow-Code darf zwischen Versionen nicht geaendert werden.",
            "PERSONNEL_WORKFLOW_CODE_CONFLICT",
            PERSONNEL_WORKFLOW_ERROR_KINDS.CONFLICT,
          );
        }
        const versionNumber = processPublications.length + 1;
        const publishedAt = clock().toISOString();
        const row = {
          id: `workflow-version-${createId()}`,
          process_id: processId,
          source_revision: sourceRevision,
          version_number: versionNumber,
          workflow_code: workflowCode,
          workflow_type: workflowType,
          authority_level: access.global ? "central" : "local",
          requirement_kind: requirementKind,
          data_classification: "standard",
          scope_type: scope.type,
          location_id: scope.locationId,
          department_id: scope.departmentId,
          snapshot_json: snapshotJson,
          snapshot_sha256: sha256(snapshotJson),
          published_by: actor,
          published_at: publishedAt,
        };
        row.receipt_sha256 = publicationRowReceipt(row);
        await transactionRepository.insertWorkflowPublication({
          id: row.id,
          processId,
          sourceRevision,
          versionNumber,
          workflowCode,
          workflowType,
          authorityLevel: row.authority_level,
          requirementKind,
          dataClassification: row.data_classification,
          scopeType: scope.type,
          locationId: scope.locationId,
          departmentId: scope.departmentId,
          snapshotJson,
          snapshotSha256: row.snapshot_sha256,
          receiptSha256: row.receipt_sha256,
          publishedBy: actor,
          publishedAt,
        });
        await transactionRepository.insertAudit({
          actor,
          action: "personnel-workflow.publish",
          entityType: "custom_process_publication",
          entityId: row.id,
          detail: JSON.stringify({
            processId,
            sourceRevision,
            versionNumber,
            workflowCode,
            workflowType,
            authorityLevel: row.authority_level,
            requirementKind,
            scopeType: scope.type,
          }),
        });
        return publicPublication(verifiedPublication({ ...row, archived_at: null }));
      }, { isolation: "serializable" });
    } catch (error) {
      if (error instanceof PersonnelWorkflowError) throw error;
      if (CONCURRENT_PERSISTENCE_ERROR_CODES.has(error?.code)) {
        throw workflowError(
          "Die Workflow-Veroeffentlichung wurde parallel geaendert. Bitte neu laden.",
          "PERSONNEL_WORKFLOW_CONCURRENT_CHANGE",
          PERSONNEL_WORKFLOW_ERROR_KINDS.CONFLICT,
        );
      }
      throw error;
    }
  }

  async function archive(publicationIdValue, inputValue, { access, actorId } = {}) {
    const publicationId = String(publicationIdValue || "").trim();
    const input = plainObject(inputValue, "Die Workflow-Archivierung");
    exactKeys(input, new Set(["reason"]), "Die Workflow-Archivierung");
    const reason = String(input.reason || "").replace(/\s+/g, " ").trim();
    if (reason.length < 3 || reason.length > 300) {
      throw workflowError(
        "Die Archivierung benoetigt eine Begruendung mit 3 bis 300 Zeichen.",
        "PERSONNEL_WORKFLOW_ARCHIVE_REASON_INVALID",
      );
    }
    const actor = String(actorId || "").trim();
    if (!actor || !access?.canPublish) {
      throw workflowError(
        "Fuer die Workflow-Archivierung fehlt die fachliche Freigabe.",
        "PERSONNEL_WORKFLOW_PERMISSION_REQUIRED",
        PERSONNEL_WORKFLOW_ERROR_KINDS.FORBIDDEN,
      );
    }
    try {
      return await repository.transaction(async (transactionRepository) => {
        const current = (await publicationValues(transactionRepository, { includeArchived: true }))
          .find(({ row }) => row.id === publicationId);
        if (!current || (!access.global && !access.canReadScope(current.scope))) {
          throw workflowError(
            "Die Workflow-Version wurde nicht gefunden.",
            "PERSONNEL_WORKFLOW_PUBLICATION_NOT_FOUND",
            PERSONNEL_WORKFLOW_ERROR_KINDS.NOT_FOUND,
          );
        }
        const publication = publicPublication(current);
        if (!access.canArchivePublication(publication)) {
          throw workflowError(
            "Diese Workflow-Version darf im aktuellen Fachbereich nicht archiviert werden.",
            "PERSONNEL_WORKFLOW_SCOPE_DENIED",
            PERSONNEL_WORKFLOW_ERROR_KINDS.FORBIDDEN,
          );
        }
        if (publication.archived) return publication;
        const archivedAt = clock().toISOString();
        await transactionRepository.insertWorkflowPublicationArchive({
          publicationId,
          reason,
          archivedBy: actor,
          archivedAt,
        });
        await transactionRepository.insertAudit({
          actor,
          action: "personnel-workflow.archive",
          entityType: "custom_process_publication",
          entityId: publicationId,
          detail: JSON.stringify({
            processId: publication.processId,
            versionNumber: publication.versionNumber,
            requirementKind: publication.requirementKind,
            scopeType: publication.scope.type,
            reasonSha256: sha256(reason),
          }),
        });
        return Object.freeze({ ...publication, archived: true, archivedAt });
      }, { isolation: "serializable" });
    } catch (error) {
      if (error instanceof PersonnelWorkflowError) throw error;
      if (CONCURRENT_PERSISTENCE_ERROR_CODES.has(error?.code)) {
        throw workflowError(
          "Die Workflow-Archivierung wurde parallel geändert. Bitte neu laden.",
          "PERSONNEL_WORKFLOW_CONCURRENT_CHANGE",
          PERSONNEL_WORKFLOW_ERROR_KINDS.CONFLICT,
        );
      }
      throw error;
    }
  }

  async function resolve(targetValue, { access } = {}) {
    if (!access?.canRead) {
      throw workflowError(
        "Fuer die Workflow-Aufloesung fehlt das Leserecht.",
        "PERSONNEL_WORKFLOW_PERMISSION_REQUIRED",
        PERSONNEL_WORKFLOW_ERROR_KINDS.FORBIDDEN,
      );
    }
    const target = normalizedScope(targetValue);
    if (target.type === "company" || (!access.global && !access.canReadScope(target))) {
      throw workflowError(
        "Der angeforderte Workflow-Bereich ist nicht freigegeben.",
        "PERSONNEL_WORKFLOW_SCOPE_DENIED",
        PERSONNEL_WORKFLOW_ERROR_KINDS.FORBIDDEN,
      );
    }
    const activeScope = await repository.scopeIsActive(target);
    if (!activeScope?.active) {
      throw workflowError(
        "Der angeforderte Workflow-Bereich ist nicht mehr aktiv.",
        "PERSONNEL_WORKFLOW_SCOPE_INACTIVE",
        PERSONNEL_WORKFLOW_ERROR_KINDS.CONFLICT,
      );
    }
    const publications = (await publicationValues(repository, { includeArchived: false }))
      .map(publicPublication)
      .filter((publication) => publicationAppliesTo(publication, target));
    return Object.freeze({
      scope: target,
      publications: Object.freeze(publications),
      conflicts: conflictSummary(publications),
    });
  }

  return Object.freeze({ archive, list, publish, resolve });
}

module.exports = {
  PERSONNEL_WORKFLOW_ERROR_KINDS,
  PERSONNEL_WORKFLOW_TYPES,
  PersonnelWorkflowError,
  createPersonnelWorkflowPublicationService,
  verifyPersonnelWorkflowPublication: verifiedPublication,
};

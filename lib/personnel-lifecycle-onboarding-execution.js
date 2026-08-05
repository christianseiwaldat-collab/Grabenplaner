"use strict";

const { randomUUID: cryptoRandomUUID } = require("node:crypto");
const {
  assertCustomProcessManagementRepository,
} = require("./persistence/repositories/custom-process-management");
const {
  PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES,
  PERSONNEL_LIFECYCLE_O2_REQUIRED_ONBOARDING_PACKAGE_FAMILIES,
} = require("./personnel-lifecycle-case-foundation");
const {
  PERSONNEL_LIFECYCLE_O3_BLOCKER_CODES,
  createPersonnelLifecycleOnboardingProfilePreview,
} = require("./personnel-lifecycle-onboarding-preview");
const {
  canonicalJson,
  canonicalSha256,
  deterministicUuidV4,
  personnelLifecycleAssignmentBindingReceiptBody,
  personnelLifecycleOnboardingOperationReceiptBody,
  personnelLifecyclePackageRunReceiptBody,
  previewSha256,
  sha256,
} = require("./personnel-lifecycle-onboarding-receipt");

const PERSONNEL_LIFECYCLE_O4_CONTRACT_VERSION = "o4-v0.1";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PACKAGES = 30;
const MAX_ASSIGNMENTS = 900;
const REQUIRED_CONFIRMATIONS = Object.freeze([
  "responsibility",
  "packages",
  "lifecycleReviews",
  "assignments",
  "atomicStart",
]);

const PERSONNEL_LIFECYCLE_ONBOARDING_EXECUTION_ERROR_KINDS = Object.freeze({
  INPUT: "input",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  INTEGRITY: "integrity",
});

const REQUIRED_REPOSITORY_METHODS = Object.freeze([
  "currentEpisodeOnboardingCaseForEmployee",
  "employmentEpisodeForEmployee",
  "insertEmploymentEpisode",
  "insertLifecycleAssignment",
  "insertLifecycleAssignmentBinding",
  "insertLifecycleCase",
  "insertLifecycleCaseEvent",
  "insertLifecyclePackageBinding",
  "insertLifecyclePackageRun",
  "insertLifecycleReferenceDates",
  "insertOnboardingOperation",
  "lifecycleCaseLastEvent",
  "listLifecycleAssignments",
  "listLifecyclePackageRuns",
  "onboardingCaseById",
  "onboardingOperationById",
  "transitionLifecycleCase",
]);

class PersonnelLifecycleOnboardingExecutionError extends Error {
  constructor(message, code, kind = PERSONNEL_LIFECYCLE_ONBOARDING_EXECUTION_ERROR_KINDS.INPUT) {
    super(message);
    this.name = "PersonnelLifecycleOnboardingExecutionError";
    this.code = code;
    this.kind = kind;
  }
}

function executionError(message, code, kind) {
  return new PersonnelLifecycleOnboardingExecutionError(message, code, kind);
}

function inputError(message, code = "PERSONNEL_LIFECYCLE_ONBOARDING_INPUT_INVALID") {
  return executionError(
    message,
    code,
    PERSONNEL_LIFECYCLE_ONBOARDING_EXECUTION_ERROR_KINDS.INPUT,
  );
}

function conflictError(message, code) {
  return executionError(
    message,
    code,
    PERSONNEL_LIFECYCLE_ONBOARDING_EXECUTION_ERROR_KINDS.CONFLICT,
  );
}

function integrityError(message = "Der Onboarding-Fall besitzt keinen gueltigen Integritaetsbeleg.") {
  return executionError(
    message,
    "PERSONNEL_LIFECYCLE_ONBOARDING_INTEGRITY_FAILED",
    PERSONNEL_LIFECYCLE_ONBOARDING_EXECUTION_ERROR_KINDS.INTEGRITY,
  );
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw inputError(`${label} ist ungueltig.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw inputError(`${label} enthaelt unbekannte Felder.`);
  }
}

function text(value, label, maximum = 120) {
  if (typeof value !== "string") throw inputError(`${label} ist ungueltig.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\0\r\n]/.test(normalized)) {
    throw inputError(`${label} ist ungueltig.`);
  }
  return normalized;
}

function uuid(value, label = "Die Operations-ID") {
  const normalized = text(value, label, 36).toLowerCase();
  if (!UUID_V4.test(normalized)) {
    throw inputError(`${label} muss eine UUIDv4 sein.`, "PERSONNEL_LIFECYCLE_ONBOARDING_OPERATION_ID_INVALID");
  }
  return normalized;
}

function sha256Value(value, label) {
  const normalized = text(value, label, 64).toLowerCase();
  if (!SHA256.test(normalized)) throw inputError(`${label} ist ungueltig.`);
  return normalized;
}

function isoDate(value, label) {
  const normalized = text(value, label, 10);
  if (!ISO_DATE.test(normalized)) throw inputError(`${label} ist ungueltig.`);
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw inputError(`${label} ist ungueltig.`);
  }
  return normalized;
}

function normalizedReferenceDates(value) {
  const dates = plainObject(value, "Die Onboarding-Referenztermine");
  exactKeys(
    dates,
    ["contractualEntryDate", "firstWorkingDay", "onboardingTargetDate"],
    "Die Onboarding-Referenztermine",
  );
  const normalized = Object.freeze({
    contractualEntryDate: isoDate(dates.contractualEntryDate, "Das vertragliche Eintrittsdatum"),
    firstWorkingDay: isoDate(dates.firstWorkingDay, "Der erste Arbeitstag"),
    onboardingTargetDate: isoDate(dates.onboardingTargetDate, "Das Onboarding-Zieldatum"),
  });
  if (normalized.contractualEntryDate > normalized.firstWorkingDay
    || normalized.firstWorkingDay > normalized.onboardingTargetDate) {
    throw inputError(
      "Die Onboarding-Referenztermine muessen in zeitlicher Reihenfolge liegen.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_REFERENCE_DATES_INVALID",
    );
  }
  return normalized;
}

function normalizedConfirmations(value) {
  const confirmations = plainObject(value, "Die Onboarding-Bestaetigungen");
  exactKeys(confirmations, REQUIRED_CONFIRMATIONS, "Die Onboarding-Bestaetigungen");
  if (REQUIRED_CONFIRMATIONS.some((name) => confirmations[name] !== true)) {
    throw inputError(
      "Alle Onboarding-Bestaetigungen muessen ausdruecklich erteilt werden.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_CONFIRMATION_REQUIRED",
    );
  }
  return Object.freeze(Object.fromEntries(REQUIRED_CONFIRMATIONS.map((name) => [name, true])));
}

function normalizedAssignments(value, packageIndex) {
  if (!Array.isArray(value) || value.length > 30) {
    throw inputError(`Die Zuweisungen des Pakets ${packageIndex + 1} sind ungueltig.`);
  }
  const seen = new Set();
  const assignments = value.map((entry, index) => {
    const assignment = plainObject(entry, `Die Zuweisung ${index + 1}`);
    exactKeys(
      assignment,
      ["stepReference", "assigneeActorId"],
      `Die Zuweisung ${index + 1}`,
    );
    const normalized = Object.freeze({
      stepReference: text(assignment.stepReference, "Der Schrittbezug", 120),
      assigneeActorId: text(assignment.assigneeActorId, "Die zugewiesene Person", 120),
    });
    if (seen.has(normalized.stepReference)) {
      throw inputError("Ein Paketschritt darf nur einmal zugewiesen werden.");
    }
    seen.add(normalized.stepReference);
    return normalized;
  });
  return Object.freeze(assignments.sort((left, right) => (
    left.stepReference.localeCompare(right.stepReference)
  )));
}

function normalizedFamilyCodes(value, packageIndex) {
  if (!Array.isArray(value) || value.length > 2) {
    throw inputError(`Die Pflichtfamilien des Pakets ${packageIndex + 1} sind ungueltig.`);
  }
  const allowed = new Set(PERSONNEL_LIFECYCLE_O2_REQUIRED_ONBOARDING_PACKAGE_FAMILIES);
  const values = value.map((entry) => text(entry, "Die Pflichtfamilie", 80));
  if (new Set(values).size !== values.length || values.some((entry) => !allowed.has(entry))) {
    throw inputError(`Die Pflichtfamilien des Pakets ${packageIndex + 1} sind ungueltig.`);
  }
  return Object.freeze(values.sort());
}

function normalizedPackageBindings(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PACKAGES) {
    throw inputError("Die Onboarding-Paketbindungen sind ungueltig.");
  }
  const seen = new Set();
  let assignmentCount = 0;
  const packages = value.map((entry, index) => {
    const binding = plainObject(entry, `Die Paketbindung ${index + 1}`);
    exactKeys(
      binding,
      ["publicationId", "versionNumber", "familyCodes", "reviewConfirmed", "assignments"],
      `Die Paketbindung ${index + 1}`,
    );
    if (!Number.isSafeInteger(binding.versionNumber) || binding.versionNumber < 1) {
      throw inputError(`Die Paketversion ${index + 1} ist ungueltig.`);
    }
    if (binding.reviewConfirmed !== true) {
      throw inputError(
        "Jede Paketversion muss unter dem Lifecycle-Vertrag neu geprueft werden.",
        "PERSONNEL_LIFECYCLE_ONBOARDING_REVIEW_REQUIRED",
      );
    }
    const normalized = Object.freeze({
      publicationId: text(binding.publicationId, "Die Publikations-ID", 120),
      versionNumber: binding.versionNumber,
      familyCodes: normalizedFamilyCodes(binding.familyCodes, index),
      reviewConfirmed: true,
      assignments: normalizedAssignments(binding.assignments, index),
    });
    if (seen.has(normalized.publicationId)) {
      throw inputError("Jede Onboarding-Publikation darf nur einmal gebunden werden.");
    }
    seen.add(normalized.publicationId);
    assignmentCount += normalized.assignments.length;
    return normalized;
  });
  if (assignmentCount > MAX_ASSIGNMENTS) {
    throw inputError("Der Onboarding-Auftrag enthaelt zu viele Zuweisungen.");
  }
  return Object.freeze(packages.sort((left, right) => (
    left.publicationId.localeCompare(right.publicationId)
  )));
}

function normalizedStartInput(value) {
  const input = plainObject(value, "Der Onboarding-Start");
  exactKeys(input, [
    "operationId",
    "employeeNumber",
    "expectedPreviewSha256",
    "responsibleActorId",
    "confirmation",
    "confirmations",
    "referenceDates",
    "packageBindings",
  ], "Der Onboarding-Start");
  if (input.confirmation !== "START_ONBOARDING") {
    throw inputError(
      "Der Onboarding-Start wurde nicht eindeutig bestaetigt.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_CONFIRMATION_REQUIRED",
    );
  }
  return Object.freeze({
    operationId: uuid(input.operationId),
    employeeNumber: text(input.employeeNumber, "Die Personalnummer", 80),
    expectedPreviewSha256: sha256Value(input.expectedPreviewSha256, "Der Vorschaubeleg"),
    responsibleActorId: text(input.responsibleActorId, "Die fallverantwortliche Person", 120),
    confirmation: "START_ONBOARDING",
    confirmations: normalizedConfirmations(input.confirmations),
    referenceDates: normalizedReferenceDates(input.referenceDates),
    packageBindings: normalizedPackageBindings(input.packageBindings),
  });
}

function requestSha256(input) {
  return canonicalSha256({ schemaVersion: 1, contractVersion: PERSONNEL_LIFECYCLE_O4_CONTRACT_VERSION, ...input });
}

function normalizedNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Die O4-Zeitquelle ist ungueltig.");
  return date.toISOString();
}

function generatedUuid(randomUUID, label) {
  const value = String(randomUUID() || "").trim().toLowerCase();
  if (!UUID_V4.test(value)) throw new TypeError(`Die O4-UUID-Quelle ist fuer ${label} ungueltig.`);
  return value;
}

function resultRowsAffected(result, label) {
  if (Number(result?.rowsAffected || 0) !== 1) throw integrityError(`${label} wurde nicht eindeutig gespeichert.`);
}

function eventReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: row.id,
    caseId: row.caseId,
    sequenceNumber: row.sequenceNumber,
    eventType: row.eventType,
    dataClassification: row.dataClassification,
    protectedPayloadSha256: sha256(row.protectedPayload),
    previousReceiptSha256: row.previousReceiptSha256,
    actorId: row.actorId ?? row.actor,
    occurredAt: row.occurredAt,
  };
}

function lifecycleProtectionContext(namespace, recordId, employeeNumber) {
  return { namespace, recordId, field: "payload", employeeNumber };
}

function familyResolution(input) {
  const assignments = new Map();
  for (const binding of input.packageBindings) {
    for (const familyCode of binding.familyCodes) {
      if (assignments.has(familyCode)) {
        throw inputError(
          "Jede Pflichtfamilie muss genau einer Paketversion zugeordnet werden.",
          "PERSONNEL_LIFECYCLE_ONBOARDING_FAMILY_MAPPING_INVALID",
        );
      }
      assignments.set(familyCode, binding.publicationId);
    }
  }
  const required = PERSONNEL_LIFECYCLE_O2_REQUIRED_ONBOARDING_PACKAGE_FAMILIES;
  if (assignments.size !== required.length || required.some((family) => !assignments.has(family))) {
    throw inputError(
      "Beide Pflichtfamilien muessen eindeutig zugeordnet werden.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_FAMILY_MAPPING_REQUIRED",
    );
  }
  if (new Set(assignments.values()).size !== required.length) {
    throw inputError(
      "Die beiden Pflichtfamilien muessen konservativ zwei getrennten Pflichtpaketen zugeordnet werden.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_FAMILY_MAPPING_INVALID",
    );
  }
  return Object.freeze(Object.fromEntries([...assignments.entries()].sort()));
}

function hardPreviewBlockers(preview) {
  const resolvable = new Set([
    PERSONNEL_LIFECYCLE_O3_BLOCKER_CODES.EXECUTION_DEFERRED,
    PERSONNEL_LIFECYCLE_O3_BLOCKER_CODES.ASSIGNMENT_SELECTION_REQUIRED,
    PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.M4_PUBLICATION_REVIEW_REQUIRED,
    PERSONNEL_LIFECYCLE_O2_BLOCKER_CODES.REQUIRED_PACKAGE_FAMILY_UNMAPPED,
  ]);
  return (preview.blockers || []).filter(({ code }) => !resolvable.has(code));
}

function validateExactResolution(input, preview) {
  const familyMapping = familyResolution(input);
  if ((preview.blockers || []).some(({ code }) => (
    code === PERSONNEL_LIFECYCLE_O3_BLOCKER_CODES.NOTIFICATIONS_DEFERRED
  ))) {
    throw conflictError(
      "Workflow-Benachrichtigungen bleiben im kontrollierten Onboarding gesperrt.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_NOTIFICATIONS_DEFERRED",
    );
  }
  if (hardPreviewBlockers(preview).length || preview.packageResolution.conflicts.length) {
    throw conflictError(
      "Die aktuelle Onboarding-Aufloesung enthaelt einen nicht aufloesbaren Blocker.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_RESOLUTION_BLOCKED",
    );
  }
  const expectedPackages = [...preview.packageResolution.packages]
    .sort((left, right) => left.publicationId.localeCompare(right.publicationId));
  if (expectedPackages.length !== input.packageBindings.length
    || expectedPackages.some((entry, index) => (
      entry.publicationId !== input.packageBindings[index].publicationId
      || entry.versionNumber !== input.packageBindings[index].versionNumber
    ))) {
    throw conflictError(
      "Die Paketauflösung hat sich geaendert. Bitte die Vorschau neu pruefen.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_PREVIEW_STALE",
    );
  }
  const resolved = [];
  for (const [index, packagePreview] of expectedPackages.entries()) {
    const binding = input.packageBindings[index];
    if (binding.reviewConfirmed !== true || packagePreview.reviewStatus !== "requires_new_lifecycle_review") {
      throw integrityError("Der Lifecycle-Pruefstatus einer Paketversion ist widerspruechlich.");
    }
    if (binding.familyCodes.length) {
      if (packagePreview.scope.type !== "company"
        || packagePreview.requirementKind !== "mandatory"
        || packagePreview.authorityLevel !== "central") {
        throw conflictError(
          "Eine Pflichtfamilie darf nur einer zentralen unternehmensweiten Pflichtversion zugeordnet werden.",
          "PERSONNEL_LIFECYCLE_ONBOARDING_FAMILY_PACKAGE_INVALID",
        );
      }
    }
    const nonSystem = packagePreview.assignments.filter(({ responsibility }) => (
      responsibility.type !== "system"
    ));
    if (nonSystem.length !== binding.assignments.length) {
      throw conflictError(
        "Alle nicht-systemischen Paketschritte muessen einzeln zugewiesen werden.",
        "PERSONNEL_LIFECYCLE_ONBOARDING_ASSIGNMENT_REQUIRED",
      );
    }
    const assignments = [];
    for (const step of packagePreview.assignments) {
      const selected = binding.assignments.find(({ stepReference }) => (
        stepReference === step.stepReference
      ));
      if (step.responsibility.type === "system") {
        if (selected) throw inputError("Ein Systemschritt darf keiner Person zugewiesen werden.");
        continue;
      }
      if (!selected || !step.eligibleRecipients.some(({ actorId }) => (
        actorId === selected.assigneeActorId
      ))) {
        throw conflictError(
          "Eine Aufgabenzuweisung ist nicht mehr aktuell verfuegbar.",
          "PERSONNEL_LIFECYCLE_ONBOARDING_ASSIGNMENT_STALE",
        );
      }
      assignments.push(Object.freeze({
        step,
        stepReference: step.stepReference,
        assigneeActorId: selected.assigneeActorId,
      }));
    }
    resolved.push(Object.freeze({ binding, preview: packagePreview, assignments }));
  }
  return Object.freeze({ familyMapping, packages: Object.freeze(resolved) });
}

function assertStartAccess(access, actorId, responsibleActorId) {
  if (!access || access.actorId !== actorId || responsibleActorId !== actorId
    || access.namedActor !== true || access.central !== true
    || access.canReadOnboarding !== true
    || access.canPrepareOnboarding !== true
    || access.canApproveOnboarding !== true
    || access.canExecuteOnboarding !== true
    || access.canReadPackages !== true
    || access.canWritePackages !== true
    || access.canPublishPackages !== true
    || access.canWriteAssignments !== true) {
    throw executionError(
      "Fuer den kontrollierten Onboarding-Start fehlen getrennte Fachrechte.",
      "PERSONNEL_LIFECYCLE_ONBOARDING_PERMISSION_REQUIRED",
      PERSONNEL_LIFECYCLE_ONBOARDING_EXECUTION_ERROR_KINDS.FORBIDDEN,
    );
  }
}

function createPersonnelLifecycleOnboardingExecutionService(repositoryValue, {
  instantiatePersonnelLifecycleOnboardingInTransaction,
  canAssignRecipient = async () => false,
  protectJson,
  parseProtectedJson,
  now = () => new Date(),
  randomUUID = cryptoRandomUUID,
} = {}) {
  const repository = assertCustomProcessManagementRepository(repositoryValue);
  const missing = REQUIRED_REPOSITORY_METHODS.filter((name) => typeof repository[name] !== "function");
  if (missing.length) throw new TypeError(`Dem O4-Repository fehlen Methoden: ${missing.join(", ")}.`);
  if (typeof instantiatePersonnelLifecycleOnboardingInTransaction !== "function"
    || typeof canAssignRecipient !== "function"
    || typeof protectJson !== "function"
    || typeof parseProtectedJson !== "function"
    || typeof now !== "function"
    || typeof randomUUID !== "function") {
    throw new TypeError("Fuer O4 fehlen sichere Laufzeitfunktionen.");
  }

  function protect(value, namespace, recordId, employeeNumber) {
    const result = protectJson(value, lifecycleProtectionContext(namespace, recordId, employeeNumber));
    if (typeof result !== "string" || !result.startsWith("enc:v2:")) {
      throw integrityError("Ein O4-Fachbeleg konnte nicht sicher geschuetzt werden.");
    }
    return result;
  }

  function parse(value, namespace, recordId, employeeNumber) {
    try {
      return plainObject(
        parseProtectedJson(value, lifecycleProtectionContext(namespace, recordId, employeeNumber)),
        "Der geschuetzte O4-Beleg",
      );
    } catch {
      throw integrityError("Ein geschuetzter O4-Fachbeleg konnte nicht sicher gelesen werden.");
    }
  }

  async function replay(currentRepository, existing, input, hash, actorId) {
    const operationId = existing.operation_id || existing.operationId;
    const caseId = existing.case_id || existing.caseId;
    const storedActor = existing.actor_id || existing.actorId;
    const requestHash = existing.request_sha256 || existing.requestSha256;
    const resultPayload = existing.result_payload || existing.resultPayload;
    const receiptHash = existing.result_receipt_sha256 || existing.resultReceiptSha256;
    const row = {
      operation_id: operationId,
      case_id: caseId,
      request_sha256: requestHash,
      preview_sha256: existing.preview_sha256 || existing.previewSha256,
      result_payload: resultPayload,
      actor_id: storedActor,
      occurred_at: existing.occurred_at || existing.occurredAt,
    };
    if (sha256(JSON.stringify(personnelLifecycleOnboardingOperationReceiptBody(row)))
      !== receiptHash) throw integrityError();
    if (storedActor !== actorId || requestHash !== hash) {
      throw conflictError(
        "Die Operations-ID wurde bereits fuer einen anderen Onboarding-Auftrag verwendet.",
        "PERSONNEL_LIFECYCLE_ONBOARDING_OPERATION_CONFLICT",
      );
    }
    let result;
    try {
      result = plainObject(
        typeof resultPayload === "string" ? JSON.parse(resultPayload) : resultPayload,
        "Der O4-Ergebnisbeleg",
      );
    } catch { throw integrityError(); }
    if (result.caseId !== caseId
      || result.employeeNumber !== input.employeeNumber || result.state !== "active") {
      throw integrityError();
    }
    const currentCase = await currentRepository.onboardingCaseById({ caseId });
    if (!currentCase || (currentCase.id || currentCase.case_id) !== caseId) throw integrityError();
    return Object.freeze({ ...result, replayed: true });
  }

  async function start(inputValue, { access, actorId: actorIdValue } = {}) {
    const input = normalizedStartInput(inputValue);
    const actorId = text(actorIdValue, "Die handelnde Person", 120);
    assertStartAccess(access, actorId, input.responsibleActorId);
    const hash = requestSha256(input);
    try {
      return await repository.transaction(async (currentRepository) => {
        const existing = await currentRepository.onboardingOperationById({
          operationId: input.operationId,
        });
        if (existing) return replay(currentRepository, existing, input, hash, actorId);

        const [subject, publications, recipients] = await Promise.all([
          currentRepository.personnelWorkflowEmployeeSubject({
            employeeNumber: input.employeeNumber,
          }),
          currentRepository.listWorkflowPublications({ includeArchived: 1 }),
          currentRepository.listRecipientCandidates(),
        ]);
        const preview = await createPersonnelLifecycleOnboardingProfilePreview({
          subject,
          publications,
          recipients,
          canPreviewRecipient: ({ scope, recipient, step, publication }) => canAssignRecipient({
            scope,
            recipient,
            step,
            publication,
            repository: currentRepository,
          }),
        });
        const currentPreviewSha256 = previewSha256(preview);
        if (currentPreviewSha256 !== input.expectedPreviewSha256) {
          throw conflictError(
            "Die Onboarding-Vorschau hat sich geaendert. Bitte neu laden und erneut pruefen.",
            "PERSONNEL_LIFECYCLE_ONBOARDING_PREVIEW_STALE",
          );
        }
        const resolution = validateExactResolution(input, preview);
        for (const packageValue of resolution.packages) {
          for (const assignment of packageValue.assignments) {
            const recipient = recipients.find(({ employee_number: employeeNumber }) => (
              employeeNumber === assignment.assigneeActorId
            ));
            if (!recipient || await canAssignRecipient({
              scope: preview.scope,
              recipient,
              step: assignment.step,
              publication: packageValue.preview,
              repository: currentRepository,
            }) !== true) {
              throw conflictError(
                "Eine Aufgabenzuweisung ist nicht mehr aktuell verfuegbar.",
                "PERSONNEL_LIFECYCLE_ONBOARDING_ASSIGNMENT_STALE",
              );
            }
          }
        }

        const activeCase = await currentRepository.currentEpisodeOnboardingCaseForEmployee({
          employeeNumber: input.employeeNumber,
        });
        if (activeCase) {
          throw conflictError(
            "Fuer diese Beschaeftigung besteht bereits ein offener Onboarding-Fall.",
            "PERSONNEL_LIFECYCLE_ONBOARDING_CASE_EXISTS",
          );
        }

        const startedAt = normalizedNow(now);
        let episode = await currentRepository.employmentEpisodeForEmployee({
          employeeNumber: input.employeeNumber,
        });
        if (episode && (episode.state || episode.episode_state) === "exit_in_progress") {
          throw conflictError(
            "Die aktuelle Beschaeftigung befindet sich bereits im Austrittsprozess.",
            "PERSONNEL_LIFECYCLE_ONBOARDING_EPISODE_CONFLICT",
          );
        }
        if (!episode || (episode.state || episode.episode_state) === "employment_ended") {
          const episodeId = generatedUuid(randomUUID, "die Beschaeftigungsepisode");
          const predecessorEpisodeId = episode?.id || episode?.episode_id || null;
          const sequenceNumber = Number(episode?.sequence_number || episode?.sequenceNumber || 0) + 1;
          const protectedPayload = protect({
            schemaVersion: 1,
            source: "controlled_onboarding_start",
            employeeNumber: input.employeeNumber,
          }, "personnel-employment-episode", episodeId, input.employeeNumber);
          resultRowsAffected(await currentRepository.insertEmploymentEpisode({
            id: episodeId,
            employeeNumber: input.employeeNumber,
            sequenceNumber,
            predecessorEpisodeId,
            protectedPayload,
            actor: actorId,
            occurredAt: startedAt,
          }), "Die Beschaeftigungsepisode");
          episode = { id: episodeId, state: "employment_active", sequence_number: sequenceNumber };
        }
        if ((episode.state || episode.episode_state) !== "employment_active") throw integrityError();
        const episodeId = episode.id || episode.episode_id;
        const caseId = generatedUuid(randomUUID, "den Onboarding-Fall");
        const scopeSha256 = canonicalSha256(preview.scope);
        const caseProtectedPayload = protect({
          schemaVersion: 1,
          operationId: input.operationId,
          requestSha256: hash,
          previewSha256: currentPreviewSha256,
          confirmations: input.confirmations,
          familyMapping: resolution.familyMapping,
        }, "personnel-lifecycle-case", caseId, input.employeeNumber);
        resultRowsAffected(await currentRepository.insertLifecycleCase({
          id: caseId,
          caseType: "onboarding",
          employmentEpisodeId: episodeId,
          predecessorCaseId: null,
          state: "prepared",
          responsibleActorId: actorId,
          scopeType: preview.scope.type,
          locationId: preview.scope.locationId,
          departmentId: preview.scope.departmentId,
          scopeSnapshotSha256: scopeSha256,
          protectedPayload: caseProtectedPayload,
          actor: actorId,
          occurredAt: startedAt,
        }), "Der Onboarding-Fall");

        let eventSequence = 0;
        let previousEventReceipt = "";
        const appendEvent = async (eventType, payload) => {
          eventSequence += 1;
          const id = generatedUuid(randomUUID, "das Onboarding-Ereignis");
          const protectedPayload = protect(payload, "personnel-lifecycle-case-event", id, input.employeeNumber);
          const body = {
            id,
            caseId,
            sequenceNumber: eventSequence,
            eventType,
            dataClassification: "personal_restricted",
            protectedPayload,
            previousReceiptSha256: previousEventReceipt,
            actor: actorId,
            occurredAt: startedAt,
          };
          const receiptSha256 = canonicalSha256(eventReceiptBody(body));
          resultRowsAffected(await currentRepository.insertLifecycleCaseEvent({
            ...body,
            receiptSha256,
          }), "Das Onboarding-Ereignis");
          previousEventReceipt = receiptSha256;
        };
        await appendEvent("onboarding_prepared", {
          schemaVersion: 1,
          operationId: input.operationId,
          previewSha256: currentPreviewSha256,
        });

        const referenceId = generatedUuid(randomUUID, "die Referenztermine");
        const referencePayload = protect({
          schemaVersion: 1,
          ...input.referenceDates,
        }, "personnel-lifecycle-reference-dates", referenceId, input.employeeNumber);
        resultRowsAffected(await currentRepository.insertLifecycleReferenceDates({
          id: referenceId,
          caseId,
          revision: 1,
          previousRevisionId: null,
          protectedPayload: referencePayload,
          receiptSha256: canonicalSha256({
            schemaVersion: 1,
            id: referenceId,
            caseId,
            revision: 1,
            protectedPayloadSha256: sha256(referencePayload),
            changedBy: actorId,
            changedAt: startedAt,
          }),
          actor: actorId,
          occurredAt: startedAt,
        }), "Die Onboarding-Referenztermine");
        resultRowsAffected(await currentRepository.transitionLifecycleCase({
          caseId,
          caseType: "onboarding",
          fromState: "prepared",
          toState: "approved",
          expectedRevision: 1,
          actor: actorId,
          occurredAt: startedAt,
        }), "Die Onboarding-Freigabe");
        await appendEvent("onboarding_approved", {
          schemaVersion: 1,
          operationId: input.operationId,
          packageCount: resolution.packages.length,
          assignmentCount: resolution.packages.reduce((sum, entry) => sum + entry.assignments.length, 0),
          familyMapping: resolution.familyMapping,
        });

        const startedPackages = [];
        for (const packageValue of resolution.packages) {
          const packageBindingId = generatedUuid(randomUUID, "die Paketbindung");
          const runOperationId = deterministicUuidV4(
            "personnel-lifecycle-onboarding-run",
            input.operationId,
            packageValue.preview.publicationId,
          );
          const familyCodesJson = canonicalJson(packageValue.binding.familyCodes);
          const lifecycleReviewSha256 = canonicalSha256({
            schemaVersion: 1,
            publicationId: packageValue.preview.publicationId,
            versionNumber: packageValue.preview.versionNumber,
            sourceRevision: packageValue.preview.sourceRevision,
            previewSha256: currentPreviewSha256,
            familyCodes: packageValue.binding.familyCodes,
            reviewedBy: actorId,
            reviewedAt: startedAt,
          });
          let linkedRunId = null;
          const workflowResult = await instantiatePersonnelLifecycleOnboardingInTransaction(currentRepository, {
            operationId: runOperationId,
            publicationId: packageValue.preview.publicationId,
            subject: { type: "employee", employeeNumber: input.employeeNumber },
            assignments: packageValue.assignments.map((assignment) => ({
              stepId: assignment.stepReference,
              employeeNumber: assignment.assigneeActorId,
            })),
          }, {
            actorId,
            now: () => new Date(startedAt),
            randomUUID,
            access: {
              actorId,
              canStartScope: async () => true,
              canStartEmployeeSubject: async () => true,
              canStartCandidateSubject: async () => false,
              canAssignPersonnelWorkflowStep: async ({ recipient, step, scope, publication }) => (
                canAssignRecipient({
                  scope,
                  recipient,
                  step,
                  publication,
                  repository: currentRepository,
                })
              ),
            },
            bindLifecyclePackageRun: async ({ runId, runOperationId: boundOperationId, startedAt: boundAt }) => {
              if (boundOperationId !== runOperationId || boundAt !== startedAt) throw integrityError();
              linkedRunId = runId;
              const bindingReceiptSha256 = canonicalSha256({
                schemaVersion: 1,
                id: packageBindingId,
                caseId,
                publicationId: packageValue.preview.publicationId,
                versionNumber: packageValue.preview.versionNumber,
                scopeSnapshotSha256: scopeSha256,
                boundBy: actorId,
                boundAt: startedAt,
              });
              resultRowsAffected(await currentRepository.insertLifecyclePackageBinding({
                id: packageBindingId,
                caseId,
                publicationId: packageValue.preview.publicationId,
                versionNumber: packageValue.preview.versionNumber,
                scopeSnapshotSha256: scopeSha256,
                receiptSha256: bindingReceiptSha256,
                actor: actorId,
                occurredAt: startedAt,
              }), "Die Lifecycle-Paketbindung");
              const runRow = {
                package_binding_id: packageBindingId,
                run_id: runId,
                run_operation_id: runOperationId,
                family_codes_json: familyCodesJson,
                lifecycle_review_sha256: lifecycleReviewSha256,
                scope_snapshot_sha256: scopeSha256,
                linked_by: actorId,
                linked_at: startedAt,
              };
              const receiptSha256 = sha256(JSON.stringify(
                personnelLifecyclePackageRunReceiptBody(runRow),
              ));
              resultRowsAffected(await currentRepository.insertLifecyclePackageRun({
                packageBindingId,
                runId,
                runOperationId,
                familyCodesJson,
                lifecycleReviewSha256,
                scopeSnapshotSha256: scopeSha256,
                actor: actorId,
                occurredAt: startedAt,
                receiptSha256,
              }), "Die Lifecycle-Instanzbindung");
            },
          });
          const runId = workflowResult?.instance?.id || workflowResult?.runId || linkedRunId;
          if (!runId || runId !== linkedRunId) throw integrityError("Die M5-Instanzbindung ist widerspruechlich.");
          for (const assignment of packageValue.assignments) {
            const assignmentId = generatedUuid(randomUUID, "die Lifecycle-Zuweisung");
            const assignmentReceiptSha256 = canonicalSha256({
              schemaVersion: 1,
              id: assignmentId,
              caseId,
              packageBindingId,
              runId,
              stepReference: assignment.stepReference,
              assigneeActorId: assignment.assigneeActorId,
              assignedBy: actorId,
              assignedAt: startedAt,
            });
            resultRowsAffected(await currentRepository.insertLifecycleAssignment({
              id: assignmentId,
              caseId,
              stepReference: assignment.stepReference,
              assigneeActorId: assignment.assigneeActorId,
              predecessorAssignmentId: null,
              receiptSha256: assignmentReceiptSha256,
              actor: actorId,
              occurredAt: startedAt,
            }), "Die Lifecycle-Zuweisung");
            const bindingRow = {
              assignment_id: assignmentId,
              package_binding_id: packageBindingId,
              run_id: runId,
              step_reference: assignment.stepReference,
              linked_by: actorId,
              linked_at: startedAt,
              bound_by: actorId,
              bound_at: startedAt,
            };
            resultRowsAffected(await currentRepository.insertLifecycleAssignmentBinding({
              assignmentId,
              packageBindingId,
              runId,
              stepReference: assignment.stepReference,
              actor: actorId,
              occurredAt: startedAt,
              receiptSha256: sha256(JSON.stringify(
                personnelLifecycleAssignmentBindingReceiptBody(bindingRow),
              )),
            }), "Die Lifecycle-Zuweisungsbindung");
          }
          startedPackages.push(Object.freeze({
            publicationId: packageValue.preview.publicationId,
            versionNumber: packageValue.preview.versionNumber,
            packageBindingId,
            runId,
            familyCodes: packageValue.binding.familyCodes,
            assignmentCount: packageValue.assignments.length,
          }));
        }

        resultRowsAffected(await currentRepository.transitionLifecycleCase({
          caseId,
          caseType: "onboarding",
          fromState: "approved",
          toState: "active",
          expectedRevision: 2,
          actor: actorId,
          occurredAt: startedAt,
        }), "Die Onboarding-Aktivierung");
        await appendEvent("onboarding_started", {
          schemaVersion: 1,
          operationId: input.operationId,
          requestSha256: hash,
          previewSha256: currentPreviewSha256,
          packageRunIds: startedPackages.map(({ runId }) => runId).sort(),
        });

        const result = Object.freeze({
          contractVersion: PERSONNEL_LIFECYCLE_O4_CONTRACT_VERSION,
          caseId,
          employmentEpisodeId: episodeId,
          employeeNumber: input.employeeNumber,
          state: "active",
          startedAt,
          packageCount: startedPackages.length,
          assignmentCount: startedPackages.reduce((sum, entry) => sum + entry.assignmentCount, 0),
          packages: Object.freeze(startedPackages),
          replayed: false,
        });
        const resultPayload = JSON.stringify(result);
        const operationRow = {
          operation_id: input.operationId,
          case_id: caseId,
          request_sha256: hash,
          preview_sha256: currentPreviewSha256,
          result_payload: resultPayload,
          actor_id: actorId,
          occurred_at: startedAt,
        };
        resultRowsAffected(await currentRepository.insertOnboardingOperation({
          operationId: input.operationId,
          caseId,
          requestSha256: hash,
          previewSha256: currentPreviewSha256,
          resultPayload,
          resultReceiptSha256: sha256(JSON.stringify(
            personnelLifecycleOnboardingOperationReceiptBody(operationRow),
          )),
          actor: actorId,
          occurredAt: startedAt,
        }), "Der Onboarding-Operationsbeleg");
        resultRowsAffected(await currentRepository.insertAudit({
          actor: actorId,
          action: "personnel-lifecycle.onboarding.start",
          entityType: "personnel_lifecycle_case",
          entityId: caseId,
          detail: JSON.stringify({
            operationId: input.operationId,
            packageCount: result.packageCount,
            assignmentCount: result.assignmentCount,
            scopeType: preview.scope.type,
          }),
        }), "Der Onboarding-Startaudit");

        const [storedCase, storedRuns, storedAssignments] = await Promise.all([
          currentRepository.onboardingCaseById({ caseId }),
          currentRepository.listLifecyclePackageRuns({ caseId }),
          currentRepository.listLifecycleAssignments({ caseId }),
        ]);
        if (!storedCase || (storedCase.state || storedCase.case_state) !== "active"
          || storedRuns.length !== result.packageCount
          || storedAssignments.length !== result.assignmentCount) {
          throw integrityError("Der vollstaendige Onboarding-Start konnte nicht eindeutig gelesen werden.");
        }
        return result;
      }, { isolation: "serializable" });
    } catch (error) {
      if (error instanceof PersonnelLifecycleOnboardingExecutionError) throw error;
      if ([
        "PERSISTENCE_UNIQUE_VIOLATION",
        "PERSISTENCE_BUSY",
        "PERSISTENCE_RETRYABLE_TRANSACTION",
      ].includes(error?.code)) {
        throw conflictError(
          "Der Onboarding-Fall wurde parallel geaendert. Bitte neu laden.",
          "PERSONNEL_LIFECYCLE_ONBOARDING_CONCURRENT_CHANGE",
        );
      }
      throw error;
    }
  }

  return Object.freeze({ start });
}

module.exports = {
  PERSONNEL_LIFECYCLE_O4_CONTRACT_VERSION,
  PERSONNEL_LIFECYCLE_ONBOARDING_EXECUTION_ERROR_KINDS,
  PersonnelLifecycleOnboardingExecutionError,
  createPersonnelLifecycleOnboardingExecutionService,
  normalizedStartInput,
  requestSha256,
};

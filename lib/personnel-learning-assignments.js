"use strict";

const { createHash } = require("node:crypto");
const {
  PersonnelLearningCatalogError,
  stableJsonStringify,
} = require("./personnel-learning-catalog");

const PERSONNEL_LEARNING_ASSIGNMENT_CHANGE_TYPES = Object.freeze([
  "assigned",
  "trainers_updated",
  "cancelled",
  "restored",
]);
const PERSONNEL_LEARNING_ASSIGNMENT_MAX_TRAINER_BINDINGS = 12;

function invalid(code, message) {
  throw new PersonnelLearningCatalogError(code, message);
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function requiredText(value, label, max = 180) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max || normalized.includes("\0")) {
    invalid("PERSONNEL_LEARNING_ASSIGNMENT_INVALID", `${label} ist ungültig.`);
  }
  return normalized;
}

function assignmentReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: String(row.id || ""),
    processModuleId: String(row.processModuleId ?? row.process_module_id ?? ""),
    learnerEmployeeNumber: String(
      row.learnerEmployeeNumber ?? row.learner_employee_number ?? "",
    ),
    createdBy: String(row.createdBy ?? row.created_by ?? ""),
    createdAt: String(row.createdAt ?? row.created_at ?? ""),
  };
}

function assignmentReceiptSha256(row) {
  return sha256(stableJsonStringify(assignmentReceiptBody(row)));
}

function normalizedTrainerBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(
      "PERSONNEL_LEARNING_ASSIGNMENT_TRAINERS_INVALID",
      "Eine Trainerzuweisung ist ungültig.",
    );
  }
  const competencyRevisionNumber = Number(value.competencyRevisionNumber);
  const skillVersionNumber = Number(value.skillVersionNumber);
  const competencyLevel = Number(value.competencyLevel);
  const competencyRevisionReceipt = String(
    value.competencyRevisionReceipt || "",
  ).trim().toLowerCase();
  if (!Number.isSafeInteger(competencyRevisionNumber)
    || competencyRevisionNumber < 1
    || !Number.isSafeInteger(skillVersionNumber)
    || skillVersionNumber < 1
    || !Number.isSafeInteger(competencyLevel)
    || competencyLevel < 1
    || competencyLevel > 10
    || !/^[a-f0-9]{64}$/.test(competencyRevisionReceipt)) {
    invalid(
      "PERSONNEL_LEARNING_ASSIGNMENT_TRAINERS_INVALID",
      "Eine Trainerzuweisung besitzt keinen gültigen Kompetenzbeleg.",
    );
  }
  return Object.freeze({
    competencyId: requiredText(value.competencyId, "Das Kompetenzprofil"),
    competencyRevisionNumber,
    competencyRevisionReceipt,
    trainerEmployeeNumber: requiredText(
      value.trainerEmployeeNumber,
      "Die Trainerperson",
      80,
    ),
    skillModuleId: requiredText(value.skillModuleId, "Die Trainerfähigkeit"),
    skillVersionNumber,
    competencyLevel,
  });
}

function normalizePersonnelLearningTrainerBindings(value) {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > PERSONNEL_LEARNING_ASSIGNMENT_MAX_TRAINER_BINDINGS) {
    invalid(
      "PERSONNEL_LEARNING_ASSIGNMENT_TRAINERS_INVALID",
      `Bitte zwischen einer und ${PERSONNEL_LEARNING_ASSIGNMENT_MAX_TRAINER_BINDINGS} Trainerfähigkeiten auswählen.`,
    );
  }
  const competencyIds = new Set();
  const normalized = value.map((entry) => {
    const binding = normalizedTrainerBinding(entry);
    if (competencyIds.has(binding.competencyId)) {
      invalid(
        "PERSONNEL_LEARNING_ASSIGNMENT_TRAINERS_INVALID",
        "Eine Trainerfähigkeit darf nur einmal zugewiesen werden.",
      );
    }
    competencyIds.add(binding.competencyId);
    return binding;
  }).sort((left, right) => (
    left.trainerEmployeeNumber.localeCompare(
      right.trainerEmployeeNumber,
      "de-AT",
      { numeric: true },
    )
    || left.skillModuleId.localeCompare(right.skillModuleId, "de-AT")
    || left.competencyId.localeCompare(right.competencyId, "de-AT")
  ));
  return Object.freeze(normalized);
}

function trainerBindingsSha256(bindings) {
  return sha256(stableJsonStringify(
    normalizePersonnelLearningTrainerBindings(bindings),
  ));
}

function normalizedPersonnelLearningAssignmentMutation(value, { current = null } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(
      "PERSONNEL_LEARNING_ASSIGNMENT_INVALID",
      "Bitte eine gültige Schulungszuweisung übermitteln.",
    );
  }
  const active = value.active !== false;
  const source = active
    ? value.trainerCompetencyIds
    : (value.trainerCompetencyIds ?? current?.trainerCompetencyIds ?? []);
  if (!Array.isArray(source)
    || source.length < 1
    || source.length > PERSONNEL_LEARNING_ASSIGNMENT_MAX_TRAINER_BINDINGS) {
    invalid(
      "PERSONNEL_LEARNING_ASSIGNMENT_TRAINERS_INVALID",
      `Bitte zwischen einer und ${PERSONNEL_LEARNING_ASSIGNMENT_MAX_TRAINER_BINDINGS} Trainerfähigkeiten auswählen.`,
    );
  }
  const seen = new Set();
  const trainerCompetencyIds = source.map((entry) => requiredText(
    entry,
    "Das Trainer-Kompetenzprofil",
  )).filter((entry) => {
    if (seen.has(entry)) {
      invalid(
        "PERSONNEL_LEARNING_ASSIGNMENT_TRAINERS_INVALID",
        "Eine Trainerfähigkeit darf nur einmal zugewiesen werden.",
      );
    }
    seen.add(entry);
    return true;
  }).sort((left, right) => left.localeCompare(right, "de-AT"));
  return Object.freeze({ active, trainerCompetencyIds: Object.freeze(trainerCompetencyIds) });
}

function assignmentRevisionReceiptBody(row) {
  const rawBindings = row.trainerBindings ?? row.trainer_bindings_json;
  const bindings = typeof rawBindings === "string"
    ? JSON.parse(rawBindings)
    : rawBindings;
  return {
    schemaVersion: 1,
    assignmentId: String(row.assignmentId ?? row.assignment_id ?? ""),
    revisionNumber: Number(row.revisionNumber ?? row.revision_number ?? 0),
    processModuleId: String(row.processModuleId ?? row.process_module_id ?? ""),
    processVersionNumber: Number(
      row.processVersionNumber ?? row.process_version_number ?? 0,
    ),
    active: Boolean(row.active),
    trainerBindings: normalizePersonnelLearningTrainerBindings(bindings),
    trainerBindingsSha256: String(
      row.trainerBindingsSha256 ?? row.trainer_bindings_sha256 ?? "",
    ),
    changeType: String(row.changeType ?? row.change_type ?? ""),
    previousReceiptSha256: String(
      row.previousReceiptSha256 ?? row.previous_receipt_sha256 ?? "",
    ),
    changedBy: String(row.changedBy ?? row.changed_by ?? ""),
    changedAt: String(row.changedAt ?? row.changed_at ?? ""),
  };
}

function assignmentRevisionReceiptSha256(row) {
  return sha256(stableJsonStringify(assignmentRevisionReceiptBody(row)));
}

function parsedTrainerBindings(value) {
  try {
    return normalizePersonnelLearningTrainerBindings(
      typeof value === "string" ? JSON.parse(value) : value,
    );
  } catch (error) {
    if (error instanceof PersonnelLearningCatalogError) throw error;
    invalid(
      "PERSONNEL_LEARNING_ASSIGNMENT_HISTORY_INVALID",
      "Die Trainerhistorie der Schulungszuweisung ist unvollständig.",
    );
  }
}

function buildPersonnelLearningAssignmentState({ assignment, revisions } = {}) {
  if (!assignment || !Array.isArray(revisions) || !revisions.length) {
    invalid(
      "PERSONNEL_LEARNING_ASSIGNMENT_HISTORY_INVALID",
      "Die Schulungszuweisung besitzt keine vollständige Revisionshistorie.",
    );
  }
  const ordered = [...revisions].sort((left, right) => (
    Number(left.revisionNumber ?? left.revision_number)
      - Number(right.revisionNumber ?? right.revision_number)
  ));
  const normalizedRevisions = [];
  let previousReceipt = "";
  let previousActive = false;
  for (let index = 0; index < ordered.length; index += 1) {
    const revision = ordered[index];
    const revisionNumber = Number(
      revision.revisionNumber ?? revision.revision_number,
    );
    const active = Boolean(revision.active);
    const changeType = String(revision.changeType ?? revision.change_type ?? "");
    const bindings = parsedTrainerBindings(
      revision.trainerBindings ?? revision.trainer_bindings_json,
    );
    const bindingsHash = String(
      revision.trainerBindingsSha256 ?? revision.trainer_bindings_sha256 ?? "",
    );
    const receipt = String(
      revision.receiptSha256 ?? revision.receipt_sha256 ?? "",
    );
    if (revisionNumber !== index + 1
      || String(revision.assignmentId ?? revision.assignment_id ?? "")
        !== String(assignment.id || "")
      || String(revision.processModuleId ?? revision.process_module_id ?? "")
        !== String(assignment.processModuleId ?? assignment.process_module_id ?? "")
      || String(revision.previousReceiptSha256
        ?? revision.previous_receipt_sha256 ?? "") !== previousReceipt
      || bindingsHash !== trainerBindingsSha256(bindings)
      || receipt !== assignmentRevisionReceiptSha256(revision)
      || !PERSONNEL_LEARNING_ASSIGNMENT_CHANGE_TYPES.includes(changeType)
      || (index === 0 && (changeType !== "assigned" || !active))
      || (index > 0 && changeType === "assigned")
      || (changeType === "trainers_updated" && (!previousActive || !active))
      || (changeType === "cancelled" && (!previousActive || active))
      || (changeType === "restored" && (previousActive || !active))) {
      invalid(
        "PERSONNEL_LEARNING_ASSIGNMENT_HISTORY_INVALID",
        "Die Schulungszuweisung enthält einen widersprüchlichen Revisionsverlauf.",
      );
    }
    normalizedRevisions.push(Object.freeze({ ...revision, trainerBindings: bindings }));
    previousReceipt = receipt;
    previousActive = active;
  }
  const current = normalizedRevisions.at(-1);
  return Object.freeze({
    current,
    currentReceipt: String(current.receiptSha256 ?? current.receipt_sha256 ?? ""),
    revisionNumber: Number(current.revisionNumber ?? current.revision_number),
    active: Boolean(current.active),
    trainerBindings: parsedTrainerBindings(
      current.trainerBindings ?? current.trainer_bindings_json,
    ),
    revisions: Object.freeze(normalizedRevisions),
  });
}

module.exports = {
  PERSONNEL_LEARNING_ASSIGNMENT_CHANGE_TYPES,
  PERSONNEL_LEARNING_ASSIGNMENT_MAX_TRAINER_BINDINGS,
  assignmentReceiptBody,
  assignmentReceiptSha256,
  assignmentRevisionReceiptBody,
  assignmentRevisionReceiptSha256,
  buildPersonnelLearningAssignmentState,
  normalizePersonnelLearningAssignmentMutation:
    normalizedPersonnelLearningAssignmentMutation,
  normalizePersonnelLearningTrainerBindings,
  trainerBindingsSha256,
};

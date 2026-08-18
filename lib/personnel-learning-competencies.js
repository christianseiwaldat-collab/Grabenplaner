"use strict";

const { createHash } = require("node:crypto");
const {
  PersonnelLearningCatalogError,
  stableJsonStringify,
} = require("./personnel-learning-catalog");
const {
  isPersonnelLearningSkillContent,
} = require("./personnel-learning-skills");

const PERSONNEL_LEARNING_COMPETENCY_CHANGE_TYPES = Object.freeze([
  "assigned",
  "updated",
  "withdrawn",
  "restored",
]);

function invalid(code, message) {
  throw new PersonnelLearningCatalogError(code, message);
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function competencyReceiptBody(row) {
  return {
    schemaVersion: 1,
    id: String(row.id || ""),
    employeeNumber: String(row.employeeNumber ?? row.employee_number ?? ""),
    skillModuleId: String(row.skillModuleId ?? row.skill_module_id ?? ""),
    createdBy: String(row.createdBy ?? row.created_by ?? ""),
    createdAt: String(row.createdAt ?? row.created_at ?? ""),
  };
}

function competencyReceiptSha256(row) {
  return sha256(stableJsonStringify(competencyReceiptBody(row)));
}

function competencyRevisionReceiptBody(row) {
  return {
    schemaVersion: 1,
    competencyId: String(row.competencyId ?? row.competency_id ?? ""),
    revisionNumber: Number(row.revisionNumber ?? row.revision_number ?? 0),
    skillModuleId: String(row.skillModuleId ?? row.skill_module_id ?? ""),
    skillVersionNumber: Number(
      row.skillVersionNumber ?? row.skill_version_number ?? 0,
    ),
    competencyLevel: Number(row.competencyLevel ?? row.competency_level ?? 0),
    trainerAuthorized: Boolean(
      row.trainerAuthorized ?? row.trainer_authorized,
    ),
    active: Boolean(row.active),
    changeType: String(row.changeType ?? row.change_type ?? ""),
    previousReceiptSha256: String(
      row.previousReceiptSha256 ?? row.previous_receipt_sha256 ?? "",
    ),
    changedBy: String(row.changedBy ?? row.changed_by ?? ""),
    changedAt: String(row.changedAt ?? row.changed_at ?? ""),
  };
}

function competencyRevisionReceiptSha256(row) {
  return sha256(stableJsonStringify(competencyRevisionReceiptBody(row)));
}

function normalizedCompetencyMutation(value, { current = null } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(
      "PERSONNEL_LEARNING_COMPETENCY_INVALID",
      "Bitte einen gültigen Kompetenzstand übermitteln.",
    );
  }
  const active = value.active !== false;
  const fallbackLevel = Number(
    current?.competencyLevel ?? current?.competency_level ?? 0,
  );
  const competencyLevel = value.level === undefined && !active
    ? fallbackLevel
    : Number(value.level);
  if (!Number.isSafeInteger(competencyLevel)
    || competencyLevel < 1 || competencyLevel > 10) {
    invalid(
      "PERSONNEL_LEARNING_COMPETENCY_LEVEL_INVALID",
      "Bitte eine gültige Fähigkeitsstufe zwischen 1 und 10 auswählen.",
    );
  }
  if (active && typeof value.trainerAuthorized !== "boolean") {
    invalid(
      "PERSONNEL_LEARNING_TRAINER_AUTHORIZATION_INVALID",
      "Bitte den Status der Trainerfreigabe ausdrücklich festlegen.",
    );
  }
  return Object.freeze({
    active,
    competencyLevel,
    trainerAuthorized: active ? value.trainerAuthorized === true : false,
  });
}

function levelDefinitionForSkillVersion(version, level) {
  const content = version?.content;
  if (!isPersonnelLearningSkillContent(content)
    || !Array.isArray(content.levelDefinitions)
    || content.levelDefinitions.length !== 10) {
    invalid(
      "PERSONNEL_LEARNING_SKILL_VERSION_INVALID",
      "Die veröffentlichte Fähigkeitsversion enthält keine vollständige Stufendefinition.",
    );
  }
  const definition = content.levelDefinitions[Number(level) - 1];
  if (!definition || Number(definition.level) !== Number(level)) {
    invalid(
      "PERSONNEL_LEARNING_COMPETENCY_LEVEL_INVALID",
      "Die ausgewählte Stufe ist in der veröffentlichten Fähigkeitsversion nicht definiert.",
    );
  }
  return Object.freeze({
    level: Number(definition.level),
    label: String(definition.label || ""),
    description: String(definition.description || ""),
  });
}

function buildPersonnelLearningCompetencyState({ competency, revisions } = {}) {
  if (!competency || !Array.isArray(revisions) || !revisions.length) {
    invalid(
      "PERSONNEL_LEARNING_COMPETENCY_HISTORY_INVALID",
      "Die Kompetenzhistorie ist unvollständig.",
    );
  }
  const ordered = [...revisions].sort((left, right) => (
    Number(left.revisionNumber ?? left.revision_number)
      - Number(right.revisionNumber ?? right.revision_number)
  ));
  let previousReceipt = "";
  let previousActive = false;
  for (let index = 0; index < ordered.length; index += 1) {
    const revision = ordered[index];
    const revisionNumber = Number(
      revision.revisionNumber ?? revision.revision_number,
    );
    const active = Boolean(revision.active);
    const changeType = String(revision.changeType ?? revision.change_type ?? "");
    if (revisionNumber !== index + 1
      || String(revision.competencyId ?? revision.competency_id ?? "")
        !== String(competency.id || "")
      || String(revision.skillModuleId ?? revision.skill_module_id ?? "")
        !== String(competency.skillModuleId ?? competency.skill_module_id ?? "")
      || String(revision.previousReceiptSha256
        ?? revision.previous_receipt_sha256 ?? "") !== previousReceipt
      || !PERSONNEL_LEARNING_COMPETENCY_CHANGE_TYPES.includes(changeType)
      || (index === 0 && (changeType !== "assigned" || !active))
      || (index > 0 && changeType === "assigned")
      || (changeType === "updated" && (!previousActive || !active))
      || (changeType === "withdrawn" && (!previousActive || active))
      || (changeType === "restored" && (previousActive || !active))
      || (!active && Boolean(
        revision.trainerAuthorized ?? revision.trainer_authorized,
      ))) {
      invalid(
        "PERSONNEL_LEARNING_COMPETENCY_HISTORY_INVALID",
        "Die Kompetenzhistorie enthält einen widersprüchlichen Revisionsverlauf.",
      );
    }
    previousReceipt = String(
      revision.receiptSha256 ?? revision.receipt_sha256 ?? "",
    );
    previousActive = active;
  }
  const current = ordered.at(-1);
  return Object.freeze({
    current,
    currentReceipt: String(
      current.receiptSha256 ?? current.receipt_sha256 ?? "",
    ),
    revisionNumber: Number(
      current.revisionNumber ?? current.revision_number,
    ),
    active: Boolean(current.active),
    trainerAuthorized: Boolean(
      current.trainerAuthorized ?? current.trainer_authorized,
    ),
    competencyLevel: Number(
      current.competencyLevel ?? current.competency_level,
    ),
    revisions: Object.freeze(ordered),
  });
}

module.exports = {
  PERSONNEL_LEARNING_COMPETENCY_CHANGE_TYPES,
  buildPersonnelLearningCompetencyState,
  competencyReceiptBody,
  competencyReceiptSha256,
  competencyRevisionReceiptBody,
  competencyRevisionReceiptSha256,
  levelDefinitionForSkillVersion,
  normalizedCompetencyMutation,
};

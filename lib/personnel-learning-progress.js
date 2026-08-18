"use strict";

const { createHash } = require("node:crypto");
const {
  PersonnelLearningCatalogError,
  stableJsonStringify,
} = require("./personnel-learning-catalog");

const PERSONNEL_LEARNING_PROGRESS_CHANGE_TYPES = Object.freeze([
  "progress_recorded",
  "completed",
  "corrected",
]);
const PERSONNEL_LEARNING_PROGRESS_RESULTS = Object.freeze([
  "pending",
  "passed",
  "follow_up_required",
  "not_passed",
]);
const PERSONNEL_LEARNING_PROGRESS_ACTOR_KINDS = Object.freeze([
  "learner",
  "trainer",
  "leadership",
  "branch_account",
]);
const PERSONNEL_LEARNING_PROGRESS_MAX_NOTE_LENGTH = 600;

function invalid(code, message) {
  throw new PersonnelLearningCatalogError(code, message);
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function boundedText(value, label, { required = false } = {}) {
  const normalized = String(value ?? "").trim();
  if ((required && !normalized)
    || normalized.length > PERSONNEL_LEARNING_PROGRESS_MAX_NOTE_LENGTH
    || normalized.includes("\0")) {
    invalid("PERSONNEL_LEARNING_PROGRESS_INVALID", `${label} ist ungültig.`);
  }
  return normalized;
}

function normalizedProcessSteps(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40) {
    invalid(
      "PERSONNEL_LEARNING_PROGRESS_PROCESS_INVALID",
      "Die gebundene Prozessversion enthält keine gültigen Schritte.",
    );
  }
  const stepIds = new Set();
  return Object.freeze(value.map((step) => {
    const stepId = String(step?.stepId || "").trim();
    if (!stepId || stepId.length > 120 || stepId.includes("\0") || stepIds.has(stepId)) {
      invalid(
        "PERSONNEL_LEARNING_PROGRESS_PROCESS_INVALID",
        "Die gebundene Prozessversion enthält widersprüchliche Schrittkennungen.",
      );
    }
    stepIds.add(stepId);
    return Object.freeze({
      stepId,
      required: step?.required !== false,
    });
  }));
}

function normalizePersonnelLearningProgressStepStates(value, processSteps) {
  const steps = normalizedProcessSteps(processSteps);
  if (!Array.isArray(value) || value.length !== steps.length) {
    invalid(
      "PERSONNEL_LEARNING_PROGRESS_STEPS_INVALID",
      "Der Fortschritt muss alle Schritte der gebundenen Prozessversion enthalten.",
    );
  }
  const byId = new Map();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalid(
        "PERSONNEL_LEARNING_PROGRESS_STEPS_INVALID",
        "Ein Prozessschritt besitzt keinen gültigen Fortschrittswert.",
      );
    }
    const stepId = String(entry.stepId || "").trim();
    if (!stepId || byId.has(stepId) || typeof entry.completed !== "boolean") {
      invalid(
        "PERSONNEL_LEARNING_PROGRESS_STEPS_INVALID",
        "Die Prozessschritte sind unvollständig oder doppelt vorhanden.",
      );
    }
    byId.set(stepId, Boolean(entry.completed));
  }
  return Object.freeze(steps.map(({ stepId }) => {
    if (!byId.has(stepId)) {
      invalid(
        "PERSONNEL_LEARNING_PROGRESS_STEPS_INVALID",
        "Der Fortschritt passt nicht zur gebundenen Prozessversion.",
      );
    }
    return Object.freeze({ stepId, completed: byId.get(stepId) });
  }));
}

function personnelLearningProgressStepStatesFromCompletedIds(value, processSteps) {
  const steps = normalizedProcessSteps(processSteps);
  if (!Array.isArray(value)) {
    invalid(
      "PERSONNEL_LEARNING_PROGRESS_STEPS_INVALID",
      "Bitte die erledigten Prozessschritte als Liste übermitteln.",
    );
  }
  const known = new Set(steps.map(({ stepId }) => stepId));
  const completed = new Set();
  for (const entry of value) {
    const stepId = String(entry || "").trim();
    if (!known.has(stepId) || completed.has(stepId)) {
      invalid(
        "PERSONNEL_LEARNING_PROGRESS_STEPS_INVALID",
        "Die erledigten Prozessschritte passen nicht zur gebundenen Prozessversion.",
      );
    }
    completed.add(stepId);
  }
  return Object.freeze(steps.map(({ stepId }) => Object.freeze({
    stepId,
    completed: completed.has(stepId),
  })));
}

function progressCounts(stepStates, processSteps) {
  const steps = normalizedProcessSteps(processSteps);
  const states = normalizePersonnelLearningProgressStepStates(stepStates, steps);
  let completedStepCount = 0;
  let requiredStepCount = 0;
  let requiredCompletedCount = 0;
  for (let index = 0; index < steps.length; index += 1) {
    if (states[index].completed) completedStepCount += 1;
    if (steps[index].required) {
      requiredStepCount += 1;
      if (states[index].completed) requiredCompletedCount += 1;
    }
  }
  return Object.freeze({
    totalStepCount: steps.length,
    completedStepCount,
    requiredStepCount,
    requiredCompletedCount,
  });
}

function progressPercent(counts) {
  return counts.totalStepCount > 0
    ? Math.round((counts.completedStepCount / counts.totalStepCount) * 100)
    : 0;
}

function progressStepStatesSha256(stepStates, processSteps) {
  return sha256(stableJsonStringify(
    normalizePersonnelLearningProgressStepStates(stepStates, processSteps),
  ));
}

function normalizePersonnelLearningProgressMutation(value, {
  processSteps,
  current = null,
  allowMissingCorrectionReason = false,
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(
      "PERSONNEL_LEARNING_PROGRESS_INVALID",
      "Bitte einen gültigen Schulungsfortschritt übermitteln.",
    );
  }
  const stepStates = personnelLearningProgressStepStatesFromCompletedIds(
    value.completedStepIds,
    processSteps,
  );
  const counts = progressCounts(stepStates, processSteps);
  const finalized = value.finalized === true;
  const result = String(value.result || "pending").trim();
  if (!PERSONNEL_LEARNING_PROGRESS_RESULTS.includes(result)
    || (!finalized && result !== "pending")
    || (finalized && result === "pending")) {
    invalid(
      "PERSONNEL_LEARNING_PROGRESS_RESULT_INVALID",
      "Bitte ein gültiges Abschlussergebnis auswählen.",
    );
  }
  if (finalized && counts.requiredCompletedCount !== counts.requiredStepCount) {
    invalid(
      "PERSONNEL_LEARNING_PROGRESS_REQUIRED_STEPS_INCOMPLETE",
      "Der Prozess kann erst abgeschlossen werden, wenn alle Pflichtschritte erledigt sind.",
    );
  }
  const assessmentNote = boundedText(value.assessmentNote, "Die Abschlussnotiz");
  if (!finalized && assessmentNote) {
    invalid(
      "PERSONNEL_LEARNING_PROGRESS_RESULT_INVALID",
      "Eine Abschlussnotiz ist erst bei einer Abschlussbewertung zulässig.",
    );
  }
  const correction = Boolean(current?.hasFinalizedRevision ?? current?.finalized);
  const correctionReason = boundedText(
    value.correctionReason,
    "Die Korrekturbegründung",
    { required: correction && !allowMissingCorrectionReason },
  );
  if (!correction && correctionReason) {
    invalid(
      "PERSONNEL_LEARNING_PROGRESS_INVALID",
      "Eine Korrekturbegründung ist nur nach einem Abschluss erforderlich.",
    );
  }
  const changeType = correction
    ? "corrected"
    : finalized ? "completed" : "progress_recorded";
  return Object.freeze({
    stepStates,
    ...counts,
    progressPercent: progressPercent(counts),
    finalized,
    result,
    assessmentNote,
    correctionReason,
    changeType,
  });
}

function progressRevisionReceiptBody(row, processSteps) {
  const rawStates = row.stepStates ?? row.step_states_json;
  const stepStates = normalizePersonnelLearningProgressStepStates(
    typeof rawStates === "string" ? JSON.parse(rawStates) : rawStates,
    processSteps,
  );
  return {
    schemaVersion: 1,
    assignmentId: String(row.assignmentId ?? row.assignment_id ?? ""),
    revisionNumber: Number(row.revisionNumber ?? row.revision_number ?? 0),
    assignmentRevisionReceiptSha256: String(
      row.assignmentRevisionReceiptSha256
        ?? row.assignment_revision_receipt_sha256
        ?? "",
    ),
    processModuleId: String(row.processModuleId ?? row.process_module_id ?? ""),
    processVersionNumber: Number(
      row.processVersionNumber ?? row.process_version_number ?? 0,
    ),
    stepStates,
    stepStatesSha256: String(row.stepStatesSha256 ?? row.step_states_sha256 ?? ""),
    totalStepCount: Number(row.totalStepCount ?? row.total_step_count ?? 0),
    completedStepCount: Number(row.completedStepCount ?? row.completed_step_count ?? 0),
    requiredStepCount: Number(row.requiredStepCount ?? row.required_step_count ?? 0),
    requiredCompletedCount: Number(
      row.requiredCompletedCount ?? row.required_completed_count ?? 0,
    ),
    finalized: Boolean(row.finalized),
    result: String(row.result || ""),
    assessmentNote: String(row.assessmentNote ?? row.assessment_note ?? ""),
    changeType: String(row.changeType ?? row.change_type ?? ""),
    correctionReason: String(row.correctionReason ?? row.correction_reason ?? ""),
    previousReceiptSha256: String(
      row.previousReceiptSha256 ?? row.previous_receipt_sha256 ?? "",
    ),
    actorKind: String(row.actorKind ?? row.actor_kind ?? ""),
    changedBy: String(row.changedBy ?? row.changed_by ?? ""),
    changedAt: String(row.changedAt ?? row.changed_at ?? ""),
  };
}

function personnelLearningProgressRevisionReceiptSha256(row, processSteps) {
  return sha256(stableJsonStringify(progressRevisionReceiptBody(row, processSteps)));
}

function buildPersonnelLearningProgressState({ revisions, processSteps } = {}) {
  const steps = normalizedProcessSteps(processSteps);
  if (!Array.isArray(revisions)) {
    invalid(
      "PERSONNEL_LEARNING_PROGRESS_HISTORY_INVALID",
      "Die Fortschrittshistorie ist ungültig.",
    );
  }
  if (!revisions.length) {
    const counts = progressCounts(
      steps.map(({ stepId }) => ({ stepId, completed: false })),
      steps,
    );
    return Object.freeze({
      current: null,
      currentReceipt: "",
      revisionNumber: 0,
      finalized: false,
      hasFinalizedRevision: false,
      result: "pending",
      stepStates: Object.freeze(steps.map(({ stepId }) => Object.freeze({
        stepId,
        completed: false,
      }))),
      ...counts,
      progressPercent: 0,
      revisions: Object.freeze([]),
    });
  }
  const ordered = [...revisions].sort((left, right) => (
    Number(left.revisionNumber ?? left.revision_number)
      - Number(right.revisionNumber ?? right.revision_number)
  ));
  let previousReceipt = "";
  let hasFinalizedRevision = false;
  const normalized = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const revision = ordered[index];
    const receiptBody = progressRevisionReceiptBody(revision, steps);
    const counts = progressCounts(receiptBody.stepStates, steps);
    const receipt = String(revision.receiptSha256 ?? revision.receipt_sha256 ?? "");
    const expectedChangeType = hasFinalizedRevision
      ? "corrected"
      : receiptBody.finalized ? "completed" : "progress_recorded";
    if (receiptBody.revisionNumber !== index + 1
      || receiptBody.previousReceiptSha256 !== previousReceipt
      || receiptBody.stepStatesSha256 !== progressStepStatesSha256(
        receiptBody.stepStates,
        steps,
      )
      || receiptBody.totalStepCount !== counts.totalStepCount
      || receiptBody.completedStepCount !== counts.completedStepCount
      || receiptBody.requiredStepCount !== counts.requiredStepCount
      || receiptBody.requiredCompletedCount !== counts.requiredCompletedCount
      || receiptBody.changeType !== expectedChangeType
      || !PERSONNEL_LEARNING_PROGRESS_CHANGE_TYPES.includes(receiptBody.changeType)
      || !PERSONNEL_LEARNING_PROGRESS_RESULTS.includes(receiptBody.result)
      || !PERSONNEL_LEARNING_PROGRESS_ACTOR_KINDS.includes(receiptBody.actorKind)
      || (!receiptBody.finalized && receiptBody.result !== "pending")
      || (receiptBody.finalized && (
        receiptBody.result === "pending"
        || counts.requiredCompletedCount !== counts.requiredStepCount
      ))
      || (receiptBody.changeType === "corrected" && !receiptBody.correctionReason)
      || (receiptBody.changeType !== "corrected" && receiptBody.correctionReason)
      || receiptBody.assessmentNote.length > PERSONNEL_LEARNING_PROGRESS_MAX_NOTE_LENGTH
      || receiptBody.correctionReason.length > PERSONNEL_LEARNING_PROGRESS_MAX_NOTE_LENGTH
      || receipt !== personnelLearningProgressRevisionReceiptSha256(revision, steps)) {
      invalid(
        "PERSONNEL_LEARNING_PROGRESS_HISTORY_INVALID",
        "Die Fortschrittshistorie enthält einen widersprüchlichen Revisionsverlauf.",
      );
    }
    normalized.push(Object.freeze({ ...receiptBody, receiptSha256: receipt }));
    previousReceipt = receipt;
    hasFinalizedRevision = hasFinalizedRevision || receiptBody.finalized;
  }
  const current = normalized.at(-1);
  const counts = progressCounts(current.stepStates, steps);
  return Object.freeze({
    current,
    currentReceipt: current.receiptSha256,
    revisionNumber: current.revisionNumber,
    finalized: current.finalized,
    hasFinalizedRevision,
    result: current.result,
    stepStates: current.stepStates,
    ...counts,
    progressPercent: progressPercent(counts),
    revisions: Object.freeze(normalized),
  });
}

module.exports = {
  PERSONNEL_LEARNING_PROGRESS_ACTOR_KINDS,
  PERSONNEL_LEARNING_PROGRESS_CHANGE_TYPES,
  PERSONNEL_LEARNING_PROGRESS_MAX_NOTE_LENGTH,
  PERSONNEL_LEARNING_PROGRESS_RESULTS,
  buildPersonnelLearningProgressState,
  normalizePersonnelLearningProgressMutation,
  normalizePersonnelLearningProgressStepStates,
  personnelLearningProgressRevisionReceiptSha256,
  personnelLearningProgressStepStatesFromCompletedIds,
  progressCounts,
  progressPercent,
  progressRevisionReceiptBody,
  progressStepStatesSha256,
};

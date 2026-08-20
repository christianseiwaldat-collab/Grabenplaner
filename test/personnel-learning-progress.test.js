"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PERSONNEL_LEARNING_PROGRESS_ACTOR_KINDS,
  buildPersonnelLearningProgressState,
  normalizePersonnelLearningProgressMutation,
  personnelLearningProgressRevisionReceiptSha256,
  progressStepStatesSha256,
} = require("../lib/personnel-learning-progress");

test("Fortschrittsbelege unterscheiden persönliche, leitende und standortgebundene Akteure", () => {
  assert.deepEqual(PERSONNEL_LEARNING_PROGRESS_ACTOR_KINDS, [
    "learner",
    "trainer",
    "leadership",
    "branch_account",
  ]);
});

const STEPS = Object.freeze([
  Object.freeze({ stepId: "vorbereiten", required: true }),
  Object.freeze({ stepId: "durchfuehren", required: true }),
  Object.freeze({ stepId: "vertiefen", required: false }),
]);

function revision({
  revisionNumber,
  completedStepIds,
  finalized = false,
  result = "pending",
  changeType,
  correctionReason = "",
  previousReceiptSha256 = "",
}) {
  const stepStates = STEPS.map(({ stepId }) => ({
    stepId,
    completed: completedStepIds.includes(stepId),
  }));
  const row = {
    assignmentId: "assignment:1",
    revisionNumber,
    assignmentRevisionReceiptSha256: "a".repeat(64),
    processModuleId: "process:1",
    processVersionNumber: 1,
    stepStates,
    stepStatesSha256: progressStepStatesSha256(stepStates, STEPS),
    totalStepCount: 3,
    completedStepCount: completedStepIds.length,
    requiredStepCount: 2,
    requiredCompletedCount: completedStepIds.filter((id) => id !== "vertiefen").length,
    finalized,
    result,
    assessmentNote: finalized ? "Strukturiert geprüft." : "",
    changeType,
    correctionReason,
    previousReceiptSha256,
    receiptSha256: "",
    actorKind: "trainer",
    changedBy: "TRAINER-1",
    changedAt: `2026-08-18T10:0${revisionNumber}:00.000Z`,
  };
  row.receiptSha256 = personnelLearningProgressRevisionReceiptSha256(row, STEPS);
  return row;
}

test("Block 6 leitet Fortschritt nur aus erledigten Prozessschritten ab", () => {
  const normalized = normalizePersonnelLearningProgressMutation({
    completedStepIds: ["vorbereiten"],
    progressPercent: 100,
    finalized: false,
    result: "pending",
  }, { processSteps: STEPS });

  assert.equal(normalized.completedStepCount, 1);
  assert.equal(normalized.totalStepCount, 3);
  assert.equal(normalized.progressPercent, 33);
  assert.equal(normalized.changeType, "progress_recorded");
  assert.deepEqual(normalized.stepStates, [
    { stepId: "vorbereiten", completed: true },
    { stepId: "durchfuehren", completed: false },
    { stepId: "vertiefen", completed: false },
  ]);
});

test("Block 6 verlangt alle Pflichtschritte und ein strukturiertes Abschlussergebnis", () => {
  assert.throws(() => normalizePersonnelLearningProgressMutation({
    completedStepIds: ["vorbereiten"],
    finalized: true,
    result: "passed",
  }, { processSteps: STEPS }), {
    code: "PERSONNEL_LEARNING_PROGRESS_REQUIRED_STEPS_INCOMPLETE",
  });

  const completed = normalizePersonnelLearningProgressMutation({
    completedStepIds: ["vorbereiten", "durchfuehren"],
    finalized: true,
    result: "follow_up_required",
    assessmentNote: "Praxisanteil nochmals gemeinsam wiederholen.",
  }, { processSteps: STEPS });
  assert.equal(completed.changeType, "completed");
  assert.equal(completed.progressPercent, 67);
  assert.equal(completed.result, "follow_up_required");
});

test("Block 6 bewahrt Abschluss und spätere Korrekturen als begründete Receipt-Kette", () => {
  const first = revision({
    revisionNumber: 1,
    completedStepIds: ["vorbereiten"],
    changeType: "progress_recorded",
  });
  const second = revision({
    revisionNumber: 2,
    completedStepIds: ["vorbereiten", "durchfuehren"],
    finalized: true,
    result: "passed",
    changeType: "completed",
    previousReceiptSha256: first.receiptSha256,
  });
  const third = revision({
    revisionNumber: 3,
    completedStepIds: ["vorbereiten", "durchfuehren", "vertiefen"],
    finalized: true,
    result: "follow_up_required",
    changeType: "corrected",
    correctionReason: "Bewertung nach dokumentierter Rücksprache berichtigt.",
    previousReceiptSha256: second.receiptSha256,
  });
  const state = buildPersonnelLearningProgressState({
    revisions: [first, second, third],
    processSteps: STEPS,
  });

  assert.equal(state.revisionNumber, 3);
  assert.equal(state.progressPercent, 100);
  assert.equal(state.result, "follow_up_required");
  assert.equal(state.hasFinalizedRevision, true);
  assert.equal(state.revisions[2].changeType, "corrected");

  assert.throws(() => normalizePersonnelLearningProgressMutation({
    completedStepIds: ["vorbereiten", "durchfuehren"],
    finalized: true,
    result: "passed",
  }, { processSteps: STEPS, current: state }), {
    code: "PERSONNEL_LEARNING_PROGRESS_INVALID",
  });
});

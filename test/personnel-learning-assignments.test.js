"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assignmentReceiptSha256,
  assignmentRevisionReceiptSha256,
  buildPersonnelLearningAssignmentState,
  normalizePersonnelLearningAssignmentMutation,
  normalizePersonnelLearningTrainerBindings,
  trainerBindingsSha256,
} = require("../lib/personnel-learning-assignments");

const RECEIPT_A = "a".repeat(64);
const RECEIPT_B = "b".repeat(64);

function binding(overrides = {}) {
  return {
    competencyId: "competency:trainer-a:tradefoto",
    competencyRevisionNumber: 3,
    competencyRevisionReceipt: RECEIPT_A,
    trainerEmployeeNumber: "252",
    skillModuleId: "skill:tradefoto",
    skillVersionNumber: 2,
    competencyLevel: 8,
    ...overrides,
  };
}

function identity() {
  const row = {
    id: "assignment:test:1",
    processModuleId: "process:kassa",
    learnerEmployeeNumber: "412",
    createdBy: "FL-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  };
  return { ...row, receiptSha256: assignmentReceiptSha256(row) };
}

function revision(overrides = {}) {
  const trainerBindings = [binding()];
  const row = {
    assignmentId: "assignment:test:1",
    revisionNumber: 1,
    processModuleId: "process:kassa",
    processVersionNumber: 4,
    active: true,
    trainerBindings,
    trainerBindingsSha256: trainerBindingsSha256(trainerBindings),
    changeType: "assigned",
    previousReceiptSha256: "",
    changedBy: "FL-1",
    changedAt: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
  return { ...row, receiptSha256: assignmentRevisionReceiptSha256(row) };
}

test("Block 5 normalisiert mehrere Trainerfähigkeiten eindeutig und deterministisch", () => {
  const normalized = normalizePersonnelLearningTrainerBindings([
    binding({
      competencyId: "competency:trainer-b:drohnen",
      competencyRevisionNumber: 1,
      competencyRevisionReceipt: RECEIPT_B,
      trainerEmployeeNumber: "410",
      skillModuleId: "skill:drohnen",
      skillVersionNumber: 1,
      competencyLevel: 7,
    }),
    binding(),
  ]);
  assert.deepEqual(normalized.map(({ trainerEmployeeNumber }) => trainerEmployeeNumber), [
    "252",
    "410",
  ]);
  assert.equal(trainerBindingsSha256([...normalized].reverse()), trainerBindingsSha256(normalized));
  assert.throws(() => normalizePersonnelLearningTrainerBindings([
    binding(),
    binding(),
  ]), /nur einmal/);
  assert.throws(() => normalizePersonnelLearningTrainerBindings([]), /zwischen einer und 12/);
});

test("Block 5 trennt aktive Zuweisung und Abbruch und übernimmt keine freien Belegdaten", () => {
  assert.deepEqual(normalizePersonnelLearningAssignmentMutation({
    trainerCompetencyIds: ["z", "a"],
  }), {
    active: true,
    trainerCompetencyIds: ["a", "z"],
  });
  assert.deepEqual(normalizePersonnelLearningAssignmentMutation({
    active: false,
  }, {
    current: { trainerCompetencyIds: ["competency:1"] },
  }), {
    active: false,
    trainerCompetencyIds: ["competency:1"],
  });
});

test("Block 5 bildet Zuweisung, Trainerwechsel, Abbruch und Restore als Receipt-Kette", () => {
  const first = revision();
  const updatedBindings = [binding({ competencyLevel: 9 })];
  const second = revision({
    revisionNumber: 2,
    trainerBindings: updatedBindings,
    trainerBindingsSha256: trainerBindingsSha256(updatedBindings),
    changeType: "trainers_updated",
    previousReceiptSha256: first.receiptSha256,
    changedAt: "2026-08-18T11:00:00.000Z",
  });
  const third = revision({
    revisionNumber: 3,
    active: false,
    trainerBindings: updatedBindings,
    trainerBindingsSha256: trainerBindingsSha256(updatedBindings),
    changeType: "cancelled",
    previousReceiptSha256: second.receiptSha256,
    changedAt: "2026-08-18T12:00:00.000Z",
  });
  const fourth = revision({
    revisionNumber: 4,
    active: true,
    trainerBindings: updatedBindings,
    trainerBindingsSha256: trainerBindingsSha256(updatedBindings),
    changeType: "restored",
    previousReceiptSha256: third.receiptSha256,
    changedAt: "2026-08-18T13:00:00.000Z",
  });
  const state = buildPersonnelLearningAssignmentState({
    assignment: identity(),
    revisions: [third, first, fourth, second],
  });
  assert.equal(state.revisionNumber, 4);
  assert.equal(state.active, true);
  assert.equal(state.trainerBindings[0].competencyLevel, 9);
  assert.equal(state.currentReceipt, fourth.receiptSha256);
});

test("Block 5 verwirft manipulierte Belege und unzulässige Zustandswechsel", () => {
  const first = revision();
  assert.throws(() => buildPersonnelLearningAssignmentState({
    assignment: identity(),
    revisions: [{ ...first, receiptSha256: "f".repeat(64) }],
  }), /widersprüchlichen Revisionsverlauf/);
  assert.throws(() => buildPersonnelLearningAssignmentState({
    assignment: identity(),
    revisions: [first, revision({
      revisionNumber: 2,
      active: true,
      changeType: "restored",
      previousReceiptSha256: first.receiptSha256,
    })],
  }), /widersprüchlichen Revisionsverlauf/);
});

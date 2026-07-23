"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  OFFICIAL_TIME_RECORD_SOURCES,
  appendActualTimeCorrection,
  appendActualTimeEvent,
  createActualTimeLedger,
  createMonthlyTimeRecordStatement,
  effectiveActualEvents,
  finalizeMonthlyTimeRecordStatement,
  reviewMonthlyTimeRecordStatement,
  supersedeMonthlyTimeRecordStatement,
  verifyActualTimeLedger,
  verifyMonthlyTimeRecordStatement,
} = require("../lib/time-record-statements");

function baseLedger() {
  return createActualTimeLedger({
    ledgerId: "actual-time-252",
    employeeId: "252",
    createdAt: "2026-07-01T00:00:00.000Z",
  });
}

function actualEvent(eventId, type, occurredAt, overrides = {}) {
  return {
    eventId,
    type,
    workDate: "2026-07-06",
    occurredAt,
    recordedAt: occurredAt,
    source: "employee",
    actorId: "252",
    note: "",
    ...overrides,
  };
}

function completeLedger() {
  let ledger = baseLedger();
  ledger = appendActualTimeEvent(ledger, actualEvent("in-1", "clock_in", "2026-07-06T09:00:00+02:00"));
  ledger = appendActualTimeEvent(ledger, actualEvent("break-1", "break_start", "2026-07-06T12:30:00+02:00"));
  ledger = appendActualTimeEvent(ledger, actualEvent("break-2", "break_end", "2026-07-06T13:00:00+02:00"));
  ledger = appendActualTimeEvent(ledger, actualEvent("out-1", "clock_out", "2026-07-06T17:00:00+02:00"));
  return ledger;
}

test("v0.82 Arbeitszeit: nur Ist-Ereignisse, niemals Dienstplanwerte, gelangen ins Ledger", () => {
  assert.ok(OFFICIAL_TIME_RECORD_SOURCES.some(({ id }) => id === "at-usp-arbeitszeitaufzeichnungen"));
  const ledger = baseLedger();
  assert.equal(verifyActualTimeLedger(ledger), true);
  assert.ok(OFFICIAL_TIME_RECORD_SOURCES.some(({ id, url }) => id === "at-azg-26" && url.startsWith("https://")));

  assert.throws(
    () => appendActualTimeEvent(ledger, actualEvent("planned-1", "clock_in", "2026-07-06T09:00:00+02:00", {
      source: "schedule",
    })),
    /source is unsupported/i,
  );
  assert.throws(
    () => appendActualTimeEvent(ledger, {
      ...actualEvent("planned-2", "clock_in", "2026-07-06T09:00:00+02:00"),
      plannedStart: "09:00",
    }),
    /unsupported fields/i,
  );
  assert.equal(ledger.events.length, 0);
});

test("v0.82 Arbeitszeit: Monatskopie enthaelt tatsaechlichen Beginn, Ende, Pausen und deterministischen SHA256", () => {
  const ledger = completeLedger();
  const statement = createMonthlyTimeRecordStatement({
    statementId: "statement-252-2026-07",
    ledger,
    month: "2026-07",
    createdAt: "2026-08-01T08:00:00.000Z",
  });
  const repeated = createMonthlyTimeRecordStatement({
    createdAt: "2026-08-01T08:00:00.000Z",
    month: "2026-07",
    ledger,
    statementId: "statement-252-2026-07",
  });

  assert.equal(statement.receiptSha256, repeated.receiptSha256);
  assert.match(statement.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(verifyMonthlyTimeRecordStatement(statement), true);
  assert.equal(statement.completeness, "complete");
  assert.equal(statement.status, "draft");
  assert.equal(statement.days.length, 1);
  assert.equal(statement.days[0].beginningAt, "2026-07-06T09:00:00+02:00");
  assert.equal(statement.days[0].endingAt, "2026-07-06T17:00:00+02:00");
  assert.deepEqual(statement.days[0].breaks, [{
    startAt: "2026-07-06T12:30:00+02:00",
    endAt: "2026-07-06T13:00:00+02:00",
    durationMinutes: 30,
  }]);
  assert.equal(statement.days[0].actualMinutes, 450);
  assert.equal(statement.totals.breakMinutes, 30);
  assert.equal(statement.totals.actualMinutes, 450);
  assert.ok(statement.sources.some(({ id }) => id === "at-arbeitsinspektion-arbeitszeitaufzeichnung"));
});

test("v0.82 Arbeitszeit: unvollstaendige Kopien koennen weder genehmigt noch finalisiert werden", () => {
  let ledger = baseLedger();
  ledger = appendActualTimeEvent(ledger, actualEvent("open-in", "clock_in", "2026-07-06T09:00:00+02:00"));
  const statement = createMonthlyTimeRecordStatement({
    statementId: "statement-open",
    ledger,
    month: "2026-07",
    createdAt: "2026-08-01T08:00:00.000Z",
  });
  assert.equal(statement.completeness, "incomplete");
  assert.ok(statement.issues.some(({ code }) => code === "missing_clock_out"));
  assert.throws(
    () => reviewMonthlyTimeRecordStatement(statement, {
      decision: "approved",
      reviewedBy: "fl-252",
      reviewedAt: "2026-08-01T09:00:00.000Z",
      note: "",
    }),
    /cannot be approved/i,
  );
  const needsCorrection = reviewMonthlyTimeRecordStatement(statement, {
    decision: "needs_correction",
    reviewedBy: "fl-252",
    reviewedAt: "2026-08-01T09:00:00.000Z",
    note: "Gehen-Buchung fehlt",
  });
  assert.equal(needsCorrection.status, "needs_correction");
  assert.throws(
    () => finalizeMonthlyTimeRecordStatement(needsCorrection, {
      finalizedBy: "fl-252",
      finalizedAt: "2026-08-01T10:00:00.000Z",
    }),
    /Only a complete, approved statement/i,
  );
});

test("v0.82 Arbeitszeit: Review und Finalisierung bilden unveraenderliche Revisionen", () => {
  const draft = createMonthlyTimeRecordStatement({
    statementId: "statement-final",
    ledger: completeLedger(),
    month: "2026-07",
    createdAt: "2026-08-01T08:00:00.000Z",
  });
  const reviewed = reviewMonthlyTimeRecordStatement(draft, {
    decision: "approved",
    reviewedBy: "fl-252",
    reviewedAt: "2026-08-01T09:00:00.000Z",
    note: "Mit Originalbuchungen geprueft",
  });
  const finalized = finalizeMonthlyTimeRecordStatement(reviewed, {
    finalizedBy: "fl-252",
    finalizedAt: "2026-08-01T10:00:00.000Z",
  });

  assert.equal(draft.status, "draft");
  assert.equal(reviewed.status, "reviewed");
  assert.equal(finalized.status, "finalized");
  assert.equal(reviewed.previousReceiptSha256, draft.receiptSha256);
  assert.equal(finalized.previousReceiptSha256, reviewed.receiptSha256);
  assert.equal(finalized.revision, 3);
  assert.equal(verifyMonthlyTimeRecordStatement(finalized), true);
  const tampered = structuredClone(finalized);
  tampered.totals.actualMinutes = 9999;
  assert.equal(verifyMonthlyTimeRecordStatement(tampered), false);
});

test("v0.82 Arbeitszeit: Korrektur supersediert statt zu ueberschreiben und erzeugt eine neue Monatsrevision", () => {
  const ledger = completeLedger();
  const originalStatement = createMonthlyTimeRecordStatement({
    statementId: "statement-corrected",
    ledger,
    month: "2026-07",
    createdAt: "2026-08-01T08:00:00.000Z",
  });
  const correctedLedger = appendActualTimeCorrection(ledger, {
    correctionId: "out-1-correction",
    targetEventId: "out-1",
    replacement: {
      type: "clock_out",
      workDate: "2026-07-06",
      occurredAt: "2026-07-06T17:30:00+02:00",
      source: "manager",
      note: "Nach Originalnachweis korrigiert",
    },
    recordedAt: "2026-08-01T08:30:00.000Z",
    actorId: "fl-252",
    reason: "Fehlende halbe Stunde nachgewiesen",
  });
  assert.equal(ledger.events.length, 4, "Korrektur darf das alte Ledger nicht mutieren.");
  assert.equal(correctedLedger.events.length, 5);
  assert.equal(verifyActualTimeLedger(correctedLedger), true);
  assert.equal(effectiveActualEvents(correctedLedger).some(({ eventId }) => eventId === "out-1"), false);
  assert.equal(effectiveActualEvents(correctedLedger).some(({ eventId }) => eventId === "out-1-correction"), true);

  const superseding = supersedeMonthlyTimeRecordStatement(originalStatement, {
    ledger: correctedLedger,
    createdAt: "2026-08-01T08:35:00.000Z",
    actorId: "fl-252",
    reason: "Genehmigte Zeitkorrektur",
  });
  assert.equal(superseding.revision, 2);
  assert.equal(superseding.previousReceiptSha256, originalStatement.receiptSha256);
  assert.equal(superseding.supersedesReceiptSha256, originalStatement.receiptSha256);
  assert.equal(superseding.status, "draft");
  assert.equal(superseding.totals.actualMinutes, 480);
  assert.equal(originalStatement.totals.actualMinutes, 450);
  assert.equal(verifyMonthlyTimeRecordStatement(superseding), true);
});

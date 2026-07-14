"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  calendarDays, selectRangeDate, rangeLabel, shiftMonth, selectionMaximum, selectionCanCommit,
} = require("../public/date-range-calendar");

test("Zeitraumskalender beginnt montags und liefert sechs vollständige Wochen", () => {
  const days = calendarDays("2026-07-01");
  assert.equal(days.length, 42);
  assert.equal(days[0], "2026-06-29");
  assert.equal(days[41], "2026-08-09");
});

test("erste Auswahl setzt den Beginn, zweite Auswahl das Ende", () => {
  const start = selectRangeDate({}, "2026-07-14");
  assert.deepEqual(start, { start: "2026-07-14", end: "" });
  assert.deepEqual(selectRangeDate(start, "2026-07-18"), { start: "2026-07-14", end: "2026-07-18" });
  assert.deepEqual(selectRangeDate(start, "2026-07-10"), { start: "2026-07-10", end: "" });
});

test("offenes Ende und Monatswechsel werden eindeutig dargestellt", () => {
  assert.match(rangeLabel("2026-07-14", ""), /14\.07\.2026.*Ende offen/);
  assert.equal(shiftMonth("2026-12-01", 1), "2027-01-01");
});

test("maximales Ende wird an den gewählten Beginn gekoppelt", () => {
  assert.equal(selectionMaximum({ start: "2025-07-14", end: "", maxEndDays: 365 }), "2026-07-14");
  assert.equal(selectionMaximum({ start: "2026-07-14", end: "", maxEndDays: 365 }), "2027-07-14");
  assert.equal(selectionMaximum({ start: "2026-07-14", end: "2026-07-20", maxStart: "2026-07-14" }), "2026-07-14");
});

test("ein abgewähltes offenes Ende verlangt eine Endauswahl", () => {
  assert.equal(selectionCanCommit({ start: "2026-07-14", end: "", allowOpenEnd: true, openEndSelected: true }), true);
  assert.equal(selectionCanCommit({ start: "2026-07-14", end: "", allowOpenEnd: true, openEndSelected: false }), false);
  assert.equal(selectionCanCommit({ start: "2026-07-14", end: "2026-07-20", allowOpenEnd: true, openEndSelected: false }), true);
});

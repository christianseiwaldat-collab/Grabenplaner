"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildScheduleMatrixOptionSpans,
  buildScheduleMatrixSicknessSegments,
  paginateScheduleMatrixNote,
  wrapScheduleMatrixNote,
} = require("../lib/schedule-matrix-layout");

function option(overrides = {}) {
  return { id: "same", employee_number: "419", option_type: "vocational_school",
    date_from: "2026-09-07", date_to: "2026-09-10", all_day: 1,
    start_time: null, end_time: null, note: "Berufsschule", ...overrides };
}

test("mehrtägige identische Optionen werden als ein sichtbarer, kontinuierlicher Zeitraum angeordnet", () => {
  const spans = buildScheduleMatrixOptionSpans({ options: [option()], employeeNumber: "419", weekStart: "2026-09-07", dayCount: 6 });
  assert.equal(spans.length, 1);
  assert.deepEqual({ startDay: spans[0].startDay, endDay: spans[0].endDay, lane: spans[0].lane }, { startDay: 0, endDay: 3, lane: 0 });
  assert.equal(spans[0].options.length, 1);
});

test("verschiedene Ursprünge, Inhalte oder Zeiten werden niemals still zusammengeführt", () => {
  const spans = buildScheduleMatrixOptionSpans({ options: [
    option({ id: "one", date_from: "2026-09-07", date_to: "2026-09-08", start_time: "09:00", end_time: "12:00", all_day: 0 }),
    option({ id: "two", date_from: "2026-09-09", date_to: "2026-09-10", start_time: "09:00", end_time: "12:00", all_day: 0 }),
    option({ id: "one", date_from: "2026-09-09", date_to: "2026-09-10", start_time: "13:00", end_time: "17:00", all_day: 0 }),
  ], employeeNumber: "419", weekStart: "2026-09-07", dayCount: 6 });
  assert.equal(spans.length, 3);
  assert.deepEqual(spans.map(span => [span.startDay, span.endDay]), [[0, 1], [2, 3], [2, 3]]);
  assert.ok(spans.some(span => span.lane === 1), "overlapping unrelated spans need separate lanes");
});

test("sichtbare Woche beschneidet gespeicherte Zeiträume auf sechs oder sieben Tage", () => {
  const six = buildScheduleMatrixOptionSpans({ options: [option({ date_from: "2026-09-01", date_to: "2026-09-20" })], employeeNumber: "419", weekStart: "2026-09-07", dayCount: 6 });
  const seven = buildScheduleMatrixOptionSpans({ options: [option({ date_from: "2026-09-01", date_to: "2026-09-20" })], employeeNumber: "419", weekStart: "2026-09-07", dayCount: 7 });
  assert.deepEqual([six[0].startDay, six[0].endDay], [0, 5]);
  assert.deepEqual([seven[0].startDay, seven[0].endDay], [0, 6]);
});

test("Krankheitstage werden nur innerhalb derselben Fall-ID zusammengefasst", () => {
  const segments = buildScheduleMatrixSicknessSegments({
    credits: [
      ...[7, 8, 9, 10].map((day) => ({ employee_number: "419", date: `2026-09-${String(day).padStart(2, "0")}`, caseId: "case-a" })),
      { employee_number: "419", date: "2026-09-11", caseId: "case-b" },
      { employee_number: "430", date: "2026-09-07", caseId: "case-hidden" },
    ],
    options: [],
    employeeNumbers: ["419"],
    weekStart: "2026-09-07",
    weekEnd: "2026-09-13",
  });
  assert.deepEqual(segments.map((segment) => [segment.caseId, segment.startDay, segment.endDay]), [
    ["case-a", Date.UTC(2026, 8, 7) / 86400000, Date.UTC(2026, 8, 10) / 86400000],
    ["case-b", Date.UTC(2026, 8, 11) / 86400000, Date.UTC(2026, 8, 11) / 86400000],
  ]);
});

test("bereits vorhandene Krankenstandsoptionen unterdrücken nur ihre eigenen Tage", () => {
  const segments = buildScheduleMatrixSicknessSegments({
    credits: [7, 8, 9, 10].map((day) => ({ employee_number: "419", date: `2026-09-${String(day).padStart(2, "0")}`, case_id: "case-a" })),
    options: [option({ option_type: "sick", date_from: "2026-09-08", date_to: "2026-09-09" })],
    employeeNumbers: ["419"],
    weekStart: "2026-09-07",
    weekEnd: "2026-09-13",
  });
  assert.deepEqual(segments.map((segment) => [segment.startDay, segment.endDay]), [
    [Date.UTC(2026, 8, 7) / 86400000, Date.UTC(2026, 8, 7) / 86400000],
    [Date.UTC(2026, 8, 10) / 86400000, Date.UTC(2026, 8, 10) / 86400000],
  ]);
});

test("Bemerkungen werden ohne Ellipse in lesbare Spalten und zusätzliche Seiten aufgeteilt", () => {
  const lines = wrapScheduleMatrixNote("Erster längerer Absatz mit Inhalt.\n\nZweiter Absatz mit Zusatzinformationen.", value => value.length, 18);
  assert.ok(lines.length > 4);
  assert.ok(lines.includes(""));
  assert.equal(lines.some((line, index) => line === "" && lines[index - 1] === ""), false);
  assert.equal(lines.join(" ").includes("…"), false);
  const pages = paginateScheduleMatrixNote(lines, { columns: 2, linesPerColumn: 2 });
  assert.ok(pages.length > 1);
  assert.deepEqual(pages.flat(2).filter(Boolean), lines.filter(Boolean));
});

test("kurze Bemerkungsabsätze bleiben innerhalb einer Spalte zusammen", () => {
  const pages = paginateScheduleMatrixNote(["Absatz eins A", "Absatz eins B", "", "Absatz zwei A", "Absatz zwei B"], {
    columns: 2,
    linesPerColumn: 5,
  });
  assert.deepEqual(pages[0], [["Absatz eins A", "Absatz eins B", "", "Absatz zwei A", "Absatz zwei B"], []]);
});

test("Absatzgrenzen bleiben auch beim Wechsel der Spalte erhalten", () => {
  const pages = paginateScheduleMatrixNote(["A1", "A2", "", "B1", "B2"], {
    columns: 2,
    linesPerColumn: 3,
  });
  assert.deepEqual(pages[0], [["A1", "A2", ""], ["B1", "B2"]]);
});

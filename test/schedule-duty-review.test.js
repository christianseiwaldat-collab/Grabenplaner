"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { resolveScheduleDuty } = require("../public/schedule-duty");
const { buildScheduleMatrixSicknessSegments } = require("../lib/schedule-matrix-layout");

// Execute the actual pure PDF projection without opening the server or a database.
const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
function sourceBetween(start, end) {
  const from = server.indexOf(start), to = server.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing source boundary: ${start} / ${end}`);
  return server.slice(from, to);
}
const context = vm.createContext({ resolveScheduleDuty, buildScheduleMatrixSicknessSegments });
vm.runInContext([
  sourceBetween("function isTime(", "function timeToMinutes("),
  sourceBetween("function addDays(", "function addMonths("),
  sourceBetween("function optionIsAllDay(", "function optionTimeRange("),
  sourceBetween("function schedulePdfAssignmentOptionAlreadyPresent(", "function scheduleForPdf("),
].join("\n"), context);
const project = schedule => JSON.parse(JSON.stringify(context.schedulePdfWeekOptions(schedule)));

function fixture() {
  const base = { employee_number: "98761", home_location_id: "18", destination_location_id: "19",
    destination_location_name: "Zielstandort", date_from: "2026-09-07", date_to: "2026-09-07", all_day: 0 };
  return {
    context: { locationId: "18" }, weekStart: "2026-09-07", weekEnd: "2026-09-13",
    employees: [{ personnel_number: "98761", nickname: "Demo", position_id: "teamleitung", color: "#49796b" }],
    departments: [], weekOptions: [],
    staffAssignments: [
      { ...base, id: "morning-hw", destination_department_id: 31, destination_department_name: "Hardware", start_time: "09:00", end_time: "12:00" },
      { ...base, id: "afternoon-fo", destination_department_id: 32, destination_department_name: "Fotowelt", start_time: "13:00", end_time: "16:00" },
    ],
    pdfStaffAssignmentShifts: [
      { employee_number: "98761", shift_date: "2026-09-07", location_id: "19", location_name: "Zielstandort",
        department_id: 31, department_name: "Hardware", duty_code: "department", start_time: "09:00", end_time: "12:00" },
      { employee_number: "98761", shift_date: "2026-09-07", location_id: "19", location_name: "Zielstandort",
        department_id: 32, department_name: "Fotowelt", duty_code: "department", start_time: "13:00", end_time: "16:00" },
    ],
  };
}

test("PDF bewahrt zwei Dienste am selben Zielstandort mit ihren eigenen HW-/FO-Zuordnungen", () => {
  for (const reversed of [false, true]) {
    const schedule = fixture();
    if (reversed) schedule.staffAssignments.reverse();
    const original = JSON.stringify(schedule);
    const options = project(schedule).sort((left, right) => left.start_time.localeCompare(right.start_time));
    assert.equal(options.length, 2, "Exactly one option per actual assigned shift");
    assert.deepEqual(options.map(option => [option.start_time, option.end_time, option.pdf_time_kind,
      option.pdf_destination_label, option.pdf_duty_code, option.pdf_duty_label]), [
      ["09:00", "12:00", "planned", "Zielstandort · Hardware", "HW", "Hardware"],
      ["13:00", "16:00", "planned", "Zielstandort · Fotowelt", "FO", "Fotowelt"],
    ]);
    assert.equal(JSON.stringify(schedule), original, "The source read model remains unchanged");
  }
});

test("Ein geplanter Vormittagsdienst verschluckt keinen ungeplanten Nachmittagseinsatz", () => {
  const schedule = fixture();
  schedule.pdfStaffAssignmentShifts.pop();
  const options = project(schedule).sort((left, right) => left.start_time.localeCompare(right.start_time));
  assert.equal(options.length, 2);
  assert.deepEqual(options.map(option => [option.start_time, option.end_time, option.pdf_time_kind,
    option.pdf_destination_label, option.pdf_duty_code]), [
    ["09:00", "12:00", "planned", "Zielstandort · Hardware", "HW"],
    ["13:00", "16:00", "assignment", "Zielstandort · Fotowelt", "FO"],
  ]);
});

test("PDF übernimmt keine Freitextnotizen aus Fremddiensten oder Einsatzzusagen", () => {
  const schedule = fixture();
  for (const row of [...schedule.staffAssignments, ...schedule.pdfStaffAssignmentShifts]) {
    row.note = "SYNTHETIC_PRIVATE_NOTE";
    row.area = "SYNTHETIC_PRIVATE_AREA";
  }
  const rendered = JSON.stringify(project(schedule));
  assert.doesNotMatch(rendered, /SYNTHETIC_PRIVATE_(NOTE|AREA)/);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = script.indexOf(startMarker);
  const end = script.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `${startMarker} fehlt`);
  assert.ok(end > start, `${endMarker} fehlt nach ${startMarker}`);
  return script.slice(start, end);
}

const visibilityHelpers = sourceBetween(
  "function staffAssignmentsForDate(",
  "function renderTimeline()",
);

function visibleEmployeeNumbers(state, date) {
  const sandbox = { state, result: null };
  vm.createContext(sandbox);
  vm.runInContext(`${visibilityHelpers}\nresult = scheduleEmployeesForDate(${JSON.stringify(date)}).map((employee) => employee.personnel_number);`, sandbox);
  return JSON.parse(JSON.stringify(sandbox.result));
}

test("Fremdfilial-MA erscheint nur an Tagen des eingehenden Filialeinsatzes", () => {
  const state = {
    locationId: "18",
    data: {
      employees: [
        { personnel_number: "252", home_location_id: "18" },
        { personnel_number: "353", home_location_id: "05" },
      ],
      staffAssignments: [{
        employee_number: "353",
        home_location_id: "05",
        destination_location_id: "18",
        date_from: "2026-09-19",
        date_to: "2026-09-19",
        all_day: 1,
      }],
      shifts: [],
    },
  };

  for (const date of ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"]) {
    assert.deepEqual(visibleEmployeeNumbers(state, date), ["252"], date);
  }
  assert.deepEqual(visibleEmployeeNumbers(state, "2026-09-19"), ["252", "353"]);
});

test("Fremdfilial-Dienst ohne historische Einsatzverknüpfung bleibt nur am Diensttag sichtbar", () => {
  const state = {
    locationId: "18",
    data: {
      employees: [{ personnel_number: "353", home_location_id: "05" }],
      staffAssignments: [],
      shifts: [{
        employee_number: "353",
        shift_date: "2026-09-19",
        location_id: "18",
      }],
    },
  };

  assert.deepEqual(visibleEmployeeNumbers(state, "2026-09-18"), []);
  assert.deepEqual(visibleEmployeeNumbers(state, "2026-09-19"), ["353"]);
});

test("Wochenraster verwendet je Tag eine eigene Mitarbeiterliste und Spaltenzahl", () => {
  const renderer = sourceBetween("function renderTimeline()", "function renderRemarks()");
  assert.match(renderer, /const dayEmployees = scheduleEmployeesForDate\(date\)/);
  assert.match(renderer, /dayEmployees\.map\(\(employee\) =>/);
  assert.match(renderer, /--employee-count:\$\{Math\.max\(1, dayEmployees\.length\)\}/);
});

test("Firmeneintritt: Wochen davor zeigen den Mitarbeiter nicht, der erste Tag zählt einschließlich", () => {
  const employee = { personnel_number: "TEST-NEW", home_location_id: "18", planningDates: [] };
  const state = { locationId: "18", data: { employees: [employee], staffAssignments: [], shifts: [] } };
  for (const day of ["2026-10-05", "2026-10-10", "2026-10-11"]) {
    assert.deepEqual(visibleEmployeeNumbers(state, day), []);
  }
  employee.planningDates = ["2026-10-12", "2026-10-13"];
  assert.deepEqual(visibleEmployeeNumbers(state, "2026-10-12"), ["TEST-NEW"]);
  assert.deepEqual(visibleEmployeeNumbers(state, "2026-10-13"), ["TEST-NEW"]);
});

test("Firmeneintritt innerhalb einer Woche wird tageweise ausgewertet; Filialeinsätze und Alt-Dienste umgehen ihn nicht", () => {
  const state = { locationId: "18", data: {
    employees: [{ personnel_number: "TEST-NEW", home_location_id: "05", planningDates: ["2026-10-15", "2026-10-16"] }],
    staffAssignments: [{ employee_number: "TEST-NEW", destination_location_id: "18", date_from: "2026-10-12", date_to: "2026-10-16" }],
    shifts: [{ employee_number: "TEST-NEW", shift_date: "2026-10-14", location_id: "18" }],
  } };
  for (const day of ["2026-10-12", "2026-10-13", "2026-10-14"]) assert.deepEqual(visibleEmployeeNumbers(state, day), []);
  for (const day of ["2026-10-15", "2026-10-16"]) assert.deepEqual(visibleEmployeeNumbers(state, day), ["TEST-NEW"]);
  assert.equal(state.data.shifts.length, 1, "Die Anzeige darf alte Plandaten nicht verändern");
});

test("Fehlende neue Tagesprojektion erhält die bisherige Sichtbarkeit vorhandener Datensätze", () => {
  const state = { locationId: "18", data: { employees: [{ personnel_number: "TEST-OLD", home_location_id: "18" }] } };
  assert.deepEqual(visibleEmployeeNumbers(state, "2026-10-05"), ["TEST-OLD"]);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const duty = require("../public/schedule-duty");
const script = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

function between(start, end) {
  const from = script.indexOf(start), to = script.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} / ${end}`);
  return script.slice(from, to);
}

function fixture() {
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const settings = { show_sunday: "0" };
  for (const day of days.slice(1)) {
    settings[`${day}_open`] = "1";
    settings[`${day}_start_time`] = day === "saturday" ? "10:00" : "09:00";
    settings[`${day}_end_time`] = day === "saturday" ? "17:00" : "18:00";
  }
  const employee = { personnel_number: "990001", full_name: "Alex Beispiel", nickname: "Alex", home_location_id: "18", color: "#426D5B" };
  const state = { weekStart: "2026-09-07", locationId: "18", positions: [], data: {
    settings, employees: [employee], shifts: [], weekOptions: [], staffAssignments: [],
    globalDayBlocks: [], sicknessCredits: [],
  } };
  const properties = {};
  const elements = { timeline: { innerHTML: "", style: { setProperty(key, value) { properties[key] = value; } } } };
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const sandbox = vm.createContext({ state, elements, window: { GPScheduleDuty: duty },
    dayKeyByNumber: Object.fromEntries(days.map((day, i) => [i, day])),
    weekdayNames: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
    addDays: (date, offset) => new Date(Date.parse(`${date}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10),
    formatDate: date => date, formatHours: minutes => String(minutes || 0),
    escapeHtml: escape, escapeHtmlAttribute: escape, contrastColor: () => "#fff",
    isAutomaticallyWeekLocked: () => false, employeeCanWorkOnDate: () => true,
    globalBlockForDate: date => state.data.globalDayBlocks.find(row => row.block_date === date),
    publicHolidayForDate: () => null, departmentsForLocation: () => [],
    specialCasesFor: (number, date) => state.data.weekOptions.filter(row => row.employee_number === number && row.date_from <= date && row.date_to >= date),
    optionLabels: { time_off: "Zeitausgleich" }, TEAM_MEETING_GROUP_PREFIX: "team-meeting-",
  });
  vm.runInContext([
    between("function timeToMinutes(", "function isAutomaticallyWeekLocked("),
    between("function optionIsAllDay(", "function fixedWorkdays("),
    between("function staffAssignmentsForDate(", "function renderRemarks("),
  ].join("\n"), sandbox);
  return { ...sandbox, properties, employee };
}

test("Wochenwechsel mit bis Sonntag reichender Abwesenheit ersetzt das gesamte alte Raster", () => {
  const f = fixture();
  f.renderTimeline();
  assert.match(f.elements.timeline.innerHTML, /Mo 2026-09-07/);
  assert.equal(f.properties["--day-count"], 6);
  f.state.weekStart = "2026-09-14";
  f.state.data.weekOptions = [{ employee_number: f.employee.personnel_number, option_type: "time_off",
    date_from: "2026-09-18", date_to: "2026-09-20", all_day: 1, start_time: null, end_time: null }];
  assert.doesNotThrow(() => f.renderTimeline());
  assert.equal(f.properties["--day-count"], 7);
  assert.match(f.elements.timeline.innerHTML, /Mo 2026-09-14/);
  assert.match(f.elements.timeline.innerHTML, /So 2026-09-20/);
  assert.match(f.elements.timeline.innerHTML, /closed-day/);
  assert.match(f.elements.timeline.innerHTML, /Zeitausgleich/);
  assert.doesNotMatch(f.elements.timeline.innerHTML, /2026-09-07|undefined|NaN/);
  f.state.weekStart = "2026-09-07";
  f.state.data.weekOptions = [];
  f.renderTimeline();
  assert.equal(f.properties["--day-count"], 6);
  assert.doesNotMatch(f.elements.timeline.innerHTML, /2026-09-20/);
});

test("Sonntagsdienst bleibt auch ohne Sonntagsöffnung sichtbar und zeitlich korrekt", () => {
  const f = fixture();
  f.state.weekStart = "2026-09-14";
  f.state.data.shifts = [{ id: 91, employee_number: f.employee.personnel_number,
    shift_date: "2026-09-20", start_time: "10:00", end_time: "12:00", duty_code: "general" }];
  assert.doesNotThrow(() => f.renderTimeline());
  assert.match(f.elements.timeline.innerHTML, /So 2026-09-20/);
  assert.match(f.elements.timeline.innerHTML, /data-shift-id="91"/);
  assert.match(f.elements.timeline.innerHTML, /10:00–12:00/);
  assert.doesNotMatch(f.elements.timeline.innerHTML, /undefined|NaN/);
});

test("Fehlende Öffnungszeiten sind keine Öffnung; gültige Tageszeiten bleiben erhalten", () => {
  const f = fixture();
  assert.equal(f.operatingHours("2026-09-20"), null);
  assert.equal(f.dayConfig("2026-09-20"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(f.operatingHours("2026-09-14"))), { start: "09:00", end: "18:00", key: "monday" });
  Object.assign(f.state.data.settings, { sunday_open: "1", sunday_start_time: "10:00", sunday_end_time: "14:00" });
  assert.equal(f.operatingHours("2026-09-20").start, "10:00");
  f.state.data.settings.sunday_open = "0";
  assert.equal(f.operatingHours("2026-09-20"), null);
  f.state.data.settings.show_sunday = "1";
  assert.doesNotThrow(() => f.renderTimeline());
  assert.equal(f.properties["--day-count"], 7);
});

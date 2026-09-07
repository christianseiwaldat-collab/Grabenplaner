"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const duty = require("../public/schedule-duty");
const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");
const json = value => JSON.parse(JSON.stringify(value));
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
function between(start, end) {
  const from = app.indexOf(start), to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} / ${end}`);
  return app.slice(from, to);
}
function control(select = false) {
  let markup = "", value = "";
  const result = { dataset: {}, options: [], classList: { toggle() {} }, textContent: "",
    get value() { return value; },
    set value(next) { const text = String(next); value = select && !this.options.some(option => option.value === text) ? "" : text; },
    get innerHTML() { return markup; },
    set innerHTML(next) { markup = next; if (select) this.options = [...next.matchAll(/<option value="([^"]*)"/g)].map(match => ({ value: match[1] })); },
  };
  return result;
}
function fixture() {
  const fields = Object.fromEntries(["shiftId", "shiftEmployee", "shiftDate", "shiftStart", "shiftEnd", "shiftArea", "shiftNote"]
    .map(name => ["#" + name, control(name === "shiftEmployee")]));
  const employees = [
    { personnel_number: "100", nickname: "Leitung", position_id: "teamleitung", preferred_department_id: 1, home_location_id: "18", active: 1, color: "#dbac19" },
    { personnel_number: "101", nickname: "Stellvertretung", position_id: "fl-stellvertretung", preferred_department_id: 2, home_location_id: "18", active: 1, color: "#ff70aa" },
    { personnel_number: "102", nickname: "Team", position_id: "verkauf", preferred_department_id: 1, home_location_id: "18", active: 1, color: "#11aa77" },
    { personnel_number: "103", nickname: "Ohne Abteilung", position_id: "verkauf", home_location_id: "18", active: 1, color: "#aaaaff" },
  ];
  const departments = [{ id: 1, name: "Hardware", active: 1 }, { id: 2, name: "Fotowelt", active: 1 }, { id: 3, name: "Archiv & Studio", active: 0 }];
  const state = { locationId: "18", departmentId: "2", weekStart: "2026-09-07", allEmployees: employees,
    locations: [{ id: "18", name: "Filiale", departments }], data: { employees, shifts: [], weekOptions: [], settings: { monday_start_time: "09:00", monday_end_time: "18:00" } } };
  let previews = 0, opened = 0, closed = 0, guard = false;
  const requests = [], properties = {};
  const elements = { shiftDepartment: control(true), shiftModalTitle: control(), deleteShiftButton: control(),
    shiftModal: { showModal() { opened++; }, close() { closed++; } },
    timeline: { innerHTML: "", style: { setProperty(name, value) { properties[name] = value; } } } };
  elements.shiftForm = { reset() { for (const field of Object.values(fields)) field.value = ""; elements.shiftDepartment.value = ""; } };
  const sandbox = { window: { GPScheduleDuty: duty }, state, elements, document: { querySelector(selector) { assert.ok(fields[selector], selector); return fields[selector]; } },
    escapeHtml: escape, escapeHtmlAttribute: escape, guardScheduleEditing: () => guard,
    operatingHours: () => ({ start: "09:00", end: "18:00" }), fullDaySpecialCaseFor: () => null, employeeCanWorkOnDate: () => true,
    calculateShiftPreview: () => { previews++; }, showToast() {}, getMonday: () => "2026-09-07", loadAll: async () => {},
    api: async (url, options) => { requests.push({ url, ...options, body: JSON.parse(options.body) }); },
    planningDayKeys: ["monday"], weekdayNames: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
    timeToMinutes: value => { const [h, m] = value.split(":").map(Number); return h * 60 + m; },
    addDays: (date, days) => new Date(Date.parse(date + "T12:00:00Z") + days * 86400000).toISOString().slice(0, 10),
    formatDate: date => date, formatHours: minutes => String(minutes || 0), contrastColor: () => "#172331",
    scheduleEmployeesForDate: () => state.data.employees, isAutomaticallyWeekLocked: () => false,
    globalBlockForDate: () => null, publicHolidayForDate: () => null, dayConfig: () => ({ start: "09:00", end: "18:00" }),
    collapsedWeekOptions: value => value, optionIsAllDay: () => false, isTeamWideMeetingOption: () => false,
    specialCasesFor: () => [], staffAssignmentsForDate: () => [], optionLabels: {},
  };
  vm.createContext(sandbox);
  vm.runInContext([
    between("function departmentsForLocation(", "function currentLocation("),
    between("function currentShiftDuty()", "function scheduleShiftRulePreview()"),
    between("function canUseAllEmployeesForShiftPlanning()", "function canManageEmployeeLendings()"),
    between("function openShiftModal(", "function openOptionsModal()"),
    between("async function saveShift(event)", "async function saveOption(event)"),
    between("function scheduleEmployeeAccessibleLabel(", "function renderRemarks()"),
  ].join("\n"), sandbox);
  return { ...sandbox, fields, requests, properties, departments, employees, setOperatingHours(value) { sandbox.operatingHours = value; },
    get previews() { return previews; }, get opened() { return opened; }, get closed() { return closed; }, setGuard(value) { guard = value; } };
}

test("Dienstwahl loads its shared helper before the app and uses passive unclipped high-contrast badges", () => {
  assert.doesNotThrow(() => new vm.Script(app));
  assert.ok(html.indexOf('src="/schedule-duty.js"') < html.indexOf('src="/app.js"'));
  assert.match(html, /<span>Dienst<\/span><select id="shiftDepartment">/);
  assert.match(css, /\.shift-bar \{[^}]*overflow: visible;[^}]*background: var\(--employee-color\)/);
  const badge = css.match(/\.shift-bar \.shift-duty-badge \{([^}]+)\}/)[1];
  assert.match(badge, /color:var\(--duty-contrast,#172331\); background:var\(--duty-color,#fff\)/); assert.match(badge, /pointer-events:none/);
  assert.doesNotMatch(badge, /text-overflow|overflow:hidden|cursor:pointer/);
  assert.match(css, /minmax\(var\(--day-min-width\),1fr\)/);
});

test("new FL and deputies default to branch supervision independently of preferred department and scope", () => {
  const f = fixture();
  for (const number of ["100", "101"]) {
    f.openShiftModal(number, "2026-09-07");
    assert.equal(f.elements.shiftDepartment.value, "__branch_supervision__");
    assert.deepEqual(json(f.currentShiftDuty()), { departmentId: "", dutyCode: "branch_supervision" });
    assert.match(f.elements.shiftDepartment.innerHTML, />FL · Filialaufsicht<\/option>/);
    assert.match(f.elements.shiftDepartment.innerHTML, /value="1">HW · Hardware/);
    assert.match(f.elements.shiftDepartment.innerHTML, /value="2">FO · Fotowelt/);
    assert.equal(f.elements.shiftDepartment.dataset.userSelected, "false");
  }
  assert.equal(f.opened, 2);
});

test("other new shifts retain context before preferred department and safely default to general duty", () => {
  const f = fixture();
  f.openShiftModal("102", "2026-09-07"); assert.equal(f.elements.shiftDepartment.value, "2");
  f.state.departmentId = ""; f.openShiftModal("102", "2026-09-07"); assert.equal(f.elements.shiftDepartment.value, "1");
  f.openShiftModal("103", "2026-09-07"); assert.equal(f.elements.shiftDepartment.value, "__general__");
  f.state.departmentId = "missing"; f.employees[2].preferred_department_id = 99;
  f.openShiftModal("102", "2026-09-07"); assert.equal(f.elements.shiftDepartment.value, "__general__");
});

test("existing explicit and historical department assignments are preserved instead of replaced by defaults", () => {
  const f = fixture();
  const base = { id: 7, employee_number: "100", shift_date: "2026-09-07", start_time: "10:00", end_time: "16:00" };
  for (const [change, expected] of [
    [{ duty_code: "department", department_id: 1 }, "1"], [{ duty_code: "", department_id: 2 }, "2"],
    [{ duty_code: "general", department_id: null }, "__general__"], [{ duty_code: "branch_supervision", department_id: null }, "__branch_supervision__"],
    [{ duty_code: "", department_id: null }, "__branch_supervision__"], [{ duty_code: "department", department_id: 3 }, "3"],
    [{ duty_code: "", department_id: null, employee_number: "102" }, "__general__"],
  ]) {
    f.openShiftModal("100", "2026-09-07", { ...base, ...change });
    assert.equal(f.elements.shiftDepartment.value, expected);
    f.fields["#shiftEmployee"].value = "103"; f.handleShiftEmployeeChange();
    assert.equal(f.elements.shiftDepartment.value, expected, "editing does not replace the assigned duty");
  }
  f.openShiftModal("100", "2026-09-07", { ...base, duty_code: "department", department_id: 3 });
  assert.match(f.elements.shiftDepartment.innerHTML, /value="3">AS · Archiv &amp; Studio/);
});

test("employee changes update only untouched new defaults and never overwrite a manual duty selection", () => {
  const f = fixture(); f.openShiftModal("100", "2026-09-07");
  f.fields["#shiftEmployee"].value = "102"; f.handleShiftEmployeeChange();
  assert.equal(f.elements.shiftDepartment.value, "2");
  f.elements.shiftDepartment.value = "1"; f.handleShiftDutyChange();
  f.fields["#shiftEmployee"].value = "101"; f.handleShiftEmployeeChange();
  assert.equal(f.elements.shiftDepartment.value, "1");
  f.elements.shiftDepartment.value = "__general__"; f.handleShiftDutyChange();
  f.fields["#shiftEmployee"].value = "100"; f.handleShiftEmployeeChange();
  assert.equal(f.elements.shiftDepartment.value, "__general__");
  f.openShiftModal("100", "2026-09-07");
  assert.equal(f.elements.shiftDepartment.dataset.userSelected, "false");
  assert.equal(f.elements.shiftDepartment.value, "__branch_supervision__");
  assert.match(app, /"#shiftEmployee"\)\.addEventListener\("change", handleShiftEmployeeChange\)/);
  assert.match(app, /shiftDepartment\.addEventListener\("change", handleShiftDutyChange\)/);
});

test("save and live rule preview send the same explicit duty with only real numeric department IDs", async () => {
  const f = fixture(); f.openShiftModal("100", "2026-09-07");
  for (const [selected, expected] of [["__branch_supervision__", { departmentId: "", dutyCode: "branch_supervision" }],
    ["__general__", { departmentId: "", dutyCode: "general" }], ["2", { departmentId: 2, dutyCode: "department" }]]) {
    f.elements.shiftDepartment.value = selected;
    const candidate = f.currentShiftRuleCandidate();
    assert.equal(candidate.departmentId, expected.departmentId); assert.equal(candidate.dutyCode, expected.dutyCode);
    await f.saveShift({ preventDefault() {} });
    const request = f.requests.at(-1);
    assert.equal(request.url, "/api/shifts"); assert.equal(request.method, "POST");
    assert.equal(request.body.departmentId, expected.departmentId); assert.equal(request.body.dutyCode, expected.dutyCode);
    assert.equal(request.body.employeeNumber, "100"); assert.equal(request.body.locationId, "18");
  }
  f.fields["#shiftId"].value = "7"; await f.saveShift({ preventDefault() {} });
  assert.equal(f.requests.at(-1).method, "PUT");
  assert.equal(f.requests.at(-1).url, "/api/shifts/7");
  f.setGuard(true); await f.saveShift({ preventDefault() {} });
  assert.equal(f.requests.length, 4, "manual/automatic editing guards remain authoritative");
});

test("every timeline shift has its resolved compact code, full accessible label and unchanged employee color", () => {
  const f = fixture();
  f.state.data.shifts = [
    { id: 1, employee_number: "100", duty_code: "", department_id: null },
    { id: 2, employee_number: "101", duty_code: "department", department_id: 1 },
    { id: 3, employee_number: "102", duty_code: "department", department_id: 2 },
    { id: 4, employee_number: "103", duty_code: "general", department_id: null, area: '<img src=x onerror="alert(1)">' },
  ].map(shift => ({ shift_date: "2026-09-07", start_time: "09:00", end_time: "10:00", counted_minutes: 60, ...shift }));
  f.renderTimeline();
  const result = f.elements.timeline.innerHTML;
  assert.equal((result.match(/class="shift-duty-badge"/g) || []).length, 4);
  for (const code of ["FL", "HW", "FO", "AG"]) assert.match(result, new RegExp('class="shift-duty-badge"[^>]+aria-hidden="true">' + code + '<\\/span>'));
  for (const label of ["Filialaufsicht", "Hardware", "Fotowelt", "Allgemeiner Dienst"]) assert.ok(result.includes(' · ' + label));
  assert.match(result, /aria-label="Leitung · 100 · 09:00–10:00 · 60 · Filialaufsicht"/);
  assert.match(result, /--employee-color:#dbac19/); assert.match(result, /--employee-color:#11aa77/);
  assert.doesNotMatch(result, /<img|<button[^>]*shift-duty-badge/);
  assert.equal(f.properties["--day-min-width"], "128px");
  assert.equal((result.match(/data-shift-id=/g) || []).length, 4, "badge is not a second action");
});

test("manual planning permits closed weekdays and Sunday within shared 07–23 bounds", () => {
  const f = fixture();
  f.setOperatingHours(() => null);
  f.openShiftModal("100", "2026-09-13");
  assert.equal(f.opened, 1);
  for (const id of ["#shiftStart", "#shiftEnd"]) {
    assert.equal(f.fields[id].min, "07:00"); assert.equal(f.fields[id].max, "23:00");
  }
  assert.equal(f.fields["#shiftStart"].value, "09:00");
  assert.equal(f.fields["#shiftEnd"].value, "17:00");
  f.renderTimeline();
  assert.ok(f.elements.timeline.innerHTML.includes(">07:00</span>"));
  assert.ok(f.elements.timeline.innerHTML.includes(">23:00</span>"));
  f.state.data.shifts = [{ id: 9, employee_number: "100", shift_date: "2026-09-13", start_time: "07:00", end_time: "23:00", duty_code: "general" }];
  assert.equal(f.state.data.settings.show_sunday, undefined);
  f.renderTimeline(); assert.equal(f.properties["--day-count"], 7);
  assert.match(f.elements.timeline.innerHTML, /data-date="2026-09-13"/);
  f.state.data.shifts = []; f.state.data.weekOptions = [{ date_from: "2026-09-13", date_to: "2026-09-13", all_day: 1 }];
  assert.equal(f.scheduleHasSundayEntries(), true);
});

test("timeline initials, full-name accessibility and company palette use the canonical shared helpers", () => {
  const f = fixture();
  Object.assign(f.employees[0], { full_name: "Seiwald Christian", nickname: "Christian", position_name: "Teamleitung" });
  f.state.data.settings.schedule_duty_colors = JSON.stringify({ FL: "#FFFF00", HW: "#000000", FO: "#FF00FF", AG: "#FFFFFF" });
  f.state.data.shifts = [{ id: 1, employee_number: "100", shift_date: "2026-09-07", start_time: "07:00", end_time: "08:00", duty_code: "branch_supervision" }];
  f.renderTimeline();
  const result = f.elements.timeline.innerHTML;
  assert.match(result, /<strong>CS<\/strong><small>100<\/small>/);
  assert.doesNotMatch(result, /<strong>Christian<\/strong>/);
  assert.match(result, /title="Seiwald Christian · 100 · Teamleitung" aria-label="Seiwald Christian · 100 · Teamleitung" tabindex="0"/);
  assert.match(result, /--duty-color:#FFFF00;--duty-contrast:#000000/);
  assert.match(result, /aria-label="Seiwald Christian · 100 · Teamleitung · 2026-09-07"/);
});

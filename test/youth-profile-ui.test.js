"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const school = require("../public/vocational-school");
const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

function between(start, end) {
  const from = app.indexOf(start), to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} / ${end}`);
  return app.slice(from, to);
}

function control(value = "") {
  return { value, checked: false, disabled: false, required: false, type: "text", textContent: "",
    validityMessage: "", setCustomValidity(message) { this.validityMessage = message; },
    classList: { hidden: false, toggle(name, hidden) { this[name] = hidden; }, add() {}, remove() {} } };
}

function optionContext() {
  const controls = new Map();
  const node = (selector) => {
    if (!controls.has(selector)) controls.set(selector, control());
    return controls.get(selector);
  };
  node("#optionType").value = "vocational_school";
  node("#optionEmployee").value = "synthetic-youth";
  node("#optionAllDay").checked = true;
  node("#optionDateFrom").value = node("#optionDateTo").value = "2030-10-07";
  node("#optionStartTime").value = "07:45";
  node("#optionEndTime").value = "16:30";
  node("#optionSchoolKind").value = "regular";
  node("#optionSchoolSpecialCase").value = "none";
  const calls = [], toasts = [];
  const context = vm.createContext({ document: { querySelector: node }, window: { GPVocationalSchool: school }, Intl,
    state: { locationId: "synthetic-site", departmentId: null, weekStart: "2030-10-07",
      data: { employees: [{ personnel_number: "synthetic-youth", contracted_hours: 38.5 }] } },
    guardScheduleEditing: () => false, isLocationPlannerSession: () => false,
    timeToMinutes: (value) => value.split(":").reduce((hours, minutes) => Number(hours) * 60 + Number(minutes)),
    showToast: (message, error) => toasts.push({ message, error }),
    api: async (url, request) => { calls.push({ url, ...request, body: JSON.parse(request.body) }); },
    loadAll: async () => {}, renderOptionList: () => {}, resetOptionEditor: () => {},
  });
  vm.runInContext(between("function fillOptionSchoolDetails(", "function handleOptionTypeChange("), context);
  vm.runInContext(between("function handleOptionTypeChange(", "function openAutoPlanModal("), context);
  vm.runInContext(between("async function saveOption(", "async function saveGlobalBlock("), context);
  return { context, node, calls, toasts };
}

test("Berufsschule: leere Minuten bleiben unbekannt; ausdrückliche Null ist eine Angabe", () => {
  assert.equal(school.createDetails(), null);
  const partial = school.createDetails({ startTime: "08:00", lunchMinutes: "", travelMinutes: "" });
  assert.equal(partial.lunchMinutes, null);
  assert.equal(partial.travelMinutes, null);
  assert.equal(partial.confirmed, false);
  assert.equal(school.createDetails({ lunchMinutes: "0", travelMinutes: "0" }).lunchMinutes, 0);
  assert.equal(school.createDetails({ confirmed: "true" }), null);
});

test("Berufsschule: Bestätigung benötigt Zeiten, Mittagspause und Quelle", () => {
  const complete = school.createDetails({ startTime: "08:00", endTime: "16:30", lunchMinutes: "30", sourceReference: "synthetischer Stundenplan", confirmed: true });
  assert.equal(school.detailError(complete), "");
  assert.match(school.detailHint(complete), /480 Zeitminuten/);
  for (const patch of [{ lunchMinutes: null }, { sourceReference: "" }, { endTime: "" }, { endTime: "07:00" }, { lunchMinutes: 510 }, { lunchMinutes: 900 }, { travelMinutes: -1 }]) {
    assert.notEqual(school.detailError({ ...complete, ...patch }), "");
  }
  assert.match(school.detailHint({ ...complete, specialCase: "cancelled_lessons" }), /eigene fachliche Prüfung/);
});

test("Berufsschule: Legacy und beide Antwortformate werden ohne erfundene Angaben gelesen", () => {
  assert.equal(school.readDetails({ option_type: "vocational_school", all_day: 1 }), null);
  assert.equal(school.readDetails({ school_details_json: "ungültiges JSON" }), null);
  const details = school.createDetails({ lunchMinutes: 0 });
  assert.deepEqual(school.readDetails({ school_details_json: JSON.stringify(details) }), details);
  assert.equal(school.readDetails({ vocationalSchool: details, school_details_json: "ungültig" }), details);
});

test("Berufsschule: ganztägiger Legacy-Eintrag bleibt ohne Zwangsmigration speicherbar", async () => {
  const { context, node, calls } = optionContext();
  context.updateOptionCreditFields();
  assert.equal(node("#optionAllDay").checked, true);
  assert.equal(node("#optionAllDay").disabled, false);
  assert.equal(node("#optionTimeFields").classList.hidden, true);
  assert.equal(node("#optionSchoolDetails").classList.hidden, false);
  assert.equal(node("#optionSchoolDetails").disabled, false);
  await context.saveOption({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.allDay, true);
  assert.equal(calls[0].body.vocationalSchool, null);
});

test("Berufsschule: Typwechsel beginnt weiterhin ganztägig, regulärer Unterricht lässt Zeitfenster zu", () => {
  const { context, node } = optionContext();
  node("#optionAllDay").checked = false;
  context.handleOptionTypeChange();
  assert.equal(node("#optionAllDay").checked, true);
  assert.equal(node("#optionAllDay").disabled, false);
});

test("Berufsschule: zeitliche Nichtverfügbarkeit bleibt von Unterricht und Wegezeit getrennt", async () => {
  const { context, node, calls } = optionContext();
  node("#optionAllDay").checked = false;
  context.fillOptionSchoolDetails({ version: 1, kind: "regular", specialCase: "none", startTime: "08:00", endTime: "16:00",
    lunchMinutes: 30, travelMinutes: 25, sourceReference: "synthetischer Stundenplan", confirmed: true });
  context.updateOptionCreditFields();
  assert.equal(node("#optionTimeFields").classList.hidden, false);
  assert.equal(node("#optionSchoolLunchMinutes").required, true);
  await context.saveOption({ preventDefault() {} });
  assert.equal(calls[0].body.startTime, "07:45");
  assert.equal(calls[0].body.endTime, "16:30");
  assert.equal(calls[0].body.vocationalSchool.startTime, "08:00");
  assert.equal(calls[0].body.vocationalSchool.endTime, "16:00");
  assert.equal(calls[0].body.vocationalSchool.travelMinutes, 25);
});

test("Berufsschule: Block- und Saisonunterricht bleiben ganztägig gesperrt", () => {
  for (const kind of ["block", "seasonal"]) {
    const { context, node } = optionContext();
    node("#optionAllDay").checked = false;
    node("#optionSchoolKind").value = kind;
    context.updateOptionCreditFields();
    assert.equal(node("#optionAllDay").checked, true);
    assert.equal(node("#optionAllDay").disabled, true);
    assert.equal(node("#optionSchoolDetails").disabled, false);
    assert.equal(node("#optionSchoolStartTime").disabled, false);
  }
});

test("Berufsschule: das zeitliche Fenster darf den Unterricht nicht verkürzen", async () => {
  const { context, node, calls, toasts } = optionContext();
  node("#optionAllDay").checked = false;
  node("#optionStartTime").value = "09:00";
  node("#optionSchoolStartTime").value = "08:00";
  node("#optionSchoolEndTime").value = "16:00";
  await context.saveOption({ preventDefault() {} });
  assert.equal(calls.length, 0);
  assert.match(toasts[0].message, /gesamten Unterrichtszeitraum/);
});

test("Berufsschule: unvollständige Bestätigung wird vor dem Speichern abgewiesen", async () => {
  const { context, node, calls, toasts } = optionContext();
  node("#optionSchoolConfirmed").checked = true;
  await context.saveOption({ preventDefault() {} });
  assert.equal(calls.length, 0);
  assert.match(toasts[0].message, /Unterrichtszeiten, Mittagspause und Quelle/);
});

test("Berufsschule: Formularwechsel löscht alte Bestätigung; andere Optionen senden keine Schuldaten", async () => {
  const { context, node, calls } = optionContext();
  context.fillOptionSchoolDetails({ version: 1, kind: "regular", specialCase: "none", startTime: "08:00", endTime: "12:00",
    lunchMinutes: 0, travelMinutes: 0, sourceReference: "synthetisch", confirmed: true });
  assert.equal(node("#optionSchoolLunchMinutes").value, 0);
  context.fillOptionSchoolDetails(null);
  assert.equal(node("#optionSchoolLunchMinutes").value, "");
  assert.equal(node("#optionSchoolConfirmed").checked, false);
  assert.equal(node("#optionSchoolSourceReference").value, "");
  node("#optionType").value = "school";
  context.updateOptionCreditFields();
  assert.equal(node("#optionSchoolDetails").disabled, true);
  await context.saveOption({ preventDefault() {} });
  assert.equal(Object.hasOwn(calls[0].body, "vocationalSchool"), false);
});

test("Personalakt: Position und Freitext erzeugen keinen bestätigten Lehrlingsstatus", () => {
  const context = vm.createContext({ window: { GPVocationalSchool: school } });
  vm.runInContext(between("function normalizeProtectedPersonnelRecord(", "function employeeRecordControl("), context);
  const result = context.normalizeProtectedPersonnelRecord({ sensitive: { employment: { employmentType: "Lehrling", classification: "apprentice" } } });
  assert.equal(result.sensitive.employment.apprenticeshipStatus, "unknown");
  assert.equal(result.sensitive.employment.apprenticeshipConfirmed, false);
  assert.equal(result.sensitive.employment.apprenticeshipValidFrom, "");
  assert.equal(result.sensitive.employment.apprenticeshipSourceReference, "");
  assert.match(school.apprenticeshipHint("active", true), /unvollständig/);
  assert.match(school.apprenticeshipHint("active", true, { validFrom: "2030-09-01", sourceReference: "synthetischer Lehrvertrag" }), /fachlich bestätigt/);
});

test("Personalakt: Speichern verwendet Boolesche Bestätigung und respektiert einzelne Feldrechte", async () => {
  const fields = { apprenticeshipStatus: control("active"), apprenticeshipConfirmed: { ...control("on"), type: "checkbox", checked: false }, apprenticeshipSourceReference: control("nicht freigegeben") };
  const calls = [];
  const context = vm.createContext({ window: { GPVocationalSchool: school },
    state: { personnelRecord: { employeeNumber: "synthetic-youth", result: { access: { fieldAccess: {
      "employment.apprenticeshipStatus": "write", "employment.apprenticeshipConfirmed": "write", "employment.apprenticeshipSourceReference": "hidden",
    } } } }, personnelRecordDirtyFields: new Set(["employment.apprenticeshipStatus", "employment.apprenticeshipConfirmed", "employment.apprenticeshipSourceReference"]) },
    elements: { personnelRecordForm: { elements: { namedItem: (name) => fields[name] } }, savePersonnelRecordButton: control(), personnelRecordMessage: control() },
    showToast() {}, api: async (url, request) => { calls.push(JSON.parse(request.body)); return {}; }, openPersonnelRecord: async () => {},
  });
  vm.runInContext(between("const PERSONNEL_RECORD_FORM_FIELDS", "function personnelRecordSectionMode("), context);
  vm.runInContext(between("function withPersonnelPlanningStatusBasis(", "function personnelRecordPatch("), context);
  vm.runInContext(between("async function savePersonnelRecord(", "async function uploadPersonnelDocument("), context);
  await context.savePersonnelRecord({ preventDefault() {} });
  assert.deepEqual(calls[0], { sensitive: { employment: { apprenticeshipStatus: "active", apprenticeshipConfirmed: false } } });
});

test("Personalakt: Bestätigung verlangt datierte Grundlage und lässt ungeklärte Angaben offen", () => {
  const fields = Object.fromEntries(["Status", "Confirmed", "ValidFrom", "ValidTo", "SourceReference"].map((suffix) => [`apprenticeship${suffix}`, control()]));
  fields.apprenticeshipStatus.value = "completed";
  fields.apprenticeshipConfirmed.checked = true;
  const hint = control();
  const context = vm.createContext({ window: { GPVocationalSchool: school } });
  vm.runInContext(between("function updateApprenticeshipHint(", "function personnelRecordDetails("), context);
  const form = { elements: { namedItem: (name) => fields[name] } };
  context.updateApprenticeshipHint(form, "", hint);
  assert.equal(fields.apprenticeshipValidFrom.required, true);
  assert.equal(fields.apprenticeshipValidTo.required, true);
  assert.equal(fields.apprenticeshipSourceReference.required, true);
  assert.match(hint.textContent, /unvollständig/);
  fields.apprenticeshipConfirmed.checked = false;
  context.updateApprenticeshipHint(form, "", hint);
  assert.equal(fields.apprenticeshipValidFrom.required, false);
  assert.equal(fields.apprenticeshipValidFrom.value, "");
});

test("Personalakt: verborgene Basis und Bestätigung werden nicht als fehlende Daten ausgegeben", () => {
  const context = vm.createContext({ window: { GPVocationalSchool: school } });
  vm.runInContext(between("function updateApprenticeshipHint(", "function personnelRecordDetails("), context);
  const fields = { apprenticeshipStatus: control("active"), apprenticeshipConfirmed: { ...control(), checked: true, disabled: true } };
  const hint = control(), form = { elements: { namedItem: (name) => fields[name] } };
  context.updateApprenticeshipHint(form, "", hint);
  assert.match(hint.textContent, /fachlich bestätigt/);
  assert.match(hint.textContent, /nicht vollständig freigegeben/);
  assert.doesNotMatch(hint.textContent, /unvollständig|ungeklärt|angeben/);
  delete fields.apprenticeshipConfirmed;
  context.updateApprenticeshipHint(form, "", hint);
  assert.match(hint.textContent, /Bestätigung.*nicht freigegeben/);
  assert.doesNotMatch(hint.textContent, /fachlich ungeklärt/);
});

test("Personalakt: beide Formulare unterscheiden Lehrzeitraum und sonstige Statusgültigkeit", () => {
  const context = vm.createContext({ window: { GPVocationalSchool: school } });
  vm.runInContext(between("function updateApprenticeshipHint(", "function personnelRecordDetails("), context);
  for (const prefix of ["", "employeeRecord"]) {
    const fromLabel = control(), toLabel = control();
    const fields = { apprenticeshipStatus: control("active"), apprenticeshipConfirmed: control(),
      apprenticeshipValidFrom: { ...control(), closest: () => ({ querySelector: () => fromLabel }) },
      apprenticeshipValidTo: { ...control(), closest: () => ({ querySelector: () => toLabel }) }, apprenticeshipSourceReference: control() };
    const names = Object.fromEntries(Object.entries(fields).map(([name, value]) => [prefix ? `${prefix}${name[0].toUpperCase()}${name.slice(1)}` : name, value]));
    const form = { elements: { namedItem: (name) => names[name] } }, hint = control();
    context.updateApprenticeshipHint(form, prefix, hint);
    assert.equal(fromLabel.textContent, "Belegter Lehrbeginn");
    assert.equal(toLabel.textContent, "Letzter Lehrtag (einschließlich)");
    fields.apprenticeshipStatus.value = "completed";
    fields.apprenticeshipConfirmed.checked = true;
    context.updateApprenticeshipHint(form, prefix, hint);
    assert.equal(fields.apprenticeshipValidTo.required, true);
    assert.match(hint.textContent, /letzten Lehrtag \(einschließlich\)/);
    fields.apprenticeshipStatus.value = "not_apprentice";
    context.updateApprenticeshipHint(form, prefix, hint);
    assert.equal(fromLabel.textContent, "Gültig ab");
    assert.equal(toLabel.textContent, "Gültig bis");
    assert.equal(fields.apprenticeshipValidTo.required, false);
  }
});

test("UI: Berufsschulfelder sind beschriftet, optional ausgeblendet und vor app.js geladen", () => {
  assert.match(html, /<fieldset class="option-school-details hidden" id="optionSchoolDetails" disabled>/);
  assert.match(html, /id="optionSchoolLunchMinutes"[^>]*placeholder="Ungeklärt"/);
  assert.match(html, /id="optionSchoolHint" role="status"/);
  assert.ok(html.indexOf('src="/vocational-school.js"') < html.indexOf('src="/app.js"'));
  for (const suffix of ["Status", "Confirmed", "ValidFrom", "ValidTo", "SourceReference"]) {
    assert.match(html, new RegExp(`name="employeeRecordApprenticeship${suffix}"`));
  }
  assert.match(html, /name="employeeRecordApprenticeshipSourceReference" maxlength="240"/);
  assert.match(app, /personnelRecordField\("apprenticeshipSourceReference"[^\n]+maxlength="240"/);
});

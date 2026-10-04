"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const protection = require("../public/planning-protection");
const school = require("../public/vocational-school");
const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

function between(start, end) {
  const from = app.indexOf(start), to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} / ${end}`);
  return app.slice(from, to);
}

function period(patch = {}) {
  return { id: "synthetic-1", phase: "pregnancy", confirmed: true, validFrom: "2030-10-01", validTo: "",
    referenceId: "HR:SYN/1", normalDailyMinutes: null, ...patch };
}

function status(patch = {}) {
  return { version: 1, planningEnabled: true, periods: [period()], ...patch };
}

function editor(value = null, mode = "write", prefix = "personnelRecord") {
  const node = { dataset: { protectionEditor: prefix, protectionAccess: mode, protectionNull: value ? "false" : "true" },
    enabled: { checked: value?.planningEnabled === true }, hint: { textContent: "" },
    rows: (value?.periods || []).map((item) => {
      const controls = Object.fromEntries(Object.entries(item).map(([key, itemValue]) => [key, {
        value: itemValue ?? "", checked: itemValue === true, disabled: mode !== "write", dataset: { protectionProperty: key },
      }]));
      const row = { dataset: { protectionPeriod: item.id }, controls,
        querySelector(selector) { return controls[/data-protection-property="([^"]+)"/.exec(selector)?.[1]] || null; } };
      for (const control of Object.values(controls)) control.closest = (selector) => selector === "[data-protection-editor]" ? node : row;
      return row;
    }),
    querySelector(selector) { return selector === "[data-protection-hint]" ? this.hint : this.enabled; },
    querySelectorAll() { return this.rows; },
  };
  node.enabled.dataset = { protectionProperty: "planningEnabled" };
  node.enabled.closest = () => node;
  return node;
}

function context(extra = {}) {
  const ctx = vm.createContext({
    window: { GPPlanningProtection: protection, GPVocationalSchool: school },
    state: { portalSession: { user: { role: "hr" } }, personnelRecordDirtyFields: new Set() },
    escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    escapeHtmlAttribute: (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"),
    ...extra,
  });
  vm.runInContext(between("function personnelRecordAccessMode(", "function personnelRecordSectionMode("), ctx);
  vm.runInContext(between("function withPersonnelPlanningStatusBasis(", "function personnelRecordPatch("), ctx);
  vm.runInContext(between("function renderPersonnelProtectionEditor(", "function updateApprenticeshipHint("), ctx);
  return ctx;
}

test("Schutzstatus: nur HR/Admin mit ausdrücklichem atomarem Feldrecht", () => {
  const access = { canReadSensitive: true, canWriteSensitive: true, fieldAccess: { [protection.FIELD_KEY]: "write" } };
  for (const role of ["developer", "it_admin", "manager", "department_manager", "location_planner", "employee", "local", ""]) {
    assert.equal(protection.accessMode(access, role), "hidden");
  }
  assert.equal(protection.accessMode(access, "hr"), "write");
  assert.equal(protection.accessMode({ fieldAccess: { [protection.FIELD_KEY]: "read" } }, "admin"), "read");
  for (const role of ["hr", "admin"]) assert.equal(protection.accessMode({ canWriteSensitive: true }, role), "hidden");
});

test("Schutzstatus: realistischer lokaler Admin erhält auch mit manipuliertem Feldrecht keine UI-Freigabe", () => {
  const access = { canWriteSensitive: true, fieldAccess: { [protection.FIELD_KEY]: "write" } };
  const ctx = context();
  ctx.state.portalSession.user.role = "admin";
  ctx.state.portalStatus = { portalEnabled: false };
  assert.equal(ctx.personnelRecordAccessMode(access, protection.FIELD_KEY), "hidden");
  ctx.state.portalStatus.portalEnabled = true;
  ctx.state.portalSession.user.employeeNumber = "local";
  assert.equal(ctx.personnelRecordAccessMode(access, protection.FIELD_KEY), "hidden");
  ctx.state.portalSession.user.employeeNumber = "synthetic-admin";
  ctx.state.portalSession.user.localSystem = true;
  assert.equal(ctx.personnelRecordAccessMode(access, protection.FIELD_KEY), "hidden");
  ctx.state.portalSession.user.localSystem = false;
  assert.equal(ctx.personnelRecordAccessMode(access, protection.FIELD_KEY), "write");
});

test("Schutzstatus: unbekannte/Legacy-Daten werden nicht automatisch aktiviert oder medizinisch ergänzt", () => {
  assert.equal(protection.copyStatus(undefined), null);
  assert.equal(protection.copyStatus("pregnancy"), null);
  assert.equal(protection.copyStatus({ version: 2, periods: [] }), null);
  const minimal = protection.copyStatus(status({ planningEnabled: "true", diagnosis: "synthetic", dueDate: "2031-01-01",
    periods: [period({ birthDate: "2030-12-01", sourceReference: "synthetic medical prose" })] }));
  assert.equal(minimal.planningEnabled, false);
  assert.equal(Object.hasOwn(minimal, "dueDate"), false);
  assert.equal(Object.hasOwn(minimal.periods[0], "birthDate"), false);
  assert.equal(Object.hasOwn(minimal.periods[0], "sourceReference"), false);
  assert.equal(protection.createPeriod("new-id").validFrom, "");
  assert.equal(protection.createPeriod("new-id").normalDailyMinutes, null);
});

test("Schutzstatus: echte Datums-, ID-, Bestätigungs- und Minutengrenzen", () => {
  assert.equal(protection.statusError(null), "");
  assert.equal(protection.statusError(status()), "");
  assert.equal(protection.statusError(status({ periods: [] })), "");
  for (const patch of [{ validFrom: "2030-02-29" }, { validFrom: "" }, { validTo: "2030-09-30" }, { referenceId: "HR Name" },
    { referenceId: "x".repeat(81) }, { confirmed: true, referenceId: "" }, { confirmed: "true" }, { phase: "unknown" }, { phase: "diagnosis" },
    { id: "unsafe/id" }, { normalDailyMinutes: 0 }, { normalDailyMinutes: 541 }, { normalDailyMinutes: 60.5 }, { normalDailyMinutes: "60" }]) {
    assert.notEqual(protection.statusError(status({ periods: [period(patch)] })), "", JSON.stringify(patch));
  }
  assert.equal(protection.statusError(status({ periods: [period({ normalDailyMinutes: 1, validTo: "2030-10-01" })] })), "");
  assert.equal(protection.statusError(status({ periods: [period({ normalDailyMinutes: 540 })] })), "");
  assert.equal(protection.strictDate("2032-02-29"), true);
  assert.notEqual(protection.statusError(status({ periods: [period(), period()] })), "");
  assert.notEqual(protection.statusError(status({ periods: Array.from({ length: 33 }, (_, i) => period({ id: `p${i}` })) })), "");
});

test("Beide Personalformulare: verborgener Schutzstatus hat keinerlei Formularinhalt", () => {
  const ctx = context();
  assert.equal(ctx.renderPersonnelProtectionEditor(status(), "hidden", "test"), "");
  const read = ctx.renderPersonnelProtectionEditor(status(), "read", "test");
  assert.match(read, /Schwangerschaft/);
  assert.match(read, /disabled/);
  assert.doesNotMatch(read, /data-protection-add|data-protection-remove/);
  const write = ctx.renderPersonnelProtectionEditor(status(), "write", "test");
  assert.match(write, /data-protection-add/);
  assert.match(write, /data-protection-remove/);
  assert.match(write, /Letzter Gültigkeitstag \(einschließlich\)/);
  assert.match(write, /Zulässige tägliche Normalarbeitszeit · Minuten/);
  assert.match(write, /Fachlich bestätigte Gesetz\/KV-Grenze\. Leer bleibt ungeklärt; vertragliche Teilzeit-Sollstunden werden gesondert geplant\./);
  assert.doesNotMatch(write, /Reguläre tägliche Arbeitszeit/);
  assert.match(write, /pattern="\[A-Za-z0-9\._:\/-\]\+"/);
  assert.ok(html.indexOf('/planning-protection.js') < html.indexOf('/app.js'));
  assert.match(html, /class="protected-record-section hidden" id="employeeRecordProtectionStatus"/);
});

test("Schutzstatus: Formulardaten bleiben echte boolesche/strukturierte Werte und leere Minuten null", () => {
  const ctx = context(), form = editor(status({ periods: [period({ normalDailyMinutes: null })] }));
  assert.equal(ctx.readPersonnelProtectionEditor(editor()), null);
  const result = ctx.readPersonnelProtectionEditor(form);
  assert.equal(result.periods[0].normalDailyMinutes, null);
  assert.equal(result.periods[0].confirmed, true);
  assert.equal(typeof result, "object");
  form.rows[0].controls.normalDailyMinutes.value = "480";
  assert.equal(ctx.readPersonnelProtectionEditor(form).periods[0].normalDailyMinutes, 480);
});

test("Schutzstatus: jede Basisänderung entbestätigt nur den bearbeiteten Zeitraum; Checkbox bestätigt ausdrücklich", () => {
  for (const property of ["phase", "validFrom", "validTo", "referenceId", "normalDailyMinutes"]) {
    const ctx = context(), form = editor(status({ periods: [period(), period({ id: "synthetic-2" })] }));
    ctx.handlePersonnelProtectionInput({ target: form.rows[0].controls[property] });
    assert.equal(form.rows[0].controls.confirmed.checked, false, property);
    assert.equal(form.rows[1].controls.confirmed.checked, true, property);
    assert.equal(ctx.state.personnelRecordDirtyFields.has(protection.FIELD_KEY), true);
    form.rows[0].controls.confirmed.checked = true;
    ctx.handlePersonnelProtectionInput({ target: form.rows[0].controls.confirmed });
    assert.equal(form.rows[0].controls.confirmed.checked, true);
  }
  const ctx = context(), read = editor(status(), "read");
  ctx.handlePersonnelProtectionInput({ target: read.rows[0].controls.phase });
  assert.equal(read.rows[0].controls.confirmed.checked, true);
  assert.equal(ctx.state.personnelRecordDirtyFields.size, 0);
});

test("Schutzstatus: Zeitraum hinzufügen/entfernen erhält bestehende IDs und setzt den Tastaturfokus", () => {
  const form = editor(status()), focus = { count: 0, focus() { this.count++; } };
  const ctx = context({ document: { querySelector: () => ({ querySelector: () => focus }) } });
  const add = { disabled: false, closest: () => form, hasAttribute: (key) => key === "data-protection-add" };
  ctx.handlePersonnelProtectionClick({ target: { closest: () => add } });
  assert.match(form.outerHTML, /data-protection-period="synthetic-1"/);
  assert.match(form.outerHTML, /Zeitraum 2/);
  assert.match(form.outerHTML, /data-protection-period="p-[A-Za-z0-9._-]+"/);
  assert.equal(focus.count, 1);
  assert.equal(ctx.state.personnelRecordDirtyFields.has(protection.FIELD_KEY), true);
  const remove = { disabled: false, hasAttribute: () => false,
    closest: (selector) => selector === "[data-protection-editor]" ? form : form.rows[0] };
  ctx.handlePersonnelProtectionClick({ target: { closest: () => remove } });
  assert.doesNotMatch(form.outerHTML, /data-protection-period=/);
  assert.equal(focus.count, 2);
  const full = editor(status({ periods: Array.from({ length: 32 }, (_, i) => period({ id: `p${i}` })) }));
  add.closest = () => full;
  assert.equal(ctx.handlePersonnelProtectionClick({ target: { closest: () => add } }), true);
  assert.equal(full.outerHTML, undefined);
});

test("Schreibsperre laden/aufheben öffnet kein readonly Schutzfeld", () => {
  const form = editor(status(), "read", "employeeRecord"), normal = { disabled: true, closest: () => null };
  const controls = [normal, ...Object.values(form.rows[0].controls)];
  const ctx = context({ elements: { employeeProtectedRecord: { querySelectorAll: (selector) => selector === "input,select,textarea" ? controls : [] } } });
  vm.runInContext(between("function setEmployeeProtectedRecordDisabled(", "function collectEmployeeProtectedRecord("), ctx);
  ctx.setEmployeeProtectedRecordDisabled(false);
  assert.equal(normal.disabled, false);
  assert.equal(form.rows[0].controls.phase.disabled, true);
  assert.equal(form.rows[0].controls.confirmed.disabled, true);
});

test("Personalakt-Patch: Änderungen in Objektperioden werden atomar erkannt", () => {
  const ctx = context();
  vm.runInContext(between("function personnelRecordPatch(", "function clearEmployeeProtectedRecord("), ctx);
  const before = { employment: { protectionStatus: status({ periods: [period(), period({ id: "second" })] }) } };
  const after = structuredClone(before);
  after.employment.protectionStatus.periods[1].validTo = "2030-11-30";
  after.employment.protectionStatus.periods[1].confirmed = false;
  const patch = ctx.personnelRecordPatch(before, after);
  assert.deepEqual(JSON.parse(JSON.stringify(patch)), after);
  assert.equal(ctx.personnelRecordPatch(before, structuredClone(before)).employment, undefined);
  assert.equal(ctx.personnelRecordPatch(before, { employment: { protectionStatus: null } }).employment.protectionStatus, null);
});

test("Eingebettetes Formular: Hidden-/Read-Felder werden selbst bei manipuliertem DOM nicht gesendet; Jugendfelder bleiben", () => {
  const form = editor(status(), "write", "employeeRecord");
  const controls = { employeeRecordApprenticeshipStatus: { value: "active" }, employeeRecordApprenticeshipConfirmed: { checked: true },
    employeeRecordApprenticeshipSourceReference: { value: "synthetic-contract" } };
  const ctx = context({ document: { querySelector: () => form }, employeeRecordControl: (name) => controls[name] || null });
  vm.runInContext(between("function collectEmployeeProtectedRecord(", "async function loadEmployeeProtectedRecord("), ctx);
  for (const role of ["hr", "developer", "it_admin", "location_planner", "local"]) {
    for (const level of ["hidden", "read", "write"]) {
      ctx.state.portalSession.user.role = role;
      ctx.state.employeePersonnelRecord = { access: { fieldAccess: { [protection.FIELD_KEY]: level } } };
      const result = ctx.collectEmployeeProtectedRecord();
      assert.equal(Object.hasOwn(result.sensitive.employment, "protectionStatus"), role === "hr" && level === "write", `${role}/${level}`);
      assert.equal(result.sensitive.employment.apprenticeshipStatus, "active");
      assert.equal(result.sensitive.employment.apprenticeshipConfirmed, true);
    }
  }
});

test("Separater Personalakt: vollständiges Objekt wird ausschließlich mit ausdrücklichem Schreibrecht gespeichert", async () => {
  const form = editor(status()), calls = [], toasts = [];
  const ctx = context({ elements: { personnelRecordForm: { elements: { namedItem: () => null } },
    personnelRecordContent: { querySelector: () => form }, savePersonnelRecordButton: {}, personnelRecordMessage: { classList: { add() {}, remove() {} } } },
    PERSONNEL_RECORD_FORM_FIELDS: [], api: async (url, request) => { calls.push(JSON.parse(request.body)); return { changedFields: [protection.FIELD_KEY] }; },
    openPersonnelRecord: async () => {}, showToast: (text) => toasts.push(text),
  });
  vm.runInContext(between("async function savePersonnelRecord(", "async function uploadPersonnelDocument("), ctx);
  ctx.state.personnelRecord = { employeeNumber: "synthetic-person", result: { access: { fieldAccess: { [protection.FIELD_KEY]: "write" } }, planningStatusBasis: { [protection.FIELD_KEY]: "a".repeat(64) } } };
  ctx.state.personnelRecordDirtyFields.add(protection.FIELD_KEY);
  await ctx.savePersonnelRecord({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].sensitive.employment.protectionStatus, status());
  assert.equal(calls[0].planningStatusBasis[protection.FIELD_KEY], "a".repeat(64));
  form.rows[0].controls.validFrom.value = "2030-02-29";
  await ctx.savePersonnelRecord({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.match(toasts.at(-1), /gültiges Anfangsdatum/);
  ctx.state.personnelRecord.result.access.fieldAccess[protection.FIELD_KEY] = "read";
  await ctx.savePersonnelRecord({ preventDefault() {} });
  assert.equal(calls.length, 1);
});

test("Personalaktwechsel: fehlendes Feldrecht entfernt den vorigen vertraulichen Inhalt", () => {
  const host = { innerHTML: "", classList: { toggle(name, value) { this[name] = value; } } };
  const ctx = context({ document: { querySelector: () => host } });
  ctx.fillEmployeeProtectionEditor(status(), { fieldAccess: { [protection.FIELD_KEY]: "write" } });
  assert.match(host.innerHTML, /HR:SYN\/1/);
  ctx.fillEmployeeProtectionEditor(null, { canWriteSensitive: true });
  assert.equal(host.innerHTML, "");
  assert.equal(host.classList.hidden, true);
});

test("Leitungs-Feldrechtematrix: Schutzstatus bietet einzig hidden/disabled; andere Rechte bleiben bearbeitbar", () => {
  const matrix = { innerHTML: "", querySelectorAll: () => [] };
  const ctx = context({ elements: { personnelFieldRightsMatrix: matrix, personnelFieldRightsRole: {},
    savePersonnelFieldRightsButton: {}, personnelFieldRightsHint: {} },
    personnelFieldLevelLabel: (value) => value, personnelFieldGroupSummary: () => {},
  });
  ctx.state.personnelFieldRights = { canChange: true, roles: [{ id: "manager", label: "Leitung" }],
    fields: [{ key: protection.FIELD_KEY, label: "Vertraulicher Planungsschutzstatus", group: "Planungsschutz", sensitive: true },
      { key: "identity.firstName", label: "Vorname", group: "Identität" }],
    matrix: { manager: { [protection.FIELD_KEY]: "write", "identity.firstName": "read" } },
  };
  ctx.state.personnelFieldRightsDrafts = {};
  ctx.state.personnelFieldRightsDirtyRoles = new Set();
  ctx.state.selectedPersonnelFieldRightsRole = "manager";
  vm.runInContext(between("function renderPersonnelFieldRights(", "async function loadRightsManagement("), ctx);
  ctx.renderPersonnelFieldRights();
  const restricted = /<select data-personnel-field-right="employment\.protectionStatus"[\s\S]*?<\/select>/.exec(matrix.innerHTML)?.[0];
  assert.ok(restricted);
  assert.match(restricted, /disabled/);
  assert.match(restricted, /option value="hidden" selected/);
  assert.doesNotMatch(restricted, /option value="read"|option value="write"/);
  const ordinary = /<select data-personnel-field-right="identity\.firstName"[\s\S]*?<\/select>/.exec(matrix.innerHTML)?.[0];
  assert.doesNotMatch(ordinary, /disabled/);
  assert.match(ordinary, /option value="read" selected/);
  assert.match(ordinary, /option value="write"/);
  assert.match(matrix.innerHTML, /Nur berechtigte HR\/Admin/);
  assert.doesNotMatch(matrix.innerHTML, /MSchG|Schwangerschaft|Stillzeit/);
});

test("Leitungs-Feldrechtematrix: manipuliertes Schutzstatus-Change stellt hidden wieder her", () => {
  let callback;
  const ctx = context({ elements: { personnelFieldRightsMatrix: { addEventListener: (name, handler) => { callback = handler; } } } });
  ctx.state.personnelFieldRightsDrafts = {};
  ctx.state.personnelFieldRightsDirtyRoles = new Set();
  ctx.state.selectedPersonnelFieldRightsRole = "manager";
  vm.runInContext(between('elements.personnelFieldRightsMatrix?.addEventListener("change",', 'elements.savePersonnelFieldRightsButton?.addEventListener('), ctx);
  const select = { dataset: { personnelFieldRight: protection.FIELD_KEY }, value: "write", disabled: false };
  callback({ target: { closest: () => select } });
  assert.equal(select.value, "hidden");
  assert.equal(select.disabled, true);
  assert.equal(ctx.state.personnelFieldRightsDirtyRoles.size, 0);
  assert.equal(Object.keys(ctx.state.personnelFieldRightsDrafts).length, 0);
});

test("editor sends only loaded opaque bases for submitted structure fields, including deletion", () => {
  const source = typeof app === "string" ? app : code;
  const start = source.indexOf("function withPersonnelPlanningStatusBasis(");
  const end = source.indexOf("\nfunction personnelRecordPatch(",start);
  const ctx = vm.createContext({}); vm.runInContext(source.slice(start,end),ctx);
  const initial = {"employment.protectionStatus":"a".repeat(64),"employment.retailKv":"b".repeat(64)};
  const input = {sensitive:{employment:{protectionStatus:null}}};
  const submitted = ctx.withPersonnelPlanningStatusBasis(input,initial);
  assert.deepEqual(JSON.parse(JSON.stringify(submitted.planningStatusBasis)),{"employment.protectionStatus":"a".repeat(64)});
  initial["employment.protectionStatus"] = "c".repeat(64);
  assert.equal(submitted.planningStatusBasis["employment.protectionStatus"],"a".repeat(64));
  assert.ok(!Object.hasOwn(input,"planningStatusBasis"));
  const ordinary = {phone:"synthetic"}; assert.equal(ctx.withPersonnelPlanningStatusBasis(ordinary,initial),ordinary);
  const combined = ctx.withPersonnelPlanningStatusBasis({sensitive:{employment:{protectionStatus:null,retailKv:{version:1,periods:[]}}}},initial);
  assert.deepEqual(Object.keys(combined.planningStatusBasis).sort(),["employment.protectionStatus","employment.retailKv"]);
});

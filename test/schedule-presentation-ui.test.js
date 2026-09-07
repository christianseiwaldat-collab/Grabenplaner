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
function between(start, end) {
  const from = app.indexOf(start), to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} / ${end}`);
  return app.slice(from, to);
}
function colorFixture(role = "hr", permissions = ["settings:write"]) {
  const state = { portalSession: { user: { role, permissions } }, data: { settings: { schedule_duty_colors: JSON.stringify(duty.DEFAULT_DUTY_COLORS) } } };
  const requests = [], messages = [], rows = new Map();
  const list = { innerHTML: "" }, save = { disabled: false, hidden: false }, hint = { textContent: "" };
  function input(value, dataset) {
    return { value, dataset, custom: "", closest(selector) { return selector === "[data-duty-color-row]" ? rows.get(dataset.dutyColor || dataset.dutyRgb) : this; },
      setCustomValidity(value) { this.custom = value; },
      checkValidity() { return !this.custom && (!this.dataset.dutyRgb || (this.value !== "" && Number.isInteger(Number(this.value)) && Number(this.value) >= 0 && Number(this.value) <= 255)); },
      reportValidity() { return this.checkValidity(); } };
  }
  for (const [code, color] of Object.entries(duty.DEFAULT_DUTY_COLORS)) {
    const properties = {}, picker = input(color, { dutyColor: code });
    const channels = [1, 3, 5].map((offset, index) => input(String(parseInt(color.slice(offset, offset + 2), 16)), { dutyRgb: code, rgbChannel: String(index) }));
    rows.set(code, { dataset: { dutyColorRow: code }, picker, channels, properties,
      querySelectorAll: () => channels,
      querySelector(selector) { return selector === "[data-duty-color]" ? picker : { style: { setProperty(name, value) { properties[name] = value; } } }; } });
  }
  const selectors = { "#scheduleDutyColorList": list, "#saveScheduleDutyColors": save, "#scheduleDutyColorsHint": hint };
  const sandbox = { window: { GPScheduleDuty: duty }, state,
    document: { querySelector(selector) { assert.ok(selectors[selector], selector); return selectors[selector]; }, querySelectorAll() { return [...rows.values()].flatMap(row => row.channels); } },
    api: async (url, options) => { requests.push({ url, method: options.method, body: JSON.parse(options.body) }); return { colors: JSON.parse(options.body).colors }; },
    renderTimeline() {}, showToast(message) { messages.push(message); } };
  vm.createContext(sandbox);
  vm.runInContext(between("function canManageScheduleDutyColors()", "function renderSettings()"), sandbox);
  sandbox.renderScheduleDutyColorSettings();
  return { ...sandbox, list, save, hint, rows, requests, messages };
}

test("company palette is read-only outside PL/developer plus settings permission", async () => {
  for (const role of ["manager", "department_manager", "admin", "it_admin", "employee", undefined]) {
    const f = colorFixture(role);
    // Explicit undefined must not use the fixture's default role.
    if (role === undefined) { f.state.portalSession.user.role = undefined; f.renderScheduleDutyColorSettings(); }
    assert.equal(f.canManageScheduleDutyColors(), false, role);
    assert.equal(f.save.hidden, true);
    assert.equal((f.list.innerHTML.match(/ disabled>/g) || []).length, 4);
    await assert.rejects(f.saveScheduleDutyColors(), /Nur Personalleitung/);
    assert.equal(f.requests.length, 0);
  }
  for (const role of ["hr", "developer"]) {
    const f = colorFixture(role, []);
    assert.equal(f.canManageScheduleDutyColors(), false);
    assert.equal(f.save.hidden, true);
  }
});

test("RGB and color picker stay synchronized, reject invalid values, and save only the dedicated global endpoint", async () => {
  for (const role of ["hr", "developer"]) {
    const f = colorFixture(role), row = f.rows.get("FL");
    row.channels.forEach((channel, index) => { channel.value = String([255, 128, 0][index]); });
    f.updateScheduleDutyColor(row.channels[0]);
    assert.equal(row.picker.value, "#FF8000");
    assert.equal(f.state.scheduleDutyColorDraft.FL, "#FF8000");
    assert.equal(f.save.disabled, false);
    row.channels[0].value = "256"; f.updateScheduleDutyColor(row.channels[0]);
    assert.equal(f.save.disabled, true);
    await assert.rejects(f.saveScheduleDutyColors(), /gültige RGB-Werte/);
    assert.equal(f.requests.length, 0);
    row.picker.value = "#ffffff"; f.updateScheduleDutyColor(row.picker);
    assert.deepEqual(row.channels.map(channel => channel.value), ["255", "255", "255"]);
    assert.equal(row.properties["--duty-contrast"], "#000000");
    await f.saveScheduleDutyColors();
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.requests[0], { url: "/api/settings/schedule-duty-colors", method: "PUT", body: { colors: { ...duty.DEFAULT_DUTY_COLORS, FL: "#FFFFFF" } } });
    assert.equal(JSON.parse(f.state.data.settings.schedule_duty_colors).FL, "#FFFFFF");
    assert.equal(f.state.scheduleDutyColorsDirty, false);
    assert.match(f.hint.textContent, /alle Accounts und Standorte/);
  }
});

test("revoked role cannot update or save a previously enabled palette draft", async () => {
  const f = colorFixture("hr"), row = f.rows.get("HW");
  row.picker.value = "#00FFFF"; f.updateScheduleDutyColor(row.picker);
  f.state.portalSession.user.role = "manager";
  row.picker.value = "#FF0000"; f.updateScheduleDutyColor(row.picker);
  assert.equal(f.state.scheduleDutyColorDraft.HW, "#00FFFF");
  await assert.rejects(f.saveScheduleDutyColors(), /Nur Personalleitung/);
  assert.equal(f.requests.length, 0);
});

test("settings disclosures retain compact responsive columns and neutral theme variables", () => {
  assert.match(css, /#generalSettings > :is\(\.settings-card,\.settings-accordion\) \{[^}]*grid-column:auto/);
  assert.match(css, /#pdfSettings \.pdf-card > \.settings-field-disclosure-body \{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /#pdfSettings #schedulePdfDesignSettings \{ grid-column:auto/);
  assert.match(css, /#pdfSettings \.schedule-pdf-design-settings-list \{ grid-template-columns:repeat\(auto-fit/);
  assert.match(css, /@media \(max-width:820px\)[\s\S]*#pdfSettings \.pdf-card > \.settings-field-disclosure-body \{ grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /\.schedule-duty-color-settings \{[^}]*border:1px solid var\(--line\)[^}]*background:var\(--surface-soft\)/);
  assert.match(html, /id="scheduleDutyColorsTitle">Dienstfarben · unternehmensweit/);
  assert.match(app, /renderSchedulePdfDesignSettings\(\);\s+renderScheduleDutyColorSettings\(\{ preserveDraft: state\.scheduleDutyColorsDirty && canManageScheduleDutyColors\(\) \}\);/);
  assert.match(app, /state\.scheduleDutyColorsDirty && canManageScheduleDutyColors\(\)/);
});

test("PDF preview cannot publish company colors and unsaved draft survives only for its actor", () => {
  assert.match(between("async function saveSettings(", "async function deleteEmployee()"),
    /if \(!silent && state\.scheduleDutyColorsDirty && canManageScheduleDutyColors\(\)\) await saveScheduleDutyColors/);
  const f = colorFixture("hr"), row = f.rows.get("HW");
  row.picker.value = "#00FFFF"; f.updateScheduleDutyColor(row.picker);
  f.renderScheduleDutyColorSettings({ preserveDraft: true });
  assert.equal(f.state.scheduleDutyColorDraft.HW, "#00FFFF");
  assert.equal(f.state.scheduleDutyColorsDirty, true);
  assert.equal(f.requests.length, 0);
  f.state.portalSession.user.employeeNumber = "different-account";
  f.renderScheduleDutyColorSettings({ preserveDraft: true });
  assert.equal(f.state.scheduleDutyColorDraft.HW, duty.DEFAULT_DUTY_COLORS.HW);
  assert.equal(f.state.scheduleDutyColorsDirty, false);
});

test("manual preview is bounded and no longer computes or writes an arbitrary Saturday factor", () => {
  const fields = { "#shiftStart": { value: "07:00" }, "#shiftEnd": { value: "23:00" }, "#shiftDate": { value: "2026-09-12" } };
  const sandbox = { window: { GPScheduleDuty: duty }, state: { data: { settings: { break_rule_enabled: "0", saturday_bonus_enabled: "1", saturday_bonus_factor: "5", saturday_bonus_from: "00:00" } } },
    document: { querySelector: id => fields[id] }, elements: { shiftCalculation: { textContent: "" } }, renderShiftRulePreview() {}, scheduleShiftRulePreview() {},
    timeToMinutes: value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3)), formatHours: value => String(value), dayConfig: () => null };
  vm.createContext(sandbox);
  vm.runInContext(between("function calculateShiftPreview()", "function canUseAllEmployeesForShiftPlanning()"), sandbox);
  sandbox.calculateShiftPreview();
  assert.match(sandbox.elements.shiftCalculation.textContent, /Netto 960/);
  assert.doesNotMatch(sandbox.elements.shiftCalculation.textContent, /Zuschlag|Gewertet/);
  fields["#shiftEnd"].value = "23:01"; sandbox.calculateShiftPreview();
  assert.match(sandbox.elements.shiftCalculation.textContent, /zwischen 07:00 und 23:00/);
  assert.doesNotMatch(html, /id="saturdayBonus(?:Enabled|From|Factor)"/);
  assert.doesNotMatch(between("async function saveSettings(", "async function deleteEmployee()"), /saturdayBonus|saturday_bonus/);
});

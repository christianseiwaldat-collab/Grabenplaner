"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ui = require("../public/retail-kv");
const { normalizeRetailKv } = require("../lib/personnel-retail-kv");
const code = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
function reader() {
  const start = code.indexOf("function readPersonnelRetailKvEditor(");
  const end = code.indexOf("\nfunction handlePersonnelRetailKvInput(", start);
  const context = vm.createContext({ window: { GPRetailKv: ui } });
  vm.runInContext(code.slice(start, end), context); return context.readPersonnelRetailKvEditor;
}
test("editing a saved unresolved source preserves its old hash until an explicit source change", () => {
  const controls = Object.fromEntries(Object.entries(ui.createPeriod("one")).map(([key, value]) => [key, { type: typeof value === "boolean" ? "checkbox" : key === "contractWeeklyMinutes" ? "number" : "text", value: value ?? "", checked: value === true }]));
  controls.validFrom.value = "2026-01-01";
  const row = { dataset: { kvPeriod: "one", kvSourceVersion: ui.SOURCE_VERSION, kvSourceSha256: "a".repeat(64) }, querySelector: selector => controls[/data-kv-property="([^"]+)"/.exec(selector)?.[1]] || null };
  const editor = { dataset: { kvAccess: "write", kvNull: "false" }, querySelector: () => ({ checked: true }), querySelectorAll: () => [row] };
  const saved = reader()(editor);
  assert.equal(saved.periods[0].sourceVersion, ui.SOURCE_VERSION); assert.equal(saved.periods[0].sourceSha256, "a".repeat(64));
  assert.equal(saved.periods[0].confirmed, false);
  assert.throws(() => normalizeRetailKv(JSON.parse(JSON.stringify(saved))), { code: "PERSONNEL_RETAIL_KV_INVALID" });
});
test("dated and source edits reset dependent confirmations before serialization", () => {
  for (const key of ["validFrom", "validTo", "sourceReference", "collectiveAgreementVersionId", "approvedAssignmentId", "group"]) assert.deepEqual(ui.confirmationResets(key), ["confirmed", "workplaceConfirmed", "averagingConfirmed"]);
  for (const key of ["contractWeeklyMinutes", "normalWorkModel", "agreementReference", "agreementValidTo", "agreementConfirmedBy"]) assert.ok(ui.confirmationResets(key).includes("averagingConfirmed"));
  for (const key of ["workplaceKind", "exceptionModel"]) assert.deepEqual(ui.confirmationResets(key), ["confirmed", "workplaceConfirmed", "averagingConfirmed"]);
  assert.deepEqual(ui.confirmationResets("planningEnabled"), []);
  assert.deepEqual(ui.confirmationResets("confirmed"), []);
});
test("new client periods default to unknown facts and remain compatible with strict server normalization", () => {
  const period = { ...ui.createPeriod("new-one"), validFrom: "2026-10-03" };
  const record = normalizeRetailKv({ version: 1, planningEnabled: false, periods: [period] });
  assert.equal(record.planningEnabled, false); assert.equal(record.periods[0].confirmed, false);
  assert.equal(record.periods[0].group, "unknown"); assert.equal(record.periods[0].agreementStatus, "unknown"); assert.equal(record.periods[0].contractWeeklyMinutes, null);
});
test("only personal HR/Admin accounts with the explicit field grant can use the editor", () => {
  const access = { fieldAccess: { [ui.FIELD_KEY]: "write" } };
  for (const role of ["manager", "location_planner", "it_admin", "developer"]) assert.equal(ui.accessMode(access, { role, employeeNumber: "synthetic" }), "hidden");
  for (const role of ["hr", "admin"]) { assert.equal(ui.accessMode(access, { role, employeeNumber: "synthetic" }), "write"); assert.equal(ui.accessMode(access, { role, employeeNumber: "local" }), "hidden"); }
  assert.equal(ui.accessMode({ fieldAccess: { [ui.FIELD_KEY]: "hidden" } }, { role: "hr" }), "hidden");
});
test("rendering escapes private references, offers only the verified linked source and preserves unknown selections", () => {
  const start = code.indexOf("function renderPersonnelRetailKvEditor(");
  const end = code.indexOf("\nfunction readPersonnelRetailKvEditor(", start);
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const context = vm.createContext({ window: { GPRetailKv: ui }, escapeHtml: escape, escapeHtmlAttribute: escape });
  vm.runInContext(code.slice(start, end), context);
  const status = { version: 1, planningEnabled: false, periods: [{ ...ui.createPeriod("synthetic"), sourceReference: '<script>alert("private")</script>' }] };
  const html = context.renderPersonnelRetailKvEditor(status, "write", { agreements: [{ title: "Untrusted", versions: [{ id: "wrong", source: { sha256: "b".repeat(64) }, linkedProfileVersionId: "at-retail-kv-angestellte-2026@2026.5" }] }] });
  assert.ok(!html.includes('<script>alert("private")</script>')); assert.ok(html.includes("&lt;script&gt;")); assert.ok(!html.includes('value="wrong"'));
  assert.match(html, /value="unknown" selected/); assert.equal(context.renderPersonnelRetailKvEditor(status, "hidden"), "");
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

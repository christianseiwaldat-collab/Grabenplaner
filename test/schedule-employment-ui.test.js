"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
function between(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from); return source.slice(from, to);
}
function runtime() {
  const calls = [], opened = [], messages = [];
  const sandbox = { state: { weekStart: "2026-10-05", locationId: "18", departmentId: "", allEmployees: [
    { personnel_number: "TEST-OLD", active: 1 }, { personnel_number: "TEST-FUTURE", active: 1 },
  ], data: { employees: [{ personnel_number: "TEST-OLD", active: 1 }] }, portalStatus: { portalEnabled: true }, portalSession: { user: { role: "hr" } } },
    guardScheduleEditing: () => false, isAutomaticallyWeekLocked: () => false,
    captureGpContext: (canUse, source) => ({ canUse, source, expected: source() }),
    gpContextCurrent: ticket => ticket.canUse() && ticket.expected === ticket.source(),
    api: async url => { calls.push(url); return [{ personnel_number: "TEST-OLD", active: 1, planningDates: ["2026-10-05"] }]; },
    openShiftModal: (...args) => opened.push(args), showToast: message => messages.push(message), encodeURIComponent,
  };
  vm.createContext(sandbox);
  vm.runInContext(between("function canUseAllEmployeesForShiftPlanning()", "function canManageEmployeeLendings()") + "\n"
    + between("async function openShiftModalForPlanningDate(", "function openShiftModal("), sandbox);
  return { sandbox, calls, opened, messages };
}
test("Schichtdialog lädt Wochenkandidaten separat und verändert das Personalverzeichnis nicht", async () => {
  const f = runtime(); await f.sandbox.openShiftModalForPlanningDate("TEST-OLD", "2026-10-05");
  assert.deepEqual(f.calls, ["/api/employees?planningWeek=2026-10-05"]);
  assert.equal(f.opened.length, 1); assert.equal(f.opened[0][3].length, 1);
  assert.equal(f.sandbox.state.allEmployees.length, 2);
  const selected = f.sandbox.shiftEmployeeCandidates("TEST-FUTURE", null, f.opened[0][3], "2026-10-05");
  assert.equal(selected.some(employee => employee.personnel_number === "TEST-FUTURE"), false,
    "Ein ausgewählter Altwert darf den geprüften Kandidatenkreis nicht umgehen");
});
test("Schichtdialog verwirft verspätete Antworten nach Wochenwechsel und öffnet bei Ladefehlern keinen ungeprüften Ersatz", async () => {
  const f = runtime(); let release;
  f.sandbox.api = () => new Promise(resolve => { release = resolve; });
  const pending = f.sandbox.openShiftModalForPlanningDate("TEST-OLD", "2026-10-05");
  f.sandbox.state.weekStart = "2026-10-12"; release([]); await pending;
  assert.equal(f.opened.length, 0);
  f.sandbox.api = async () => { throw new Error("Testunterbrechung"); };
  await f.sandbox.openShiftModalForPlanningDate("TEST-OLD", "2026-10-12");
  assert.equal(f.opened.length, 0); assert.deepEqual(f.messages, ["Testunterbrechung"]);
});
test("Vorhandene Tagesfreigabe gilt auch für die Schichtauswahl; der erste Eintrittstag bleibt auswählbar", () => {
  const f = runtime(), employees = [{ personnel_number: "TEST-NEW", active: 1, planningDates: ["2026-10-15"] }];
  assert.equal(f.sandbox.shiftEmployeeCandidates("TEST-NEW", null, employees, "2026-10-14").length, 0);
  assert.equal(f.sandbox.shiftEmployeeCandidates("TEST-NEW", null, employees, "2026-10-15").length, 1);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { branchTimeOffContext, sameBranchTimeOffContext, branchTimeOffScheduleWindow, branchTimeOffPeriod } = require("../lib/branch-time-off");
const root = path.resolve(__dirname, "..");
const portal = fs.readFileSync(path.join(root, "public/portal.js"), "utf8");
const branchScript = fs.readFileSync(path.join(root, "public/portal-branch-time-off.js"), "utf8");
const formScript = portal.slice(portal.indexOf("let timeOffCheckTimer;"), portal.indexOf("async function loadTimeOffRequests()"));

function harness() {
  let nextTimer = 0;
  const timers = new Map(), pending = [];
  const node = () => ({ value: "", innerHTML: "", disabled: false, classList: { toggle() {} } });
  const el = new Proxy({}, { get(target, key) { return target[key] ||= node(); } });
  const context = {
    el, URLSearchParams, Date, Intl,
    portalState: { session: { user: { accountType: "branch", accountId: "branch-a", homeLocationId: "93", permissions: ["branch_time_off:submit"] } }, editingTimeOffId: null, timeOffSubmitting: false },
    mode: "day", approval: "local", esc: String,
    document: { querySelector: selector => ({ value: selector.includes("ApprovalType") ? context.approval : context.mode }) },
    portalUser: () => context.portalState.session?.user,
    isOrganizationAccount: (user = context.portalState.session?.user) => ["branch", "terminal"].includes(user?.accountType),
    updateTraffic: (_node, result, empty) => { context.traffic = result || { reason: empty }; },
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    api: (route, options = {}) => new Promise((resolve, reject) => pending.push({ route, options, resolve, reject })),
  };
  vm.createContext(context);
  vm.runInContext(branchScript + "\n" + formScript, context);
  el.branchTimeOffEmployee.value = "employee-a";
  el.timeOffDate.value = "2031-09-05";
  const runTimer = () => {
    const [id, callback] = [...timers.entries()].at(-1);
    timers.delete(id);
    return callback();
  };
  return { context, el, pending, runTimer };
}

test("eine verspätete ZA-Prüfung darf eine andere Person nicht zum Absenden freigeben", async () => {
  const { context, el, pending, runTimer } = harness();
  await context.checkTimeOff();
  const first = runTimer();
  assert.equal(JSON.parse(pending[0].options.body).employeeNumber, "employee-a");
  el.branchTimeOffEmployee.value = "employee-b";
  await context.checkTimeOff();
  const second = runTimer();
  assert.equal(el.timeOffSubmitButton.disabled, true);
  pending[0].resolve({ allowed: true, trafficLight: "green" });
  await first;
  assert.equal(context.portalState.timeOffCheck, null);
  assert.equal(el.timeOffSubmitButton.disabled, true);
  pending[1].resolve({ allowed: false, trafficLight: "red", reason: "Gesperrt" });
  await second;
  assert.equal(context.portalState.timeOffCheck.allowed, false);
  assert.equal(el.timeOffSubmitButton.disabled, true);
});

test("Änderung des Zeitraums sperrt ein bereits freigegebenes Formular sofort", async () => {
  const { context, el, pending, runTimer } = harness();
  await context.checkTimeOff();
  const first = runTimer();
  pending[0].resolve({ allowed: true });
  await first;
  assert.equal(el.timeOffSubmitButton.disabled, false);
  el.timeOffDate.value = "2031-09-06";
  await context.checkTimeOff();
  assert.equal(el.timeOffSubmitButton.disabled, true);
  assert.equal(context.portalState.timeOffCheckFingerprint, "");
});

test("überholte Stunden-Slots werden nach einem Personenwechsel verworfen", async () => {
  const { context, el, pending } = harness();
  context.mode = "hours";
  const first = context.loadTimeOffSlots();
  el.branchTimeOffEmployee.value = "employee-b";
  const second = context.loadTimeOffSlots();
  pending[0].resolve({ closed: false, startTimes: ["08:00"], endTimes: ["09:00"], start: "08:00", end: "09:00" });
  await first;
  assert.equal(context.portalState.timeOffSlots, null);
  assert.equal(el.timeOffStart.disabled, true);
  pending[1].resolve({ closed: false, startTimes: ["10:00"], endTimes: ["11:00"], start: "10:00", end: "11:00" });
  await second;
  assert.deepEqual(context.portalState.timeOffSlots.startTimes, ["10:00"]);
  assert.equal(el.timeOffStart.disabled, false);
  assert.match(pending[1].route, /branch-time-off\/slots/);
  assert.match(pending[1].route, /employeeNumber=employee-b/);
});

test("Abmelden macht eine laufende Prüfung wirkungslos", async () => {
  const { context, el, pending, runTimer } = harness();
  await context.checkTimeOff();
  const first = runTimer();
  context.portalState.session = null;
  pending[0].resolve({ allowed: true });
  await first;
  assert.equal(el.timeOffSubmitButton.disabled, true);
  assert.equal(context.portalState.timeOffCheck, null);
});

test("ohne Person wird nichts geprüft; persönliche Anträge behalten ihren bestehenden Endpunkt", async () => {
  const { context, el, pending, runTimer } = harness();
  el.branchTimeOffEmployee.value = "";
  await context.checkTimeOff();
  assert.equal(pending.length, 0);
  assert.equal(el.timeOffSubmitButton.disabled, true);
  context.portalState.session.user = { accountType: "employee", employeeNumber: "personal-a" };
  await context.checkTimeOff();
  const check = runTimer();
  assert.equal(pending[0].route, "/api/portal/v1/me/time-off-check");
  assert.equal(JSON.parse(pending[0].options.body).employeeNumber, undefined);
  pending[0].resolve({ allowed: true });
  await check;
  assert.equal(el.timeOffSubmitButton.disabled, false);
});

test("Filialkontext verlangt genau eine Filiale und bewahrt führende Nullen", () => {
  const session = { id: "s", sessionKind: "organization", accountType: "branch", accountId: "a", permissions: ["branch_time_off:submit"], scopes: [{ locationId: "00" }] };
  const context = branchTimeOffContext(session);
  assert.equal(context.locationId, "00");
  for (const patch of [{ accountType: "terminal" }, { permissions: [] }, { sessionKind: "employee" },
    { scopes: [] }, { scopes: [null] }, { scopes: [{ locationId: "00", departmentId: 1 }] },
    { scopes: [{ locationId: "00" }, { locationId: "18" }] }]) {
    assert.throws(() => branchTimeOffContext({ ...session, ...patch }), error => error.status === 403);
  }
  assert.throws(() => sameBranchTimeOffContext(context, { ...context, locationId: "18" }), error => error.status === 403);
  assert.throws(() => sameBranchTimeOffContext(context, { ...context, session: { ...session, id: "other" } }), error => error.status === 403);
});

test("Kalenderfenster behandeln Jahreswechsel und Schaltjahre; Antragszeiträume sind begrenzt", () => {
  assert.deepEqual(branchTimeOffScheduleWindow("2027-01-01"), { view: "week", from: "2026-12-28", to: "2027-01-03", anchor: "2027-01-01" });
  assert.equal(branchTimeOffScheduleWindow("2028-02-15", "month").to, "2028-02-29");
  assert.throws(() => branchTimeOffScheduleWindow("2027-02-29", "month"), error => error.status === 400);
  assert.doesNotThrow(() => branchTimeOffPeriod({ dateFrom: "2031-01-01", dateTo: "2032-01-01" }));
  assert.throws(() => branchTimeOffPeriod({ dateFrom: "2031-01-01", dateTo: "2032-01-02" }), error => error.status === 400);
});

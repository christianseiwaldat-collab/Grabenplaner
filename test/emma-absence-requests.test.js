"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createEmmaAbsenceRequests, authorizeEmmaAbsence, registerEmmaAbsenceRoutes, publicCheck, PREFIX } = require("../lib/emma-absence-requests");
const period = date => ({ dateFrom: date, dateTo: date, allDay: true, startTime: null, endTime: null });
const body = () => ({ employeeNumber: "SELF", kind: "vacation", periods: [period("2031-04-08"), period("2031-04-10"), period("2031-04-12")], note: "Eigener Antrag" });
function fixture() {
  const state = { rows: [], events: [], next: 1, authorizationCalls: 0, blocked: new Set(), staffingWarnings: new Set(), subjectRights: ["own_vacation:read", "own_vacation:request", "own_time:read", "own_time:write"],
    actor: { id: "emma-session", sessionKind: "employee", employeeNumber: "Emma", permissions: ["schedule:read", "schedule:write", "absence_entries:write"], scopes: [{ locationId: "18" }] } };
  const repository = {
    portalAccess: { async getReportPrincipal({ employeeNumber }) { return employeeNumber === "SELF" && !state.subjectDisabled
      ? { employee_number: employeeNumber, home_location_id: state.home ?? "18", permissions: state.subjectRights } : null; } },
    async transaction(work, options) {
      state.transactionOptions = options;
      const before = structuredClone({ rows: state.rows, events: state.events, next: state.next });
      try { return await work(repository); } catch (error) { Object.assign(state, before); throw error; }
    },
    async vacationOverlap(value) { return state.overlapDate === value.dateFrom ? { id: 999 } : null; },
    async insertVacationRequest(value) {
      if (state.failSecond && state.rows.length) throw Error("synthetic write failure");
      const id = state.next++; state.rows.push({ id, employee_number: value.employeeNumber, location_id: value.locationId,
        date_from: value.dateFrom, date_to: value.dateTo, status: "pending_local", note: value.note }); state.onInsert?.(); return { rows: [{ id }] };
    },
    async insertTimeOffRequest(value) {
      const saved = await repository.insertVacationRequest(value); Object.assign(state.rows.at(-1), { all_day: value.allDay, start_time: value.startTime, end_time: value.endTime });
      state.lastTimeOff = structuredClone(value); return saved;
    },
    async requestByIdVacation(id) { return structuredClone(state.rows.find(row => row.id === id)); },
    async requestByIdTimeOff(id) { return repository.requestByIdVacation(id); },
  };
  const deps = { repository, today: () => "2031-04-01",
    async authorize(request, input, repo = repository, context) {
      state.authorizationCalls++; state.onAuthorization?.();
      return authorizeEmmaAbsence({ request, input, repository: repo, context, today: () => "2031-04-01",
        requireSession: () => ({ id: "emma-session" }), loadSession: async () => state.actor,
        effectivePermissions: (_id, _role, permissions) => ({ effectivePermissions: permissions }),
        assertScope(actor, scope) { if (!actor.scopes.some(row => row.locationId === scope.locationId)) throw Object.assign(Error("scope"), { status: 403, code: "PORTAL_SCOPE_DENIED" }); } });
    },
    async context(value) {
      if (state.contextConflict === value.dateFrom) throw Object.assign(Error("Berufsschule blockiert den Tag."), { status: 409, code: "VOCATIONAL_SCHOOL_CONFLICT" });
      return { locationId: "18", originLocationId: "18", departmentId: null, lendingId: null };
    },
    async evaluate(value) {
      const hardBlock = state.blocked.has(value.dateFrom), staffing = state.staffingWarnings.has(value.dateFrom);
      return require("../lib/absence-request-policy").absenceRequestSubmissionAssessment({ allowed: !hardBlock && !staffing,
        trafficLight: hardBlock || staffing ? "red" : "yellow", manualReview: true,
        reason: hardBlock ? "Antragssperre für diesen Tag." : staffing ? "Mindestbesetzung nicht erfüllt." : "Manuelle Freigabe erforderlich.",
        code: hardBlock ? "REQUEST_BLACKOUT" : staffing ? (value.kind === "vacation" ? "VACATION_STAFFING_INSUFFICIENT" : "TIME_OFF_STAFFING_INSUFFICIENT") : "MANUAL_REVIEW" });
    },
    async decision(kind, id, stage, action, actor) { state.events.push({ type: "decision", kind, id, stage, action, actor }); },
    async notify(_repo, row, kind, stage, actor) { state.events.push({ type: "notify", subject: row.employee_number, kind, stage, actor }); },
    async audit(_repo, actor, action) { state.events.push({ type: "audit", actor, action }); },
    assertCsrf() { state.csrfChecks = (state.csrfChecks || 0) + 1; },
  };
  return { state, deps, service: createEmmaAbsenceRequests(deps) };
}
test("batch creates only eligible native pending rows and reviewer notifications with Emma actor and separate employee subject", async () => {
  const f = fixture(); f.state.blocked.add("2031-04-10");
  const result = await f.service.submit({}, body());
  assert.equal(result.status, "pending"); assert.equal(result.requests.length, 2); assert.equal(result.blocked.length, 1);
  assert(result.requests.every(row => row.status === "pending" && row.employeeNumber === "SELF"));
  assert(result.requests.every(row => row.nativeStatus === "pending_local"));
  assert(f.state.rows.every(row => row.status === "pending_local"));
  assert.equal(f.state.transactionOptions.isolation, "serializable");
  assert.deepEqual(result.requests.map(row => row.inputIndex), [0, 2]);
  assert(f.state.events.filter(event => event.type === "decision").every(event => event.action === "submit" && event.actor === "Emma"));
  assert(f.state.events.filter(event => event.type === "notify").every(event => event.subject === "SELF" && event.actor === "Emma"));
  assert(!f.state.events.some(event => /approve/.test(event.action || "")));
});
test("native staffing warning saves an open request and reports conflict, while school blocks only its own period", async () => {
  const f = fixture(); f.state.staffingWarnings.add("2031-04-08"); f.state.contextConflict = "2031-04-10";
  const result = await f.service.submit({}, body());
  assert.equal(result.requests.length, 2); assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].code, "VOCATIONAL_SCHOOL_CONFLICT");
  assert.equal(result.conflicts.length, 1); assert.equal(result.conflicts[0].code, "VACATION_STAFFING_INSUFFICIENT");
  assert.equal(result.conflicts[0].submissionAllowed, true); assert.equal(result.conflicts[0].allowed, false);
  assert.equal(result.requests[0].status, "pending"); assert.equal(result.requests[0].nativeStatus, "pending_local");
  assert.equal(result.requests[0].assessment.trafficLight, "red"); assert.equal(f.state.rows.length, 2);
});
test("all red staffing periods still become pending requests, with one explicit conflict per saved period", async () => {
  for (const kind of ["vacation", "time_off"]) {
    const f = fixture(); for (const item of body().periods) f.state.staffingWarnings.add(item.dateFrom);
    const check = await f.service.check({}, { ...body(), kind });
    assert.equal(check.allowed, false); assert.equal(check.submissionAllowed, true);
    const result = await f.service.submit({}, { ...body(), kind });
    assert.equal(result.requests.length, 3); assert.equal(result.conflicts.length, 3); assert.deepEqual(result.blocked, []);
    assert(f.state.rows.every(row => row.status === "pending_local"));
    assert(result.requests.every(row => row.assessment.allowed === false && row.assessment.submissionAllowed === true));
    assert(!f.state.events.some(event => /approve/.test(event.action || "")));
  }
});
test("conflict capability is explicit and only native staffing advisories can admit a red pending request", async () => {
  const f = fixture(), capabilities = await f.service.capabilities({});
  assert.equal(capabilities.conflictPolicy, "submit_with_warning"); assert.equal(capabilities.pendingOnly, true);
  const red = { allowed: false, trafficLight: "red", reason: "Konflikt", submissionAllowed: true };
  assert.equal(publicCheck({ ...red, code: "VACATION_STAFFING_INSUFFICIENT" }).submissionAllowed, true);
  assert.equal(publicCheck({ ...red, code: "TIME_OFF_STAFFING_INSUFFICIENT" }).submissionAllowed, true);
  assert.equal(publicCheck({ ...red, code: "VOCATIONAL_SCHOOL_CONFLICT" }).submissionAllowed, false);
  assert.equal(publicCheck({ ...red, code: "REQUEST_BLACKOUT" }).submissionAllowed, false);
  assert.equal(publicCheck({ ...red, code: "VACATION_STAFFING_INSUFFICIENT", submissionAllowed: false }).submissionAllowed, false);
});
test("all blocked periods return explicit conflicts and create no rows", async () => {
  const f = fixture(); for (const item of body().periods) f.state.blocked.add(item.dateFrom);
  const result = await f.service.submit({}, body());
  assert.equal(result.status, "blocked"); assert.equal(result.requests.length, 0); assert.equal(result.blocked.length, 3); assert.equal(f.state.events.length, 0);
});
test("an existing pending vacation blocks only its own period in both preflight and the atomic batch", async () => {
  const f = fixture(); f.state.overlapDate = "2031-04-10";
  const check = await f.service.check({}, body());
  assert.equal(check.checks[1].allowed, false); assert.equal(check.checks[1].code, "VACATION_REQUEST_OVERLAP");
  const saved = await f.service.submit({}, body());
  assert.equal(saved.requests.length, 2); assert.deepEqual(saved.requests.map(row => row.inputIndex), [0, 2]);
  assert.equal(saved.blocked[0].code, "VACATION_REQUEST_OVERLAP"); assert.equal(f.state.rows.length, 2);
});
test("hourly and all-day ZA reuse native pending fields and local review without a direct approved entry", async () => {
  const f = fixture(); const value = { ...body(), kind: "time_off", periods: [{ ...period("2031-04-08"), allDay: false, startTime: "11:00", endTime: "14:00" }] };
  const result = await f.service.submit({}, value);
  assert.equal(result.requests[0].allDay, false); assert.equal(f.state.lastTimeOff.approvalType, "local"); assert.equal(f.state.lastTimeOff.startTime, "11:00");
  const allDay = await f.service.submit({}, { ...body(), kind: "time_off", periods: [period("2031-04-10")] });
  assert.equal(allDay.requests[0].allDay, true); assert.equal(f.state.lastTimeOff.startTime, "00:00"); assert.equal(f.state.lastTimeOff.endTime, "23:59");
});
test("a second insert failure or late permission revocation rolls back every staged row and notification", async () => {
  for (const mode of ["write", "revoke"]) {
    const f = fixture();
    if (mode === "write") f.state.failSecond = true;
    else f.state.onInsert = () => { f.state.actor.permissions = ["schedule:read"]; };
    await assert.rejects(() => f.service.submit({}, body()));
    assert.equal(f.state.rows.length, 0); assert.equal(f.state.events.length, 0);
  }
});
test("strict actor, fresh subject own permissions and GP home/responsibility scopes prevent submission", async () => {
  const patches = [state => { state.actor.employeeNumber = "OTHER"; }, state => { state.actor.id = "different-session"; },
    state => { state.actor.sessionKind = "organization"; }, state => { state.actor.permissions.pop(); },
    state => { state.subjectRights = []; }, state => { state.subjectDisabled = true; }, state => { state.home = "05"; }, state => { state.actor.scopes = []; }];
  for (const patch of patches) {
    const f = fixture(); patch(f.state);
    await assert.rejects(() => f.service.submit({}, body()), error => error.status === 403);
    assert.equal(f.state.rows.length, 0);
  }
});
test("past completed dates, missing kind, overlaps, arbitrary action and forged fields are rejected before any insert", async () => {
  for (const value of [{ ...body(), kind: "free" }, { ...body(), action: "approve" }, { ...body(), periods: [period("2031-03-31")] },
    { ...body(), periods: [period("2031-04-08"), period("2031-04-08")] }, { ...body(), periods: [{ ...period("2031-04-08"), employeeNumber: "OTHER" }] }]) {
    const f = fixture(); await assert.rejects(() => f.service.submit({}, value), error => error.status === 400); assert.equal(f.state.rows.length, 0);
  }
});
test("readback returns only the requested subject and checks live rights again", async () => {
  const f = fixture(), saved = await f.service.submit({}, { ...body(), periods: [period("2031-04-08")] });
  const read = await f.service.read({}, { employeeNumber: "SELF", kind: "vacation", ids: [saved.requests[0].id] });
  assert.equal(read.requests[0].status, "pending");
  f.state.rows[0].employee_number = "OTHER";
  await assert.rejects(() => f.service.read({}, { employeeNumber: "SELF", kind: "vacation", ids: [1] }), error => error.status === 404);
});
test("routes expose only capabilities and CSRF-protected check/submit/read, never decision or general employee APIs", async () => {
  const f = fixture(), routes = [];
  registerEmmaAbsenceRoutes({ get: (url, handler) => routes.push({ method: "GET", url, handler }), post: (url, handler) => routes.push({ method: "POST", url, handler }) }, f.deps);
  assert.deepEqual(routes.map(row => row.url), ["capabilities", "check", "submit", "read"].map(action => PREFIX + "/" + action));
  const response = { status() { return this; }, json() {} };
  await routes.find(row => row.url.endsWith("/check")).handler({ body: body() }, response);
  assert.equal(f.state.csrfChecks, 1);
});
test("pending vacation projection uses a read-only PostgreSQL query and grants zero credited minutes", () => {
  const entry = require("../lib/persistence/postgresql/core/emma-absence-requests").CATALOG[0];
  assert.equal(entry.statement.operation, "queryAll"); assert.match(entry.sql, /gp\.vacation_requests/); assert.doesNotMatch(entry.sql, /INSERT|UPDATE|DELETE|approved/);
  assert.deepEqual(entry.parameterOrder, ["dateFrom", "dateTo"]);
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const at = server.indexOf("function optionMinutesPerDay("), end = server.indexOf("\nfunction ", at + 1);
  const credit = vm.runInNewContext(server.slice(at, end) + ";optionMinutesPerDay", {});
  assert.equal(credit({ option_type: "vacation", soft_pending: true }, 40), 0);
  assert.match(server, /pending-vacation-\$\{item\.id\}/); assert.match(server, /employment\.clip\(pendingVacation\)/);
  const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  assert.match(app, /softPending\.option_type === "vacation" \? "Urlaub beantragt" : "ZA beantragt"/);
});
test("new projection crosses the actual PostgreSQL provider with bound dates and serializable native repository transactions", async () => {
  const { createPostgresqlPersistenceProvider } = require("../lib/persistence/postgresql/provider");
  const { createAbsenceManagementRepository } = require("../lib/persistence/repositories/absence-management");
  const catalog = require("../lib/persistence/postgresql/core/emma-absence-requests").CATALOG;
  const calls = [], row = { id: 5, employee_number: "SELF", date_from: "2031-04-08", date_to: "2031-04-08" };
  const client = { async query(configuration) { calls.push(configuration); return { rows: typeof configuration === "object" ? [[JSON.stringify(row)]] : [], rowCount: 1, fields: [{ name: "data" }] }; }, release() {} };
  const provider = createPostgresqlPersistenceProvider({ pool: { connect: async () => client, end: async () => {} }, catalog });
  const repository = createAbsenceManagementRepository(provider);
  const result = await repository.transaction(tx => tx.pendingVacationForRange({ dateFrom: "2031-04-07", dateTo: "2031-04-13" }), { isolation: "serializable" });
  assert.deepEqual(result, [row]);
  assert(calls.some(call => call === "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE"));
  const query = calls.find(call => typeof call === "object");
  assert.deepEqual(query.values, ["2031-04-07", "2031-04-13"]); assert.match(query.text, /r\.date_from <= \$2 AND r\.date_to >= \$1/);
});

"use strict";

// Actual employee-portal markup and request handlers; accounts and transport are synthetic.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const repo = path.join(__dirname, "..");
const enabled = process.env.GP_WINDOW_BROWSER_TEST === "1";
const source = fs.readFileSync(path.join(repo, "public/portal.js"), "utf8").replace(/\r\n/g, "\n");
const html = fs.readFileSync(path.join(repo, "public/portal.html"), "utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

function handler(name) {
  const start = Math.min(...[`function ${name}(`, `async function ${name}(`]
    .map(marker => source.indexOf(marker)).filter(index => index >= 0));
  const end = source.indexOf("\n}", start);
  assert.ok(Number.isFinite(start) && end > start, `Actual ${name} handler exists`);
  return source.slice(start, end + 2);
}

function sourceRange(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Actual ${start} block exists`);
  return source.slice(from, to);
}

async function withBrowser(run) {
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true,
    ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}),
    args: ["--no-first-run"] });
  try { await run(browser); } finally { await browser.close(); }
}

async function setup(browser, { timezoneId = "Europe/Vienna", now = "2031-04-01T12:00:00Z" } = {}) {
  const page = await browser.newPage({ timezoneId });
  page.setDefaultTimeout(6000);
  await page.clock.install({ time: new Date(now) });
  await page.clock.setFixedTime(new Date(now));
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.abort());
  await page.setContent(html);
  await page.evaluate(() => {
    window.el = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
    window.portalState = { session: { user: { employeeNumber: "BEISPIEL-01", isEmployee: true,
      permissions: ["own_vacation:read", "own_vacation:request", "own_time:read", "own_time:write"] } },
    editingVacationId: null, editingTimeOffId: null, vacationSubmitting: false, timeOffSubmitting: false,
    timeOffArchive: false, absenceHistory: [], vacationRequests: [], timeOffRequests: [] };
    window.statusLabels = { pending: "Offen", pending_local: "Offen", approved: "Genehmigt", withdrawn: "Zurückgezogen" };
    window.esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    window.calls = [];
    window.checkRequests = [];
    window.fixtures = {
      "/api/portal/v1/me/vacation-requests": { requests: [{ id: 1, date_from: "2031-04-15", date_to: "2031-04-16", status: "pending", note: "BEISPIEL Urlaub" }] },
      "/api/portal/v1/me/time-off-requests": { requests: [{ id: 2, date_from: "2031-04-15", date_to: "2031-04-15", request_date: "2031-04-15", all_day: true, status: "pending", note: "BEISPIEL ZA" }] },
      "/api/portal/v1/me/approved-time-off": { requests: [{ id: 3, date_from: "2031-04-20", date_to: "2031-04-20", all_day: true }], pendingChanges: [] },
      "/api/portal/v1/me/approved-vacations": { vacations: [{ groupId: "BEISPIEL-urlaub", dateFrom: "2031-04-21", dateTo: "2031-04-22" }], pendingChanges: [] },
      "/api/portal/v1/me/absence-history": { items: [] },
    };
    window.api = async (route, options = {}) => {
      calls.push({ route, method: options.method || "GET", body: options.body && JSON.parse(options.body) });
      if (route.endsWith("-check")) return new Promise(resolve => checkRequests.push({ route, body: JSON.parse(options.body), resolve }));
      return options.method && options.method !== "GET" ? { id: 99 } : fixtures[route] || {};
    };
    window.isBranchTimeOffAccount = () => false;
    window.timeOffOwnerKey = () => portalState.session?.user?.employeeNumber;
    window.isMobileUi = () => false;
    window.mobileLocationDisplayTabModules = {};
    window.confirm = () => true;
    window.message = () => {};
    window.configureBranchTimeOffForm = () => {};
    window.branchTimeOffState = { employees: [] };
    window.resetTimeOffForm = () => { portalState.editingTimeOffId = null; };
    window.setTab = () => {};
  });
  const functions = ["iso", "absenceTodayIso", "addDays", "dateText", "portalUser", "isOrganizationAccount",
    "hasPortalPermission", "portalTabAllowed", "requestSubmissionAllowed", "updateTraffic",
    "invalidateTimeOffCheck", "timeOffFormFingerprint", "timeOffMode", "timeOffPayload", "checkTimeOff",
    "loadTimeOffRequests", "submitTimeOff", "vacationFormFingerprint", "invalidateVacationCheck", "checkVacation",
    "loadVacationRequests", "resetVacationForm", "submitVacation", "loadApprovedVacations",
    "requestKindText", "requestPeriodText", "requestMatchesHistoryFilters", "renderAbsenceHistory",
    "runAbsenceHistoryAction", "loadAbsenceHistory"].map(handler).join("\n");
  const dates = sourceRange("    const today = absenceTodayIso();\n    const requestHorizon", "    if (el.sicknessStartDate)");
  await page.addScriptTag({ content: `let timeOffCheckTimer; let timeOffCheckGeneration = 0;
    let vacationCheckTimer; let vacationCheckGeneration = 0;
    const openRequestStatuses = new Set(["pending", "submitted", "pending_local", "preliminary_local", "pending_hr"]);
    ${functions}
    function initializeAbsenceDates() { ${dates} }
    initializeAbsenceDates();` });
  return { page, errors };
}

test("personal absence date controls share the Vienna day and inclusive 365-day horizon across timezones", { skip: !enabled, timeout: 60000 }, async () => {
  await withBrowser(async browser => {
    for (const scenario of [
      { timezoneId: "America/Los_Angeles", now: "2026-10-25T23:30:00Z", today: "2026-10-26", last: "2027-10-26" },
      { timezoneId: "Asia/Tokyo", now: "2026-10-25T22:30:00Z", today: "2026-10-25", last: "2027-10-25" },
      { timezoneId: "UTC", now: "2028-02-28T23:30:00Z", today: "2028-02-29", last: "2029-02-28" },
    ]) {
      const { page, errors } = await setup(browser, scenario);
      try {
        const bounds = await page.evaluate(() => ["timeOffDate", "timeOffDateTo", "vacationDateFrom", "vacationDateTo",
          "timeOffChangeFrom", "timeOffChangeTo", "vacationChangeFrom", "vacationChangeTo"].map(id => ({ id, min: el[id].min, max: el[id].max })));
        for (const field of bounds) {
          assert.equal(field.min, scenario.today, field.id);
          assert.equal(field.max, scenario.last, field.id);
        }
        const validity = await page.evaluate(last => {
          el.vacationDateFrom.value = last;
          const boundaryAccepted = el.vacationDateFrom.checkValidity();
          el.vacationDateFrom.value = addDays(last, 1);
          return { boundaryAccepted, beyondRejected: el.vacationDateFrom.validity.rangeOverflow };
        }, scenario.last);
        assert.deepEqual(validity, { boundaryAccepted: true, beyondRejected: true });
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });
});

test("read-only own requests retain overview and history while individual denial hides all mutation controls", { skip: !enabled, timeout: 60000 }, async () => {
  await withBrowser(async browser => {
    const { page, errors } = await setup(browser);
    try {
      const readonly = await page.evaluate(async () => {
        portalState.session.user.permissions = ["own_vacation:read", "own_time:read"];
        portalState.absenceHistory = [
          { id: 1, kind: "vacation", status: "pending", date_from: "2031-04-15", date_to: "2031-04-16", created_at: "2031-04-01T12:00:00Z" },
          { id: 2, kind: "time_off", status: "pending", date_from: "2031-04-15", date_to: "2031-04-15", all_day: true, created_at: "2031-04-01T12:00:00Z" },
          { id: 4, kind: "vacation_change", request_type: "change", status: "pending", original_date_from: "2031-04-21", original_date_to: "2031-04-22", requested_date_from: "2031-04-23", requested_date_to: "2031-04-24", created_at: "2031-04-01T12:00:00Z" },
          { id: 5, kind: "time_off_cancel", status: "pending", original_date_from: "2031-04-20", original_date_to: "2031-04-20", created_at: "2031-04-01T12:00:00Z" },
        ];
        el.historyTypeFilter.value = "all";
        await Promise.all([loadVacationRequests(), loadTimeOffRequests(), loadApprovedVacations()]);
        renderAbsenceHistory();
        return { tabs: [portalTabAllowed("timeOff"), portalTabAllowed("vacation"), portalTabAllowed("history")],
          pendingVacation: el.vacationRequestList.querySelectorAll(".request-item").length,
          pendingZa: el.timeOffRequestList.querySelectorAll(".request-item").length,
          mutationControls: [el.vacationRequestList, el.timeOffRequestList, el.approvedVacationList, el.absenceHistoryList].reduce((total, node) => total + node.querySelectorAll(".edit-request,.cancel-request,[data-vacation-action],[data-time-off-action],[data-history-action]").length, 0),
          historyControls: el.absenceHistoryList.querySelectorAll("[data-open-history]").length };
      });
      assert.deepEqual(readonly.tabs, [true, true, true]);
      assert.equal(readonly.pendingVacation, 1);
      assert.equal(readonly.pendingZa, 2);
      assert.equal(readonly.historyControls, 4);
      assert.equal(readonly.mutationControls, 0);
      const enabledControls = await page.evaluate(async () => {
        portalState.session.user.permissions.push("own_vacation:request", "own_time:write");
        await Promise.all([loadVacationRequests(), loadTimeOffRequests(), loadApprovedVacations()]);
        renderAbsenceHistory();
        const withdrawal = el.absenceHistoryList.querySelector('[data-history-kind="vacation_change"] [data-history-action="withdraw"]');
        const timeOffWithdrawal = el.absenceHistoryList.querySelector('[data-history-kind="time_off_cancel"] [data-history-action="withdraw"]');
        const result = { vacation: el.vacationRequestList.querySelectorAll("button").length,
          za: el.timeOffRequestList.querySelectorAll("button").length,
          approvedVacation: el.approvedVacationList.querySelectorAll("button").length,
          changeWithdrawal: Boolean(withdrawal), cancellationWithdrawal: Boolean(timeOffWithdrawal) };
        fixtures["/api/portal/v1/me/absence-history"].items = [...portalState.absenceHistory];
        await runAbsenceHistoryAction(withdrawal);
        const beforeDenial = calls.length;
        portalState.session.user.permissions = ["own_vacation:read", "own_time:read"];
        await runAbsenceHistoryAction(timeOffWithdrawal);
        result.deniedMutationStopped = calls.length === beforeDenial;
        result.withdrawRoute = calls.find(call => call.method === "DELETE")?.route;
        return result;
      });
      assert.deepEqual(enabledControls, { vacation: 2, za: 4, approvedVacation: 2,
        changeWithdrawal: true, cancellationWithdrawal: true, deniedMutationStopped: true,
        withdrawRoute: "/api/portal/v1/me/vacation-change-requests/4" });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
});

test("live absence checks keep staffing warnings red and submittable, reject hard blocks and discard stale vacation results", { skip: !enabled, timeout: 60000 }, async () => {
  await withBrowser(async browser => {
    const { page, errors } = await setup(browser);
    try {
      await page.evaluate(() => { el.vacationDateFrom.value = "2031-04-15"; el.vacationDateTo.value = "2031-04-15"; checkVacation(); });
      await page.waitForFunction(() => checkRequests.length === 1);
      const invalidated = await page.evaluate(() => {
        el.vacationDateFrom.value = "2031-04-16"; el.vacationDateTo.value = "2031-04-16"; checkVacation();
        return { disabled: el.vacationSubmitButton.disabled, check: portalState.vacationCheck };
      });
      assert.deepEqual(invalidated, { disabled: true, check: null });
      await page.waitForFunction(() => checkRequests.length === 2);
      await page.evaluate(() => checkRequests[1].resolve({ allowed: false, submissionAllowed: false, trafficLight: "red", code: "REQUEST_BLACKOUT", reason: "BEISPIEL Sperre B" }));
      await page.waitForFunction(() => portalState.vacationCheck?.code === "REQUEST_BLACKOUT");
      await page.evaluate(() => checkRequests[0].resolve({ allowed: true, submissionAllowed: true, trafficLight: "green", reason: "Veraltete Prüfung A" }));
      await page.waitForTimeout(30);
      const stale = await page.evaluate(async () => {
        const before = calls.length;
        await submitVacation({ preventDefault() {} });
        return { code: portalState.vacationCheck.code, reason: el.vacationCheck.querySelector("small").textContent,
          disabled: el.vacationSubmitButton.disabled, submitBlocked: before === calls.length };
      });
      assert.deepEqual(stale, { code: "REQUEST_BLACKOUT", reason: "BEISPIEL Sperre B", disabled: true, submitBlocked: true });

      for (const kind of ["vacation", "time_off"]) {
        await page.evaluate(kind => {
          if (kind === "vacation") checkVacation();
          else {
            document.querySelector('input[name="timeOffMode"][value="day"]').checked = true;
            el.timeOffDate.value = "2031-04-17"; el.timeOffDateTo.value = "2031-04-17";
            checkTimeOff();
          }
        }, kind);
        const count = kind === "vacation" ? 3 : 4;
        await page.waitForFunction(count => checkRequests.length === count, count);
        await page.evaluate(({ count, kind }) => checkRequests[count - 1].resolve({ allowed: false,
          submissionAllowed: true, trafficLight: "red", code: kind === "vacation" ? "VACATION_STAFFING_INSUFFICIENT" : "TIME_OFF_STAFFING_INSUFFICIENT", reason: "BEISPIEL Besetzung knapp" }), { count, kind });
        await page.waitForFunction(kind => !(kind === "vacation" ? el.vacationSubmitButton : el.timeOffSubmitButton).disabled, kind);
        const warning = await page.evaluate(kind => {
          const node = kind === "vacation" ? el.vacationCheck : el.timeOffCheck;
          return { red: node.classList.contains("red"), title: node.querySelector("strong").textContent, note: node.querySelector("small").textContent };
        }, kind);
        assert.equal(warning.red, true);
        assert.match(warning.title, /Antrag möglich/);
        assert.match(warning.note, /Genehmigung wird erneut geprüft/);
        await page.evaluate(async kind => {
          if (kind === "vacation") await submitVacation({ preventDefault() {} });
          else await submitTimeOff({ preventDefault() {} });
        }, kind);
        const submitted = await page.evaluate(kind => calls.filter(call => call.method === "POST"
          && call.route === `/api/portal/v1/me/${kind === "vacation" ? "vacation" : "time-off"}-requests`).length, kind);
        assert.equal(submitted, 1, `${kind}: staffing warning can be submitted for review`);
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
});

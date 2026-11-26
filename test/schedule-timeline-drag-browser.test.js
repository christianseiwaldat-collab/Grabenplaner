"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { functionSource, read, root } = require("../test-support/learning-workspace-ui");
const { planningShiftRevision } = require("../lib/planning-shift-precondition");

const app = read("app.js");
const controls = app.slice(app.indexOf("state.timelineShiftDrag = window.GPScheduleTimelineDrag"),
  app.indexOf('elements.optionList.addEventListener("click"'));
const functions = ["renderTimeline", "canDragTimelineShifts", "readTimelineShift", "saveTimelineShift"]
  .map(name => functionSource(name)).join("\n");
const original = {
  id: 7, employee_number: "E1", location_id: "18", department_id: 2, duty_code: "department",
  shift_date: "2026-12-11", start_time: "09:00", end_time: "13:00", area: "Verkauf", note: " Vermerk ",
  counted_minutes: 240,
};
original.revision = planningShiftRevision(original);

async function openTimeline(page) {
  await page.route("**/*", route => route.abort());
  await page.setContent('<p id="timelineDragHint" class="hidden"></p><div class="timeline-scroll"><div class="timeline" id="timeline"></div></div><dialog id="shiftModal"></dialog>');
  await page.addStyleTag({ path: path.join(root, "public", "styles.css") });
  for (const file of ["schedule-duty.js", "schedule-timeline-drag.js"]) {
    await page.addScriptTag({ path: path.join(root, "public", file) });
  }
  await page.addScriptTag({ content: [
    "const original = " + JSON.stringify(original) + ";",
    fixtureSource(),
    functions, controls, "renderTimeline();",
  ].join("\n") });
}

function fixtureSource() {
  return `
    const state = { weekStart: "2026-12-07", locationId: "18", departmentId: "", currentView: "planning",
      portalStatus: { portalEnabled: true }, portalSession: { user: { permissions: ["schedule:write"] } },
      data: { weekStart: "2026-12-07", context: { locationId: "18" }, settings: {}, weekOptions: [], shifts: [original],
        employees: [
          { personnel_number: "E1", full_name: "Elisa Beispiel", color: "#44dfa4" },
          { personnel_number: "E2", full_name: "Oskar Beispiel", color: "#eb57b2" },
        ] } };
    const elements = { timeline: document.getElementById("timeline"), shiftModal: document.getElementById("shiftModal") };
    const weekdayNames = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
    const optionLabels = {};
    const writes = [], messages = [], editorCalls = [];
    let reads = 0, shiftMutation = null, nextShift = null, failure = null;
    window.fixture = { state, writes, messages, editorCalls, get reads() { return reads; },
      rejectNext(code) { failure = code; }, render() { renderTimeline(); } };
    const timeToMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
    const safeCssColor = color => color;
    const contrastColor = () => "#172331";
    const escapeHtml = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    const escapeHtmlAttribute = escapeHtml;
    const formatHours = minutes => (minutes / 60) + " h";
    const scheduleHasSundayEntries = () => false;
    const addDays = (date, days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
    const scheduleEmployeesForDate = () => state.data.employees;
    const scheduleEmployeeAccessibleLabel = employee => employee.full_name;
    const xoffiImportedBadge = () => "";
    const isAutomaticallyWeekLocked = () => false;
    const isWeekLocked = () => Boolean(state.data.manualScheduleLock?.locked);
    const globalBlockForDate = date => date === "2026-12-08" ? { reason: "Feiertag" } : null;
    const publicHolidayForDate = () => null;
    const dayConfig = () => ({ start: "09:00", end: "18:00" });
    const collapsedWeekOptions = options => options;
    const specialCasesFor = () => [];
    const staffAssignmentsForDate = () => [];
    const employeeCanWorkOnDate = () => true;
    const departmentsForLocation = () => [{ id: 2, name: "Verkauf", code: "HW" }];
    const formatDate = date => date;
    const captureGpContext = (canUse, source) => ({ canUse, source, value: source() });
    const gpContextCurrent = context => context.canUse() && context.source() === context.value;
    const showToast = (message, error) => messages.push({ message, error: Boolean(error) });
    const openShiftModalForPlanningDate = (...args) => editorCalls.push(args);
    async function api(url, options) {
      const body = JSON.parse(options.body);
      writes.push({ url, method: options.method, body });
      if (failure) {
        const code = failure;
        failure = null;
        throw Object.assign(new Error("Dienst wurde inzwischen geändert."), { code });
      }
      nextShift = { ...state.data.shifts[0], shift_date: body.date, start_time: body.startTime,
        end_time: body.endTime, revision: String(writes.length).padStart(64, "0") };
    }
    async function loadPlanningPeriod() {
      reads++;
      if (nextShift) state.data.shifts = [nextShift];
      nextShift = null;
      renderTimeline();
    }
  `;
}

const block = page => page.locator('[data-shift-id="7"]');

async function drag(page, target, destination) {
  const bounds = await target.boundingBox();
  assert.ok(bounds);
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const { x: toX = x, y: toY = y } = destination(x, y);
  await page.mouse.move(toX, toY, { steps: 8 });
}

async function release(page, writes) {
  await page.mouse.up();
  await page.waitForFunction(count => fixture.writes.length === count
    && !document.getElementById("timeline").hasAttribute("aria-busy"), writes);
}

test("timeline drag resizes and moves shifts in the original employee lane", {
  skip: process.env.GP_WINDOW_BROWSER_TEST !== "1", timeout: 30000,
}, async () => {
  const { chromium } = require(process.env.GP_BROWSER_TEST_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true,
    ...(process.env.GP_BROWSER_EXECUTABLE ? { executablePath: process.env.GP_BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
    page.setDefaultTimeout(4500);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await openTimeline(page);
    const grid = await page.locator(".day-body").first().boundingBox();
    const hour = grid.height / 16;

    await drag(page, block(page), (x, y) => ({ x, y: y + 1.5 * hour }));
    assert.equal(await page.locator(".shift-drag-preview").textContent(), "10:30–14:30");
    await release(page, 1);
    const first = await page.evaluate(() => fixture.writes[0]);
    assert.deepEqual(first, { url: "/api/shifts/7", method: "PUT", body: {
      date: "2026-12-11", startTime: "10:30", endTime: "14:30", employeeNumber: "E1",
      locationId: "18", area: "Verkauf", note: " Vermerk ", expectedRevision: original.revision,
    } });

    const otherEmployeeOnThursday = await page.locator('[data-timeline-date="2026-12-10"] [data-timeline-employee="E2"]').boundingBox();
    await drag(page, block(page), () => ({ x: otherEmployeeOnThursday.x + otherEmployeeOnThursday.width / 2 }));
    const thursday = page.locator('[data-timeline-date="2026-12-10"] [data-timeline-employee="E1"]');
    assert.equal(await thursday.locator(".shift-drag-preview").textContent(), "10:30–14:30");
    await release(page, 2);
    assert.equal(await thursday.locator('[data-shift-id="7"]').count(), 1);

    await drag(page, block(page).locator('[data-shift-edge="start"]'), (x, y) => ({ x, y: y - hour / 2 }));
    assert.equal(await thursday.locator(".shift-drag-preview").textContent(), "10:00–14:30");
    await release(page, 3);
    await drag(page, block(page).locator('[data-shift-edge="end"]'), (x, y) => ({ x, y: y - hour }));
    assert.equal(await thursday.locator(".shift-drag-preview").textContent(), "10:00–13:30");
    await release(page, 4);

    const holiday = await page.locator('[data-timeline-date="2026-12-08"] .day-body').boundingBox();
    await drag(page, block(page), () => ({ x: holiday.x + holiday.width / 2 }));
    await release(page, 4);
    assert.deepEqual(await page.evaluate(() => fixture.messages.at(-1)), { message: "Feiertag", error: true });

    await drag(page, block(page), (x, y) => ({ x, y: y + hour }));
    await page.keyboard.press("Escape");
    await release(page, 4);
    assert.equal(await page.locator(".shift-drag-preview").count(), 0);
    assert.equal(await page.evaluate(() => fixture.editorCalls.length), 0);
    await block(page).click();
    assert.equal(await page.evaluate(() => fixture.editorCalls.length), 1);

    await page.evaluate(() => fixture.rejectNext("SHIFT_REVISION_CONFLICT"));
    await drag(page, block(page), (x, y) => ({ x, y: y + hour }));
    await release(page, 5);
    assert.deepEqual(await page.evaluate(() => [fixture.state.data.shifts[0].start_time, fixture.reads]), ["10:00", 5]);

    await page.evaluate(() => { fixture.state.data.manualScheduleLock = { locked: true }; fixture.render(); });
    assert.equal(await block(page).locator("[data-shift-edge]").count(), 0);

    await page.setViewportSize({ width: 515, height: 800 });
    await page.evaluate(() => { fixture.state.data.manualScheduleLock.locked = false; fixture.render(); });
    const scrollArea = await page.locator(".timeline-scroll").boundingBox();
    await drag(page, block(page), () => ({ x: scrollArea.x + scrollArea.width - 10 }));
    await page.waitForFunction(() => {
      const area = document.querySelector(".timeline-scroll");
      return area.scrollLeft > 0 && area.scrollLeft >= area.scrollWidth - area.clientWidth - 1;
    });
    await release(page, 6);
    assert.equal(await page.locator('[data-timeline-date="2026-12-12"] [data-shift-id="7"]').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

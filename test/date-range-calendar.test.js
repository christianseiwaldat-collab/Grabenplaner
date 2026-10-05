"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createDateRangeCalendar, calendarDays, selectRangeDate, rangeLabel, shiftMonth, selectionMaximum, selectionCanCommit,
} = require("../public/date-range-calendar");

test("Zeitraumskalender beginnt montags und liefert sechs vollständige Wochen", () => {
  const days = calendarDays("2026-07-01");
  assert.equal(days.length, 42);
  assert.equal(days[0], "2026-06-29");
  assert.equal(days[41], "2026-08-09");
});

test("erste Auswahl setzt den Beginn, zweite Auswahl das Ende", () => {
  const start = selectRangeDate({}, "2026-07-14");
  assert.deepEqual(start, { start: "2026-07-14", end: "" });
  assert.deepEqual(selectRangeDate(start, "2026-07-14"), { start: "2026-07-14", end: "2026-07-14" });
  assert.deepEqual(selectRangeDate(start, "2026-07-18"), { start: "2026-07-14", end: "2026-07-18" });
  assert.deepEqual(selectRangeDate(start, "2026-07-10"), { start: "2026-07-10", end: "" });
});

test("offenes Ende und Monatswechsel werden eindeutig dargestellt", () => {
  assert.match(rangeLabel("2026-07-14", ""), /14\.07\.2026.*Ende offen/);
  assert.equal(shiftMonth("2026-12-01", 1), "2027-01-01");
});

test("maximales Ende wird an den gewählten Beginn gekoppelt", () => {
  assert.equal(selectionMaximum({ start: "2025-07-14", end: "", maxEndDays: 365 }), "2026-07-14");
  assert.equal(selectionMaximum({ start: "2026-07-14", end: "", maxEndDays: 365 }), "2027-07-14");
  assert.equal(selectionMaximum({ start: "2026-07-14", end: "2026-07-20", maxStart: "2026-07-14" }), "2026-07-14");
});

test("ein abgewähltes offenes Ende verlangt eine Endauswahl", () => {
  assert.equal(selectionCanCommit({ start: "2026-07-14", end: "", allowOpenEnd: true, openEndSelected: true }), true);
  assert.equal(selectionCanCommit({ start: "2026-07-14", end: "", allowOpenEnd: true, openEndSelected: false }), false);
  assert.equal(selectionCanCommit({ start: "2026-07-14", end: "2026-07-20", allowOpenEnd: true, openEndSelected: false }), true);
});

function calendarFixture() {
  const element = () => ({
    listeners: {}, classList: { toggle() {} },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    fire(type, event = {}) { this.listeners[type]?.(event); },
  });
  const grid = element(), applyButton = element(), openEndCheckbox = element();
  openEndCheckbox.closest = () => element();
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; }, querySelectorAll: () => [] };
  const calendar = createDateRangeCalendar({ dialog, grid, title: element(), summary: element(), applyButton, openEndCheckbox });
  const commits = [];
  return {
    dialog, applyButton, openEndCheckbox, commits,
    open(config) { calendar.open({ month: "2026-07-01", onCommit: (...range) => commits.push(range), ...config }); },
    day(date) {
      const button = grid.innerHTML.match(new RegExp(`<button[^>]*data-range-date="${date}"[^>]*>`));
      assert.ok(button, `Rendered day ${date}`);
      return { dataset: { rangeDate: date }, disabled: /\sdisabled(?:\s|>)/.test(button[0]) };
    },
    click(date) {
      const button = this.day(date);
      grid.fire("click", { target: { closest: () => button } });
    },
  };
}

test("AUM with an explicit null day limit accepts a multi-day range; omitted limits remain unrestricted", () => {
  for (const limits of [{ maxEndDays: null }, {}]) {
    const fixture = calendarFixture();
    fixture.open({ ...limits, min: "2016-01-01", maxStart: "2036-12-31", maxEnd: "2036-12-31", allowOpenEnd: true });
    fixture.click("2026-07-14");
    assert.equal(fixture.day("2026-07-18").disabled, false);
    fixture.click("2026-07-18");
    fixture.applyButton.fire("click");
    assert.deepEqual(fixture.commits, [["2026-07-14", "2026-07-18"]]);
    assert.equal(fixture.openEndCheckbox.checked, false);
    assert.equal(fixture.dialog.open, false);
  }
});

test("explicit zero and finite day limits still constrain the rendered end selection", () => {
  for (const [limit, lastAllowed, firstDisabled] of [[0, "2026-07-14", "2026-07-15"], [3, "2026-07-17", "2026-07-18"], ["3", "2026-07-17", "2026-07-18"]]) {
    const fixture = calendarFixture();
    fixture.open({ maxEndDays: limit, allowOpenEnd: false });
    fixture.click("2026-07-14");
    assert.equal(fixture.day(lastAllowed).disabled, false);
    assert.equal(fixture.day(firstDisabled).disabled, true);
    fixture.click(firstDisabled);
    assert.equal(fixture.applyButton.disabled, true);
    fixture.click(lastAllowed);
    fixture.applyButton.fire("click");
    assert.deepEqual(fixture.commits, [["2026-07-14", lastAllowed]]);
  }
});

test("null day limit retains the absolute end boundary and explicit open-end selection", () => {
  const fixture = calendarFixture();
  fixture.open({ maxEndDays: null, maxEnd: "2026-07-16", allowOpenEnd: true });
  fixture.click("2026-07-14");
  assert.equal(fixture.day("2026-07-16").disabled, false);
  assert.equal(fixture.day("2026-07-17").disabled, true);
  fixture.openEndCheckbox.checked = false;
  fixture.openEndCheckbox.fire("change");
  assert.equal(fixture.applyButton.disabled, true);
  fixture.openEndCheckbox.checked = true;
  fixture.openEndCheckbox.fire("change");
  fixture.applyButton.fire("click");
  assert.deepEqual(fixture.commits, [["2026-07-14", ""]]);
});

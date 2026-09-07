"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { manualPlanningHours, PLANNING_DAY_COUNT, DEFAULT_DUTY_COLORS,
  normalizeScheduleDutyColors, scheduleDutyColor, scheduleDutyTextColor,
  scheduleEmployeeInitials } = require("../public/schedule-duty");

test("Manual planning is 07–23 on seven days without changing opening hours", () => {
  assert.equal(PLANNING_DAY_COUNT, 7);
  assert.deepEqual(manualPlanningHours(), { open: true, start: "07:00", end: "23:00" });
  assert.ok(Object.isFrozen(manualPlanningHours()));
});

test("Company duty colors are strict RGB maps, tolerant only when reading legacy settings", () => {
  const palette = { ...DEFAULT_DUTY_COLORS, FL: "#ff123a" };
  assert.equal(normalizeScheduleDutyColors(palette, { strict: true }).FL, "#FF123A");
  assert.equal(scheduleDutyColor("FL", JSON.stringify(palette)), "#FF123A");
  assert.equal(scheduleDutyColor("XX", "invalid"), DEFAULT_DUTY_COLORS.AG);
  for (const input of [null, [], "{}", {}, { ...palette, XX: "#000000" }, { ...palette, FL: "red" },
    { ...palette, FL: "#123" }, { ...palette, FL: "url(evil)" }]) {
    assert.throws(() => normalizeScheduleDutyColors(input, { strict: true }));
  }
  assert.deepEqual(normalizeScheduleDutyColors({ FL: "bad" }), DEFAULT_DUTY_COLORS);
});

test("Duty badge foreground maximizes black/white contrast for arbitrary RGB colors", () => {
  assert.equal(scheduleDutyTextColor("#FFFFFF"), "#000000");
  assert.equal(scheduleDutyTextColor("#000000"), "#FFFFFF");
  assert.equal(scheduleDutyTextColor("#FFFF00"), "#000000");
  assert.equal(scheduleDutyTextColor("#0000FF"), "#FFFFFF");
});

test("Personnel initials have one canonical given/family order in timeline and profile", () => {
  for (const employee of [
    { full_name: "Christian Seiwald", nickname: "Christian" },
    { full_name: "Seiwald Christian", nickname: "Christian" },
    { full_name: "Seiwald, Christian" },
    { first_name: "Christian", last_name: "Seiwald", full_name: "Seiwald Christian" },
  ]) assert.equal(scheduleEmployeeInitials(employee), "CS");
  assert.equal(scheduleEmployeeInitials({ full_name: "Änne Überall" }), "ÄÜ");
  assert.equal(scheduleEmployeeInitials({ full_name: "Alex" }), "A");
  assert.equal(scheduleEmployeeInitials(null), "?");
});

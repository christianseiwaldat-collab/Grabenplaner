"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { previousRegularWorkdays } = require("../test-support/planning-workday-fixture");

for (const [reference, expected] of [
  ["2026-10-27", ["2026-10-23", "2026-10-22", "2026-10-21"]],
  ["2026-04-07", ["2026-04-03", "2026-04-02", "2026-04-01"]],
  ["2026-12-28", ["2026-12-24", "2026-12-23", "2026-12-22"]],
  ["2026-01-07", ["2026-01-05", "2026-01-02", "2025-12-31"]],
  ["2026-10-26", ["2026-10-23", "2026-10-22", "2026-10-21"]],
  ["2026-10-28", ["2026-10-27", "2026-10-23", "2026-10-22"]],
]) {
  test(`ordinary sickness workday fixtures before ${reference}`, () => {
    assert.deepEqual(previousRegularWorkdays(reference, 3), expected);
    assert.deepEqual(previousRegularWorkdays(reference, 1), expected.slice(0, 1));
  });
}

"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { buildSeries, dialIndex, validHistory } = require("../public/system-utilization");
const at = offset => new Date(Date.UTC(2031, 3, 7, 12, 0, offset)).toISOString();
const measure = (avg, count = 1) => ({ avg, min: avg, max: avg, count });
const point = (offset, cpu, memory = 40, extra = {}) => ({ at: at(offset), until: at(offset + 10), sampleCount: 1, cpu: measure(cpu), memory: measure(memory), ...extra });
const history = points => ({ schemaVersion: 1, generatedAt: at(40), scope: "host", intervalSeconds: 10, status: "ready", hours: 1, from: at(0), to: at(40), resolutionSeconds: 10, points });
test("Fixed 0–100 measurements preserve genuine zero and weighted min/max", () => {
  const result = buildSeries(history([point(0, 0), point(10, 50, 40, { sampleCount: 3, cpu: { avg: 50, min: 10, max: 90, count: 3 } })]), "cpu");
  assert.equal(result.segments.length, 1); assert.equal(result.segments[0][0].avg, 0);
  assert.deepEqual(result.summary, { count: 4, avg: 37.5, min: 0, max: 90 });
});
test("Missing buckets and missing CPU values never become zero or connect across gaps", () => {
  const input = history([point(0, 20), point(10, null, 42, { cpu: { avg: null, min: null, max: null, count: 0 } }), point(20, 30)]);
  assert.deepEqual(buildSeries(input, "cpu").segments.map(segment => segment.length), [1, 1]);
  assert.deepEqual(buildSeries(input, "memory").segments.map(segment => segment.length), [3]);
  assert.equal(buildSeries(input, "cpu").summary.count, 2);
  assert.deepEqual(buildSeries(history([point(0, 20), point(20, 30)]), "cpu").segments.map(segment => segment.length), [1, 1]);
});
test("Partial gaps remain isolated; invalid and unverified values do not produce a line", () => {
  const input = history([point(0, 20), point(10, 30, 40, { hasGap: true }), point(20, 40)]);
  assert.deepEqual(buildSeries(input, "cpu").segments.map(segment => segment.length), [1, 1, 1]);
  assert.equal(buildSeries(history([point(0, -1), point(10, 101), point(20, 4, 40, { cpu: { avg: 4, min: 5, max: 10, count: 1 } })]), "cpu").summary, null);
  assert.equal(buildSeries({ ...input, integrityVerified: false }, "cpu").summary, null);
  assert.equal(buildSeries(input, "database").summary, null);
});
test("History validation binds schema, requested window and fixed recording interval", () => {
  const value = history([point(0, 0)]); assert.equal(validHistory(value, 1), true);
  for (const patch of [{ hours: 6 }, { scope: "process" }, { intervalSeconds: 1 }, { schemaVersion: 2 }, { status: "invented" }, { generatedAt: "invalid" }, { from: at(40) }, { points: Array(1201).fill(point(0, 20)) }]) assert.equal(Boolean(validHistory({ ...value, ...patch }, 1)), false);
});
test("Discrete dial retains its selection in center or lower dead sector", () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 };
  assert.equal(dialIndex(50, 0, rect, 8, 2), 4);
  assert.equal(dialIndex(50, 50, rect, 8, 2), 2);
  assert.equal(dialIndex(50, 100, rect, 8, 2), 2);
  assert.equal(dialIndex(100, 50, rect, 8, 2), 6);
  assert.equal(dialIndex(NaN, 50, rect, 8, 2), 2);
});

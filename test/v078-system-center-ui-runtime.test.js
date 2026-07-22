"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

function loadFunction(name, nextName) {
  const start = script.indexOf(`function ${name}`);
  const end = script.indexOf(`function ${nextName}`, start);
  assert.notEqual(start, -1, `${name} fehlt`);
  assert.notEqual(end, -1, `${nextName} fehlt`);
  const context = vm.createContext({ Date, Number, Array });
  vm.runInContext(`${script.slice(start, end)}\nthis.subject = ${name};`, context);
  return context.subject;
}

test("v0.78: redigierte oder fehlende Trendwerte bleiben null und werden nicht zu null Byte", () => {
  const normalize = loadFunction("normalizedSystemCenterTrendPoints", "renderSystemCenterSparkline");
  const points = normalize({
    points: [{
      at: "2026-07-22T00:00:00.000Z",
      trustScore: null,
      databaseBytes: null,
      backupDurationSeconds: undefined,
      recoveryDurationSeconds: "",
    }],
  });
  assert.equal(points.length, 1);
  assert.equal(points[0].trustScore, null);
  assert.equal(points[0].databaseBytes, null);
  assert.equal(points[0].backupDurationSeconds, null);
  assert.equal(points[0].recoveryDurationSeconds, null);
});

test("v0.78: echte numerische Nullwerte und positive Messwerte bleiben erhalten", () => {
  const normalize = loadFunction("normalizedSystemCenterTrendPoints", "renderSystemCenterSparkline");
  const points = normalize({
    points: [{
      at: "2026-07-22T00:00:00.000Z",
      trustScore: 0,
      databaseBytes: "4096",
      backupDurationSeconds: 0,
      recoveryDurationSeconds: 12.5,
    }],
  });
  assert.equal(points[0].trustScore, 0);
  assert.equal(points[0].databaseBytes, 4096);
  assert.equal(points[0].backupDurationSeconds, 0);
  assert.equal(points[0].recoveryDurationSeconds, 12.5);
});

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const worker = path.join(__dirname, "..", "test-support", "security-canvas-native-worker.js");

// A parser crash, native abort or stalled decoder must become an ordinary test
// failure with a bounded lifetime, rather than taking the application suite down.
for (const scenario of ["binary-sbom", "malformed-raster", "encode-lifetime", "pattern-gc", "local-font", "pdf-render"]) {
  test(`native canvas: ${scenario} in an isolated process`, { timeout: 65000 }, () => {
    const result = spawnSync(process.execPath, ["--expose-gc", worker, scenario], {
      encoding: "utf8",
      timeout: 60000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, GP_CANVAS_QUALIFICATION_SCENARIO: scenario },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, `${scenario} terminated by ${result.signal}: ${result.stderr}`);
    assert.equal(result.status, 0, `${scenario} failed: ${result.stderr}\n${result.stdout}`);
    const line = result.stdout.split(/\r?\n/).find(value => value.startsWith("GP_CANVAS_QUALIFICATION "));
    assert.ok(line, `Missing native qualification result: ${result.stdout}`);
    const report = JSON.parse(line.slice("GP_CANVAS_QUALIFICATION ".length));
    assert.equal(report.scenario, scenario);
    assert.equal(report.version, "1.0.13");
    assert.equal(report.passed, true);
    assert.equal(report.platform, process.platform);
    assert.equal(report.architecture, process.arch);
    console.log(line);
  });
}

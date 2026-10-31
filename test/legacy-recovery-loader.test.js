"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { isLinuxLoaderPath } = require("../scripts/legacy-recovery-capsule");

test("native runtime inventory recognizes Linux loaders and rejects malformed library names", () => {
  for (const file of ["/lib64/ld-linux-x86-64.so.2", "/lib/ld-linux-aarch64.so.1", "/lib/ld-linux.so", "/lib/ld-linux.so.1.2"]) {
    assert.equal(isLinuxLoaderPath(file), true, file);
  }
  for (const file of [null, undefined, "ld-linux.so.2", "/lib/libc.so.6", "/lib/ld-linux", "/lib/ld-linux.so.",
    "/lib/ld-linux.so..2", "/lib/ld-linux.so.2x", "/lib/ld-linux.so.2\n", "/lib/ld-linux.so.2/other"]) {
    assert.equal(isLinuxLoaderPath(file), false, String(file));
  }
});

test("native loader classification scans long suffixes without ambiguous repetition", () => {
  assert.equal(isLinuxLoaderPath("/lib/ld-linux" + ".so.123456789".repeat(30000) + "x"), false);
  assert.equal(isLinuxLoaderPath("/lib/ld-linux.so." + "123456789".repeat(30000)), true);
  assert.equal(isLinuxLoaderPath("/lib/ld-linux.so." + "1.".repeat(30000)), false);
});

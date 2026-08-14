"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const scripts = [
  "server-tools/linux/update-grabenplaner-server.sh",
  "server-tools/linux/finalize-grabenplaner-runtime-v3.sh",
  "server-tools/linux/migrate-grabenplaner-runtime-v2.sh",
  "server-tools/linux/migrate-grabenplaner-runtime-v3.sh",
  "server-tools/linux/migrate-grabenplaner-runtime-v4.sh",
];

test("v0.92.5: Updater und Runtime-Migrationen verwenden dauerhaft 1500 Sekunden Health-Timeout", () => {
  for (const relativePath of scripts) {
    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    assert.match(source, /health_timeout=1500/, relativePath);
    assert.match(source, /health_timeout <= 1500/, relativePath);
    assert.match(source, /zwischen 30 und 1500/, relativePath);
    assert.doesNotMatch(source, /health_timeout <= 600/, relativePath);
  }
});

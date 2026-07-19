"use strict";

const fs = require("node:fs");
const path = require("node:path");

const [modulePath, databasePath, readyPath] = process.argv.slice(2);
if (![modulePath, databasePath, readyPath].every(Boolean)) {
  console.error("Wartungslock-Parameter fehlen.");
  process.exit(1);
}

let handle;
let finished = false;
function finish(exitCode = 0) {
  if (finished) return;
  finished = true;
  try {
    if (handle) require(path.resolve(modulePath)).releaseDatabaseLock(handle);
  } finally {
    process.exit(exitCode);
  }
}

try {
  const { acquireDatabaseLock } = require(path.resolve(modulePath));
  handle = acquireDatabaseLock({ databasePath, kind: "backup", appVersion: "linux-update-maintenance" });
  fs.writeFileSync(path.resolve(readyPath), `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
} catch (error) {
  console.error(error?.message || "Datenbank-Wartungslock fehlgeschlagen.");
  process.exit(1);
}

process.on("SIGTERM", () => finish(0));
process.on("SIGINT", () => finish(0));
process.stdin.resume();

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const targetDatabase = path.resolve(String(process.argv[2] || ""));
const appRoot = path.resolve(String(process.argv[3] || path.join(path.dirname(targetDatabase), "..")));

if (!targetDatabase || path.extname(targetDatabase).toLowerCase() !== ".db") {
  throw new Error("Zielpfad für die portable SQLite-Datenbank fehlt.");
}

fs.mkdirSync(path.dirname(targetDatabase), { recursive: true });
process.env.DB_PATH = targetDatabase;
process.env.GRABENPLANER_DATA_DIR = appRoot;
process.env.GRABENPLANER_OPERATION_MODE = "local";
process.env.GRABENPLANER_HOST = "127.0.0.1";
process.env.NODE_ENV = "test";
delete process.env.GRABENPLANER_SEED_DEMO;
delete process.env.GRABENPLANER_FORCE_PORTAL;

const application = require("../server");
try {
  const result = application.db.prepare("PRAGMA quick_check").get();
  if (String(Object.values(result || {})[0] || "").toLowerCase() !== "ok") {
    throw new Error("Die neue SQLite-Datenbank hat die Integritätsprüfung nicht bestanden.");
  }
} finally {
  application.db.close();
  application.releaseInstanceLockForTests();
}

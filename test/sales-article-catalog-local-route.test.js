"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grabenplaner-article-search-local-"));
process.env.DB_PATH = path.join(testRoot, "dienstplan.db");
process.env.BACKUP_DIR = path.join(testRoot, "backups");
process.env.GRABENPLANER_DATA_DIR = path.join(testRoot, "app-data");
process.env.GRABENPLANER_OPERATION_MODE = "local";
process.env.GRABENPLANER_HOST = "127.0.0.1";
delete process.env.GRABENPLANER_FORCE_PORTAL;
process.env.GRABENPLANER_SEED_DEMO = "1";
process.env.GRABENPLANER_TEST_AMU_SCANNER = "clean";
process.env.NODE_ENV = "test";
process.env.TZ = "Europe/Vienna";

const subject = require("../server");
const { app, db, getPortalStatus } = subject;
let httpServer;
let baseUrl;

test.before(async () => {
  assert.equal(getPortalStatus().portalEnabled, false);
  await new Promise((resolve, reject) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try { db.close(); } catch {}
  subject.releaseInstanceLockForTests();
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test("Lokaler Einzelplatz öffnet die Artikelsuche ohne künstliches Mitarbeiterkonto", async () => {
  const response = await fetch(`${baseUrl}/api/sales/articles?status=all&limit=10&offset=0`, {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(Array.isArray(payload.items), true);
  assert.equal(Number.isInteger(payload.total), true);
});

test("Lokaler Einzelplatz erreicht auch die Detailroute ohne künstliches Mitarbeiterkonto", async () => {
  const response = await fetch(
    `${baseUrl}/api/sales/articles/detail?articleNumber=NICHT-VORHANDEN`,
    { headers: { Accept: "application/json" } },
  );
  const payload = await response.json();
  assert.equal(response.status, 404, JSON.stringify(payload));
  assert.equal(payload.code, "SALES_ARTICLE_NOT_FOUND");
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createPortalAccessRepository,
} = require("../lib/persistence/repositories/portal-access");
const {
  SQLITE_PORTAL_ACCESS_CATALOG,
} = require("../lib/persistence/sqlite/portal-access-catalog");
const {
  ensureSqliteApplicationSchema,
} = require("../lib/persistence/sqlite/operations/application-schema");
const {
  PORTAL_ACCESS_STATEMENTS,
} = require("../lib/persistence/statements/portal-access");


test("Block 3/7: Portal-Access-Katalog deckt jedes typisierte Statement genau einmal ab", () => {
  const statements = Object.values(PORTAL_ACCESS_STATEMENTS);
  assert.equal(SQLITE_PORTAL_ACCESS_CATALOG.length, statements.length);
  assert.equal(
    new Set(SQLITE_PORTAL_ACCESS_CATALOG.map(({ statement }) => statement.id)).size,
    statements.length,
  );
  assert.deepEqual(
    statements.filter((statement) => (
      !SQLITE_PORTAL_ACCESS_CATALOG.some((entry) => entry.statement === statement)
    )),
    [],
  );
});

test("Block 3/7: USB-Ersteller-Serverpfad bleibt raw-frei und wird abgewartet", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const creatorSlice = source.match(
    /async function usbCreatorCandidates[\s\S]*?function usbCandidateOptions/,
  )?.[0] || "";
  assert.ok(creatorSlice);
  assert.doesNotMatch(creatorSlice, /\bdb\.(?:prepare|exec)\b/);
  assert.match(creatorSlice, /await portalAccessRepository\.listUsbCreatorCandidates/);
  assert.match(creatorSlice, /await portalAccessRepository\.getUsbCreator/);

  const statusRoute = source.match(
    /app\.get\("\/api\/usb-provisioning\/status"[\s\S]*?app\.get\("\/api\/usb-provisioning\/drives"/,
  )?.[0] || "";
  assert.match(statusRoute, /creators:\s*await usbCreatorCandidates\(session\)/);
});

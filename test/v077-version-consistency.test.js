const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("v0.77: historischer System-Center-Block bleibt nachvollziehbar dokumentiert", () => {
  const versionLog = read("VERSIONS-LOG.md");
  assert.match(versionLog, /## v0\.77 Beta · System-Center und technischer Vertrauensindex/);
  assert.match(versionLog, /signierte Recovery-Assurance-Historie erscheint als redigierte Timeline/);
  assert.match(versionLog, /isolierte App-Smoke-Test, nächtliche Vollautomatismus, Benachrichtigungen und Langzeitdiagramme bleiben bewusst Block 3 vorbehalten/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Versionsstatus trennt Quellstand, ausgelieferten Serverstand und Legacy", () => {
  const versionLog = read("VERSIONS-LOG.md");
  const packageJson = JSON.parse(read("package.json"));
  assert.ok(versionLog.includes(`v${packageJson.version.replace("-beta", " Beta")} · Quellstand`));
  assert.match(versionLog, /v0\.92\.72 Beta · Produktiver Serverstand/);
  assert.match(versionLog, /v0\.87\.0-beta\.legacy\.1 · Legacy/);
  assert.match(versionLog, /noch nicht als Serverrelease freigegeben/);
  assert.equal((versionLog.match(/^## /gm) || []).length, 3);
});

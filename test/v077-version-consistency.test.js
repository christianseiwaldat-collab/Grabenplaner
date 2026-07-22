const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("v0.77: Paket, Launcher, UI und aktuelle Dokumentation bleiben konsistent", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.version, "0.77.0-beta");

  assert.equal(fs.existsSync(path.join(root, "Grabenplaner v0.77 Beta starten.cmd")), true);
  assert.equal(fs.existsSync(path.join(root, "Grabenplaner v0.76 Beta starten.cmd")), false);

  const indexHtml = read("public/index.html");
  assert.match(indexHtml, /v0\.77 Beta/);

  const readme = read("README.md");
  const serverDocs = read("SERVERBETRIEB.md");
  const usbNotes = read("USB-HINWEISE.txt");
  const versionLog = read("VERSIONS-LOG.md");

  assert.match(readme, /v0\.77 Beta/);
  assert.match(serverDocs, /Mit v0\.77 steigt[\s\S]{0,200}Version 2 auf Version 3/);
  assert.match(usbNotes, /Version v0\.77 Beta/);
  assert.match(usbNotes, /System-Center zeigt den nachweisbasierten technischen Vertrauensindex/);
  assert.match(usbNotes, /Offsite-Modulversion 2 wird nicht still durch das Kernupdate/);
  assert.match(usbNotes, /Modulversion 3 im beaufsichtigten/);
  assert.doesNotMatch(usbNotes, /noch kein System-Center oder einen\s+Vertrauensindex/);
  assert.doesNotMatch(usbNotes, /Offsite-Modulversion 1 wird nicht still migriert/);
  assert.match(versionLog, /v0\.77 Beta/);
});

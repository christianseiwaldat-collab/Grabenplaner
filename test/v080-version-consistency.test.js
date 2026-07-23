const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("v0.80: Paket, Launcher, UI und aktuelle Dokumentation bleiben konsistent", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.version, "0.80.0-beta");

  assert.equal(fs.existsSync(path.join(root, "Grabenplaner v0.80 Beta starten.cmd")), true);
  assert.equal(fs.existsSync(path.join(root, "Grabenplaner v0.79 Beta starten.cmd")), false);
  assert.equal(fs.existsSync(path.join(root, "Grabenplaner v0.78.7 Beta starten.cmd")), false);
  assert.equal(fs.existsSync(path.join(root, "Grabenplaner v0.78.6 Beta starten.cmd")), false);
  assert.equal(fs.existsSync(path.join(root, "Grabenplaner v0.78.5 Beta starten.cmd")), false);
  assert.equal(fs.existsSync(path.join(root, "Grabenplaner v0.78.4 Beta starten.cmd")), false);
  assert.equal(fs.existsSync(path.join(root, "Grabenplaner v0.78.3 Beta starten.cmd")), false);
  assert.equal(fs.existsSync(path.join(root, "Grabenplaner v0.78.2 Beta starten.cmd")), false);
  assert.equal(fs.existsSync(path.join(root, "Grabenplaner v0.78.1 Beta starten.cmd")), false);
  assert.equal(fs.existsSync(path.join(root, "Grabenplaner v0.78 Beta starten.cmd")), false);

  const indexHtml = read("public/index.html");
  const readme = read("README.md");
  const serverDocs = read("SERVERBETRIEB.md");
  const usbNotes = read("USB-HINWEISE.txt");
  const versionLog = read("VERSIONS-LOG.md");

  assert.match(indexHtml, /v0\.80 Beta/);
  assert.match(readme, /v0\.80 Beta/);
  assert.match(readme, /Entziehbare Rollen-Grundrechte/);
  assert.match(readme, /Revisionssichere Fallverwaltung/);
  assert.match(readme, /nächtliche Recovery-Assurance-Automatik/);
  assert.match(serverDocs, /Recovery Assurance und System-Center v0\.78/);
  assert.match(usbNotes, /Version v0\.80 Beta/);
  assert.match(versionLog, /v0\.80 Beta/);
  assert.match(versionLog, /v0\.79 Beta/);
  assert.match(versionLog, /v0\.78\.7 Beta/);
  assert.match(versionLog, /v0\.78\.6 Beta/);
  assert.match(versionLog, /v0\.78\.5 Beta/);
  assert.match(versionLog, /v0\.78\.4 Beta/);
  assert.match(versionLog, /v0\.78\.3 Beta/);
  assert.match(versionLog, /v0\.78\.2 Beta/);
  assert.match(versionLog, /v0\.78\.1 Beta/);
  assert.match(versionLog, /v0\.78 Beta/);
  assert.doesNotMatch(readme, /v0\.77 enthält noch keinen nächtlichen/);
});

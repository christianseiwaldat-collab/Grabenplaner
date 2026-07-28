const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

test("Rechteeditor zeigt alle vier persönlichen Rechtezustände", () => {
  assert.match(html, /Grundrecht der Rolle/);
  assert.match(html, /Individuell hinzugefügt/);
  assert.match(html, /Individuell entzogen/);
  assert.match(html, /Nicht vergeben/);
  assert.match(script, /data-rights-permission/);
  assert.match(script, /data-role-permission=/);
  assert.match(script, /updateRightsEditorPermissionStatus/);
  assert.match(styles, /\.rights-permission\.revoked-right/);
  assert.match(styles, /\.rights-permission\.unassigned-right/);
  assert.doesNotMatch(script, /data-additional-permission/);
});

test("Rechteeditor sendet getrennte Freigaben, Entzüge und Bereiche", () => {
  assert.match(script, /JSON\.stringify\(\{ grantedPermissions, deniedPermissions, scopes \}\)/);
  assert.doesNotMatch(script, /JSON\.stringify\(\{ permissions \}\)/);
  assert.match(script, /dataset\.rolePermission !== "true" && input\.checked/);
  assert.match(script, /dataset\.rolePermission === "true" && !input\.checked/);
  assert.match(script, /departmentId: context\.departmentId/);
  assert.match(script, /departmentId: null/);
});

test("Dienstplan-Schreibrecht bleibt vom Leserecht abhängig", () => {
  assert.match(script, /const permissionDependencyRules/);
  assert.match(script, /permissionId: "schedule:write"/);
  assert.match(script, /requiredPermissionId: "schedule:read"/);
  assert.match(script, /permissionId: "amu:local:manage"/);
  assert.match(script, /requiredPermissionId: "sickness:read"/);
  assert.match(script, /function enforceRightsEditorPermissionDependencies/);
  assert.match(script, /Dienstpläne bearbeiten wurde ebenfalls entzogen/);
  assert.match(script, /Dienstpläne lesen wurde automatisch ergänzt/);
});

test("Verantwortungsbereich hat sicheren Abteilungsstandard und Filialoption", () => {
  assert.match(html, /id="rightsEditorScope"/);
  assert.match(html, /name="rightsEditorScopeMode" value="department"/);
  assert.match(html, /Nur eigene Abteilung/);
  assert.match(html, /name="rightsEditorScopeMode" value="location"/);
  assert.match(html, /Gesamte Filiale/);
  assert.match(script, /\["employee", "department_manager"\]\.includes\(user\?\.role\) \? "department" : "location"/);
  assert.match(script, /rightsEditorHasOrganizationalPermissions/);
});

test("Rechteeditor stellt Fokus und Statusmeldungen barrierearm bereit", () => {
  assert.match(html, /id="rightsEditorTitle" tabindex="-1"/);
  assert.match(html, /id="rightsEditorAnnouncement" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /aria-label="Rechteeditor schließen"/);
  assert.match(script, /state\.rightsEditorReturnFocus = document\.activeElement/);
  assert.match(script, /elements\.rightsEditorTitle\?\.focus\(\)/);
  assert.match(script, /if \(returnFocus\?\.isConnected\) returnFocus\.focus\(\)/);
});

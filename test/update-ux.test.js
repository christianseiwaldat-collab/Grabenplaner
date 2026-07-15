const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");

test("Updater-Oberfläche unterscheidet Service-, Sicherheits- und Funktionsupdates", () => {
  const appSource = fs.readFileSync(path.join(projectRoot, "public", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(projectRoot, "public", "styles.css"), "utf8");

  assert.match(appSource, /const updateTypeLabel = status\.updateTypeLabel \|\| "Update"/);
  assert.match(appSource, /status\.updateKind === "security" \? "security" : "available"/);
  assert.match(appSource, /`\$\{updateTypeLabel\} verfügbar`/);
  assert.match(styles, /\.sidebar-update-button\.security/);
});

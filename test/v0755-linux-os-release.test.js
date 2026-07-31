"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function assertSafeOsReleaseContract(relativePath, dieFunction) {
  const source = fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf8");
  const resolvedAssignment = 'os_release_source="$(realpath --canonicalize-existing -- /etc/os-release';
  const resolvedIndex = source.indexOf(resolvedAssignment);
  const sourceIndex = source.indexOf('source "$os_release_source"', resolvedIndex);

  assert.notEqual(resolvedIndex, -1, `${relativePath} muss /etc/os-release kanonisch aufloesen.`);
  assert.notEqual(sourceIndex, -1, `${relativePath} muss den aufgeloesten Betriebssystempfad sourcen.`);

  const validation = source.slice(resolvedIndex, sourceIndex + 'source "$os_release_source"'.length);
  assert.match(validation, new RegExp(
    `case "\\$os_release_source" in\\s*` +
    `/etc/os-release\\|/usr/lib/os-release\\)\\s*;;\\s*` +
    `\\*\\)\\s*${dieFunction}\\b[^;]*;;\\s*esac`,
  ));
  assert.match(validation, /\[\[ -f "\$os_release_source" && ! -L "\$os_release_source" \]\]/);
  assert.match(
    validation,
    /stat --format='%u:%g:%h' -- "\$os_release_source"\)" == "0:0:1"/,
  );
  assert.match(validation, /os_release_mode="\$\(stat --format='%a' -- "\$os_release_source"\)"/);
  assert.match(
    validation,
    /\$\(\(8#\$os_release_mode & 022\)\) -eq 0|\(\(\s*\(8#\$os_release_mode & 022\)\s*==\s*0\s*\)\)/,
  );
  assert.doesNotMatch(validation, /\bsource\s+\/etc\/os-release\b/);

  const caseIndex = validation.indexOf('case "$os_release_source" in');
  const regularFileIndex = validation.indexOf('[[ -f "$os_release_source" && ! -L "$os_release_source" ]]');
  const ownershipIndex = validation.indexOf("stat --format='%u:%g:%h'");
  const modeIndex = validation.indexOf("stat --format='%a'");
  const writableBitsIndex = validation.indexOf("& 022");
  const checks = [caseIndex, regularFileIndex, ownershipIndex, modeIndex, writableBitsIndex, sourceIndex - resolvedIndex];
  assert.ok(checks.every((position) => position >= 0), `${relativePath} hat unvollstaendige os-release-Pruefungen.`);
  assert.ok(caseIndex < regularFileIndex, `${relativePath} muss das kanonische Ziel vor den Dateirechten begrenzen.`);
  assert.ok(
    [ownershipIndex, modeIndex, writableBitsIndex].every(
      (position) => position > regularFileIndex && position < sourceIndex - resolvedIndex,
    ),
    `${relativePath} muss os-release vollstaendig pruefen, bevor die Datei gesourct wird.`,
  );
}

test("v0.75.5 runtime migration accepts only the canonical Ubuntu os-release paths", () => {
  assertSafeOsReleaseContract("server-tools/linux/migrate-grabenplaner-runtime-v2.sh", "gp_die");
  assertSafeOsReleaseContract("server-tools/linux/migrate-grabenplaner-runtime-v3.sh", "gp_die");
  assertSafeOsReleaseContract("server-tools/linux/migrate-grabenplaner-runtime-v4.sh", "gp_die");
});

test("v0.75.5 offsite installer accepts only the canonical Ubuntu os-release paths", () => {
  assertSafeOsReleaseContract("server-tools/linux/offsite/install-grabenplaner-offsite.sh", "offsite_die");
});

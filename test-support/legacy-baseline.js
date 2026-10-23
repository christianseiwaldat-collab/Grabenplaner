"use strict";

// Historical compatibility assertions run against this fixed old source tree.
// This helper is test-only and is excluded from every current server package.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const BASELINE = "b2ba03cdc0b738d44766857de052e090db557807";
const repository = path.resolve(__dirname, "..");
let checkout;
function command(binary, args) {
  const result = spawnSync(binary, args, { cwd: repository, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("LEGACY_TEST_BASELINE_EXTRACTION_FAILED: " + binary);
  return result.stdout;
}
function sourceRoot() {
  if (checkout) return checkout;
  assertTestContext();
  if (command("git", ["rev-parse", "--verify", BASELINE + "^{commit}"]).trim() !== BASELINE) throw new Error("LEGACY_TEST_BASELINE_COMMIT");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gp-historical-baseline-"));
  fs.chmodSync(temporary, 0o700);
  const archive = path.join(temporary, "baseline.tar"), source = path.join(temporary, "source");
  fs.mkdirSync(source, { mode: 0o700 });
  try {
    // A Windows checkout may enable core.autocrlf globally. In particular the
    // immutable password-corpus digest binds LF bytes, so archive extraction
    // must not inherit that unrelated workstation conversion preference.
    command("git", ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar", "--output", archive, BASELINE,
      ".gitattributes", "backup.js", "server.js", "package.json", "pnpm-lock.yaml", "lib", "public", "demo", "services/planning-optimizer",
      "test/cross-location-schedule-view-api.test.js", "test/sales-analytics-production-hardening.test.js",
      "test/v081-work-rule-safety-regressions.test.js", "test/v058-personnel-rights-encryption.test.js",
      "test/portal-foundation.test.js", "test/portal-permission-defaults.test.js",
      "test/v082-immutable-trigger-migration.test.js", "test/v087-block5-loan-photo-migration.test.js",
      "test/v087-block8-cost-center-migration.test.js", "test/v087-block7-settings-appearance.test.js", "test/v072-production-bootstrap.test.js",
      "test/v063-import-payroll.test.js", "test/v071-cost-centers-personnel.test.js", "test/v071-shift-locations.test.js",
      "test-support/portal-session-fixture.js", "test-support/session-touch-race.js",
      "scripts/run-background-backup.js", "scripts/manage-local-backup-archive.js", "server-tools"]);
    command("tar", ["-xf", archive, "-C", source]);
    fs.rmSync(archive);
    checkout = source;
    process.once("exit", () => { try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {} });
    return checkout;
  } catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
}
function assertTestContext() {
  if (!process.env.NODE_TEST_CONTEXT && !process.argv.some(argument => argument.endsWith(".test.js"))) {
    throw new Error("LEGACY_TEST_BASELINE_TEST_CONTEXT_REQUIRED");
  }
}
function legacyPath(relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.startsWith("/")
      || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("LEGACY_TEST_BASELINE_PATH");
  return path.join(sourceRoot(), relative);
}
function legacyRequire(relative) { return require(legacyPath(relative)); }
function linkFrozenDependencies() {
  const crypto = require("node:crypto");
  const lockDigest = file => crypto.createHash("sha256")
    .update(fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n")).digest("hex");
  // This explicitly requested test-only link requires identical complete lock
  // contents. No historical application dependency is guessed or downloaded.
  if (lockDigest(legacyPath("pnpm-lock.yaml")) !== lockDigest(path.join(repository, "pnpm-lock.yaml"))) {
    throw new Error("LEGACY_TEST_FROZEN_DEPENDENCIES_REQUIRED");
  }
  const target = fs.realpathSync(path.join(repository, "node_modules"));
  const entry = legacyPath("node_modules");
  if (!fs.existsSync(entry)) fs.symlinkSync(target, entry, process.platform === "win32" ? "junction" : "dir");
  if (fs.realpathSync(entry) !== target) throw new Error("LEGACY_TEST_DEPENDENCY_LINK_MISMATCH");
  return target;
}
module.exports = { BASELINE, legacyPath, legacyRequire, sourceRoot, linkFrozenDependencies };

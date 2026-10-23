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
    command("git", ["archive", "--format=tar", "--output", archive, BASELINE,
      "backup.js", "package.json", "lib", "public", "services/planning-optimizer",
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
module.exports = { BASELINE, legacyPath, legacyRequire, sourceRoot };

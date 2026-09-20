"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const path = require("node:path"), fs = require("node:fs"), { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const verify = path.join(root, "server-tools/linux/recovery/lib/recovery-verify.js");
const { recoveryFailureDiagnostic } = require(verify);

test("journal diagnostics preserve fixed recovery failures and redact arbitrary exception text", () => {
  for (const value of [{ code: "PG_RECOVERY_STALLED", message: "private-path secret=synthetic" }, new Error("PG_RECOVERY_WORKER_FAILED")]) {
    assert.deepEqual(recoveryFailureDiagnostic(value), { event: "recovery-verification-failed", code: value.code || value.message });
  }
  for (const value of [new Error("PG_CUSTOM_SYNTHETIC_SECRET"), new Error("ENOENT /private/key: synthetic-password"),
    { code: "TOKEN_SYNTHETIC", message: "credential=synthetic" }, null]) {
    assert.deepEqual(recoveryFailureDiagnostic(value), { event: "recovery-verification-failed", code: "RECOVERY_VERIFY_FAILED" });
  }
});

test("CLI argument failures produce one fixed diagnostic without a stack trace", () => {
  const result = spawnSync(process.execPath, [verify, "--unknown-synthetic-secret"], {
    encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), { event: "recovery-verification-failed", code: "RECOVERY_VERIFY_FAILED" });
  const script = fs.readFileSync(path.join(root, "server-tools/linux/offsite/grabenplaner-offsite-restore-test.sh"), "utf8");
  assert.match(script, /--scratch-root "\$operation_root" --output "\$operation_root\/verification\.json" >\/dev\/null \\\r?\n/);
});

"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { FORMAT, validateRequest } = require("../../../lib/persistence/postgresql/lifecycle-control");

// The accepted root operation outlives the HTTP/socket client. A disconnected
// client must not abort a backup after the application has already stopped.
process.stdout.on('error', () => {});

async function main() {
  if (process.platform !== "linux" || process.getuid() !== 0 || process.argv.length !== 2) {
    throw new Error("PG_LIFECYCLE_ROOT_REQUIRED");
  }
  const configuration = require("../../../lib/persistence/postgresql/operations/runtime")
    .loadConfiguration("/etc/grabenplaner/postgresql-operations.json");
  if (configuration.mode !== "productive") throw new Error("PG_LIFECYCLE_PRODUCTIVE_REQUIRED");
  let request;
  try {
    let bytes = 0, body = "";
    const timer = setTimeout(() => process.stdin.destroy(new Error("PG_LIFECYCLE_REQUEST_TIMEOUT")), 5000);
    try {
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > 2048) throw new Error("PG_LIFECYCLE_REQUEST_INVALID");
        body += chunk.toString("utf8");
      }
    } finally { clearTimeout(timer); }
    request = validateRequest(JSON.parse(body));
  } catch { throw new Error("PG_LIFECYCLE_REQUEST_INVALID"); }
  const script = "/opt/grabenplaner/app/server-tools/linux/postgresql/lifecycle-maintenance.sh";
  const stat = fs.lstatSync(script);
  if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o022)
      || fs.realpathSync(script) !== script) throw new Error("PG_LIFECYCLE_SCRIPT_PERMISSIONS");
  const lockPath = '/run/grabenplaner/maintenance.lock', lock = fs.lstatSync(lockPath);
  if (!lock.isFile() || lock.uid !== 0 || lock.gid !== 0 || lock.nlink !== 1
      || (lock.mode & 0o777) !== 0o600 || fs.realpathSync(lockPath) !== lockPath) throw new Error('PG_LIFECYCLE_LOCK_PERMISSIONS');
  const child = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "73",
    "/run/grabenplaner/maintenance.lock", "/usr/bin/bash", script, request.action, request.requestId], {
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let replied = false, pending = "", outputBytes = 0;
  child.stderr.on("data", () => {});
  const reply = value => {
    if (replied) return;
    replied = true;
    process.stdout.write(JSON.stringify({ format: FORMAT, requestId: request.requestId, action: request.action, ...value }) + "\n");
  };
  child.stdout.on("data", chunk => {
    outputBytes += chunk.length;
    if (outputBytes > 4096) { child.kill("SIGTERM"); return; }
    pending += chunk.toString("utf8");
    if (!pending.includes("\n") || replied) return;
    try {
      const value = JSON.parse(pending.split("\n", 1)[0]);
      if (value.accepted !== true || value.requestId !== request.requestId) throw new Error();
      reply({ accepted: true, acceptedAt: value.acceptedAt, backupVerified: false });
    } catch { child.kill("SIGTERM"); }
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => {
      if (!replied) reply({ accepted: false, code: code === 73 ? "PG_LIFECYCLE_MAINTENANCE_BUSY" : "PG_LIFECYCLE_FAILED" });
      code === 0 ? resolve() : reject(new Error("PG_LIFECYCLE_FAILED"));
    });
  });
}

main().catch(error => {
  // The protected status file holds the operation outcome; no credentials or
  // native command output are returned through the application socket.
  process.stderr.write((/^PG_/.test(error.message) ? error.message : "PG_LIFECYCLE_FAILED") + "\n");
  process.exitCode = 1;
});

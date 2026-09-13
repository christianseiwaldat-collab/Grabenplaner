"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { FORMAT, validateRequest } = require("../../../lib/persistence/postgresql/lifecycle-control");
const R = require("../../../lib/persistence/postgresql/operations/runtime");
const status = require("./lifecycle-status");
const APP = "/opt/grabenplaner/app";
const COMMON = `source ${APP}/server-tools/linux/lib/common.sh; `;

async function main() {
  if (process.platform !== "linux" || process.getuid() !== 0 || process.argv.length !== 4) throw new Error("PG_LIFECYCLE_ROOT_REQUIRED");
  const request = validateRequest({ format: FORMAT, action: process.argv[2], requestId: process.argv[3] });
  for (const fd of [3, 9]) if (fs.realpathSync(`/proc/self/fd/${fd}`) !== "/run/grabenplaner/maintenance.lock") throw new Error("PG_LIFECYCLE_LEASE_REQUIRED");
  if (fs.realpathSync('/proc/self/fd/4') !== '/run/grabenplaner/update-backup-owner.json') throw new Error("PG_LIFECYCLE_OWNER_REQUIRED");
  const config = R.loadConfiguration("/etc/grabenplaner/postgresql-operations.json");
  const resultFile = config.workDirectory + "/" + request.requestId + ".lifecycle-backup.json";
  const diagnostic = fs.openSync(config.workDirectory + "/" + request.requestId + ".lifecycle-private.log", "wx", 0o600);
  const env = require("node:util").parseEnv(fs.readFileSync(config.environmentFile, "utf8"));
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PG_LIFECYCLE_PORT");
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
  async function run(binary, args, { output = diagnostic, recovery = false } = {}) {
    if (interrupted && !recovery) throw new Error("PG_LIFECYCLE_INTERRUPTED");
    await new Promise((resolve, reject) => {
      const child = spawn(binary, args, { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
        stdio: ["ignore", output, diagnostic, 3, 4, "ignore", "ignore", "ignore", "ignore", 9] });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error("PG_LIFECYCLE_NATIVE_FAILED")));
    });
  }
  const shell = (command, options) => run('/usr/bin/bash', ['-Eeuo', 'pipefail', '-c', COMMON + command], options);
  const verifyReady = async () => {
    const deadline = Date.now() + 180000;
    do {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`, { signal: AbortSignal.timeout(5000) });
        if (response.status === 200) { const value = await response.json(); if (value.ready === true || value.ok === true || value.status === 'ok') return; }
      } catch { /* startup may still be completing */ }
      await delay(1000);
    } while (Date.now() < deadline);
    throw new Error('PG_LIFECYCLE_READINESS');
  };
  try {
    await require('../../../lib/persistence/postgresql/operations/lifecycle').performLifecycle(request, {
      async preflight() {
        await run('/usr/bin/flock', ['--nonblock', '9']);
        await run('/usr/bin/systemctl', ['is-active', '--quiet', 'grabenplaner.service']);
        if (fs.existsSync(resultFile)) throw new Error('PG_LIFECYCLE_REQUEST_REPLAY');
        const state = require('../../../lib/persistence/postgresql/operations/status').readStatus(config.binding);
        if (state.acceptedAt && Date.now() - Date.parse(state.acceptedAt) < 300000) throw new Error('PG_LIFECYCLE_COOLDOWN');
        if (request.action === 'vps-reboot') require('./host-reboot').preflight();
      },
      async recordAccepted() { await status.publish(request.requestId, request.action, 'preparing', resultFile); },
      async acknowledge() {
        process.stdout.write(JSON.stringify({ accepted: true, requestId: request.requestId, acceptedAt: new Date().toISOString() }) + '\n');
        await delay(1000);
      },
      stopApplication: () => shell('gp_stop_service grabenplaner.service 150'),
      async createBackup() {
        const output = fs.openSync(resultFile, 'wx', 0o600);
        try {
          await run('/usr/bin/bash', [APP + '/server-tools/linux/backup-grabenplaner.sh',
            '--env-file', config.environmentFile, '--app-dir', APP, '--data-dir', config.sourceFiles,
            '--backup-dir', config.backupDirectory, '--service', 'grabenplaner.service', '--node', '/usr/bin/node',
            '--service-user', 'grabenplaner', '--service-group', 'grabenplaner', '--lock-already-held'], { output });
          fs.fsyncSync(output);
        } finally { fs.closeSync(output); }
        return resultFile;
      },
      verifyBackup: () => status.verifyResult(resultFile, request.requestId),
      async releaseLease() { await run('/usr/bin/flock', ['--unlock', '4']); await run('/usr/bin/flock', ['--unlock', '9']); },
      requestHostReboot: () => run('/usr/bin/node', [APP + '/server-tools/linux/postgresql/host-reboot.js', 'request', request.requestId, resultFile]),
      startApplication: () => run('/usr/bin/systemctl', ['start', 'grabenplaner.service'], { recovery: true }),
      verifyReadiness: verifyReady,
      complete: () => status.publish(request.requestId, request.action, 'completed', resultFile),
      recordFailure: () => status.publish(request.requestId, request.action, 'failed', resultFile),
    });
  } finally { process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal); fs.closeSync(diagnostic); }
}

if (require.main === module) main().catch(() => { process.stderr.write('PG_LIFECYCLE_FAILED\n'); process.exitCode = 1; });

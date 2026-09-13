"use strict";

const broker = require("../host-control/lib/host-reboot-broker");
const { validateRequest, FORMAT } = require("../../../lib/persistence/postgresql/lifecycle-control");

function preflight(now = Date.now()) {
  if (!broker.assertRebootRequired()) throw new Error("PG_HOST_REBOOT_NOT_REQUIRED");
  broker.assertHostSecurityAllowsReboot(now);
  if (broker.rebootUnitBusy()) throw new Error("PG_HOST_REBOOT_BUSY");
  const previous = broker.readRateLimitState();
  if (previous && (now - Date.parse(previous.lastAcceptedAt)) / 1000 < broker.RATE_LIMIT_SECONDS) {
    throw new Error("PG_HOST_REBOOT_COOLDOWN");
  }
}

async function main() {
  const [action, requestId, resultFile] = process.argv.slice(2);
  if (process.platform !== "linux" || process.getuid() !== 0 || !['preflight', 'request'].includes(action)
      || process.argv.length !== (action === 'preflight' ? 4 : 5)) throw new Error("PG_HOST_REBOOT_ARGUMENTS");
  validateRequest({ format: FORMAT, action: "vps-reboot", requestId });
  preflight();
  if (action === 'preflight') return;
  await require("./lifecycle-status").verifyResult(resultFile, requestId, { completeContent: true });
  if (broker.maintenanceLockBusy()) throw new Error("PG_HOST_REBOOT_MAINTENANCE_BUSY");
  // Recheck the host immediately before reserving its existing root-owned cooldown.
  preflight();
  const acceptedAt = new Date().toISOString();
  broker.writeRateLimitState(broker.STATE_PATH, {
    format: broker.STATE_FORMAT, schemaVersion: broker.STATE_SCHEMA_VERSION,
    lastAcceptedAt: acceptedAt, lastRequestId: requestId,
  });
  broker.startRebootUnit(requestId, acceptedAt);
}

if (require.main === module) main().catch(() => { process.stderr.write("PG_HOST_REBOOT_FAILED\n"); process.exitCode = 1; });
module.exports = { preflight };

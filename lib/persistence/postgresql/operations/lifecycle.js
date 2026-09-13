"use strict";

const { validateRequest } = require("../lifecycle-control");

async function performLifecycle(request, operations) {
  validateRequest(request);
  let stopped = false;
  try {
    await operations.preflight();
    await operations.recordAccepted();
    await operations.acknowledge();
    stopped = true;
    await operations.stopApplication();
    const backup = await operations.createBackup();
    await operations.verifyBackup(backup);
    if (request.action === "vps-reboot") {
      await operations.releaseLease();
      await operations.requestHostReboot(backup);
    } else if (request.action !== "shutdown") {
      await operations.startApplication();
      await operations.verifyReadiness();
    }
    await operations.complete(backup);
    return { completed: true, backupVerified: true };
  } catch (error) {
    let recoveryError;
    if (stopped) {
      try { await operations.startApplication(); await operations.verifyReadiness(); }
      catch (failure) { recoveryError = failure; }
    }
    await operations.recordFailure({ error, recoveryError });
    throw error;
  }
}

module.exports = { performLifecycle };

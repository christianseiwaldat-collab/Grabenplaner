"use strict";

// The same sequence drives the root command and the failure qualification. The
// caller holds the maintenance lease throughout and implements fixed host paths.
async function performCutover(operations) {
  let stopped = false;
  let published = false;
  try {
    await operations.preflight();
    stopped = true;
    await operations.stopApplication();
    await operations.captureReturnPoint();
    await operations.transferAndVerify();
    await operations.promotePair();
    await operations.installConfiguration();
    await operations.createFirstPairedBackup();
    // This durable boundary precedes the first application start. Once reached,
    // PostgreSQL is authoritative, even if the readiness check subsequently fails.
    published = true;
    await operations.publishAuthority();
    await operations.startApplication();
    await operations.verifyApplication();
    await operations.complete();
    return { completed: true, authoritativeProvider: "postgresql" };
  } catch (error) {
    let recoveryError;
    if (stopped && !published) {
      try {
        await operations.restoreSqliteConfiguration();
        await operations.startApplication();
        await operations.verifySqliteReadiness();
      } catch (failure) { recoveryError = failure; }
    }
    await operations.recordFailure({ authoritativeProvider: published ? "postgresql" : "sqlite",
      recoveryRequired: published || Boolean(recoveryError), error, recoveryError });
    throw error;
  }
}

module.exports = { performCutover };

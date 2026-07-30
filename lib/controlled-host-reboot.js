"use strict";

const path = require("node:path");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BACKUP_MARKER_PATTERN = /^dienstplan-[0-9A-Za-z._-]+\.complete\.json$/;

class ControlledHostRebootError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ControlledHostRebootError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ControlledHostRebootError(code, message);
}

function verifiedBackupMarkerFileName(backup) {
  const marker = backup?.appBackup?.marker;
  if (backup?.appBackup?.verified !== true
    || backup.appBackup.committed !== true
    || typeof marker !== "string"
    || !path.isAbsolute(marker)) {
    fail(
      "HOST_REBOOT_BACKUP_FAILED",
      "Der verifizierte Sicherungsbeleg fuer den VPS-Neustart fehlt.",
    );
  }
  const markerFileName = path.basename(marker);
  if (!BACKUP_MARKER_PATTERN.test(markerFileName)) {
    fail(
      "HOST_REBOOT_BACKUP_FAILED",
      "Der Sicherungsbeleg fuer den VPS-Neustart besitzt keinen freigegebenen Namen.",
    );
  }
  return markerFileName;
}

async function prepareControlledHostReboot({
  requestId,
  createBackup,
  recordRequest,
  requestControl,
} = {}) {
  if (!UUID_PATTERN.test(String(requestId || ""))
    || typeof createBackup !== "function"
    || typeof recordRequest !== "function"
    || typeof requestControl !== "function") {
    fail("HOST_REBOOT_PREPARATION_INVALID", "Der kontrollierte VPS-Neustart ist unvollstaendig.");
  }
  let backup;
  try {
    backup = await createBackup();
  } catch {
    fail(
      "HOST_REBOOT_BACKUP_FAILED",
      "Der verifizierte Sicherungspunkt konnte nicht erstellt werden.",
    );
  }
  const backupMarkerFileName = verifiedBackupMarkerFileName(backup);
  await recordRequest({ requestId, backupMarkerFileName });
  return requestControl({ requestId, backupMarkerFileName });
}

module.exports = {
  BACKUP_MARKER_PATTERN,
  ControlledHostRebootError,
  prepareControlledHostReboot,
  verifiedBackupMarkerFileName,
};

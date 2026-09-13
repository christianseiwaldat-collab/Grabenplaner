'use strict';
const fs = require('node:fs');
const ROOT = '/etc/grabenplaner';

function inspect() {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('PG_CONFIGURATION_ROOT_REQUIRED');
  const stat = fs.lstatSync(ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(ROOT) !== ROOT || stat.uid !== 0) throw new Error('PG_CONFIGURATION_DIRECTORY');
  return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
}

function grantApplicationRead(gid) {
  const previous = inspect();
  if (!Number.isSafeInteger(gid) || gid < 1 || previous.gid !== 0 || previous.mode !== 0o700) throw new Error('PG_CONFIGURATION_PREDECESSOR');
  // Files remain root-owned. Only the four-account application document has
  // group read permission; environment, operations and offsite secrets do not.
  fs.chownSync(ROOT, 0, gid);
  fs.chmodSync(ROOT, 0o750);
  return previous;
}

function restoreRootOnly(previous, gid) {
  const current = inspect();
  if (previous?.uid !== 0 || previous.gid !== 0 || previous.mode !== 0o700
      || ![0, gid].includes(current.gid) || ![0o700, 0o750].includes(current.mode)) throw new Error('PG_CONFIGURATION_ROLLBACK');
  fs.chmodSync(ROOT, previous.mode);
  fs.chownSync(ROOT, previous.uid, previous.gid);
}

module.exports = { inspect, grantApplicationRead, restoreRootOnly };

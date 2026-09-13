"use strict";

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const FILE = '/var/lib/grabenplaner-postgresql/installed.json';
const FORMAT = 'grabenplaner-postgresql-installed-v1';
const templates = Object.freeze({
  'grabenplaner-postgresql.service.in': '/etc/systemd/system/grabenplaner-postgresql.service',
  'grabenplaner-postgresql-control.socket.in': '/etc/systemd/system/grabenplaner-postgresql-control.socket',
  'grabenplaner-postgresql-control@.service.in': '/etc/systemd/system/grabenplaner-postgresql-control@.service',
  'grabenplaner-application.conf.in': '/etc/systemd/system/grabenplaner.service.d/40-postgresql.conf',
  'grabenplaner-postgresql-maintenance-recover.service.in': '/etc/systemd/system/grabenplaner-postgresql-maintenance-recover.service',
});
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function expected(applicationRoot) {
  if (!path.isAbsolute(applicationRoot) || fs.realpathSync(applicationRoot) !== applicationRoot) throw new Error('PG_MANAGED_APPLICATION_PATH');
  return Object.entries(templates).map(([source, target]) => {
    const file = applicationRoot + '/server-tools/linux/postgresql/' + source;
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.nlink !== 1 || fs.realpathSync(file) !== file) throw new Error('PG_MANAGED_TEMPLATE');
    return { source, target, sha256: hash(file) };
  });
}
function verifyInstalled(applicationRoot) {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('PG_MANAGED_ROOT');
  const stat = fs.lstatSync(FILE);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o077)
      || stat.size > 16384 || fs.realpathSync(FILE) !== FILE) throw new Error('PG_MANAGED_RECEIPT');
  const value = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const units = expected(applicationRoot);
  if (value.format !== FORMAT || JSON.stringify(value.units) !== JSON.stringify(units)) throw new Error('PG_MANAGED_MIGRATION_REQUIRED');
  for (const unit of units) {
    const info = fs.lstatSync(unit.target);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o022)
        || fs.realpathSync(unit.target) !== unit.target || hash(unit.target) !== unit.sha256) throw new Error('PG_MANAGED_UNIT_DRIFT');
  }
  return { verified: true, units: units.length };
}
if (require.main === module) {
  try { if (process.argv.length !== 3) throw new Error(); process.stdout.write(JSON.stringify(verifyInstalled(process.argv[2])) + '\n'); }
  catch { process.stderr.write('PG_MANAGED_CONTRACT_FAILED\n'); process.exitCode = 1; }
}
module.exports = { FILE, FORMAT, templates, expected, verifyInstalled };

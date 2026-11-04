'use strict';
const fs = require('node:fs'), path = require('node:path');
const { safeRoot, verifyPairBundle, digest: fileDigest } = require('./paired-bundle');
const { digest } = require('../../../vps-storage-contract');
const NAME = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pair$/;
const identity = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
function privateEntry(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || fs.realpathSync(file) !== file || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
      || process.platform !== 'win32' && (stat.uid !== 0 || stat.mode & 0o077)) throw new Error('VPS_STORAGE_ENTRY_UNSAFE');
  return stat;
}
function candidate(root, name, { now, ageDays }) {
  if (!NAME.test(name)) return null;
  const directory = path.join(root, name);
  const stat = privateEntry(directory, true);
  if (fs.existsSync(directory + '.complete.json') || fs.existsSync(directory + '.pending.complete.json')) return null;
  const names=fs.readdirSync(directory).sort();
  if(!names.length || !names.every(name=>['core.dump','sales.dump'].includes(name))) return null;
  const files = names.map(file => {
    const target=path.join(directory,file),entry=privateEntry(target),fd=fs.openSync(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    try{const header=Buffer.alloc(5);if(fs.readSync(fd,header,0,5,0)!==5||header.toString()!=='PGDMP')throw new Error('VPS_STORAGE_DUMP_FORMAT_INVALID');}
    finally{fs.closeSync(fd);}
    return {file,...identity(entry)};
  });
  const modified = Math.max(stat.mtimeMs, ...files.map(file => file.mtimeMs));
  if (modified > now - ageDays * 86400000) return null;
  return { name, directory: identity(stat), files, bytes: files.reduce((sum, file) => sum + file.size, 0), modifiedAt: new Date(modified).toISOString() };
}
async function inspectResiduals(root, { ageDays = 7, now = Date.now(), verifyContent = false } = {}) {
  safeRoot(root);
  const candidates = [], complete = [], unknown = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (!NAME.test(name)) continue;
    const directory = path.join(root, name);
    try {
      privateEntry(directory, true);
      if (fs.existsSync(directory + '.complete.json')) {
        const proof = await verifyPairBundle(directory, directory + '.complete.json', { verifyContent });
        if (!Number.isFinite(Date.parse(proof.manifest.createdAt)) || Date.parse(proof.manifest.createdAt) > now + 300000) throw new Error('VPS_STORAGE_BACKUP_DATE_INVALID');
        complete.push({ name, createdAt: proof.manifest.createdAt, bytes: proof.bytes,
          manifestSha256: proof.manifestSha256, verificationScope: proof.verificationScope, manifest: proof.manifest });
      } else {
        const found = candidate(root, name, { now, ageDays });
        if (found) candidates.push(found); else unknown.push(name);
      }
    } catch { unknown.push(name); }
  }
  complete.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
  return { candidates, complete, unknown, planSha256: digest(candidates) };
}
function assertNoOpenResiduals(root, candidates, procRoot = '/proc') {
  const targets = candidates.map(item => path.join(root, item.name));
  for (const pid of fs.readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
    let names; try { names = fs.readdirSync(path.join(procRoot, pid, 'fd')); } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw new Error('VPS_STORAGE_PROCESS_CHECK_UNAVAILABLE');
    }
    for (const fd of names) {
      let target; try { target = fs.readlinkSync(path.join(procRoot, pid, 'fd', fd)); } catch (error) {
        if (['ENOENT', 'ESRCH', 'EINVAL'].includes(error.code)) continue; throw new Error('VPS_STORAGE_PROCESS_CHECK_UNAVAILABLE');
      }
      if (targets.some(item => target === item || target.startsWith(item + '/'))) throw new Error('VPS_STORAGE_RESIDUAL_IN_USE');
    }
  }
}
async function removeResiduals(root, expected, { ageDays = 7, now = Date.now(), assertUnused = assertNoOpenResiduals, record = () => {}, validateBackup = () => {} } = {}) {
  const audit = await inspectResiduals(root, { ageDays, now });
  if (audit.planSha256 !== expected) throw new Error('VPS_STORAGE_PLAN_CHANGED');
  if (!audit.candidates.length) throw new Error('VPS_STORAGE_NO_RESIDUALS');
  if (audit.complete.length < 2) throw new Error('VPS_STORAGE_TWO_BACKUPS_REQUIRED');
  // Verify two complete recovery points, including every byte, before removing anything.
  for (const point of audit.complete.slice(0, 2)) await validateBackup(await verifyPairBundle(path.join(root, point.name), path.join(root, point.name) + '.complete.json', { expectedSha256: point.manifestSha256 }));
  assertUnused(root, audit.candidates);
  const proof = [];
  for (const item of audit.candidates) {
    const current = candidate(root, item.name, { ageDays, now });
    if (digest(current) !== digest(item)) throw new Error('VPS_STORAGE_PLAN_CHANGED');
    const files = [];
    for (const entry of item.files) files.push({ file: entry.file, ...await fileDigest(path.join(root, item.name, entry.file)) });
    proof.push({ name: item.name, files, bytes: item.bytes });
  }
  await record({ phase: 'verified-before-removal', planSha256: expected, retained: audit.complete.slice(0, 2).map(p => ({ name: p.name, manifestSha256: p.manifestSha256 })), files: proof });
  // Recheck the entire immutable plan after hashing. Never recurse into unknown content.
  for (const item of audit.candidates) if (digest(candidate(root, item.name, { ageDays, now })) !== digest(item)) throw new Error('VPS_STORAGE_PLAN_CHANGED');
  assertUnused(root, audit.candidates);
  for (const item of audit.candidates) {
    const directory = path.join(root, item.name);
    if (path.dirname(directory) !== root || fs.realpathSync(directory) !== directory) throw new Error('VPS_STORAGE_ENTRY_UNSAFE');
    for (const entry of item.files) fs.unlinkSync(path.join(directory, entry.file));
    fs.rmdirSync(directory);
  }
  return { removed: proof.map(item => item.name), removedBytes: proof.reduce((sum, item) => sum + item.bytes, 0) };
}
module.exports = { identity, privateEntry, candidate, inspectResiduals, assertNoOpenResiduals, removeResiduals };

'use strict';
// Read-only advisory lookup: only public package names and locked versions leave the host.
// No npmrc, credentials, source contents, dependency installation, or fixes are used.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
async function main() {
  const root = path.resolve(__dirname, '../..');
  const output = path.resolve(process.argv[2]);
  const lock = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  const section = lock.split(/^packages:\s*$/m)[1]?.split(/^snapshots:\s*$/m)[0];
  if (!section) throw new Error('Expected pnpm v9 packages section');
  const packages = {}, skipped = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^  (\S.*):\s*$/.exec(line);
    if (!match) continue;
    const raw = match[1].replace(/^['"]|['"]$/g, '');
    const split = raw.lastIndexOf('@');
    const name = raw.slice(0, split), version = raw.slice(split + 1);
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i.test(version)) { skipped.push(raw); continue; }
    (packages[name] ||= []).push(version);
  }
  if (skipped.length) throw new Error('Unparsed package keys; refusing incomplete scan');
  const startedAt = new Date().toISOString();
  const endpoint = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
  const record = { format:'gp-ops-lockfile-advisories-v1', startedAt, endpoint, node:process.version,
    lockSha256:crypto.createHash('sha256').update(lock).digest('hex'), packageNames:Object.keys(packages).length,
    packageVersions:Object.values(packages).reduce((sum, versions) => sum + versions.length, 0),
    limitations:['Includes all lockfile platform packages, not only installed or reachable dependencies.',
      'Registry database snapshot date is not exposed; lookup time is recorded.',
      'A package advisory is not proof of exploitable application reachability.',
      'Local patches require separate applicability review; registry only sees upstream names and versions.'] };
  try {
    const response = await fetch(endpoint, { method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify(packages), signal:AbortSignal.timeout(30000), redirect:'error' });
    record.httpStatus = response.status;
    if (!response.ok) throw new Error('Registry advisory lookup HTTP ' + response.status);
    record.advisories = await response.json();
    record.status = 'completed';
    record.advisoryCount = Object.values(record.advisories).reduce((sum, list) => sum + list.length, 0);
  } catch (error) { record.status = 'blocked'; record.error = {name:error.name,message:error.message}; process.exitCode = 2; }
  record.completedAt = new Date().toISOString();
  fs.writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({status:record.status,packageNames:record.packageNames,packageVersions:record.packageVersions,advisoryCount:record.advisoryCount,httpStatus:record.httpStatus,output}));
}
main().catch(error => { console.error(error.message); process.exitCode = 2; });

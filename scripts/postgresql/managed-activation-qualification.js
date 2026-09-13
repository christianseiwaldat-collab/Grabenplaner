"use strict";

const fs = require('node:fs');
const ROOT = '/run/gp-postgresql-activation-qualification';
async function main() {
  if (process.platform !== 'linux' || require('node:os').userInfo().username !== 'grabenplaner'
      || fs.readFileSync(ROOT + '/ownership-marker', 'utf8').trim() !== 'grabenplaner-managed-activation-qualification-v1'
      || Object.values(require('node:os').networkInterfaces()).flat().some(address => !address.internal)) throw new Error('PG_MANAGED_QUALIFICATION_SCOPE');
  const config = JSON.parse(fs.readFileSync(ROOT + '/fixture-operations.json', 'utf8'));
  const proof = await require('../../server-tools/linux/recovery/lib/postgresql-application-smoke').qualifyHttp({
    root: ROOT, config, connectionPort: 55486, managed: true,
  });
  fs.writeFileSync(ROOT + '/proof.json', JSON.stringify({ ...proof, managedRuntime: true, isolated: true,
    productiveAccount: 'grabenplaner', productActivation: false, checkedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
main().catch(error => {
  fs.writeFileSync(ROOT + '/failure-private.json', JSON.stringify({ message: error.message, stack: error.stack }) + '\n', { mode: 0o600 });
  process.stderr.write('PG_MANAGED_QUALIFICATION_FAILED\n'); process.exitCode = 1;
});

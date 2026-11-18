'use strict';

// Explicit opt-in classification for the reduced deploy recovery path. The
// automatic chooser stays in deploy-policy.js. This classifier only chooses a
// backup scope; the drained backup still has to prove source/cash reconstruction.
const path = require('node:path'), crypto = require('node:crypto');
const legacy = require('./deploy-policy');
const HASH = /^[a-f0-9]{64}$/;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const OWNED_POLICY_ID = 'existing-gp-business-protected-sales-recovery-v1';
const BUSINESS_FILES = Object.freeze([
  'server.js',
  ...[
    'absence-request-policy', 'branch-time-off', 'employee-preferences', 'leave-governance',
    'payroll-export', 'payroll-handoffs', 'personnel-apprenticeship', 'personnel-retail-kv',
    'personnel-learning-assessment', 'personnel-learning-assignments', 'personnel-learning-catalog',
    'personnel-learning-competencies', 'personnel-learning-confirmation', 'personnel-learning-evidence',
    'personnel-learning-knowledge', 'personnel-learning-progress', 'personnel-learning-receipts',
    'personnel-learning-schedules', 'personnel-learning-skills', 'personnel-learning-targets', 'personnel-learning-team',
    'planning-assistant-gp', 'planning-assistant-preferences', 'planning-assistant-settings', 'planning-assistant',
    'planning-derived-refresh', 'planning-optimizer-revision', 'planning-optimizer-service', 'planning-optimizer',
    'planning-qualifications', 'planning-saturday-credit', 'planning-shift-precondition',
    'schedule-employment', 'schedule-history-coverage', 'schedule-matrix-layout', 'schedule-note-rich-text',
    'schedule-pdf-day-status', 'schedule-pdf-designs', 'schedule-print-selection',
  ].map(name => 'lib/' + name + '.js'),
].sort());
const PROTECTED_PREFIXES = Object.freeze(['lib/persistence/', 'server-tools/', 'scripts/', 'migrations/', 'schemas/', 'contracts/']);
const PROTECTED_COMPONENT = /(?:^|[/.\-_])(?:sales|import|cash|trade|schema|schemas|contract|contracts|migration|migrations|backup|recovery|restore|deploy)(?:[/.\-_]|$)/i;
const PROTECTED_POLICY = Object.freeze({ id: OWNED_POLICY_ID, version: 1, businessFiles: BUSINESS_FILES,
  existingPublicPrefix: 'public/', protectedPrefixes: PROTECTED_PREFIXES, protectedComponent: PROTECTED_COMPONENT.source,
  packageMetadata: 'all-properties-except-version', unknownPaths: 'protected', pathInventory: 'must-match-exactly' });
const PROTECTED_POLICY_SHA256 = digest(PROTECTED_POLICY);
const businessFiles = new Set(BUSINESS_FILES);

function allowedBusinessPath(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.startsWith('/')
    || relative.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f\x7f:]/.test(relative)) return false;
  // Schema, backup and recovery artifacts remain protected even if a future
  // developer accidentally adds an overlapping name to the business list.
  if (PROTECTED_PREFIXES.some(prefix => relative.startsWith(prefix)) || PROTECTED_COMPONENT.test(relative)) return false;
  return relative.startsWith('public/') || businessFiles.has(relative);
}

function ownedApplicationContract(root) {
  // Reuse the installed verifier: a package declaration never substitutes for
  // the exact on-disk bytes, inventory, nonlinked files and complete manifest.
  const contract = legacy.applicationContract(root);
  const manifestBytes = legacy.readRegular(path.join(root, 'grabenplaner-server-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  if (crypto.createHash('sha256').update(manifestBytes).digest('hex') !== contract.manifestSha256) throw new Error('DEPLOY_CONTRACT_CHANGED');
  const metadataBytes = legacy.readRegular(path.join(root, 'package.json'));
  const metadata = JSON.parse(metadataBytes), { version, ...runtime } = metadata;
  if (version !== contract.appVersion || crypto.createHash('sha256').update(metadataBytes).digest('hex') !== manifest.files.find(f => f.path === 'package.json')?.sha256) throw new Error('DEPLOY_CONTRACT_CHANGED');
  const protectedFiles = manifest.files.filter(entry => entry.path !== 'package.json' && !allowedBusinessPath(entry.path))
    .map(entry => [entry.path, entry.sha256]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { ...contract, protectedPolicySha256: PROTECTED_POLICY_SHA256,
    protectedFilesSha256: digest({ policy: PROTECTED_POLICY_SHA256, inventoryPathsSha256: contract.inventoryPathsSha256, protectedFiles, runtime }) };
}

function evaluateOwnedDeploy(options) {
  const { installed, candidate } = options || {}, full = reason => ({ mode: 'full', reason });
  if (!installed || !candidate || installed.protectedPolicySha256 !== PROTECTED_POLICY_SHA256 || candidate.protectedPolicySha256 !== PROTECTED_POLICY_SHA256
    || !HASH.test(installed.protectedFilesSha256 || '') || !HASH.test(candidate.protectedFilesSha256 || '')) return full('OWNED_CLASSIFICATION_UNAVAILABLE');
  if (installed.inventoryPathsSha256 !== candidate.inventoryPathsSha256) return full('OWNED_INVENTORY_CHANGED');
  if (installed.protectedFilesSha256 !== candidate.protectedFilesSha256) return full('OWNED_PROTECTED_CONTRACT_CHANGED');
  if (!HASH.test(installed.fingerprint || '') || !HASH.test(candidate.fingerprint || '')) return full('OWNED_CLASSIFICATION_UNAVAILABLE');
  // Only this checked difference is relaxed. The installed full fingerprint
  // must still equal the signed full proof. A second business update before a
  // new full qualification therefore falls back to full, conservatively.
  const decision = legacy.evaluateDeploy({ ...options, candidate: { ...candidate, fingerprint: installed.fingerprint } });
  if (decision.mode !== 'short') return decision;
  return { ...decision, mode: 'owned', reason: 'RECENT_FULL_RECOVERY_AND_PROTECTED_CONTRACT_UNCHANGED',
    classification: OWNED_POLICY_ID, protectedPolicySha256: PROTECTED_POLICY_SHA256, protectedFilesSha256: installed.protectedFilesSha256 };
}

async function main(args=process.argv.slice(2)) {
 if(process.platform!=='linux'||process.getuid?.()!==0)throw new Error('DEPLOY_ROOT_REQUIRED');
 const [action,appRoot,candidateRoot,databasePath,envFile,timerActive,...extra]=args;
 if(action!=='decide'||extra.length||[appRoot,candidateRoot,databasePath,envFile,timerActive].some(value=>typeof value!=='string'||!value))throw new Error('DEPLOY_ARGUMENTS_INVALID');
 try {
  const checked=await require('./core-deploy-proof').readProof(appRoot,candidateRoot,envFile);
  return {mode:'owned',reason:'CORE_PLUS_RESTORE_VERIFIED',classification:'qualified-core-plus',
   installedManifestSha256:checked.installedManifestSha256,candidateManifestSha256:checked.candidateManifestSha256,
   coreBackup:checked.backup,ownedRecovery:checked.ownedRecovery};
 } catch { /* An absent or mismatched Core proof still needs the legacy qualification below. */ }
 try {
  const schedule=/^1:([0-9]{13})$/.exec(timerActive);
  let queueSchedule;
  try{queueSchedule=require('../../../lib/pending-recovery').readPendingRecoveryDocument();}
  catch(error){if(error.code!=='ENOENT')throw error;}
  return evaluateOwnedDeploy({installed:ownedApplicationContract(appRoot),candidate:ownedApplicationContract(candidateRoot),
   proof:JSON.parse(legacy.readRegular('/var/lib/grabenplaner-assurance/deploy-verification.json',16384,{rootOnly:true})),
   history:legacy.inspectedHistory(),identity:await legacy.configuredDatabaseIdentity(databasePath,envFile),
   configurationSha256:legacy.configurationIdentity(envFile),timerActive:Boolean(schedule),scheduledForMs:schedule?Number(schedule[1]):undefined,queueSchedule});
 }catch{return {mode:'full',reason:'OWNED_VERIFICATION_UNAVAILABLE'};}
}
if(require.main===module)main().then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(()=>{
 process.stderr.write('Die kleinere Deploy-Pruefgrundlage konnte nicht bestaetigt werden.\n');process.exitCode=1;
});
module.exports = { ownedApplicationContract, evaluateOwnedDeploy, allowedBusinessPath, OWNED_POLICY_ID, PROTECTED_POLICY_SHA256, main };

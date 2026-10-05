'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {verifyBackupBudgetCompatibility}=require('../server-tools/linux/lib/postgresql-backup-budget-compat');
const contract=require('../server-tools/linux/lib/postgresql-backup-budget-contract.json');
const {sealPairBundle}=require('../lib/persistence/postgresql/operations/paired-bundle');
const source=path.resolve(__dirname,'..');
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gp-budget-bridge-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const installed=path.join(root,'installed'),candidate=path.join(root,'candidate');
 for(const [target,old] of [[installed,true],[candidate,false]]){
  fs.mkdirSync(target);const metadata=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));if(old)metadata.version=contract.predecessorVersion;
  fs.writeFileSync(path.join(target,'package.json'),JSON.stringify(metadata));
  for(const [file,pins] of Object.entries(contract.files)){
   if((old?pins.before:pins.after)===null)continue;
   const from=old&&pins.before!==pins.after?path.join(source,'test-support/postgresql-backup-budget-before',file.replaceAll('/','__')+'.txt'):path.join(source,file);
   const to=path.join(target,file);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);
  }
 }
 return {root,installed,candidate};
}
test('first-deploy bridge accepts only the pinned installed 0.92.75 and complete reviewed candidate backup tree',t=>{
 const f=fixture(t),result=verifyBackupBudgetCompatibility(f.installed,f.candidate);
 assert.equal(result.verified,true);assert.equal(result.predecessorCommit,'503106fa24da31b8194f96b98b4f05fcab269a5a');
 assert.equal(result.freshBackupRequired,true);assert.equal(result.candidateBackupTree,true);
 assert.equal(fs.existsSync(path.join(f.installed,'lib/persistence/postgresql/operations/backup-budget.js')),false);
 for(const scenario of ['runtime','snapshot','bundle','checkpoint','schema','lease','database-lock','shell','retention','managed-runtime','transitive-catalog']){
  const file={runtime:'lib/persistence/postgresql/operations/runtime.js',snapshot:'lib/persistence/postgresql/operations/paired-backup.js',bundle:'lib/persistence/postgresql/operations/paired-bundle.js',
   checkpoint:'lib/persistence/postgresql/operations/paired-checkpoint.js',schema:'lib/persistence/postgresql/core/schema.js',lease:'lib/backup-maintenance.js','database-lock':'lib/database-lock.js',shell:'server-tools/linux/backup-grabenplaner.sh',
   retention:'lib/persistence/postgresql/operations/paired-retention.js','managed-runtime':'server-tools/linux/postgresql/grabenplaner-postgresql-control@.service.in','transitive-catalog':'lib/persistence/sqlite/application-catalog.js'}[scenario];
  for(const tree of [f.installed,f.candidate]){const target=path.join(tree,file),old=fs.readFileSync(target);fs.appendFileSync(target,'\n// unreviewed');
   assert.throws(()=>verifyBackupBudgetCompatibility(f.installed,f.candidate),/PG_BACKUP_BUDGET_BRIDGE_UNREVIEWED/,scenario);fs.writeFileSync(target,old);}
 }
});
test('bridge rejects other versions, changed dependencies, missing modules and mixed source trees',t=>{
 const f=fixture(t),installedPackage=path.join(f.installed,'package.json'),original=fs.readFileSync(installedPackage);
 const p=JSON.parse(original);p.version='0.92.74-beta';fs.writeFileSync(installedPackage,JSON.stringify(p));assert.throws(()=>verifyBackupBudgetCompatibility(f.installed,f.candidate),/PREDECESSOR/);fs.writeFileSync(installedPackage,original);
 const nextFile=path.join(f.candidate,'package.json'),nextOriginal=fs.readFileSync(nextFile),next=JSON.parse(nextOriginal);next.dependencies.pg='0.0.0';fs.writeFileSync(nextFile,JSON.stringify(next));assert.throws(()=>verifyBackupBudgetCompatibility(f.installed,f.candidate),/DEPENDENCIES/);fs.writeFileSync(nextFile,nextOriginal);
 const module='lib/persistence/postgresql/operations/paired-backup.js',target=path.join(f.candidate,module),nextBytes=fs.readFileSync(target);
 fs.copyFileSync(path.join(f.installed,module),target);assert.throws(()=>verifyBackupBudgetCompatibility(f.installed,f.candidate),/UNREVIEWED/);fs.writeFileSync(target,nextBytes);
 fs.unlinkSync(target);assert.throws(()=>verifyBackupBudgetCompatibility(f.installed,f.candidate));
 assert.throws(()=>verifyBackupBudgetCompatibility(f.installed,f.installed),/ROOT/);
});
test('both pinned backup trees contain the complete recursive local module dependency closure',t=>{
 const f=fixture(t);
 for(const tree of [f.installed,f.candidate])for(const relative of Object.keys(contract.files)){
  const file=path.join(tree,relative);if(!relative.endsWith('.js')||!fs.existsSync(file))continue;
  for(const match of fs.readFileSync(file,'utf8').matchAll(/\brequire\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g)){
   const base=path.resolve(path.dirname(file),match[2]);
   assert.ok(base.startsWith(tree+path.sep),'local module stays in its own reviewed tree: '+relative);
   const dependency=[base,base+'.js',base+'.json',path.join(base,'index.js')].find(value=>fs.existsSync(value)&&fs.statSync(value).isFile());
   assert.ok(dependency,'missing pinned dependency: '+relative+' -> '+match[2]);
   const name=path.relative(tree,dependency).split(path.sep).join('/');
   assert.ok(Object.hasOwn(contract.files,name),'unreviewed dependency: '+name);
  }
 }
});
test('image integrity dependencies are pinned and a new helper cannot appear in the historical installation',t=>{
 const f=fixture(t),helper='lib/sales-price-label-image-references.js';
 assert.equal(contract.files[helper].before,null);
 for(const relative of [helper,'lib/amu-storage.js','lib/integration-secret-vault.js','lib/data-import-protection.js','server-tools/linux/recovery/lib/recovery-verify.js']){
  const target=path.join(f.candidate,relative),original=fs.readFileSync(target);fs.appendFileSync(target,'\n// unreviewed');
  assert.throws(()=>verifyBackupBudgetCompatibility(f.installed,f.candidate),/PG_BACKUP_BUDGET_BRIDGE_UNREVIEWED/);fs.writeFileSync(target,original);
 }
 fs.copyFileSync(path.join(f.candidate,helper),path.join(f.installed,helper));
 assert.throws(()=>verifyBackupBudgetCompatibility(f.installed,f.candidate),/PG_BACKUP_BUDGET_BRIDGE_UNREVIEWED/);
});
test('new budget bundle remains completely verifiable by the pinned installed verifier',async t=>{
 const f=fixture(t);verifyBackupBudgetCompatibility(f.installed,f.candidate);
 const bundle=path.join(f.root,'snapshot.pair');fs.mkdirSync(bundle,{mode:0o700});fs.chmodSync(bundle,0o700);
 for(const name of ['core.dump','sales.dump','configuration.env','roles.sql'])fs.writeFileSync(path.join(bundle,name),'synthetic',{mode:0o600});
 const result=await sealPairBundle(bundle,{databases:['core','sales'].map(domain=>({domain,database:'grabenplaner_'+domain,file:domain+'.dump'})),checkpoint:{synthetic:true}});
 const old=require(path.join(f.installed,'lib/persistence/postgresql/operations/paired-bundle.js'));
 assert.equal((await old.verifyPairBundle(bundle,result.commitMarker)).verificationScope,'complete-file-content');
});
test('explicit bridge preserves preflight, full candidate selection and fresh first/second backup gates',()=>{
 const shell=fs.readFileSync(path.join(source,'server-tools/linux/update-grabenplaner-server.sh'),'utf8');
 assert.match(shell,/--postgresql-backup-budget-repair\) postgresql_backup_budget_repair=1/);
 assert.match(shell,/postgresql_backup_budget_repair" -eq 0[\s\S]*Der Deploy-Vorabcheck/);
 const create=shell.slice(shell.indexOf('create_exact_local_backup()'),shell.indexOf('\n}',shell.indexOf('create_exact_local_backup()'))+2);
 assert.match(create,/postgresql_backup_budget_repair:-0[\s\S]*backup_app_dir="\$extract_root"/);
 assert.match(create,/postgresql-backup-budget-compat\.js" "\$app_dir" "\$backup_app_dir"/);
 assert.match(create,/"\$backup_script" --env-file[\s\S]*--app-dir "\$backup_app_dir"/);
 assert.match(create,/"\$backup_app_dir\/server-tools\/linux\/lib\/postgresql-operations\.js" verify/);
 assert.equal((shell.match(/^create_exact_local_backup$/gm)||[]).length,1);
 assert.match(shell,/begin_deploy_phase final-rollback-backup\s+create_exact_local_backup/);
 assert.ok(shell.indexOf('"$trusted_package_verifier" "$extract_root"')<shell.indexOf('if (( postgresql_backup_budget_repair == 1 )); then',shell.indexOf('"$trusted_package_verifier" "$extract_root"')));
 assert.match(shell,/old_version" == 0\.92\.58-beta/,'historical bridge remains separately scoped');
});

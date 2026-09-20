'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..'),bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'/bin/bash';
const source=fs.readFileSync(path.join(root,'server-tools/linux/lib/common.sh'),'utf8');
const block=source.slice(source.indexOf('gp_configure_nightly_backups()'),source.indexOf('gp_apply_app_permissions()'));
test('only a trusted matching version pair selects the single nightly schedule',()=>{
 const guard=source.slice(source.indexOf('gp_nightly_schedule_mode()'),source.indexOf('gp_configure_nightly_backups()'));
 const code=guard.split("<<'NODE'\n")[1].split('\nNODE')[0],vm=require('node:vm');
 function run(coreVersion,moduleVersion,overrides={}){
  const process={argv:['node','-', '/fixture'],stdout:{write:s=>result.output+=s},stderr:{write:s=>result.error+=s},exitCode:0};
  const result={output:'',error:''},info={isFile:()=>true,isSymbolicLink:()=>false,uid:0,nlink:1,mode:0o644,size:1024,...overrides.info};
  const fs={existsSync:()=>true,lstatSync:()=>info,realpathSync:file=>overrides.alias||file,readFileSync:file=>JSON.stringify({
   format:file.includes('installed-contract')?'grabenplaner-linux-offsite-installed-contract':'grabenplaner-linux-offsite-module-contract',
   schemaVersion:1,moduleVersion:file.includes('installed-contract')?moduleVersion:coreVersion,...overrides.contract})};
  vm.runInNewContext(code,{require:name=>name==='node:fs'?fs:require('node:path').posix,process});
  return {...result,exitCode:process.exitCode};
 }
 for(const [core,installed,expected] of [[11,11,'single'],[10,11,'single'],[11,10,'single'],[10,10,'single'],[9,10,'legacy'],[10,9,'legacy'],[8,10,'legacy'],[7,10,'legacy']])
  assert.deepEqual(run(core,installed),{output:expected,error:'',exitCode:0});
 for(const bad of [{info:{uid:1000}},{info:{mode:0o666}},{info:{nlink:2}},{info:{isSymbolicLink:()=>true}},
  {info:{size:131073}},{alias:'/elsewhere'},{contract:{schemaVersion:2}},{contract:{moduleVersion:12}},{contract:{format:'other'}}]){
  const result=run(10,10,bad);assert.equal(result.exitCode,1);assert.equal(result.output,'');
 }
});
for(const mode of ['single','legacy','none','failed-replacement']){
 test('actual backup timer convergence: '+mode,{skip:!fs.existsSync(bash)},()=>{
  const code=`set -e\ngp_maintenance_schedule_state(){ printf none; }\ngp_nightly_schedule_mode(){ printf '%s' '${mode==='failed-replacement'?'single':mode}'; }\n`+
   `systemctl(){ printf '%s\\n' "$*" >> "$log"; if [[ '${mode}' == failed-replacement && "$1" == is-active ]]; then return 1; fi; }\n`+
   `log=$(mktemp)\ntrap 'rm -f -- "$log"' EXIT\n`+block+`\nif gp_configure_nightly_backups /fixture node; then printf 'ok\\n'; else printf 'failed\\n'; fi\ncat "$log"`;
  const r=spawnSync(bash,['--noprofile','--norc','-s'],{input:code,encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);
  if(mode==='none'){assert.equal(r.stdout,'ok\n');return;}
  if(mode==='failed-replacement'){assert.match(r.stdout,/^failed/);assert.doesNotMatch(r.stdout,/disable|offsite-upload/);return;}
  const action=(mode==='single'?'disable':'enable')+' --now grabenplaner-offsite-upload.timer';
  assert.ok(r.stdout.indexOf('is-active --quiet grabenplaner-offsite-assurance.timer')<r.stdout.indexOf(action));
  assert.match(r.stdout,new RegExp(action));assert.doesNotMatch(r.stdout,/offsite-check|restore-test/);
 });
}
test('the package requires a versioned transition and converges on install, application swap and rollback',()=>{
 const read=p=>fs.readFileSync(path.join(root,p),'utf8');
 assert.equal(JSON.parse(read('server-tools/linux/offsite/module-schema.json')).moduleVersion,11);
 const updater=read('server-tools/linux/update-grabenplaner-server.sh');
 assert.equal((updater.match(/gp_configure_nightly_backups "\$app_dir" "\$node"/g)||[]).length,2);
 assert.match(read('server-tools/linux/offsite/install-grabenplaner-offsite.sh'),/declare -F gp_configure_nightly_backups/);
});

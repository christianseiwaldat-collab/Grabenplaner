'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'/bin/bash';
const source=fs.readFileSync(path.resolve(__dirname,'../server-tools/linux/update-grabenplaner-server.sh'),'utf8').replace(/\r\n/g,'\n');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
function fixture(t){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'gp-owned-shell-'));
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const write=(relative,content)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content,{mode:0o755});};
 return {root,write,run(script){write('run.sh',script);const result=spawnSync(bash,['--noprofile','--norc','run.sh'],{cwd:root,encoding:'utf8',timeout:15000});return {...result,events:fs.existsSync(path.join(root,'events'))?fs.readFileSync(path.join(root,'events'),'utf8').trim().split('\n'):[]};}};
}
const nodePrelude=`node=${quote(process.execPath.replaceAll('\\','/'))}\nroot_node() { "$node" "$@"; }\n`;

for (const scenario of [
 {name:'saved-core',scope:'deploy-owned',verification:'auto',expected:'owned',reads:1},
 {name:'saved-full',scope:'full',verification:'auto',expected:'full',reads:1},
 {name:'unreadable',scope:'deploy-owned',verification:'auto',expected:'blocked',reads:1,unreadable:true},
 {name:'malformed-response',scope:'unknown',verification:'auto',expected:'blocked',reads:1},
 {name:'corrupt-storage',scope:'full',valid:false,verification:'auto',expected:'blocked',reads:1},
 {name:'invalid-reduced-response',scope:'deploy-owned',valid:false,verification:'auto',expected:'blocked',reads:1},
 {name:'explicit-full-wins',scope:'deploy-owned',verification:'full',expected:'full',reads:0},
 {name:'explicit-core-wins',scope:'full',verification:'deploy-owned',expected:'owned',reads:0},
 {name:'mandatory-transition-stops-core',scope:'deploy-owned',verification:'auto',expected:'blocked',reads:1,transition:'protected'},
 {name:'missing-assurance-stops-core',scope:'deploy-owned',verification:'auto',expected:'blocked',reads:1,offsite:0},
]) test('actual updater backup preference: '+scenario.name,{skip:!fs.existsSync(bash)},t=>{
 const f=fixture(t),start=source.indexOf('effective_verification_policy="$verification_policy"'),end=source.indexOf('\ngp_info "Deploy-Pruefstrategie:',start);
 assert.ok(start>0&&end>start);
 f.write('candidate/lib/deploy-backup-scope.js',fs.readFileSync(path.resolve(__dirname,'../lib/deploy-backup-scope.js'),'utf8'));
 f.write('candidate/server-tools/linux/lib/postgresql-operations.js',`const fs=require('node:fs');fs.appendFileSync(process.env.EVENTS_FILE,'read-preference\\n');
if(process.argv[2]!=='deploy-backup-scope'||!process.argv[3].replaceAll('\\\\','/').endsWith('/etc/grabenplaner/postgresql-operations.json'))process.exit(2);
${scenario.unreadable?'process.exit(1);':`console.log(JSON.stringify({scope:${JSON.stringify(scenario.scope)},valid:${scenario.valid!==false},available:true,appliesTo:'deploy-auto'}));`}`);
 for(const [relative,mode] of [['scripts/lib/deploy-policy.js','full'],['candidate/server-tools/linux/lib/deploy-owned-policy.js','owned']])
  f.write(relative,`require('node:fs').appendFileSync(process.env.EVENTS_FILE,${JSON.stringify('classifier:'+mode+'\n')});console.log(JSON.stringify({mode:${JSON.stringify(mode)}}));`);
 const r=f.run(`set -Eeuo pipefail
export EVENTS_FILE="$PWD/events"
: > "$EVENTS_FILE"
${nodePrelude}
verification_policy=${quote(scenario.verification)};database_provider=postgresql
extract_root="$PWD/candidate";SCRIPT_DIR="$PWD/scripts";app_dir="$PWD/app";database="$PWD/anchor";env_file="$PWD/env"
runtime_v5_transition=${quote(scenario.transition||'')};GRABENPLANER_OFFSITE_CONFIGURED=${scenario.offsite??1}
deploy_decision='{"mode":"full","reason":"SAFE_DEFAULT"}'
declare -A deploy_timer_was_enabled=([grabenplaner-offsite-assurance.timer]=1)
declare -A deploy_timer_was_active=([grabenplaner-offsite-assurance.timer]=1)
gp_warn() { printf 'warning\\n' >> "$EVENTS_FILE"; }
gp_die() { exit 42; }
${source.slice(start,end)}
printf 'mode:%s\\n' "$deploy_mode" >> "$EVENTS_FILE"
`);
 assert.equal(r.events.filter(event=>event==='read-preference').length,scenario.reads);
 if(scenario.expected==='blocked'){
  assert.equal(r.status,42,r.stderr);
  assert.ok(!r.events.some(event=>event.startsWith('mode:')));
  return;
 }
 assert.equal(r.status,0,r.stderr);
 assert.ok(r.events.includes('mode:'+scenario.expected),JSON.stringify(r.events));
 if(scenario.transition||scenario.verification==='full'||scenario.offsite===0) assert.ok(!r.events.some(event=>event.startsWith('classifier:')));
 else assert.ok(r.events.includes('classifier:'+scenario.expected));
});

for(const scenario of ['owned','missing-source','invalid-owned-verification'])test('fresh backup selection and scoped verification: '+scenario,{skip:!fs.existsSync(bash)},t=>{
 const f=fixture(t),start=source.indexOf('create_exact_local_backup() {'),end=source.indexOf('\nbegin_deploy_phase deploy-preflight',start);
 assert.ok(start>0&&end>start);const functionSource=source.slice(start,end);
 for(const label of ['installed','candidate']){
  f.write(label+'/server-tools/linux/backup-grabenplaner.sh',`#!/usr/bin/env bash
set -Eeuo pipefail
printf 'backup:${label}:%s\\n' "$*" >> "$EVENTS_FILE"
${label==='candidate'&&scenario==='missing-source'?'exit 41':''}
point="$TEST_BACKUP_ROOT/${label}"
mkdir -p "$point/private/amu"
printf '{"path":"%s","amuBackup":"%s/private/amu"}\\n' "$point" "$point"
`);
  f.write(label+'/server-tools/linux/lib/postgresql-operations.js',`const fs=require('node:fs');fs.appendFileSync(process.env.EVENTS_FILE,'operation:${label}:'+process.argv[2]+'\\n');
${label==='candidate'&&scenario==='invalid-owned-verification'?"if(process.argv[2]==='verify-deploy-owned')process.exit(42);":''}
console.log(JSON.stringify({synthetic:true}));`);
 }
 const r=f.run(`set -Eeuo pipefail
export EVENTS_FILE="$PWD/events" TEST_BACKUP_ROOT="$PWD/points"
: > "$EVENTS_FILE"
app_dir="$PWD/installed"
extract_root="$PWD/candidate"
runtime_v5_transition='';runtime_v6_transition='';xoffi_snapshots_migration=0
postgresql_backup_repair=0;postgresql_backup_budget_repair=0
deploy_mode=owned;deploy_decision='{"mode":"owned"}'
database_provider=postgresql;database="$PWD/anchor";env_file="$PWD/environment";data_dir="$PWD/data";backup_dir="$PWD/points";backup_keep=2
backup_result_file="$PWD/backup-result.json";service=synthetic.service;service_user=synthetic;service_group=synthetic
${nodePrelude}
gp_die() { printf 'failed\\n' >> "$EVENTS_FILE"; exit 42; }
gp_warn() { printf 'fallback-warning\\n' >> "$EVENTS_FILE"; }
${functionSource}
create_exact_local_backup
printf 'final-mode:%s\\n' "$deploy_mode" >> "$EVENTS_FILE"
printf 'final-decision:%s\\n' "$deploy_decision" >> "$EVENTS_FILE"
`);
 const candidate=r.events.find(event=>event.startsWith('backup:candidate:'));assert.ok(candidate?.includes('--deploy-owned'));
 assert.ok(r.events.includes('operation:candidate:identity'));
 assert.ok(!r.events.some(event=>event.startsWith('backup:installed:')));
 assert.equal(r.events.includes('operation:candidate:verify-deploy-owned'),scenario!=='missing-source');
 assert.equal(r.status,scenario==='owned'?0:42,r.stderr);
 assert.equal(r.events.includes('final-mode:owned'),scenario==='owned');
});

for(const scenario of ['owned','policy-drift','failed-owned-recovery','invalid-owned-proof','failed-readiness','explicit-full'])test('actual updater phase ordering: '+scenario,{skip:!fs.existsSync(bash)},t=>{
 const f=fixture(t),entry='\ngp_begin_update_backup_ownership "$database"',start=source.indexOf(entry)+1;assert.ok(start>0);
 const workflow=source.slice(start).replaceAll('/usr/local/sbin/grabenplaner-offsite-pre-update','$TEST_MODULE_ROOT/grabenplaner-offsite-pre-update.sh').replaceAll('/opt/grabenplaner-offsite/module','$TEST_MODULE_ROOT');
 f.write('app/old.txt','old synthetic app');
 f.write('candidate/package.json','{}');
 f.write('candidate/server-tools/linux/test-grabenplaner-server.sh','#!/usr/bin/env bash\nprintf "short-checks\\n" >> "$EVENTS_FILE"\n');
 f.write('candidate/server-tools/linux/lib/deploy-owned-policy.js',`require('node:fs').appendFileSync(process.env.EVENTS_FILE,'owned-policy-recheck\\n');console.log(JSON.stringify({mode:'${scenario==='policy-drift'?'full':'owned'}'}));`);
 f.write('candidate/server-tools/linux/lib/deploy-owned-recovery.js',`require('node:fs').appendFileSync(process.env.EVENTS_FILE,'owned-recovery-proof\\n');
${scenario==='failed-owned-recovery'?'process.exit(42);':`console.log(JSON.stringify({ok:true,fullRecovery:${scenario==='invalid-owned-proof'},ownedApplicationSmoke:true,providerId:'postgresql-deploy-owned',pairManifestSha256:'${'a'.repeat(64)}',verifiedAt:'2026-11-16T00:00:00.000Z'}));`}`);
 for(const [helper,result] of [['import-delete',{verified:true,coreUnchanged:true}],['vocational-school',{verified:true,salesUnchanged:true}],['session-security',{verified:true,salesUnchanged:true}]])f.write('candidate/server-tools/linux/lib/'+helper+'-migrate.js',`require('node:fs').appendFileSync(process.env.EVENTS_FILE,'migration:${helper}\\n');console.log(JSON.stringify(${JSON.stringify(result)}));`);
 f.write('candidate/server-tools/linux/lib/passkeys-release-policy.js',"require('node:fs').appendFileSync(process.env.EVENTS_FILE,'migration:passkeys-proof\\n');");
 f.write('candidate/server-tools/linux/lib/deploy-recovery-queue.js',"require('node:fs').appendFileSync(process.env.EVENTS_FILE,'queue-deadline\\n');");
 f.write('module/grabenplaner-offsite-pre-update.sh','#!/usr/bin/env bash\nprintf "offsite-transfer\\n" >> "$EVENTS_FILE"\n');
 f.write('module/lib/offsite-common.sh',`offsite_acquire_assurance_lock() { :; }
offsite_assert_runtime_binaries() { :; }
offsite_record_assurance_queue() { printf 'queue-assurance\\n' >> "$EVENTS_FILE"; }
`);
 const r=f.run(`set -Eeuo pipefail
export EVENTS_FILE="$PWD/events" TEST_MODULE_ROOT="$PWD/module"
: > "$EVENTS_FILE"
app_dir="$PWD/app";extract_root="$PWD/candidate";rollback_root="$PWD/previous";maintenance_root="$PWD/maintenance";mkdir "$maintenance_root"
database="$PWD/anchor";database_provider=postgresql;data_dir="$PWD/data";backup_dir="$PWD/backups";backup_result_file="$PWD/backup-result.json";env_file="$PWD/environment";SCRIPT_DIR="$PWD/scripts"
service=fixture.service;caddy_service=fixture-caddy.service;service_group=root
${nodePrelude}
root_node_with_installed_dependencies() { "$node" "$@"; }
deploy_assurance_scheduled_epoch_ms=1793271600000
health_timeout=1500;internal_ready_url=http://127.0.0.1/ready;public_ready_url=https://fixture.invalid/ready;public_url=https://fixture.invalid
old_version=0.92.102-beta;candidate_version=0.92.104-beta;actual_package_sha256=synthetic
runtime_v5_transition='';runtime_v6_transition='';xoffi_snapshots_migration=0
GRABENPLANER_OFFSITE_CONFIGURED=1;GRABENPLANER_OFFSITE_STATUS_FILE=/var/lib/grabenplaner-offsite/status.json
deploy_mode=${scenario==='explicit-full'?'full':'owned'};deploy_decision='{"mode":"${scenario==='explicit-full'?'full':'owned'}"}'
schema_migration_result="$PWD/migration.json";school_migration_result="$PWD/school.json";session_security_migration_result="$PWD/session-security.json"
backup_count=0;new_service_started=0
gp_info() { :; }
gp_warn() { printf 'warning\\n' >> "$EVENTS_FILE"; }
gp_die() { printf 'failed\\n' >> "$EVENTS_FILE"; exit 42; }
begin_deploy_phase() { printf 'phase:%s\\n' "$1" >> "$EVENTS_FILE"; }
finish_deploy_phase() { :; }
gp_begin_update_backup_ownership() { printf 'owner\\n' >> "$EVENTS_FILE"; }
gp_stop_service() { printf 'stop\\n' >> "$EVENTS_FILE"; }
gp_start_service() { printf 'start\\n' >> "$EVENTS_FILE"; }
gp_configure_nightly_backups() { printf 'schedule-converged\\n' >> "$EVENTS_FILE"; }
wait_deployment_ready() { printf 'ready\\n' >> "$EVENTS_FILE"; ${scenario==='failed-readiness'?'return 1;':':;'} }
gp_apply_app_permissions() { :; }
gp_sha256() { printf '${'a'.repeat(64)}'; }
start_database_lock() { printf 'database-lock\\n' >> "$EVENTS_FILE"; }
release_database_lock() { :; }
create_exact_local_backup() {
 backup_count=$((backup_count + 1));printf 'verified-backup\\n' >> "$EVENTS_FILE"
 backup_database="$PWD/point-$backup_count";backup_amu="$backup_database/private/amu";mkdir -p "$backup_amu"
}
write_receipt() { printf 'success-receipt\\n' >> "$EVENTS_FILE"; printf '%s\\n' "$PWD/receipt"; }
write_commit_marker() { printf 'commit\\n' >> "$EVENTS_FILE"; }
stat() { if [[ "$1" == '--format=%a' ]]; then printf '600\\n'; else printf '0:0:1\\n'; fi; }
systemctl() { case "$1" in is-enabled|is-active) return 0;;is-failed) return 1;;*) printf 'start-assurance\\n' >> "$EVENTS_FILE";;esac; }
${workflow}
`);
 const events=r.events;
 if(['policy-drift','failed-owned-recovery','invalid-owned-proof','failed-readiness'].includes(scenario)){
  assert.equal(r.status,42,r.stderr);assert.ok(!events.includes('commit'));assert.ok(!events.includes('queue-assurance'));
  if(scenario==='policy-drift')assert.ok(!events.includes('phase:application-swap'));
  if(scenario==='failed-readiness')assert.ok(!events.includes('owned-recovery-proof'));
  if(['failed-owned-recovery','invalid-owned-proof'].includes(scenario))assert.ok(events.includes('owned-recovery-proof'));
  return;
 }
 assert.equal(r.status,0,r.stderr);assert.ok(events.includes('commit'));
 assert.ok(events.indexOf('short-checks')<events.indexOf('success-receipt'));assert.ok(events.indexOf('success-receipt')<events.indexOf('commit'));
 assert.ok(events.indexOf('commit')<events.indexOf('queue-assurance'));
 if(scenario==='owned'){
  assert.equal(events.filter(event=>event==='verified-backup').length,1);
  assert.ok(events.indexOf('owned-policy-recheck')<events.indexOf('phase:application-swap'));
  assert.ok(events.indexOf('ready')<events.indexOf('owned-recovery-proof'));
  assert.ok(events.indexOf('short-checks')<events.indexOf('owned-recovery-proof'));
  assert.ok(events.indexOf('owned-recovery-proof')<events.indexOf('success-receipt'));
  assert.ok(events.indexOf('queue-assurance')<events.indexOf('queue-deadline'));
  assert.ok(!events.includes('offsite-transfer'));assert.ok(!events.includes('start-assurance'));
 }else{
  assert.equal(events.filter(event=>event==='verified-backup').length,2);assert.ok(events.includes('offsite-transfer'));assert.ok(events.includes('start-assurance'));
  assert.ok(!events.includes('owned-policy-recheck'));assert.ok(!events.includes('owned-recovery-proof'));assert.ok(!events.includes('queue-deadline'));
 }
});

for (const scenario of ['qualified','local-basis','drive','failed-drive','resume']) {
  test('candidate preparation runs exactly the required restore: ' + scenario, { skip: !fs.existsSync(bash) }, t => {
    const f = fixture(t), start = source.indexOf('prepare_core_candidate() {'), end = source.indexOf('\ncreate_exact_local_backup()', start);
    assert.ok(start > 0 && end > start);
    const helper = 'candidate/server-tools/linux/lib/';
    const point = { bundle: 'example.owned', sha256: 'a'.repeat(64) };
    f.write(helper + 'core-deploy-proof.js', [
      "const fs = require('node:fs'), action = process.argv[2];",
      "fs.appendFileSync('events', action + '\\n');",
      "if (action === 'inspect') process.exit(process.env.SCENARIO === 'qualified' || fs.existsSync('signed') ? 0 : 1);",
      "if (action === 'basis-for-point') process.exit(process.env.SCENARIO === 'local-basis' ? 0 : 1);",
      "if (action === 'local-point' && process.env.SCENARIO === 'resume') process.exit(1);",
      "if (action === 'local-point') console.log(JSON.stringify({backup:" + JSON.stringify(point) + "}));",
    ].join('\n'));
    f.write(helper + 'core-drive-proof.js', "require('node:fs').appendFileSync('events',process.argv[2]+'\\n');console.log(" +
      JSON.stringify(JSON.stringify({ backup: point })) + ");");
    f.write(helper + 'deploy-owned-recovery.js', "require('node:fs').appendFileSync('events','local-restore\\n');console.log('{}');");
    f.write('candidate/server-tools/linux/core-drive-recovery.sh', [
      '#!/usr/bin/env bash', 'echo drive-restore >>events', '[[ $1 == example.owned && $4 == --lock-already-held ]] || exit 3',
      '[[ $SCENARIO != failed-drive ]] || exit 1', 'touch signed',
    ].join('\n'));
    const result = f.run([
      'set -euo pipefail', 'mkdir maintenance', 'maintenance_root=maintenance', 'app_dir=installed', 'extract_root=candidate',
      'export SCENARIO=' + scenario, nodePrelude, 'gp_die() { exit 42; }', source.slice(start, end), 'prepare_core_candidate',
    ].join('\n'));
    assert.equal(result.status, scenario === 'failed-drive' ? 42 : 0, result.stderr);
    const expected = {
      qualified: ['inspect'],
      'local-basis': ['inspect','local-point','basis-for-point','local-restore','record'],
      drive: ['inspect','local-point','basis-for-point','drive-restore','inspect'],
      'failed-drive': ['inspect','local-point','basis-for-point','drive-restore'],
      resume: ['inspect','local-point','resume','basis-for-point','drive-restore','inspect'],
    };
    assert.deepEqual(result.events, expected[scenario]);
  });
}

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const P=require('../lib/manual-drive-backups');
const ID='12345678-1234-4123-8123-123456789abc',OTHER='12345678-1234-4123-8123-123456789abd',host='grabenplaner-'+'a'.repeat(32),sha='b'.repeat(64),newest='c'.repeat(64),time='2026-11-17T10:00:00.000Z';
const raw=(overrides={})=>({id:sha,hostname:host,paths:[P.STAGE],tags:['grabenplaner-offsite','manual-admin-ui','gp-manual-'+ID],time,summary:{total_bytes_processed:42},...overrides});
const op=(overrides={})=>({requestId:ID,action:'create',state:'queued',phase:'queued',requestedAt:time,startedAt:null,finishedAt:null,snapshotId:null,errorCode:null,...overrides});

test('control and HTTP input accept only UUID actions and exact full snapshot identifiers',()=>{
 for(const action of ['list','create','dispatch'])assert.equal(P.request({format:P.FORMAT,action,requestId:ID,snapshotId:null}).action,action);
 P.request({format:P.FORMAT,action:'delete',requestId:ID,snapshotId:sha});
 for(const value of [{format:P.FORMAT,action:'create',requestId:ID,snapshotId:null,path:'/tmp/owned'},{format:P.FORMAT,action:'forget',requestId:ID,snapshotId:sha},{format:P.FORMAT,action:'delete',requestId:ID,snapshotId:'b'.repeat(8)}])assert.throws(()=>P.request(value),{code:'DRIVE_BACKUP_INVALID'});
 P.body({requestId:ID},'create');P.body({requestId:ID,currentPassword:'synthetic-only',confirmation:'DELETE_BACKUP'},'delete');
 for(const [value,action] of [[{requestId:ID,currentPassword:'secret'},'create'],[{requestId:ID,confirmation:'DELETE_BACKUP'},'delete'],[{requestId:ID,currentPassword:'synthetic-only',confirmation:'ALL'},'delete'],[{requestId:ID,currentPassword:'synthetic-only',confirmation:'DELETE_BACKUP',path:'/tmp'},'delete']])assert.throws(()=>P.body(value,action),{code:'DRIVE_BACKUP_INVALID'});
});

test('remote inventory excludes other installations, paths, providers tags and ambiguous ownership',()=>{
 const accepted=P.snapshots([raw(),raw({id:newest,tags:['daily','grabenplaner-offsite'],time:'2026-11-18T10:00:00Z'}),raw({hostname:'other'}),raw({paths:['/other']}),raw({tags:['grabenplaner-offsite','manual-admin-ui']}),raw({tags:['daily','grabenplaner-offsite','unexpected']})],host);
 assert.equal(accepted.length,2);assert.equal(accepted[0].snapshotId,newest);assert.equal(accepted[0].manual,false);assert.equal(accepted[1].manual,true);assert.equal(accepted[1].sizeBytes,42);assert.equal(accepted[1].sizeBasis,'logical');
 assert.throws(()=>P.snapshots([raw(),raw()],host),{code:'DRIVE_BACKUP_UNAVAILABLE'});
 assert.throws(()=>P.snapshots([raw({id:'short'})],host),{code:'DRIVE_BACKUP_UNAVAILABLE'});
 assert.equal(P.snapshots([raw({summary:undefined})],host)[0].sizeBytes,null);
});

test('newest and automatic snapshots are protected; stale or busy rows cannot be deleted',()=>{
 const cache={verifiedAt:time,backups:P.snapshots([raw(),raw({id:newest,time:'2026-11-18T10:00:00Z',tags:['daily','grabenplaner-offsite']})],host)};
 const fresh=P.publicModel(cache,null);assert.equal(fresh.backups[0].deletable,false);assert.equal(fresh.backups[0].blockedDeleteReason,'AUTOMATIC_BACKUP');assert.equal(fresh.backups[1].deletable,true);
 for(const options of [{busy:true},{stale:true}]){const current=P.publicModel(cache,null,options);assert.ok(current.backups.every(row=>!row.deletable&&row.blockedDeleteReason==='OPERATION_BUSY'));}
 const single=P.publicModel({verifiedAt:time,backups:P.snapshots([raw()],host)},null);assert.equal(single.backups[0].blockedDeleteReason,'NEWEST_BACKUP');
});

test('unknown sizes stay unknown and impossible terminal job states fail closed',()=>{
 P.operation(op());P.operation(op({state:'running',phase:'uploading',startedAt:time}));
 P.operation(op({state:'failed',phase:'failed',finishedAt:time,errorCode:'DRIVE_BACKUP_FAILED'}));
 for(const value of [op({state:'succeeded'}),op({state:'succeeded',phase:'complete',finishedAt:time}),op({action:'delete'}),op({errorCode:'DRIVE_BACKUP_FAILED'}),op({state:'failed',finishedAt:time}),op({phase:'/bin/sh'})])assert.throws(()=>P.operation(value),{code:'DRIVE_BACKUP_UNAVAILABLE'});
 P.operation(op({state:'succeeded',phase:'complete',finishedAt:time,snapshotId:sha}));
 const current=P.publicModel({verifiedAt:null,backups:[]},op(),{busy:true,stale:true});assert.equal(current.stale,true);assert.equal(current.verifiedAt,null);
});

// Execute the actual queue boundary with synthetic durable storage. There is
// no privileged process, repository or business data in this fixture.
const broker=fs.readFileSync(path.join(__dirname,'../server-tools/linux/lib/manual-drive-control.js'),'utf8');
const start=broker.indexOf('function queue('),end=broker.indexOf('\nfunction dispatch(',start),queueSource=broker.slice(start,end);
function fixture(){
 const jobs=new Map(),calls=[],expected={repositoryId:'a'.repeat(64),host},cache={verifiedAt:time,backups:P.snapshots([raw(),raw({id:newest,time:'2026-11-18T10:00:00Z',tags:['daily','grabenplaner-offsite']})],host)};let latest=null;
 const context=vm.createContext({P,Date,ROOT:'/synthetic-private',fs:{readdirSync:()=>[]},fail:code=>{throw Object.assign(new Error(code),{code});},same:(a,b)=>a.repositoryId===b.repositoryId&&a.host===b.host,
  job:id=>jobs.get(id),reconcile:value=>value,latest:()=>latest,cache:()=>cache,refresh:()=>{calls.push('refresh');return cache;},command:action=>calls.push(action),save:value=>jobs.set(value.operation.requestId,structuredClone(value)),write:(_file,value)=>{latest=jobs.get(value.requestId);}});
 vm.runInContext(queueSource,context);return{jobs,calls,run:(action,requestId=ID,snapshotId=null)=>context.queue({action,requestId,snapshotId},expected)};
}
test('durable queue is idempotent, never starts a process and rejects conflicting reuse or concurrent job',()=>{
 const f=fixture(),first=f.run('create');assert.equal(first.operation.state,'queued');assert.deepEqual(f.calls,['probe','refresh']);
 assert.equal(f.run('create').operation.requestId,ID);assert.deepEqual(f.calls,['probe','refresh']);
 assert.throws(()=>f.run('delete',ID,sha),{code:'DRIVE_BACKUP_REQUEST_CONFLICT'});assert.throws(()=>f.run('create',OTHER),{code:'DRIVE_BACKUP_BUSY'});
});
test('delete queue requires fresh exact selectable remote snapshot, and cannot target newest or another snapshot',()=>{
 assert.equal(fixture().run('delete',ID,sha).operation.snapshotId,sha);
 assert.throws(()=>fixture().run('delete',ID,newest),{code:'DRIVE_BACKUP_PROTECTED'});
 assert.throws(()=>fixture().run('delete',ID,'d'.repeat(64)),{code:'DRIVE_BACKUP_NOT_FOUND'});
});

test('every accepted socket instance uses one fixed root state flock before queue/list/dispatch',async()=>{
 const unit=fs.readFileSync(path.join(__dirname,'../server-tools/linux/drive-control/grabenplaner-drive-control@.service'),'utf8');
 assert.match(unit,/^ExecStart=\/usr\/bin\/flock --exclusive --wait 3 \/run\/grabenplaner-drive-control\/broker\.lock \/usr\/bin\/node \/opt\/grabenplaner\/app\/server-tools\/linux\/lib\/manual-drive-control\.js broker$/m);
 assert.doesNotMatch(unit,/^User=/m);assert.match(unit,/^Group=root$/m);
 assert.match(unit,/^NoNewPrivileges=yes$/m);assert.match(broker,/process\.getuid\(\)!==0/);
 assert.match(unit,/^RuntimeDirectoryMode=0755$/m);
 const f=fixture(),results=await Promise.allSettled([Promise.resolve().then(()=>f.run('create',ID)),Promise.resolve().then(()=>f.run('create',OTHER))]);
 assert.equal(results.filter(v=>v.status==='fulfilled').length,1);assert.equal(results.find(v=>v.status==='rejected').reason.code,'DRIVE_BACKUP_BUSY');assert.equal(f.jobs.size,1);
 assert.equal(f.calls.filter(v=>v==='probe').length,1);
});

test('privileged manual operation uses fixed inherited locks and exact deletion without retention or assurance',()=>{
 const shell=fs.readFileSync(path.join(__dirname,'../server-tools/linux/lib/manual-drive-operation.sh'),'utf8');
 assert.match(shell,/offsite_acquire_maintenance_lock_with_wait 300[\s\S]*offsite_acquire_repository_lock/);
 assert.match(shell,/grabenplaner-offsite-prepare\.sh" --lock-already-held --repository-lock-already-held/);
 assert.match(shell,/offsite_restic "\$credentials" forget "\$snapshot"/);
 assert.doesNotMatch(shell,/^\s*[^#\n]*(?:--prune|--keep-daily|restic[^\n]* restore|assurance@)/m);
 assert.match(shell,/value\.binding\?\.host!==host[\s\S]*value\.binding\?\.repositoryId/);
 assert.match(shell,/index<1\|\|!rows\[index\]\.manual/);
 assert.match(shell,/a\.length!==b\.length\+1/);
 assert.ok(shell.indexOf('flock --unlock 9')<shell.indexOf('phase "$id" uploading'));
});

test('manual worker finds required system-account tools with a minimal inherited environment',{skip:process.platform!=='linux'},()=>{
 const shell=fs.readFileSync(path.join(__dirname,'../server-tools/linux/lib/manual-drive-operation.sh'),'utf8');
 const fixedPath=shell.match(/^export PATH=[^\r\n]+$/m);
 assert.ok(fixedPath,'worker must declare its own fixed search path');
 const probe=spawnSync('/bin/bash',['--noprofile','--norc','-c',fixedPath[0]+'\ncommand -v runuser\ncommand -v getent\ncommand -v flock'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'},timeout:5000});
 assert.equal(probe.status,0,probe.stderr);
 assert.equal(probe.stdout.trim().split('\n').length,3,'all three account and locking tools must be found');
});

test('normal installers and committed updater provision only the optional protected capability',()=>{
 const root=path.join(__dirname,'../server-tools/linux'),update=fs.readFileSync(path.join(root,'update-grabenplaner-server.sh'),'utf8'),install=fs.readFileSync(path.join(root,'install-grabenplaner-server.sh'),'utf8'),offsite=fs.readFileSync(path.join(root,'offsite/install-grabenplaner-offsite.sh'),'utf8'),setup=fs.readFileSync(path.join(root,'install-manual-drive-control.sh'),'utf8');
 assert.ok(update.indexOf('update_committed=1\n')<update.indexOf('/bin/bash "$app_dir/server-tools/linux/install-manual-drive-control.sh"'));
 assert.ok(install.lastIndexOf('APP_SWAPPED=0\n')<install.indexOf('/bin/bash "$APP_ROOT/server-tools/linux/install-manual-drive-control.sh"'));
 assert.ok(offsite.indexOf('setup_complete=1\n')<offsite.indexOf('/bin/bash "$OFFSITE_APP_ROOT/server-tools/linux/install-manual-drive-control.sh"'));
 assert.match(setup,/cmp --silent "\$SOURCE\/\$name" "\$target" \|\| exit 1/);
 assert.match(setup,/for name in "\$\{created\[@\]\}"; do rm -f -- "\/etc\/systemd\/system\/\$name"; done/);
 assert.doesNotMatch(setup,/systemctl (?:start|enable --now) grabenplaner-drive-backup/);
});

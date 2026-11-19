'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Exercise the production shell's ExecCondition exit codes and real flock
// ordering. Only the host/service and provider adapters are fixture commands.
test('timer reads the newly completed proof after lock transfer; an explicit or unproved restore runs', {
  skip: process.platform !== 'linux', timeout: 15000
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-timer-lock-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const put = (name, contents) => fs.writeFileSync(path.join(dir,name),contents,{mode:0o700});
  const script = fs.readFileSync(path.join(__dirname,'../scripts/operations/restore-timer/restore-condition.sh'),'utf8');
  put('condition',script.replace('/opt/grabenplaner-offsite/module/lib/offsite-common.sh', '"$FIXTURE/common"'));
  put('common', `OFFSITE_NODE="$FIXTURE/evidence"
OFFSITE_STAGE_CURRENT=/stage
OFFSITE_APP_ROOT=/fixture
offsite_acquire_assurance_lock() { :; }
offsite_acquire_repository_lock() { exec 8<>"$FIXTURE/repo.lock"; echo waiting; flock 8; }
offsite_require_root() { :; }
offsite_assert_runtime_binaries() { :; }
offsite_credentials_directory() { echo fixture; }
offsite_make_uploader_credentials() { echo fixture; }
offsite_remove_uploader_credentials() { :; }
offsite_verify_repository_identity() { :; }
offsite_installation_host() { echo fixture; }
offsite_restic() { echo '[]'; }
systemctl() { if [[ "$*" == *ActiveState* ]]; then echo inactive; else echo success; fi; }
`);
  put('evidence', '#!/bin/bash\nif [[ "$1" == --no-global-search-paths ]]; then test -f "$FIXTURE/completed"; else echo "{}"; fi\n');
  const env = {...process.env, FIXTURE:dir,TRIGGER_UNIT:'grabenplaner-offsite-restore-test.timer',
    TRIGGER_TIMER_REALTIME_USEC:'1795062600000000'};
  const options = {cwd:dir,env,encoding:'utf8'};
  assert.equal(spawnSync('/bin/bash',['condition'],options).status,0);
  const holder = spawn('/bin/bash',['-c','exec 8<>repo.lock; flock 8; echo held; read -r done; touch completed'],options);
  t.after(() => holder.kill());
  await new Promise(resolve => holder.stdout.once('data',resolve));
  const timer = spawn('/bin/bash',['condition'],options);
  t.after(() => timer.kill());
  const finished = new Promise((resolve,reject) => {
    timer.once('error',reject); timer.once('close',resolve);
  });
  await new Promise(resolve => timer.stdout.once('data',resolve));
  holder.stdin.end('done\n');
  assert.equal(await finished,1, 'systemd must skip ExecStart after the waiting job sees the fresh pass');
  assert.equal(spawnSync('/bin/bash',['condition'],{...options,env:{...env,TRIGGER_UNIT:''}}).status,0);
  assert.equal(spawnSync('/bin/bash',['condition'],{...options,env:{...env,TRIGGER_TIMER_REALTIME_USEC:''}}).status,0);
});

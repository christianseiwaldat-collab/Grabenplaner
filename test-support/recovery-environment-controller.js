'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const candidate=path.dirname(__dirname),root=process.argv[2];
assert.equal(process.getuid(),0);assert.equal(path.dirname(candidate),root);assert.equal(fs.realpathSync(root),root);
const {recoveryUnitProperties}=require('../server-tools/linux/recovery/lib/postgresql-recovery');
const unit='grabenplaner-recovery-preflight-'+path.basename(root);
const properties=recoveryUnitProperties(root).filter(p=>!p.startsWith('ReadOnlyPaths=')&&!p.startsWith('RuntimeMaxSec='));
properties.push('ReadOnlyPaths=/opt/grabenplaner/app '+candidate+' '+root+'/source','RuntimeMaxSec=180');
// This three-minute cap is only for the cheap environment probe, never the restore.
let status=1;
try{
 const result=spawnSync('/usr/bin/systemd-run',['--quiet','--wait','--unit='+unit,...properties.map(p=>'--property='+p),
  '/usr/bin/node','--require',candidate+'/test-support/recovery-timeout-preload.js',candidate+'/test-support/recovery-environment-probe.js'],
  {stdio:'inherit',timeout:210000});
 if(result.error)throw result.error;
 assert.equal(result.status,0,'Isolated environment probe failed');
 assert.equal(JSON.parse(fs.readFileSync(root+'/environment-preflight.json','utf8')).passed,true);
 assert.deepEqual(fs.readdirSync(root+'/work'),[]);status=0;
}finally{
 const stopped=spawnSync('/usr/bin/systemctl',['stop',unit],{encoding:'utf8',timeout:45000});
 const state=spawnSync('/usr/bin/systemctl',['show',unit,'-p','ActiveState','-p','LoadState','-p','MainPID'],{encoding:'utf8',timeout:10000});
 const fields=Object.fromEntries(state.stdout.trim().split('\n').map(line=>line.split('=')));
 // systemd may already have unloaded a successfully exited transient unit.
 assert.match(fields.ActiveState,/^(inactive|failed)$/);assert.equal(fields.MainPID,'0');
 assert.ok(stopped.status===0||fields.LoadState==='not-found','Probe stop was not confirmed');
}
process.exitCode=status;

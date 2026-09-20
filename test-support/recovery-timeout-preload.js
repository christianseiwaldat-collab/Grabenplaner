'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{threadId}=require('node:worker_threads');
const candidate=path.dirname(__dirname),root=path.dirname(candidate);
if(process.getuid()===0||!/^\/var\/lib\/grabenplaner-offsite\/postgresql-recovery\/[a-f0-9-]{36}$/.test(root)||fs.realpathSync(root)!==root||Object.values(os.networkInterfaces()).flat().some(x=>!x.internal))throw new Error('GP697_DIAGNOSTIC_ISOLATION');
// A startup event must not make restorePair's new work directory non-empty.
const log=root+'/timeout-observer.jsonl';
const emit=event=>fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),pid:process.pid,threadId,...event})+'\n',{mode:0o600});
require('./recovery-timeout-observer').install({pg:require('pg'),errors:require('../lib/persistence/errors'),root:candidate,emit});
emit({event:'observer-ready'});

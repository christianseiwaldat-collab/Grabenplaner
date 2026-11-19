'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const source = path.resolve(__dirname, '../server-tools/linux/core-drive-recovery.sh');
const native = path.resolve(__dirname, '../server-tools/linux/lib/core-drive-proof.js');
const point = '00000000-0000-4000-8000-000000000001.owned';

test('Drive round trip rejects changed download, retries a failed receipt mirror without a second DB restore, then reuses proof',
  { skip: !fs.existsSync(bash) }, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-drive-roundtrip-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    function file(name, data) {
      const target = path.join(dir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data, { mode: 0o700 });
    }
    file('core-drive-recovery.sh', fs.readFileSync(source,'utf8').replace(
      'source /opt/grabenplaner-offsite/module/lib/offsite-common.sh', 'source ./offsite.sh'));
    file(point + '/manifest.json', 'sealed test manifest');
    file(point + '.complete.json', 'commit marker');
    file('offsite.sh', [
      'OFFSITE_NODE=node; OFFSITE_MODULE_ROOT=$PWD/module; OFFSITE_CONFIG_ROOT=$PWD; OFFSITE_STATE_ROOT=$PWD; OFFSITE_INSTALLED_CONTRACT=synthetic; OFFSITE_MAINTENANCE_LOCK=synthetic',
      'offsite_require_root() { :; }; offsite_assert_installed_contract() { :; }; offsite_assert_inherited_lock() { :; }',
      'offsite_acquire_repository_lock() { exec 8<offsite.sh; }; offsite_make_uploader_credentials() { echo synthetic; }',
      'offsite_verify_repository_identity() { :; }; offsite_installation_host() { printf "grabenplaner-%032d\\n" 0; }',
      'offsite_remove_uploader_credentials() { :; }; offsite_info() { :; }; offsite_die() { echo "$*" >&2; exit 7; }',
      'offsite_restic() { shift; node ./restic.js "$@"; }',
    ].join('\n'));
    file('module/lib/offsite-contract.js', "console.log('google_drive');");
    // All bytes being moved are real. Only restic transport, root policy and the PostgreSQL worker are replaced.
    file('restic.js', [
      "const fs=require('node:fs'), args=process.argv.slice(2), [action,id,name]=args;",
      "const rows=fs.existsSync('remote.json')?JSON.parse(fs.readFileSync('remote.json')):[];",
      "if(action==='snapshots'){console.log(JSON.stringify(rows));return;}",
      "if(action==='backup'){const file=args[args.indexOf('--stdin-filename')+1],isProof=file.endsWith('.json');",
      " if(isProof && fs.existsSync('fail-mirror')) process.exit(4);",
      " const id=(isProof?'b':'a').repeat(64),tags=args.flatMap((x,i)=>x==='--tag'?[args[i+1]]:[]);",
      " fs.writeFileSync(id,fs.readFileSync(0)); rows.push({id,hostname:'grabenplaner-'+'0'.repeat(32),tags,paths:['/'+file]});",
      " fs.writeFileSync('remote.json',JSON.stringify(rows));fs.appendFileSync('events','upload '+file+'\\n');}",
      "else if(action==='dump'){fs.writeSync(1,fs.readFileSync(id));if(id.startsWith('a')&&fs.existsSync('bad-copy'))fs.writeSync(1,'changed');}",
      "else process.exit(9);",
    ].join('\n'));
    file('lib/core-drive-proof.js', [
      "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');",
      'const select=require(' + JSON.stringify(native) + ').snapshotId;',
      "const [action,app,target,bundle,work]=process.argv.slice(2), digest=crypto.createHash('sha256').update('sealed test manifest').digest('hex');",
      "if(action==='prepare') console.log(JSON.stringify({manifestSha256:digest}));",
      "else if(action==='select'||action==='select-receipt') console.log(select(JSON.parse(fs.readFileSync(work)),target,bundle,action==='select-receipt'));",
      "else if(action==='reusable'){if(!fs.existsSync('pending'))process.exit(1);fs.copyFileSync('pending',path.join(work,'receipt.json'));}",
      "else if(action==='seal'){if(fs.readFileSync(path.join(work,'restore.json'),'utf8').trim()!=='restored')process.exit(5);fs.writeFileSync('pending','signed fixture');fs.copyFileSync('pending',path.join(work,'receipt.json'));}",
      "else if(action==='publish'){if(fs.readFileSync(path.join(work,'downloaded-receipt.json'),'utf8')!=='signed fixture')process.exit(6);fs.writeFileSync('published','yes');}",
      "else if(action!=='verify-files')process.exit(8);",
    ].join('\n'));
    file('app/server-tools/linux/lib/deploy-owned-recovery.js', [
      "const fs=require('node:fs'),path=require('node:path'),[bundle,marker]=process.argv.slice(2);",
      "if(path.basename(path.dirname(bundle))!=='download'||fs.readFileSync(path.join(bundle,'manifest.json'),'utf8')!=='sealed test manifest'||fs.readFileSync(marker,'utf8')!=='commit marker') process.exit(2);",
      "fs.appendFileSync('events','db-restore\\n');console.log('restored');",
    ].join('\n'));
    const run = () => spawnSync(bash, ['--noprofile','--norc','core-drive-recovery.sh',point,'app','app','--lock-already-held'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, MSYS2_ARG_CONV_EXCL: '/core-plus' } });
    file('bad-copy','1');
    const bad = run();
    assert.notEqual(bad.status,0);
    assert.match(bad.stderr,/Archivbytes/);
    fs.unlinkSync(path.join(dir,'bad-copy'));
    file('fail-mirror','1');
    const failedMirror = run();
    assert.notEqual(failedMirror.status,0);
    assert.equal(fs.existsSync(path.join(dir,'published')),false);
    fs.unlinkSync(path.join(dir,'fail-mirror'));
    for (let i=0;i<2;i++) { const r=run(); assert.equal(r.status,0,r.stderr); }
    assert.equal(fs.readFileSync(path.join(dir,'published'),'utf8'),'yes');
    assert.deepEqual(fs.readFileSync(path.join(dir,'events'),'utf8').trim().split('\n'),
      ['upload core-plus.tar','db-restore','upload core-plus-receipt.json']);
  });

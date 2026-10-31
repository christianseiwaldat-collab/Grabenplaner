'use strict';
// Explicit local-only verification of the P1 dependency candidate. No SMTP/network.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
// Follow declared dependency edges so both pnpm isolated and production hoisted
// installs exercise the same packages without relying on a virtual-store path.
function requireFrom(...packages) {
  let parent = require;
  for (const name of packages) parent = createRequire(parent.resolve(name));
  return parent;
}
const globParent = requireFrom('exceljs', 'archiver', 'archiver-utils', 'glob');
const readdirParent = requireFrom('exceljs', 'archiver', 'readdir-glob');
const braceParent = createRequire(globParent.resolve('minimatch'));
const expressParent = requireFrom('express');
const transitives = name => (name === 'brace-expansion' ? braceParent : expressParent)(name);
const worker = process.argv[2];
if (worker === 'minimatch-optimization') {
  for (const parent of [globParent, readdirParent]) {
    const {Minimatch} = parent('minimatch');
    const pattern = 'a/' + '**/../b/c/'.repeat(24) + 'z';
    const matcher = new Minimatch(pattern, {optimizationLevel:2, braceExpandMax:32});
    assert.ok(matcher.set.length > 0 && matcher.set.length <= 32);
    assert.equal(matcher.match('unrelated.txt'), false);
    assert.throws(() => new Minimatch('x'.repeat(65537)), /too long/i);
    const large = new Minimatch('{1..1100}/**/file.txt', {optimizationLevel:2});
    assert.equal(large.set.length, 1100);
    assert.equal(large.match('1100/sub/file.txt'), true);
    assert.equal(large.match('1101/sub/file.txt'), false);
  }
  process.stdout.write('completed');
} else if (worker === 'brace-nesting' || worker === 'brace-comma' || worker === 'brace-rewrite') {
  const expand = transitives('brace-expansion');
  const input = worker === 'brace-nesting' ? '{'.repeat(4000) + 'a,b' + '}'.repeat(4000)
    : worker === 'brace-comma' ? '{' + '{a},'.repeat(8000) + 'b}'
      : '{a}' + '}'.repeat(64000) + ',z}';
  const result = expand(input);
  assert.ok(Array.isArray(result));
  process.stdout.write('completed');
} else if (worker === 'mail-parser') {
  const parser = require('nodemailer/lib/addressparser');
  assert.equal(parser(Array.from({length:15000}, (_,i)=>`u${i}@example.test`).join(',')).length, 15000);
  assert.ok(Array.isArray(parser(' >' + '>[x][x]'.repeat(20000))));
  process.stdout.write('completed');
} else {
  function boundedWorker(name) {
    const result = spawnSync(process.execPath, ['--max-old-space-size=192', __filename, name], {encoding:'utf8', timeout:5000, maxBuffer:4096});
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'completed');
  }
  test('brace-expansion keeps callable CJS, named exports and new upstream limits', () => {
    const expand = transitives('brace-expansion');
    assert.equal(typeof expand, 'function'); assert.equal(expand.expand, expand);
    for (const k of ['EXPANSION_MAX','EXPANSION_MAX_LENGTH','EXPANSION_MAX_DEPTH','EXPANSION_MAX_REWRITES']) assert.ok(Number.isFinite(expand[k]) && expand[k] > 0,k);
    assert.deepEqual(expand('file-{a,b}-{1..2}.txt'), ['file-a-1.txt','file-a-2.txt','file-b-1.txt','file-b-2.txt']);
    assert.equal(expand('{a,b,c}', {max:2}).length, 2);
  });
  test('both ExcelJS matcher consumers use the fixed modern API', () => {
    for(const parent of [globParent, readdirParent]){
      assert.equal(parent('minimatch/package.json').version, '11.0.3');
      const mm=parent('minimatch');
      assert.equal(mm.minimatch('report-2.xlsx','report-{1,2}.xlsx'),true); assert.equal(mm.minimatch('report-3.xlsx','report-{1,2}.xlsx'),false);
      assert.deepEqual(mm.braceExpand('{a,b}/file-{1..2}'),['a/file-1','a/file-2','b/file-1','b/file-2']);}
  });
  test('ExcelJS XLSX write/read roundtrip works with transitive patch', async () => {
    const ExcelJS=require('exceljs'), book=new ExcelJS.Workbook();
    book.addWorksheet('Prüfung').addRow(['Grabenplaner',42]);
    const bytes=await book.xlsx.writeBuffer(), read=new ExcelJS.Workbook(); await read.xlsx.load(bytes);
    assert.equal(read.getWorksheet('Prüfung').getCell('B1').value,42);
  });
  for(const name of ['brace-nesting','brace-comma','brace-rewrite','minimatch-optimization']) test(`bounded upstream advisory regression: ${name}`,()=>boundedWorker(name));
  test('qs rejects bracket/comma expansion above explicit array limit', () => {
    assert.throws(()=>transitives('qs').parse('a[]=1,2,3,4',{comma:true,arrayLimit:3,throwOnLimitExceeded:true}),RangeError);
  });
  test('qs safely roundtrips an attacker-controlled noncallable isBuffer property', () => {
    const qs=transitives('qs');const v=qs.parse('x[constructor][isBuffer]=y',{plainObjects:true});
    assert.doesNotThrow(()=>qs.stringify(v));
  });
  test('proxy-addr rejects IPv4 trust through incorrectly mapped IPv6 subnet', () => {
    const p=transitives('proxy-addr'), req={socket:{remoteAddress:'198.51.100.23'},headers:{'x-forwarded-for':'203.0.113.9'}};
    assert.equal(p(req,p.compile('::ffff:10.0.0.0/8')),'198.51.100.23');
    assert.equal(p(req,p.compile('loopback')),'198.51.100.23');
  });
  test('Nodemailer CJS stream transport composes text and a Buffer attachment locally', async () => {
    const transport=require('nodemailer').createTransport({streamTransport:true,buffer:true});
    const result=await transport.sendMail({from:'GP <gp@example.test>',to:'user@example.test',subject:'Prüfung',text:'Synthetisch',attachments:[{filename:'test.pdf',content:Buffer.from('%PDF-synthetic'),contentType:'application/pdf'}]});
    assert.deepEqual(result.envelope.to,['user@example.test']);assert.ok(result.message.includes(Buffer.from('application/pdf')));
    transport.close();
  });
  test('legacy MailMessage.resolveContent respects file and URL prohibition', async () => {
    const base=path.dirname(require.resolve('nodemailer'));
    const imported=require(path.join(base,'mailer/mail-message.js')), MailMessage=imported.default || imported;
    const mail=new MailMessage({options:{disableFileAccess:true,disableUrlAccess:true},_defaults:{}},{});
    const resolve=(data)=>new Promise((res,rej)=>mail.resolveContent(data,'text',(error,value)=>error?rej(error):res(value)));
    await assert.rejects(resolve({text:{path:path.join(root,'synthetic-never-created.txt')}}),/access|disabled|allowed/i);
    await assert.rejects(resolve({text:{href:'http://127.0.0.1:1/synthetic-never-requested'}}),/access|disabled|allowed/i);
  });
  test('Nodemailer address parsers finish bounded adversarial lists and free text',()=>boundedWorker('mail-parser'));
  test('Nodemailer nested recipient arrays no longer overflow the native stack', async () => {
    const transport=require('nodemailer').createTransport({jsonTransport:true});
    let to='user@example.test';for(let i=0;i<5000;i++)to=[to];
    try {const result=await transport.sendMail({from:'gp@example.test',to,text:'synthetic'});assert.deepEqual(result.envelope.to,['user@example.test']);}
    catch(error){assert.notEqual(error.name,'RangeError');assert.match(error.message,/depth|limit|nested|recipient/i);}
    finally{transport.close();}
  });
  test('Nodemailer cached host addresses do not overwrite the per-call TLS identity', async () => {
    const shared=require('nodemailer/lib/shared'), host='cache-fixture.example.test';
    shared.dnsCache.set(host,{expires:Date.now()+60000,value:{addresses:[{address:'127.0.0.1',family:4}],servername:'other.example.test'}});
    try {const value=await new Promise((res,rej)=>shared.resolveHostname({host,servername:'expected.example.test'},(e,v)=>e?rej(e):res(v)));assert.equal(value.servername,'expected.example.test');}
    finally{shared.dnsCache.delete(host);}
  });
  test('Nodemailer normalizes an IDN soft hyphen consistently with Node UTS-46', async () => {
    const transport=require('nodemailer').createTransport({jsonTransport:true});
    try {const result=await transport.sendMail({from:'gp@example.test',to:'user@ex\u00adample.test',text:'synthetic'});
      assert.deepEqual(result.envelope.to,['user@'+require('node:url').domainToASCII('ex\u00adample.test')]);}
    finally{transport.close();}
  });
  test('Nodemailer domain comments do not concatenate a following attacker domain', async () => {
    const transport=require('nodemailer').createTransport({jsonTransport:true});
    try {const result=await transport.sendMail({from:'gp@example.test',to:'user@good-corp.com(x)evil.com',text:'synthetic'});
      assert.deepEqual(result.envelope.to,['user@good-corp.com']);}
    finally{transport.close();}
  });
  test('updated sharp handles harmless AVIF through the real loan-photo path', async () => {
    const sharp=require('sharp'),{prepareLoanPhoto}=require('../../lib/loan-photo');
    const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#337755'}}).avif().toBuffer();
    const photo=await prepareLoanPhoto({buffer:bytes,originalName:'synthetic.avif'});
    assert.equal(photo.mime,'image/jpeg');assert.equal((await sharp(photo.buffer).metadata()).format,'jpeg');
  });
  test('updated sharp SVG backend converts a harmless generated image', async () => {
    const sharp=require('sharp'), bytes=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>')).png().toBuffer();
    assert.equal((await sharp(bytes).metadata()).width,8);
  });
  test('tedious uses upstream fixed formatting without a sprintf-js dependency', () => {
    const driverParent=requireFrom('tedious');
    assert.equal(require('tedious/package.json').version,'20.3.7');
    assert.equal(require('tedious/package.json').dependencies['sprintf-js'],undefined);
    assert.throws(()=>driverParent.resolve('sprintf-js'),{code:'MODULE_NOT_FOUND'});
    assert.doesNotMatch(fs.readFileSync(path.join(root,'pnpm-lock.yaml'),'utf8'),/^\s+sprintf-js@/m);
    const {readMetadata}=require('tedious/lib/metadata-parser');
    assert.throws(()=>readMetadata(Buffer.from([0,0,0,0,0,0,255]),0,{tdsVersion:'7_4'}),/Unrecognised data type 0xFF/);
  });
}

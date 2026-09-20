'use strict';
// Cheap rehearsal of the actual restore service environment; never opens a DB.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{createRequire}=require('node:module');
const candidate=path.dirname(__dirname),root=path.dirname(candidate),work=root+'/work';
async function main(){
 assert.match(root,/^\/var\/lib\/grabenplaner-offsite\/postgresql-recovery\/[a-f0-9-]{36}$/);
 assert.notEqual(process.getuid(),0);assert.equal(fs.realpathSync(root),root);
 assert.equal(fs.statSync(root).uid,process.getuid());
 assert.equal(fs.statSync(work).uid,process.getuid());assert.equal(fs.statSync(work).mode&0o077,0);
 assert.deepEqual(fs.readdirSync(work),[]);
 assert.ok(Object.values(require('node:os').networkInterfaces()).flat().every(a=>a.internal));
 assert.ok(fs.readFileSync(root+'/timeout-observer.jsonl','utf8').includes('observer-ready'));
 for(const dir of [candidate,root+'/source'])assert.throws(()=>fs.accessSync(dir,fs.constants.W_OK));
 const metadata=require('../package.json'),load=createRequire(candidate+'/server.js');
 const installed=require('/opt/grabenplaner/app/package.json');
 assert.deepEqual(metadata.dependencies,installed.dependencies,'Candidate dependencies differ from installed dependencies');
 assert.deepEqual(metadata.engines,installed.engines);
 for(const name of Object.keys(metadata.dependencies))load.resolve(name);
 const sharp=load('sharp');assert.ok(sharp.versions.vips);
 // Resolve static imports transitively without evaluating server.js or its DB startup.
 const pending=['server.js','backup.js','server-tools/linux/recovery/lib/postgresql-recovery-worker.js',
  'server-tools/linux/recovery/lib/postgresql-application-smoke.js','lib/persistence/postgresql/reporting/worker.js'];
 const visited=new Set();
 while(pending.length){
  const file=path.resolve(candidate,pending.pop());if(visited.has(file)||!file.endsWith('.js'))continue;
  visited.add(file);const source=fs.readFileSync(file,'utf8'),local=createRequire(file);
  for(const match of source.matchAll(/\brequire\(['"]([^'"]+)['"]\)/g)){
   const resolved=local.resolve(match[1]);
   if(match[1].startsWith('.')&&resolved.startsWith(candidate+'/'))pending.push(resolved);
  }
 }
 for(const file of ['server.js','server-tools/linux/recovery/lib/postgresql-recovery-worker.js','lib/persistence/postgresql/reporting/worker.js'])
  execFileSync(process.execPath,['--check',candidate+'/'+file],{timeout:15000,stdio:'pipe'});
 const tools={};
 for(const name of ['initdb','pg_ctl','pg_restore','psql']){
  const binary='/usr/lib/postgresql/18/bin/'+name,stat=fs.lstatSync(binary);
  assert.equal(stat.uid,0);assert.equal(stat.mode&0o022,0);assert.ok(stat.isFile());assert.equal(fs.realpathSync(binary),binary);
  tools[name]=execFileSync(binary,['--version'],{encoding:'utf8',timeout:10000}).trim();
 }
 for(const port of [55484,55488])await new Promise((resolve,reject)=>{
  const server=require('node:net').createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(resolve));
 });
 const PDFDocument=load('pdfkit');
 const pdfBytes=await new Promise((resolve,reject)=>{
  const doc=new PDFDocument();let size=0;doc.on('data',b=>{size+=b.length;});doc.on('error',reject);doc.on('end',()=>resolve(size));
  doc.font(candidate+'/lib/pdf-fonts/Roboto-Bold.ttf').text('Recovery environment probe');doc.end();
 });assert.ok(pdfBytes>0);
 const tap=execFileSync(process.execPath,['--test','--test-concurrency=1',candidate+'/test/recovery-timeout-observer.test.js',candidate+'/test/recovery-candidate-proof.test.js'],{encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
 assert.match(tap,/# pass 22\b/);assert.match(tap,/# fail 0\b/);
 fs.writeFileSync(root+'/environment-tests.tap',tap,{flag:'wx',mode:0o600});
 assert.deepEqual(fs.readdirSync(work),[],'Preload or tests polluted restore workspace');
 const result={passed:true,scope:'environment-only-no-database-start',uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),
  privateNetwork:true,sourceAndCandidateReadOnly:true,workspaceEmpty:true,staticModulesResolved:visited.size,
  packageDependenciesResolved:Object.keys(metadata.dependencies).length,postgresqlTools:tools,syntheticPdfBytes:pdfBytes,testsPassed:22,
  nodeVersion:process.version};
 fs.writeFileSync(root+'/environment-preflight.json',JSON.stringify(result)+'\n',{flag:'wx',mode:0o600});
 process.stdout.write(JSON.stringify(result)+'\n');
}
main().catch(error=>{process.stderr.write(JSON.stringify({passed:false,code:error.code||null,name:error.name,message:error.message})+'\n');process.exitCode=1;});

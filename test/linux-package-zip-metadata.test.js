'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),tool=path.join(root,'server-tools/package/normalize-linux-zip-creator.py');
const python=process.platform==='win32'?'python':'python3';
function fixture(t){const parent=fs.realpathSync(os.tmpdir());if(process.platform==='win32')assert.equal(path.parse(parent).root.toUpperCase(),'C:\\');
 const dir=fs.mkdtempSync(path.join(parent,'gp-zip-creator-'));t.after(()=>{assert.equal(path.dirname(fs.realpathSync(dir)),parent);fs.rmSync(dir,{recursive:true,force:true});});return dir;}
function run(code,args=[]){const r=spawnSync(python,['-I','-B','-c',code,...args],{cwd:root,encoding:'utf8',timeout:20000,maxBuffer:1024*1024});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);return r.stdout;}
const create=String.raw`import sys,zipfile,struct
from pathlib import Path
p=Path(sys.argv[1])
with zipfile.ZipFile(p,'w',compression=zipfile.ZIP_DEFLATED)as z:
 z.comment=b'fixture metadata must survive'
 for name,data,mode in [(f'jre/bin/elf{i}',b'\x7fELF\x02\x01'+bytes([i])*64,0o755)for i in range(7)]+[('bin/run.sh',b'#!/bin/sh\nprintf fixture\n',0o755),('data/regular.txt',b'fixed content\n',0o644)]:
  info=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0));info.create_system=0;info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=(0o100000|mode)<<16;info.extra=struct.pack('<HH',0xcafe,3)+b'xyz';z.writestr(info,data)
`;
const imports=String.raw`import importlib.util,sys
spec=importlib.util.spec_from_file_location('actual_zip_creator',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
`;

test('ZIP creator normalization preserves all other bytes/decoded files and is idempotent',t=>{
 const dir=fixture(t),archive=path.join(dir,'fixture.zip');run(create,[archive]);
 run(imports+String.raw`import io,zipfile
from pathlib import Path
p=Path(sys.argv[2]);before=p.read_bytes();layout=m.parse(before);proof=m.normalize_archive(p);after=p.read_bytes()
assert proof['changedCreatorBytes']==9 and proof['payloadAndOtherMetadataUnchanged']is True
assert len(before)==len(after);positions=[r['creatorByte']for r in layout['records']]
assert [i for i,(a,b)in enumerate(zip(before,after))if a!=b]==positions
restored=bytearray(after)
for at in positions:assert before[at]==0 and after[at]==3;restored[at]=0
assert restored==before
with zipfile.ZipFile(io.BytesIO(before))as a,zipfile.ZipFile(io.BytesIO(after))as b:
 assert a.comment==b.comment
 for left,right in zip(a.infolist(),b.infolist()):
  assert left.create_system==0 and right.create_system==3
  assert all(getattr(left,k,None)==getattr(right,k,None)for k in zipfile.ZipInfo.__slots__ if k!='create_system')
  assert a.read(left)==b.read(right)
second=m.normalize_archive(p);assert second['changedCreatorBytes']==0 and p.read_bytes()==after
`,[tool,archive]);
});

test('ZIP creator normalization rejects malformed/unsupported layouts before any write',t=>{
 const dir=fixture(t),archive=path.join(dir,'fixture.zip');run(create,[archive]);
 run(imports+String.raw`from pathlib import Path
p=Path(sys.argv[2]);original=p.read_bytes();layout=m.parse(original);e=layout['eocdOffset'];c=layout['centralOffset']
changes=[(e+4,b'\x01\x00'),(e+10,b'\x01\x00'),(e+12,b'\xff'*4),(e+16,b'\x00'*4),(c,b'NOPE'),(c+5,b'\x09'),(c+42,b'\xff'*4)]
for i,(at,value)in enumerate(changes):
 bad=bytearray(original);bad[at:at+len(value)]=value;q=p.with_name('negative-'+str(i)+'.zip');q.write_bytes(bad)
 try:m.normalize_archive(q)
 except (ValueError,m.struct.error):pass
 else:raise AssertionError('invalid archive accepted')
 assert q.read_bytes()==bad
`,[tool,archive]);
});

test('Linux unzip observes Unix0755/0644 from the normalized archive',{skip:process.platform!=='linux'&&'Actual Linux unzip mode proof'},t=>{
 const dir=fixture(t),archive=path.join(dir,'fixture.zip'),extract=path.join(dir,'extract');run(create,[archive]);run(imports+'m.normalize_archive(sys.argv[2])\n',[tool,archive]);
 run(String.raw`import os,subprocess,sys
os.umask(0o022)
result=subprocess.run(['unzip','-qq',sys.argv[1],'-d',sys.argv[2]],capture_output=True,timeout=10)
assert result.returncode==0,result.stderr
`,[archive,extract]);
 for(let i=0;i<7;i++)assert.equal(fs.statSync(path.join(extract,'jre/bin/elf'+i)).mode&0o777,0o755);
 assert.equal(fs.statSync(path.join(extract,'bin/run.sh')).mode&0o777,0o755);assert.equal(fs.statSync(path.join(extract,'data/regular.txt')).mode&0o777,0o644);
});

test('Windows actual packager ZIP function has Unix creator metadata after the helper',{skip:process.platform!=='win32'&&'Actual Windows .NET ZIP path'},t=>{
 const dir=fixture(t),source=path.join(dir,'source'),archive=path.join(dir,'dotnet.zip');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'run.sh'),'#!/bin/sh\n');fs.writeFileSync(path.join(source,'regular.txt'),'content\n');
 const builder=fs.readFileSync(path.join(root,'server-tools/package/New-GrabenplanerLinuxServerPackage.ps1'),'utf8');
 const begin=builder.indexOf('function Write-DeterministicZip('),end=builder.indexOf('\n$sourceRoot = Resolve-SafeDirectory',begin);assert(begin>=0&&end>begin);
 const script=path.join(dir,'create.ps1');fs.writeFileSync(script,'param($source,$archive)\n$ErrorActionPreference="Stop"\n'+builder.slice(begin,end)+'\nWrite-DeterministicZip -SourceRoot $source -ArchivePath $archive\n');
 const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-File',script,source,archive],{encoding:'utf8',timeout:20000});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
 run(imports+String.raw`import zipfile
with zipfile.ZipFile(sys.argv[2])as z:
 assert {i.create_system for i in z.infolist()}<={0,3};expected=sum(i.create_system==0 for i in z.infolist())
proof=m.normalize_archive(sys.argv[2]);assert proof['changedCreatorBytes']==expected
with zipfile.ZipFile(sys.argv[2])as z:
 assert {i.create_system for i in z.infolist()}=={3};assert (z.getinfo('run.sh').external_attr>>16)&0o777==0o755
`,[tool,archive]);
});

test('packager calls the excluded build-only helper before roundtrip/hash; exact LF rules apply',()=>{
 const builder=fs.readFileSync(path.join(root,'server-tools/package/New-GrabenplanerLinuxServerPackage.ps1'),'utf8');
 const invoke=builder.indexOf('$zipCreatorJson = & $zipCreatorPython');assert(invoke>builder.indexOf('Write-DeterministicZip -SourceRoot $buildRoot'));
 assert(invoke<builder.indexOf('[IO.Compression.ZipFile]::ExtractToDirectory'));assert(invoke<builder.indexOf('$packageSha256 = Get-Sha256File'));
 assert.match(builder,/Join-Path \$PSScriptRoot 'normalize-linux-zip-creator\.py'/);assert.match(builder,/server-tools\/package\//);assert.match(builder,/'scripts'.*'test'/);
 for(const filename of ['server-tools/linux/lib/offsite-upload-hardening-compat.js','server-tools/linux/lib/private-workspace-preflight.py','scripts/security/sast-dispositions.json']){
  const result=spawnSync('git',['check-attr','text','eol','--',filename],{cwd:root,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert(result.stdout.includes(': text: set'));assert(result.stdout.includes(': eol: lf'));
 }
});

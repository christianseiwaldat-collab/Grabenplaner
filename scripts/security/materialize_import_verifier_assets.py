"""Build-only, offline, exact regular payload assembly. Never run by the app."""
from pathlib import Path,PurePosixPath
import argparse,hashlib,json,os,posixpath,re,shutil,stat,tarfile,tempfile
LOCK='scripts/security/import-verifier-assets/known-af-v2-temurin17.0.21_9-jackcess4.0.12-r1/acquisition-lock.json'
MAX_FILE=128*1024*1024
def need(value,code):
 if not value:raise ValueError(code)
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def sha_data(data):return hashlib.sha256(data).hexdigest()
def relative(name):
 need(isinstance(name,str)and 0<len(name)<=240 and all(32<ord(c)<127 for c in name)and'\\'not in name and':'not in name,'BUILD_ASSET_PATH')
 path=PurePosixPath(name);need(not path.is_absolute()and path.as_posix()==name and all(p not in['.','..','']and not p.endswith(('.',' '))for p in path.parts),'BUILD_ASSET_PATH');return path
def root(path):
 path=Path(path).absolute();need(path.is_dir()and not path.is_symlink()and path.resolve()==path,'BUILD_ASSET_ROOT');return path
def inside(base,name):
 p=base.joinpath(*relative(name).parts);need(p.resolve().is_relative_to(base),'BUILD_ASSET_ESCAPE')
 current=p
 while current!=base:
  need(not current.is_symlink(),'BUILD_ASSET_LINK');current=current.parent
 return p
def snapshot(stat):return (stat.st_dev,stat.st_ino,stat.st_size,stat.st_mtime_ns)
def opened(base,name,expected):
 path=inside(base,name);before=path.lstat();need(stat.S_ISREG(before.st_mode)and before.st_nlink==1 and before.st_size==expected['bytes']and before.st_size<MAX_FILE,'BUILD_ASSET_REGULAR_SIZE')
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0));file=os.fdopen(fd,'rb');need(snapshot(os.fstat(file.fileno()))==snapshot(before),'BUILD_ASSET_OPEN_CHANGED')
 return file,before
def consume(file,dest,expected,before):
 remaining=expected['bytes']+1;total=0;digest=hashlib.sha256()
 while remaining:
  chunk=file.read(min(1024*1024,remaining))
  if not chunk:break
  total+=len(chunk);remaining-=len(chunk);digest.update(chunk)
  if dest is not None:dest.write(chunk)
 need(total==expected['bytes']and digest.hexdigest()==expected['sha256']and snapshot(os.fstat(file.fileno()))==snapshot(before),'BUILD_ASSET_HASH_OR_CHANGE')
def read_json(base,name,pin=None):
 path=inside(base,name);before=path.lstat();need(before.st_size<2*1024*1024,'BUILD_ASSET_JSON_LIMIT')
 need(stat.S_ISREG(before.st_mode)and before.st_nlink==1,'BUILD_ASSET_JSON_FILE')
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
 with os.fdopen(fd,'rb')as stream:
  need(snapshot(os.fstat(stream.fileno()))==snapshot(before),'BUILD_ASSET_JSON_CHANGED');data=stream.read(before.st_size+1);need(len(data)==before.st_size and snapshot(os.fstat(stream.fileno()))==snapshot(before),'BUILD_ASSET_JSON_CHANGED')
 if pin:need(sha_data(data)==pin,'BUILD_ASSET_JSON_PIN')
 return json.loads(data),sha_data(data)
def validate_lock(lock):
 need(set(lock)=={'format','schemaVersion','assetId','installPrefix','descriptor','materializationPlan','runtimeIndex','archive','jars','trackedFiles','completeTreeSha256','policy'}and lock['format']=='gp-af-build-acquisition-lock-v2'and lock['schemaVersion']==2,'BUILD_ASSET_LOCK')
 need(lock['assetId']=='known-af-v2-temurin17.0.21_9-jackcess4.0.12-r1'and lock['installPrefix']=='lib/import-verifier-assets/'+lock['assetId'],'BUILD_ASSET_ID')
 need(lock['policy']=={'physicalFileCount':291,'perFileBytesExclusive':MAX_FILE,'totalBytesExclusive':256*1024*1024,'runtimeFetchOrCache':False,'sourceBytesOrApprovals':False},'BUILD_ASSET_POLICY')
 for ref in [lock['descriptor'],lock['materializationPlan'],lock['runtimeIndex']]:need(set(ref)=={'path','sha256'},'BUILD_ASSET_REF');relative(ref['path']);need(re.fullmatch('[0-9a-f]{64}',ref['sha256']),'BUILD_ASSET_SHA')
 need(len(lock['jars'])==4 and len(lock['trackedFiles'])==29,'BUILD_ASSET_CLOSURE')
 for item in [lock['archive'],*lock['jars']]:
  relative(item['cacheObject']);need(item['cacheObject']=='sha256/'+item['sha256']+'.blob'and re.fullmatch('[a-f0-9]{64}',item['sha256'])and type(item['bytes'])is int and 0<item['bytes']<MAX_FILE,'BUILD_ASSET_CACHE_OBJECT')
 need(lock['archive']['sha256']=='9f41bf88c7900c7097444a1bdeb84146ae692bc08842490ab098063c74bf9a8a'and lock['archive']['bytes']==46726088 and lock['archive']['upstreamRoot']=='jdk-17.0.21+9-jre','BUILD_ASSET_ARCHIVE')
 need(lock['descriptor']['sha256']=='5730aa3a7269b2283cbe879cb52123d42a238606cd5840ec3f8108e4ba523d93'and lock['completeTreeSha256']=='1dcc2d6be1936c6d83a0798123e19e9b6452027f567ffdc92313420db939cfe6','BUILD_ASSET_DESCRIPTOR')
def fresh_copy(source_root,source_name,dest,expected):
 dest.parent.mkdir(parents=True,exist_ok=True)
 with opened(source_root,source_name,expected)[0]as source,dest.open('xb')as out:
  before=os.fstat(source.fileno());consume(source,out,expected,before)
 dest.chmod(expected['mode'])
def write_archive(cache,entry,plan,target,files):
 stream,before=opened(cache,entry['cacheObject'],entry)
 with stream:
  consume(stream,None,entry,before);stream.seek(0)
  with tarfile.open(fileobj=stream,mode='r:gz')as tar:
   members=tar.getmembers();need(len(members)==len(plan['entries']),'BUILD_ASSET_TAR_COUNT');seen=set();entries={e['path']:e for e in plan['entries']};links=[]
   for m in members:
    name=m.name.rstrip('/');p=PurePosixPath(name);need(p.parts[0]==entry['upstreamRoot']and p.as_posix()==name and'\\'not in name and':'not in name and all(x not in['.','..','']for x in p.parts),'BUILD_ASSET_TAR_PATH');rel='/'.join(p.parts[1:]);need(rel.casefold()not in seen,'BUILD_ASSET_TAR_DUPLICATE');seen.add(rel.casefold());expected=entries.get(rel);need(expected is not None,'BUILD_ASSET_TAR_EXTRA')
    if m.isdir():need(expected['type']=='directory','BUILD_ASSET_TAR_TYPE');continue
    need(not m.mode&0o7000,'BUILD_ASSET_TAR_MODE')
    if m.issym():
     need(expected['type']=='internal-legal-symlink'and m.linkname==expected['linkText']and expected['resolvedPath']in['legal/java.base/ASSEMBLY_EXCEPTION','legal/java.base/LICENSE','legal/java.base/ADDITIONAL_LICENSE_INFO','legal/java.base/cldr.md']and rel.startswith('legal/')and posixpath.normpath(posixpath.join(posixpath.dirname(rel),m.linkname))==expected['resolvedPath'],'BUILD_ASSET_TAR_LEGAL_LINK');links.append(expected);continue
    need(m.isfile()and not m.islnk()and expected['type']=='regular'and m.size==expected['bytes']and format(m.mode,'04o')==expected['upstreamMode'],'BUILD_ASSET_TAR_REGULAR')
    name='jre/'+rel;ref=files.get(name);need(ref and ref['bytes']==m.size and ref['sha256']==expected['sha256'],'BUILD_ASSET_TAR_DESCRIPTOR');dest=target.joinpath(*relative(name).parts);dest.parent.mkdir(parents=True,exist_ok=True)
    with tar.extractfile(m)as inp,dest.open('xb')as out:
     digest=hashlib.sha256();total=0
     while chunk:=inp.read(1024*1024):total+=len(chunk);need(total<=ref['bytes'],'BUILD_ASSET_TAR_LENGTH');digest.update(chunk);out.write(chunk)
    need(total==ref['bytes']and digest.hexdigest()==ref['sha256'],'BUILD_ASSET_TAR_SHA');dest.chmod(ref['mode'])
   need(set(entries)=={'/'.join(PurePosixPath(m.name.rstrip('/')).parts[1:])for m in members},'BUILD_ASSET_TAR_SET')
   for link in links:
    name='jre/'+link['path'];ref=files.get(name);need(ref is not None,'BUILD_ASSET_LINK_DESCRIPTOR');fresh_copy(target,'jre/'+link['resolvedPath'],target.joinpath(*relative(name).parts),ref)
  need(snapshot(os.fstat(stream.fileno()))==snapshot(before),'BUILD_ASSET_ARCHIVE_CHANGED')
def audit_tree(target,descriptor):
 expected={e['path']:e for e in descriptor['files']};actual=[]
 for path in sorted(target.rglob('*')):
  need(not path.is_symlink(),'BUILD_ASSET_OUTPUT_LINK')
  if path.is_dir():continue
  name=path.relative_to(target).as_posix();need(name in expected or name=='descriptor.json','BUILD_ASSET_OUTPUT_EXTRA')
  if name=='descriptor.json':continue
  ref=expected[name];stream,before=opened(target,name,ref)
  with stream:consume(stream,None,ref,before)
  actual.append(name)
 need(set(actual)==set(expected),'BUILD_ASSET_OUTPUT_MISSING')
 need(sha_data(canonical(descriptor['files']).encode())==descriptor['completeTreeSha256'],'BUILD_ASSET_TREE_SHA')
def materialize(source_root,build_root,cache_root):
 source=root(source_root);build=root(build_root);cache=root(cache_root)
 need(not cache.is_relative_to(source)and not cache.is_relative_to(build)and not build.is_relative_to(source),'BUILD_ASSET_ROOTS_MUST_BE_SEPARATE')
 if os.name=='nt':need(cache.drive.upper()=='C:'and source.drive.upper()=='C:'and build.drive.upper()=='C:','BUILD_ASSET_INTERNAL_C_REQUIRED')
 lock,lock_sha=read_json(source,LOCK);validate_lock(lock);descriptor,_=read_json(source,lock['descriptor']['path'],lock['descriptor']['sha256']);plan,_=read_json(source,lock['materializationPlan']['path'],lock['materializationPlan']['sha256'])
 need(descriptor['assetId']==lock['assetId']and descriptor['completeTreeSha256']==lock['completeTreeSha256']and len(descriptor['files'])==291,'BUILD_ASSET_DESCRIPTOR_BINDING')
 need(plan['archiveSha256']==lock['archive']['sha256']and plan['upstreamRoot']==lock['archive']['upstreamRoot'],'BUILD_ASSET_PLAN_BINDING')
 index,_=read_json(source,lock['runtimeIndex']['path'],lock['runtimeIndex']['sha256']);read_json(build,lock['runtimeIndex']['path'],lock['runtimeIndex']['sha256'])
 need(index['currentAsset']==lock['assetId']and index['assets'][0]['sha256']==lock['descriptor']['sha256'],'BUILD_ASSET_INDEX_BINDING')
 files={e['path']:e for e in descriptor['files']};need(len(files)==291 and sum(e['bytes']for e in files.values())<256*1024*1024,'BUILD_ASSET_COUNT_OR_SIZE')
 target=build.joinpath(*relative(lock['installPrefix']).parts);need(not target.exists()and not target.is_symlink(),'BUILD_ASSET_TARGET_MUST_BE_NEW')
 base=build/'lib/import-verifier-assets';need(not base.exists()or base.is_dir()and not base.is_symlink()and not any(base.iterdir()),'BUILD_ASSET_BASE_NOT_EMPTY')
 temp=Path(tempfile.mkdtemp(prefix='.gp-af-build-',dir=build.parent)).absolute()
 try:
  write_archive(cache,lock['archive'],plan,temp,files)
  for jar in lock['jars']:
   ref=files.get(jar['path']);need(ref and ref['bytes']==jar['bytes']and ref['sha256']==jar['sha256'],'BUILD_ASSET_JAR_DESCRIPTOR');fresh_copy(cache,jar['cacheObject'],temp.joinpath(*relative(jar['path']).parts),ref)
  for item in lock['trackedFiles']:
   ref=files.get(item['path']);need(ref and all(ref[k]==item[k]for k in ['bytes','sha256','mode'])and item['source'].startswith(LOCK.rsplit('/',1)[0]+'/payload/'),'BUILD_ASSET_METADATA_DESCRIPTOR');fresh_copy(source,item['source'],temp.joinpath(*relative(item['path']).parts),ref)
  data=inside(source,lock['descriptor']['path']).read_bytes();need(sha_data(data)==lock['descriptor']['sha256'],'BUILD_ASSET_DESCRIPTOR_CHANGED');(temp/'descriptor.json').write_bytes(data);(temp/'descriptor.json').chmod(0o644)
  need(sha_data((temp/'descriptor.json').read_bytes())==lock['descriptor']['sha256'],'BUILD_ASSET_OUTPUT_DESCRIPTOR');audit_tree(temp,descriptor);need(read_json(source,LOCK)[1]==lock_sha,'BUILD_ASSET_LOCK_CHANGED')
  target.parent.mkdir(parents=True,exist_ok=True);temp.rename(target)
  return {'format':'gp-af-build-materialization-v2','assetId':lock['assetId'],'descriptorSha256':lock['descriptor']['sha256'],'completeTreeSha256':lock['completeTreeSha256'],'payloadFiles':291,'payloadBytes':sum(e['bytes']for e in descriptor['files']),'materialized':True,'runtimeDownloadOrCache':False,'sourceBytesOrApprovals':False,'releasePackageBuilt':False}
 finally:
  if temp.exists():need(temp.resolve().parent==build.parent.resolve()and temp.name.startswith('.gp-af-build-'),'BUILD_ASSET_CLEANUP_BOUNDARY');shutil.rmtree(temp)
def verify_cache(source_root,cache_root):
 source=root(source_root);cache=root(cache_root);need(not cache.is_relative_to(source),'BUILD_CACHE_OUTSIDE_SOURCE_REQUIRED')
 if os.name=='nt':need(cache.drive.upper()=='C:','BUILD_ASSET_INTERNAL_C_REQUIRED')
 lock,_=read_json(source,LOCK);validate_lock(lock);read_json(source,lock['descriptor']['path'],lock['descriptor']['sha256']);read_json(source,lock['materializationPlan']['path'],lock['materializationPlan']['sha256'])
 for item in [lock['archive'],*lock['jars']]:
  stream,before=opened(cache,item['cacheObject'],item)
  with stream:consume(stream,None,item,before)
 return {'format':'gp-af-build-cache-verification-v3','verified':True,'objects':5,'networkUsed':False,'sourceRootWritten':False}
def main():
 p=argparse.ArgumentParser();p.add_argument('--source-root',required=True);p.add_argument('--build-root');p.add_argument('--cache-root',required=True);p.add_argument('--verify-cache',action='store_true');args=p.parse_args()
 need(args.verify_cache and args.build_root is None or not args.verify_cache and args.build_root is not None,'BUILD_ASSET_ARGUMENTS')
 result=verify_cache(args.source_root,args.cache_root)if args.verify_cache else materialize(args.source_root,args.build_root,args.cache_root);print(json.dumps(result))
if __name__=='__main__':
 try:main()
 except Exception as error:print(json.dumps({'passed':False,'code':str(error)if isinstance(error,ValueError)else'BUILD_ASSET_IO_FAILED'}));raise SystemExit(1)

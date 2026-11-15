"""Normal explicit package route. No download, upload, deploy or service action."""
from pathlib import Path,PurePosixPath
import argparse,datetime,hashlib,json,re,shutil,subprocess,sys,zipfile
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def preflight_is_fresh(at_utc,now=None):
 try:
  at=datetime.datetime.fromisoformat(at_utc)
  if at.tzinfo is None or at.utcoffset()is None:return False
  now=now or datetime.datetime.now(datetime.timezone.utc)
  if now.tzinfo is None or now.utcoffset()is None:return False
  age=now.astimezone(datetime.timezone.utc)-at.astimezone(datetime.timezone.utc)
  return datetime.timedelta(0)<=age<datetime.timedelta(minutes=15)
 except (TypeError,ValueError):return False
def package_command(source,target,evidence,digest,cache_root,pwsh):
 command=[pwsh,'-NoProfile','-File',str(source/'server-tools/package/New-GrabenplanerLinuxServerPackage.ps1'),'-SourceDirectory',str(source),'-OutputDirectory',str(target),'-SastContextEvidence',str(evidence),'-SastContextEvidenceSha256',digest]
 if cache_root is not None:command+=['-VerifierAssetsCacheRoot',str(cache_root)]
 return command
def verify_asset_cache(source,cache_root,run=subprocess.run):
 declared=(source/'lib/import-verifier-runtime-assets.json').is_file()
 if not declared:
  if cache_root is not None:raise ValueError('VERIFIER_CACHE_WITHOUT_DECLARATION')
  return {'required':False}
 if cache_root is None:raise ValueError('VERIFIER_ASSET_CACHE_REQUIRED')
 cache=Path(cache_root).resolve(strict=True)
 if cache.is_relative_to(source):raise ValueError('VERIFIER_CACHE_MUST_BE_OUTSIDE_CHECKOUT')
 result=run([sys.executable,'-I','-B',str(source/'scripts/security/materialize_import_verifier_assets.py'),'--source-root',str(source),'--cache-root',str(cache),'--verify-cache'],cwd=source,capture_output=True,check=True,timeout=60)
 proof=json.loads(result.stdout)
 if proof.get('verified')is not True or proof.get('networkUsed')is not False or proof.get('objects')!=5:raise ValueError('VERIFIER_CACHE_NOT_VERIFIED')
 return {'required':True,'cacheRoot':str(cache),'verifiedObjects':5,'networkUsed':False}
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--source-root',required=True);parser.add_argument('--output-root',required=True);parser.add_argument('--head',required=True);parser.add_argument('--pin',required=True);parser.add_argument('--app-proof',required=True);parser.add_argument('--preflight',required=True);parser.add_argument('--verifier-assets-cache-root');a=parser.parse_args()
 source=Path(a.source_root).resolve(strict=True);out=Path(a.output_root).resolve();head=a.head
 assert re.fullmatch('[0-9a-f]{40}',head)
 pin_path=Path(a.pin).resolve(strict=True);pin=json.loads(pin_path.read_text(encoding='utf-8'))
 assert pin['sourceHead']==head and pin['workflowConclusion']=='success'and pin['pinReadyForNormalPackageBuilder']and pin['all4SecurityGatesCompleteAndPassed']and pin['all5SecurityJobsSucceeded']and pin['freshFinalRunAttemptJobArtifactReadbackVerified']
 evidence=Path(pin['sastContextEvidencePath']).resolve(strict=True);digest=sha(evidence);assert pin['sastContextEvidenceSha256']==digest
 context=json.loads(evidence.read_text(encoding='utf-8'));assert context['sourceCommit']==head and context['ci']=={'repository':'christianseiwaldat-collab/Grabenplaner','workflow':'.github/workflows/security.yml','runId':str(pin['runId']),'attempt':str(pin['attempt'])}
 assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=source).decode().strip()==head and subprocess.check_output(['git','status','--porcelain','--untracked-files=all'],cwd=source)==b''
 subprocess.run(['git','diff','--check'],cwd=source,check=True)
 preflight=json.loads(Path(a.preflight).read_text(encoding='utf-8'));assert preflight['readOnly']and preflight['preflight']['exitCode']==0 and not preflight['maintenanceLocks'];assert preflight_is_fresh(preflight['atUtc'])
 app=json.loads(Path(a.app_proof).read_text(encoding='utf-8'));assert app['sourceCommit']==head and app['allSixJobsPassed']
 cache_root=Path(a.verifier_assets_cache_root).resolve(strict=True)if a.verifier_assets_cache_root else None
 cache=verify_asset_cache(source,cache_root);assert shutil.disk_usage(out if out.exists()else out.parent).free>10*1024**3
 target=out/('package-'+head[:8]);target.mkdir(parents=True,exist_ok=False)
 receipt={'sourceCommit':head,'sastContextSha256':digest,'sastPinReceipt':str(pin_path),'verifierBuildCache':cache,'packageBuilt':False,'productionMutation':False,'deployed':False};receipt_path=target/'package-build-receipt.json'
 def save():receipt_path.write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
 save();command=package_command(source,target,evidence,digest,cache_root,shutil.which('pwsh'))
 with(target/'builder.stdout.log').open('wb')as stdout,(target/'builder.stderr.log').open('wb')as stderr:result=subprocess.run(command,cwd=source,stdout=stdout,stderr=stderr,timeout=2700,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
 receipt['builderExitCode']=result.returncode;save();assert result.returncode==0,'Normal builder failed; retained logs'
 archives=list(target.glob('*.zip'));assert len(archives)==1;archive=archives[0];digest=sha(archive);sidecars=list(target.glob('*.sha256'));assert len(sidecars)==1 and sidecars[0].read_text(encoding='ascii').split()[0]==digest
 # Retain the existing normal release's independent extraction, exact manifest,
 # protected-source byte comparisons and full verifier. No gate is delegated to
 # the builder's earlier roundtrip alone.
 unpack=target/'independent-verification';unpack.mkdir()
 with zipfile.ZipFile(archive)as z:
  names=z.namelist();assert len(names)==len(set(names))==len({n.casefold()for n in names})and sum(e.file_size for e in z.infolist())<2*1024**3
  for item in z.infolist():
   rel=PurePosixPath(item.filename);assert not rel.is_absolute()and rel.as_posix()==item.filename and'..'not in rel.parts and'\\'not in item.filename and':'not in item.filename and ((item.external_attr>>16)&0o170000)!=0o120000 and item.file_size<128*1024*1024
   destination=unpack.joinpath(*rel.parts);destination.parent.mkdir(parents=True,exist_ok=True)
   with z.open(item)as inp,destination.open('xb')as output:shutil.copyfileobj(inp,output,1024*1024)
  raw=(unpack/'grabenplaner-server-manifest.json').read_bytes();manifest=json.loads(raw);assert manifest['sourceCommit']==head and manifest['appVersion']==json.loads((source/'package.json').read_text(encoding='utf-8'))['version']and manifest['dependenciesMode']=='source-install';assert set(names)=={e['path']for e in manifest['files']}|{'grabenplaner-server-manifest.json'}
  for e in manifest['files']:data=(unpack/e['path']).read_bytes();assert len(data)==e['bytes']and hashlib.sha256(data).hexdigest()==e['sha256']
  if cache['required']:
   descriptor=json.loads((unpack/'lib/import-verifier-assets/known-af-v2-temurin17.0.21_9-jackcess4.0.12-r1/descriptor.json').read_text(encoding='utf-8'))
   for executable in descriptor['executableAllowlist']:assert ((z.getinfo(descriptor['installPrefix']+'/'+executable['path']).external_attr>>16)&0o777)==0o755
 for required in ['server-tools/linux/refresh-grabenplaner-offsite-upload.sh','server-tools/linux/update-grabenplaner-server.sh','server-tools/linux/lib/offsite-upload-hardening-compat.js','server-tools/linux/lib/private-workspace-preflight.py']:
  assert required in names and (unpack/required).read_bytes()==subprocess.check_output(['git','show',head+':'+required],cwd=source)
 verifier_script=source/'server-tools/linux/lib/verify-package.js'
 check=subprocess.run(['node',str(verifier_script),str(unpack)],cwd=source,capture_output=True,timeout=180);(target/'independent-verifier.stdout.json').write_bytes(check.stdout);(target/'independent-verifier.stderr.log').write_bytes(check.stderr);assert check.returncode==0
 verifier=json.loads(check.stdout);assert verifier['ok']and verifier['appVersion']==manifest['appVersion']
 contract=subprocess.run(['node',str(verifier_script),'--runtime-contract',str(source)],cwd=source,capture_output=True,check=True,timeout=180);declared=json.loads(contract.stdout)
 assert verifier['runtimeContract']['deploymentSchemaVersion']==declared['deploymentSchemaVersion']and verifier['offsiteModule']==declared['offsiteModule']and verifier['hardeningModule']==declared['hardeningModule']
 hardening=json.loads((unpack/'server-tools/linux/hardening/module-schema.json').read_bytes());assert all(name in names for name in hardening['managedArtifacts'])
 assert subprocess.check_output(['git','status','--porcelain','--untracked-files=all'],cwd=source)==b''
 receipt.update(packageBuilt=True,archive=str(archive),archiveSha256=digest,archiveBytes=archive.stat().st_size,manifestSha256=hashlib.sha256(raw).hexdigest(),manifestFileCount=len(manifest['files']),sourceWorkingTreeClean=True,independentZipAndManifestVerification=True,independentFullVerifier=verifier,completeHardeningArtifactListVerified=True);save();print(json.dumps(receipt))
if __name__=='__main__':main()

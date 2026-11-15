"""Descriptor-bound supplemental inventory. Does not replace npm or native checks."""
from pathlib import Path
import hashlib,json,os,re
EXPECTED={('com.healthmarketscience.jackcess:jackcess','4.0.12'),('org.apache.commons:commons-lang3','3.18.0'),('commons-logging:commons-logging','1.2'),('com.google.code.gson:gson','2.13.2')}
def load_runtime_assets(root,command,declared_source=False):
 root=Path(root);module=root/'lib/import-verifier-runtime-assets.js'
 if not module.exists():
  if any(os.path.lexists(root/x)for x in ['lib/import-verifier-runtime-assets.json','lib/import-verifier-assets']):raise ValueError('Runtime asset verifier missing')
  return None
 run=command(['node','--no-global-search-paths',module,'--source-declaration'if declared_source else'--inventory',root],'runtime-asset-inventory')
 inventory=json.loads(run.stdout)
 if inventory is None:return None
 if declared_source and (inventory.get('status')!='declared_source_only'or inventory.get('observation',{}).get('payloadBytesVerified')is not False):raise ValueError('Runtime source-only scope mislabeled')
 ref=inventory.get('sbom',{});name=ref.get('path')
 if not isinstance(name,str)or not re.fullmatch((r'scripts/security/import-verifier-assets/[a-z0-9._-]+/payload/runtime-components\.cdx\.json'if declared_source else r'lib/import-verifier-assets/[a-z0-9._-]+/runtime-components\.cdx\.json'),name):raise ValueError('Unbound runtime SBOM')
 target=root/name;data=target.read_bytes()
 if target.is_symlink()or len(data)!=ref.get('bytes')or hashlib.sha256(data).hexdigest()!=ref.get('sha256'):raise ValueError('Runtime SBOM changed')
 bom=json.loads(data)
 if bom.get('bomFormat')!='CycloneDX'or bom.get('specVersion')!='1.6'or len(bom.get('components',[]))!=6:raise ValueError('Incomplete runtime SBOM')
 maven={(x.get('group','')+':'+x.get('name',''),x.get('version'))for x in bom['components']if x.get('purl','').startswith('pkg:maven/')}
 if maven!=EXPECTED:raise ValueError('Runtime Maven SBOM coverage mismatch')
 if not any(x.get('name')=='Temurin JRE'and x.get('version')=='17.0.21+9'for x in bom['components'])or not any(x.get('name')=='KnownAfCountVerifier'for x in bom['components']):raise ValueError('Runtime/helper SBOM identity missing')
 inventory['componentSbom']=bom
 inventory['coverageLimits']=['Native JVM/internal library CVEs are not cleared by OSV generic purl recognition.','Java helper source is outside the existing JS-only SAST profile and requires explicit review/qualification.','Full npm SCA, source/installed inventory, secrets and full-path recovery gates remain mandatory.']
 return inventory
def check_runtime_sca_result(result,runtime):
 packages=[p for group in result.get('results',[])for p in group.get('packages',[])]
 maven=[p for p in packages if p.get('package',{}).get('ecosystem')=='Maven']
 if len(maven)!=4 or {(p['package'].get('name'),p['package'].get('version'))for p in maven}!=EXPECTED:raise ValueError('OSV runtime Maven coverage incomplete')
 return [{'ecosystem':p['package'].get('ecosystem'),'advisory':v['id'],'package':p['package']['name'],'version':p['package']['version']}for p in packages for v in p.get('vulnerabilities',[])]
def merge_runtime_sbom(npm,runtime):
 if npm.get('bomFormat')!='CycloneDX'or not isinstance(npm.get('components'),list)or runtime.get('bomFormat')!='CycloneDX':raise ValueError('Malformed supplemental SBOM')
 # Retain every original npm component/dependency without rewriting identities.
 result=json.loads(json.dumps(npm));old_refs={x.get('bom-ref')for x in npm['components']};new_refs=[x.get('bom-ref')for x in runtime['components']]
 if None in new_refs or len(set(new_refs))!=len(new_refs)or old_refs.intersection(new_refs):raise ValueError('Runtime SBOM reference collision')
 result['components'].extend(runtime['components'])
 result.setdefault('dependencies',[]).extend(runtime.get('dependencies',[]))
 result.setdefault('properties',[]).append({'name':'gp:runtime-coverage','value':'Release-owned Temurin/four-Maven/helper payload; does not assert full native CVE clearance or executed Linux verification.'})
 return result

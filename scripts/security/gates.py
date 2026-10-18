"""Fail-closed local/CI scanner entrypoints. 0=pass, 1=findings, 2=incomplete/tool error."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import time
from sast_profile import source_partition, deployment_guard, build_rule_profiles, PROFILE_TIMEOUTS
from sast_dispositions import canonical_rule_id, finding_identity, apply_dispositions, scanner_position

HERE = Path(__file__).resolve().parent


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf8')


def validate_exceptions(policy, today=None):
    today = today or dt.date.today()
    if policy.get('schemaVersion') != 1 or policy.get('advisoryExceptions') != []:
        raise ValueError('No advisory exceptions are approved')
    seen=set()
    for item in policy.get('findingExceptions', []):
        if set(item) != {'scanner','fingerprint','sourceSha256','owner','reason','reviewedOn','expiresOn','priority'}:
            raise ValueError('Exception requires an exact reviewed fingerprint, source hash and expiry')
        if item['scanner'] not in ('sast','secrets') or not re.fullmatch(r'[a-f0-9]{64}',item['fingerprint']) or not re.fullmatch(r'[a-f0-9]{64}',item['sourceSha256']):
            raise ValueError('Broad or malformed exception')
        expiry=dt.date.fromisoformat(item['expiresOn'])
        reviewed=dt.date.fromisoformat(item['reviewedOn'])
        limit=14 if item['priority'] in ('P0','P1') else 30 if item['priority'] in ('P2','P3') else 0
        if not limit or reviewed > today or expiry < today or expiry < reviewed or expiry > reviewed+dt.timedelta(days=limit) or len(item['reason'])<20 or not item['owner'].strip():
            raise ValueError('Expired, unbounded or undocumented exception')
        key=(item['scanner'],item['fingerprint'],item['sourceSha256'])
        if key in seen:raise ValueError('Duplicate exception')
        seen.add(key)
    return policy['findingExceptions']


def remaining_findings(scanner, findings, exceptions):
    return [finding for finding in findings if not any(
        e['scanner']==scanner and e['fingerprint']==finding['fingerprint']
        and e['sourceSha256']==finding['sourceSha256'] for e in exceptions)]


def secret_finding(item, mode, stage, root):
    if item.get('Secret') not in ('REDACTED',''):
        raise ValueError('Unredacted secret scanner report')
    commit=item.get('Commit','')
    if mode=='dir':
        path=Path(item['File']).resolve()
        relative=path.relative_to(stage.resolve()).as_posix()
        if path.is_symlink() or not path.is_file():raise ValueError('Unsafe secret target')
        content=path.read_bytes()
        if commit:raise ValueError('Unexpected directory finding commit')
    elif mode=='git':
        relative=PurePosixPath(item['File']).as_posix()
        if not re.fullmatch(r'[a-f0-9]{40}',commit):raise ValueError('Invalid history commit')
        if PurePosixPath(relative).is_absolute() or '..' in PurePosixPath(relative).parts:
            raise ValueError('Unsafe history target')
        content=subprocess.run(['git','show',commit+':'+relative],cwd=root,check=True,capture_output=True).stdout
    else:raise ValueError('Invalid secret scan mode')
    # Exact location + mode + immutable historical commit; independent of the
    # machine-specific stage prefix. Every exception also binds actual bytes.
    identity=[mode,item['RuleID'],relative,item['StartLine'],item['EndLine'],commit]
    fingerprint=hashlib.sha256(json.dumps(identity,separators=(',',':')).encode()).hexdigest()
    return {'mode':mode,'rule':item['RuleID'],'path':relative,'line':item['StartLine'],
            'endLine':item['EndLine'],'commit':commit,'fingerprint':fingerprint,
            'sourceSha256':hashlib.sha256(content).hexdigest()}


def source_files(root):
    result=subprocess.run(['git','ls-files','-z','--cached','--others','--exclude-standard'],cwd=root,check=True,capture_output=True)
    entries=[]
    for name in sorted(set(result.stdout.decode('utf8').split('\0'))- {''}):
        relative=PurePosixPath(name);path=root/relative
        if not path.exists():continue
        if relative.is_absolute() or '..' in relative.parts or path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):
            raise ValueError('Unsafe source inventory entry')
        entries.append({'path':name,'bytes':path.stat().st_size,'sha256':sha(path)})
    if not entries:raise ValueError('Empty source inventory')
    return entries


def stage_sources(root, destination, entries):
    if destination.exists():raise ValueError('Scanner staging directory must be new')
    destination.mkdir(parents=True)
    for e in entries:
        target=destination/e['path'];target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(root/e['path'],target)
        if sha(target)!=e['sha256']:raise ValueError('Source changed while staging')


def check_sast_result(result, expected, stage):
    if result.get('errors'):raise ValueError('SAST parser, rule, memory or timeout errors: incomplete analysis')
    scanned={Path(p).resolve().relative_to(stage.resolve()).as_posix() for p in result.get('paths',{}).get('scanned',[])}
    missing=sorted(set(expected)-scanned)
    if not expected or set(expected)!=scanned:
        raise ValueError('Incomplete SAST target coverage: '+', '.join(missing[:10]))
    if result.get('paths',{}).get('skipped'):raise ValueError('Unexpected SAST skips')
    if result.get('skipped_rules'):raise ValueError('Unexpected SAST rule skips')
    return len(scanned)


def lock_packages(path):
    text=Path(path).read_text();body=text.split('\npackages:\n',1)
    if len(body)!=2:raise ValueError('Unsupported/empty pnpm lockfile')
    packages=set()
    for line in body[1].split('\nsnapshots:\n',1)[0].splitlines():
        if not re.match(r'^  \S.*:$',line):continue
        key=line[2:-1].strip("'\"");match=re.fullmatch(r'(@?[^@]+)@([^()]+)',key)
        if not match:raise ValueError('Unrecognized pnpm package key')
        packages.add(match.groups())
    if not packages:raise ValueError('Empty lockfile package inventory')
    return packages


def check_sca_result(result, expected):
    packages=[p for group in result.get('results',[]) for p in group.get('packages',[])]
    actual={(p['package']['name'],p['package']['version']) for p in packages if p['package'].get('ecosystem')=='npm'}
    if actual!=expected:raise ValueError('OSV did not report every package/version from the lockfile')
    return [dict(advisory=v['id'],package=p['package']['name'],version=p['package']['version']) for p in packages for v in p.get('vulnerabilities',[])]


def registry_vulnerability_count(audit):
    counts=audit.get('metadata',{}).get('vulnerabilities')
    keys={'info','low','moderate','high','critical'}
    if audit.get('error') or not isinstance(counts,dict) or set(counts)!=keys:
        raise ValueError('Incomplete npm registry audit')
    if any(type(value) is not int or value<0 for value in counts.values()):
        raise ValueError('Invalid npm registry vulnerability counts')
    return sum(counts.values())


class Gate:
    def __init__(self, args):
        self.args=args;self.root=Path(args.root).resolve();self.output=Path(args.output).resolve();self.output.mkdir(parents=True,exist_ok=True)
        self.tools=Path(args.tools).resolve();self.config=read(HERE/'tools.json');self.exceptions=validate_exceptions(read(HERE/'exceptions.json'));self.commands=[]

    def command(self,args,label,acceptable=(0,),cwd=None,timeout=1800):
        env={**os.environ,'SEMGREP_SEND_METRICS':'off','SEMGREP_ENABLE_VERSION_CHECK':'0','PYTHONUTF8':'1','SYFT_CHECK_FOR_APP_UPDATE':'false'}
        for key in ('SEMGREP_APP_TOKEN','GITLEAKS_CONFIG','GITLEAKS_CONFIG_TOML'):env.pop(key,None)
        result=subprocess.run([str(a) for a in args],cwd=cwd or self.root,env=env,capture_output=True,timeout=timeout)
        # All secret-scanner calls are redacted before output reaches this process.
        (self.output/(label+'.stdout')).write_bytes(result.stdout);(self.output/(label+'.stderr')).write_bytes(result.stderr)
        self.commands.append({'label':label,'argv':[str(a) for a in args],'exitCode':result.returncode})
        if result.returncode not in acceptable:raise ValueError(label+' failed with exit '+str(result.returncode))
        return result

    def tool(self,name):
        executable=self.tools/(name+('.exe' if sys.platform=='win32' else ''));receipt=read(self.tools/(name+'-receipt.json'))
        platform='windows' if sys.platform=='win32' else 'linux';asset=self.config['tools'][name]['assets'][platform]
        if receipt['asset']!=asset or receipt['version']!=self.config['tools'][name]['version'] or sha(executable)!=receipt['executableSha256']:
            raise ValueError('Scanner executable provenance mismatch')
        return executable

    def sast(self):
        started=time.monotonic()
        inventory=source_files(self.root)
        entries=[e for e in inventory if PurePosixPath(e['path']).suffix in ('.js','.cjs','.mjs','.ts','.jsx','.tsx')
                 and PurePosixPath(e['path']).parts[0] not in ('test','tests','test-support') and not e['path'].startswith('public/vendor/')]
        deployment_guard(inventory,self.root)
        partitions=source_partition(self.root,entries)
        expected={e['path']:e for e in entries}
        write(self.output/'sast-targets.json',entries)
        manifest=read(self.tools/'rules-manifest.json')
        if manifest['commit']!=self.config['rules']['commit'] or manifest['archiveSha256']!=self.config['rules']['sha256']:raise ValueError('Unpinned rule bundle')
        profiles=build_rule_profiles(self.tools,self.output/'sast-profiles',manifest)
        profiles['targets']={name:items for name,items in partitions.items()}
        profiles['perRuleTimeoutSeconds']=PROFILE_TIMEOUTS
        profiles['combinedWallClockSeconds']=2400
        write(self.output/'sast-profile-manifest.json',profiles)
        version=self.command([self.args.semgrep,'--version'],'semgrep-version').stdout.decode().strip()
        if version!=self.config['semgrep']['version']:raise ValueError('Unpinned Semgrep version')
        findings=[];runs=[];incomplete=[]
        for name,targets in partitions.items():
            stage=self.output/('sast-'+name+'-source');stage_sources(self.root,stage,targets)
            result_path=self.output/('sast-'+name+'.json')
            remaining=2400-(time.monotonic()-started)
            if remaining<=0:raise ValueError('Combined SAST wall-clock budget exhausted')
            run=self.command([self.args.semgrep,'scan','--config',self.output/'sast-profiles'/name/'rules','--json','--output',result_path,'--metrics','off','--disable-version-check','--disable-nosem','--no-git-ignore','--max-target-bytes','0','--timeout',str(PROFILE_TIMEOUTS[name]),'--timeout-threshold','0','--max-memory','4096','--jobs','1','--strict','--error',stage], 'semgrep-'+name,(0,1,2,3),timeout=remaining)
            result=read(result_path);target_map={e['path']:e for e in targets}
            try:
                count=check_sast_result(result,target_map,stage)
                complete=True
            except ValueError:
                count=len(result.get('paths',{}).get('scanned',[]));complete=False;incomplete.append(name)
            run_findings=[]
            for item in result.get('results',[]):
                relative=Path(item['path']).resolve().relative_to(stage).as_posix()
                rule=canonical_rule_id(item['check_id'],profiles['canonicalRuleIds'])
                start=scanner_position(item['start']);end=scanner_position(item['end'])
                legacy=hashlib.sha256(json.dumps([rule,relative,start['line'],end['line']],separators=(',',':')).encode()).hexdigest()
                run_findings.append({'rule':rule,'path':relative,'line':start['line'],'start':start,'end':end,'severity':item['extra']['severity'],'fingerprint':finding_identity(rule,relative,start,end),'legacyFingerprint':legacy,'sourceSha256':target_map[relative]['sha256']})
            if complete and ((run.returncode==1)!=bool(run_findings) or run.returncode not in (0,1)):
                raise ValueError('Inconsistent SAST exit/result')
            runs.append({'profile':name,'targetedFiles':len(targets),'reportedScannedFiles':count,'complete':complete,'scannerExitCode':run.returncode,'findings':len(run_findings),'analysisErrors':len(result.get('errors',[]))})
            findings.extend(run_findings)
        disposition={'reviewedFalsePositives':[],'blockingFindings':findings}
        # Review decisions cannot turn an incomplete analysis into a pass.
        if not incomplete:
            disposition=apply_dispositions(read(HERE/'sast-dispositions.json'),findings,self.root)
        details={'scannedFiles':len(entries),'serverBytes':expected['server.js']['bytes'],'rulesCommit':manifest['commit'],'profileVersion':profiles['profileVersion'],'profiles':runs,'elapsedSeconds':time.monotonic()-started,'findings':findings,**disposition}
        write(self.output/'sast-assessment.json',{'complete':not incomplete,**details})
        if incomplete:raise ValueError('Incomplete SAST profiles: '+', '.join(incomplete))
        return details

    def sca(self):
        self.command(['node',HERE/'verify-patch.cjs'],'patch-verification')
        expected=lock_packages(self.root/'pnpm-lock.yaml');path=self.output/'sca-osv.json'
        run=self.command([self.tool('osv-scanner'),'scan','source','--lockfile',self.root/'pnpm-lock.yaml','--all-packages','--all-vulns','--no-call-analysis','all','--format','json','--output-file',path],'osv',(0,1))
        findings=check_sca_result(read(path),expected)
        if (run.returncode==1)!=bool(findings):raise ValueError('Inconsistent OSV exit/result')
        pnpm_command=[self.args.pnpm] if not self.args.pnpm.endswith('.cjs') else ['node',self.args.pnpm]
        version=self.command([*pnpm_command,'--version'],'pnpm-version').stdout.decode().strip()
        if version!='11.7.0':raise ValueError('Unpinned pnpm audit version')
        pnpm=self.command([*pnpm_command,'audit','--json'],'pnpm-audit',(0,1))
        audit=json.loads(pnpm.stdout)
        count=registry_vulnerability_count(audit)
        if (pnpm.returncode==1)!=bool(count):raise ValueError('Inconsistent pnpm audit exit/result')
        return {'scannedPackages':len(expected),'scope':'All lockfile packages including optional packages for other operating systems; OSV + npm registry metadata. No reachability claim.','findings':findings,'registryVulnerabilities':audit['metadata']['vulnerabilities'],'blockingFindings':findings+([{'registryVulnerabilityCount':count}] if count else [])}

    def secrets(self):
        entries=source_files(self.root);stage=self.output/'secrets-source';stage_sources(self.root,stage,entries);write(self.output/'secrets-targets.json',entries)
        ignore=self.output/'empty.gitleaksignore';ignore.write_text('')
        all_findings=[]
        shallow=self.command(['git','rev-parse','--is-shallow-repository'],'git-shallow').stdout.decode().strip()
        if shallow!='false':raise ValueError('Secrets history requires a complete checkout')
        for mode,target in [('dir',stage),('git',self.root)]:
            result_path=self.output/('secrets-'+mode+'.json')
            args=[self.tool('gitleaks'),mode,target,'--config',HERE/'gitleaks.toml','--gitleaks-ignore-path',ignore,'--ignore-gitleaks-allow','--redact=100','--no-banner','--no-color','--max-target-megabytes','0','--report-format','json','--report-path',result_path]
            if mode=='git':args+=['--log-opts=--all --full-history --no-renames']
            run=self.command(args,'gitleaks-'+mode,(0,1),timeout=3600);items=read(result_path)
            if not isinstance(items,list) or (run.returncode==1)!=bool(items):raise ValueError('Incomplete secrets scan result')
            for item in items:
                all_findings.append(secret_finding(item,mode,stage,self.root))
        return {'scannedWorktreeFiles':len(entries),'history':'All locally fetched refs, complete Git checkout; source working tree also scanned. No test/docs/history path allowlist.','findings':all_findings,'blockingFindings':remaining_findings('secrets',all_findings,self.exceptions)}

    def sbom(self):
        path=self.output/'sbom.cdx.json'
        # Catalog the exact source dependency manifests, not arbitrary ignored
        # data, backups, credentials or stale node_modules/store contents.
        # The separate inventory below verifies the active runner installation.
        stage=self.output/'sbom-source';stage.mkdir()
        manifest_entries=[]
        for name in ('package.json','pnpm-lock.yaml','pnpm-workspace.yaml'):
            shutil.copyfile(self.root/name,stage/name)
            manifest_entries.append({'path':name,'sha256':sha(stage/name)})
        write(self.output/'sbom-inputs.json',manifest_entries)
        self.command([self.tool('syft'),'scan','dir:'+str(stage),'-o','cyclonedx-json='+str(path)],'syft')
        data=read(path)
        if data.get('bomFormat')!='CycloneDX' or not data.get('components'):raise ValueError('Empty/invalid SBOM')
        components={(str(p.get('group','')).rstrip('/')+'/'+p['name'] if p.get('group') else p['name'],p.get('version')) for p in data['components']}
        if not lock_packages(self.root/'pnpm-lock.yaml').issubset(components):raise ValueError('SBOM omits locked dependency versions')
        if not any(p.get('name')=='brace-expansion' and p.get('version')=='5.0.12' for p in data['components']):raise ValueError('SBOM missing required transitive dependency')
        self.command(['node',self.root/'scripts/security-release-inventory.js','generate','--root',self.root,'--output',self.output/'release-inventory.json'],'release-inventory')
        self.command(['node',self.root/'scripts/security-release-inventory.js','verify','--root',self.root,'--input',self.output/'release-inventory.json'],'verify-inventory')
        return {'components':len(data['components']),'sbomSha256':sha(path),'inventorySha256':sha(self.output/'release-inventory.json'),'scope':'CycloneDX source SBOM from the exact package/lock/workspace manifests. Separate release-inventory.json verifies the active runner installation/native dependencies. Not a built release or production host inventory.','blockingFindings':[]}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('gate',choices=['sca','sast','secrets','sbom']);parser.add_argument('--root',default='.');parser.add_argument('--output',required=True);parser.add_argument('--tools',required=True);parser.add_argument('--semgrep',default='semgrep');parser.add_argument('--pnpm',default='pnpm');args=parser.parse_args()
    gate=None;code=2
    try:
        gate=Gate(args);details=getattr(gate,args.gate)();code=1 if details['blockingFindings'] else 0
        receipt={'complete':True,'passed':code==0,'status':'findings' if code else 'passed','details':details}
    except Exception as error:
        receipt={'complete':False,'passed':False,'status':'tool_or_coverage_error','error':str(error)}
    receipt.update({'schemaVersion':1,'gate':args.gate,'checkedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'exitCode':code,'commands':gate.commands if gate else []})
    output=Path(args.output);output.mkdir(parents=True,exist_ok=True);write(output/'gate-result.json',receipt)
    print(json.dumps({key:receipt[key] for key in ('gate','complete','passed','status','exitCode')}))
    return code


if __name__=='__main__':sys.exit(main())

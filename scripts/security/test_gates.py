import datetime as dt
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from gates import Gate, validate_exceptions, remaining_findings, check_sast_result, check_sca_result, lock_packages, registry_vulnerability_count
from install_tools import verified_download


class GateContractTests(unittest.TestCase):
    def policy(self):
        return {'schemaVersion':1,'advisoryExceptions':[],'findingExceptions':[{'scanner':'sast','fingerprint':'a'*64,'sourceSha256':'b'*64,'owner':'maintainer','reason':'Reviewed synthetic fixture with exact bytes.','reviewedOn':'2026-10-18','expiresOn':'2026-11-01','priority':'P2'}]}

    def test_exact_exception_and_source_drift(self):
        p=self.policy();items=validate_exceptions(p,dt.date(2026,10,18))
        self.assertEqual(remaining_findings('sast',[{'fingerprint':'a'*64,'sourceSha256':'b'*64}],items),[])
        for finding in ({'fingerprint':'c'*64,'sourceSha256':'b'*64},{'fingerprint':'a'*64,'sourceSha256':'c'*64}):
            self.assertEqual(len(remaining_findings('sast',[finding],items)),1)
        self.assertEqual(len(remaining_findings('secrets',[{'fingerprint':'a'*64,'sourceSha256':'b'*64}],items)),1)

    def test_expired_exception_fails(self):
        with self.assertRaises(ValueError):validate_exceptions(self.policy(),dt.date(2026,11,2))

    def test_unbounded_exception_fails(self):
        with self.assertRaises(ValueError):validate_exceptions(self.policy(),dt.date(2026,1,1))

    def test_global_advisory_ignore_forbidden(self):
        p=self.policy();p['advisoryExceptions']=['GHSA-anything']
        with self.assertRaises(ValueError):validate_exceptions(p,dt.date(2026,10,18))

    def test_wildcard_path_exception_forbidden(self):
        p=self.policy();p['findingExceptions'][0]['fingerprint']='test/**'
        with self.assertRaises(ValueError):validate_exceptions(p,dt.date(2026,10,18))

    def test_missing_owner_or_reason_fails(self):
        for key in ('owner','reason'):
            p=self.policy();p['findingExceptions'][0][key]=''
            with self.assertRaises(ValueError):validate_exceptions(p,dt.date(2026,10,18))

    def test_sast_requires_complete_server_coverage(self):
        with tempfile.TemporaryDirectory() as directory:
            stage=Path(directory);path=str(stage/'server.js')
            self.assertEqual(check_sast_result({'errors':[],'paths':{'scanned':[path]},'time':{'fixpoint_timeouts':[]}},{'server.js'},stage),1)
            for result in ({'errors':[],'paths':{'scanned':[]}}, {'errors':[{'type':'Timeout'}],'paths':{'scanned':[path]}}, {'errors':[{'type':'ParseError'}],'paths':{'scanned':[path]}}, {'paths':{'scanned':[path],'skipped':[{'path':path,'reason':'size'}]}}):
                with self.assertRaises(ValueError):check_sast_result(result,{'server.js'},stage)

    def test_sca_requires_optional_other_platform_packages(self):
        expected={('example','1.0.0'),('@img/sharp-linux-x64','0.35.5')}
        result={'results':[{'packages':[{'package':{'name':n,'version':v,'ecosystem':'npm'}} for n,v in expected]}]}
        self.assertEqual(check_sca_result(result,expected),[])
        result['results'][0]['packages'].pop()
        with self.assertRaises(ValueError):check_sca_result(result,expected)

    def test_sast_taint_fixpoint_timeout_blocks_despite_complete_targets_and_no_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            stage=Path(directory);path=str(stage/'server.js')
            clean={'errors':[],'paths':{'scanned':[path]},'time':{'fixpoint_timeouts':[]}}
            self.assertEqual(check_sast_result(clean,{'server.js'},stage),1)
            # This is the shape emitted by the actual pinned scanner: warnings
            # in profiling, even with strict mode and no top-level errors.
            warning={'error_type':'Fixpoint timeout','severity':'warn',
                     'message':'Fixpoint timeout while performing taint analysis',
                     'location':{'path':path,'start':{'line':1,'col':1,'offset':0},'end':{'line':1,'col':1,'offset':0}}}
            for severity in ('warn','error','info'):
                result={**clean,'time':{'fixpoint_timeouts':[{**warning,'severity':severity}]}}
                with self.assertRaisesRegex(ValueError,'taint fixpoint timeout'):
                    check_sast_result(result,{'server.js'},stage)

    def test_sast_fixpoint_evidence_missing_or_malformed_is_not_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            stage=Path(directory);path=str(stage/'server.js')
            base={'errors':[],'paths':{'scanned':[path]}}
            for result in (base,{**base,'time':None},{**base,'time':[]},{**base,'time':{}},
                           *({**base,'time':{'fixpoint_timeouts':value}} for value in (None,False,0,'',{}))):
                with self.assertRaisesRegex(ValueError,'fixpoint completeness evidence'):
                    check_sast_result(result,{'server.js'},stage)

    def test_sast_rule_skip_or_unexpected_extra_target_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            stage=Path(directory);path=str(stage/'server.js')
            for result in ({'errors':[],'paths':{'scanned':[path]},'skipped_rules':['unparsed-rule']},{'errors':[],'paths':{'scanned':[path,str(stage/'unexpected.js')]}}):
                with self.assertRaises(ValueError):check_sast_result(result,{'server.js'},stage)

    def test_sca_reports_vulnerabilities(self):
        result={'results':[{'packages':[{'package':{'name':'example','version':'1.0.0','ecosystem':'npm'},'vulnerabilities':[{'id':'GHSA-fixture'}]}]}]}
        self.assertEqual(check_sca_result(result,{('example','1.0.0')})[0]['advisory'],'GHSA-fixture')

    def test_registry_audit_requires_all_five_severity_counts(self):
        valid=dict.fromkeys(('info','low','moderate','high','critical'),0)
        self.assertEqual(registry_vulnerability_count({'metadata':{'vulnerabilities':valid}}),0)
        for value in (None,{},dict(list(valid.items())[:-1])):
            with self.assertRaises(ValueError):registry_vulnerability_count({'metadata':{'vulnerabilities':value}})

    def test_registry_audit_rejects_negative_nonnumeric_and_boolean_counts(self):
        for invalid in (-1,'0',None,False,0.0):
            counts=dict.fromkeys(('info','low','moderate','high','critical'),0);counts['high']=invalid
            with self.assertRaises(ValueError):registry_vulnerability_count({'metadata':{'vulnerabilities':counts}})

    def test_malformed_or_empty_lock_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'lock.yaml'
            for data in ('','packages: []','\npackages:\n\nsnapshots:\n','\npackages:\n  invalid:\n\nsnapshots:\n'):
                p.write_text(data)
                with self.assertRaises(ValueError):lock_packages(p)

    def test_tampered_scanner_cache_fails_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            asset={'sha256':'a'*64,'bytes':3,'url':'https://invalid.example/scanner'}
            (Path(directory)/asset['sha256']).write_bytes(b'bad')
            with self.assertRaises(ValueError):verified_download(asset,Path(directory))

    def test_missing_scanner_never_passes(self):
        with self.assertRaises(FileNotFoundError):subprocess.run(['gp-missing-security-scanner-fixture-01910'],check=True,capture_output=True)

    def inventory_gate(self, directory, fail_label=None):
        # Exercise the real SBOM gate ordering/arguments without executing a
        # scanner or inventory process; those have separate Linux CLI tests.
        root=Path(directory);output=root/'evidence';output.mkdir()
        for name in ('package.json','pnpm-lock.yaml','pnpm-workspace.yaml'):
            (root/name).write_text('synthetic input\n')
        gate=Gate.__new__(Gate);gate.root=root;gate.output=output
        gate.tool=lambda name: root/('verified-'+name)
        commands=[]
        def command(args,label,*unused,**options):
            commands.append((label,[str(value) for value in args]))
            if label==fail_label:raise ValueError(label+' failed with exit 1')
            if label=='syft':
                (output/'sbom.cdx.json').write_text(json.dumps({'bomFormat':'CycloneDX','components':[{'name':'brace-expansion','version':'5.0.12'}]}))
            if label=='release-inventory':(output/'release-inventory.json').write_text('{}\n')
        gate.command=command
        return gate,commands

    def test_sbom_runs_and_verifies_explicit_linux_host_policy_without_changing_other_platforms(self):
        for platform in ('linux','win32'):
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                gate,commands=self.inventory_gate(directory)
                with patch('gates.sys.platform',platform), patch('gates.lock_packages',return_value={('brace-expansion','5.0.12')}):
                    result=gate.sbom()
                self.assertEqual([label for label,argv in commands],['syft','release-inventory','verify-inventory'])
                for label,argv in commands[1:]:
                    self.assertEqual(argv[2],'generate' if label=='release-inventory' else 'verify')
                    if platform=='linux':self.assertEqual(argv[-2:],['--host-policy','debian-nodejs-v1'])
                    else:self.assertNotIn('--host-policy',argv)
                self.assertEqual(result['inventoryHostPolicy'],'debian-nodejs-v1' if platform=='linux' else None)
                self.assertEqual(result['blockingFindings'],[])

    def test_sbom_inventory_generation_or_verification_error_never_falls_back_to_strict_or_passes(self):
        for failure in ('release-inventory','verify-inventory'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                gate,commands=self.inventory_gate(directory,failure)
                with patch('gates.sys.platform','linux'), patch('gates.lock_packages',return_value={('brace-expansion','5.0.12')}):
                    with self.assertRaisesRegex(ValueError,failure+' failed'):gate.sbom()
                expected=['syft','release-inventory']+(['verify-inventory'] if failure=='verify-inventory' else [])
                self.assertEqual([label for label,argv in commands],expected)
                for label,argv in commands[1:]:self.assertEqual(argv[-2:],['--host-policy','debian-nodejs-v1'])

    def test_linux_sbom_job_requires_native_inventory_positive_and_negative_tests_before_gate(self):
        workflow=(Path(__file__).resolve().parents[2]/'.github/workflows/security.yml').read_text()
        job=workflow.split('\n  security-sbom:\n',1)[1].split('\n  security-gates:\n',1)[0]
        self.assertIn('runs-on: ubuntu-24.04',job)
        expected='node --test test/security-release-inventory.test.js test/security-release-host-inventory.test.js test/security-release-inventory-host-cli.test.js'
        self.assertIn(expected,job)
        self.assertLess(job.index(expected),job.index('python scripts/security/gates.py sbom'))
        test_step=job[job.index('      - name: Native inventory Linux positive and negative tests'):job.index('      - name: Run sbom gate')]
        self.assertNotIn('continue-on-error:',test_step)
        self.assertNotIn('if:',test_step)

    def test_actual_aggregate_shell_rejects_every_non_success(self):
        workflow=(Path(__file__).resolve().parents[2]/'.github/workflows/security.yml').read_text()
        script=workflow[workflow.index('          for result in'):]
        script='\n'.join(line[10:] for line in script.splitlines())
        bash=shutil.which('bash')
        if not bash and Path(r'C:\Program Files\Git\bin\bash.exe').is_file():bash=r'C:\Program Files\Git\bin\bash.exe'
        self.assertIsNotNone(bash,'Bash is required to test the actual aggregate step')
        import os
        names=('SCA','SAST','SECRETS','SBOM')
        for name in names:
            for value in ('success','failure','cancelled','skipped','pending','neutral','timed_out','','success; exit 0'):
                with self.subTest(gate=name,result=value):
                    env={**os.environ,**dict.fromkeys(names,'success'),name:value}
                    result=subprocess.run([bash,'-c',script],env=env,capture_output=True)
                    self.assertEqual(result.returncode==0,value=='success',value)


if __name__=='__main__':unittest.main()

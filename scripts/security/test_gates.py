import datetime as dt
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from gates import validate_exceptions, remaining_findings, check_sast_result, check_sca_result, lock_packages, registry_vulnerability_count
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
            self.assertEqual(check_sast_result({'errors':[],'paths':{'scanned':[path]}},{'server.js'},stage),1)
            for result in ({'errors':[],'paths':{'scanned':[]}}, {'errors':[{'type':'Timeout'}],'paths':{'scanned':[path]}}, {'errors':[{'type':'ParseError'}],'paths':{'scanned':[path]}}, {'paths':{'scanned':[path],'skipped':[{'path':path,'reason':'size'}]}}):
                with self.assertRaises(ValueError):check_sast_result(result,{'server.js'},stage)

    def test_sca_requires_optional_other_platform_packages(self):
        expected={('example','1.0.0'),('@img/sharp-linux-x64','0.35.5')}
        result={'results':[{'packages':[{'package':{'name':n,'version':v,'ecosystem':'npm'}} for n,v in expected]}]}
        self.assertEqual(check_sca_result(result,expected),[])
        result['results'][0]['packages'].pop()
        with self.assertRaises(ValueError):check_sca_result(result,expected)

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

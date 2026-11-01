"""Exact registry identities, not aggregate subtraction or advisory waivers."""
import copy
import datetime as dt
import json
from pathlib import Path
import unittest
from gates import registry_audit_findings, verified_registry_patch_remediations


class RegistryBackportTests(unittest.TestCase):
    def fixture(self):
        policy=json.loads((Path(__file__).parent/'patch-policy.json').read_text())['securityBackports'][0]
        record={name:policy[name] for name in ('advisory','package','version','patchSha256','originalTarballIntegrity',
                'originalTarballSha256','upstreamCommit','installedTreeSha256','expiresOn')}
        record.update(status='remediated_by_verified_patch',regressionTestSha256=policy['regressionTestSha256'],
                      regressionPassed=True,regressionPassCount=14,
                      installedFiles={name:item['afterSha256'] for name,item in policy['installedFiles'].items()})
        proof={'passed':True,'advisoryWaivers':0,'securityBackports':[record]}
        advisory={'id':1243111,'module_name':'@azure/msal-node','github_advisory_id':'GHSA-xcx6-jx8p-x3h5',
                  'url':'https://github.com/advisories/GHSA-xcx6-jx8p-x3h5','severity':'high',
                  'findings':[{'version':'5.4.0','paths':['.>tedious>@azure/identity>@azure/msal-node'],
                               'dev':False,'optional':False,'bundled':False}]}
        audit={'advisories':{'1243111':advisory},'metadata':{
            'vulnerabilities':{'info':0,'low':0,'moderate':0,'high':1,'critical':0},'totalDependencies':1}}
        return audit,{('@azure/msal-node','5.4.0')},proof,[policy]

    def apply(self,audit,expected,proof,policies):
        return verified_registry_patch_remediations(audit,expected,proof,policies,dt.date(2026,10,24))

    def test_exact_repaired_code_accounts_for_explicit_registry_identity_without_changing_raw_counts(self):
        args=self.fixture();before=copy.deepcopy(args[0]);result=self.apply(*args)
        self.assertEqual(args[0],before);self.assertEqual(result['blockingFindings'],[])
        self.assertEqual(result['remediatedFindings'][0]['registryAdvisoryId'],1243111)
        self.assertEqual(result['remediatedFindings'][0]['status'],'remediated_by_verified_patch')
        self.assertEqual(args[0]['metadata']['vulnerabilities']['high'],1)

    def test_aggregate_count_without_all_individual_records_never_passes(self):
        for change in ('missing','empty','extra-count','wrong-severity','inventory'):
            args=self.fixture();audit=args[0]
            if change=='missing':del audit['advisories']
            elif change=='empty':audit['advisories']={}
            elif change=='extra-count':audit['metadata']['vulnerabilities']['high']=2
            elif change=='wrong-severity':audit['metadata']['vulnerabilities'].update(high=0,critical=1)
            else:audit['metadata']['totalDependencies']=2
            with self.subTest(change=change),self.assertRaises(ValueError):self.apply(*args)

    def test_another_advisory_is_blocking_even_for_the_repaired_package_and_version(self):
        args=self.fixture();record=args[0]['advisories']['1243111']
        record['github_advisory_id']='GHSA-2345-6789-cfgh';record['url']='https://github.com/advisories/GHSA-2345-6789-cfgh'
        result=self.apply(*args);self.assertEqual(len(result['blockingFindings']),1)
        self.assertEqual(result['remediatedFindings'],[])

    def test_other_installed_consumer_paths_remain_blocking(self):
        for paths in (['.>another>@azure/msal-node'],['.>tedious>@azure/identity>@azure/msal-node','.>another>@azure/msal-node']):
            args=self.fixture();args[0]['advisories']['1243111']['findings'][0]['paths']=paths
            result=self.apply(*args);self.assertEqual(len(result['blockingFindings']),1)
            self.assertEqual(result['blockingFindings'][0]['status'],'unverified_installed_consumer')
            self.assertEqual(result['remediatedFindings'],[])

    def test_other_locked_versions_and_packages_are_not_repaired_by_the_same_proof(self):
        for package,version in (('@azure/msal-node','5.3.0'),('another-package','5.4.0')):
            args=list(self.fixture());record=args[0]['advisories']['1243111'];record['module_name']=package
            record['findings'][0].update(version=version,paths=['.>consumer>'+package]);args[1]={(package,version)}
            result=self.apply(*args);self.assertEqual(len(result['blockingFindings']),1)
            self.assertEqual(result['remediatedFindings'],[])

    def test_unknown_or_duplicate_versions_are_incomplete(self):
        for change in ('outside-lock','duplicate-version','duplicate-identity'):
            args=self.fixture();audit=args[0];record=audit['advisories']['1243111']
            if change=='outside-lock':record['findings'][0]['version']='5.3.0'
            elif change=='duplicate-version':record['findings']*=2
            else:
                second=copy.deepcopy(record);second['id']=1243112;audit['advisories']['1243112']=second
                audit['metadata']['vulnerabilities']['high']=2
            with self.subTest(change=change),self.assertRaises(ValueError):self.apply(*args)

    def test_malformed_registry_identity_paths_and_classifications_are_incomplete(self):
        for field,value in [('id',True),('id',1243112),('module_name',None),('github_advisory_id','unbound'),
                            ('url','https://invalid.example'),('severity',[]),('severity','unknown'),('findings',[])]:
            args=self.fixture();args[0]['advisories']['1243111'][field]=value
            with self.subTest(field=field,value=value),self.assertRaises(ValueError):self.apply(*args)
        for field,value in [('paths',[]),('paths',[{}]),('paths',['.>another-package']),('dev',None),('optional',0),('bundled','false')]:
            args=self.fixture();args[0]['advisories']['1243111']['findings'][0][field]=value
            with self.subTest(field=field,value=value),self.assertRaises(ValueError):self.apply(*args)

    def test_zero_registry_findings_require_zero_counts_and_an_explicit_empty_advisory_set(self):
        args=self.fixture();args[0]['advisories']={};args[0]['metadata']['vulnerabilities']['high']=0
        result=self.apply(*args);self.assertEqual(result['findings'],[]);self.assertEqual(result['blockingFindings'],[])

    def test_bad_expired_or_incomplete_patch_proof_cannot_account_for_a_registry_finding(self):
        for change in ('failed','expired','missing-file','incomplete-tests','waiver'):
            args=self.fixture();proof=args[2];record=proof['securityBackports'][0]
            if change=='failed':proof['passed']=False
            elif change=='expired':args[3][0]['expiresOn']='2026-10-23'
            elif change=='missing-file':record['installedFiles'].pop(next(iter(record['installedFiles'])))
            elif change=='incomplete-tests':record['regressionPassCount']=13
            else:proof['advisoryWaivers']=1
            with self.subTest(change=change),self.assertRaises(ValueError):self.apply(*args)


if __name__=='__main__':unittest.main()

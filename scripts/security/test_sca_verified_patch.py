import copy
import datetime as dt
import json
from pathlib import Path
import unittest
from gates import verified_patch_remediations


class VerifiedSecurityBackportTests(unittest.TestCase):
    def fixture(self):
        policy=json.loads((Path(__file__).parent/'patch-policy.json').read_text())['securityBackports'][0]
        record={name:policy[name] for name in ('advisory','package','version','patchSha256','originalTarballIntegrity','originalTarballSha256','upstreamCommit','installedTreeSha256','expiresOn')}
        record.update(status='remediated_by_verified_patch',regressionTestSha256=policy['regressionTestSha256'],regressionPassed=True,regressionPassCount=14,
                      installedFiles={name:item['afterSha256'] for name,item in policy['installedFiles'].items()})
        proof={'passed':True,'advisoryWaivers':0,'securityBackports':[record]}
        finding={name:policy[name] for name in ('advisory','package','version')}
        return policy,proof,finding

    def apply(self,findings,proof,policies):
        return verified_patch_remediations(findings,proof,policies,dt.date(2026,10,24))

    def test_raw_advisory_is_preserved_and_repaired_code_is_explicit(self):
        policy,proof,finding=self.fixture();raw=[copy.deepcopy(finding)]
        result=self.apply(raw,proof,[policy])
        self.assertEqual(raw,[finding]);self.assertEqual(result['blockingFindings'],[])
        self.assertEqual(result['remediatedFindings'][0]['status'],'remediated_by_verified_patch')
        self.assertEqual({name:result['remediatedFindings'][0][name] for name in finding},finding)

    def test_new_advisory_other_package_or_different_version_stays_blocking(self):
        policy,proof,finding=self.fixture()
        for key in ('advisory','package','version'):
            unknown={**finding,key:'unreviewed'};result=self.apply([finding,unknown],proof,[policy])
            self.assertEqual(result['blockingFindings'],[unknown]);self.assertEqual(len(result['remediatedFindings']),1)

    def test_failed_missing_or_ambiguous_patch_verification_cannot_subtract(self):
        policy,proof,finding=self.fixture()
        for invalid in (None,{}, {**proof,'passed':False},{**proof,'advisoryWaivers':1},{**proof,'advisoryWaivers':False},
                        {**proof,'securityBackports':[]},{**proof,'securityBackports':proof['securityBackports']*2}):
            with self.subTest(invalid=invalid),self.assertRaises(ValueError):self.apply([finding],invalid,[policy])

    def test_source_patch_original_sri_or_installed_binding_drift_is_incomplete(self):
        policy,proof,finding=self.fixture()
        for key in ('patchSha256','originalTarballIntegrity','originalTarballSha256','upstreamCommit','installedTreeSha256','expiresOn','regressionTestSha256'):
            changed=copy.deepcopy(proof);changed['securityBackports'][0][key]='unreviewed'
            with self.subTest(field=key),self.assertRaises(ValueError):self.apply([finding],changed,[policy])

    def test_each_actual_export_source_and_declaration_is_mandatory(self):
        policy,proof,finding=self.fixture()
        for relative in policy['installedFiles']:
            changed=copy.deepcopy(proof);del changed['securityBackports'][0]['installedFiles'][relative]
            with self.subTest(path=relative),self.assertRaises(ValueError):self.apply([finding],changed,[policy])

    def test_vulnerable_original_file_is_never_treated_as_repaired(self):
        policy,proof,finding=self.fixture()
        for relative,item in policy['installedFiles'].items():
            changed=copy.deepcopy(proof);changed['securityBackports'][0]['installedFiles'][relative]=item['beforeSha256']
            with self.subTest(path=relative),self.assertRaises(ValueError):self.apply([finding],changed,[policy])

    def test_missing_failed_or_incomplete_regressions_are_not_accepted(self):
        policy,proof,finding=self.fixture()
        for key,value in [('regressionPassed',False),('regressionPassed',None),('regressionPassCount',13),('regressionPassCount',True),('status','waived')]:
            changed=copy.deepcopy(proof);changed['securityBackports'][0][key]=value
            with self.subTest(field=key,value=value),self.assertRaises(ValueError):self.apply([finding],changed,[policy])

    def test_unregistered_identity_or_expired_policy_is_not_a_version_waiver(self):
        policy,proof,finding=self.fixture()
        for change in ({'advisory':'GHSA-other'},{'kind':'exception'},{'advisoryExceptions':[finding['advisory']]},
                       {'expiresOn':'2026-10-23'},{'reviewedOn':'2026-10-25'},{'expiresOn':'2027-01-01'}):
            with self.subTest(change=change),self.assertRaises(ValueError):self.apply([finding],proof,[{**policy,**change}])


if __name__=='__main__':unittest.main()

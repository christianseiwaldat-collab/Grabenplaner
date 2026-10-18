import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from sast_profile import source_partition, deployment_guard, build_rule_profiles, EXPENSIVE_RULE_FILES, PROFILE_TIMEOUTS, PROFILE_VERSION, profile_timeouts


class ApplicabilityTests(unittest.TestCase):
    def fixture(self, root):
        root.mkdir(exist_ok=True)
        (root/'package.json').write_text('{"dependencies":{"express":"5.2.1"}}')
        (root/'pnpm-lock.yaml').write_text('packages:\n  express@5.2.1:\n')
        entries=[]
        for name in ('server.js','lib/shared.js','public/app.js'):
            path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('const value=1;')
            entries.append({'path':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
        return entries

    def test_common_covers_every_target_and_express_keeps_full_backend(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);entries=self.fixture(root);parts=source_partition(root,entries)
            self.assertEqual(parts['common'],entries)
            self.assertEqual([e['path'] for e in parts['express']],['server.js','lib/shared.js'])
            self.assertEqual(parts['script_tag'],entries)
            self.assertEqual(parts['express_property'],parts['express'])
            self.assertEqual(parts['express_response'],parts['express'])

    def test_missing_server_never_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);entries=self.fixture(root)
            with self.assertRaises(ValueError):source_partition(root,entries[1:])

    def test_lambda_dependency_or_entrypoint_requires_profile_review(self):
        for source in ('exports.handler = async () => {};','module.exports.handler = () => {};',"module.exports['handler'] = () => {};",'export const handler = () => {};',"require('@aws-sdk/client-lambda');"):
            with tempfile.TemporaryDirectory() as directory:
                root=Path(directory);entries=self.fixture(root);(root/'server.js').write_text(source)
                with self.assertRaises(ValueError):source_partition(root,entries)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);entries=self.fixture(root);(root/'package.json').write_text('{"dependencies":{"@aws-sdk/client-lambda":"1"}}')
            with self.assertRaises(ValueError):source_partition(root,entries)

    def test_express_import_in_public_cannot_be_silently_skipped(self):
        for source in ("const app=require('express')();", "import express from 'express';"):
            with tempfile.TemporaryDirectory() as directory:
                root=Path(directory);entries=self.fixture(root);(root/'public/app.js').write_text(source)
                with self.assertRaises(ValueError):source_partition(root,entries)

    def test_lambda_deployment_cannot_silently_appear(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.fixture(root)
            (root/'template.yml').write_text('Type: AWS::Lambda::Function')
            with self.assertRaises(ValueError):deployment_guard([{'path':'template.yml'}],root)
            with self.assertRaises(ValueError):deployment_guard([{'path':'serverless.yml'}],root)

    def rule_fixture(self, root):
        entries=[]
        for name in ('javascript/lang/security/example.yaml','javascript/express/security/example.yaml','javascript/aws-lambda/security/example.yaml',*EXPENSIVE_RULE_FILES):
            p=root/'rules'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('rules:\n  - id: example\n    pattern: unsafe(...)\n')
            entries.append({'path':name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
        return {'commit':'a'*40,'archiveSha256':'b'*64,'files':entries}

    def test_rule_profiles_preserve_bytes_and_account_for_every_rule(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);manifest=self.rule_fixture(root)
            result=build_rule_profiles(root,root/'profiles',manifest,expected_rules=6)
            self.assertEqual(result['totalUpstreamRules'],6)
            self.assertEqual(sum(e['ruleCount'] for e in result['excludedRuleFiles']),1)
            for name,files in result['groups'].items():
                self.assertEqual(len(files),1)
                for e in files:self.assertEqual((root/'rules'/e['path']).read_bytes(),(root/'profiles'/name/'rules'/e['path']).read_bytes())

    def test_rule_drift_or_unreviewed_rule_never_passes(self):
        for mode in ('changed','extra','missing'):
            with tempfile.TemporaryDirectory() as directory:
                root=Path(directory);manifest=self.rule_fixture(root);first=root/'rules'/manifest['files'][0]['path']
                if mode=='changed':first.write_text('rules: []')
                elif mode=='extra':(root/'rules/unreviewed.yaml').write_text('rules: []')
                else:first.unlink()
                with self.assertRaises(ValueError):build_rule_profiles(root,root/'profiles',manifest,expected_rules=6)

    def test_v2_v3_union_matches_v1_exactly_with_versioned_budgets(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);manifest=self.rule_fixture(root)
            old=build_rule_profiles(root,root/'v1',manifest,expected_rules=6,profile_version=1)
            new=build_rule_profiles(root,root/'v2',manifest,expected_rules=6,profile_version=2)
            current=build_rule_profiles(root,root/'v3',manifest,expected_rules=6,profile_version=3)
            flatten=lambda p:{e['path']:(e['sha256'],e['ruleCount']) for entries in p['groups'].values() for e in entries}
            self.assertEqual(flatten(old),flatten(new));self.assertEqual(old['canonicalRuleIds'],new['canonicalRuleIds'])
            self.assertEqual(old['excludedRuleFiles'],new['excludedRuleFiles'])
            self.assertEqual(new['groups'],current['groups']);self.assertEqual(new['canonicalRuleIds'],current['canonicalRuleIds'])
            self.assertEqual(new['excludedRuleFiles'],current['excludedRuleFiles'])
            self.assertEqual({k for k,v in PROFILE_TIMEOUTS.items() if v==300},set(EXPENSIVE_RULE_FILES.values()))
            self.assertEqual(PROFILE_TIMEOUTS['common'],120);self.assertEqual(PROFILE_TIMEOUTS['express'],120)
            for path,group in EXPENSIVE_RULE_FILES.items():self.assertEqual([e['path'] for e in new['groups'][group]],[path])

    def test_historical_timeouts_and_target_partitions_remain_exact(self):
        self.assertEqual(PROFILE_VERSION,3)
        self.assertEqual(profile_timeouts(1),{'common':60,'express':60})
        self.assertEqual(profile_timeouts(2),{'common':60,'express':60,'script_tag':300,'express_property':300,'express_response':300})
        copied=profile_timeouts(2);copied['common']=999
        self.assertEqual(profile_timeouts(2)['common'],60)
        with self.assertRaises(ValueError):profile_timeouts(4)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);entries=self.fixture(root)
            self.assertEqual(source_partition(root,entries,2),source_partition(root,entries,3))

    def test_missing_expensive_rule_or_unknown_profile_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);manifest=self.rule_fixture(root)
            with self.assertRaises(ValueError):build_rule_profiles(root,root/'bad',manifest,expected_rules=6,profile_version=4)
            removed=manifest['files'].pop();(root/'rules'/removed['path']).unlink()
            with self.assertRaises(ValueError):build_rule_profiles(root,root/'missing',manifest,expected_rules=5)


if __name__=='__main__':unittest.main()

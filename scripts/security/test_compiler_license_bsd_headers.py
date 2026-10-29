import copy
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import compiler_license_native as native
import compiler_license_ledger as ledger
from test_compiler_license_ledger import fixture_ledger
from test_compiler_license_native import tar_bytes

FIXTURES = Path(__file__).parent / 'fixtures' / 'bsd-compat-headers'


class ExactBsdHeaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.sources = self.root / 'sources'; self.sources.mkdir()
        self.recipe = {name: (FIXTURES / name).read_bytes() for name in ('APKBUILD','cdefs.h','queue.h','tree.h')}
        self.package = {'id': native.BSD_ORIGIN+'.'+native.BSD_VERSION, 'origin':native.BSD_ORIGIN,
            'name':native.BSD_ORIGIN, 'version':native.BSD_VERSION, 'commit':native.BSD_COMMIT,
            'licenseExpression':native.BSD_EXPRESSION,'url':'https://gitlab.alpinelinux.org/alpine/aports'}
        self.capture = {'apkPackages':[self.package], 'nativeInputs':[{'path':'/usr/include/sys/'+name,
            'owner':self.package['id'],'bytes':row['bytes'],'sha256':row['sha256']} for name,row in native.BSD_HEADERS.items()]}

    def collect(self, recipe=None):
        recipe = self.recipe if recipe is None else recipe
        snapshot = tar_bytes({'aports-'+native.BSD_COMMIT+'/main/'+native.BSD_ORIGIN+'/'+name:data for name,data in recipe.items()})
        with patch.object(native,'download',return_value=snapshot) as download:
            components = native.collect_native(self.capture,self.root,self.sources)
        self.assertEqual(download.call_count,1)
        component = components[0]
        return component,(self.sources/component['correspondingSource']['filename']).read_bytes()

    def validate(self,component,data):
        value,sources,context = fixture_ledger('b'*64)
        value['components'][1] = component
        value['closure']['nativePackageIds'] = component['packageIds']
        sources[component['correspondingSource']['filename']] = data
        ledger.validate_ledger(value,'b'*64,context)
        ledger.validate_sources(value,sources.__getitem__)

    def members(self,data):
        with tarfile.open(fileobj=io.BytesIO(data),mode='r:xz') as archive:
            return {item.name:archive.extractfile(item).read() for item in archive}

    def rebind(self,component,members):
        data = native.bundle_bytes(members)
        component['correspondingSource'].update(bytes=len(data),sha256=native.sha(data))
        return data

    def test_actual_three_headers_and_both_distinct_notices_survive_publisher_consumer(self):
        component,data = self.collect(); self.validate(component,data)
        self.assertEqual([item['path'] for item in component['notices']],['aports/queue.h','aports/tree.h'])
        self.assertEqual(component['notices'][0]['text'].encode(),self.recipe['queue.h'])
        self.assertEqual(component['notices'][1]['text'].encode(),self.recipe['tree.h'])
        self.assertIn('The Regents of the University of California.',component['notices'][0]['text'])
        self.assertIn('Copyright 2002 Niels Provos',component['notices'][1]['text'])
        members = self.members(data)
        for name,original in self.recipe.items():self.assertEqual(members['aports/'+name],original)
        self.assertEqual(len(members),5)
        self.assertNotIn('cdefs.h',[Path(item['path']).name for item in component['notices']])

    def test_every_authentic_header_matches_its_original_aports_sha512_and_capture_sha256(self):
        sums=native.recipe_checksums(self.recipe['APKBUILD'],native.BSD_VERSION)
        for name,row in native.BSD_HEADERS.items():
            self.assertEqual(hashlib.sha512(self.recipe[name]).hexdigest(),sums[name])
            self.assertEqual(native.sha(self.recipe[name]),row['sha256'])
            self.assertEqual(len(self.recipe[name]),row['bytes'])

    def test_producer_rejects_other_commit_version_or_declared_expression(self):
        for key,bad in [('commit','0'*40),('version','0.7.3-r0'),('licenseExpression','MIT')]:
            with self.subTest(key=key):
                changed=copy.deepcopy(self.package);changed[key]=bad
                with self.assertRaises(ValueError):native.bsd_header_notices(native.BSD_ORIGIN,
                    changed['version'],changed['commit'],[changed],self.recipe)

    def test_producer_rejects_changed_original_header_even_if_an_attacker_rebinds_recipe_sum(self):
        for name in native.BSD_HEADERS:
            with self.subTest(name=name):
                changed=copy.deepcopy(self.recipe);changed[name]+=b'changed'
                changed['APKBUILD']=changed['APKBUILD'].replace(hashlib.sha512(self.recipe[name]).hexdigest().encode(),hashlib.sha512(changed[name]).hexdigest().encode())
                with self.assertRaises(ValueError):native.bsd_header_notices(native.BSD_ORIGIN,native.BSD_VERSION,native.BSD_COMMIT,[self.package],changed)

    def test_component_cannot_rename_its_actual_native_owner_to_bypass_the_review(self):
        component,data=self.collect();component['name']='apk/other'
        with self.assertRaisesRegex(ValueError,'BSD'):self.validate(component,data)

    def test_missing_truncated_replaced_or_reordered_original_notices_are_rejected(self):
        component,data=self.collect()
        changes=[lambda c:c['notices'].pop(),lambda c:c['notices'].reverse(),
            lambda c:c['notices'].__setitem__(0,ledger.notice('aports/queue.h',self.recipe['queue.h'][:2000])),
            lambda c:c['notices'].__setitem__(0,ledger.notice('aports/cdefs.h',self.recipe['cdefs.h']))]
        for change in changes:
            altered=copy.deepcopy(component);change(altered)
            with self.subTest(change=change),self.assertRaisesRegex(ValueError,'BSD'):self.validate(altered,data)

    def test_consumer_rejects_changed_or_missing_original_source_after_outer_hash_rebinding(self):
        component,data=self.collect()
        for name in ('aports/cdefs.h','aports/queue.h','aports/tree.h','aports/APKBUILD'):
            for missing in (False,True):
                with self.subTest(name=name,missing=missing):
                    altered=copy.deepcopy(component);members=self.members(data)
                    if missing:members.pop(name)
                    else:members[name]+=b'changed'
                    rebound=self.rebind(altered,members)
                    with self.assertRaisesRegex(ValueError,'BSD'):self.validate(altered,rebound)

    def test_relabelled_source_metadata_with_self_consistent_outer_hash_is_rejected(self):
        component,data=self.collect();members=self.members(data)
        metadata=json.loads(members['native-source-metadata.json']);metadata['sourceExecutionPerformed']=True
        members['native-source-metadata.json']=native.encoded(metadata)
        with self.assertRaisesRegex(ValueError,'metadata'):self.validate(component,self.rebind(component,members))

    def test_named_license_copy_cannot_substitute_for_missing_original_header(self):
        component,data=self.collect();members=self.members(data)
        members['LICENSE.queue.h']=members.pop('aports/queue.h')
        with self.assertRaisesRegex(ValueError,'BSD'):self.validate(component,self.rebind(component,members))

    def test_bsd_corresponding_source_is_required_with_its_exact_origin(self):
        component,data=self.collect()
        for reference in (None,{},dict(component['correspondingSource'],url='https://example.invalid/unreviewed')):
            changed=copy.deepcopy(component);changed['correspondingSource']=reference
            with self.subTest(reference=reference),self.assertRaisesRegex(ValueError,'BSD'):
                native.validate_bsd_header_component(changed)

    def test_exact_bsd_parser_refuses_xz_expansion_bombs_and_concatenation(self):
        component,data=self.collect()
        members=self.members(data);members['extra']=b'x'*(1024**2)
        for invalid in (native.bundle_bytes(members),data+data):
            with self.subTest(bytes=len(invalid)),self.assertRaisesRegex(ValueError,'BSD source expansion'):
                native.validate_bsd_header_source(component,invalid)

    def test_arbitrary_h_source_is_never_promoted_to_primary_notice(self):
        self.assertFalse(native.reviewed_header_source_notice('aports/other.h',self.recipe['queue.h']))
        self.assertFalse(native.reviewed_header_source_notice('aports/queue.h',b'Copyright random source header'))
        self.assertFalse(native.reviewed_header_source_notice('aports/cdefs.h',self.recipe['cdefs.h']))
        for path in ('aports/other.h','source/queue.h'):
            self.assertNotIn(native.sha(self.recipe['queue.h']),ledger.source_notice_hashes(native.bundle_bytes({path:self.recipe['queue.h']})))


if __name__=='__main__':unittest.main()

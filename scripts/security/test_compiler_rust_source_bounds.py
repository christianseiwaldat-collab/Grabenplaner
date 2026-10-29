"""Finite actual Rust archive scope; small fixtures never stand in for actual qualification."""
import copy
import hashlib
import io
import tarfile
import unittest
from unittest.mock import patch

import compiler_license_native as native
import compiler_license_ledger as ledger


class RustFiniteBoundsTests(unittest.TestCase):
    def fixture(self, changed=False):
        files = {'rust/COPYING': b'Original synthetic license notice. ' * 5}
        files.update({'rust/file%d.c' % i: (b'changed' if changed and i == 1 else b'payload') for i in range(5)})
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:xz') as archive:
            for name, data in files.items():
                item = tarfile.TarInfo(name); item.size = len(data)
                archive.addfile(item, io.BytesIO(data))
        data = stream.getvalue()
        policy = dict(native.RUST_SOURCE, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
            sha512=hashlib.sha512(data).hexdigest(), members=6, expandedBytes=sum(map(len, files.values())))
        context = {'origin': policy['origin'], 'version': policy['version'], 'commit': policy['commit']}
        component = {'name': 'apk/rust', 'version': policy['version'], 'packageIds': ['rust.' + policy['version']],
            'correspondingSource': {'url': 'https://codeload.github.com/alpinelinux/aports/tar.gz/' + policy['commit']}}
        return data, policy, context, component

    def test_unknown_sources_keep_existing_finite_bounds(self):
        data, policy, context, component = self.fixture()
        self.assertEqual(native.source_inventory_bounds(policy['filename'], data, **context), (250000, 2 * 1024**3, False))
        with self.assertRaisesRegex(ValueError, 'expansion'):
            with patch.object(ledger, 'MAX_SOURCE', 100):
                ledger.source_notice_hashes(data, depth=1, source_name=policy['filename'])

    def test_exact_reviewed_archive_and_apk_context_enable_only_its_measured_inventory(self):
        data, policy, context, component = self.fixture()
        with patch.object(native, 'RUST_SOURCE', policy), patch.object(native, 'MAX_MEMBERS', 3), patch.object(ledger, 'MAX_SOURCE', 100):
            self.assertEqual(native.source_inventory_bounds(policy['filename'], data, **context), (6, policy['expandedBytes'], True))
            notices = native.source_notices(policy['filename'], data, **context)
            hashes = ledger.source_notice_hashes(data, depth=1, source_name=policy['filename'], native_component=component)
            self.assertEqual({item['sourceBytesSha256'] for item in notices}, hashes)
            self.assertEqual(len(notices), 1)

    def test_changed_source_filename_or_apk_binding_does_not_borrow_reviewed_limits(self):
        data, policy, context, component = self.fixture()
        for change in ('filename', 'version', 'origin', 'commit', 'source'):
            name, selected, current = policy['filename'], data, dict(context)
            bound_component = copy.deepcopy(component)
            if change == 'filename': name = 'other-source.tar.xz'
            if change in ('version', 'origin', 'commit'): current[change] += '-changed'
            if change == 'version': bound_component['version'] += '-changed'
            if change == 'origin': bound_component['name'] = 'apk/other'
            if change == 'commit': bound_component['correspondingSource']['url'] += '-changed'
            if change == 'source': selected = self.fixture(changed=True)[0]
            with self.subTest(change=change), patch.object(native, 'RUST_SOURCE', policy), patch.object(native, 'MAX_MEMBERS', 3), patch.object(ledger, 'MAX_SOURCE', 100):
                self.assertFalse(native.source_inventory_bounds(name, selected, **current)[2])
                with self.assertRaises(ValueError): native.source_notices(name, selected, **current)
                with self.assertRaises(ValueError):
                    ledger.source_notice_hashes(selected, depth=1, source_name=name, native_component=bound_component)

    def test_reviewed_inventory_is_exact_and_cannot_silently_truncate_or_skip(self):
        data, policy, context, component = self.fixture()
        for field in ('members', 'expandedBytes'):
            changed = dict(policy); changed[field] += 1
            with self.subTest(field=field), patch.object(native, 'RUST_SOURCE', changed), patch.object(native, 'MAX_MEMBERS', 3):
                with self.assertRaisesRegex(ValueError, 'inventory differs'):
                    native.source_notices(policy['filename'], data, **context)
                with self.assertRaisesRegex(ValueError, 'inventory differs'):
                    ledger.source_notice_hashes(data, depth=1, source_name=policy['filename'], native_component=component)


if __name__ == '__main__':
    unittest.main()

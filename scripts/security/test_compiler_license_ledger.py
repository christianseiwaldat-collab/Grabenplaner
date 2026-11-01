import base64
import copy
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import compiler_license_ledger as ledger


def fixture_ledger(binary_sha256, image='sha256:' + 'a' * 64):
    text = b'Copyright Synthetic Test Authors\nPermission is granted for this synthetic fixture only.\n'
    source = ledger.source_archive({'COPYING': text, 'source.ml': b'(* synthetic source *)\n'})
    reference = {'filename': 'synthetic-sources.tar.xz', 'bytes': len(source), 'sha256': ledger.digest(source),
                 'url': 'https://example.org/synthetic/source.tar.xz'}
    components = []
    for name, identity, expression in [('opam/synthetic', 'synthetic.1', 'LGPL-2.1-only'),
            ('apk/musl', 'musl.1', 'MIT'), ('custom/curl', 'curl.8.5.0', 'curl'),
            ('upstream/semgrep', 'semgrep-corresponding-source', 'LicenseRef-Upstream-Per-File')]:
        components.append({'name': name, 'version': '1', 'packageIds': [identity], 'licenseExpression': expression,
            'notices': [ledger.notice('COPYING', text)], 'correspondingSource': dict(reference)})
    value = {'format': ledger.FORMAT, 'status': 'complete', 'binarySha256': binary_sha256,
        'reviewReference': 'reviewed-actual-container-closure-v1', 'closure': {'imageId': image,
            'captureSha256': 'c' * 64, 'nativeInputsSha256': 'd' * 64,
            'opamInstalled': ['synthetic.1'], 'nativePackageIds': ['musl.1']}, 'components': components}
    native = {'imageId': image, 'opamPackages': '# installed\nsynthetic 1\n'}
    return value, {'synthetic-sources.tar.xz': source}, native


class CompilerLicenseLedgerTests(unittest.TestCase):
    def setUp(self):
        self.value, self.sources, self.native = fixture_ledger('b' * 64)

    def validate(self):
        ledger.validate_ledger(self.value, 'b' * 64, self.native)
        return ledger.validate_sources(self.value, self.sources.__getitem__)

    def test_actual_set_and_shared_full_source_are_required(self):
        self.assertEqual(len(self.validate()), 1)
        self.assertNotIn('coverage', self.value)
        self.native['opamPackages'] += 'missing-runtime 2\n'
        with self.assertRaisesRegex(ValueError, 'actual qualified image/opam'):
            self.validate()

    def test_smaller_native_set_cannot_hide_an_actual_static_or_header_owner(self):
        self.native.update(nativePackageIds=['gmp.2', 'musl.1'], nativeInputsSha256=self.value['closure']['nativeInputsSha256'])
        with self.assertRaisesRegex(ValueError, 'actual static archive/header'):
            self.validate()

    def test_fresh_native_observation_uses_exact_image_without_network_or_writes(self):
        captured = {'opamListing': self.native['opamPackages'], 'nativeInputs': [
            {'path': '/usr/lib/libc.a', 'bytes': 10, 'sha256': 'e' * 64, 'owner': 'musl.1'},
            {'path': '/usr/local/lib/libcurl.a', 'bytes': 20, 'sha256': 'f' * 64, 'owner': 'custom-curl.8.5.0'}]}
        with patch.object(ledger, 'command', return_value=ledger.encoded(captured)) as run:
            actual = ledger.actual_license_closure(self.native)
        self.assertEqual(actual['nativePackageIds'], ['musl.1'])
        self.assertIn('--network', run.call_args.args[0]); self.assertIn('none', run.call_args.args[0])
        self.assertIn('--read-only', run.call_args.args[0]); self.assertIn(self.native['imageId'], run.call_args.args[0])

    def test_missing_component_cannot_be_replaced_with_coverage_booleans(self):
        self.value['components'].pop(0)
        with self.assertRaisesRegex(ValueError, 'closure is incomplete'):
            self.validate()
        self.value['coverage'] = {'staticallyLinkedDependenciesReviewed': True, 'noticesComplete': True,
                                  'correspondingSourceComplete': True}
        with self.assertRaisesRegex(ValueError, 'incomplete or unbound'):
            self.validate()

    def test_blank_and_fabricated_notices_fail_even_with_matching_self_hashes(self):
        self.value['components'][0]['notices'][0] = ledger.notice('COPYING', b'   x   ')
        with self.assertRaisesRegex(ValueError, 'not present'):
            self.validate()
        self.value['components'][0]['notices'][0]['text'] = ' '
        with self.assertRaisesRegex(ValueError, 'Blank'):
            self.validate()

    def test_no_copyleft_or_permissive_none_source_waiver_exists(self):
        for index in (0, 1):
            with self.subTest(index=index):
                saved = self.value['components'][index]['correspondingSource']
                self.value['components'][index]['correspondingSource'] = None
                with self.assertRaisesRegex(ValueError, 'corresponding source is required'):
                    self.validate()
                self.value['components'][index]['correspondingSource'] = saved

    def test_unknown_license_and_unretained_source_are_rejected(self):
        for expression in ('', ' ', 'UNKNOWN', 'NOASSERTION', 'NONE'):
            self.value['components'][0]['licenseExpression'] = expression
            with self.assertRaisesRegex(ValueError, 'license'):
                self.validate()
        self.value['components'][0]['licenseExpression'] = 'LGPL-2.1-only'
        self.sources['synthetic-sources.tar.xz'] += b'changed'
        with self.assertRaisesRegex(ValueError, 'source bytes differ'):
            self.validate()

    def test_duplicate_component_coverage_or_conflicting_source_is_rejected(self):
        self.value['components'].append(copy.deepcopy(self.value['components'][0]))
        with self.assertRaisesRegex(ValueError, 'license'):
            self.validate()
        self.value['components'].pop()
        self.value['components'][0]['correspondingSource']['url'] = 'https://example.org/other-source'
        with self.assertRaisesRegex(ValueError, 'conflicting identity'):
            self.validate()

    def test_non_utf8_notice_preserves_primary_original_bytes(self):
        notice = ledger.notice('COPYING', b'Copyright Andr\xe9\nPermission synthetic.\n')
        self.assertEqual(notice['encoding'], 'latin1')
        self.assertEqual(notice['sourceBytesSha256'], ledger.digest(notice['text'].encode('latin1')))
        self.assertNotEqual(notice['sourceBytesSha256'], notice['sha256'])

    def test_a_recorded_symlink_target_is_never_a_genuine_license_notice(self):
        self.assertFalse(ledger.notice_candidate('source/LICENSE.symlink-target'))
        source = ledger.source_archive({'LICENSE.symlink-target': b'LICENSE.real'})
        with self.assertRaisesRegex(ValueError, 'no primary license'):
            ledger.archive_notices(source)
        self.assertEqual(ledger.source_notice_hashes(source), set())

    def test_corrupt_source_test_archives_are_not_opened_as_dependency_wrappers(self):
        text = b'Copyright Synthetic Test Authors\nPermission is granted for this fixture.\n'
        original = ledger.source_archive({'COPYING': text, 'tests/bad.tar.gz': b'intentionally invalid gzip fixture'})
        for wrapper in ('source/original-archive', 'distfiles/real-source.tar.xz', 'curl-8.5.0.tar.gz'):
            with self.subTest(wrapper=wrapper):
                source = ledger.source_archive({wrapper: original, 'tests/bad.zip': b'intentionally invalid zip fixture'})
                self.assertEqual(ledger.source_notice_hashes(source), {ledger.digest(text)})
                no_notice = ledger.source_archive({'source.ml': b'only source', 'tests/bad.tar.gz': b'bad fixture'})
                self.assertEqual(ledger.source_notice_hashes(ledger.source_archive({wrapper: no_notice})), set())
        self.assertEqual(ledger.source_notice_hashes(original), {ledger.digest(text)})

    def test_nested_source_payload_is_validated_without_extraction(self):
        files = {'dependency-sources/' + name: data for name, data in self.sources.items()}
        files['upstream/README'] = b'Upstream only\n'
        data = ledger.source_archive(files)
        self.assertEqual(set(ledger.embedded_dependency_sources(data, self.value)), set(self.sources))
        files.clear(); files['upstream/README'] = b'No dependency source'
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            ledger.embedded_dependency_sources(ledger.source_archive(files), self.value)

    def test_path_control_keys_and_source_url_are_checked(self):
        for name in ('../private', '/absolute', 'a//b', 'a\\b', 'a/./b', 'a\nb', 'c:escape'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                ledger.relative(name)
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            ledger.unique(b'{"license":"MIT","license":"NONE"}')
        for url in ('http://example.org/source', 'https://user:secret@example.org/source', 'https://example.org/source?token=secret'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                ledger.https(url)

    def test_indented_actual_opam_metadata_and_exact_sha_are_read(self):
        text = 'license: ["MIT" "ISC"]\nurl {\n  src: "https://example.org/a.tar.gz"\n  checksum: "sha256=' + 'a' * 64 + '"\n}\n'
        self.assertEqual(ledger.field(text, 'license'), ['MIT', 'ISC'])
        self.assertEqual(ledger.source_url(text), ('https://example.org/a.tar.gz', ['sha256=' + 'a' * 64]))
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(ledger, 'download', return_value=b'wrong source'):
                with self.assertRaisesRegex(ValueError, 'checksum differs'):
                    ledger.checked_download('https://example.org/a', ['sha256=' + 'a' * 64], Path(temporary))

    def test_legacy_md5_does_not_authorize_an_unbound_fresh_download(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(ledger, 'download') as download:
            with self.assertRaisesRegex(ValueError, 'captured image bytes'):
                ledger.checked_download('https://example.org/a', ['md5=' + 'a' * 32], Path(temporary))
            download.assert_not_called()

    def test_actual_metadata_only_source_is_retained_under_pinned_repository_license(self):
        package = {'name': 'base-threads', 'version': 'base', 'id': 'base-threads.base',
            'opam': base64.b64encode(b'opam-version: "2.0"\n').decode(), 'install': '', 'changes': '',
            'sourceDirectory': None, 'sourcePin': None}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); output = root / 'output'; output.mkdir()
            primary = b'Creative Commons CC0 1.0 Universal\nSynthetic repository metadata license fixture.\n'
            with patch.object(ledger, 'download', return_value=primary) as fetched:
                components = ledger.collect_opam({'opamPackages': [package]}, root, output)
            self.assertTrue(fetched.call_args.args[0].endswith('/COPYING'))
            self.assertEqual(components[0]['licenseExpression'], 'CC0-1.0')
            self.assertIsNotNone(components[0]['correspondingSource'])
            ledger.validate_sources({'components': components}, lambda name: (output / name).read_bytes())
            package['install'] = base64.b64encode(b'lib: ["runtime.cmx"]\n').decode()
            with patch.object(ledger, 'download', return_value=primary), self.assertRaisesRegex(ValueError, 'no retained corresponding source'):
                ledger.collect_opam({'opamPackages': [package]}, root, output)

    def test_actual_cached_opam_archive_keeps_primary_notices_and_exact_source_bytes(self):
        primary = b'Copyright Synthetic Authors\nPermission is granted for the synthetic package.\n'
        source = ledger.source_archive({'pkg/COPYING': primary, 'pkg/source.ml': b'synthetic source'})
        sha = ledger.digest(source)
        definition = ('opam-version: "2.0"\nlicense: "MIT"\nurl {\n  src: "https://example.org/pkg.tar.xz"\n'
            '  checksum: "sha256=' + sha + '"\n}\n').encode()
        package = {'name': 'pkg', 'version': '1', 'id': 'pkg.1', 'opam': base64.b64encode(definition).decode(),
            'install': '', 'changes': '', 'sourceDirectory': None, 'sourcePin': None}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); output = root / 'output'; output.mkdir()
            cache = root / 'opam-download-cache/sha256' / sha[:2]; cache.mkdir(parents=True)
            (cache / sha).write_bytes(source)
            with patch.object(ledger, 'download', return_value=b'CC0 repository fixture\n') as fetched:
                components = ledger.collect_opam({'opamPackages': [package]}, root, output)
            self.assertEqual(fetched.call_count, 1)
            self.assertEqual(components[0]['notices'][0]['sourceBytesSha256'], ledger.digest(primary))
            ledger.validate_sources({'components': components}, lambda name: (output / name).read_bytes())

    def test_failed_source_collection_preserves_inventory_report_and_does_not_create_a_ledger(self):
        import publish_semgrep_core_tool as publisher
        import build_semgrep_source as build
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); output = root / 'output'; qualification = root / 'qualification'; qualification.mkdir()
            binary = root / 'core'; binary.write_bytes(b'synthetic qualified core')
            image = root / 'image'; image.write_text(self.native['imageId'])
            native = {**self.native, 'baseImage': build.ALPINE}
            report = {'phase': 'captured', 'publicationReady': False}
            def captured(*args):
                capture_root = output / 'capture'; capture_root.mkdir()
                return {'opamListing': self.native['opamPackages']}, capture_root, report
            with patch.object(publisher, 'validate_qualification', return_value=({}, native)), \
                    patch.object(ledger, 'capture_image', side_effect=captured), patch.object(ledger, 'verify_capture'), \
                    patch.object(ledger, 'collect_opam', side_effect=ValueError('synthetic missing primary license')):
                with self.assertRaisesRegex(ValueError, 'missing primary license'):
                    ledger.produce(image, binary, root, qualification, output)
            actual = ledger.unique((qualification / 'sourcebuild-compiler-license-review.json').read_bytes())
            self.assertEqual(actual['phase'], 'source-or-license-collection-failed')
            self.assertFalse(actual['publicationReady']); self.assertFalse((output / 'ledger.json').exists())

    def test_capture_retains_only_explicit_upstream_paths_and_checks_all_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = {'capture.json': ledger.encoded({'imageId': self.native['imageId']}),
                     'opam-sources/synthetic.1/LICENSE': b'Copyright synthetic source\n'}
            data = ledger.source_archive(files)
            receipt = {'format': ledger.CAPTURE, 'archive': {'bytes': len(data), 'sha256': ledger.digest(data)},
                'imageId': self.native['imageId'], 'binarySha256': 'b' * 64, 'upstreamOnly': True,
                'compilerRebuilt': False, 'memberInventory': [{'path': name, 'bytes': len(content), 'sha256': ledger.digest(content)}
                    for name, content in sorted(files.items())]}
            (root / 'capture.tar.xz').write_bytes(data); (root / 'capture-receipt.json').write_bytes(ledger.encoded(receipt))
            self.assertEqual(ledger.verify_capture(root), receipt)
            files['private-gp-evidence/server.js'] = b'never publish'
            data = ledger.source_archive(files); (root / 'capture.tar.xz').write_bytes(data)
            receipt['archive'] = {'bytes': len(data), 'sha256': ledger.digest(data)}
            (root / 'capture-receipt.json').write_bytes(ledger.encoded(receipt))
            with self.assertRaisesRegex(ValueError, 'Unexpected compiler capture'):
                ledger.verify_capture(root)


if __name__ == '__main__':
    unittest.main()

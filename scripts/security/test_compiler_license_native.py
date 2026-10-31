import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import compiler_license_native as native


def tar_bytes(files, mode='w:gz'):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode=mode) as archive:
        for name, content in files.items():
            item = tarfile.TarInfo(name)
            item.size = len(content)
            archive.addfile(item, io.BytesIO(content))
    return stream.getvalue()


class NativeLicenseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.sources = self.root / 'sources'
        self.sources.mkdir()
        self.commit = 'a' * 40
        self.notice = (b'Copyright actual upstream authors.\nPermission to use, copy, modify and distribute this source is granted.\n')
        self.source = tar_bytes({'native-1.0/LICENSE': self.notice, 'native-1.0/native.c': b'int native(void) { return 1; }\n'})
        self.recipe = ('pkgname=native\npkgver=1.0\npkgrel=2\nsha512sums="\n' + hashlib.sha512(self.source).hexdigest() + '  native-1.0.tar.gz\n"\n').encode()
        self.aports = tar_bytes({'aports-' + self.commit + '/main/native/APKBUILD': self.recipe,
            'aports-' + self.commit + '/main/unrelated/SECRET': b'not part of selected recipe'})
        self.package = {'name': 'native-static', 'version': '1.0-r2', 'id': 'native-static.1.0-r2',
            'origin': 'native', 'commit': self.commit, 'licenseExpression': 'MIT', 'url': 'https://example.invalid'}
        self.capture = {'apkPackages': [self.package], 'nativeInputs': [{'path': '/usr/lib/libnative.a',
            'bytes': 1, 'sha256': 'b' * 64, 'owner': self.package['id']}]}

    def collect(self, source=None, aports=None):
        def download(url, maximum=native.MAX_DOWNLOAD):
            return (aports or self.aports) if 'codeload.github.com' in url else self.source if source is None else source
        with patch.object(native, 'download', side_effect=download):
            return native.collect_native(self.capture, self.root, self.sources)

    def test_actual_owner_checksum_source_and_genuine_notice_are_all_bound(self):
        values = self.collect()
        self.assertEqual(len(values), 1)
        self.assertEqual(values[0]['packageIds'], ['native-static.1.0-r2'])
        self.assertEqual(values[0]['notices'][0]['text'], self.notice.decode())
        data = (self.sources / values[0]['correspondingSource']['filename']).read_bytes()
        self.assertEqual(native.sha(data), values[0]['correspondingSource']['sha256'])
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
            self.assertEqual(set(archive.getnames()), {'aports/APKBUILD', 'distfiles/native-1.0.tar.gz', 'native-source-metadata.json'})

    def test_wrong_distfile_hash_is_rejected_without_publishing_source(self):
        with self.assertRaisesRegex(ValueError, 'SHA-512'):
            self.collect(source=b'corrupt source')
        self.assertEqual(list(self.sources.iterdir()), [])

    def test_unknown_actual_static_owner_is_rejected(self):
        self.capture['nativeInputs'][0]['owner'] = 'unowned'
        with self.assertRaisesRegex(ValueError, 'owner'):
            self.collect()

    def test_installed_version_and_aports_identity_must_match(self):
        self.package['version'] = '2.0-r0'
        self.package['id'] = 'native-static.2.0-r0'
        self.capture['nativeInputs'][0]['owner'] = self.package['id']
        with self.assertRaisesRegex(ValueError, 'version differs'):
            self.collect()

    def test_skip_dynamic_and_duplicate_checksum_declarations_are_rejected(self):
        invalid = [b'pkgver=1.0\npkgrel=2\nsha512sums="SKIP native-1.0.tar.gz"\n',
            self.recipe + b'sha512sums="$sha512sums extra"\n', self.recipe.replace(b'pkgver=1.0', b'pkgver=$(evil)')]
        for content in invalid:
            with self.subTest(content=content), self.assertRaises(ValueError):
                native.recipe_checksums(content, '1.0-r2')

    def test_missing_license_text_fails_even_if_metadata_claims_MIT(self):
        source = tar_bytes({'native-1.0/native.c': b'no license here'})
        recipe = self.recipe.replace(hashlib.sha512(self.source).hexdigest().encode(), hashlib.sha512(source).hexdigest().encode())
        aports = tar_bytes({'aports-' + self.commit + '/main/native/APKBUILD': recipe})
        with self.assertRaisesRegex(ValueError, 'license text'):
            self.collect(source=source, aports=aports)

    def test_empty_or_binary_notices_are_not_primary_license_evidence(self):
        for content in [b'', b' ', b'\0' * 200, b'\x01' * 200]:
            self.assertIsNone(native._notice('LICENSE', content))

    def test_unsafe_archive_paths_and_links_are_rejected(self):
        for name in ['../LICENSE', '/LICENSE', 'C:/LICENSE', 'a\\LICENSE']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                native.source_notices('source.tar.gz', tar_bytes({name: self.notice}))

    def test_source_recipe_never_runs_shell_and_rejects_unknown_origin(self):
        aports = tar_bytes({'aports-' + self.commit + '/main/other/APKBUILD': self.recipe})
        with self.assertRaisesRegex(ValueError, 'origin not found'):
            self.collect(aports=aports)

    def test_same_origin_subpackages_share_one_verified_source(self):
        duplicate = {**self.package, 'name': 'native-dev', 'id': 'native-dev.1.0-r2'}
        self.capture['apkPackages'].append(duplicate)
        self.capture['nativeInputs'].append({'path': '/usr/include/native.h', 'bytes': 1, 'sha256': 'c' * 64, 'owner': duplicate['id']})
        values = self.collect()
        self.assertEqual(values[0]['packageIds'], ['native-dev.1.0-r2', 'native-static.1.0-r2'])
        self.assertEqual(len(list(self.sources.iterdir())), 1)


if __name__ == '__main__':
    unittest.main()

import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
import urllib.request
from unittest.mock import MagicMock, patch

import compiler_license_ledger as ledger


class CompilerSourceTransportTests(unittest.TestCase):
    def _alias(self, target, link):
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError) as error:
            if os.name != 'nt':
                raise
            self.skipTest('This host cannot create the relative cache-alias fixture: ' + type(error).__name__)

    def test_actual_relative_checksum_alias_uses_only_captured_bytes_even_for_legacy_md5(self):
        data = b'actual private captured source fixture'
        expected = hashlib.md5(data).hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / 'cache'; cache.mkdir()
            blob = cache / 'sha512/object'; blob.parent.mkdir(); blob.write_bytes(data)
            alias = cache / 'md5' / expected[:2] / expected; alias.parent.mkdir(parents=True)
            self._alias('../../sha512/object', alias)
            with patch.object(ledger, 'download') as fetch:
                self.assertEqual(ledger.checked_download('https://example.invalid/source', ['md5=' + expected], cache), data)
                fetch.assert_not_called()
            blob.write_bytes(b'changed image cache bytes')
            with patch.object(ledger, 'download') as fetch, self.assertRaisesRegex(ValueError, 'checksum differs'):
                ledger.checked_download('https://example.invalid/source', ['md5=' + expected], cache)
            fetch.assert_not_called()

    def test_checksum_alias_cannot_escape_cache_or_become_general_link_following(self):
        data = b'outside fixture'
        expected = hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); cache = root / 'cache'; cache.mkdir()
            outside = root / 'outside'; outside.write_bytes(data)
            alias = cache / 'sha256' / expected[:2] / expected; alias.parent.mkdir(parents=True)
            self._alias('../../../outside', alias)
            with patch.object(ledger, 'download') as fetch, self.assertRaisesRegex(ValueError, 'escapes'):
                ledger.checked_download('https://example.invalid/source', ['sha256=' + expected], cache)
            fetch.assert_not_called()
            with self.assertRaises(ValueError): ledger.regular(alias)

    def test_real_opam_inline_close_and_quoted_braces_keep_exact_source_checksums(self):
        text = 'url {\n  src: "https://example.invalid/rresult-{literal}.tbz"\n  checksum: "sha512=' + 'a' * 128 + '"}\n'
        self.assertEqual(ledger.source_url(text), ('https://example.invalid/rresult-{literal}.tbz', ['sha512=' + 'a' * 128]))
        for malformed in (text + text, text[:-3], 'url { src: "unterminated }'):
            with self.subTest(malformed=malformed), self.assertRaises(ValueError): ledger.source_url(malformed)

    def test_signed_https_transport_does_not_become_persistent_provenance(self):
        original = 'https://example.invalid/release/source.tar.gz'
        transient = 'https://release-assets.githubusercontent.com/source?signature=transient-test-value'
        response = MagicMock(); response.url = transient
        response.read.return_value = b'actual downloaded source'
        opener = MagicMock(); opener.open.return_value.__enter__.return_value = response
        with patch.object(ledger.urllib.request, 'build_opener', return_value=opener):
            self.assertEqual(ledger.download(original, maximum=100), b'actual downloaded source')
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, original)
        self.assertNotIn('signature', request.full_url)
        with self.assertRaises(ValueError): ledger.https(transient)

    def test_redirect_rejects_downgrade_credentials_fragments_and_control_characters(self):
        handler = ledger.SourceRedirectHandler()
        request = urllib.request.Request('https://example.invalid/source')
        for target in ('http://example.invalid/source', 'file:///tmp/source',
                'https://user:secret@example.invalid/source', 'https://@example.invalid/source',
                'https://example.invalid/source#fragment', 'https://example.invalid/source\r\nx:x'):
            with self.subTest(target=target), self.assertRaises(ValueError):
                handler.redirect_request(request, None, 302, '', {}, target)
        redirected = handler.redirect_request(urllib.request.Request('https://example.invalid/source',
            headers={'Authorization': 'fixture', 'Cookie': 'fixture', 'Proxy-Authorization': 'fixture'}),
            None, 302, '', {}, 'https://cdn.example.invalid/source?signature=fixture')
        for key in ('Authorization', 'Cookie', 'Proxy-Authorization'):
            self.assertFalse(redirected.has_header(key))

    def test_transport_keeps_original_url_and_size_and_checksum_requirements(self):
        with patch.object(ledger.urllib.request, 'build_opener') as factory:
            for target in ('http://example.invalid/source', 'https://example.invalid/source?credential=fixture'):
                with self.subTest(target=target), self.assertRaises(ValueError): ledger.download(target)
            factory.assert_not_called()
        response = MagicMock(); response.url = 'https://cdn.example.invalid/source?signature=fixture'
        response.read.return_value = b'oversized'
        opener = MagicMock(); opener.open.return_value.__enter__.return_value = response
        with patch.object(ledger.urllib.request, 'build_opener', return_value=opener), self.assertRaises(ValueError):
            ledger.download('https://example.invalid/source', maximum=2)
        with tempfile.TemporaryDirectory() as temporary, patch.object(ledger, 'download', return_value=b'wrong bytes'):
            with self.assertRaises(ValueError):
                ledger.checked_download('https://example.invalid/source', ['sha256=' + 'a' * 64], Path(temporary))

    def test_unix_afl_names_remain_opaque_and_complete_without_weakening_output_paths(self):
        name = 'pecu/test/contents/id:000000,src:000001'
        self.assertEqual(ledger.source_relative(name), name)
        with self.assertRaises(ValueError): ledger.relative(name)
        files = {name: b'original fuzz bytes', 'pecu/LICENSE.md': b'Original source notice fixture'}
        raw = ledger.source_archive(files)
        with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
            self.assertEqual(archive.extractfile(name).read(), files[name])
        notices = ledger.archive_notices(raw)
        self.assertEqual(len(notices), 1)
        self.assertIn(ledger.digest(files['pecu/LICENSE.md']), ledger.source_notice_hashes(raw))
        for invalid in ('.', '../escape', '/absolute', 'a/../escape', 'C:/drive', 'source/C:drive',
                'source\\file', 'source//file', 'source/\x00file'):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError): ledger.source_relative(invalid)


if __name__ == '__main__':
    unittest.main()

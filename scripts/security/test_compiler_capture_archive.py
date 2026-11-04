import hashlib
import io
import json
import lzma
import os
from pathlib import Path
import stat
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import compiler_capture_archive as capture


IMAGE = 'sha256:' + 'a' * 64
BINARY = 'b' * 64


class CaptureArchiveTests(unittest.TestCase):
    def fixture(self, root, observation=b'{"captureComplete":false,"publicationReady":false}\n'):
        source, output = root / 'capture', root / 'output'
        source.mkdir(mode=0o700)
        output.mkdir(mode=0o700)
        (source / 'capture.json').write_bytes(observation)
        return source, output

    def original(self, source, name='probe/source.ml', data=b'let fixture = 1\n'):
        file = source / 'opam-sources' / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
        return file

    def symlink(self, target, path, directory=False):
        try:
            os.symlink(target, path, target_is_directory=directory)
        except (OSError, NotImplementedError) as error:
            if os.name != 'nt':
                raise
            self.skipTest('Windows host lacks source-link fixture permission: ' + type(error).__name__)

    def receipt(self, output):
        return json.loads((output / 'capture-receipt.json').read_bytes())

    def put_receipt(self, output, value):
        (output / 'capture-receipt.json').write_bytes(capture._encoded(value))

    def archive(self, output, members, inventory=None, tail=b''):
        buffer = io.BytesIO()
        actual = []
        with tarfile.open(fileobj=buffer, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for name, data, kind in members:
                info = tarfile.TarInfo(name)
                info.size = len(data) if kind == tarfile.REGTYPE else 0
                info.type, info.mode = kind, 0o644
                info.uid = info.gid = info.mtime = 0
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    info.linkname = '../outside'
                archive.addfile(info, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
                actual.append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        raw = lzma.compress(buffer.getvalue() + tail, preset=0)
        (output / 'capture.tar.xz').write_bytes(raw)
        receipt = {'format': capture.CAPTURE, 'archive': {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()},
            'imageId': IMAGE, 'binarySha256': BINARY, 'upstreamOnly': True, 'compilerRebuilt': False,
            'memberInventory': actual if inventory is None else inventory}
        self.put_receipt(output, receipt)
        return receipt

    def test_stream_roundtrip_preserves_empty_bytes_and_partial_observation_without_authority(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = self.fixture(Path(temporary))
            self.original(source, 'probe/empty', b'')
            self.original(source, data=b'actual upstream source\x00bytes')
            result = capture.write_capture(source, output, IMAGE, BINARY)
            self.assertEqual(capture.verify_capture(output), result)
            self.assertEqual(set(result), {'format', 'archive', 'imageId', 'binarySha256', 'upstreamOnly', 'compilerRebuilt', 'memberInventory'})
            self.assertNotIn('publicationReady', result)
            self.assertNotIn('captureComplete', result)
            empty = next(row for row in result['memberInventory'] if row['path'].endswith('/empty'))
            self.assertEqual(empty['bytes'], 0)
            self.assertEqual(empty['sha256'], hashlib.sha256(b'').hexdigest())
            with tarfile.open(output / 'capture.tar.xz') as archive:
                self.assertFalse(json.loads(archive.extractfile('capture.json').read())['captureComplete'])
            if os.name == 'posix':
                self.assertEqual(stat.S_IMODE((output / 'capture.tar.xz').stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE((output / 'capture-receipt.json').stat().st_mode), 0o600)

    def test_actual_empty_tree_is_only_an_empty_diagnostic_capture(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = self.fixture(Path(temporary))
            (source / 'capture.json').unlink()
            result = capture.write_capture(source, output, IMAGE, BINARY)
            self.assertEqual(result['memberInventory'], [])
            self.assertEqual(capture.verify_capture(output), result)

    def test_scaled_aggregate_exceeds_old_two_gib_boundary_without_large_files_or_reads(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = self.fixture(Path(temporary), b'{}')
            for i in range(4):
                self.original(source, 'probe/part' + str(i), b'original\n' * 125)
            old_reduced_bound = 4096
            with patch.object(capture, 'MAX_FILE', 2048), patch.object(capture, 'MAX_ARCHIVE', 4096), patch.object(capture, 'MAX_EXPANDED', 16384):
                result = capture.write_capture(source, output, IMAGE, BINARY)
                self.assertGreater(sum(row['bytes'] for row in result['memberInventory']), old_reduced_bound)
                self.assertEqual(capture.verify_capture(output), result)
            self.assertEqual(capture.MAX_EXPANDED, 8 * 1024**3)
            self.assertEqual(capture.MAX_ARCHIVE, 2 * 1024**3)
            self.assertEqual(capture.MAX_FILE, 512 * 1024**2)

    def test_pax_unicode_long_and_opaque_unix_names_remain_exact(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = self.fixture(Path(temporary))
            # A drive-like path component remains forbidden; AFL's colon is opaque.
            if os.name == 'posix':
                self.original(source, 'probe/id:000000,src:000001', b'opaque source')
            else:
                self.assertEqual(capture.source_relative('opam-sources/probe/id:000000,src:000001'), 'opam-sources/probe/id:000000,src:000001')
            self.original(source, 'probe/' + 'long-name-' * 14 + '/Größe.ml', b'let value = 1')
            result = capture.write_capture(source, output, IMAGE, BINARY)
            self.assertEqual(capture.verify_capture(output), result)
            self.assertTrue(any('Größe' in row['path'] for row in result['memberInventory']))
        # The archive member remains an opaque Unix name on Windows too, where
        # constructing a local file with that name would be invalid syntax.
        with tempfile.TemporaryDirectory() as temporary:
            _source, output = self.fixture(Path(temporary))
            result = self.archive(output, [('opam-sources/probe/id:000000,src:000001', b'opaque', tarfile.REGTYPE)])
            self.assertEqual(capture.verify_capture(output), result)

    def test_reserved_git_and_build_directories_keep_existing_exclusion(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = self.fixture(Path(temporary))
            self.original(source, 'probe/.git/secret', b'not retained')
            self.original(source, 'probe/_build/large', b'not retained')
            self.original(source, 'probe/kept', b'upstream source')
            result = capture.write_capture(source, output, IMAGE, BINARY)
            self.assertEqual([r['path'] for r in result['memberInventory']], ['capture.json', 'opam-sources/probe/kept'])
            capture.verify_capture(output)

    def test_symlink_target_text_is_retained_without_opening_or_inventorying_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, output = self.fixture(root)
            outside = root / 'outside'; outside.mkdir()
            (outside / 'secret').write_bytes(b'outside secret must not enter archive')
            file = self.original(source)
            self.symlink(str(outside / 'secret'), file.parent / 'file-link')
            self.symlink(str(outside), file.parent / 'directory-link', directory=True)
            result = capture.write_capture(source, output, IMAGE, BINARY)
            self.assertEqual(capture.verify_capture(output), result)
            names = [row['path'] for row in result['memberInventory']]
            self.assertIn('opam-sources/probe/file-link.symlink-target', names)
            self.assertIn('opam-sources/probe/directory-link.symlink-target', names)
            self.assertFalse(any(name.endswith('/secret') for name in names))
            with tarfile.open(output / 'capture.tar.xz') as archive:
                self.assertEqual(archive.extractfile('opam-sources/probe/file-link.symlink-target').read(), os.fsencode(str(outside / 'secret')))

    def test_hardlinked_source_is_rejected_and_partial_outputs_are_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = self.fixture(Path(temporary))
            file = self.original(source)
            os.link(file, file.parent / 'second-link')
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                capture.write_capture(source, output, IMAGE, BINARY)
            self.assertFalse((output / 'capture.tar.xz').exists())
            self.assertFalse((output / 'capture-receipt.json').exists())

    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'POSIX FIFO fixture requires Linux')
    def test_fifo_is_rejected_before_open_and_cannot_block_capture(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = self.fixture(Path(temporary))
            file = self.original(source)
            os.mkfifo(file.parent / 'fifo')
            with self.assertRaisesRegex(ValueError, 'source type'):
                capture.write_capture(source, output, IMAGE, BINARY)
            self.assertFalse((output / 'capture.tar.xz').exists())

    def test_no_overwrite_even_when_only_one_existing_result_is_present(self):
        for name in ('capture.tar.xz', 'capture-receipt.json'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                source, output = self.fixture(Path(temporary))
                original = output / name; original.write_bytes(b'preserve earlier evidence')
                with self.assertRaisesRegex(ValueError, 'already exists'):
                    capture.write_capture(source, output, IMAGE, BINARY)
                self.assertEqual(original.read_bytes(), b'preserve earlier evidence')

    def test_output_inside_capture_tree_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, _output = self.fixture(Path(temporary))
            nested = source / 'output'; nested.mkdir(mode=0o700)
            with self.assertRaisesRegex(ValueError, 'inside source'):
                capture.write_capture(source, nested, IMAGE, BINARY)

    def test_linked_input_or_output_root_is_rejected(self):
        for which in ('input', 'output'):
            with self.subTest(which=which), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); source, output = self.fixture(root)
                link = root / 'linked'
                self.symlink(str(source if which == 'input' else output), link, directory=True)
                with self.assertRaisesRegex(ValueError, 'canonical'):
                    capture.write_capture(link if which == 'input' else source, link if which == 'output' else output, IMAGE, BINARY)

    @unittest.skipUnless(os.name == 'posix', 'POSIX mode enforcement requires Linux')
    def test_public_capture_root_or_output_is_rejected(self):
        for which in ('input', 'output'):
            with self.subTest(which=which), tempfile.TemporaryDirectory() as temporary:
                source, output = self.fixture(Path(temporary))
                (source if which == 'input' else output).chmod(0o755)
                with self.assertRaisesRegex(ValueError, 'private'):
                    capture.write_capture(source, output, IMAGE, BINARY)

    def test_foreign_owner_is_rejected_but_current_and_root_are_permitted(self):
        with patch.object(capture, '_POSIX_FDS', True), patch.object(capture.os, 'geteuid', return_value=1234, create=True):
            capture._owner(SimpleNamespace(st_uid=0))
            capture._owner(SimpleNamespace(st_uid=1234))
            with self.assertRaisesRegex(ValueError, 'Foreign'):
                capture._owner(SimpleNamespace(st_uid=4321))

    def test_file_member_count_expanded_compressed_and_json_bounds_fail_closed(self):
        for constant, bound in (('MAX_FILE', 3), ('MAX_MEMBERS', 1), ('MAX_EXPANDED', 512), ('MAX_ARCHIVE', 16), ('MAX_JSON', 128)):
            with self.subTest(constant=constant), tempfile.TemporaryDirectory() as temporary:
                source, output = self.fixture(Path(temporary), b'{}')
                self.original(source, data=b'nonempty source')
                with patch.object(capture, constant, bound), self.assertRaises(ValueError):
                    capture.write_capture(source, output, IMAGE, BINARY)
                self.assertFalse((output / 'capture.tar.xz').exists())
                self.assertFalse((output / 'capture-receipt.json').exists())

    def test_concurrent_source_content_change_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = self.fixture(Path(temporary))
            file = self.original(source, data=b'original data')
            read = capture._Regular.read
            changed = False
            def mutate(reader, size):
                nonlocal changed
                result = read(reader, size)
                if reader.name == file.name and result and not changed:
                    changed = True
                    file.write_bytes(b'different data')
                return result
            with patch.object(capture._Regular, 'read', mutate), self.assertRaisesRegex(ValueError, 'Changed'):
                capture.write_capture(source, output, IMAGE, BINARY)
            self.assertTrue(changed)
            self.assertFalse((output / 'capture.tar.xz').exists())

    def test_manifest_and_archive_mismatches_and_wrong_identity_are_rejected(self):
        for change in ('hash', 'size', 'path', 'missing', 'duplicate', 'archive-hash', 'image', 'boolean', 'extra-key'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                source, output = self.fixture(Path(temporary))
                value = capture.write_capture(source, output, IMAGE, BINARY)
                if change == 'hash': value['memberInventory'][0]['sha256'] = 'c' * 64
                if change == 'size': value['memberInventory'][0]['bytes'] += 1
                if change == 'path': value['memberInventory'][0]['path'] = 'opam-sources/other'
                if change == 'missing': value['memberInventory'] = []
                if change == 'duplicate': value['memberInventory'] *= 2
                if change == 'archive-hash': value['archive']['sha256'] = 'd' * 64
                if change == 'image': value['imageId'] = 'mutable:tag'
                if change == 'boolean': value['memberInventory'][0]['bytes'] = True
                if change == 'extra-key': value['publicationReady'] = True
                self.put_receipt(output, value)
                with self.assertRaises(ValueError): capture.verify_capture(output)

    def test_tar_traversal_unknown_names_links_devices_and_duplicate_members_are_rejected(self):
        for name, kind in (('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE), ('opam-sources/C:drive', tarfile.REGTYPE),
                ('unknown', tarfile.REGTYPE), ('opam-sources/link', tarfile.SYMTYPE), ('opam-sources/hardlink', tarfile.LNKTYPE),
                ('opam-sources/fifo', tarfile.FIFOTYPE), ('opam-sources/device', tarfile.CHRTYPE)):
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as temporary:
                _source, output = self.fixture(Path(temporary))
                self.archive(output, [(name, b'fixture', kind)])
                with self.assertRaises(ValueError): capture.verify_capture(output)
        with tempfile.TemporaryDirectory() as temporary:
            _source, output = self.fixture(Path(temporary))
            self.archive(output, [('capture.json', b'{}', tarfile.REGTYPE)] * 2)
            with self.assertRaises(ValueError): capture.verify_capture(output)

    def test_extra_tar_payload_or_concatenated_xz_stream_is_rejected(self):
        for kind in ('tar-tail', 'compressed-tail'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                _source, output = self.fixture(Path(temporary))
                value = self.archive(output, [('capture.json', b'{}', tarfile.REGTYPE)], tail=b'hidden' if kind == 'tar-tail' else b'')
                if kind == 'compressed-tail':
                    file = output / 'capture.tar.xz'
                    raw = file.read_bytes() + lzma.compress(b'hidden', preset=0)
                    file.write_bytes(raw)
                    value['archive'] = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
                    self.put_receipt(output, value)
                with self.assertRaises(ValueError): capture.verify_capture(output)

    def test_verifier_enforces_actual_member_and_decompression_bounds(self):
        for constant, bound in (('MAX_FILE', 1), ('MAX_MEMBERS', 0), ('MAX_EXPANDED', 512), ('MAX_ARCHIVE', 8), ('MAX_JSON', 16), ('MAX_XZ_MEMORY', 1)):
            with self.subTest(constant=constant), tempfile.TemporaryDirectory() as temporary:
                source, output = self.fixture(Path(temporary))
                capture.write_capture(source, output, IMAGE, BINARY)
                with patch.object(capture, constant, bound), self.assertRaises((ValueError, lzma.LZMAError)):
                    capture.verify_capture(output)

    def test_duplicate_json_keys_and_hardlinked_archive_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = self.fixture(Path(temporary))
            capture.write_capture(source, output, IMAGE, BINARY)
            receipt = output / 'capture-receipt.json'
            receipt.write_bytes(b'{"format":"first","format":"second"}')
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                capture.verify_capture(output)
        with tempfile.TemporaryDirectory() as temporary:
            source, output = self.fixture(Path(temporary))
            capture.write_capture(source, output, IMAGE, BINARY)
            os.link(output / 'capture.tar.xz', output / 'second-link')
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                capture.verify_capture(output)

    def test_oversized_pax_header_is_rejected_without_allocating_its_claimed_payload(self):
        with tempfile.TemporaryDirectory() as temporary:
            _source, output = self.fixture(Path(temporary))
            value = self.archive(output, [])
            header = tarfile.TarInfo('././@PaxHeader')
            header.type, header.size = tarfile.XHDTYPE, capture.MAX_PAX + 1
            raw = lzma.compress(header.tobuf() + b'\0' * 1024, preset=0)
            (output / 'capture.tar.xz').write_bytes(raw)
            value['archive'] = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
            self.put_receipt(output, value)
            exact = capture._exact
            requests = []
            def bounded(stream, count):
                requests.append(count)
                return exact(stream, count)
            with patch.object(capture, '_exact', bounded), self.assertRaisesRegex(ValueError, 'PAX'):
                capture.verify_capture(output)
            self.assertEqual(requests, [512])

    def test_truncated_compressed_capture_cannot_receive_a_matching_partial_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = self.fixture(Path(temporary))
            value = capture.write_capture(source, output, IMAGE, BINARY)
            file = output / 'capture.tar.xz'
            raw = file.read_bytes()[:-8]
            file.write_bytes(raw)
            value['archive'] = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
            self.put_receipt(output, value)
            with self.assertRaisesRegex(ValueError, 'compressed|stream'):
                capture.verify_capture(output)


if __name__ == '__main__':
    unittest.main()

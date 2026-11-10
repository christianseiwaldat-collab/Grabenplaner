"""Integrity and drift controls for the dependency-only scanner repair."""
import base64
import csv
import hashlib
import io
from pathlib import Path
import re
import tempfile
import unittest
import warnings
import zipfile

import install_semgrep_runtime as installer


class ScannerWheelRepairTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.source = self.directory / 'source.whl'
        self.destination = self.directory / 'repaired.whl'
        self.metadata = ('Metadata-Version: 2.4\nName: semgrep\nVersion: 1.181.0\n'
                         + ''.join('Requires-Dist: ' + name + '\n'
                                   for name in installer.REPLACEMENTS)
                         + 'Requires-Dist: attrs>=21.3\n\nOriginal description.\n').encode()
        self.members = {
            installer.DIST + 'METADATA': self.metadata,
            installer.DIST + 'RECORD': b'original record\n',
            installer.DIST + 'entry_points.txt': b'[console_scripts]\nsemgrep=semgrep:main\n',
            'semgrep/__init__.py': b'# original source\n',
            'semgrep/bin/semgrep-core': b'\x7fELF\x00original native bytes',
        }

    def wheel(self, extra=None):
        with zipfile.ZipFile(self.source, 'w') as archive:
            for name, data in self.members.items():
                archive.writestr(name, data)
            if extra:
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore', UserWarning)
                    name, data = extra
                    header = zipfile.ZipInfo('temporary')
                    header.filename = name
                    archive.writestr(header, data)
        return {'bytes': self.source.stat().st_size, 'sha256': installer.digest(self.source)}

    def test_only_dependency_metadata_and_record_change(self):
        asset = self.wheel()
        installer.repair_wheel(self.source, self.destination, asset)
        with zipfile.ZipFile(self.destination) as archive:
            self.assertEqual(set(archive.namelist()), set(self.members))
            metadata = archive.read(installer.DIST + 'METADATA')
            self.assertEqual(installer.dependencies(metadata),
                             list(installer.REPLACEMENTS.values()) + ['attrs>=21.3'])
            self.assertTrue(metadata.endswith(b'Original description.\n'))
            for name, data in self.members.items():
                if name not in (installer.DIST + 'METADATA', installer.DIST + 'RECORD'):
                    self.assertEqual(archive.read(name), data, name)
            records = list(csv.reader(io.StringIO(archive.read(installer.DIST + 'RECORD').decode())))
            self.assertEqual(len(records), len(self.members))
            for name, hashed, size in records:
                if name == installer.DIST + 'RECORD':
                    self.assertEqual([hashed, size], ['', ''])
                else:
                    data = archive.read(name)
                    expected = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=')
                    self.assertEqual(hashed, 'sha256=' + expected.decode())
                    self.assertEqual(int(size), len(data))

    def test_repaired_wheel_has_a_reproducible_digest(self):
        asset = self.wheel()
        installer.repair_wheel(self.source, self.destination, asset)
        other = self.directory / 'other.whl'
        installer.repair_wheel(self.source, other, asset)
        self.assertEqual(installer.digest(self.destination), installer.digest(other))

    def test_windows_metadata_preserves_original_crlf_bytes(self):
        source = self.metadata.replace(b'\n', b'\r\n')
        repaired = installer.repair_metadata(source)
        expected = source
        for before, after in installer.REPLACEMENTS.items():
            expected = expected.replace(('Requires-Dist: ' + before + '\r\n').encode(),
                                        ('Requires-Dist: ' + after + '\r\n').encode())
        self.assertEqual(repaired, expected)

    def test_wrong_original_hash_or_size_blocks_before_output(self):
        asset = self.wheel()
        for bad in ({**asset, 'sha256': '0' * 64}, {**asset, 'bytes': asset['bytes'] + 1}):
            with self.subTest(asset=bad), self.assertRaisesRegex(ValueError, 'integrity'):
                installer.repair_wheel(self.source, self.destination, bad)
            self.assertFalse(self.destination.exists())

    def test_missing_duplicate_or_changed_dependency_pin_blocks(self):
        line = b'Requires-Dist: mcp==1.29.0\n'
        for bad in (self.metadata.replace(line, b''), self.metadata + line,
                    self.metadata.replace(b'mcp==1.29.0', b'mcp==1.29.1')):
            with self.subTest(metadata=bad), self.assertRaisesRegex(ValueError, 'drift'):
                installer.repair_metadata(bad)

    def test_duplicate_and_unsafe_archive_members_block(self):
        for member in ('semgrep/__init__.py', '../escape.py', '/absolute.py', 'semgrep\\bad.py'):
            asset = self.wheel((member, b'bad'))
            with self.subTest(member=member), self.assertRaises(ValueError):
                installer.repair_wheel(self.source, self.destination, asset)
            self.assertFalse(self.destination.exists())

    def test_different_distribution_version_blocks(self):
        self.members[installer.DIST + 'METADATA'] = self.metadata.replace(b'1.181.0', b'1.181.1')
        asset = self.wheel()
        with self.assertRaisesRegex(ValueError, 'distribution'):
            installer.repair_wheel(self.source, self.destination, asset)
        self.assertFalse(self.destination.exists())

    def test_frozen_inventory_retains_the_scanner_and_both_repaired_wheel_hashes(self):
        locked = (Path(installer.__file__).parent / 'requirements.txt').read_text()
        section = re.search(r'^semgrep==1\.181\.0 \\\n((?:    .*\n)+)', locked, re.MULTILINE)
        self.assertIsNotNone(section, 'The scanner itself must remain visible to dependency auditing')
        hashes = re.findall(r'--hash=sha256:([a-f0-9]{64})', section.group(1))
        self.assertEqual(set(hashes), {asset['patchedSha256'] for asset in installer.ASSETS.values()})


if __name__ == '__main__':
    unittest.main()

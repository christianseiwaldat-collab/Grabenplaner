import base64
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import compiler_license_ledger as ledger


class CaptureEvidenceTests(unittest.TestCase):
    def test_actual_pinned_source_directory_without_version_is_retained(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); sources = root / 'opam-sources'; sources.mkdir()
            tree = sources / 'probe'; tree.mkdir()
            (tree / 'LICENSE').write_bytes(b'Synthetic original MIT notice for source continuity test')
            (tree / 'source.ml').write_bytes(b'let value = 1\n')
            output = root / 'published'; output.mkdir()
            package = {'name': 'probe', 'version': 'dev', 'id': 'probe.dev',
                'opam': base64.b64encode(b'license: "MIT"\n').decode(),
                'install': '', 'changes': '', 'sourceDirectory': 'probe',
                'sourcePin': 'git+https://example.invalid/probe.git#' + 'a' * 40}
            with patch.object(ledger, 'download', return_value=b'Synthetic metadata repository notice'):
                components = ledger.collect_opam({'opamPackages': [package]}, root, output)
            self.assertEqual(components[0]['correspondingSource']['url'], 'https://example.invalid/probe/tree/' + 'a' * 40)
            with tarfile.open(output / components[0]['correspondingSource']['filename']) as archive:
                self.assertEqual(archive.extractfile('source/source.ml').read(), b'let value = 1\n')
            package['sourcePin'] = None
            with patch.object(ledger, 'download', return_value=b'Synthetic metadata repository notice'):
                with self.assertRaisesRegex(ValueError, 'source identity'):
                    ledger.collect_opam({'opamPackages': [package]}, root, output)

    def test_command_error_keeps_bounded_private_details_out_of_message(self):
        stderr = b'private-upstream-diagnostic\n' * 3000
        result = subprocess.CompletedProcess(['docker', 'run'], 42, b'partial', stderr)
        with patch.object(ledger.subprocess, 'run', return_value=result):
            with self.assertRaises(ledger.CaptureCommandError) as raised:
                ledger.command(['docker', 'run'])
        value = raised.exception.evidence
        self.assertNotIn('private-upstream', str(raised.exception))
        self.assertEqual(value['returncode'], 42)
        self.assertTrue(value['stderr']['truncated'])
        self.assertEqual(base64.b64decode(value['stderr']['tailBase64']), stderr[-16384:])
        self.assertEqual(value['stderr']['sha256'], ledger.digest(stderr))

    def test_timeout_is_bounded_private_command_evidence(self):
        failure = subprocess.TimeoutExpired(['docker', 'cp'], 1, output=b'part', stderr=b'why')
        with patch.object(ledger.subprocess, 'run', side_effect=failure):
            with self.assertRaises(ledger.CaptureCommandError) as raised:
                ledger.command(['docker', 'cp'], timeout=1)
        self.assertEqual(raised.exception.evidence['returncode'], 'timeout')
        self.assertEqual(base64.b64decode(raised.exception.evidence['stderr']['tailBase64']), b'why')

    def test_receipt_exists_before_first_command_and_preserves_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); qualification = root / 'qualification'; qualification.mkdir()
            output = root / 'review'; output.mkdir()
            def fail(arguments, timeout=300):
                early = json.loads((qualification / 'sourcebuild-compiler-license-review.json').read_bytes())
                self.assertEqual(early['phase'], 'raw-source-export-started')
                raise ledger.CaptureCommandError(arguments, 7, stderr=b'first failure')
            with patch.object(ledger, 'command', side_effect=fail):
                with self.assertRaises(ledger.CaptureCommandError):
                    ledger.capture_image('sha256:' + 'a' * 64, 'b' * 64, qualification, output)
            self.assertEqual(ledger.verify_capture(output)['binarySha256'], 'b' * 64)
            report = json.loads((qualification / 'sourcebuild-compiler-license-review.json').read_bytes())
            self.assertEqual(report['phase'], 'capture-observation-failed')
            self.assertFalse(report['publicationReady'])
            private = json.loads((qualification / 'sourcebuild-compiler-capture-command-failure.json').read_bytes())
            self.assertEqual(base64.b64decode(private['stderr']['tailBase64']), b'first failure')
            with tarfile.open(output / 'capture.tar.xz') as archive:
                observed = json.loads(archive.extractfile('capture.json').read())
                self.assertFalse(observed['captureComplete'])

    def test_raw_source_export_survives_a_later_observation_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); qualification = root / 'qualification'; qualification.mkdir()
            output = root / 'review'; output.mkdir(); operations = []
            def command(arguments, timeout=300):
                operations.append(arguments[1])
                if arguments[1] == 'create': return ('a' * 64).encode()
                if arguments[1] == 'cp':
                    target = Path(arguments[-1])
                    if target.name in ('opam-download-cache', 'opam-sources', 'opam-package-metadata', 'opam-install-evidence'):
                        target.mkdir(); (target / 'original.txt').write_bytes(b'original upstream bytes')
                    else: target.write_bytes(b'original upstream bytes')
                    return b''
                if arguments[1] == 'run':
                    raise ledger.CaptureCommandError(arguments, 1, stderr=b'unknown owner fixture')
                self.assertEqual(arguments[1], 'rm'); return b''
            with patch.object(ledger, 'command', side_effect=command):
                with self.assertRaises(ledger.CaptureCommandError):
                    ledger.capture_image('sha256:' + 'a' * 64, 'b' * 64, qualification, output)
            receipt = ledger.verify_capture(output)
            self.assertIn('opam-package-metadata/original.txt', [item['path'] for item in receipt['memberInventory']])
            self.assertEqual(operations[-1], 'rm')
            self.assertLess(operations.index('cp'), operations.index('run'))


if __name__ == '__main__':
    unittest.main()

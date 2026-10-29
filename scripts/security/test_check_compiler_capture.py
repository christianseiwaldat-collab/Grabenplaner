import base64
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

import check_compiler_capture as contract


def capture_value():
    packages = []
    for name in (contract.PROBE, contract.PIN_PROBE):
        data = ('name: "' + name + '"\nlicense: "MIT"\n').encode()
        packages.append({'id': name + '.1', 'name': name, 'version': '1',
            'opam': base64.b64encode(data).decode(), 'install': '',
            'changes': base64.b64encode(b'actual installed fixture change').decode(),
            'sourcePin': 'file:///capture-pin-source' if name == contract.PIN_PROBE else None,
            'sourceDirectory': name if name == contract.PIN_PROBE else name + '.1'})
    return {'opamPackages': packages, 'opamListing': 'synthetic probe metadata',
        'apkPackages': [{'id': 'opam.2.5.2-r0'}, {'id': 'python3.3.12.16-r0'}, {'id': 'musl-dev.synthetic'}],
        'nativeInputs': [{'path': '/usr/include/stdio.h', 'bytes': 10, 'sha256': 'a' * 64,
                          'owner': 'musl-dev.synthetic'}], 'alpineRelease': '3.23.9'}


class CaptureContractTests(unittest.TestCase):
    def test_actual_metadata_requires_exact_tools_two_compiler_free_packages_and_apk_native_owner(self):
        value = capture_value()
        self.assertEqual(contract.validate_capture(contract.encoded(value)), value)
        for change in ('tool-version', 'missing-native', 'unowned-native', 'missing-opam', 'wrong-pin-directory', 'compiler'):
            changed = copy.deepcopy(value)
            if change == 'tool-version': changed['apkPackages'][0]['id'] = 'opam.2.4.0-r0'
            if change == 'missing-native': changed['nativeInputs'] = []
            if change == 'unowned-native': changed['nativeInputs'][0]['owner'] = 'unknown.1'
            if change == 'missing-opam': changed['opamPackages'][0]['opam'] = ''
            if change == 'wrong-pin-directory': changed['opamPackages'][1]['sourceDirectory'] += '.1'
            if change == 'compiler': changed['opamPackages'].append({'id': 'ocaml.5.4.0'})
            with self.subTest(change=change), self.assertRaises(ValueError):
                contract.validate_capture(contract.encoded(changed))

    def test_expected_negative_cannot_be_replaced_by_unrelated_opam_or_docker_failure(self):
        error = ('AssertionError: Unowned native input: ' + contract.UNKNOWN).encode()
        contract.validate_negative({'exitCode': 1}, b'', error)
        for code, message in ((0, error), (1, b'opam command syntax failed'), (127, b'python3 not found')):
            with self.subTest(code=code, message=message), self.assertRaises(ValueError):
                contract.validate_negative({'exitCode': code}, b'', message)

    def test_generated_fixture_has_local_release_and_pin_but_no_compiler_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context, negative = contract.fixture(root)
            dockerfile = (context / 'Dockerfile').read_text()
            self.assertTrue(dockerfile.startswith('FROM ' + contract.ALPINE + '\n'))
            self.assertIn('opam=2.5.2-r0 python3=3.12.16-r0', dockerfile)
            self.assertIn('musl-dev bash build-base git make rsync', dockerfile)
            self.assertIn('opam switch create 5.4.0 --empty', dockerfile)
            self.assertIn('opam pin add ' + contract.PIN_PROBE + ' /capture-pin-source', dockerfile)
            self.assertNotIn('make core', dockerfile)
            self.assertNotIn('ocaml-system', dockerfile)
            self.assertIn('file:///capture-repository', dockerfile)
            self.assertTrue((context / 'pinned-source/README.synthetic').is_file())
            self.assertIn(b'Synthetic unowned capture probe', (negative / 'unowned.h').read_bytes())

    def test_metadata_byte_proof_preserves_original_and_installed_bytes_without_hash_normalization(self):
        with tempfile.TemporaryDirectory() as directory:
            context, _ = contract.fixture(Path(directory))
            value = capture_value()
            proof = contract.metadata_byte_proof(value, context)
            self.assertFalse(proof['hashNormalizationApplied'])
            self.assertEqual(len(proof['records']), 2)
            for row in proof['records']:
                original = base64.b64decode(row['originalBase64'], validate=True)
                installed = base64.b64decode(row['installedBase64'], validate=True)
                self.assertEqual(contract.digest(original), row['originalSha256'])
                self.assertEqual(contract.digest(installed), row['installedSha256'])
                self.assertEqual(row['normalizedDuringInstall'], original != installed)

    def test_real_subprocess_keeps_bounded_stdout_and_stderr_and_rejects_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            record, stdout, stderr = contract.run([sys.executable, '-I', '-c',
                'import sys;print("actual stdout");print("actual stderr",file=sys.stderr)'], 'small', output)
            self.assertEqual(record['exitCode'], 0)
            self.assertIn(b'actual stdout', stdout); self.assertIn(b'actual stderr', stderr)
            self.assertFalse(record['stdoutTruncated'])
            with self.assertRaisesRegex(ValueError, 'evidence bound'):
                contract.run([sys.executable, '-I', '-c', 'print("x"*20000)'], 'large', output, limit=64)
            evidence = json.loads((output / 'large.json').read_bytes())
            self.assertTrue(evidence['stdoutTruncated'])
            self.assertEqual((output / 'large.stdout').stat().st_size, 64)

    def test_manual_workflow_is_read_only_and_cannot_publish_a_compiler_tool(self):
        source = (Path(__file__).resolve().parents[2] / '.github/workflows/compiler-capture-check.yml').read_text()
        self.assertIn('  workflow_dispatch:', source)
        self.assertNotIn('pull_request:', source)
        self.assertIn('branches: [ci/semgrep-core-activation-20261029]', source)
        self.assertNotIn('branches: [main]', source)
        self.assertNotIn('feature/', source)
        self.assertIn('      - scripts/security/compiler_license_ledger.py', source)
        self.assertIn('permissions:\n  contents: read\n', source)
        self.assertNotIn('contents: write', source)
        self.assertIn('python scripts/security/check_compiler_capture.py', source)
        self.assertNotIn('build_semgrep_source.py', source)
        self.assertNotIn('publish_semgrep_core_tool.py', source)
        self.assertNotIn('semgrep-core-tool-${{', source)
        self.assertIn('raw-negative/capture.tar.xz', source)
        self.assertNotIn('**', source)

    def test_capture_image_command_binding_cannot_select_remote_docker(self):
        original = Mock(return_value=b'actual local result')
        local = ['docker', '--host', 'unix:///run/docker.sock']
        bound = contract.bind_capture_command(original, local)
        self.assertEqual(bound(['docker', 'run', '--network', 'none', 'synthetic-image'], timeout=10), b'actual local result')
        original.assert_called_once_with([*local, 'run', '--network', 'none', 'synthetic-image'], timeout=10)
        for arguments in (['ssh', 'vps'], ['docker', '--context', 'remote', 'run'],
                          ['docker', 'run', '--host=tcp://remote'], ['docker', 'build', '.']):
            with self.subTest(arguments=arguments), self.assertRaisesRegex(ValueError, 'explicit local Docker'):
                bound(arguments)


if __name__ == '__main__':
    unittest.main()

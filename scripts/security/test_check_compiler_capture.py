import base64
import contextlib
import copy
import io
import json
from pathlib import Path, PurePosixPath
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

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
    def test_large_sparse_contract_cannot_allocate_gigabyte_fixtures_in_windows_units(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(contract.sys, 'platform', 'win32'), self.assertRaisesRegex(ValueError, 'native Linux'):
                contract.host_streaming_contract(root, 'sha256:' + 'a' * 64)
            self.assertEqual(list(root.iterdir()), [])

    def test_fourteen_real_pin_classes_use_only_small_local_synthetic_sources_and_safe_readonly_routes(self):
        self.assertEqual(len(contract.PIN_CLASSES), 14)
        self.assertEqual(sum(item[2] == 'git' for item in contract.PIN_CLASSES), 13)
        self.assertEqual(sum(item[2] == 'rsync' for item in contract.PIN_CLASSES), 1)
        compile(contract.PIN_SETUP_SCRIPT, '<actual-pin-setup>', 'exec')
        compile(contract.PIN_READ_SCRIPT, '<actual-pin-read>', 'exec')
        with tempfile.TemporaryDirectory() as directory:
            fixture = contract.git_pin_fixture(Path(directory), 'gp-capture-contract-positive:' + 'a' * 32)
            self.assertEqual(json.loads((fixture / 'pins.json').read_bytes()), [list(row) for row in contract.PIN_CLASSES])
            for name, version, _backend in contract.PIN_CLASSES:
                text = (fixture / 'sources' / name / 'opam').read_text()
                self.assertIn('version: "' + version + '"', text)
                self.assertNotIn('build:', text); self.assertNotIn('install:', text)
            local = ['docker', '--host', 'unix:///run/docker.sock']
            bare = contract.pin_read_arguments(local, 'sha256:' + 'b' * 64, contract.PIN_ROOT)
            fixed = contract.pin_read_arguments(local, 'sha256:' + 'b' * 64, contract.PIN_ROOT, True)
            for arguments in (bare, fixed):
                self.assertIn('--read-only', arguments)
                self.assertEqual(arguments[arguments.index('--network') + 1], 'none')
                self.assertEqual(arguments[-1], contract.PIN_READ_SCRIPT)
            self.assertNotIn('--tmpfs', bare)
            self.assertIn(contract.PIN_TMPFS, fixed)
            self.assertIn('OPAMLOGS=' + contract.PIN_LOGS, fixed)
            self.assertNotIn('--privileged', fixed)

    def test_pin_read_contract_preserves_real_readonly99_cause_and_rejects_unrelated_errors(self):
        def record(data):
            return {'bytes': len(data), 'sha256': contract.digest(data),
                'base64': base64.b64encode(data).decode(), 'truncated': False}
        def value(root, scratch, code=0, error=b''):
            expected = contract.PIN_CLASSES if root == contract.PIN_ROOT else [row for row in contract.PIN_CLASSES if row[2] == 'rsync']
            lines = [name + '.' + version + ' (uninstalled) ' + backend + ' file:///synthetic/' + name
                + (' (at ' + 'c' * 40 + ')' if backend == 'git' else '') for name, version, backend in expected]
            state = [{'path': 'config', 'sha256': 'd' * 64}]
            return {'format': 'gp-synthetic-opam-pin-readonly/v1', 'syntheticOnly': True,
                'compilerQualification': False, 'opamRoot': root,
                'command': ['opam', 'pin', 'list', '--normalise', '--safe'],
                'opamLogs': contract.PIN_LOGS if scratch else None, 'stateBefore': state, 'stateAfter': state,
                'exitCode': code, 'stdout': record(('\n'.join(lines) + '\n').encode() if not code else b''),
                'stderr': record(error)}
        for root, scratch in ((contract.RSYNC_ROOT, False), (contract.PIN_ROOT, True)):
            contract.validate_pin_read(contract.encoded(value(root, scratch)), root, scratch)
        failure = value(contract.PIN_ROOT, False, 99, b'Fatal error: /tmp/opam-x/log.info: Read-only file system')
        contract.validate_pin_read(contract.encoded(failure), contract.PIN_ROOT, expect_readonly_failure=True)
        for changed in ('unrelated99', 'missing-git', 'state-mutation', 'diagnostic-tamper', 'unsafe'):
            candidate = copy.deepcopy(failure if changed == 'unrelated99' else value(contract.PIN_ROOT, True))
            if changed == 'unrelated99': candidate['stderr'] = record(b'Unknown arbitrary internal error')
            if changed == 'missing-git': candidate['stdout'] = record(b'tree-sitter.dev rsync file:///synthetic\n')
            if changed == 'state-mutation': candidate['stateAfter'] = []
            if changed == 'diagnostic-tamper': candidate['stdout']['sha256'] = 'e' * 64
            if changed == 'unsafe': candidate['command'].remove('--safe')
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                contract.validate_pin_read(contract.encoded(candidate), contract.PIN_ROOT,
                    scratch=changed != 'unrelated99', expect_readonly_failure=changed == 'unrelated99')

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

    def test_real_empty_musl_headers_remain_owned_and_byte_bound_instead_of_being_omitted(self):
        value = capture_value()
        # Observed in authenticated native run 40809493525: musl-dev ships
        # these empty compatibility headers alongside nonempty stdio.h.
        value['nativeInputs'].append({'path': '/usr/include/bits/hwcap.h', 'bytes': 0,
            'sha256': contract.digest(b''), 'owner': 'musl-dev.synthetic'})
        self.assertEqual(len(contract.validate_capture(contract.encoded(value))['nativeInputs']), 2)
        for changed in ({'bytes': -1}, {'sha256': 'a' * 64}, {'owner': 'unknown.1'}, {'bytes': False}):
            candidate = copy.deepcopy(value)
            candidate['nativeInputs'][-1].update(changed)
            with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, 'owner or byte identity'):
                contract.validate_capture(contract.encoded(candidate))

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

    def test_official_config_fixture_keeps_exact_bytes_and_isolated_fake_variant_without_actions(self):
        with tempfile.TemporaryDirectory() as directory:
            image = 'sha256:' + 'a' * 64
            context, original, variant = contract.metadata_fixture(Path(directory), image)
            self.assertEqual(contract.digest(original), contract.CONFIG_METADATA_SHA)
            self.assertEqual((context / 'repository/packages/ocaml-config/ocaml-config.3/opam').read_bytes(), original)
            self.assertFalse((context / 'Dockerfile').exists())
            arguments = contract.metadata_run_arguments(['docker', '--host', 'unix:///run/docker.sock'], image, context)
            self.assertEqual(arguments[:4], ['docker', '--host', 'unix:///run/docker.sock', 'run'])
            self.assertIn(image, arguments)
            self.assertNotIn('build', arguments)
            self.assertNotIn('pull', arguments)
            self.assertIn('--read-only', arguments)
            self.assertEqual(arguments[arguments.index('--network') + 1], 'none')
            self.assertEqual(arguments[arguments.index('--mount') + 1],
                'type=bind,src=' + str(context / 'repository') + ',dst=/metadata-repository,readonly')
            self.assertIn('/metadata-root:rw,nosuid,nodev,noexec,size=128m', arguments)
            self.assertEqual(arguments[-1], contract.CONFIG_METADATA_SCRIPT)
            self.assertIn(b'Synthetic fake-install metadata only', variant)
            for forbidden in (b'build:', b'install:', b'url {', b'extra-source'):
                self.assertNotIn(forbidden, variant)
            self.assertFalse((context / 'repository/packages/gp-capture-probe').exists())
            with self.assertRaisesRegex(ValueError, 'immutable'):
                contract.metadata_run_arguments(['docker'], 'mutable:tag', context)
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, 'immutable'):
            contract.metadata_fixture(Path(directory), 'mutable:tag')

    def test_actual_fake_metadata_script_records_original_installed_bytes_and_scoped_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            _, original, variant = contract.metadata_fixture(Path(directory), 'sha256:' + 'a' * 64)
        # Execute the actual embedded program with only its process/filesystem
        # boundaries stubbed. Native OPAM behavior is proved by the workflow.
        installed = original.replace(b'  src:\n    ', b'  src: ')
        files = {
            '/metadata-repository/packages/ocaml-config/ocaml-config.3/opam': original,
            '/metadata-repository/packages/ocaml-variants/ocaml-variants.5.4.0/opam': variant,
            '/metadata-root/config3-metadata/.opam-switch/packages/ocaml-config.3/opam': installed}
        class FakePath(PurePosixPath):
            def read_bytes(self): return files[str(self)]
        environments = []
        def command(arguments, **kwargs):
            environments.append(dict(kwargs['env']))
            stdout = b'2.5.2\n' if arguments == ['opam', '--version'] else (
                b'ocaml-config.3\nocaml-variants.5.4.0\n' if arguments[1] == 'list' else b'Fake action metadata only\n')
            return SimpleNamespace(returncode=0, stdout=stdout, stderr=b'')
        stdout = io.StringIO()
        with patch.dict(sys.modules, {'pathlib': SimpleNamespace(Path=FakePath)}), \
                patch('subprocess.run', side_effect=command), contextlib.redirect_stdout(stdout), \
                patch.dict('os.environ', {'OPAMSWITCH': 'inherited-must-not-leak'}, clear=True):
            with self.assertRaises(SystemExit) as stopped:
                exec(compile(contract.CONFIG_METADATA_SCRIPT, '<actual-config-metadata-script>', 'exec'), {})
        self.assertEqual(stopped.exception.code, 0)
        evidence = contract.validate_config_metadata(stdout.getvalue(), original, variant)
        self.assertEqual(base64.b64decode(evidence['installed']['base64']), installed)
        self.assertTrue(all('OPAMSWITCH' not in item for item in environments[:3]))
        self.assertTrue(all(item['OPAMSWITCH'] == 'config3-metadata' for item in environments[3:]))
        for changed in ('qualification', 'actual-install', 'original-sha', 'installed-sha', 'unexpected-package', 'command-error'):
            value = copy.deepcopy(evidence)
            if changed == 'qualification': value['sourceQualification'] = True
            if changed == 'actual-install': value['commands'][3]['argv'].remove('--fake')
            if changed == 'original-sha': value['original']['sha256'] = '0' * 64
            if changed == 'installed-sha': value['installed']['sha256'] = '0' * 64
            if changed == 'unexpected-package': value['installedPackageIds'].append('ocaml.5.4.0')
            if changed == 'command-error': value['commands'][3]['exitCode'] = 1
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                contract.validate_config_metadata(contract.encoded(value), original, variant)

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
        self.assertIn('config3-installed.opam', source)
        self.assertIn('config3-metadata-binding.json', source)
        self.assertIn('host-streaming-capture/capture.tar.xz', source)
        self.assertIn('host-streaming-contract.json', source)
        self.assertIn('scripts/security/compiler_capture_archive.py', source)
        self.assertNotIn('host-streaming-private/', source)
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

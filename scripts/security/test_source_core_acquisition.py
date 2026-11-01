import copy
import io
import json
import os
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch, Mock
import zipfile

import build_semgrep_source as build
import semgrep_core_tool as tool
import source_core_acquisition as acquisition
import source_core_identity as identity
import test_publish_semgrep_core_tool as publisher_fixture


class CompilerAcquisitionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = publisher_fixture.PublisherTests('runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.base = self.fixture.root
        self.root = self.base / 'gp'
        security = self.root / 'scripts/security'
        security.mkdir(parents=True)
        shutil.copyfile(Path(__file__).resolve().parents[2] / '.gitattributes', self.root / '.gitattributes')
        for name in ('requirements.txt', 'tools.json', *identity.PROGRAMS):
            shutil.copyfile(Path(__file__).parent / name, security / name)
        (self.root / '.github').mkdir()
        self.work, self.output = self.base / 'consumer-work', self.base / 'consumer-private'
        self.work.mkdir(); self.output.mkdir()
        self.pin_path = self.root / acquisition.PIN
        self.identity = identity.inputs(self.root)
        self.native = self.fixture.core.read_bytes()
        self.commands = Mock()
        self.commands.run.side_effect = lambda argv, label: (build.VERSION if argv[-1] == '-version'
            else '5.4+' + build.COMPILER).encode()
        self.environment = {'GITHUB_TOKEN': 'synthetic-read-only-token',
            'GITHUB_REPOSITORY': 'synthetic/gp', 'GITHUB_REPOSITORY_ID': '1'}
        receipt = self.fixture.prepare()
        inner = (self.base / 'tool-output' / tool.ARCHIVE).read_bytes()
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr(tool.ARCHIVE, inner)
        self.zip = buffer.getvalue()
        self.pin = {'format': tool.FORMAT, 'repository': {'fullName': 'synthetic/gp', 'id': 1},
            'run': {'id': 2, 'attempt': 1, 'headSha': 'a' * 40, 'workflowId': 3,
                'workflowPath': '.github/workflows/sast-source-build.yml'},
            'artifact': {'id': 4, 'name': 'semgrep-core-tool-2-1', 'bytes': len(self.zip), 'sha256': tool.digest(self.zip)},
            'archive': {'name': tool.ARCHIVE, 'bytes': len(inner), 'sha256': tool.digest(inner)},
            'manifestSha256': receipt['manifest']['sha256'], 'native': receipt['core'],
            'wrapper': {'version': build.VERSION, 'requirementsSha256': self.identity['requirementsSha256']},
            'toolsConfigurationSha256': self.identity['toolsConfigurationSha256'], 'source': tool.UPSTREAM,
            'buildInputs': self.identity, 'buildInputsSha256': identity.digest(identity.canonical(self.identity))}
        self.run_metadata = {'id': 2, 'run_attempt': 1, 'head_sha': 'a' * 40, 'workflow_id': 3,
            'path': '.github/workflows/sast-source-build.yml@reviewed',
            'repository': {'full_name': 'synthetic/gp', 'id': 1}, 'head_repository': {'id': 1},
            'status': 'completed', 'conclusion': 'success', 'event': 'workflow_dispatch'}
        self.artifact_metadata = {'id': 4, 'name': 'semgrep-core-tool-2-1',
            'size_in_bytes': len(self.zip), 'expired': False, 'digest': 'sha256:' + tool.digest(self.zip),
            'expires_at': '2099-01-01T00:00:00Z',
            'workflow_run': {'id': 2, 'head_sha': 'a' * 40, 'repository_id': 1, 'head_repository_id': 1}}

    def pin_file(self):
        self.pin_path.write_bytes(tool.canonical(self.pin))

    def request(self, path, token, limit):
        self.assertEqual(token, 'synthetic-read-only-token')
        if path.endswith('/zip'):
            return self.zip
        return tool.canonical(self.run_metadata if '/runs/' in path else self.artifact_metadata)

    def cold(self, work, output, tools, source, recipe, commands):
        target = work / 'cold-native'
        target.write_bytes(self.native)
        return target

    def acquire(self):
        return acquisition.acquire(self.root, self.base / 'tools', self.work, self.output,
            self.fixture.source, self.base / 'recipe', self.commands)

    def test_verified_warm_artifact_skips_compilation_but_grants_no_scan_approval(self):
        self.pin_file()
        with patch.dict(os.environ, self.environment), \
                patch.object(tool, 'github_request', side_effect=self.request), \
                patch.object(build, 'build_core', side_effect=AssertionError('warm path must not compile')):
            binary = self.acquire()
        self.assertEqual(binary.read_bytes(), self.native)
        receipt = acquisition.verify(self.output, self.root, self.native)
        self.assertEqual(receipt['mode'], 'reviewed_reuse')
        self.assertTrue(receipt['freshCurrentQualificationRequired'])
        self.assertFalse(receipt['fullProjectScanApproved'])
        self.assertFalse((self.output / 'gate-result.json').exists())
        self.assertEqual(receipt['producer']['pinSha256'], tool.digest(self.pin_path.read_bytes()))

    def test_no_reviewed_pin_builds_cold_without_network_or_existing_binary_fallback(self):
        with patch.object(tool, 'github_request', side_effect=AssertionError('no pin: no fetch')), \
                patch.object(build, 'build_core', side_effect=self.cold) as cold:
            binary = self.acquire()
        cold.assert_called_once()
        self.assertEqual(binary.read_bytes(), self.native)
        receipt = acquisition.verify(self.output, self.root, self.native)
        self.assertEqual((receipt['mode'], receipt['reason'], receipt['producer']),
                         ('cold_build', 'no_reviewed_pin', None))

    def test_independent_producer_always_builds_cold_even_when_a_consumer_pin_exists(self):
        self.pin_path.write_bytes(b'unrelated invalid consumer pin')
        with patch.object(acquisition, 'fetch', side_effect=AssertionError('producer must not download')), \
                patch.object(build, 'build_core', side_effect=self.cold) as cold:
            acquisition.acquire(self.root, self.base / 'tools', self.work, self.output,
                self.fixture.source, self.base / 'recipe', self.commands, force_cold=True)
        cold.assert_called_once()
        self.assertEqual(acquisition.verify(self.output, self.root, self.native)['reason'], 'explicit_producer_build')

    def test_compiler_identity_is_path_independent_and_never_reuses_application_results(self):
        other = self.base / 'other-gp'
        shutil.copytree(self.root, other)
        self.assertEqual(identity.inputs(other), self.identity)
        (other / 'server.js').write_text('entirely different application source')
        self.assertEqual(identity.inputs(other), self.identity)
        self.assertNotIn('server.js', self.identity['programs'])

    def test_lf_checkout_policy_is_versioned_and_actual_crlf_is_rejected_not_normalized(self):
        attributes = self.root / '.gitattributes'
        original_attributes = attributes.read_bytes()
        self.assertIn(identity.PROGRAM_ATTRIBUTE.encode(), original_attributes.splitlines())
        for name in (identity.PROGRAMS[0], 'requirements.txt', 'tools.json'):
            program = self.root / 'scripts/security' / name
            original = program.read_bytes()
            self.assertNotIn(b'\r', original)
            program.write_bytes(original.replace(b'\n', b'\r\n'))
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'violate the versioned LF'):
                identity.inputs(self.root)
            program.write_bytes(original)
        attributes.write_bytes(b'*.py text eol=crlf\n')
        with self.assertRaisesRegex(ValueError, 'require the versioned LF'):
            identity.inputs(self.root)
        attributes.write_bytes(original_attributes)
        self.assertEqual(identity.inputs(self.root), self.identity)

    def test_exact_expired_artifact_builds_cold(self):
        self.pin_file()
        self.artifact_metadata.update(expired=True, expires_at='2020-01-01T00:00:00Z')
        with patch.dict(os.environ, self.environment), \
                patch.object(tool, 'github_request', side_effect=self.request), \
                patch.object(build, 'build_core', side_effect=self.cold) as cold:
            self.acquire()
        cold.assert_called_once()
        self.assertEqual(acquisition.verify(self.output, self.root, self.native)['reason'], 'reviewed_artifact_unavailable')

    def test_missing_artifact_builds_cold(self):
        self.pin_file()
        with patch.dict(os.environ, self.environment), \
                patch.object(tool, 'github_request', side_effect=tool.ToolUnavailable('authenticated missing artifact')), \
                patch.object(build, 'build_core', side_effect=self.cold) as cold:
            self.acquire()
        cold.assert_called_once()

    def test_present_tampered_artifact_fails_and_never_conceals_failure_with_cold_build(self):
        self.pin_file()
        self.zip += b'tampered'
        with patch.dict(os.environ, self.environment), \
                patch.object(tool, 'github_request', side_effect=self.request), \
                patch.object(build, 'build_core') as cold, self.assertRaisesRegex(ValueError, 'Outer Actions ZIP identity'):
            self.acquire()
        cold.assert_not_called()
        self.assertFalse((self.output / acquisition.RECEIPT).exists())
        self.assertFalse((self.work / 'semgrep-core-reviewed-reuse').exists())

    def test_integrity_failure_is_preserved_in_the_actual_builder_failure_receipt(self):
        self.pin_file()
        self.zip += b'tampered'
        failed = self.base / 'actual-pipeline-failure'
        with patch.dict(os.environ, self.environment), \
                patch.object(tool, 'github_request', side_effect=self.request), \
                patch.object(build.sys, 'platform', 'linux'), \
                patch.object(build.shutil, 'disk_usage', return_value=type('Space', (), {'free': 24 * 1024**3})()), \
                patch.object(build, 'checkout_and_patch', return_value=(self.fixture.source, self.base / 'recipe')), \
                patch.object(build, 'build_core') as cold, patch.object(build, 'diagnose') as diagnose:
            code = build.run(self.root, self.base / 'tools', self.base / 'actual-pipeline-work', failed)
        self.assertEqual(code, 2)
        gate = json.loads((failed / 'gate-result.json').read_bytes())
        self.assertIn('Outer Actions ZIP identity mismatch', gate['error'])
        self.assertFalse(gate['diagnosticExecutionComplete'])
        self.assertFalse(gate['securityGatePassed'])
        cold.assert_not_called(); diagnose.assert_not_called()

    def test_pr_fork_failed_run_or_inexact_provenance_is_not_a_cache_miss(self):
        self.pin_file()
        original = copy.deepcopy(self.run_metadata)
        variants = [{'event': 'pull_request'}, {'head_repository': {'id': 44}},
            {'conclusion': 'failure'}, {'head_sha': 'b' * 40}, {'run_attempt': 2},
            {'path': '.github/workflows/unreviewed.yml'}, {'workflow_id': 88}]
        for variant in variants:
            self.run_metadata = {**original, **variant}
            with self.subTest(variant=variant), patch.dict(os.environ, self.environment), \
                    patch.object(tool, 'github_request', side_effect=self.request), \
                    patch.object(build, 'build_core') as cold, self.assertRaisesRegex(ValueError, 'reviewed successful run'):
                self.acquire()
            cold.assert_not_called()

    def test_valid_other_wrapper_rules_or_program_key_builds_cold_before_fetch(self):
        self.pin_file()
        for name in ('requirements.txt', 'tools.json', *identity.PROGRAMS):
            file = self.root / 'scripts/security' / name
            original = file.read_bytes()
            file.write_bytes(original + b'\n# actual current input changed\n')
            try:
                with self.subTest(name=name), patch.object(acquisition, 'fetch') as fetch, \
                        patch.object(build, 'build_core', side_effect=self.cold) as cold:
                    self.acquire()
                    receipt = acquisition.verify(self.output, self.root, self.native)
                    self.assertEqual(receipt['reason'], 'reviewed_inputs_changed')
                fetch.assert_not_called(); cold.assert_called_once()
            finally:
                file.write_bytes(original)

    def test_malformed_pin_or_missing_token_is_a_hard_failure(self):
        for content in (b'{}\n', b'{"format":"duplicate","format":"other"}\n', tool.canonical(self.pin)):
            self.pin_path.write_bytes(content)
            with self.subTest(content=content[:25]), patch.dict(os.environ, {**self.environment, 'GITHUB_TOKEN': ''}), \
                    patch.object(build, 'build_core') as cold, self.assertRaises(ValueError):
                self.acquire()
            cold.assert_not_called()

    def test_other_repository_cannot_supply_the_producer_even_with_a_valid_external_pin(self):
        self.pin_file()
        for changed in ({'GITHUB_REPOSITORY': 'other/repository'}, {'GITHUB_REPOSITORY_ID': '44'}):
            with self.subTest(changed=changed), patch.dict(os.environ, {**self.environment, **changed}), \
                    patch.object(acquisition, 'fetch') as fetch, patch.object(build, 'build_core') as cold, \
                    self.assertRaisesRegex(ValueError, 'not this GitHub repository'):
                self.acquire()
            fetch.assert_not_called(); cold.assert_not_called()

    def test_acquisition_evidence_is_rechecked_before_scan(self):
        self.pin_file()
        with patch.dict(os.environ, self.environment), \
                patch.object(tool, 'github_request', side_effect=self.request):
            self.acquire()
        for name in ('sourcebuild-reuse-manifest.json', 'sourcebuild-reuse-provenance.json',
                     'sourcebuild-native-provenance.json', 'sourcebuild-toolchain-sbom.json', acquisition.INPUTS):
            file = self.output / name
            original = file.read_bytes()
            file.write_bytes(original + b' ')
            try:
                with self.subTest(name=name), self.assertRaises(ValueError):
                    acquisition.verify(self.output, self.root, self.native)
            finally:
                file.write_bytes(original)
        with self.assertRaises(ValueError):
            acquisition.verify(self.output, self.root, self.native + b'changed')

    def test_source_tag_patch_recipe_toolchain_and_architecture_cannot_be_self_redefined(self):
        for group, field in (('source', 'tag'), ('source', 'tagObject'), ('source', 'commit'),
                ('patchRecipe', 'to'), ('patchRecipe', 'derivedRecipeSha256'),
                ('toolchain', 'baseImage'), ('toolchain', 'compilerSourceCommit'),
                ('toolchain', 'opamRepositoryCommit'), ('toolchain', 'platform'), ('toolchain', 'elfMachine')):
            changed = copy.deepcopy(self.pin)
            changed['buildInputs'][group][field] = 'unreviewed'
            changed['buildInputsSha256'] = tool.digest(tool.canonical(changed['buildInputs']))
            with self.subTest(group=group, field=field), self.assertRaisesRegex(ValueError, 'Unreviewed compiler build-input identity'):
                tool.validate_pin(changed)

    def test_execution_version_or_compiler_drift_does_not_trigger_a_cold_retry(self):
        self.pin_file()
        self.commands.run.side_effect = lambda argv, label: b'wrong toolchain'
        with patch.dict(os.environ, self.environment), \
                patch.object(tool, 'github_request', side_effect=self.request), \
                patch.object(build, 'build_core') as cold, self.assertRaisesRegex(ValueError, 'execution differs'):
            self.acquire()
        cold.assert_not_called()
        self.assertFalse((self.output / acquisition.RECEIPT).exists())


if __name__ == '__main__':
    unittest.main()

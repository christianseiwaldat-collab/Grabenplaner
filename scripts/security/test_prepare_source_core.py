import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import os
from unittest.mock import patch
import unittest

import prepare_source_core as prepare
import build_semgrep_source as build
import test_publish_semgrep_core_tool as fixtures


class PrivateCoreBindingTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PublisherTests('runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.base = self.fixture.root
        self.runner = self.base / 'runner'
        self.prefix = self.runner / 'semgrep-source-venv'
        self.core = self.prefix / 'bin/semgrep-core'
        self.core.parent.mkdir(parents=True)
        shutil.copyfile(self.fixture.core, self.core)
        self.root = self.base / 'gp'
        (self.root / 'scripts/security').mkdir(parents=True)
        for name in ('requirements.txt', 'tools.json'):
            (self.root / 'scripts/security' / name).write_text('synthetic exact ' + name)
        self.write_source('server.js', b'const actual = true;\n')
        self.write_source(build.SMALL_TARGET, b'const smaller = true;\n')
        plan = {'diagnosticOnly': True, 'securityGatePassed': False,
            'wholeUnmodifiedFiles': [self.entries['server.js'], self.entries[build.SMALL_TARGET]]}
        self.fixture.write('sourcebuild-diagnostic-plan.json', plan)
        controls = {name: (sources, rule) for name, rule, sources in build.control_sources()}
        for case in self.fixture.gate['cases']:
            name = case['name']
            paths = list(controls[name.removeprefix('control-')][0]) if name.startswith('control-') else [build.SMALL_TARGET if name == 'small-common' else 'server.js']
            stage = self.fixture.private / 'stages' / name
            findings = []
            if name.startswith('control-'):
                rule = controls[name.removeprefix('control-')][1]
                findings.append({'path': str(stage / 'unsafe.js'), 'check_id': rule.removesuffix('.yaml').replace('/', '.')})
            result = {'version': build.VERSION, 'errors': [], 'paths': {'scanned': [str(stage / path) for path in paths]},
                'results': findings, 'time': {'fixpoint_timeouts': []}}
            self.fixture.write(name + '.json', result)
            case['resultSha256'] = prepare.sha((self.fixture.private / (name + '.json')).read_bytes())
        self.fixture.write('gate-result.json', self.fixture.gate)

    def write_source(self, name, content):
        if not hasattr(self, 'entries'):
            self.entries = {}
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        self.entries[name] = {'path': name, 'bytes': len(content), 'sha256': prepare.sha(content)}

    def bind(self, output='results', **kwargs):
        return prepare.prepare(self.fixture.private, self.root, self.base / output,
            kwargs.get('core', self.core), kwargs.get('prefix', self.prefix), self.runner,
            kwargs.get('version', build.VERSION))

    def test_real_raw_result_chain_and_private_binary_binding(self):
        binding = self.bind()
        self.assertTrue(binding['qualificationComplete'])
        self.assertEqual(binding['qualificationCaseCount'], 10)
        self.assertFalse(binding['fullProjectScanApproved'])
        self.assertEqual(binding['nativeCoreSha256'], self.fixture.sha)
        self.assertTrue((self.base / 'results/sourcecore-gate-result.json').is_file())
        self.assertFalse((self.base / 'results/server.js').exists())
        self.assertFalse((self.base / 'results/scan-result.json').exists())
        self.assertFalse((self.base / 'results/gate-result.json').exists(), 'only the subsequent complete project scan may write this receipt')

    def test_core_outside_private_venv_or_wrapper_drift_never_creates_results(self):
        for kwargs in ({'core': self.fixture.core}, {'prefix': self.runner / 'other'}, {'version': 'latest'}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.bind(**kwargs)
            self.assertFalse((self.base / 'results').exists())

    def test_actual_core_mutation_fails_even_when_reported_version_is_unchanged(self):
        self.core.write_bytes(self.core.read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'actually qualified'):
            self.bind()
        self.assertFalse((self.base / 'results').exists())

    def test_raw_result_changed_after_qualification_is_rejected(self):
        file = self.fixture.private / 'server-common.json'
        file.write_bytes(file.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'raw scanner result changed'):
            self.bind()

    def test_matching_receipt_hash_cannot_hide_fixpoint_or_safe_control_regressions(self):
        original = json.loads((self.fixture.private / 'control-require.json').read_bytes())
        for change in ('fixpoint', 'safe-control'):
            with self.subTest(change=change):
                file = self.fixture.private / 'control-require.json'
                result = copy.deepcopy(original)
                if change == 'fixpoint':
                    result['time']['fixpoint_timeouts'] = [{'severity': 'warn'}]
                else:
                    result['results'][0]['path'] = result['results'][0]['path'].replace('unsafe.js', 'safe.js')
                self.fixture.write(file.name, result)
                for case in self.fixture.gate['cases']:
                    if case['name'] == 'control-require':
                        case['resultSha256'] = prepare.sha(file.read_bytes())
                self.fixture.write('gate-result.json', self.fixture.gate)
                with self.assertRaises(ValueError):
                    self.bind()
                self.assertFalse((self.base / 'results').exists())

    def test_source_drift_after_whole_file_qualification_is_rejected(self):
        (self.root / 'server.js').write_text('changed actual source')
        with self.assertRaisesRegex(ValueError, 'source changed'):
            self.bind()

    def test_missing_whole_file_identity_is_not_a_successful_qualification(self):
        self.fixture.write('sourcebuild-diagnostic-plan.json', {
            'diagnosticOnly': True, 'securityGatePassed': False, 'wholeUnmodifiedFiles': []})
        with self.assertRaisesRegex(ValueError, 'Both original whole-file'):
            self.bind()

    def test_shadow_cli_in_path_cannot_replace_the_verified_private_entrypoint(self):
        shadow = self.base / 'shadow'
        shadow.mkdir()
        marker = shadow / 'executed'
        (shadow / 'semgrep').write_text('import pathlib;pathlib.Path(' + repr(str(marker)) + ').write_text("wrong scanner")')
        wrapper = self.prefix / 'bin/semgrep'
        wrapper.write_text('print("verified-wrapper-only")')
        with patch.dict(os.environ, {'PATH': str(shadow)}):
            selected = prepare.select_scanner('semgrep', str(wrapper))
            result = subprocess.run([sys.executable, selected], capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), 'verified-wrapper-only')
        self.assertFalse(marker.exists())
        with self.assertRaisesRegex(ValueError, 'unqualified scanner override'):
            prepare.select_scanner(str(shadow / 'semgrep'), str(wrapper))


if __name__ == '__main__':
    unittest.main()

"""Exercise the closed legacy-native/current-wrapper approval through real trust checks.

All archives, GitHub replies and native bytes are synthetic. Only transport and
the native version subprocess are simulated; archive/provenance validation and
acquisition/read-back are the production implementations.
"""
import copy
import io
import json
import os
from pathlib import Path
import tarfile
import unittest
from unittest.mock import patch
import zipfile

import build_semgrep_source as build
import publish_semgrep_core_tool as publisher
import semgrep_core_tool as tool
import source_core_acquisition as acquisition
import source_core_identity as identity
import test_source_core_acquisition as fixture


APPROVAL = '.github/security-semgrep-core-reuse.json'


class CompilerReuseApprovalTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixture.CompilerAcquisitionTests('runTest')
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        self.current = copy.deepcopy(self.fx.identity)
        self.legacy = copy.deepcopy(self.current)
        del self.legacy['programs']['install_semgrep_runtime.py']
        self.legacy['requirementsSha256'] = '1' * 64
        # These consumers/guards changed without changing native build inputs.
        for index, name in enumerate(('source_core_identity.py',
                                      'source_core_acquisition.py', 'gates.py'), 2):
            self.legacy['programs'][name] = str(index) * 64
        self.producer_key = identity.digest(identity.canonical(self.legacy))
        with zipfile.ZipFile(io.BytesIO(self.fx.zip)) as outer:
            with tarfile.open(fileobj=io.BytesIO(outer.read(tool.ARCHIVE)), mode='r:xz') as inner:
                self.members = {item.name: inner.extractfile(item).read() for item in inner}
        self.publish_legacy()
        self.approval_path = self.fx.root / APPROVAL

    def publish_legacy(self, mutate_provenance=None):
        """Create a self-consistent producer; never patch a verification function."""
        manifest = json.loads(self.members['tool-manifest.json'])
        provenance = json.loads(self.members['upstream/provenance.json'])
        provenance['buildInputsSha256'] = self.producer_key
        if mutate_provenance:
            mutate_provenance(provenance)
        self.members['upstream/provenance.json'] = tool.canonical(provenance)
        manifest['buildInputs'] = copy.deepcopy(self.legacy)
        manifest['buildInputsSha256'] = self.producer_key
        manifest['files']['upstream/provenance.json'] = {
            'bytes': len(self.members['upstream/provenance.json']),
            'sha256': tool.digest(self.members['upstream/provenance.json'])}
        self.members['tool-manifest.json'] = tool.canonical(manifest)
        inner = publisher.archive_bytes({name: (data,
            0o755 if name == 'bin/semgrep-core' else 0o644, 'regular')
            for name, data in self.members.items()})
        outer = io.BytesIO()
        with zipfile.ZipFile(outer, 'w') as archive:
            archive.writestr(tool.ARCHIVE, inner)
        self.fx.zip = outer.getvalue()
        self.fx.pin.update(buildInputs=copy.deepcopy(self.legacy),
            buildInputsSha256=self.producer_key,
            manifestSha256=tool.digest(self.members['tool-manifest.json']),
            wrapper={'version': build.VERSION,
                     'requirementsSha256': self.legacy['requirementsSha256']},
            archive={'name': tool.ARCHIVE, 'bytes': len(inner), 'sha256': tool.digest(inner)},
            artifact={'id': 4, 'name': 'semgrep-core-tool-2-1',
                      'bytes': len(self.fx.zip), 'sha256': tool.digest(self.fx.zip)})
        self.fx.artifact_metadata.update(size_in_bytes=len(self.fx.zip),
            digest='sha256:' + tool.digest(self.fx.zip))
        self.fx.pin_file()

    def approval(self):
        current = identity.inputs(self.fx.root)
        return {'format': 'gp-semgrep-core-reuse-approval/v1',
            'migration': 'legacy-native-current-wrapper-v1',
            'producerPinSha256': tool.digest(self.fx.pin_path.read_bytes()),
            'producerBuildInputsSha256': self.producer_key,
            'consumerBuildInputsSha256': identity.digest(identity.canonical(current)),
            'native': copy.deepcopy(self.fx.pin['native']),
            'compilerInputsSha256': identity.digest(identity.canonical(
                identity.native_compiler_identity(current))),
            'freshCurrentQualificationRequired': True,
            'fullProjectScanApproved': False,
            'requirements': {'producerSha256': self.legacy['requirementsSha256'],
                             'consumerSha256': current['requirementsSha256']},
            'installer': {'path': 'install_semgrep_runtime.py',
                          'sha256': current['programs']['install_semgrep_runtime.py']}}

    def approve(self, mutate=None):
        approval = self.approval()
        if mutate:
            mutate(approval)
        self.approval_path.write_bytes(tool.canonical(approval))
        return approval

    def warm(self):
        with patch.dict(os.environ, self.fx.environment), \
                patch.object(tool, 'github_request', side_effect=self.fx.request), \
                patch.object(build, 'build_core', side_effect=AssertionError('approved reuse must not compile')):
            return self.fx.acquire()

    def assert_cold_without_fetch(self):
        with patch.object(acquisition, 'fetch', side_effect=AssertionError('stale approval must not fetch')), \
                patch.object(build, 'build_core', side_effect=self.fx.cold) as cold:
            binary = self.fx.acquire()
        cold.assert_called_once()
        receipt = acquisition.verify(self.fx.output, self.fx.root, binary.read_bytes())
        self.assertEqual(receipt['mode'], 'cold_build')
        self.assertEqual(receipt['format'], 'gp-semgrep-core-acquisition/v1')
        self.assertNotIn('reuseApproval', receipt)

    def test_approved_legacy_archive_reuses_native_without_rewriting_producer_or_approving_scan(self):
        self.approve()
        pin_before = self.fx.pin_path.read_bytes()
        archive_before = self.fx.zip
        # Independently prove the synthetic legacy archive passes the real consumer.
        native, manifest = tool.verify_zip(self.fx.zip, self.fx.pin)
        self.assertEqual(native, self.fx.native)
        self.assertEqual(manifest['buildInputs'], self.legacy)
        self.assertNotEqual(self.legacy, identity.inputs(self.fx.root))
        self.assertEqual(identity.native_compiler_identity(self.legacy),
                         identity.native_compiler_identity(identity.inputs(self.fx.root)))
        binary = self.warm()
        receipt = acquisition.verify(self.fx.output, self.fx.root, binary.read_bytes())
        self.assertEqual((receipt['format'], receipt['mode']),
                         ('gp-semgrep-core-acquisition/v2', 'reviewed_reuse'))
        self.assertEqual(receipt['buildInputsSha256'], self.approval()['consumerBuildInputsSha256'])
        self.assertEqual(receipt['reuseApproval'], {'path': APPROVAL,
            'sha256': tool.digest(self.approval_path.read_bytes())})
        self.assertEqual(receipt['producer']['pinSha256'], tool.digest(pin_before))
        self.assertTrue(receipt['freshCurrentQualificationRequired'])
        self.assertFalse(receipt['fullProjectScanApproved'])
        self.assertFalse((self.fx.output / 'gate-result.json').exists())
        self.assertEqual(self.fx.pin_path.read_bytes(), pin_before)
        self.assertEqual(self.fx.zip, archive_before)
        self.assertEqual((self.fx.output / 'sourcebuild-reuse-manifest.json').read_bytes(),
                         self.members['tool-manifest.json'])
        recorded_current = json.loads((self.fx.output / acquisition.INPUTS).read_bytes())
        self.assertEqual(recorded_current, identity.inputs(self.fx.root))

    def test_legacy_archive_without_explicit_approval_remains_cold(self):
        self.assert_cold_without_fetch()

    def test_legitimate_approval_for_a_previous_consumer_key_is_cold(self):
        self.approve()
        current = self.fx.root / 'scripts/security/gates.py'
        current.write_bytes(current.read_bytes() + b'\n# later consumer qualification\n')
        self.assert_cold_without_fetch()

    def test_selected_approval_cannot_authorize_changed_critical_program(self):
        current = self.fx.root / 'scripts/security/build_semgrep_source.py'
        current.write_bytes(current.read_bytes() + b'\n# changed native builder\n')
        self.approve()  # Even a forged approval with the exact new consumer key fails.
        with patch.object(acquisition, 'fetch') as fetch, patch.object(build, 'build_core') as cold, \
                self.assertRaises(ValueError):
            self.fx.acquire()
        fetch.assert_not_called(); cold.assert_not_called()

    def test_selected_approval_is_closed_and_never_grants_scan_approval(self):
        for change in (lambda doc: doc.update(fullProjectScanApproved=True),
                       lambda doc: doc.update(freshCurrentQualificationRequired=False),
                       lambda doc: doc['native'].update(sha256='9' * 64),
                       lambda doc: doc['installer'].update(path='../install_semgrep_runtime.py'),
                       lambda doc: doc['requirements'].update(producerSha256='9' * 64),
                       lambda doc: doc.update(unreviewedExtra=True)):
            with self.subTest(change=change):
                self.approve(change)
                with patch.object(acquisition, 'fetch') as fetch, patch.object(build, 'build_core') as cold, \
                        self.assertRaises(ValueError):
                    self.fx.acquire()
                fetch.assert_not_called(); cold.assert_not_called()

    def test_consistent_outer_hashes_do_not_hide_corrupt_producer_provenance(self):
        self.publish_legacy(lambda doc: doc.update(buildInputsSha256='f' * 64))
        self.approve()
        with patch.dict(os.environ, self.fx.environment), \
                patch.object(tool, 'github_request', side_effect=self.fx.request), \
                patch.object(build, 'build_core') as cold, self.assertRaises(ValueError):
            self.fx.acquire()
        cold.assert_not_called()
        self.assertFalse((self.fx.output / acquisition.RECEIPT).exists())

    def test_verify_rejects_approval_tampering_and_current_identity_drift(self):
        self.approve(); self.warm()
        original = self.approval_path.read_bytes()
        self.approval_path.write_bytes(original + b' ')
        with self.assertRaises(ValueError):
            acquisition.verify(self.fx.output, self.fx.root, self.fx.native)
        self.approval_path.write_bytes(original)
        installer = self.fx.root / 'scripts/security/install_semgrep_runtime.py'
        installer.write_bytes(installer.read_bytes() + b'\n# changed installer\n')
        with self.assertRaises(ValueError):
            acquisition.verify(self.fx.output, self.fx.root, self.fx.native)


if __name__ == '__main__':
    unittest.main()

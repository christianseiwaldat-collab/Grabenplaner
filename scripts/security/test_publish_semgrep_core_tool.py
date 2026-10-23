import copy
import io
import json
import os
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import build_semgrep_source as build
import publish_semgrep_core_tool as publisher
import semgrep_core_tool as consumer


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'upstream'
        self.private = self.root / 'private-gp-evidence'
        self.dependencies = self.root / 'license-sources'
        for directory in (self.source, self.private, self.dependencies):
            directory.mkdir()
        self.core = self.root / 'qualified-core'
        core = bytearray(120)
        core[:7] = b'\x7fELF\x02\x01\x01'
        struct.pack_into('<HH', core, 16, 2, 62)
        struct.pack_into('<Q', core, 32, 64)
        struct.pack_into('<HH', core, 54, 56, 1)
        struct.pack_into('<I', core, 64, 1)
        self.core.write_bytes(core)
        self.sha = publisher.sha(core)
        (self.source / 'LICENSE').write_text('synthetic upstream license\n')
        self.secret = 'PRIVATE_GP_SOURCE_AND_SECRET_NEVER_PUBLISH'
        (self.private / 'server.js').write_text(self.secret)
        (self.private / 'scan-result.json').write_text(self.secret)
        self.sbom = {'bomFormat': 'CycloneDX', 'specVersion': '1.6', 'version': 1,
                     'metadata': {'properties': [{'name': 'private', 'value': self.secret}]},
                     'components': [{'type': 'library', 'name': 'synthetic-upstream', 'version': '1',
                                     'properties': [{'name': 'private', 'value': self.secret}],
                                     'licenses': [{'license': {'id': 'MIT'}}]}]}
        self.write('sourcebuild-toolchain-sbom.json', self.sbom)
        self.provenance = {
            'repository': build.UPSTREAM, 'tag': build.TAG, 'tagObject': build.TAG_OBJECT,
            'commit': build.COMMIT, 'limitsBeforeSha256': build.LIMITS_BEFORE,
            'limitsAfterSha256': build.LIMITS_AFTER, 'changedSourcePaths': [build.LIMITS],
            'variableSetGraphLimitsUnchanged': True, 'upstreamDockerfileSha256': build.DOCKERFILE,
            'officialTarget': 'semgrep-core-container', 'baseImage': build.ALPINE,
            'compilerSourceCommit': build.COMPILER, 'opamRepositoryCommit': build.OPAM_REPOSITORY,
            'patchSha256': publisher.sha(b'synthetic patch'), 'derivedRecipeSha256': 'd' * 64,
            'privateExtraNeverCopied': self.secret,
        }
        self.write('sourcebuild-source-provenance.json', self.provenance)
        self.native = {
            'imageId': 'sha256:' + 'a' * 64, 'binarySha256': self.sha, 'binaryBytes': len(core),
            'sourceModified': True, 'officialReleaseBinary': False, 'baseImage': build.ALPINE,
            'versionOutput': build.VERSION, 'compilerOutput': '5.4+' + build.COMPILER,
            'sbomSha256': publisher.sha((self.private / 'sourcebuild-toolchain-sbom.json').read_bytes()),
            'privateExtraNeverCopied': self.secret,
        }
        self.write('sourcebuild-native-provenance.json', self.native)
        cases = [{'name': name, 'executionEvidenceValid': True, 'analysisCompleteForCase': True,
                  'fixpointFieldPresent': True, 'fixpointTimeoutCount': 0,
                  'scannedFiles': 2 if name.startswith('control-') else 1,
                  'findingCount': 1 if name.startswith('control-') else 0,
                  'exitCode': 1 if name.startswith('control-') else 0,
                  'controlPassed': True if name.startswith('control-') else None,
                  'privateFindingNeverCopied': self.secret}
                 for name in sorted(publisher.CASES)]
        self.gate = {'gate': 'sast-diagnostic', 'diagnosticOnly': True,
                     'securityGatePassed': False, 'complete': False, 'passed': False,
                     'diagnosticExecutionComplete': True, 'controlsPassed': True,
                     'scannerVersion': build.VERSION, 'sourceModified': True,
                     'officialReleaseBinary': False, 'nativeCoreSha256': self.sha, 'cases': cases}
        self.write('gate-result.json', self.gate)
        notice = 'Synthetic dependency notice; no production input.'
        self.ledger = self.root / 'reviewed-license-ledger.json'
        self.license_value = {
            'format': publisher.LEDGER_FORMAT, 'status': 'complete', 'binarySha256': self.sha,
            'coverage': {'staticallyLinkedDependenciesReviewed': True, 'noticesComplete': True,
                         'correspondingSourceComplete': True},
            'reviewReference': 'synthetic-unit-test-only',
            'components': [{'name': 'synthetic-upstream', 'version': '1', 'licenseExpression': 'MIT',
                            'notices': [{'text': notice, 'sha256': publisher.sha(notice.encode())}],
                            'correspondingSource': None}],
        }
        self.ledger.write_bytes(publisher.encoded(self.license_value))

    def write(self, name, value):
        (self.private / name).write_bytes(publisher.encoded(value))

    def prepare(self, output='tool-output'):
        upstream = {'upstream/README': (b'Only synthetic upstream source\n', 0o644, 'regular')}
        with patch.object(publisher, 'source_members', return_value=(upstream, b'synthetic patch')):
            return publisher.prepare(self.source, self.private, self.core, self.ledger,
                                     self.dependencies, self.root / output)

    def test_exact_tool_archive_and_nested_source_exclude_adjacent_private_data(self):
        receipt = self.prepare()
        archive = (self.root / 'tool-output/semgrep-core-tool.tar.xz').read_bytes()
        self.assertEqual(receipt['archive']['sha256'], publisher.sha(archive))
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:xz') as tool:
            self.assertEqual(set(tool.getnames()), set(publisher.FILES) | {'tool-manifest.json'})
            manifest_bytes = tool.extractfile('tool-manifest.json').read()
            manifest = json.loads(manifest_bytes)
            self.assertEqual(receipt['manifest']['sha256'], publisher.sha(manifest_bytes))
            self.assertEqual(manifest['format'], 'gp-semgrep-core-tool/v1')
            self.assertEqual(manifest['qualification']['caseCount'], 10)
            for entry in tool.getmembers():
                self.assertTrue(entry.isfile())
                self.assertEqual((entry.uid, entry.gid, entry.mtime, entry.uname, entry.gname), (0, 0, 0, '', ''))
                content = tool.extractfile(entry).read()
                self.assertNotIn(self.secret.encode(), content)
                if entry.name != 'tool-manifest.json':
                    self.assertEqual(manifest['files'][entry.name], {'bytes': len(content), 'sha256': publisher.sha(content)})
            with tarfile.open(fileobj=io.BytesIO(tool.extractfile('upstream/corresponding-source.tar.xz').read()), mode='r:xz') as source:
                self.assertEqual(source.getnames(), ['upstream/README'])
                self.assertNotIn(self.secret.encode(), source.extractfile('upstream/README').read())
        self.assertFalse(receipt['securityGateApproved'])
        self.assertFalse(receipt['uploadPerformed'])

    def test_identical_inputs_produce_identical_archive_bytes(self):
        first = self.prepare('first')
        second = self.prepare('second')
        self.assertEqual(first, second)
        self.assertEqual((self.root / 'first/semgrep-core-tool.tar.xz').read_bytes(), (self.root / 'second/semgrep-core-tool.tar.xz').read_bytes())

    def test_publisher_archive_passes_independent_consumer_and_fails_after_tampering(self):
        receipt = self.prepare()
        data = (self.root / 'tool-output' / consumer.ARCHIVE).read_bytes()
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr(consumer.ARCHIVE, data)
        outer = buffer.getvalue()
        pin = {'format': consumer.FORMAT, 'repository': {'fullName': 'synthetic/gp', 'id': 1},
               'run': {'id': 2, 'attempt': 1, 'headSha': 'a' * 40, 'workflowId': 3,
                       'workflowPath': '.github/workflows/sast-source-build.yml'},
               'artifact': {'id': 4, 'name': 'semgrep-core-tool-2-1', 'bytes': len(outer), 'sha256': publisher.sha(outer)},
               'archive': {'name': consumer.ARCHIVE, 'bytes': len(data), 'sha256': publisher.sha(data)},
               'manifestSha256': receipt['manifest']['sha256'], 'native': receipt['core'],
               'wrapper': {'version': build.VERSION, 'requirementsSha256': 'b' * 64},
               'toolsConfigurationSha256': 'c' * 64, 'source': consumer.UPSTREAM}
        actual, manifest = consumer.verify_zip(outer, pin)
        self.assertEqual(actual, self.core.read_bytes())
        self.assertEqual(manifest['qualification']['caseCount'], 10)
        with self.assertRaises(ValueError): consumer.verify_zip(outer + b'forged', pin)

    def test_incomplete_or_unbound_qualification_never_creates_tool(self):
        for name, mutate in [
            ('not-complete', lambda x: x.update(diagnosticExecutionComplete=False)),
            ('wrong-core', lambda x: x.update(nativeCoreSha256='b' * 64)),
            ('missing-case', lambda x: x['cases'].pop()),
            ('timeout', lambda x: x['cases'][0].update(fixpointTimeoutCount=1)),
            ('missing-target', lambda x: x['cases'][0].update(scannedFiles=0)),
            ('control-fails', lambda x: x['cases'][0].update(controlPassed=False)),
            ('fake-gate-approval', lambda x: x.update(securityGatePassed=True)),
        ]:
            with self.subTest(name=name):
                gate = copy.deepcopy(self.gate); mutate(gate); self.write('gate-result.json', gate)
                with self.assertRaises(ValueError):
                    self.prepare(name)
                self.assertFalse((self.root / name).exists())

    def test_license_incompleteness_and_forged_notices_fail_before_archiving(self):
        for name, mutate in [
            ('incomplete', lambda x: x.update(status='incomplete')),
            ('unbound', lambda x: x.update(binarySha256='b' * 64)),
            ('missing-source-review', lambda x: x['coverage'].update(correspondingSourceComplete=False)),
            ('forged-text', lambda x: x['components'][0]['notices'][0].update(text='forged')),
            ('extra-private-field', lambda x: x.update(private=self.secret)),
        ]:
            with self.subTest(name=name):
                value = copy.deepcopy(self.license_value); mutate(value)
                self.ledger.write_bytes(publisher.encoded(value))
                with self.assertRaises(ValueError):
                    self.prepare(name)
                self.assertFalse((self.root / name).exists())

    def test_duplicate_qualification_and_license_json_keys_are_rejected(self):
        self.write('gate-result.json', self.gate)
        self.ledger.write_bytes(b'{"status":"incomplete","status":"complete"}')
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON key'):
            self.prepare('duplicate-license-key')
        self.ledger.write_bytes(publisher.encoded(self.license_value))
        (self.private / 'gate-result.json').write_bytes(b'{"complete":false,"complete":true}')
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON key'):
            self.prepare('duplicate-qualification-key')

    def test_dependency_source_digest_and_explicit_single_archive_path(self):
        data = b'synthetic dependency source archive'
        (self.dependencies / 'dependency.tar.xz').write_bytes(data)
        reference = {'filename': 'dependency.tar.xz', 'sha256': publisher.sha(data),
                     'bytes': len(data), 'url': 'https://example.org/upstream/dependency.tar.xz'}
        self.license_value['components'][0]['correspondingSource'] = reference
        self.ledger.write_bytes(publisher.encoded(self.license_value))
        _, members = publisher.license_ledger(self.ledger, self.dependencies, self.sha)
        self.assertEqual(members['dependency-sources/dependency.tar.xz'][0], data)
        for bad in ['../private-gp-evidence/server.js', '/server.js', 'sub/dependency.tar.xz']:
            reference['filename'] = bad
            self.ledger.write_bytes(publisher.encoded(self.license_value))
            with self.assertRaises(ValueError):
                publisher.license_ledger(self.ledger, self.dependencies, self.sha)

    def test_existing_output_and_nested_output_are_rejected(self):
        output = self.root / 'existing'; output.mkdir(); (output / 'keep').write_text('untouched')
        with self.assertRaises(ValueError): self.prepare('existing')
        self.assertEqual((output / 'keep').read_text(), 'untouched')
        with self.assertRaises(ValueError):
            publisher.prepare(self.source, self.private, self.core, self.ledger,
                              self.dependencies, self.private / 'nested')

    def test_source_member_paths_and_hardlink_inputs_fail_closed(self):
        for name in ['../private', '/absolute', 'a//b', 'a/./b', 'a\\b', 'a\nb']:
            with self.subTest(name=name), self.assertRaises(ValueError): publisher.safe_relative(name)
        linked = self.root / 'linked-core'
        os.link(self.core, linked)
        with self.assertRaises(ValueError): self.prepare('hardlinked-core')

    def test_corresponding_source_uses_only_inventory_bound_upstream_tracked_files(self):
        fixtures = Path(__file__).parent / 'fixtures'
        files = {'Dockerfile': (fixtures / 'semgrep-1.181.0-Dockerfile').read_bytes(),
                 build.LIMITS: build.approved_patch((fixtures / 'semgrep-1.181.0-Limits_semgrep.ml').read_bytes()),
                 'LICENSE': (fixtures / 'semgrep-1.181.0-LICENSE').read_bytes()}
        inventory = []
        for name, data in files.items():
            file = self.source / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(data)
            inventory.append({'path': name, 'kind': 'regular', 'bytes': len(data), 'sha256': publisher.sha(data)})
        (self.source / 'adjacent-private.js').write_text(self.secret)
        self.write('sourcebuild-source-inventory.json', inventory)
        provenance = {'derivedRecipeSha256': publisher.sha(build.pinned_recipe(files['Dockerfile'])),
                      'patchSha256': publisher.sha(b'synthetic patch')}
        def git(source, *args):
            if args == ('rev-parse', 'HEAD'): return (build.COMMIT + '\n').encode()
            if args == ('remote', 'get-url', 'origin'): return (build.UPSTREAM + '\n').encode()
            if args == ('submodule', 'status', '--recursive'): return (' ' + build.SUBMODULE[1] + ' ' + build.SUBMODULE[0] + ' (pinned)\n').encode()
            if args == ('diff', '--name-only'): return (build.LIMITS + '\n').encode()
            if args == ('diff', '--cached', '--name-only'): return b''
            if args == ('ls-files', '-z', '--recurse-submodules'): return ('\0'.join(files) + '\0').encode()
            if args[0] == 'diff': return b'synthetic patch'
            raise AssertionError(args)
        with patch.object(publisher, '_git', side_effect=git):
            members, _ = publisher.source_members(self.source, self.private, provenance)
            self.assertNotIn('upstream/adjacent-private.js', members)
            self.assertFalse(any(self.secret.encode() in item[0] for item in members.values()))
            inventory[0]['privateExtra'] = self.secret
            self.write('sourcebuild-source-inventory.json', inventory)
            with self.assertRaises(ValueError): publisher.source_members(self.source, self.private, provenance)
            del inventory[0]['privateExtra']
            self.write('sourcebuild-source-inventory.json', inventory)
            (self.source / build.LIMITS).write_bytes(files[build.LIMITS] + b'\n')
            with self.assertRaises(ValueError): publisher.source_members(self.source, self.private, provenance)


if __name__ == '__main__':
    unittest.main()

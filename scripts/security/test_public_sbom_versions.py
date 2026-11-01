"""Explicit upstream inventory versions, sanitization and publication roundtrip."""
import copy
import io
import json
import tarfile
import unittest

import publish_semgrep_core_tool as publisher
import test_publish_semgrep_core_tool as fixtures


class PublicSbomVersions(unittest.TestCase):
    def fixture(self):
        return {'bomFormat': 'CycloneDX', 'specVersion': '1.7', 'components': [
            {'type': 'library', 'name': 'upstream', 'version': '1',
             'group': 'example', 'purl': 'pkg:generic/example/upstream@1',
             'bom-ref': 'component-1', 'scope': 'required',
             'licenses': [{'license': {'id': 'MIT'}}]}]}

    def test_explicit_known_versions_and_unknown_version_rejection(self):
        for version in ('1.4', '1.5', '1.6', '1.7'):
            value = self.fixture(); value['specVersion'] = version
            self.assertEqual(json.loads(publisher.public_sbom(value))['specVersion'], version)
        for version in (None, '1.3', '1.8', '2.0', 1.7, True):
            value = self.fixture(); value['specVersion'] = version
            with self.subTest(version=version), self.assertRaises(ValueError):
                publisher.public_sbom(value)

    def test_version_17_preserves_inventory_and_excludes_private_metadata(self):
        value = self.fixture(); expected = copy.deepcopy(value['components'])
        value['metadata'] = {'properties': [{'name': 'private', 'value': 'PRIVATE_MARKER'}]}
        value['components'][0].update(description='PRIVATE_MARKER', properties=[{'name': 'private', 'value': 'PRIVATE_MARKER'}])
        value['components'][0]['licenses'][0]['license']['url'] = 'PRIVATE_MARKER'
        raw = publisher.public_sbom(value); actual = json.loads(raw)
        self.assertNotIn(b'PRIVATE_MARKER', raw)
        self.assertEqual(actual, {'bomFormat': 'CycloneDX', 'specVersion': '1.7', 'version': 1, 'components': expected})

    def test_version_17_preserves_all_existing_field_bounds(self):
        for invalid in ('a' * 2049, 'name\ncontrol', 17, None, True):
            value = self.fixture(); value['components'][0]['name'] = invalid
            with self.subTest(invalid=type(invalid).__name__), self.assertRaises(ValueError):
                publisher.public_sbom(value)
        for components in (None, {}, []):
            value = self.fixture(); value['components'] = components
            with self.subTest(components=components), self.assertRaises(ValueError):
                publisher.public_sbom(value)

    def test_version_17_publisher_and_independent_consumer_roundtrip(self):
        fixture = fixtures.PublisherTests('test_publisher_archive_passes_independent_consumer_and_fails_after_tampering')
        fixture.setUp(); self.addCleanup(fixture.doCleanups)
        fixture.sbom['specVersion'] = '1.7'
        fixture.write('sourcebuild-toolchain-sbom.json', fixture.sbom)
        fixture.native['sbomSha256'] = publisher.sha((fixture.private / 'sourcebuild-toolchain-sbom.json').read_bytes())
        fixture.write('sourcebuild-native-provenance.json', fixture.native)
        receipt = fixture.prepare()
        output = fixture.root / 'tool-output'
        self.assertEqual(publisher.verify_publication(output), receipt)
        with tarfile.open(fileobj=io.BytesIO((output / publisher.ARCHIVE).read_bytes()), mode='r:xz') as archive:
            sbom = json.loads(archive.extractfile('upstream/toolchain-sbom.cdx.json').read())
        self.assertEqual(sbom['specVersion'], '1.7')
        self.assertEqual(len(sbom['components']), 1)


if __name__ == '__main__':
    unittest.main()

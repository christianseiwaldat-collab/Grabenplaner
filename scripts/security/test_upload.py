import base64
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from prepare_upload import identity, prepare, uploaded_receipt


class UploadEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.raw = self.root / 'raw'; self.raw.mkdir()
        self.public = self.root / 'public'; self.public.mkdir()
        self.key = self.root / 'recipient.pem'
        # Structural envelope fixture only; real RSA/GCM authentication and
        # per-file recovery are exercised by security-evidence-seal.test.js.
        self.key.write_text('-----BEGIN PUBLIC KEY-----\n' + base64.b64encode(b'synthetic DER identity').decode() + '\n-----END PUBLIC KEY-----\n')
        receipt = json.dumps({'sensitive': 'SYNTHETIC PRIVATE DETAIL', 'gate': 'sca',
                              'complete': True, 'passed': True, 'status': 'passed', 'exitCode': 0}).encode()
        (self.raw / 'gate-result.json').write_bytes(receipt)
        self.summary = {'schemaVersion': 1, 'gate': 'sca', 'complete': True, 'passed': True,
                        'status': 'passed', 'exitCode': 0, 'privateReceiptSha256': hashlib.sha256(receipt).hexdigest()}
        self.envelope = {'format': 'gp-security-evidence-v1',
                         'recipientSha256': hashlib.sha256(b'synthetic DER identity').hexdigest(),
                         **{key: base64.b64encode(b'x' * count).decode() for key, count in
                            [('wrappedKey', 384), ('iv', 12), ('tag', 16), ('ciphertext', 80)]}}
        self.write()

    def write(self):
        (self.public / 'gate-summary.json').write_text(json.dumps(self.summary))
        (self.public / 'private-evidence.gpe').write_text(json.dumps(self.envelope))

    def prepare(self, gate='sca'):
        return prepare(self.raw, self.public, self.key, gate, 'a' * 40, '123', '2')

    def test_bound_file_set_hashes_and_identity_are_recoverable(self):
        manifest = self.prepare()
        self.assertEqual(manifest['retentionDays'], 14)
        self.assertEqual((manifest['commit'], manifest['runId'], manifest['attempt']), ('a' * 40, '123', '2'))
        self.assertEqual({row['name'] for row in manifest['files']}, {'gate-summary.json', 'private-evidence.gpe'})
        for row in manifest['files']:
            content = (self.public / row['name']).read_bytes()
            self.assertEqual(row['sha256'], hashlib.sha256(content).hexdigest())
            self.assertEqual(row['bytes'], len(content))
        self.assertNotIn('SYNTHETIC PRIVATE DETAIL', (self.public / 'upload-manifest.json').read_text())
        with self.assertRaises(ValueError): self.prepare()

    def test_missing_each_required_file_blocks(self):
        for path in (self.raw / 'gate-result.json', self.public / 'gate-summary.json', self.public / 'private-evidence.gpe'):
            content = path.read_bytes(); path.unlink()
            with self.subTest(path=path.name), self.assertRaises(ValueError): self.prepare()
            path.write_bytes(content)

    def test_raw_extra_file_directory_or_previous_manifest_blocks(self):
        for name in ('sast.json', '.env', 'scanner.stdout', 'upload-manifest.json'):
            file = self.public / name; file.write_text('PRIVATE')
            with self.subTest(name=name), self.assertRaises(ValueError): self.prepare()
            file.unlink()
        (self.public / 'raw').mkdir()
        with self.assertRaises(ValueError): self.prepare()

    def test_gate_receipt_drift_and_wrong_gate_block(self):
        with self.assertRaises(ValueError): self.prepare('secrets')
        (self.raw / 'gate-result.json').write_text('changed')
        with self.assertRaises(ValueError): self.prepare()

    def test_malformed_unredacted_or_inconsistent_summary_blocks(self):
        original = copy.deepcopy(self.summary)
        for key, value in [('exitCode', False), ('passed', False), ('status', 'unknown'),
                           ('error', 'PRIVATE'), ('findingCount', -1), ('privateReceiptSha256', 'invalid')]:
            self.summary = {**original, key: value}; self.write()
            with self.subTest(key=key), self.assertRaises(ValueError): self.prepare()

    def test_failed_gate_can_preserve_encrypted_failure_evidence_without_becoming_success(self):
        self.summary.update(exitCode=1, passed=False, status='findings'); self.write()
        receipt = json.dumps(self.summary).encode()
        (self.raw / 'gate-result.json').write_bytes(receipt)
        self.summary['privateReceiptSha256'] = hashlib.sha256(receipt).hexdigest(); self.write()
        self.prepare()
        self.assertFalse(json.loads((self.public / 'gate-summary.json').read_text())['passed'])

    def test_wrong_recipient_or_malformed_envelope_blocks(self):
        original = copy.deepcopy(self.envelope)
        for key, value in [('recipientSha256', '0' * 64), ('format', 'plaintext'), ('iv', 'eA=='),
                           ('tag', 'eA=='), ('ciphertext', ''), ('wrappedKey', '%%%'), ('extra', 'PRIVATE')]:
            self.envelope = {**original, key: value}; self.write()
            with self.subTest(key=key), self.assertRaises(ValueError): self.prepare()

    def test_successful_sbom_requires_exact_published_sbom_digest(self):
        self.summary.update(gate='sbom', publishedSbomSha256='0' * 64)
        receipt = json.dumps(self.summary).encode()
        (self.raw / 'gate-result.json').write_bytes(receipt)
        self.summary['privateReceiptSha256'] = hashlib.sha256(receipt).hexdigest()
        self.write()
        with self.assertRaises(ValueError): self.prepare('sbom')
        content = b'{"bomFormat":"CycloneDX","components":[]}'
        (self.public / 'sbom.cdx.json').write_bytes(content)
        with self.assertRaises(ValueError): self.prepare('sbom')
        self.summary['publishedSbomSha256'] = hashlib.sha256(content).hexdigest(); self.write()
        self.assertEqual(len(self.prepare('sbom')['files']), 3)

    def test_correct_hash_does_not_allow_public_success_to_contradict_private_failure(self):
        receipt = {'gate': 'sca', 'exitCode': 1, 'complete': True, 'passed': False, 'status': 'findings'}
        content = json.dumps(receipt).encode(); (self.raw / 'gate-result.json').write_bytes(content)
        self.summary['privateReceiptSha256'] = hashlib.sha256(content).hexdigest(); self.write()
        with self.assertRaises(ValueError): self.prepare()

    def test_source_run_identity_and_action_digest_reject_missing_or_injected_values(self):
        self.assertEqual(uploaded_receipt('123', 'b' * 64)['artifactArchiveSha256'], 'b' * 64)
        for row in [('', '1', '1'), ('a' * 40, '0', '1'), ('a' * 40, '1', '1; echo PRIVATE'),
                    ('a' * 39, '1', '1'), ('A' * 40, '1', '1'), ('a' * 40, None, '1')]:
            with self.subTest(row=row), self.assertRaises(ValueError): identity(*row)
        for row in [('', 'b' * 64), ('1', ''), ('0', 'b' * 64), ('1', 'b' * 63), ('1', '../PRIVATE')]:
            with self.subTest(row=row), self.assertRaises(ValueError): uploaded_receipt(*row)

    def test_symbolic_evidence_does_not_follow_outside_public_directory(self):
        target = self.public / 'private-evidence.gpe'
        original = target.read_bytes(); target.unlink()
        outside = self.root / 'outside.gpe'; outside.write_bytes(original)
        try:
            target.symlink_to(outside)
        except OSError:
            self.skipTest('Symbolic-link creation unavailable; mandatory Linux qualification covers this case')
        with self.assertRaises(ValueError): self.prepare()


if __name__ == '__main__': unittest.main()

"""Bind the explicit, sanitized upload set to source/run identity and hashes.

This checks the encrypted envelope structurally; only the offline recipient can
authenticate/decrypt it. The action's ZIP digest and these per-file hashes are
different values and must both be checked when retaining a downloaded artifact.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re

GATES = ('sca', 'sast', 'secrets', 'sbom')
MAX_BYTES = 192 * 1024 * 1024


def require(condition):
    if not condition:
        raise ValueError('Invalid upload evidence contract')


def digest(content):
    return hashlib.sha256(content).hexdigest()


def regular_bytes(path):
    require(not path.is_symlink() and path.is_file())
    require(0 < path.stat().st_size <= MAX_BYTES)
    return path.read_bytes()


def identity(commit, run_id, attempt):
    require(isinstance(commit, str) and re.fullmatch(r'[0-9a-f]{40}', commit))
    for number in (run_id, attempt):
        require(isinstance(number, str) and re.fullmatch(r'[1-9][0-9]{0,19}', number))
    return {'commit': commit, 'runId': run_id, 'attempt': attempt}


def prepare(source, public, public_key, gate, commit, run_id, attempt):
    require(gate in GATES)
    metadata = identity(commit, run_id, attempt)
    require(not source.is_symlink() and source.is_dir())
    require(not public.is_symlink() and public.is_dir())
    summary_bytes = regular_bytes(public / 'gate-summary.json')
    summary = json.loads(summary_bytes)
    require(set(summary) <= {'schemaVersion', 'gate', 'complete', 'passed', 'status', 'exitCode',
                            'privateReceiptSha256', 'findingCount', 'blockingFindingCount',
                            'scannedFiles', 'scannedPackages', 'scannedWorktreeFiles', 'serverBytes',
                            'components', 'sourceSbomSha256', 'publishedSbomSha256', 'runnerInventorySha256'})
    require(summary.get('schemaVersion') == 1 and summary.get('gate') == gate)
    code = summary.get('exitCode')
    require(type(code) is int and code in (0, 1, 2))
    require(summary.get('status') == ('passed', 'findings', 'tool_or_coverage_error')[code])
    require(summary.get('passed') is (code == 0) and summary.get('complete') is (code != 2))
    for name, value in summary.items():
        if name.endswith('Sha256'):
            require(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value))
        if name in ('findingCount', 'blockingFindingCount', 'scannedFiles', 'scannedPackages',
                    'scannedWorktreeFiles', 'serverBytes', 'components'):
            require(type(value) is int and value >= 0)
    receipt_bytes = regular_bytes(source / 'gate-result.json')
    require(summary.get('privateReceiptSha256') == digest(receipt_bytes))
    receipt = json.loads(receipt_bytes)
    for name in ('gate', 'complete', 'passed', 'status', 'exitCode'):
        require(type(receipt.get(name)) is type(summary.get(name)) and receipt.get(name) == summary.get(name))
    names = {'gate-summary.json', 'private-evidence.gpe'}
    if gate == 'sbom' and code == 0:
        names.add('sbom.cdx.json')
        require(summary.get('publishedSbomSha256') == digest(regular_bytes(public / 'sbom.cdx.json')))
    require({path.name for path in public.iterdir()} == names)
    envelope = json.loads(regular_bytes(public / 'private-evidence.gpe'))
    require(set(envelope) == {'format', 'recipientSha256', 'wrappedKey', 'iv', 'tag', 'ciphertext'})
    require(envelope['format'] == 'gp-security-evidence-v1')
    pem = regular_bytes(public_key).decode('ascii').strip().splitlines()
    require(pem[0] == '-----BEGIN PUBLIC KEY-----' and pem[-1] == '-----END PUBLIC KEY-----')
    recipient = digest(base64.b64decode(''.join(pem[1:-1]), validate=True))
    require(envelope['recipientSha256'] == recipient)
    lengths = {field: len(base64.b64decode(envelope[field], validate=True))
               for field in ('wrappedKey', 'iv', 'tag', 'ciphertext')}
    require(lengths['wrappedKey'] >= 384 and lengths['iv'] == 12 and lengths['tag'] == 16 and lengths['ciphertext'] > 0)
    manifest = {'schemaVersion': 1, 'gate': gate, **metadata, 'retentionDays': 14,
                'recipientSha256': recipient, 'files': []}
    for name in sorted(names):
        content = regular_bytes(public / name)
        manifest['files'].append({'name': name, 'bytes': len(content), 'sha256': digest(content)})
    with (public / 'upload-manifest.json').open('x', encoding='utf8', newline='\n') as target:
        target.write(json.dumps(manifest, indent=2) + '\n')
    return manifest


def uploaded_receipt(artifact_id, artifact_digest):
    require(isinstance(artifact_id, str) and re.fullmatch(r'[1-9][0-9]{0,19}', artifact_id))
    require(isinstance(artifact_digest, str) and re.fullmatch(r'[a-f0-9]{64}', artifact_digest))
    return {'artifactId': artifact_id, 'artifactArchiveSha256': artifact_digest, 'retentionDays': 14}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--uploaded-receipt', action='store_true')
    parser.add_argument('--input'); parser.add_argument('--public'); parser.add_argument('--key')
    parser.add_argument('--gate', choices=GATES)
    args = parser.parse_args()
    try:
        if args.uploaded_receipt:
            result = uploaded_receipt(os.environ.get('ARTIFACT_ID'), os.environ.get('ARTIFACT_DIGEST'))
        else:
            result = prepare(Path(args.input), Path(args.public), Path(args.key), args.gate,
                             os.environ.get('GITHUB_SHA'), os.environ.get('GITHUB_RUN_ID'),
                             os.environ.get('GITHUB_RUN_ATTEMPT'))
        print(json.dumps(result))
        return 0
    except Exception:
        print('Upload evidence verification failed.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

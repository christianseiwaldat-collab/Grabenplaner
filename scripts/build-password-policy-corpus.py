#!/usr/bin/env python3
"""Reproduce the bundled password hash sets from pinned, public SecLists files.

No credentials are accepted. Network access is opt-in (--download); no user
password lookup is performed. Source plaintext stays in the chosen private cache.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tarfile
import urllib.request

COMMIT = '60e43f4d2b0251330ff18ea4fa76aabec0515dcb'
BASE = f'https://raw.githubusercontent.com/danielmiessler/SecLists/{COMMIT}/'
SOURCES = {
    'common': ('Passwords/Common-Credentials/xato-net-10-million-passwords.txt', 48312893,
               'c95989fecfae9c91aa9f5c730344d5cabd6335bb094c9c60aba16bf1742a72fe'),
    'breached': ('Passwords/Leaked-Databases/rockyou.txt.tar.gz', 53291283,
                '47c070a029bcdb4cbd0e02c69fed136ef46dce4048ddbadf177daa5e885b8172'),
    'license': ('LICENSE', 1072, '3dbdc93d5f8829de0941744841730a09c106d0732e5ae0e98ca1d77be7ded66c'),
    'commonReadme': ('Passwords/Common-Credentials/README.md', 872,
                     '49b7d00632c09b24bfa7c21bace2164b72815f0e50344604dd63ed66db2dbd37'),
    'breachedReadme': ('Passwords/Leaked-Databases/README.md', 588,
                       'fed6fdd445f13340db1919401cce54c3beb1f09ed2ed1392d4ea46a7d7d7df1b'),
}


def digest_file(file):
    with file.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def source_file(cache, specification, download):
    name, size, digest = specification
    target = cache / name.replace('/', '_')
    if not target.exists():
        if not download:
            raise ValueError(f'Source missing: {name}; provide pinned cache or use --download')
        request = urllib.request.Request(BASE + name, headers={'User-Agent': 'Grabenplaner-password-policy-corpus-builder'})
        temporary = target.with_suffix(target.suffix + '.partial')
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open('wb') as output:
            received = 0
            while chunk := response.read(1024 * 1024):
                received += len(chunk)
                if received > size:
                    raise ValueError('Source exceeds pinned byte limit')
                output.write(chunk)
        if temporary.stat().st_size != size or digest_file(temporary) != digest:
            raise ValueError(f'Source hash mismatch: {name}')
        os.replace(temporary, target)
    if target.stat().st_size != size or digest_file(target) != digest:
        raise ValueError(f'Source hash mismatch: {name}')
    return target


def candidates(stream, metrics):
    # Source rows use LF (or CRLF). No whitespace trimming, case conversion or NFC.
    for line in stream:
        metrics['rows'] += 1
        raw = line[:-1] if line.endswith(b'\n') else line
        if raw.endswith(b'\r'):
            raw = raw[:-1]
        try:
            value = raw.decode('utf-8', errors='strict')
        except UnicodeDecodeError:
            metrics['invalidUtf8Rows'] += 1
            continue
        if len(raw) > 1024 or not 15 <= len(value) <= 256:
            metrics['outsidePolicyRows'] += 1
            continue
        metrics['policyCompatibleRows'] += 1
        yield raw


def metric():
    return dict(rows=0, invalidUtf8Rows=0, outsidePolicyRows=0, policyCompatibleRows=0)


def atomic_write(file, data):
    temporary = file.with_suffix(file.suffix + '.tmp')
    temporary.write_bytes(data)
    os.replace(temporary, file)


def build(cache, destination, download=False):
    cache.mkdir(parents=True, exist_ok=True)
    inputs = {key: source_file(cache, spec, download) for key, spec in SOURCES.items()}
    common_metrics, breach_metrics = metric(), metric()
    common, common_end_rank = set(), None
    with inputs['common'].open('rb') as source:
        for raw in candidates(source, common_metrics):
            digest = hashlib.sha256(raw).hexdigest()
            if len(common) < 3000:
                common.add(digest)
                if len(common) == 3000:
                    common_end_rank = common_metrics['rows']
    if len(common) != 3000:
        raise ValueError('Not enough policy-compatible common passwords')
    breach = set()
    with tarfile.open(inputs['breached'], 'r:gz') as archive:
        members = archive.getmembers()
        if len(members) != 1 or members[0].name != 'rockyou.txt' or not members[0].isfile() or members[0].size != 139921497:
            raise ValueError('Unexpected archive structure or inflated size')
        with archive.extractfile(members[0]) as source:
            for raw in candidates(source, breach_metrics):
                breach.add(hashlib.sha256(raw).digest())
    if len(breach) < 3000 or len(breach) * 32 > 32 * 1024 * 1024:
        raise ValueError('Unexpected policy-compatible breach corpus size')
    common_data = ('\n'.join(sorted(common)) + '\n').encode('ascii')
    breach_data = b''.join(sorted(breach))
    artifacts = {}
    for key, file, data, count in [('common', 'common-sha256.txt', common_data, len(common)),
                                    ('breached', 'breached-sha256.bin', breach_data, len(breach))]:
        artifacts[key] = dict(file=file, count=count, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                              format='sha256-hex-lines' if key == 'common' else 'sha256-binary-sorted')
    manifest = dict(
        schemaVersion=1, policyVersion=1, corpusVersion='seclists-60e43f4d-p15-v1', sourceReviewedAt='2026-10-18',
        minimumCodePoints=15, maximumCodePoints=256, maximumUtf8Bytes=1024,
        inputSemantics='UTF-8 strict, Unicode code points, no trim/case/NFC; LF/CRLF source row delimiters removed',
        sourceCommit=COMMIT,
        sources={key: dict(path=spec[0], url=BASE + spec[0], bytes=spec[1], sha256=spec[2]) for key, spec in SOURCES.items()},
        commonSelection=dict(strategy='First 3000 unique policy-compatible values in source frequency order',
                             finalSourceRow=common_end_rank, metrics=common_metrics),
        breachedSelection=dict(strategy='All distinct policy-compatible UTF-8 rows from the pinned RockYou archive',
                               archiveMember='rockyou.txt', archiveMemberBytes=139921497, metrics=breach_metrics),
        limitations=[
            'Historical xato frequency list and historical RockYou breach; not a current or complete worldwide breach database.',
            'Hashes cover exact UTF-8 strings only; malformed UTF-8 source rows are excluded and counted.',
            'Source repository labels MIT and describes its password-only/no-account-link data rule; no independent reconstruction of the original leak.',
            'The common ranking is inherited from the source, not newly measured in the GP population.',
        ], artifacts=artifacts)
    destination.mkdir(parents=True, exist_ok=True)
    atomic_write(destination / artifacts['common']['file'], common_data)
    atomic_write(destination / artifacts['breached']['file'], breach_data)
    # Manifest last; application loads and verifies the complete pair on next restart.
    atomic_write(destination / 'manifest.json', (json.dumps(manifest, indent=2, ensure_ascii=False) + '\n').encode('utf-8'))
    atomic_write(destination / 'LICENSE-SecLists.txt', inputs['license'].read_bytes())
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-cache', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parents[1] / 'lib' / 'password-policy')
    parser.add_argument('--download', action='store_true', help='Fetch only pinned public source files (~102 MB total)')
    args = parser.parse_args()
    result = build(args.source_cache, args.output_dir, args.download)
    print(json.dumps({'corpusVersion': result['corpusVersion'], 'artifacts': result['artifacts'],
                      'commonSelection': result['commonSelection'], 'breachedSelection': result['breachedSelection']}))

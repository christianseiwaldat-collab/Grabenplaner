"""Install the hash-bound scanner with a dependency-only wheel metadata repair.

Semgrep 1.181.0 (and 1.184.0) pins vulnerable MCP/OpenTelemetry releases.
Only six Requires-Dist fields and their wheel RECORD entry change. Python
sources, native binaries, entrypoints, version and scanner rules stay byte exact.
The patched wheel participates in pip's normal, hash-required resolution.
"""
import argparse
import base64
import csv
import hashlib
import io
from pathlib import Path, PurePosixPath
import platform
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

VERSION = '1.181.0'
DIST = 'semgrep-' + VERSION + '.dist-info/'
REPLACEMENTS = {
    'mcp==1.29.0': 'mcp==1.30.0',
    'opentelemetry-api~=1.37.0': 'opentelemetry-api==1.45.1',
    'opentelemetry-sdk~=1.37.0': 'opentelemetry-sdk==1.45.1',
    'opentelemetry-exporter-otlp-proto-http~=1.37.0':
        'opentelemetry-exporter-otlp-proto-http==1.45.1',
    'opentelemetry-instrumentation-requests~=0.58b0':
        'opentelemetry-instrumentation-requests==0.66b1',
    'opentelemetry-instrumentation-threading~=0.58b0':
        'opentelemetry-instrumentation-threading==0.66b1',
}
WHEEL_PREFIX = 'semgrep-1.181.0-cp310.cp311.cp312.cp313.cp314.py310.py311.py312.py313.py314-none-'
ASSETS = {
    'linux': {
        'filename': WHEEL_PREFIX + 'manylinux_2_34_x86_64.whl',
        'url': 'https://files.pythonhosted.org/packages/b0/1d/aed54e9cea5491f0dd54286126216f97ef817a356734d3c9d5e40c124c34/'
            + WHEEL_PREFIX + 'manylinux_2_34_x86_64.whl',
        'bytes': 70540779,
        'sha256': 'c142ec04a2ed144970cb0a92f6877651dd3c088505eec737bb7f4db7ae5f0ffa',
        'patchedSha256': '91e27645d3f7255b69441577f7196b49289e9bd313ce62996853ea9f3a17bde5',
    },
    'win32': {
        'filename': WHEEL_PREFIX + 'win_amd64.whl',
        'url': 'https://files.pythonhosted.org/packages/53/d0/c35c85e860b722b86108ecef78c104558d65fddb6d00e6e83be54b4b263b/'
            + WHEEL_PREFIX + 'win_amd64.whl',
        'bytes': 58091264,
        'sha256': 'c3d7295bfd26f994231d82145888bd0a73ef0ad66ffb0c0341f0350a90ac3136',
        'patchedSha256': 'b6ae83eb1fe2f143ee8309e2675001d83b61791356365ab3065c2945f41b760e',
    },
}


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def repair_metadata(data):
    newline = '\r\n' if data.splitlines(keepends=True)[0].endswith(b'\r\n') else '\n'
    for before, after in REPLACEMENTS.items():
        old = ('Requires-Dist: ' + before + newline).encode()
        if data.count(old) != 1:
            raise ValueError('Upstream dependency metadata drift: ' + before)
        data = data.replace(old, ('Requires-Dist: ' + after + newline).encode(), 1)
    return data


def dependencies(metadata):
    return [line.removeprefix('Requires-Dist: ') for line in metadata.decode().splitlines()
            if line.startswith('Requires-Dist: ')]


def repair_wheel(source, destination, asset):
    if source.stat().st_size != asset['bytes'] or digest(source) != asset['sha256']:
        raise ValueError('Original PyPI wheel integrity mismatch')
    with zipfile.ZipFile(source) as original:
        names = original.namelist()
        if len(names) != len(set(names)) or sum(i.file_size for i in original.infolist()) > 512 * 1024**2:
            raise ValueError('Invalid upstream wheel inventory')
        for item in original.infolist():
            path = PurePosixPath(item.filename)
            if (path.is_absolute() or '..' in path.parts or '\\' in item.orig_filename
                    or item.orig_filename != item.filename or ':' in item.filename
                    or stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1):
                raise ValueError('Unsafe upstream wheel member')
        metadata = repair_metadata(original.read(DIST + 'METADATA'))
        if b'Name: semgrep' not in metadata.splitlines() or b'Version: 1.181.0' not in metadata.splitlines():
            raise ValueError('Unexpected scanner distribution')
        records = []
        # Stored entries and fixed headers make output hashes independent of zlib.
        with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_STORED) as patched:
            for item in original.infolist():
                if item.filename == DIST + 'RECORD':
                    continue
                data = metadata if item.filename == DIST + 'METADATA' else original.read(item)
                header = zipfile.ZipInfo(item.filename, (1980, 1, 1, 0, 0, 0))
                header.create_system = 3
                header.external_attr = item.external_attr
                patched.writestr(header, data)
                hashed = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
                records.append([item.filename, 'sha256=' + hashed, str(len(data))])
            record = io.StringIO(newline='')
            csv.writer(record, lineterminator='\n').writerows(records + [[DIST + 'RECORD', '', '']])
            header = zipfile.ZipInfo(DIST + 'RECORD', (1980, 1, 1, 0, 0, 0))
            header.create_system = 3
            header.external_attr = 0o100644 << 16
            patched.writestr(header, record.getvalue().encode())
    return metadata


def install(root):
    if sys.prefix == sys.base_prefix:
        raise ValueError('A dedicated scanner virtual environment is required')
    if sys.platform not in ASSETS or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise ValueError('Scanner wheel is not qualified for this platform')
    asset = ASSETS[sys.platform]
    with tempfile.TemporaryDirectory(prefix='gp-semgrep-deps-') as temporary:
        temporary = Path(temporary)
        source = temporary / 'upstream.whl'
        with urllib.request.urlopen(asset['url'], timeout=120) as response, source.open('xb') as output:
            remaining = asset['bytes'] + 1
            while remaining:
                chunk = response.read(min(1024**2, remaining))
                if not chunk:
                    break
                output.write(chunk)
                remaining -= len(chunk)
        wheel = temporary / asset['filename']
        metadata = repair_wheel(source, wheel, asset)
        if digest(wheel) != asset['patchedSha256']:
            raise ValueError('Repaired wheel differs from the reviewed metadata-only result')
        inputs = [line.strip() for line in (root / 'scripts/security/requirements.in').read_text().splitlines()
                  if line.strip() and not line.lstrip().startswith('#')]
        if inputs != dependencies(metadata):
            raise ValueError('Dependency input differs from the repaired upstream metadata')
        locked = temporary / 'scanner-wheel.txt'
        locked.write_text('semgrep @ ' + wheel.as_uri() + ' --hash=sha256:'
                          + asset['patchedSha256'] + '\n', encoding='utf8')
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check',
            '--only-binary=:all:', '--require-hashes', '--index-url', 'https://pypi.org/simple',
            '-r', str(root / 'scripts/security/requirements.txt'), '-r', str(locked)], check=True)
        subprocess.run([sys.executable, '-m', 'pip', 'check'], check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    install(parser.parse_args().root.resolve())

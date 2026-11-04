"""Cheap synthetic Linux/Docker contract for the current license CAPTURE_SCRIPT.

No compiler is built and no scanner is qualified. Only an explicitly local
Docker daemon is used; the tested capture runs read-only without a network.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import tarfile
import threading
import time
import uuid

ALPINE = 'alpine@sha256:3d67941fed5ae436b2bb9791cb3f50a252441c7706bbc5b4e738936df8ff8306'
OPAM_APK = 'opam-2.5.2-r0'
PYTHON_APK = 'python3-3.12.16-r0'
PROBE = 'gp-capture-probe'
PROBE_ID = PROBE + '.1'
PIN_PROBE = 'gp-capture-pin'
PIN_ID = PIN_PROBE + '.1'
UNKNOWN = '/usr/include/gp_capture_contract_unowned.h'
MAX_OUTPUT = 4 * 1024**2
MAX_ERROR = 64 * 1024
SOCKET = Path('/run/docker.sock')
CONFIG_METADATA_SHA = 'eac491c01bd4de3e78443d55bd9948e107c9ad4c80b5d0f4c63de778b601aae3'
CONFIG_PACKAGE = 'ocaml-config.3'
VARIANT_PACKAGE = 'ocaml-variants.5.4.0'
# Actual P2 identities/backend classes from run 40815657275. Sources below are
# explicitly synthetic tiny local repositories, not these upstream packages.
PIN_CLASSES = (
    ('memtrace', 'dev', 'git'), ('obackward', 'dev', 'git'), ('ocaml-variants', '5.4.0', 'git'),
    ('opentelemetry', '0.91.1', 'git'), ('opentelemetry-client', '0.91.1', 'git'),
    ('opentelemetry-client-cohttp-eio', '0.91.1', 'git'), ('opentelemetry-client-ocurl', '0.91.1', 'git'),
    ('opentelemetry-logs', '0.91.1', 'git'), ('pcre2', 'dev', 'git'), ('pyro-caml', 'dev', 'git'),
    ('pyro-caml-instruments', 'dev', 'git'), ('pyro-caml-ppx', 'dev', 'git'),
    ('semgrep-interfaces', 'dev', 'git'), ('tree-sitter', 'dev', 'rsync'))
PIN_ROOT = '/root/.opam-git-probe'
RSYNC_ROOT = '/root/.opam-rsync-probe'
PIN_LOGS = '/tmp/opam-capture-logs'
PIN_TMPFS = '/tmp:rw,nosuid,nodev,noexec,size=32m'

PIN_SETUP_SCRIPT = r'''
import json, os, pathlib, subprocess
base = pathlib.Path('/pin-fixtures')
pins = json.loads((base/'pins.json').read_bytes())
def command(arguments, environment=None):
    result = subprocess.run(arguments, env=environment, capture_output=True, timeout=60, check=False)
    if result.returncode:
        raise RuntimeError('Synthetic pin setup failed: '+repr(arguments)+'\n'+result.stderr.decode(errors='replace')[-16384:])
    return result.stdout
for name, version, backend in pins:
    source = base/'sources'/name
    if backend == 'git':
        command(['git', 'init', '--quiet', str(source)])
        command(['git', '-C', str(source), 'add', 'opam', 'README.synthetic'])
        command(['git', '-C', str(source), '-c', 'user.name=Synthetic Capture Contract',
            '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'Synthetic metadata only'])
for root, selected in [('/root/.opam-git-probe', pins),
        ('/root/.opam-rsync-probe', [item for item in pins if item[2] == 'rsync'])]:
    environment = dict(os.environ, OPAMROOT=root, OPAMYES='1')
    environment.pop('OPAMSWITCH', None)
    command(['opam', 'init', '--bare', '--disable-sandboxing', '--no-setup', '--yes',
        'capture', 'file:///capture-repository'], environment)
    command(['opam', 'switch', 'create', '5.4.0', '--empty', '--yes'], environment)
    environment['OPAMSWITCH'] = '5.4.0'
    for name, version, backend in selected:
        source = str(base/'sources'/name)
        arguments = ['opam', 'pin', 'add', name]
        if backend == 'git': arguments += ['git+file://'+source, '--kind=git']
        else: arguments += [source]
        command(arguments+['--no-action', '--yes'], environment)
    observed = command(['opam', 'pin', 'list', '--normalise'], environment)
    (base/('setup-git-pins.stdout' if len(selected)>1 else 'setup-rsync-pins.stdout')).write_bytes(observed)
print(json.dumps({'syntheticOnly': True, 'compilerBuilt': False, 'pinCount': len(pins)}))
'''

PIN_READ_SCRIPT = r'''
import base64, hashlib, json, os, pathlib, subprocess
def digest(data): return hashlib.sha256(data).hexdigest()
root = pathlib.Path(os.environ['OPAMROOT'])
def snapshot():
    paths = [root/'config', root/'5.4.0/.opam-switch/switch-state']
    paths += sorted((root/'5.4.0/.opam-switch/overlay').glob('*/opam'))
    return [{'path':str(path.relative_to(root)), 'sha256':digest(path.read_bytes())} for path in paths]
before = snapshot()
arguments = ['opam', 'pin', 'list', '--normalise', '--safe']
result = subprocess.run(arguments, capture_output=True, timeout=60, check=False)
record = {'format':'gp-synthetic-opam-pin-readonly/v1', 'syntheticOnly':True,
    'compilerQualification':False, 'command':arguments, 'exitCode':result.returncode,
    'opamRoot':str(root), 'opamLogs':os.environ.get('OPAMLOGS'),
    'stateBefore':before, 'stateAfter':snapshot()}
for key, data in [('stdout',result.stdout),('stderr',result.stderr)]:
    record[key] = {'bytes':len(data), 'sha256':digest(data),
        'base64':base64.b64encode(data[-65536:]).decode(), 'truncated':len(data)>65536}
print(json.dumps(record, sort_keys=True))
'''

# This isolated switch deliberately contains fake installation records. It is
# never passed to the compiler capture or license collector. Network isolation
# independently prevents the original declaration's extra-source URLs from
# being fetched, even if OPAM were unexpectedly to try performing an action.
CONFIG_METADATA_SCRIPT = r'''
import base64, hashlib, json, os, pathlib, subprocess
def sha(data): return hashlib.sha256(data).hexdigest()
def data_record(data):
    return {'bytes': len(data), 'sha256': sha(data), 'base64': base64.b64encode(data).decode()}
record = {'format': 'gp-fake-opam-config3-metadata/v1', 'complete': False,
    'fakeInstall': True, 'syntheticCompilerMetadata': True, 'compilerBuilt': False,
    'compilerQualification': False, 'runtimeQualification': False,
    'sourceQualification': False, 'declarationSemanticsApproved': False, 'commands': []}
environment = dict(os.environ, HOME='/metadata-root', OPAMROOT='/metadata-root', OPAMYES='1')
environment.pop('OPAMSWITCH', None)
def command(arguments):
    result = subprocess.run(arguments, env=environment, capture_output=True, timeout=60, check=False)
    if len(result.stdout) > 65536 or len(result.stderr) > 65536:
        raise ValueError('Metadata command exceeded its diagnostic bound')
    record['commands'].append({'argv': arguments, 'exitCode': result.returncode,
        'stdout': data_record(result.stdout), 'stderr': data_record(result.stderr)})
    if result.returncode: raise ValueError('Fake metadata command failed')
    return result.stdout
try:
    record['opamVersion'] = command(['opam', '--version']).decode().strip()
    if record['opamVersion'] != '2.5.2': raise ValueError('Expected actual OPAM 2.5.2')
    record['original'] = data_record(pathlib.Path('/metadata-repository/packages/ocaml-config/ocaml-config.3/opam').read_bytes())
    record['syntheticVariant'] = data_record(pathlib.Path('/metadata-repository/packages/ocaml-variants/ocaml-variants.5.4.0/opam').read_bytes())
    command(['opam', 'init', '--bare', '--disable-sandboxing', '--no-setup', '--yes',
        'metadata', 'file:///metadata-repository'])
    command(['opam', 'switch', 'create', 'config3-metadata', '--empty', '--yes'])
    environment['OPAMSWITCH'] = 'config3-metadata'
    command(['opam', 'install', '--fake', '--yes', 'ocaml-config.3'])
    record['installedPackageIds'] = sorted(command(['opam', 'list', '--installed', '--short', '--columns=package', '--color=never']).decode().splitlines())
    installed = pathlib.Path('/metadata-root/config3-metadata/.opam-switch/packages/ocaml-config.3/opam')
    record['installedPath'] = str(installed)
    record['installed'] = data_record(installed.read_bytes())
    record['complete'] = True
except Exception as error:
    record['error'] = str(error)[:1000]
print(json.dumps(record, sort_keys=True))
raise SystemExit(0 if record['complete'] else 2)
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def write(file, data):
    with Path(file).open('xb') as stream:
        stream.write(data)


def local_docker():
    if sys.platform != 'linux' or platform.machine().lower() not in ('x86_64', 'amd64'):
        raise ValueError('The synthetic Docker capture contract requires native Linux')
    info = SOCKET.lstat()
    if SOCKET.resolve() != SOCKET or not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
        raise ValueError('A canonical root-owned local Docker socket is required')
    # Explicit --host overrides remote contexts and environment configuration.
    return ['docker', '--host', 'unix://' + str(SOCKET)]


def run(arguments, label, output, timeout=120, limit=MAX_OUTPUT, error_limit=MAX_ERROR):
    """Drain both streams with finite retention; never treat truncation as pass."""
    started = time.monotonic()
    process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={key: value for key, value in os.environ.items() if key in ('PATH', 'HOME', 'SYSTEMROOT')})
    retained = {}
    def drain(name, stream, bound):
        blocks, size, truncated = [], 0, False
        try:
            while True:
                block = stream.read(65536)
                if not block:
                    break
                keep = block[:max(0, bound - size)]
                if keep: blocks.append(keep)
                size += len(keep)
                truncated |= len(keep) != len(block)
        finally:
            stream.close()
        retained[name] = (b''.join(blocks), truncated)
    readers = [threading.Thread(target=drain, args=('stdout', process.stdout, limit)),
               threading.Thread(target=drain, args=('stderr', process.stderr, error_limit))]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True; process.kill(); process.wait(timeout=15)
    for reader in readers:
        reader.join(timeout=15)
        if reader.is_alive():
            raise ValueError('Synthetic capture stream did not close')
    stdout, out_truncated = retained['stdout']; stderr, err_truncated = retained['stderr']
    write(output / (label + '.stdout'), stdout); write(output / (label + '.stderr'), stderr)
    record = {'label': label, 'exitCode': process.returncode, 'timedOut': timed_out,
        'stdoutBytes': len(stdout), 'stdoutSha256': digest(stdout), 'stdoutTruncated': out_truncated,
        'stderrBytes': len(stderr), 'stderrSha256': digest(stderr), 'stderrTruncated': err_truncated,
        'elapsedSeconds': time.monotonic() - started}
    write(output / (label + '.json'), encoded(record))
    if timed_out or out_truncated or err_truncated:
        raise ValueError('Synthetic capture command timed out or exceeded its evidence bound: ' + label)
    return record, stdout, stderr


def fixture(output):
    context = output / 'fixture'; context.mkdir(mode=0o700)
    repository = context / 'repository'
    package = repository / 'packages' / PROBE / PROBE_ID
    package.mkdir(parents=True)
    write(repository / 'repo', b'opam-version: "2.0"\n')
    def definition(name):
        return ('opam-version: "2.0"\nname: "' + name + '"\nversion: "1"\n'
        'synopsis: "Synthetic capture contract; no compiler"\n'
        'maintainer: "synthetic@example.invalid"\nauthors: "Synthetic Capture Contract"\nlicense: "MIT"\n'
        'install: [["sh" "-c" "mkdir -p %{share}%/' + name
        + ' && printf capture-contract > %{share}%/' + name + '/probe.txt"]]\n')
    write(package / 'opam', definition(PROBE).encode())
    pinned = context / 'pinned-source'; pinned.mkdir()
    write(pinned / 'opam', definition(PIN_PROBE).encode())
    write(pinned / 'README.synthetic', b'Synthetic local pinned capture source; no compiler.\n')
    write(pinned / 'LICENSE', b'Copyright Synthetic Capture Contract Authors\nMIT test fixture only.\n')
    with tarfile.open(context / 'synthetic-curl.tar.gz', mode='w:gz') as archive:
        data = b'Synthetic capture pathname fixture; this is not curl source.\n'
        info = tarfile.TarInfo('README.synthetic'); info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
    dockerfile = ('FROM ' + ALPINE + '\n'
        'RUN apk add --no-cache opam=2.5.2-r0 python3=3.12.16-r0 musl-dev bash build-base git make rsync\n'
        'COPY repository /capture-repository\n'
        'COPY pinned-source /capture-pin-source\n'
        'COPY synthetic-curl.tar.gz /tmp/curl-8.5.0.tar.gz\n'
        'ENV OPAMROOT=/root/.opam OPAMYES=1\n'
        'RUN test "$(opam --version)" = 2.5.2 && test "$(python3 --version)" = "Python 3.12.16" \\\n'
        ' && python3 -c \'import pathlib; blocks=pathlib.Path("/lib/apk/db/installed").read_text().strip().split("\\n\\n"); '
        'packages=[dict(line.split(":",1) for line in block.splitlines() if ":" in line) for block in blocks]; '
        'installed={item["P"]:item["V"] for item in packages if "P" in item}; '
        'assert installed["opam"] == "2.5.2-r0"; assert installed["python3"] == "3.12.16-r0"\'\n'
        'RUN opam init --bare --disable-sandboxing --no-setup --yes capture file:///capture-repository \\\n'
        ' && opam switch create 5.4.0 --empty --yes\n'
        'ENV OPAMSWITCH=5.4.0\n'
        'RUN opam install ' + PROBE_ID + ' --yes \\\n'
        ' && opam pin add ' + PIN_PROBE + ' /capture-pin-source --no-action --yes \\\n'
        ' && opam install ' + PIN_PROBE + ' --yes \\\n'
        ' && test "$(opam var prefix --safe)" = /root/.opam/5.4.0 \\\n'
        ' && mkdir -p /root/.opam/download-cache /root/.opam/5.4.0/.opam-switch/sources/' + PROBE_ID + ' \\\n'
        ' && printf synthetic-capture-cache > /root/.opam/download-cache/contract.synthetic \\\n'
        ' && printf synthetic-release-source > /root/.opam/5.4.0/.opam-switch/sources/' + PROBE_ID + '/README.synthetic\n')
    write(context / 'Dockerfile', dockerfile.encode())
    negative = output / 'negative-fixture'; negative.mkdir(mode=0o700)
    write(negative / 'unowned.h', b'/* Synthetic unowned capture probe; never product code. */\n')
    return context, negative


def validate_capture(raw):
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {'opamPackages', 'opamListing', 'apkPackages',
            'nativeInputs', 'alpineRelease'} or not str(value['alpineRelease']).startswith('3.23.')):
        raise ValueError('Unexpected actual capture structure or Alpine release')
    packages = value['opamPackages']
    if len(packages) != 2 or {item['id'] for item in packages} != {PROBE_ID, PIN_ID}:
        raise ValueError('The synthetic switch must contain only its two compiler-free probes')
    for package in packages:
        metadata = base64.b64decode(package['opam'], validate=True)
        if package['name'].encode() not in metadata or b'license: "MIT"' not in metadata:
            raise ValueError('Actual installed OPAM metadata is missing')
        base64.b64decode(package['install'], validate=True)
        if not base64.b64decode(package['changes'], validate=True):
            raise ValueError('Actual installed OPAM changes metadata is missing')
        if package['id'] == PIN_ID and (not package['sourcePin'] or '/capture-pin-source' not in package['sourcePin']
                                      or package['sourceDirectory'] != PIN_PROBE):
            raise ValueError('The actual local pin must retain its unversioned OPAM source directory')
        if package['id'] == PROBE_ID and package['sourceDirectory'] != PROBE_ID:
            raise ValueError('The synthetic release source must retain its installed identity')
    apks = {item['id']: item for item in value['apkPackages']}
    if 'opam.2.5.2-r0' not in apks or 'python3.3.12.16-r0' not in apks:
        raise ValueError('Actual installed interpreter/OPAM versions differ')
    native = value['nativeInputs']
    if not native or not any(item['path'] == '/usr/include/stdio.h' and item['bytes'] > 0 for item in native):
        raise ValueError('The positive fixture must observe real APK-owned native headers')
    for item in native:
        if (set(item) != {'path', 'bytes', 'sha256', 'owner'} or item['owner'] not in apks
                or type(item['bytes']) is not int or item['bytes'] < 0
                or not re.fullmatch('[a-f0-9]{64}', str(item['sha256']))
                or item['bytes'] == 0 and item['sha256'] != digest(b'')):
            raise ValueError('Actual native owner or byte identity is unbound')
    return value


def validate_negative(record, stdout, stderr):
    if record['exitCode'] == 0 or ('Unowned native input: ' + UNKNOWN).encode() not in stderr:
        raise ValueError('Unknown native owner did not fail for the required capture reason')


def metadata_byte_proof(captured, context):
    """Observe OPAM normalization; never silently replace expected byte hashes."""
    files = {PROBE_ID: context / 'repository/packages' / PROBE / PROBE_ID / 'opam',
             PIN_ID: context / 'pinned-source/opam'}
    records = []
    for package in captured['opamPackages']:
        original = files[package['id']].read_bytes()
        installed = base64.b64decode(package['opam'], validate=True)
        records.append({'packageId': package['id'], 'originalBytes': len(original),
            'originalSha256': digest(original), 'originalBase64': base64.b64encode(original).decode(),
            'installedBytes': len(installed), 'installedSha256': digest(installed),
            'installedBase64': base64.b64encode(installed).decode(),
            'normalizedDuringInstall': installed != original})
    return {'format': 'gp-synthetic-opam-metadata-bytes/v1', 'syntheticOnly': True,
        'hashNormalizationApplied': False, 'records': records}


def metadata_fixture(output, positive_image):
    """Keep official config metadata out of the real two-package capture switch."""
    if not re.fullmatch('sha256:[a-f0-9]{64}', positive_image):
        raise ValueError('Metadata fixture requires the positive immutable image ID')
    original = (Path(__file__).resolve().parent / 'fixtures/ocaml-config.3/opam').read_bytes()
    if digest(original) != CONFIG_METADATA_SHA:
        raise ValueError('Official config.3 fixture differs from its exact reviewed bytes')
    context = output / 'metadata-fixture'; context.mkdir(mode=0o700)
    repository = context / 'repository'
    package = repository / 'packages/ocaml-config' / CONFIG_PACKAGE
    package.mkdir(parents=True)
    write(repository / 'repo', b'opam-version: "2.0"\n')
    write(package / 'opam', original)
    variant = repository / 'packages/ocaml-variants' / VARIANT_PACKAGE
    variant.mkdir(parents=True)
    synthetic = (b'opam-version: "2.0"\n'
        b'synopsis: "Synthetic fake-install metadata only; no compiler programs"\n'
        b'maintainer: "synthetic@example.invalid"\n'
        b'authors: "Synthetic Capture Contract"\nlicense: "MIT"\n')
    write(variant / 'opam', synthetic)
    return context, original, synthetic


def metadata_run_arguments(docker, positive_image, context):
    """Run by local image ID; never feed a bare SHA to Dockerfile FROM.

    BuildKit treats FROM sha256:<local-id> as a registry image named sha256.
    A separate container plus a read-only local fixture mount avoids both that
    resolution and any mutation of the already checked image/switch.
    """
    repository = (context / 'repository').absolute()
    if (not re.fullmatch('sha256:[a-f0-9]{64}', positive_image)
            or not repository.is_dir() or repository.resolve() != repository
            or ',' in str(repository)):
        raise ValueError('Fake metadata container requires an immutable image and canonical mount')
    return docker + ['run', '--rm', '--network', 'none', '--read-only',
        '--mount', 'type=bind,src=' + str(repository) + ',dst=/metadata-repository,readonly',
        '--tmpfs', '/metadata-root:rw,nosuid,nodev,noexec,size=128m',
        '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=128m',
        '--entrypoint', 'python3', positive_image, '-I', '-c', CONFIG_METADATA_SCRIPT]


def git_pin_fixture(output, positive_tag):
    if not re.fullmatch('gp-capture-contract-positive:[a-f0-9]{32}', positive_tag):
        raise ValueError('Git pin fixture requires the locally owned positive image tag')
    context = output / 'git-pin-fixture'; context.mkdir(mode=0o700)
    write(context / 'pins.json', encoded(PIN_CLASSES))
    write(context / 'setup.py', PIN_SETUP_SCRIPT.encode())
    for name, version, _backend in PIN_CLASSES:
        source = context / 'sources' / name; source.mkdir(parents=True)
        metadata = ('opam-version: "2.0"\nname: "' + name + '"\nversion: "' + version + '"\n'
            'synopsis: "Synthetic backend probe; not upstream package source"\n'
            'maintainer: "synthetic@example.invalid"\nauthors: "Synthetic Capture Contract"\nlicense: "MIT"\n')
        write(source / 'opam', metadata.encode())
        write(source / 'README.synthetic', b'Synthetic local pin metadata; no compiler or upstream source qualification.\n')
    write(context / 'Dockerfile', ('FROM ' + positive_tag + '\n'
        'COPY . /pin-fixtures\nRUN python3 -I /pin-fixtures/setup.py\n').encode())
    return context


def pin_read_arguments(docker, image, root, scratch=False):
    if (not re.fullmatch('sha256:[a-f0-9]{64}', image) or root not in (PIN_ROOT, RSYNC_ROOT)):
        raise ValueError('Pin read probe requires an exact image and isolated synthetic root')
    arguments = docker + ['run', '--rm', '--network', 'none', '--read-only',
        '--env', 'OPAMROOT=' + root, '--env', 'OPAMSWITCH=5.4.0']
    if scratch:
        arguments += ['--tmpfs', PIN_TMPFS, '--env', 'OPAMLOGS=' + PIN_LOGS]
    return arguments + ['--entrypoint', 'python3', image, '-I', '-c', PIN_READ_SCRIPT]


def validate_pin_read(raw, root, scratch=False, expect_readonly_failure=False):
    value = json.loads(raw)
    if (value.get('format') != 'gp-synthetic-opam-pin-readonly/v1' or value.get('syntheticOnly') is not True
            or value.get('compilerQualification') is not False or value.get('opamRoot') != root
            or value.get('command') != ['opam', 'pin', 'list', '--normalise', '--safe']
            or value.get('opamLogs') != (PIN_LOGS if scratch else None)
            or not value.get('stateBefore') or value['stateBefore'] != value.get('stateAfter')):
        raise ValueError('Synthetic pin read evidence has an invalid scope or changed state')
    streams = {}
    for key in ('stdout', 'stderr'):
        record = value.get(key, {})
        if set(record) != {'bytes', 'sha256', 'base64', 'truncated'} or record['truncated'] is not False:
            raise ValueError('Synthetic pin command diagnostics are incomplete')
        data = base64.b64decode(record['base64'], validate=True)
        if type(record['bytes']) is not int or record['bytes'] != len(data) or digest(data) != record['sha256']:
            raise ValueError('Synthetic pin command byte identity differs')
        streams[key] = data
    if expect_readonly_failure:
        if (scratch or root != PIN_ROOT or value.get('exitCode') != 99
                or b'read-only' not in streams['stderr'].lower()):
            raise ValueError('Git-pin readonly failure must retain the actual OPAM99/filesystem cause')
    else:
        expected = PIN_CLASSES if root == PIN_ROOT else [item for item in PIN_CLASSES if item[2] == 'rsync']
        rows = [line.split() for line in streams['stdout'].decode().splitlines() if line.strip()]
        observed = {row[0]: next((token for token in row[1:] if token in ('git', 'rsync')), None) for row in rows}
        if (value.get('exitCode') != 0 or len(rows) != len(expected)
                or observed != {name + '.' + version: backend for name, version, backend in expected}
                or b'error while fetching' in streams['stdout']
                or streams['stdout'].count(b'(at ') != sum(backend == 'git' for _name, _version, backend in expected)):
            raise ValueError('Synthetic pin list must observe every exact identity/backend and genuine local Git revision')
    return value


def host_streaming_contract(output, image):
    """Exercise the old 2-GiB failure boundary on native sparse host files."""
    if sys.platform != 'linux' or not re.fullmatch('sha256:[a-f0-9]{64}', image):
        raise ValueError('The large sparse streaming contract requires native Linux and an exact synthetic image')
    import compiler_capture_archive as capture
    if (capture.MAX_FILE != 512 * 1024**2 or capture.MAX_ARCHIVE != 2 * 1024**3
            or capture.MAX_EXPANDED != 8 * 1024**3):
        raise ValueError('The reviewed separate diagnostic bounds differ')
    private = output / 'host-streaming-private'; private.mkdir(mode=0o700)
    source = private / 'capture'; source.mkdir(mode=0o700)
    probes = source / 'opam-sources/probe'; probes.mkdir(parents=True)
    destination = output / 'host-streaming-capture'; destination.mkdir(mode=0o700)
    binary_sha = digest(b'SYNTHETIC SPARSE STREAM CONTRACT; NOT A COMPILER')
    descriptor = encoded({'format': 'gp-semgrep-core-source-capture-observation/v1',
        'imageId': image, 'binarySha256': binary_sha, 'captureComplete': False})
    write(source / 'capture.json', descriptor)
    sparse = []
    for index in range(4):
        file = probes / ('part-' + str(index) + '.synthetic-source')
        with file.open('xb') as stream: stream.truncate(capture.MAX_FILE)
        sparse.append(file)
    allocated = sum(file.stat().st_blocks * 512 for file in sparse)
    if allocated >= 4 * capture.MAX_FILE:
        raise ValueError('Native sparse fixture unexpectedly allocated the whole source payload')
    write(probes / 'one-byte.synthetic-source', b'1')
    # One bounded chunk computes the independent expected all-zero source hash;
    # no multi-gigabyte bytes object is created, including on the native runner.
    zeros = hashlib.sha256(); chunk = bytes(1024**2)
    for _ in range(capture.MAX_FILE // len(chunk)): zeros.update(chunk)
    expected = {'capture.json': {'bytes': len(descriptor), 'sha256': digest(descriptor)},
        'opam-sources/probe/one-byte.synthetic-source': {'bytes': 1, 'sha256': digest(b'1')}}
    for index in range(4):
        expected['opam-sources/probe/part-' + str(index) + '.synthetic-source'] = {
            'bytes': capture.MAX_FILE, 'sha256': zeros.hexdigest()}
    started = time.monotonic()
    receipt = capture.write_capture(source, destination, image, binary_sha)
    if capture.verify_capture(destination) != receipt:
        raise ValueError('Native streaming verification differs from the written receipt')
    inventory = {row['path']: {key: row[key] for key in ('bytes', 'sha256')} for row in receipt['memberInventory']}
    total = sum(row['bytes'] for row in inventory.values())
    if (inventory != expected or total != 2 * 1024**3 + 1 + len(descriptor)
            or set(receipt) != {'format', 'archive', 'imageId', 'binarySha256', 'upstreamOnly', 'compilerRebuilt', 'memberInventory'}
            or receipt['format'] != 'gp-semgrep-core-license-capture/v1' or receipt['imageId'] != image
            or receipt['binarySha256'] != binary_sha or receipt['upstreamOnly'] is not True
            or receipt['compilerRebuilt'] is not False or receipt['archive']['bytes'] > capture.MAX_ARCHIVE):
        raise ValueError('Sparse diagnostic stream has an invalid byte manifest or publication claim')
    proof = {'format': 'gp-native-sparse-capture-stream-contract/v1', 'passed': True,
        'syntheticOnly': True, 'compilerQualification': False, 'publicationReady': False,
        'captureComplete': False, 'perFileBytes': capture.MAX_FILE, 'sparseFileCount': 4,
        'sparseAllocatedBytes': allocated,
        'extraSourceBytes': 1, 'descriptorBytes': len(descriptor), 'actualSourceBytes': total,
        'exceedsFormer2GiB': total > 2 * 1024**3, 'manifestVerified': True,
        'archive': receipt['archive'], 'diagnosticExpandedLimit': capture.MAX_EXPANDED,
        'publicationLimitChanged': False, 'elapsedSeconds': time.monotonic() - started}
    write(output / 'host-streaming-contract.json', encoded(proof))
    # Remove only these four known private sparse fixtures after verification;
    # retain the small compressed diagnostic archive and its exact receipt.
    for file in sparse: file.unlink()
    return proof


def validate_config_metadata(raw, original, variant):
    """This is a metadata-writing proof, never a source/license qualification."""
    value = json.loads(raw)
    if (not isinstance(value, dict) or value.get('format') != 'gp-fake-opam-config3-metadata/v1'
            or value.get('complete') is not True or value.get('fakeInstall') is not True
            or value.get('syntheticCompilerMetadata') is not True or value.get('opamVersion') != '2.5.2'
            or any(value.get(key) is not False for key in ('compilerBuilt', 'compilerQualification',
                'runtimeQualification', 'sourceQualification', 'declarationSemanticsApproved'))
            or value.get('installedPackageIds') != [CONFIG_PACKAGE, VARIANT_PACKAGE]
            or value.get('installedPath') != '/metadata-root/config3-metadata/.opam-switch/packages/ocaml-config.3/opam'
            or digest(original) != CONFIG_METADATA_SHA):
        raise ValueError('Fake config metadata evidence has an invalid scope or package binding')
    for name, expected in (('original', original), ('syntheticVariant', variant), ('installed', None)):
        item = value.get(name, {})
        if set(item) != {'bytes', 'sha256', 'base64'}:
            raise ValueError('Fake config metadata byte record is malformed')
        data = base64.b64decode(item['base64'], validate=True)
        if (type(item['bytes']) is not int or not 0 < len(data) <= 65536
                or item['bytes'] != len(data) or item['sha256'] != digest(data)
                or expected is not None and data != expected):
            raise ValueError('Fake config metadata byte identity differs')
    commands = value.get('commands', [])
    expected_argv = [
        ['opam', '--version'],
        ['opam', 'init', '--bare', '--disable-sandboxing', '--no-setup', '--yes', 'metadata', 'file:///metadata-repository'],
        ['opam', 'switch', 'create', 'config3-metadata', '--empty', '--yes'],
        ['opam', 'install', '--fake', '--yes', CONFIG_PACKAGE],
        ['opam', 'list', '--installed', '--short', '--columns=package', '--color=never']]
    if ([item.get('argv') for item in commands] != expected_argv
            or any(type(item.get('exitCode')) is not int or item['exitCode'] != 0 for item in commands)):
        raise ValueError('Fake config metadata was not generated by the exact isolated commands')
    for item in commands:
        for stream in ('stdout', 'stderr'):
            record = item.get(stream, {})
            if set(record) != {'bytes', 'sha256', 'base64'}:
                raise ValueError('Fake metadata command evidence is malformed')
            data = base64.b64decode(record['base64'], validate=True)
            if (type(record['bytes']) is not int or record['bytes'] != len(data)
                    or len(data) > 65536 or digest(data) != record['sha256']):
                raise ValueError('Fake metadata command evidence is unbound')
    return value


def bind_capture_command(original, docker):
    def local_command(arguments, timeout=300):
        if (len(arguments) < 2 or arguments[0] != 'docker' or arguments[1] not in ('create', 'run', 'cp', 'rm')
                or any(item in ('--host', '-H', '--context') or item.startswith(('--host=', '--context='))
                       for item in arguments[1:])):
            raise ValueError('Capture orchestration may use only the explicit local Docker route')
        return original([*docker, *arguments[1:]], timeout=timeout)
    return local_command


def capture_image_contract(ledger, docker, image, output, name, negative=False):
    qualification = output / ('qualification-' + name); qualification.mkdir(mode=0o700)
    destination = output / ('raw-' + name); destination.mkdir(mode=0o700)
    synthetic = digest(b'SYNTHETIC CAPTURE CONTRACT; NOT A COMPILER BINARY')
    failed = None
    original = ledger.command
    try:
        ledger.command = bind_capture_command(original, docker)
        ledger.capture_image(image, synthetic, qualification, destination)
    except Exception as error:
        failed = error
    finally:
        ledger.command = original
    report = json.loads((qualification / 'sourcebuild-compiler-license-review.json').read_bytes())
    capture_receipt = ledger.verify_capture(destination)
    value = json.loads((destination / 'capture/capture.json').read_bytes())
    if (report['imageId'] != image or report['binarySha256'] != synthetic
            or report['publicationReady'] is not False or capture_receipt['compilerRebuilt'] is not False):
        raise ValueError('Actual capture_image evidence has an invalid synthetic binding')
    inventory = {item['path'] for item in capture_receipt['memberInventory']}
    required = {'capture.json', 'apk-installed-database', 'opam-switch-state', 'custom-curl.tar.gz',
        'opam-download-cache/contract.synthetic', 'opam-package-metadata/' + PROBE_ID + '/opam',
        'opam-package-metadata/' + PIN_ID + '/opam', 'opam-install-evidence/' + PROBE + '.changes',
        'opam-install-evidence/' + PIN_PROBE + '.changes', 'opam-sources/' + PIN_PROBE + '/README.synthetic'}
    if not required <= inventory:
        raise ValueError('Actual capture_image did not preserve the required raw fixture bytes')
    if negative:
        if not isinstance(failed, ledger.CaptureCommandError) or value.get('captureComplete') is not False:
            raise ValueError('The unknown owner must leave an explicitly partial actual capture')
        evidence = json.loads((qualification / 'sourcebuild-compiler-capture-command-failure.json').read_bytes())
        error_bytes = base64.b64decode(evidence['stderr']['tailBase64'], validate=True)
        if ('Unowned native input: ' + UNKNOWN).encode() not in error_bytes or report['phase'] != 'capture-observation-failed':
            raise ValueError('Actual failed capture did not retain its exact unknown-owner cause')
    elif failed is not None:
        raise ValueError('Actual positive capture_image failed; inspect its retained early report/command evidence') from failed
    elif value.get('captureComplete') is not True or report['phase'] != 'captured':
        raise ValueError('Actual positive capture_image did not finish completely')
    return {'name': name, 'captureComplete': value['captureComplete'],
        'captureSha256': capture_receipt['archive']['sha256'], 'rawMemberCount': len(inventory),
        'installedOpamSha256': {item['id']: digest(base64.b64decode(item['opam'], validate=True))
                               for item in value.get('opamPackages', [])},
        'expectedFailureRetained': negative, 'syntheticOnly': True, 'compilerQualification': False}


def check(output):
    output = Path(output).absolute()
    if (output.exists() or output.is_symlink() or output.parent.resolve() != output.parent):
        raise ValueError('A fresh canonical synthetic capture output directory is required')
    output.mkdir(mode=0o700)
    import compiler_license_ledger as ledger
    script = ledger.CAPTURE_SCRIPT
    source = Path(ledger.__file__).read_bytes()
    receipt = {'format': 'gp-synthetic-compiler-capture-check/v1', 'complete': False, 'passed': False,
        'syntheticOnly': True, 'compilerBuilt': False, 'compilerQualification': False,
        'securityGateApproved': False, 'baseImage': ALPINE, 'opamApk': OPAM_APK, 'pythonApk': PYTHON_APK,
        'dockerHost': 'unix:///run/docker.sock',
        'captureScriptSha256': digest(script.encode()), 'ledgerSourceSha256': digest(source), 'commands': []}
    images = []
    old_host, old_context = os.environ.get('DOCKER_HOST'), os.environ.pop('DOCKER_CONTEXT', None)
    try:
        docker = local_docker()
        os.environ['DOCKER_HOST'] = 'unix://' + str(SOCKET)
        context, negative = fixture(output)
        suffix = uuid.uuid4().hex
        positive_tag = 'gp-capture-contract-positive:' + suffix
        negative_tag = 'gp-capture-contract-negative:' + suffix
        git_pin_tag = 'gp-capture-contract-gitpin:' + suffix
        def command(arguments, label, timeout=120):
            result = run(arguments, label, output, timeout=timeout)
            receipt['commands'].append(result[0])
            return result
        result, _, _ = command(docker + ['build', '--platform', 'linux/amd64', '--tag', positive_tag,
            '--file', str(context / 'Dockerfile'), str(context)], 'build-positive', 480)
        if result['exitCode']:
            raise ValueError('Synthetic fixture build failed; retained stderr identifies the stage')
        images.append(positive_tag)
        result, image_raw, _ = command(docker + ['image', 'inspect', '--format', '{{.Id}}', positive_tag], 'inspect-positive')
        positive_image = image_raw.decode().strip()
        if result['exitCode'] or not re.fullmatch('sha256:[a-f0-9]{64}', positive_image):
            raise ValueError('Synthetic positive image has no immutable ID')
        result, raw, _ = command(docker + ['run', '--rm', '--network', 'none', '--read-only',
            '--entrypoint', 'python3', positive_tag, '-I', '-c', script], 'capture-positive')
        # Exercise the production orchestration even when direct observation
        # failed, so the early receipt and raw-source rescue remain inspectable.
        receipt['captureImage'] = [capture_image_contract(ledger, docker, positive_image, output, 'positive')]
        if result['exitCode']:
            raise ValueError('Current CAPTURE_SCRIPT failed in the actual read-only fixture; see capture-positive.stderr')
        # Preserve the original-versus-installed bytes even if a subsequent
        # semantic assertion discovers an unexpected OPAM normalization.
        proof = metadata_byte_proof(json.loads(raw), context)
        write(output / 'probe-metadata-binding.json', encoded(proof))
        captured = validate_capture(raw)
        if ({item['packageId']: item['installedSha256'] for item in proof['records']}
                != receipt['captureImage'][0]['installedOpamSha256']):
            raise ValueError('Read-only script and capture_image observed different installed OPAM bytes')
        receipt.update(opamPackageIds=[item['id'] for item in captured['opamPackages']],
            metadataByteBindings=[{key: item[key] for key in ('packageId', 'originalSha256', 'installedSha256',
                'originalBytes', 'installedBytes', 'normalizedDuringInstall')} for item in proof['records']],
            apkPackageIds=sorted(item['id'] for item in captured['apkPackages']),
            nativeInputCount=len(captured['nativeInputs']), nativeInputsSha256=digest(encoded(captured['nativeInputs'])))
        write(negative / 'Dockerfile', ('FROM ' + positive_tag + '\nCOPY unowned.h ' + UNKNOWN + '\n').encode())
        result, _, _ = command(docker + ['build', '--network', 'none', '--tag', negative_tag,
            '--file', str(negative / 'Dockerfile'), str(negative)], 'build-negative', 60)
        if result['exitCode']:
            raise ValueError('Synthetic negative fixture build failed')
        images.append(negative_tag)
        result, image_raw, _ = command(docker + ['image', 'inspect', '--format', '{{.Id}}', negative_tag], 'inspect-negative')
        negative_image = image_raw.decode().strip()
        if result['exitCode'] or not re.fullmatch('sha256:[a-f0-9]{64}', negative_image):
            raise ValueError('Synthetic negative image has no immutable ID')
        result, raw, error = command(docker + ['run', '--rm', '--network', 'none', '--read-only',
            '--entrypoint', 'python3', negative_tag, '-I', '-c', script], 'capture-negative')
        validate_negative(result, raw, error)
        receipt['captureImage'].append(capture_image_contract(ledger, docker, negative_image, output, 'negative', negative=True))
        # The two genuine installed probe packages have now passed both capture
        # paths. Run the deliberately FAKE config.3 write-contract in a separate
        # container with a read-only local repo and an empty tmpfs OPAMROOT,
        # never in the already checked switch. Docker run accepts a local
        # image ID directly and does not resolve a Dockerfile registry name.
        context, original_metadata, variant_metadata = metadata_fixture(output, positive_image)
        result, raw, _ = command(metadata_run_arguments(docker, positive_image, context), 'config3-fake-metadata', 300)
        write(output / 'config3-metadata-binding.json', raw)
        if result['exitCode']:
            raise ValueError('Actual OPAM fake metadata write-contract failed; retained bounded stdout/stderr identify the cause')
        metadata = validate_config_metadata(raw, original_metadata, variant_metadata)
        installed_metadata = base64.b64decode(metadata['installed']['base64'], validate=True)
        write(output / 'config3-original.opam', original_metadata)
        write(output / 'config3-installed.opam', installed_metadata)
        receipt['config3FakeMetadata'] = {'imageId': positive_image, 'isolatedContainer': True,
            'originalSha256': digest(original_metadata), 'installedSha256': digest(installed_metadata),
            'originalBytes': len(original_metadata), 'installedBytes': len(installed_metadata),
            'normalizedDuringFakeInstall': installed_metadata != original_metadata,
            'fakeInstall': True, 'syntheticCompilerMetadata': True, 'compilerQualification': False,
            'runtimeQualification': False, 'sourceQualification': False, 'declarationSemanticsApproved': False}
        context = git_pin_fixture(output, positive_tag)
        result, image_raw, _ = command(docker + ['image', 'inspect', '--format', '{{.Id}}', positive_tag], 'inspect-pin-parent')
        if result['exitCode'] or image_raw.decode().strip() != positive_image:
            raise ValueError('Owned pin fixture parent no longer matches the checked positive image')
        result, _, _ = command(docker + ['build', '--pull=false', '--network', 'none', '--tag', git_pin_tag,
            '--file', str(context / 'Dockerfile'), str(context)], 'build-git-pins', 180)
        if result['exitCode']:
            raise ValueError('Synthetic local Git backend fixture build failed; retained stderr identifies the cause')
        images.append(git_pin_tag)
        result, image_raw, _ = command(docker + ['image', 'inspect', '--format', '{{.Id}}', git_pin_tag], 'inspect-git-pins')
        pin_image = image_raw.decode().strip()
        if result['exitCode'] or not re.fullmatch('sha256:[a-f0-9]{64}', pin_image):
            raise ValueError('Synthetic Git pin image has no immutable ID')
        pin_proofs = []
        for label, root, scratch, expected_failure in (
                ('pin-rsync-readonly', RSYNC_ROOT, False, False),
                ('pin-git-readonly', PIN_ROOT, False, True),
                ('pin-git-scratch', PIN_ROOT, True, False)):
            result, raw, _ = command(pin_read_arguments(docker, pin_image, root, scratch), label)
            if result['exitCode']:
                raise ValueError('Pin probe container failed before reporting its exact OPAM result: ' + label)
            pin_proofs.append(validate_pin_read(raw, root, scratch, expected_failure))
        write(output / 'git-pin-readonly-binding.json', encoded(pin_proofs))
        receipt['gitPinReadonly'] = {'imageId': pin_image, 'sourceProducerRun': 40815657275,
            'syntheticOnly': True, 'compilerQualification': False,
            'actualPinIdentityCount': len(PIN_CLASSES), 'syntheticGitBackends': 13, 'syntheticRsyncBackends': 1,
            'rsyncReadonlyExit': pin_proofs[0]['exitCode'], 'gitReadonlyExit': pin_proofs[1]['exitCode'],
            'gitIsolatedLogScratchExit': pin_proofs[2]['exitCode'], 'stateUnchanged': True,
            'tmpfs': PIN_TMPFS, 'opamLogs': PIN_LOGS}
        receipt['hostStreamingCapture'] = host_streaming_contract(output, positive_image)
        if source != Path(ledger.__file__).read_bytes() or script != ledger.CAPTURE_SCRIPT:
            raise ValueError('Capture source changed during this contract check')
        receipt.update(complete=True, passed=True)
    except Exception as error:
        receipt['error'] = str(error)[:1000]
    finally:
        cleanup_failed = False
        for index, image in enumerate(reversed(images)):
            try:
                result, _, _ = run(docker + ['image', 'rm', image], 'cleanup-' + str(index), output)
                receipt['commands'].append(result)
                cleanup_failed |= result['exitCode'] != 0
            except Exception:
                cleanup_failed = True
        if cleanup_failed:
            receipt.update(complete=False, passed=False, error='Owned synthetic image cleanup failed')
        if old_host is None: os.environ.pop('DOCKER_HOST', None)
        else: os.environ['DOCKER_HOST'] = old_host
        if old_context is not None: os.environ['DOCKER_CONTEXT'] = old_context
        write(output / 'contract-result.json', encoded(receipt))
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    arguments = parser.parse_args()
    result = check(arguments.output)
    print(json.dumps(result, sort_keys=True))
    raise SystemExit(0 if result['passed'] else 2)

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
    if not native or not any(item['path'] == '/usr/include/stdio.h' for item in native):
        raise ValueError('The positive fixture must observe real APK-owned native headers')
    for item in native:
        if (set(item) != {'path', 'bytes', 'sha256', 'owner'} or item['owner'] not in apks
                or type(item['bytes']) is not int or item['bytes'] <= 0
                or not re.fullmatch('[a-f0-9]{64}', str(item['sha256']))):
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

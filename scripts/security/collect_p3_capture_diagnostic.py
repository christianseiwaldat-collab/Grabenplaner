"""Linux-only diagnostic collection from the exact original P3 source capture.

This helper never builds or executes a compiler, qualifies a scanner, publishes
a tool or changes a pin. Successful source/license validation is diagnostic
evidence only. The source artifact must first be independently identified.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import struct
import subprocess
import sys
import tarfile
import traceback
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = 'christianseiwaldat-collab/Grabenplaner'
REPOSITORY_ID = 1295280310
P3_RUN = 40821968979
P3_HEAD = '372abb23b3fcbc23b6d4402cfff9b92d02502d62'
P3_WORKFLOW = 394623725
P3_ATTEMPT = 1
ARTIFACT_NAME = 'source-build-license-capture-40821968979-1'
ARTIFACT_ID = 12876557761
ARTIFACT_SHA256 = '6db13d90cfbfe60a20b8da9a27562c67f3e55192fbfe2cd1f361b9f75c2a6683'
ARTIFACT_BYTES = 686759449
CAPTURE_ARCHIVE_BYTES = 681249488
CAPTURE_ARCHIVE_SHA256 = '86e9ca5c91c6501311cc70b4c8a45552174bf7164b6dce71448b27e48628e7c5'
CAPTURE_RECEIPT_BYTES = 21367452
CAPTURE_RECEIPT_SHA256 = '867e0333895bc47d175f996064169b1c0211e8a377df7359a91ffba639d3d950'
IMAGE_ID = 'sha256:5c81d46d602063772cae28b8a6509f71dde253c32544bf558f4747b9ea8ed6ed'
BINARY_SHA256 = '7a333f6e243253b7d2d2d7fa8d239c65df001e8030b3f63abc84a24d455e1763'
CAPTURE_MODULE_SHA256 = '7cb6ef74fe8da21cee5476a1c69ad614c2a9c5f04da47f4894cd36588075917c'
P3_FIXED_INPUTS_SHA256 = 'e97607af2790008c150509426da04830898cb866575db487bc2f52e94ca6e16e'
CHUNK = 1024**2
MAX_RECEIPT = 64 * CHUNK
MAX_ZIP = 2 * 1024**3 + MAX_RECEIPT + 4 * CHUNK
HASH = re.compile(r'[a-f0-9]{64}')
API = 'https://api.github.com/repos/' + REPOSITORY


def sha_file(path, maximum):
    path = Path(path).absolute()
    before = path.lstat()
    if path.resolve(strict=True) != path or not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 <= before.st_size <= maximum:
        raise ValueError('Unsafe diagnostic input')
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        if identity(os.fstat(stream.fileno())) != identity(before):
            raise ValueError('Diagnostic input replaced')
        for part in iter(lambda: stream.read(CHUNK), b''):
            digest.update(part)
        if identity(os.fstat(stream.fileno())) != identity(before):
            raise ValueError('Diagnostic input changed')
    if identity(path.lstat()) != identity(before):
        raise ValueError('Diagnostic input changed')
    return {'bytes': before.st_size, 'sha256': digest.hexdigest()}


def unique(data):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError('Duplicate diagnostic metadata key')
            value[key] = item
        return value
    return json.loads(data, object_pairs_hook=pairs)


def write_json(path, value):
    with Path(path).open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, sort_keys=True, ensure_ascii=False, indent=2)
        stream.write('\n')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def request(url, token=None):
    value = urllib.parse.urlsplit(url)
    if value.scheme != 'https' or not value.hostname or value.username is not None or value.password is not None or value.fragment:
        raise ValueError('Unsafe diagnostic transport')
    if token is not None and (value.hostname != 'api.github.com' or not value.path.startswith('/repos/' + REPOSITORY + '/')):
        raise ValueError('GitHub token cannot leave the API')
    headers = {'User-Agent': 'gp-captured-source-diagnostic', 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
    if token is not None:
        headers['Authorization'] = 'Bearer ' + token
    return urllib.request.build_opener(NoRedirect()).open(urllib.request.Request(url, headers=headers), timeout=120)


def api_json(suffix, token):
    with request(API + suffix, token) as response:
        value = response.read(4 * CHUNK + 1)
    if len(value) > 4 * CHUNK:
        raise ValueError('GitHub metadata exceeds bound')
    return unique(value)


def verify_api(run, artifact, jobs, artifact_id, expected_sha):
    if (run.get('id') != P3_RUN or run.get('head_sha') != P3_HEAD or run.get('workflow_id') != P3_WORKFLOW
            or run.get('run_attempt') != P3_ATTEMPT or run.get('path') != '.github/workflows/sast-source-build.yml'
            or run.get('repository', {}).get('id') != REPOSITORY_ID or run.get('head_repository', {}).get('id') != REPOSITORY_ID
            or run.get('status') != 'completed' or run.get('conclusion') != 'failure' or run.get('event') != 'workflow_dispatch'):
        raise ValueError('P3 workflow/source identity differs')
    bound = artifact.get('workflow_run') or {}
    if (artifact.get('id') != artifact_id or artifact.get('name') != ARTIFACT_NAME or artifact.get('expired') is not False
            or artifact.get('digest') != 'sha256:' + expected_sha or type(artifact.get('size_in_bytes')) is not int
            or not 0 < artifact['size_in_bytes'] <= MAX_ZIP or bound.get('id') != P3_RUN
            or bound.get('head_sha') != P3_HEAD or bound.get('repository_id') != REPOSITORY_ID
            or bound.get('head_repository_id') != REPOSITORY_ID
            or artifact.get('archive_download_url') != API + '/actions/artifacts/' + str(artifact_id) + '/zip'):
        raise ValueError('Capture artifact identity differs')
    rows = jobs.get('jobs')
    if jobs.get('total_count') != 1 or not isinstance(rows, list) or len(rows) != 1:
        raise ValueError('Unexpected P3 job topology')
    job = rows[0]
    if job.get('run_id') != P3_RUN or job.get('head_sha') != P3_HEAD:
        raise ValueError('P3 job source differs')
    steps = {step['name']: step for step in job.get('steps', [])}
    for name in ('Build the official upstream target and qualify whole files and controls',
            'Verify bounded upstream-only license capture even after a collection failure',
            'Retain exact upstream-only license capture without another compiler build'):
        if steps.get(name, {}).get('conclusion') != 'success':
            raise ValueError('Original build/capture retention step is not successful')


def download_capture(artifact_id, token, target, expected):
    url = API + '/actions/artifacts/' + str(artifact_id) + '/zip'
    response = None
    for hop in range(6):
        try:
            response = request(url, token if hop == 0 else None)
            break
        except urllib.error.HTTPError as error:
            if error.code not in (301, 302, 303, 307, 308):
                raise ValueError('Authenticated capture download failed: HTTP ' + str(error.code)) from None
            location = error.headers.get('Location')
            if not location:
                raise ValueError('Capture download redirect lacks destination') from None
            url = urllib.parse.urljoin(url, location)
    if response is None:
        raise ValueError('Capture download redirect count exceeds bound')
    digest, count = hashlib.sha256(), 0
    with response, Path(target).open('xb') as output:
        while True:
            part = response.read(CHUNK)
            if not part:
                break
            count += len(part)
            if count > expected['bytes'] or count > MAX_ZIP:
                raise ValueError('Capture ZIP download exceeds bound')
            digest.update(part)
            output.write(part)
    if count != expected['bytes'] or digest.hexdigest() != expected['sha256']:
        raise ValueError('Capture ZIP download digest/size differs')


def zip_directory_bound(path):
    """Bound central-directory allocation before ZipFile loads its entries."""
    with Path(path).open('rb') as stream:
        size = stream.seek(0, 2)
        stream.seek(max(0, size - 65557))
        tail = stream.read(65557)
        offset = tail.rfind(b'PK\x05\x06')
        if offset < 0 or len(tail) - offset < 22:
            raise ValueError('Missing ZIP directory')
        record = struct.unpack('<4s4H2LH', tail[offset:offset + 22])
        end = size - len(tail) + offset
        if record[1] or record[2] or record[3] != record[4] or end + 22 + record[7] != size:
            raise ValueError('Multipart or trailing ZIP data')
        entries, directory_size, directory_offset = record[4:7]
        directory_end = end
        if entries == 65535 or directory_size == 0xffffffff or directory_offset == 0xffffffff:
            if end < 20:
                raise ValueError('Missing ZIP64 locator')
            stream.seek(end - 20)
            locator = struct.unpack('<4sLQL', stream.read(20))
            if locator[0] != b'PK\x06\x07' or locator[1] or locator[3] != 1 or locator[2] > end - 76:
                raise ValueError('Invalid ZIP64 locator')
            stream.seek(locator[2])
            extended = struct.unpack('<4sQ2H2L4Q', stream.read(56))
            if extended[0] != b'PK\x06\x06' or extended[1] != 44 or extended[4] or extended[5] or extended[6] != extended[7]:
                raise ValueError('Invalid ZIP64 directory')
            entries, directory_size, directory_offset = extended[7:10]
            directory_end = locator[2]
        if entries != 2 or not 0 < directory_size <= 65536 or directory_offset + directory_size != directory_end:
            raise ValueError('ZIP must contain exactly the two bounded capture files')


def extract_hull(archive, output):
    zip_directory_bound(archive)
    output.mkdir(mode=0o700)
    expected = {'capture.tar.xz': 2 * 1024**3, 'capture-receipt.json': MAX_RECEIPT}
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) != 2 or {item.filename for item in entries} != set(expected):
            raise ValueError('Unexpected capture ZIP member')
        for item in entries:
            mode = (item.external_attr >> 16) & 0xffff
            if (item.is_dir() or stat.S_IFMT(mode) not in (0, stat.S_IFREG) or item.flag_bits & 1
                    or item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                    or not 0 < item.file_size <= expected[item.filename]):
                raise ValueError('Unsafe capture ZIP member')
            count = 0
            with bundle.open(item) as source, (output / item.filename).open('xb') as target:
                for part in iter(lambda: source.read(CHUNK), b''):
                    count += len(part)
                    if count > item.file_size:
                        raise ValueError('Capture ZIP expanded beyond member size')
                    target.write(part)
            if count != item.file_size:
                raise ValueError('Capture ZIP member is truncated')


def safe_parent(root, relative):
    path = root
    for part in PurePosixPath(relative).parts[:-1]:
        path = path / part
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or path.resolve(strict=True) != path:
            raise ValueError('Unsafe extracted capture directory')
    return root / relative


def cache_path(name):
    match = re.fullmatch(r'opam-download-cache/(md5|sha256|sha512)/([a-f0-9]{2})/([a-f0-9]+)', name)
    if not match or len(match[3]) != {'md5': 32, 'sha256': 64, 'sha512': 128}[match[1]] or not match[3].startswith(match[2]):
        raise ValueError('Unexpected OPAM cache identity')
    return match[1], match[3]


def restore_cache_aliases(root, inventory, capture_module):
    if sys.platform != 'linux':
        raise ValueError('OPAM cache alias restoration requires native Linux')
    regular = {row['path']: row for row in inventory}
    aliases = {}
    for name, row in regular.items():
        if not name.startswith('opam-download-cache/') or not name.endswith('.symlink-target'):
            continue
        alias = name.removesuffix('.symlink-target')
        cache_path(alias)
        if row['bytes'] > 65536:
            raise ValueError('OPAM cache alias target exceeds bound')
        target = (root / name).read_bytes().decode('utf-8', errors='strict')
        if (not target or target.startswith('/') or '\\' in target or any(ord(c) < 32 or ord(c) == 127 for c in target)
                or any(re.match(r'^[A-Za-z]:', part) for part in PurePosixPath(target).parts)):
            raise ValueError('Only explicit relative OPAM cache aliases are permitted')
        normalized = posixpath.normpath(posixpath.join(posixpath.dirname(alias), target))
        cache_path(normalized)
        stack = list(PurePosixPath(alias).parent.parts)
        for part in PurePosixPath(target).parts:
            if part == '..':
                if len(stack) <= 1:
                    raise ValueError('OPAM cache alias leaves the cache before returning')
                stack.pop()
            elif part != '.':
                stack.append(part)
        if '/'.join(stack) != normalized:
            raise ValueError('Noncanonical OPAM cache alias')
        if alias in regular:
            raise ValueError('Cache alias collides with actual regular source')
        aliases[alias] = (target, normalized)
    hashes, records, pending = {}, [], []
    for alias, (text, target) in sorted(aliases.items()):
        seen = {alias}
        for unused in range(32):
            if target not in aliases:
                break
            if target in seen:
                raise ValueError('Cyclic OPAM cache aliases')
            seen.add(target)
            target = aliases[target][1]
        else:
            raise ValueError('OPAM cache alias chain exceeds bound')
        if target not in regular or target.endswith('.symlink-target'):
            raise ValueError('OPAM cache alias has no captured regular target')
        if target not in hashes:
            digests = {key: hashlib.new(key) for key in ('md5', 'sha256', 'sha512')}
            with (root / target).open('rb') as stream:
                for part in iter(lambda: stream.read(CHUNK), b''):
                    for digest in digests.values():
                        digest.update(part)
            hashes[target] = {key: digest.hexdigest() for key, digest in digests.items()}
            if hashes[target]['sha256'] != regular[target]['sha256']:
                raise ValueError('Actual cache target bytes changed')
        for name in (alias, target):
            algorithm, expected = cache_path(name)
            if hashes[target][algorithm] != expected:
                raise ValueError('Actual cache alias checksum differs')
        pending.append((alias, text, target))
        records.append({'path': alias, 'targetTextSha256': hashlib.sha256(text.encode()).hexdigest(), 'regularTarget': target,
            'regularTargetSha256': regular[target]['sha256'], 'followedOutsideCache': False})
    for alias, text, target in pending:
        os.symlink(text, safe_parent(root, alias))
    for alias, text, target in pending:
        resolved = (root / alias).resolve(strict=True)
        if resolved != root / target or root / 'opam-download-cache' not in resolved.parents:
            raise ValueError('OPAM cache alias escaped its private cache')
    return records


def extract_source(capture_module, hull, output, receipt):
    if sys.platform != 'linux':
        raise ValueError('Unix source extraction requires native Linux')
    output.mkdir(mode=0o700)
    inventory = receipt['memberInventory']
    with capture_module._Directory(hull, private=True) as directory, capture_module._Regular(directory, 'capture.tar.xz', capture_module.MAX_ARCHIVE) as raw:
        expanded = capture_module._ExpandedReader(capture_module._XZReader(raw))
        index = 0
        with tarfile.open(fileobj=expanded, mode='r|') as archive:
            for item in archive:
                name = capture_module.source_relative(item.name)
                if index >= len(inventory) or not item.isfile() or item.linkname or item.size > capture_module.MAX_FILE:
                    raise ValueError('Unexpected verified capture source member')
                row = inventory[index]
                if (name, item.size) != (row['path'], row['bytes']):
                    raise ValueError('Capture extraction inventory differs')
                target = safe_parent(output, name)
                count, digest = 0, hashlib.sha256()
                with archive.extractfile(item) as source, target.open('xb') as destination:
                    for part in iter(lambda: source.read(CHUNK), b''):
                        count += len(part)
                        if count > item.size:
                            raise ValueError('Capture extraction exceeds member bound')
                        digest.update(part)
                        destination.write(part)
                if count != row['bytes'] or digest.hexdigest() != row['sha256']:
                    raise ValueError('Extracted capture source differs')
                index += 1
        while expanded.read(CHUNK):
            pass
        raw.finish()
        if index != len(inventory) or raw.sha.hexdigest() != receipt['archive']['sha256']:
            raise ValueError('Original capture bytes changed during extraction')
    return restore_cache_aliases(output, inventory, capture_module)


def clean_source_environment():
    retained = {key: value for key, value in os.environ.items() if key in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL')}
    os.environ.clear()
    os.environ.update(retained, PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1', GIT_TERMINAL_PROMPT='0')


def validate_actual(capture, receipt, image, binary, ledger):
    if (not isinstance(capture, dict) or capture.get('format') != 'gp-semgrep-core-actual-license-inputs/v1'
            or capture.get('captureComplete') is not True or capture.get('imageId') != image or receipt['imageId'] != image
            or capture.get('binarySha256') != binary or receipt['binarySha256'] != binary):
        raise ValueError('Complete actual P3 image/binary metadata is required')
    packages = capture.get('opamPackages')
    ids = ledger.opam_ids(capture.get('opamListing', ''))
    if (not isinstance(packages, list) or len(packages) != 249 or len(ids) != 249
            or sorted(row.get('id', '') for row in packages) != ids):
        raise ValueError('Actual P3 OPAM inventory must contain exactly its 249 identities')
    if not isinstance(capture.get('nativeInputs'), list) or not capture['nativeInputs'] or not isinstance(capture.get('apkPackages'), list):
        raise ValueError('Actual native static-input metadata is missing')
    owners = sorted({row['owner'] for row in capture['nativeInputs'] if row['owner'] != 'custom-curl.8.5.0'})
    return {'imageId': image, 'opamPackages': capture['opamListing'], 'nativePackageIds': owners,
        'nativeInputsSha256': ledger.digest(ledger.encoded(capture['nativeInputs']))}



# These are already-public upstream source/license diagnostics. They are not
# scanner results and do not receive a fabricated security gate receipt.
DIAGNOSTIC_FILES = (
    'public/diagnostic-summary.json', 'public/capture-collection-proof.json',
    'private/producer-run.json', 'private/capture-artifact.json', 'private/producer-jobs.json',
    'private/actual-capture.json', 'private/capture-derived-validator-context.json',
    'private/current-collector-build-inputs.json', 'private/collection-failure.json',
    'private/source-manifest-secondary-failure.json',
    'private/sourcebuild-source-inventory.json', 'private/sourcebuild-license.json',
    'private/sourcebuild-source-provenance.json',
    'private/collected-components-opam.json', 'private/collected-components-native.json',
    'dependency-sources/diagnostic-ledger.json',
)


def prepare_diagnostic_upload(output, outcome):
    """Copy only bounded, explicit upstream diagnostic files into a fresh hull."""
    clean_source_environment()
    output = Path(output).absolute()
    if (output.resolve(strict=True) != output or not output.is_dir()
            or outcome not in ('success', 'failure', 'cancelled', 'skipped')):
        raise ValueError('Invalid diagnostic upload context')
    upload = output / 'upload'
    upload.mkdir(mode=0o700)
    observation = {'format': 'gp-upstream-only-diagnostic-upload/v1', 'diagnosticOnly': True,
        'publicationReady': False, 'compilerRebuilt': False, 'collectStepOutcome': outcome,
        'contentScope': 'Previously public upstream source and license diagnostics; no GP scanner findings',
        'files': [], 'omitted': []}
    candidates = [(name, 64 * CHUNK if name.endswith('actual-capture.json') else 32 * CHUNK)
        for name in DIAGNOSTIC_FILES]
    # Commands are fixed upstream git operations after all credentials are removed.
    candidates += [('private/sourcebuild-process-%02d.json' % index, 8 * CHUNK) for index in range(32)]
    source_root = output / 'dependency-sources'
    if source_root.is_dir():
        entries = list(source_root.iterdir())
        if len(entries) > 1000:
            raise ValueError('Too many diagnostic source members')
        candidates += [('dependency-sources/' + item.name, 512 * CHUNK) for item in sorted(entries)
            if re.fullmatch(r'[A-Za-z0-9_.+-]+\.tar\.xz', item.name)]
    total = 0
    for name, limit in candidates:
        source = output / name
        if not source.exists() and not source.is_symlink():
            continue
        bound = sha_file(source, MAX_ZIP)
        if bound['bytes'] > limit or total + bound['bytes'] > 2 * 1024**3:
            observation['omitted'].append({'path': name, **bound, 'reason': 'diagnostic upload bound'})
            continue
        target = upload / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        digest, count = hashlib.sha256(), 0
        with source.open('rb') as inp, target.open('xb') as dest:
            for part in iter(lambda: inp.read(CHUNK), b''):
                count += len(part)
                if count > bound['bytes']:
                    raise ValueError('Diagnostic upload input changed')
                digest.update(part)
                dest.write(part)
        if count != bound['bytes'] or digest.hexdigest() != bound['sha256'] or sha_file(source, MAX_ZIP) != bound:
            raise ValueError('Diagnostic upload input changed')
        total += count
        observation['files'].append({'path': name, **bound})
    observation['bytes'] = total
    write_json(upload / 'upstream-diagnostic-manifest.json', observation)
    return observation


def run(args):
    if sys.platform != 'linux' or os.name != 'posix':
        raise ValueError('Native isolated Linux diagnostic only')
    os.umask(0o077)
    if (args.artifact_id != ARTIFACT_ID or args.artifact_sha256 != ARTIFACT_SHA256
            or args.expected_binary_sha256 != BINARY_SHA256 or args.expected_image_id != IMAGE_ID
            or not re.fullmatch(r'[a-f0-9]{40}', args.collector_head)):
        raise ValueError('Exact diagnostic identities are required')
    root = args.root.absolute()
    if root.resolve(strict=True) != root:
        raise ValueError('Collector checkout must be canonical')
    environment = {key: value for key, value in os.environ.items() if key in ('PATH', 'HOME', 'LANG')}
    git = lambda *a: subprocess.check_output(['git', *a], cwd=root, env=environment, timeout=60).decode().strip()
    if git('rev-parse', 'HEAD') != args.collector_head or git('status', '--porcelain', '--untracked-files=all'):
        raise ValueError('Collector requires its exact clean reviewed commit')
    module = root / 'scripts/security/compiler_capture_archive.py'
    if sha_file(module, CHUNK)['sha256'] != CAPTURE_MODULE_SHA256:
        raise ValueError('P3 capture verifier bytes differ')
    output = args.output.absolute()
    if output.exists() or output.is_symlink() or output.parent.resolve(strict=True) != output.parent or root == output or root in output.parents:
        raise ValueError('Diagnostic output requires a fresh canonical directory outside checkout')
    output.mkdir(mode=0o700)
    private, public, sources = (output / name for name in ('private', 'public', 'dependency-sources'))
    for directory in (private, public, sources):
        directory.mkdir(mode=0o700)
    proof = {'format': 'gp-p3-captured-license-collection-diagnostic/v1', 'diagnosticOnly': True, 'publicationReady': False,
        'compilerBuilt': False, 'compilerExecuted': False, 'qualificationPerformed': False, 'toolPublished': False,
        'pinChanged': False, 'repositoryId': REPOSITORY_ID, 'producerRunId': P3_RUN, 'producerAttempt': P3_ATTEMPT,
        'producerHead': P3_HEAD, 'producerWorkflowId': P3_WORKFLOW, 'captureArtifactId': args.artifact_id,
        'captureArtifactArchiveSha256': args.artifact_sha256, 'collectorHead': args.collector_head,
        'phase': 'api-binding', 'collectionValidationPassed': False, 'sourceArchives': []}
    try:
        token = os.environ.get('GH_TOKEN')
        if not token or any(ord(c) < 33 for c in token):
            raise ValueError('Authenticated read-only GitHub token required')
        run_metadata = api_json('/actions/runs/' + str(P3_RUN), token)
        artifact = api_json('/actions/artifacts/' + str(args.artifact_id), token)
        jobs = api_json('/actions/runs/' + str(P3_RUN) + '/attempts/1/jobs?per_page=10', token)
        verify_api(run_metadata, artifact, jobs, args.artifact_id, args.artifact_sha256)
        if artifact['size_in_bytes'] != ARTIFACT_BYTES:
            raise ValueError('Original P3 capture ZIP size differs')
        for name, value in (('producer-run.json', run_metadata), ('capture-artifact.json', artifact), ('producer-jobs.json', jobs)):
            write_json(private / name, value)
        zip_path = output / 'original-capture-artifact.zip'
        download_capture(args.artifact_id, token, zip_path, {'bytes': artifact['size_in_bytes'], 'sha256': args.artifact_sha256})
        token = None
        clean_source_environment()
        proof['phase'] = 'capture-byte-verification'
        hull = output / 'capture-hull'
        extract_hull(zip_path, hull)
        if sha_file(hull / 'capture-receipt.json', MAX_RECEIPT) != {'bytes': CAPTURE_RECEIPT_BYTES, 'sha256': CAPTURE_RECEIPT_SHA256}:
            raise ValueError('Original P3 capture receipt bytes differ')
        sys.path.insert(0, str(root / 'scripts/security'))
        import compiler_capture_archive as capture_module
        import compiler_license_ledger as ledger
        import compiler_license_native as native_collector
        import compiler_license_extra_sources as extra_sources
        import source_core_identity as identity
        import build_semgrep_source as build
        receipt = capture_module.verify_capture(hull)
        if (receipt['archive'] != {'bytes': CAPTURE_ARCHIVE_BYTES, 'sha256': CAPTURE_ARCHIVE_SHA256}
                or len(receipt['memberInventory']) != 121131
                or sum(row['bytes'] for row in receipt['memberInventory']) != 2177557859):
            raise ValueError('Original P3 capture archive/inventory differs')
        proof['captureReceipt'] = {'path': 'capture-receipt.json', **sha_file(hull / 'capture-receipt.json', MAX_RECEIPT)}
        proof['captureArchive'] = receipt['archive']
        capture_root = output / 'actual-capture'
        proof['restoredCacheAliases'] = extract_source(capture_module, hull, capture_root, receipt)
        observation = ledger.unique(ledger.regular(capture_root / 'capture.json', MAX_RECEIPT))
        native = validate_actual(observation, receipt, args.expected_image_id, args.expected_binary_sha256, ledger)
        source_evidence = extra_sources.actual_source_evidence(observation)
        if source_evidence:
            native['opamSourceEvidence'] = source_evidence
        write_json(private / 'actual-capture.json', observation)
        write_json(private / 'capture-derived-validator-context.json', native)
        inputs = identity.inputs(root)
        if ledger.digest(identity.canonical(identity.fixed_inputs())) != P3_FIXED_INPUTS_SHA256:
            raise ValueError('Upstream source/patch/toolchain identity differs from original P3')
        write_json(private / 'current-collector-build-inputs.json', inputs)
        proof['currentCollectorBuildInputsSha256'] = ledger.digest(identity.canonical(inputs))
        proof['unchangedP3SourcePatchToolchainSha256'] = P3_FIXED_INPUTS_SHA256
        proof['githubApiTokenForwardedToSources'] = False
        proof['actualOpamCount'], proof['actualNativeOwnerCount'] = 249, len(native['nativePackageIds'])
        proof['imageId'], proof['binarySha256'] = receipt['imageId'], receipt['binarySha256']
        proof['phase'] = 'pinned-upstream-source-checkout'
        work = output / 'upstream-work'; work.mkdir(mode=0o700)
        commands = build.Commands(private)
        upstream, unused_recipe = build.checkout_and_patch(work, private, commands)
        proof['upstreamCommit'] = build.COMMIT
        proof['phase'] = 'opam-source-license-collection'
        components = ledger.collect_opam(observation, capture_root, sources)
        write_json(private / 'collected-components-opam.json', components)
        proof['phase'] = 'native-source-license-collection'
        components += native_collector.collect_native(observation, capture_root, sources)
        write_json(private / 'collected-components-native.json', components)
        proof['phase'] = 'curl-source-license-collection'
        components.append(ledger.collect_curl(capture_root, sources))
        proof['phase'] = 'upstream-source-license-collection'
        components.append(ledger.collect_upstream(upstream, private, sources))
        value = {'format': ledger.FORMAT, 'status': 'complete', 'binarySha256': receipt['binarySha256'],
            'reviewReference': 'reviewed-actual-container-closure-v1', 'closure': {'imageId': receipt['imageId'],
                'captureSha256': receipt['archive']['sha256'], 'opamInstalled': ledger.opam_ids(observation['opamListing']),
                'nativePackageIds': native['nativePackageIds'], 'nativeInputsSha256': native['nativeInputsSha256']},
            'components': sorted(components, key=lambda item: item['name'])}
        proof['phase'] = 'independent-closure-and-source-validation'
        ledger.validate_ledger(value, receipt['binarySha256'], native)
        ledger.validate_sources(value, lambda name: ledger.regular(sources / ledger.relative(name), ledger.MAX_FILE))
        expected = {item['correspondingSource']['filename'] for item in components}
        if {file.name for file in sources.iterdir()} != expected:
            raise ValueError('Diagnostic corresponding-source set differs')
        total = sum((sources / name).stat().st_size for name in expected)
        if total > ledger.MAX_SOURCE:
            raise ValueError('Existing aggregate corresponding-source publication bound exceeded')
        with (sources / 'diagnostic-ledger.json').open('xb') as stream:
            stream.write(ledger.encoded(value))
        proof.update(phase='source-license-validation-complete', collectionValidationPassed=True, componentCount=len(components),
            correspondingSourceBytes=total, ledgerSha256=sha_file(sources / 'diagnostic-ledger.json', ledger.MAX_LEDGER_JSON)['sha256'])
    except Exception as error:
        clean_source_environment()
        proof['errorType'] = type(error).__name__
        write_json(private / 'collection-failure.json', {'format': 'gp-p3-captured-license-collection-failure/v1',
            'phase': proof['phase'], 'errorType': type(error).__name__, 'message': str(error), 'traceback': traceback.format_exc(),
            'publicationReady': False, 'compilerRebuilt': False})
    finally:
        try:
            entries = list(sources.iterdir())
            if len(entries) > 1000:
                raise ValueError('Diagnostic source archive count exceeds existing component bound')
            for path in sorted(entries):
                if path.name.endswith('.tar.xz'):
                    bound = sha_file(path, MAX_ZIP)
                    proof['sourceArchives'].append({'filename': path.name, **bound,
                        'withinExistingPublicationFileBound': bound['bytes'] <= 512 * CHUNK})
                    if bound['bytes'] > 512 * CHUNK:
                        proof['collectionValidationPassed'] = False
        except Exception as secondary:
            proof['collectionValidationPassed'] = False
            proof['sourceManifestErrorType'] = type(secondary).__name__
            write_json(private / 'source-manifest-secondary-failure.json', {'errorType': type(secondary).__name__,
                'message': str(secondary), 'traceback': traceback.format_exc(), 'originalFailureRetained': (private / 'collection-failure.json').exists()})
        proof['observedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        write_json(public / 'capture-collection-proof.json', proof)
        write_json(public / 'diagnostic-summary.json', {key: proof[key] for key in ('format', 'diagnosticOnly', 'publicationReady',
            'compilerBuilt', 'compilerExecuted', 'qualificationPerformed', 'toolPublished', 'pinChanged', 'producerRunId',
            'captureArtifactId', 'captureArtifactArchiveSha256', 'collectorHead', 'phase', 'collectionValidationPassed')})
    return 0 if proof['collectionValidationPassed'] else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--collector-head')
    parser.add_argument('--artifact-id', type=int)
    parser.add_argument('--artifact-sha256')
    parser.add_argument('--expected-image-id')
    parser.add_argument('--expected-binary-sha256')
    parser.add_argument('--prepare-upload', action='store_true')
    parser.add_argument('--collect-outcome')
    args = parser.parse_args()
    if args.prepare_upload:
        prepare_diagnostic_upload(args.output, args.collect_outcome)
        return 0
    if any(getattr(args, field) is None for field in ('root', 'collector_head', 'artifact_id', 'artifact_sha256', 'expected_image_id', 'expected_binary_sha256')):
        parser.error('Complete authenticated capture collection inputs are required')
    return run(args)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'diagnosticOnly': True, 'publicationReady': False, 'errorType': type(error).__name__}))
        sys.exit(2)
